import {
  GetDomainDetailCommand,
  Route53DomainsClient,
  type GetDomainDetailCommandOutput
} from "@aws-sdk/client-route-53-domains";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead, type SensitiveReadAuthDeps } from "./sensitive-read-auth.ts";

interface CanvasLiveEvents {
  emit(event: { type: string; [k: string]: unknown }): Promise<unknown> | unknown;
}

interface Route53DomainDetailClient {
  send(command: GetDomainDetailCommand): Promise<GetDomainDetailCommandOutput>;
}

interface AwsClientCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ReadDomainDetailDeps {
  client?: Route53DomainDetailClient;
  canvasLiveEvents?: CanvasLiveEvents;
  emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
  now?: () => Date;
  readBoundaryToken?: string;
  rateLimitPerMinute?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryJitterMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DomainDetailResponse {
  domain: string;
  registrar: string;
  nameservers: string[];
  registrationDate?: string;
  expirationDate?: string;
  autoRenew: boolean;
  transferLock: boolean;
  status: string[];
  registrantContact?: {
    organizationName?: string;
    countryCode?: string;
  };
}

export async function handleReadRoute53DomainDetail(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ReadDomainDetailDeps
): Promise<void> {
  const auth = authorizeRoute53Read(request, deps, "route53_domain_detail");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const url = new URL(request.url ?? "", "http://localhost");
  const domain = normalizeDomain(url.searchParams.get("domain") ?? "");

  if (!isValidDomain(domain)) {
    json(response, 400, { error: "invalid_domain_format" });
    return;
  }

  const client: Route53DomainDetailClient = deps.client ?? new Route53DomainsClient(route53DomainDetailClientConfigFromEnv());
  const command = new GetDomainDetailCommand({ DomainName: domain });

  try {
    const apiResponse = await sendDomainDetailWithRetry(client, command, domain, deps);

    const transferLock = route53TransferLock(apiResponse);
    const detail: DomainDetailResponse = {
      domain,
      registrar: apiResponse.RegistrarName ?? "unknown",
      nameservers: (apiResponse.Nameservers ?? [])
        .map((ns) => ns.Name)
        .filter((name): name is string => Boolean(name)),
      registrationDate: apiResponse.CreationDate?.toISOString(),
      expirationDate: apiResponse.ExpirationDate?.toISOString(),
      autoRenew: apiResponse.AutoRenew === true,
      transferLock,
      status: apiResponse.StatusList ?? [],
      registrantContact: apiResponse.RegistrantContact
        ? {
            organizationName: apiResponse.RegistrantContact.OrganizationName,
            countryCode: apiResponse.RegistrantContact.CountryCode
          }
        : undefined
    };

    await deps.emitAudit?.({
      type: "oc.route53.domain_detail_read",
      domain,
      registrar: detail.registrar,
      nameserverCount: detail.nameservers.length,
      timestamp: (deps.now ?? (() => new Date()))().toISOString()
    });

    json(response, 200, detail);
  } catch (error) {
    const failure = classifyRoute53DomainDetailError(error);
    void deps.logger?.warn("route53.domain_detail_failed", "Route53 domain detail read failed.", {
      domain,
      awsError: failure.awsError,
      httpStatus: failure.httpStatus,
      statusCode: failure.statusCode,
      transient: failure.transient,
      retryable: failure.retryable
    });
    json(response, failure.statusCode, {
      error: failure.error,
      message: failure.message,
      domain,
      awsError: failure.awsError,
      httpStatus: failure.httpStatus,
      transient: failure.transient,
      retryable: failure.retryable
    });
  }
}

function authorizeRoute53Read(
  request: IncomingMessage,
  deps: SensitiveReadAuthDeps,
  scope: string
) {
  return authorizeSensitiveRead(request, deps, scope);
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

export function route53DomainDetailClientConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): {
  region: string;
  credentials?: AwsClientCredentials;
  maxAttempts: number;
  retryMode: "adaptive";
} {
  const credentials = route53DomainsCredentialsFromEnv(env);
  return {
    region: firstNonEmpty(
      env.AWS_ROUTE53_DOMAINS_REGION,
      env.AWS_ROUTE53_REGION,
      env.AWS_REGION
    ) ?? "us-east-1",
    maxAttempts: 5,
    retryMode: "adaptive",
    ...(credentials ? { credentials } : {})
  };
}

function route53DomainsCredentialsFromEnv(
  env: Record<string, string | undefined>
): AwsClientCredentials | undefined {
  const accessKeyId = firstNonEmpty(
    env.AWS_ROUTE53_DOMAINS_ACCESS_KEY_ID,
    env.AWS_ROUTE53_ACCESS_KEY_ID,
    env.AWS_ACCESS_KEY_ID
  );
  const secretAccessKey = firstNonEmpty(
    env.AWS_ROUTE53_DOMAINS_SECRET_ACCESS_KEY,
    env.AWS_ROUTE53_SECRET_ACCESS_KEY,
    env.AWS_SECRET_ACCESS_KEY
  );
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = firstNonEmpty(
    env.AWS_ROUTE53_DOMAINS_SESSION_TOKEN,
    env.AWS_ROUTE53_SESSION_TOKEN,
    env.AWS_SESSION_TOKEN
  );
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {})
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function isValidDomain(domain: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain);
}

function route53TransferLock(apiResponse: GetDomainDetailCommandOutput): boolean {
  const explicitLock = (apiResponse as GetDomainDetailCommandOutput & { TransferLock?: boolean }).TransferLock;
  return explicitLock === true ||
    (apiResponse.StatusList ?? []).some((status) => /clientTransferProhibited/i.test(status));
}

async function sendDomainDetailWithRetry(
  client: Route53DomainDetailClient,
  command: GetDomainDetailCommand,
  domain: string,
  deps: ReadDomainDetailDeps
): Promise<GetDomainDetailCommandOutput> {
  const maxAttempts = Math.max(1, Math.min(5, Math.trunc(deps.maxAttempts ?? 3)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.send(command);
    } catch (error) {
      lastError = error;
      const failure = classifyRoute53DomainDetailError(error);
      if (!failure.retryable || attempt >= maxAttempts) {
        break;
      }
      void deps.logger?.warn("route53.domain_detail_attempt_failed", "Route53 domain detail read will retry.", {
        domain,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        awsError: failure.awsError,
        httpStatus: failure.httpStatus,
        statusCode: failure.statusCode,
        transient: failure.transient
      });
      await (deps.sleep ?? sleep)(retryDelayMs(attempt, deps));
    }
  }
  throw lastError;
}

interface Route53DomainDetailFailure {
  statusCode: number;
  error: string;
  message: string;
  awsError: string;
  httpStatus: number | null;
  transient: boolean;
  retryable: boolean;
}

function classifyRoute53DomainDetailError(error: unknown): Route53DomainDetailFailure {
  const awsError = awsErrorName(error);
  const httpStatus = awsHttpStatus(error);
  const message = errorMessage(error);
  if (isRoute53ThrottleError(awsError, httpStatus)) {
    return {
      statusCode: 429,
      error: "route53_domain_detail_throttled",
      message,
      awsError,
      httpStatus,
      transient: true,
      retryable: true
    };
  }
  if (isRoute53DomainNotFoundError(awsError, message)) {
    return {
      statusCode: 404,
      error: "route53_domain_detail_not_found",
      message,
      awsError,
      httpStatus,
      transient: false,
      retryable: false
    };
  }
  if (isRoute53TransientError(awsError, httpStatus, message)) {
    return {
      statusCode: 503,
      error: "route53_domain_detail_unavailable",
      message,
      awsError,
      httpStatus,
      transient: true,
      retryable: true
    };
  }
  return {
    statusCode: 502,
    error: "route53_domains_read_failed",
    message,
    awsError,
    httpStatus,
    transient: false,
    retryable: false
  };
}

function isRoute53ThrottleError(awsError: string, httpStatus: number | null): boolean {
  const normalized = awsError.toLowerCase();
  return httpStatus === 429 ||
    normalized.includes("throttl") ||
    normalized.includes("toomanyrequests") ||
    normalized.includes("operationlimitexceeded") ||
    normalized.includes("requestlimitexceeded") ||
    normalized.includes("limitexceeded");
}

function isRoute53DomainNotFoundError(awsError: string, message: string): boolean {
  const normalizedError = awsError.toLowerCase();
  const normalizedMessage = message.toLowerCase();
  return normalizedError.includes("domainnotfound") ||
    (
      normalizedError.includes("invalidinput") &&
      (
        normalizedMessage.includes("not found") ||
        normalizedMessage.includes("does not exist") ||
        normalizedMessage.includes("not in this account") ||
        normalizedMessage.includes("not associated")
      )
    );
}

function isRoute53TransientError(awsError: string, httpStatus: number | null, message: string): boolean {
  const normalizedError = awsError.toLowerCase();
  const normalizedMessage = message.toLowerCase();
  return (httpStatus !== null && httpStatus >= 500) ||
    normalizedError.includes("timeouterror") ||
    normalizedError.includes("timeout") ||
    normalizedError.includes("requesttimeout") ||
    normalizedError.includes("networkingerror") ||
    normalizedError.includes("aborterror") ||
    normalizedMessage.includes("timed out") ||
    normalizedMessage.includes("econnreset") ||
    normalizedMessage.includes("etimedout");
}

function awsErrorName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  if (isRecord(error)) {
    const name = stringValue(error.name) ?? stringValue(error.Code) ?? stringValue(error.code);
    if (name) return name;
  }
  return "UnknownAwsError";
}

function awsHttpStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const metadata = isRecord(error.$metadata) ? error.$metadata : {};
  const status = numberValue(metadata.httpStatusCode) ?? numberValue(error.statusCode) ?? numberValue(error.status);
  return status ?? null;
}

function retryDelayMs(attempt: number, deps: ReadDomainDetailDeps): number {
  const base = Math.max(0, deps.retryBaseDelayMs ?? 200);
  const jitter = Math.max(0, deps.retryJitterMs ?? 100);
  return (base * (2 ** (attempt - 1))) + Math.floor(Math.random() * (jitter + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  GetDomainDetailCommand,
  Route53DomainsClient,
  type GetDomainDetailCommandOutput
} from "@aws-sdk/client-route-53-domains";
import type { IncomingMessage, ServerResponse } from "node:http";

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
  now?: () => Date;
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
  const url = new URL(request.url ?? "", "http://localhost");
  const domain = normalizeDomain(url.searchParams.get("domain") ?? "");

  if (!isValidDomain(domain)) {
    json(response, 400, { error: "invalid_domain_format" });
    return;
  }

  const client: Route53DomainDetailClient = deps.client ?? new Route53DomainsClient(route53DomainDetailClientConfigFromEnv());

  try {
    const apiResponse = await client.send(
      new GetDomainDetailCommand({ DomainName: domain })
    );

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
    json(response, 502, {
      error: "route53_domains_read_failed",
      message: errorMessage(error),
      domain
    });
  }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase();
}

export function route53DomainDetailClientConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): {
  region: string;
  credentials?: AwsClientCredentials;
} {
  const credentials = route53DomainsCredentialsFromEnv(env);
  return {
    region: firstNonEmpty(
      env.AWS_ROUTE53_DOMAINS_REGION,
      env.AWS_ROUTE53_REGION,
      env.AWS_REGION
    ) ?? "us-east-1",
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

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

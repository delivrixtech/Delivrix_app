import {
  ListResourceRecordSetsCommand,
  Route53Client,
  type ListResourceRecordSetsCommandOutput,
  type RRType
} from "@aws-sdk/client-route-53";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AwsRoute53HostedZoneSummary,
  AwsRoute53ResourceRecordSet
} from "../../../../packages/adapters/src/index.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  resolveRoute53HostedZone,
  Route53ZonePolicyError
} from "./route53-zone-policy.ts";
import { authorizeSensitiveRead, type SensitiveReadAuthDeps } from "./sensitive-read-auth.ts";

interface CanvasLiveEvents {
  emit(event: { type: string; [k: string]: unknown }): Promise<unknown> | unknown;
}

interface Route53ZoneRecordsClient {
  send(command: ListResourceRecordSetsCommand): Promise<ListResourceRecordSetsCommandOutput>;
}

interface Route53ZoneRecordsAdapter {
  listHostedZones(): Promise<AwsRoute53HostedZoneSummary[]>;
  listHostedZonesByName?(domain: string): Promise<AwsRoute53HostedZoneSummary[]>;
  listResourceRecordSets(zoneId: string): Promise<AwsRoute53ResourceRecordSet[]>;
  createHostedZone(domain: string): Promise<{ zoneId: string; nameServers: string[] }>;
}

interface AwsClientCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ReadZoneRecordsDeps {
  client?: Route53ZoneRecordsClient;
  adapter?: Route53ZoneRecordsAdapter;
  workspace?: OpenClawWorkspace;
  getDomainNameservers?: (domain: string) => Promise<string[]>;
  canvasLiveEvents?: CanvasLiveEvents;
  emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
  now?: () => Date;
  readBoundaryToken?: string;
  rateLimitPerMinute?: number;
}

export interface ZoneRecord {
  name: string;
  type: string;
  ttl?: number;
  values: string[];
  setIdentifier?: string;
  weight?: number;
  aliasTarget?: { dnsName: string; hostedZoneId: string };
}

export interface ZoneRecordsResponse {
  zoneId: string;
  domain?: string;
  records: ZoneRecord[];
  isTruncated: boolean;
  totalRecords: number;
  zoneResolution?: {
    status: string;
    source: string;
    authoritativeNameserverMatch?: boolean;
    cleanupSuggested?: unknown[];
  };
}

const validRecordTypes = new Set([
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "NS",
  "SOA",
  "PTR",
  "SRV",
  "CAA"
]);

export async function handleReadRoute53ZoneRecords(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ReadZoneRecordsDeps
): Promise<void> {
  const auth = authorizeRoute53Read(request, deps, "route53_zone_records");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const url = new URL(request.url ?? "", "http://localhost");
  const domain = normalizeDomain(url.searchParams.get("domain") ?? "");
  const requestedZoneId = normalizeZoneId(url.searchParams.get("zoneId") ?? "");
  let zoneId = requestedZoneId;
  const recordType = normalizeRecordType(url.searchParams.get("recordType"));
  const recordName = normalizeRecordName(url.searchParams.get("recordName"));

  if (!domain && !zoneId) {
    json(response, 400, { error: "domain_or_zone_id_required" });
    return;
  }
  if (domain && !isValidDomain(domain)) {
    json(response, 400, { error: "invalid_domain_format" });
    return;
  }
  if (requestedZoneId && !isValidZoneId(requestedZoneId)) {
    json(response, 400, { error: "invalid_zone_id" });
    return;
  }

  if (recordType && !validRecordTypes.has(recordType)) {
    json(response, 400, { error: "invalid_record_type" });
    return;
  }

  try {
    let zoneResolution: ZoneRecordsResponse["zoneResolution"] | undefined;
    if (domain) {
      if (!deps.adapter || !deps.workspace) {
        json(response, 503, { error: "route53_zone_discovery_unavailable", domain });
        return;
      }
      const resolved = await resolveRoute53HostedZone({
        workspace: deps.workspace,
        adapter: deps.adapter,
        domain,
        mode: "reuse-only",
        preferredZoneId: requestedZoneId || undefined,
        getDomainNameservers: deps.getDomainNameservers
      });
      zoneId = resolved.zone.zoneId;
      zoneResolution = {
        status: resolved.status,
        source: resolved.source,
        ...(resolved.authoritativeNameserverMatch === true ? { authoritativeNameserverMatch: true } : {}),
        ...(resolved.cleanupSuggested ? { cleanupSuggested: resolved.cleanupSuggested } : {})
      };
    }

    const listed = deps.adapter
      ? {
        records: filterRecords((await deps.adapter.listResourceRecordSets(zoneId)).map(adapterRecordToZoneRecord), recordType, recordName),
        isTruncated: false
      }
      : await listRecordsWithSdk({
        client: deps.client ?? new Route53Client(route53ZoneRecordsClientConfigFromEnv()),
        zoneId,
        recordType,
        recordName
      });

    const result: ZoneRecordsResponse = {
      zoneId,
      ...(domain ? { domain } : {}),
      records: listed.records,
      isTruncated: listed.isTruncated,
      totalRecords: listed.records.length,
      ...(zoneResolution ? { zoneResolution } : {})
    };

    await deps.emitAudit?.({
      type: "oc.route53.zone_records_read",
      zoneId,
      ...(domain ? { domain } : {}),
      ...(zoneResolution?.source ? { zoneResolutionSource: zoneResolution.source } : {}),
      recordCount: listed.records.length,
      isTruncated: result.isTruncated,
      timestamp: (deps.now ?? (() => new Date()))().toISOString()
    });

    json(response, 200, result);
  } catch (error) {
    if (error instanceof Route53ZonePolicyError) {
      json(response, error.statusCode, {
        error: error.code,
        message: error.message,
        domain,
        details: error.details
      });
      return;
    }
    const message = errorMessage(error);
    const isNotFound = /NoSuchHostedZone/i.test(`${errorName(error)} ${message}`);
    json(response, isNotFound ? 404 : 502, {
      error: isNotFound ? "hosted_zone_not_found" : "route53_zone_read_failed",
      message,
      zoneId
    });
  }
}

async function listRecordsWithSdk(input: {
  client: Route53ZoneRecordsClient;
  zoneId: string;
  recordType?: string;
  recordName?: string;
}): Promise<{ records: ZoneRecord[]; isTruncated: boolean }> {
  const apiResponse = await input.client.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: input.zoneId,
      ...(input.recordName ? { StartRecordName: input.recordName } : {}),
      ...(input.recordName && input.recordType ? { StartRecordType: input.recordType as RRType } : {}),
      MaxItems: 300
    })
  );

  return {
    records: filterRecords((apiResponse.ResourceRecordSets ?? []).map((recordSet) => ({
      name: recordSet.Name ?? "",
      type: recordSet.Type ?? "",
      ttl: recordSet.TTL,
      values: (recordSet.ResourceRecords ?? [])
        .map((record) => record.Value ?? "")
        .filter((value) => value.length > 0),
      setIdentifier: recordSet.SetIdentifier,
      weight: recordSet.Weight,
      aliasTarget: recordSet.AliasTarget
        ? {
            dnsName: recordSet.AliasTarget.DNSName ?? "",
            hostedZoneId: recordSet.AliasTarget.HostedZoneId ?? ""
          }
        : undefined
    })), input.recordType, input.recordName),
    isTruncated: apiResponse.IsTruncated === true
  };
}

function adapterRecordToZoneRecord(record: AwsRoute53ResourceRecordSet): ZoneRecord {
  return {
    name: record.name,
    type: record.type,
    ttl: record.ttl,
    values: record.values
  };
}

function filterRecords(records: ZoneRecord[], recordType: string | undefined, recordName: string | undefined): ZoneRecord[] {
  return records.filter((recordSet) => {
    if (recordType && recordSet.type !== recordType) return false;
    if (recordName && normalizeRecordName(recordSet.name) !== recordName) return false;
    return true;
  });
}

function authorizeRoute53Read(
  request: IncomingMessage,
  deps: SensitiveReadAuthDeps,
  scope: string
) {
  return authorizeSensitiveRead(request, deps, scope);
}

function normalizeZoneId(value: string): string {
  return value.trim().replace(/^\/hostedzone\//, "").toUpperCase();
}

export function route53ZoneRecordsClientConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): {
  region: string;
  credentials?: AwsClientCredentials;
} {
  const credentials = route53DnsCredentialsFromEnv(env);
  return {
    region: firstNonEmpty(
      env.AWS_ROUTE53_DNS_REGION,
      env.AWS_ROUTE53_REGION,
      env.AWS_REGION
    ) ?? "us-east-1",
    ...(credentials ? { credentials } : {})
  };
}

function route53DnsCredentialsFromEnv(
  env: Record<string, string | undefined>
): AwsClientCredentials | undefined {
  const accessKeyId = firstNonEmpty(
    env.AWS_ROUTE53_DNS_ACCESS_KEY_ID,
    env.AWS_ROUTE53_ACCESS_KEY_ID,
    env.AWS_ACCESS_KEY_ID
  );
  const secretAccessKey = firstNonEmpty(
    env.AWS_ROUTE53_DNS_SECRET_ACCESS_KEY,
    env.AWS_ROUTE53_SECRET_ACCESS_KEY,
    env.AWS_SECRET_ACCESS_KEY
  );
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = firstNonEmpty(
    env.AWS_ROUTE53_DNS_SESSION_TOKEN,
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

function isValidZoneId(zoneId: string): boolean {
  return /^Z[A-Z0-9]{10,32}$/.test(zoneId);
}

function isValidDomain(domain: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain);
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeRecordType(value: string | null): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized ? normalized : undefined;
}

function normalizeRecordName(value: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\.$/, "");
  return normalized ? normalized : undefined;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : "";
}

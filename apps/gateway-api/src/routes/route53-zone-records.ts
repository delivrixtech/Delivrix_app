import {
  ListResourceRecordSetsCommand,
  Route53Client,
  type ListResourceRecordSetsCommandOutput,
  type RRType
} from "@aws-sdk/client-route-53";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeSensitiveRead, type SensitiveReadAuthDeps } from "./sensitive-read-auth.ts";

interface CanvasLiveEvents {
  emit(event: { type: string; [k: string]: unknown }): Promise<unknown> | unknown;
}

interface Route53ZoneRecordsClient {
  send(command: ListResourceRecordSetsCommand): Promise<ListResourceRecordSetsCommandOutput>;
}

interface AwsClientCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface ReadZoneRecordsDeps {
  client?: Route53ZoneRecordsClient;
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
  records: ZoneRecord[];
  isTruncated: boolean;
  totalRecords: number;
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
  const zoneId = normalizeZoneId(url.searchParams.get("zoneId") ?? "");
  const recordType = normalizeRecordType(url.searchParams.get("recordType"));
  const recordName = normalizeRecordName(url.searchParams.get("recordName"));

  if (!isValidZoneId(zoneId)) {
    json(response, 400, { error: "invalid_zone_id" });
    return;
  }

  if (recordType && !validRecordTypes.has(recordType)) {
    json(response, 400, { error: "invalid_record_type" });
    return;
  }

  const client: Route53ZoneRecordsClient = deps.client ?? new Route53Client(route53ZoneRecordsClientConfigFromEnv());

  try {
    const apiResponse = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: zoneId,
        ...(recordName ? { StartRecordName: recordName } : {}),
        ...(recordName && recordType ? { StartRecordType: recordType as RRType } : {}),
        MaxItems: 300
      })
    );

    const records: ZoneRecord[] = (apiResponse.ResourceRecordSets ?? [])
      .filter((recordSet) => {
        if (recordType && recordSet.Type !== recordType) return false;
        if (recordName && normalizeRecordName(recordSet.Name ?? "") !== recordName) return false;
        return true;
      })
      .map((recordSet) => ({
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
      }));

    const result: ZoneRecordsResponse = {
      zoneId,
      records,
      isTruncated: apiResponse.IsTruncated === true,
      totalRecords: records.length
    };

    await deps.emitAudit?.({
      type: "oc.route53.zone_records_read",
      zoneId,
      recordCount: records.length,
      isTruncated: result.isTruncated,
      timestamp: (deps.now ?? (() => new Date()))().toISOString()
    });

    json(response, 200, result);
  } catch (error) {
    const message = errorMessage(error);
    const isNotFound = /NoSuchHostedZone/i.test(`${errorName(error)} ${message}`);
    json(response, isNotFound ? 404 : 502, {
      error: isNotFound ? "hosted_zone_not_found" : "route53_zone_read_failed",
      message,
      zoneId
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

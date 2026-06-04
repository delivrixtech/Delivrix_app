import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  IonosDnsInventoryResult,
  IonosDnsRecord,
  IonosDnsZone
} from "../../../../packages/adapters/src/index.ts";
import { authorizeSensitiveRead, type SensitiveReadAuthDeps } from "./sensitive-read-auth.ts";

export interface ReadIonosDnsAdapter {
  listInventory(): Promise<IonosDnsInventoryResult>;
}

export interface ReadIonosDnsDeps extends SensitiveReadAuthDeps {
  adapter: ReadIonosDnsAdapter;
  emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
  now?: () => Date;
}

export interface IonosDnsReadRecord {
  id: string;
  zoneId?: string;
  name: string;
  type: string;
  content?: string;
  ttl?: number;
  priority?: number;
  enabled?: boolean;
  state?: string;
}

const validRecordTypes = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"]);

export async function handleReadIonosDns(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ReadIonosDnsDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, deps, "ionos_dns_records");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const url = new URL(request.url ?? "", "http://localhost");
  const domain = normalizeDomain(url.searchParams.get("domain"));
  const zoneId = normalizeOptionalId(url.searchParams.get("zoneId"));
  const recordType = normalizeRecordType(url.searchParams.get("recordType"));
  const recordName = normalizeRecordName(url.searchParams.get("recordName"));

  if (!domain && !zoneId) {
    json(response, 400, { error: "domain_or_zone_id_required" });
    return;
  }
  if (recordType && !validRecordTypes.has(recordType)) {
    json(response, 400, { error: "invalid_record_type" });
    return;
  }

  const inventory = await deps.adapter.listInventory();
  if (!inventory.source.responseOk) {
    json(response, 502, {
      error: "ionos_dns_read_failed",
      message: inventory.source.errorMessage ?? "IONOS DNS inventory read failed.",
      source: inventory.source
    });
    return;
  }

  const zone = resolveZone(inventory.zones, { domain, zoneId });
  if (!zone) {
    json(response, 404, {
      error: "ionos_zone_not_found",
      ...(domain ? { domain } : {}),
      ...(zoneId ? { zoneId } : {}),
      source: inventory.source
    });
    return;
  }

  const records = zone.records
    .filter((record) => !recordType || record.type.toUpperCase() === recordType)
    .filter((record) => !recordName || normalizeRecordName(record.name) === recordName)
    .map(recordSnapshot);

  await deps.emitAudit?.({
    type: "oc.ionos.dns_records_read",
    zoneId: zone.id,
    zoneName: zone.name,
    recordCount: records.length,
    timestamp: (deps.now ?? (() => new Date()))().toISOString()
  });

  json(response, 200, {
    zoneId: zone.id,
    zoneName: zone.name,
    records,
    totalRecords: records.length,
    source: inventory.source
  });
}

function resolveZone(
  zones: IonosDnsZone[],
  input: { domain?: string; zoneId?: string }
): IonosDnsZone | null {
  if (input.zoneId) {
    return zones.find((zone) => zone.id === input.zoneId) ?? null;
  }
  if (!input.domain) return null;
  const candidates = zones
    .filter((zone) => input.domain === zone.name.toLowerCase() || input.domain.endsWith(`.${zone.name.toLowerCase()}`))
    .sort((left, right) => right.name.length - left.name.length);
  return candidates[0] ?? null;
}

function recordSnapshot(record: IonosDnsRecord): IonosDnsReadRecord {
  return {
    id: record.id,
    ...(record.zoneId ? { zoneId: record.zoneId } : {}),
    name: record.name,
    type: record.type,
    ...(record.content ? { content: record.content } : {}),
    ...(typeof record.ttl === "number" ? { ttl: record.ttl } : {}),
    ...(typeof record.priority === "number" ? { priority: record.priority } : {}),
    ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    ...(record.state ? { state: record.state } : {})
  };
}

function normalizeDomain(value: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return undefined;
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(normalized)
    ? normalized
    : undefined;
}

function normalizeOptionalId(value: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9_.:-]{1,128}$/.test(normalized) ? normalized : undefined;
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

/**
 * IonosDnsActuator — Hito 5.12 multi-provider write-mode.
 *
 * Extiende {@link IonosDnsAdapter} (read-only) con métodos de escritura para
 * IONOS Cloud DNS (Bearer token) y fallback Hosting DNS (X-API-Key). El
 * actuator se construye en modo "degraded" cuando solo hay X-API-Key — algunos
 * shapes de Cloud DNS quedan no-op, pero los upserts contra Hosting DNS sí
 * surten efecto.
 *
 * Disciplina:
 *   - Idempotencia: PUT cuando la API lo permite; si una record ya existe con
 *     el mismo contenido el actuator devuelve `{ rrsetIds: [...] }` sin error.
 *   - Errors tipados: {@link IonosDnsActuatorError} encapsula statusCode, code
 *     y requestId para que el handler gateway pueda transformarlos en 502 con
 *     metadata trazable.
 *   - Sin `any`: el JSON crudo se valida con type guards (`unknown` →
 *     narrowing).
 *   - Sin tokens hardcoded — todo via env (IONOS_API_TOKEN,
 *     IONOS_DNS_API_KEY, IONOS_DNS_ENABLE_WRITES).
 */

import {
  IonosDnsAdapter,
  type IonosDnsAdapterOptions,
  type IonosDnsInventorySource
} from "./ionos-dns-adapter.ts";

const DEFAULT_IONOS_CLOUD_DNS_API_BASE = "https://dns.de-fra.ionos.com";
const DEFAULT_IONOS_HOSTING_DNS_API_BASE = "https://api.hosting.ionos.com/dns";
const DEFAULT_TTL_SECONDS = 300;

export interface IonosDnsActuatorOptions extends IonosDnsAdapterOptions {
  writeEnabled?: boolean;
  defaultTtl?: number;
}

export interface IonosDnsRecordWriteInput {
  name: string;
  type: string;
  content: string;
  ttl?: number;
  prio?: number;
}

export interface IonosDnsCreateZoneResult {
  zoneId: string;
  nameservers: string[];
}

export interface IonosDnsUpsertResult {
  rrsetIds: string[];
  idempotent: boolean;
}

export interface IonosDnsRecordSnapshot {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl?: number;
  prio?: number;
}

export type IonosDnsActuatorApiKind = IonosDnsInventorySource["apiKind"];

export class IonosDnsActuatorError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(message: string, opts: {
    statusCode: number;
    code?: string;
    requestId?: string;
  }) {
    super(message);
    this.name = "IonosDnsActuatorError";
    this.statusCode = opts.statusCode;
    this.code = opts.code;
    this.requestId = opts.requestId;
  }
}

export class IonosDnsActuator extends IonosDnsAdapter {
  private readonly writeEnabled: boolean;
  private readonly defaultTtl: number;
  private readonly hasToken: boolean;
  private readonly hasApiKey: boolean;
  private readonly tokenValue: string | undefined;
  private readonly apiKeyValue: string | undefined;
  private readonly writeApiKind: IonosDnsActuatorApiKind;
  private readonly writeApiBase: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: IonosDnsActuatorOptions = {}) {
    super(options);
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    this.tokenValue =
      normalizeEnvValue(options.token) ??
      normalizeEnvValue(env.IONOS_API_TOKEN) ??
      normalizeEnvValue(env.IONOS_CLOUD_DNS_TOKEN);
    this.apiKeyValue =
      normalizeEnvValue(options.apiKey) ??
      normalizeEnvValue(env.IONOS_DNS_API_KEY) ??
      normalizeEnvValue(env.IONOS_DOMAINS_API_KEY) ??
      normalizeEnvValue(env.IONOS_HOSTING_API_KEY) ??
      normalizeEnvValue(env.IONOS_DEVELOPER_API_KEY);
    this.hasToken = Boolean(this.tokenValue);
    this.hasApiKey = Boolean(this.apiKeyValue);
    this.writeApiKind = this.hasToken ? "cloud-dns" : "hosting-dns";
    this.writeApiBase =
      options.apiBase ??
      (this.writeApiKind === "cloud-dns"
        ? DEFAULT_IONOS_CLOUD_DNS_API_BASE
        : DEFAULT_IONOS_HOSTING_DNS_API_BASE);
    this.fetchFn = options.fetchImpl ?? fetch;
    this.writeEnabled =
      options.writeEnabled ??
      (normalizeEnvValue(env.IONOS_DNS_ENABLE_WRITES) === "true");
    const ttlEnv = Number(
      normalizeEnvValue(options.defaultTtl?.toString()) ??
        normalizeEnvValue(env.IONOS_DNS_DEFAULT_TTL)
    );
    this.defaultTtl = Number.isFinite(ttlEnv) && ttlEnv > 0
      ? Math.trunc(ttlEnv)
      : DEFAULT_TTL_SECONDS;
  }

  /** Returns `true` when both the kill switch is `true` and at least one
   * credential (Bearer token or X-API-Key) is configured. */
  isWriteEnabled(): boolean {
    return this.writeEnabled && (this.hasToken || this.hasApiKey);
  }

  /** Distinguishes the two IONOS DNS write surfaces — Cloud DNS (Bearer) vs
   * Hosting DNS (X-API-Key, degraded). */
  writeApiKindLabel(): IonosDnsActuatorApiKind {
    return this.writeApiKind;
  }

  /** Idempotent zone creation. If the zone already exists, returns the
   * existing zoneId + nameservers instead of throwing. */
  async createZone(zoneName: string): Promise<IonosDnsCreateZoneResult> {
    this.assertWritable();
    const normalized = normalizeZoneName(zoneName);
    if (this.writeApiKind === "cloud-dns") {
      return this.createZoneCloud(normalized);
    }
    return this.createZoneHosting(normalized);
  }

  /** Upserts a list of records into the given zone. Uses PUT semantics when
   * possible. Returns `idempotent: true` when no API call surfaced changes. */
  async upsertRecords(
    zoneId: string,
    records: IonosDnsRecordWriteInput[]
  ): Promise<IonosDnsUpsertResult> {
    this.assertWritable();
    if (records.length === 0) {
      return { rrsetIds: [], idempotent: true };
    }
    const rrsetIds: string[] = [];
    let idempotent = true;
    for (const record of records) {
      const result = this.writeApiKind === "cloud-dns"
        ? await this.upsertRecordCloud(zoneId, record)
        : await this.upsertRecordHosting(zoneId, record);
      rrsetIds.push(result.recordId);
      if (!result.idempotent) {
        idempotent = false;
      }
    }
    return { rrsetIds, idempotent };
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    this.assertWritable();
    const encodedZone = encodeURIComponent(zoneId);
    const encodedRecord = encodeURIComponent(recordId);
    const path = this.writeApiKind === "cloud-dns"
      ? `/zones/${encodedZone}/records/${encodedRecord}`
      : `/v1/zones/${encodedZone}/records/${encodedRecord}`;
    const response = await this.send("DELETE", path);
    if (!response.ok && response.status !== 404) {
      throw await actuatorErrorFromResponse(response, "Failed to delete record");
    }
  }

  async listRecords(zoneId: string): Promise<IonosDnsRecordSnapshot[]> {
    this.assertWritable();
    const encodedZone = encodeURIComponent(zoneId);
    const path = this.writeApiKind === "cloud-dns"
      ? `/zones/${encodedZone}/records?limit=1000`
      : `/v1/zones/${encodedZone}/records`;
    const response = await this.send("GET", path);
    if (!response.ok) {
      throw await actuatorErrorFromResponse(response, "Failed to list DNS records");
    }
    const payload = await safeJson(response);
    return collectionItems(payload)
      .map(recordSnapshotFromPayload)
      .filter((record): record is IonosDnsRecordSnapshot => record !== null);
  }

  private async createZoneCloud(zoneName: string): Promise<IonosDnsCreateZoneResult> {
    const existing = await this.findZoneByName(zoneName);
    if (existing) {
      return existing;
    }
    const response = await this.send("POST", "/zones", {
      properties: {
        zoneName,
        enabled: true
      }
    });
    if (response.status === 409) {
      const fallback = await this.findZoneByName(zoneName);
      if (fallback) return fallback;
    }
    if (!response.ok) {
      throw await actuatorErrorFromResponse(response, "Failed to create zone");
    }
    const payload = await safeJson(response);
    const zoneId = extractId(payload);
    if (!zoneId) {
      throw new IonosDnsActuatorError("Cloud DNS create zone response did not include zone id.", {
        statusCode: response.status,
        requestId: requestIdFromHeaders(response.headers)
      });
    }
    const nameservers = await this.fetchZoneNameservers(zoneId);
    return { zoneId, nameservers };
  }

  private async createZoneHosting(zoneName: string): Promise<IonosDnsCreateZoneResult> {
    const existing = await this.findZoneByName(zoneName);
    if (existing) {
      return existing;
    }
    const response = await this.send("POST", "/v1/zones", { name: zoneName });
    if (response.status === 409) {
      const fallback = await this.findZoneByName(zoneName);
      if (fallback) return fallback;
    }
    if (!response.ok) {
      throw await actuatorErrorFromResponse(response, "Failed to create zone");
    }
    const payload = await safeJson(response);
    const zoneId = extractId(payload);
    if (!zoneId) {
      throw new IonosDnsActuatorError("Hosting DNS create zone response did not include zone id.", {
        statusCode: response.status,
        requestId: requestIdFromHeaders(response.headers)
      });
    }
    return { zoneId, nameservers: extractStringArray(payload, "nameservers") };
  }

  private async upsertRecordCloud(
    zoneId: string,
    record: IonosDnsRecordWriteInput
  ): Promise<{ recordId: string; idempotent: boolean }> {
    const encodedZone = encodeURIComponent(zoneId);
    const existing = await this.findCloudRecordMatch(zoneId, record);
    const body = {
      properties: {
        name: record.name,
        type: record.type.toUpperCase(),
        content: record.content,
        ttl: record.ttl ?? this.defaultTtl,
        ...(typeof record.prio === "number" ? { priority: record.prio } : {}),
        enabled: true
      }
    };

    if (existing && existing.matchesContent) {
      return { recordId: existing.id, idempotent: true };
    }
    if (existing) {
      const response = await this.send(
        "PUT",
        `/zones/${encodedZone}/records/${encodeURIComponent(existing.id)}`,
        body
      );
      if (!response.ok) {
        throw await actuatorErrorFromResponse(response, "Failed to update record");
      }
      return { recordId: existing.id, idempotent: false };
    }

    const response = await this.send("POST", `/zones/${encodedZone}/records`, body);
    if (response.status === 409) {
      const replay = await this.findCloudRecordMatch(zoneId, record);
      if (replay && replay.matchesContent) {
        return { recordId: replay.id, idempotent: true };
      }
    }
    if (!response.ok) {
      throw await actuatorErrorFromResponse(response, "Failed to create record");
    }
    const payload = await safeJson(response);
    const recordId = extractId(payload);
    if (!recordId) {
      throw new IonosDnsActuatorError("Cloud DNS create record response did not include record id.", {
        statusCode: response.status,
        requestId: requestIdFromHeaders(response.headers)
      });
    }
    return { recordId, idempotent: false };
  }

  private async upsertRecordHosting(
    zoneId: string,
    record: IonosDnsRecordWriteInput
  ): Promise<{ recordId: string; idempotent: boolean }> {
    const encodedZone = encodeURIComponent(zoneId);
    const body = [{
      name: record.name,
      type: record.type.toUpperCase(),
      content: record.content,
      ttl: record.ttl ?? this.defaultTtl,
      prio: record.prio ?? 0,
      disabled: false
    }];
    const response = await this.send("PATCH", `/v1/zones/${encodedZone}`, body);
    if (!response.ok) {
      throw await actuatorErrorFromResponse(response, "Failed to upsert record");
    }
    const payload = await safeJson(response);
    const recordId = firstRecordIdMatching(payload, record) ?? extractId(payload) ?? "";
    return {
      recordId,
      idempotent: response.status === 200 && /already.*exists/i.test(JSON.stringify(payload ?? ""))
    };
  }

  private async findZoneByName(zoneName: string): Promise<IonosDnsCreateZoneResult | null> {
    if (this.writeApiKind === "cloud-dns") {
      const response = await this.send(
        "GET",
        `/zones?filter.zoneName=${encodeURIComponent(zoneName)}`
      );
      if (!response.ok) return null;
      const payload = await safeJson(response);
      const items = collectionItems(payload);
      for (const item of items) {
        if (!isRecord(item)) continue;
        const properties = isRecord(item.properties) ? item.properties : item;
        const name = stringValue(properties.zoneName) ?? stringValue(properties.name);
        if (name && name.toLowerCase() === zoneName.toLowerCase()) {
          const id = stringValue(item.id) ?? stringValue(properties.id);
          if (!id) continue;
          const nameservers = await this.fetchZoneNameservers(id);
          return { zoneId: id, nameservers };
        }
      }
      return null;
    }

    const response = await this.send("GET", "/v1/zones");
    if (!response.ok) return null;
    const payload = await safeJson(response);
    for (const item of collectionItems(payload)) {
      if (!isRecord(item)) continue;
      const name = stringValue(item.name) ?? stringValue(item.zoneName);
      if (name && name.toLowerCase() === zoneName.toLowerCase()) {
        const id = stringValue(item.id);
        if (!id) continue;
        return {
          zoneId: id,
          nameservers: extractStringArray(item, "nameservers")
        };
      }
    }
    return null;
  }

  private async fetchZoneNameservers(zoneId: string): Promise<string[]> {
    if (this.writeApiKind !== "cloud-dns") return [];
    const response = await this.send("GET", `/zones/${encodeURIComponent(zoneId)}`);
    if (!response.ok) return [];
    const payload = await safeJson(response);
    if (!isRecord(payload)) return [];
    const properties = isRecord(payload.properties) ? payload.properties : payload;
    return extractStringArray(properties, "nameServers")
      .concat(extractStringArray(properties, "nameservers"))
      .filter((value, idx, arr) => arr.indexOf(value) === idx);
  }

  private async findCloudRecordMatch(
    zoneId: string,
    record: IonosDnsRecordWriteInput
  ): Promise<{ id: string; matchesContent: boolean } | null> {
    const response = await this.send(
      "GET",
      `/zones/${encodeURIComponent(zoneId)}/records?limit=1000`
    );
    if (!response.ok) return null;
    const payload = await safeJson(response);
    const targetType = record.type.toUpperCase();
    for (const item of collectionItems(payload)) {
      if (!isRecord(item)) continue;
      const properties = isRecord(item.properties) ? item.properties : item;
      const name = stringValue(properties.name);
      const type = stringValue(properties.type);
      if (!name || !type) continue;
      if (name.toLowerCase() !== record.name.toLowerCase()) continue;
      if (type.toUpperCase() !== targetType) continue;
      const id = stringValue(item.id) ?? stringValue(properties.id);
      if (!id) continue;
      const currentContent = stringValue(properties.content);
      return {
        id,
        matchesContent: currentContent === record.content
      };
    }
    return null;
  }

  private async send(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "Delivrix-MailOps/0.1 (ionos-dns-actuator)"
    };
    if (this.writeApiKind === "cloud-dns") {
      headers.authorization = `Bearer ${this.tokenValue ?? ""}`;
    } else {
      headers["x-api-key"] = this.apiKeyValue ?? "";
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return this.fetchFn(`${this.writeApiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  private assertWritable(): void {
    if (!this.writeEnabled) {
      throw new IonosDnsActuatorError(
        "IONOS DNS writes are disabled by IONOS_DNS_ENABLE_WRITES.",
        { statusCode: 503, code: "WRITES_DISABLED" }
      );
    }
    if (!this.hasToken && !this.hasApiKey) {
      throw new IonosDnsActuatorError(
        "IONOS DNS writes require IONOS_API_TOKEN (Cloud DNS) or IONOS_DNS_API_KEY (Hosting DNS).",
        { statusCode: 503, code: "CREDENTIALS_MISSING" }
      );
    }
  }
}

async function actuatorErrorFromResponse(
  response: Response,
  message: string
): Promise<IonosDnsActuatorError> {
  const requestId = requestIdFromHeaders(response.headers);
  let payload: unknown = null;
  try {
    payload = await response.clone().json();
  } catch {
    payload = null;
  }
  const code = errorCodeFromPayload(payload) ?? response.statusText;
  const detail = errorMessageFromPayload(payload) ?? response.statusText;
  return new IonosDnsActuatorError(
    `${message}: ${response.status} ${detail || response.statusText}`,
    { statusCode: response.status, code, requestId }
  );
}

function requestIdFromHeaders(headers: Headers): string | undefined {
  const candidate =
    headers.get("x-request-id") ??
    headers.get("x-request-uuid") ??
    headers.get("x-amzn-requestid") ??
    undefined;
  return candidate ?? undefined;
}

function errorCodeFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const firstError = Array.isArray(payload.errors) ? payload.errors[0] : undefined;
  if (isRecord(firstError) && typeof firstError.errorCode === "string") {
    return firstError.errorCode;
  }
  if (typeof payload.code === "string") {
    return payload.code;
  }
  return undefined;
}

function errorMessageFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (Array.isArray(payload.errors)) {
    const first = payload.errors[0];
    if (isRecord(first) && typeof first.message === "string") {
      return first.message;
    }
  }
  if (typeof payload.message === "string") return payload.message;
  return undefined;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = stringValue(payload.id);
  if (direct) return direct;
  if (isRecord(payload.properties)) {
    const fromProps = stringValue(payload.properties.id);
    if (fromProps) return fromProps;
  }
  return undefined;
}

function extractStringArray(payload: unknown, key: string): string[] {
  if (!isRecord(payload)) return [];
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function firstRecordIdMatching(
  payload: unknown,
  record: IonosDnsRecordWriteInput
): string | undefined {
  if (!isRecord(payload)) return undefined;
  const recordsContainer = Array.isArray(payload.records) ? payload.records : [];
  for (const item of recordsContainer) {
    if (!isRecord(item)) continue;
    const name = stringValue(item.name);
    const type = stringValue(item.type);
    if (name === record.name && type?.toUpperCase() === record.type.toUpperCase()) {
      const id = stringValue(item.id);
      if (id) return id;
    }
  }
  return undefined;
}

function recordSnapshotFromPayload(item: unknown): IonosDnsRecordSnapshot | null {
  if (!isRecord(item)) return null;
  const properties = isRecord(item.properties) ? item.properties : item;
  const id = stringValue(item.id) ?? stringValue(properties.id);
  const name = stringValue(properties.name);
  const type = stringValue(properties.type);
  const content = stringValue(properties.content);
  if (!id || !name || !type || !content) {
    return null;
  }
  const ttl = numberValue(properties.ttl);
  const prio = numberValue(properties.priority) ?? numberValue(properties.prio);
  return {
    id,
    name,
    type: type.toUpperCase(),
    content,
    ...(ttl !== undefined ? { ttl } : {}),
    ...(prio !== undefined ? { prio } : {})
  };
}

function collectionItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.data)) return raw.data;
  if (Array.isArray(raw.records)) return raw.records;
  if (Array.isArray(raw.zones)) return raw.zones;
  return [];
}

function normalizeZoneName(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(trimmed)) {
    throw new IonosDnsActuatorError(`Invalid IONOS DNS zone name: ${value}`, {
      statusCode: 422,
      code: "ZONE_INVALID"
    });
  }
  return trimmed;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

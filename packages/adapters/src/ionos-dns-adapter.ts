export type IonosDnsProvisioningState =
  | "AVAILABLE"
  | "PROVISIONING"
  | "DESTROYING"
  | "FAILED"
  | string;

export interface IonosDnsRecord {
  id: string;
  zoneId?: string;
  name: string;
  type: string;
  content?: string;
  ttl?: number;
  priority?: number;
  enabled?: boolean;
  state?: IonosDnsProvisioningState;
}

export interface IonosDnsZone {
  id: string;
  name: string;
  type?: string;
  enabled?: boolean;
  state?: IonosDnsProvisioningState;
  records: IonosDnsRecord[];
}

export interface IonosDnsInventorySource {
  kind: "live" | "mock";
  apiKind: "cloud-dns" | "hosting-dns";
  apiBase: string;
  fetchedAt: string;
  responseOk: boolean;
  errorMessage?: string;
}

export interface IonosDnsInventoryResult {
  zones: IonosDnsZone[];
  source: IonosDnsInventorySource;
}

const DEFAULT_IONOS_CLOUD_DNS_API_BASE = "https://dns.de-fra.ionos.com";
const DEFAULT_IONOS_HOSTING_DNS_API_BASE = "https://api.hosting.ionos.com/dns";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_RECORD_FETCH_CONCURRENCY = 6;

interface CacheEntry {
  expiresAt: number;
  result: IonosDnsInventoryResult;
}

export interface IonosDnsAdapterOptions {
  token?: string;
  apiKey?: string;
  apiBase?: string;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

export class IonosDnsAdapter {
  private readonly token: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly apiKind: IonosDnsInventorySource["apiKind"];
  private readonly apiBase: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private cache: CacheEntry | null = null;

  constructor(options: IonosDnsAdapterOptions = {}) {
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    this.token =
      normalizeEnvValue(options.token) ??
      normalizeEnvValue(env.IONOS_API_TOKEN) ??
      normalizeEnvValue(env.IONOS_CLOUD_DNS_TOKEN);
    this.apiKey =
      normalizeEnvValue(options.apiKey) ??
      normalizeEnvValue(env.IONOS_DNS_API_KEY) ??
      normalizeEnvValue(env.IONOS_DOMAINS_API_KEY) ??
      normalizeEnvValue(env.IONOS_HOSTING_API_KEY) ??
      normalizeEnvValue(env.IONOS_DEVELOPER_API_KEY);
    this.apiKind = this.token ? "cloud-dns" : "hosting-dns";
    this.apiBase =
      options.apiBase ??
      (this.apiKind === "cloud-dns"
        ? DEFAULT_IONOS_CLOUD_DNS_API_BASE
        : DEFAULT_IONOS_HOSTING_DNS_API_BASE);
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  isLive(): boolean {
    return Boolean(this.token || this.apiKey);
  }

  async listInventory(): Promise<IonosDnsInventoryResult> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now.getTime()) {
      return this.cache.result;
    }

    if (!this.isLive()) {
      const result: IonosDnsInventoryResult = {
        zones: [],
        source: this.sourceMetadata(now, "mock", true)
      };
      this.cacheResult(now, result);
      return result;
    }

    try {
      const zonesResponse = await this.getJson(
        this.apiKind === "cloud-dns" ? "/zones?limit=1000" : "/v1/zones"
      );
      const zones = parseIonosDnsZones(zonesResponse);
      const zonesWithRecords = await mapWithConcurrency(
        zones,
        DEFAULT_RECORD_FETCH_CONCURRENCY,
        async (zone) => {
          const recordsResponse =
            this.apiKind === "cloud-dns"
              ? await this.getJson(`/zones/${encodeURIComponent(zone.id)}/records?limit=1000`)
              : await this.getJson(`/v1/zones/${encodeURIComponent(zone.id)}`);
          return {
            ...zone,
            records: parseIonosDnsRecords(recordsResponse, zone.id)
          };
        }
      );

      const result: IonosDnsInventoryResult = {
        zones: zonesWithRecords,
        source: this.sourceMetadata(now, "live", true)
      };
      this.cacheResult(now, result);
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown IONOS DNS fetch error";
      const result: IonosDnsInventoryResult = {
        zones: [],
        source: this.sourceMetadata(now, "live", false, errorMessage)
      };
      this.cacheResult(now, result);
      return result;
    }
  }

  invalidateCache(): void {
    this.cache = null;
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: "GET",
      headers: this.headers()
    });

    if (!response.ok) {
      throw new Error(`IONOS DNS API returned ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private sourceMetadata(
    now: Date,
    kind: IonosDnsInventorySource["kind"],
    responseOk: boolean,
    errorMessage?: string
  ): IonosDnsInventorySource {
    return {
      kind,
      apiKind: this.apiKind,
      apiBase: this.apiBase,
      fetchedAt: now.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {})
    };
  }

  private cacheResult(now: Date, result: IonosDnsInventoryResult): void {
    this.cache = {
      expiresAt: now.getTime() + this.cacheTtlMs,
      result
    };
  }

  private headers(): HeadersInit {
    const base = {
      accept: "application/json",
      "user-agent": "Delivrix-MailOps/0.1 (ionos-dns-inventory)"
    };
    if (this.apiKind === "cloud-dns") {
      return {
        ...base,
        authorization: `Bearer ${this.token ?? ""}`
      };
    }
    return {
      ...base,
      "x-api-key": this.apiKey ?? ""
    };
  }
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

export function parseIonosDnsZones(raw: unknown): IonosDnsZone[] {
  return collectionItems(raw).flatMap((item) => {
    if (!isRecord(item)) return [];
    const properties = isRecord(item.properties) ? item.properties : item;
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const id = stringValue(item.id) ?? stringValue(properties.id);
    const name =
      stringValue(properties.name) ??
      stringValue(properties.zoneName) ??
      stringValue(item.name);
    if (!id || !name) return [];
    return [{
      id,
      name,
      type: stringValue(properties.type) ?? stringValue(item.type),
      enabled: booleanValue(properties.enabled),
      state:
        stringValue(metadata.state) ??
        stringValue(properties.state) ??
        stringValue(item.state),
      records: []
    }];
  });
}

export function parseIonosDnsRecords(raw: unknown, zoneId?: string): IonosDnsRecord[] {
  return collectionItems(raw).flatMap((item) => {
    if (!isRecord(item)) return [];
    const properties = isRecord(item.properties) ? item.properties : item;
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const id = stringValue(item.id) ?? stringValue(properties.id);
    const name = stringValue(properties.name) ?? stringValue(item.name);
    const type = stringValue(properties.type) ?? stringValue(item.recordType);
    if (!id || !name || !type) return [];
    return [{
      id,
      zoneId: stringValue(properties.zoneId) ?? stringValue(item.zoneId) ?? zoneId,
      name,
      type,
      content: stringValue(properties.content) ?? stringValue(item.content),
      ttl: numberValue(properties.ttl) ?? numberValue(item.ttl),
      priority:
        numberValue(properties.priority) ??
        numberValue(properties.prio) ??
        numberValue(item.priority) ??
        numberValue(item.prio),
      enabled:
        booleanValue(properties.enabled) ??
        booleanValue(item.enabled) ??
        invertBoolean(properties.disabled) ??
        invertBoolean(item.disabled),
      state:
        stringValue(metadata.state) ??
        stringValue(properties.state) ??
        stringValue(item.state)
    }];
  });
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

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function invertBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? !value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface IonosDomainNameserver {
  name: string;
  ipV4Addresses?: string[];
  ipV6Addresses?: string[];
}

export interface IonosDomainItem {
  id: string;
  name: string;
  idn?: string;
  type?: string;
  contract?: string;
  status?: string;
  statusGroup?: string;
  provisioningStatus?: string;
  pendingProvisioning?: boolean;
  expiresAt?: string;
  domainLock?: boolean;
  transferLock?: boolean;
  autoRenew?: boolean;
  privacyEnabled?: boolean;
  dnssecEnabled?: boolean;
  nameservers: IonosDomainNameserver[];
}

export interface IonosDomainsInventorySource {
  kind: "live" | "mock";
  apiBase: string;
  fetchedAt: string;
  responseOk: boolean;
  tenantConfigured: boolean;
  errorMessage?: string;
}

export interface IonosDomainsInventoryResult {
  domains: IonosDomainItem[];
  source: IonosDomainsInventorySource;
}

const DEFAULT_IONOS_DOMAINS_API_BASE = "https://api.hosting.ionos.com/domains/v1";
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  result: IonosDomainsInventoryResult;
}

export interface IonosDomainsAdapterOptions {
  apiKey?: string;
  tenantId?: string;
  apiBase?: string;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

export class IonosDomainsAdapter {
  private readonly apiKey: string | undefined;
  private readonly tenantId: string | undefined;
  private readonly apiBase: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private cache: CacheEntry | null = null;

  constructor(options: IonosDomainsAdapterOptions = {}) {
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    this.apiKey =
      normalizeEnvValue(options.apiKey) ??
      normalizeEnvValue(env.IONOS_DOMAINS_API_KEY) ??
      normalizeEnvValue(env.IONOS_HOSTING_API_KEY) ??
      normalizeEnvValue(env.IONOS_DEVELOPER_API_KEY);
    this.tenantId =
      normalizeEnvValue(options.tenantId) ??
      normalizeEnvValue(env.IONOS_DOMAINS_TENANT_ID) ??
      normalizeEnvValue(env.IONOS_TENANT_ID);
    this.apiBase = options.apiBase ?? DEFAULT_IONOS_DOMAINS_API_BASE;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  isLive(): boolean {
    return Boolean(this.apiKey && this.tenantId);
  }

  async listInventory(): Promise<IonosDomainsInventoryResult> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now.getTime()) {
      return this.cache.result;
    }

    if (!this.apiKey || !this.tenantId) {
      const result: IonosDomainsInventoryResult = {
        domains: [],
        source: this.sourceMetadata(now, "mock", true)
      };
      this.cacheResult(now, result);
      return result;
    }

    try {
      const domainsResponse = await this.getJson("/domainitems");
      const domains = parseIonosDomains(domainsResponse);
      const domainsWithNameservers: IonosDomainItem[] = [];

      for (const domain of domains) {
        const nameserversResponse = await this.getJson(
          `/domainitems/${encodeURIComponent(domain.id)}/nameservers`
        );
        domainsWithNameservers.push({
          ...domain,
          nameservers: parseIonosNameservers(nameserversResponse)
        });
      }

      const result: IonosDomainsInventoryResult = {
        domains: domainsWithNameservers,
        source: this.sourceMetadata(now, "live", true)
      };
      this.cacheResult(now, result);
      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown IONOS Domains fetch error";
      const result: IonosDomainsInventoryResult = {
        domains: [],
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
      headers: {
        "x-api-key": this.apiKey ?? "",
        "x-tenant-id": this.tenantId ?? "",
        accept: "application/json",
        "user-agent": "Delivrix-MailOps/0.1 (ionos-domains-inventory)"
      }
    });

    if (!response.ok) {
      throw new Error(`IONOS Domains API returned ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private sourceMetadata(
    now: Date,
    kind: IonosDomainsInventorySource["kind"],
    responseOk: boolean,
    errorMessage?: string
  ): IonosDomainsInventorySource {
    return {
      kind,
      apiBase: this.apiBase,
      fetchedAt: now.toISOString(),
      responseOk,
      tenantConfigured: Boolean(this.tenantId),
      ...(errorMessage ? { errorMessage } : {})
    };
  }

  private cacheResult(now: Date, result: IonosDomainsInventoryResult): void {
    this.cache = {
      expiresAt: now.getTime() + this.cacheTtlMs,
      result
    };
  }
}

export function parseIonosDomains(raw: unknown): IonosDomainItem[] {
  return collectionItems(raw).flatMap((item) => {
    if (!isRecord(item)) return [];
    const properties = isRecord(item.properties) ? item.properties : item;
    const status = isRecord(properties.status) ? properties.status : null;
    const provisioningStatus = status && isRecord(status.provisioningStatus)
      ? status.provisioningStatus
      : null;
    const complianceStatus = status && isRecord(status.complianceStatus)
      ? status.complianceStatus
      : null;
    const processStatus = status && isRecord(status.processStatus)
      ? status.processStatus
      : null;
    const id = stringValue(item.id) ?? stringValue(properties.id) ?? stringValue(properties.domainId);
    const name =
      stringValue(properties.name) ??
      stringValue(properties.domain) ??
      stringValue(properties.domainName) ??
      stringValue(item.name);
    if (!id || !name) return [];
    return [{
      id,
      name,
      idn:
        stringValue(properties.idn) ??
        stringValue(properties.idnName) ??
        stringValue(properties.encodedName),
      type: stringValue(properties.type) ?? stringValue(properties.domainType),
      contract: stringValue(properties.contract) ?? stringValue(properties.contractNumber),
      status:
        stringValue(properties.status) ??
        stringValue(provisioningStatus?.type) ??
        stringValue(processStatus?.type) ??
        stringValue(complianceStatus?.type),
      statusGroup:
        stringValue(properties.statusGroup) ??
        stringValue(processStatus?.type) ??
        stringValue(complianceStatus?.type),
      provisioningStatus:
        stringValue(properties.provisioningStatus) ??
        stringValue(properties.provisioning_status) ??
        stringValue(provisioningStatus?.type),
      pendingProvisioning: booleanValue(properties.pendingProvisioning),
      expiresAt:
        stringValue(properties.expiresAt) ??
        stringValue(properties.expirationDate) ??
        stringValue(properties.expires) ??
        stringValue(provisioningStatus?.setToExpireOn),
      domainLock: booleanValue(properties.domainLock),
      transferLock:
        booleanValue(properties.transferLock) ??
        booleanValue(properties.transfer_lock),
      autoRenew:
        booleanValue(properties.autoRenew) ??
        booleanValue(properties.autorenew),
      privacyEnabled:
        booleanValue(properties.privacyEnabled) ??
        booleanValue(properties.privacy),
      dnssecEnabled:
        booleanValue(properties.dnssecEnabled) ??
        booleanValue(properties.dnsSecEnabled) ??
        booleanValue(properties.dnssec),
      nameservers: []
    }];
  });
}

export function parseIonosNameservers(raw: unknown): IonosDomainNameserver[] {
  return collectionItems(raw).flatMap((item) => {
    if (typeof item === "string") {
      return [{ name: item }];
    }
    if (!isRecord(item)) return [];
    const properties = isRecord(item.properties) ? item.properties : item;
    const name =
      stringValue(properties.name) ??
      stringValue(properties.hostname) ??
      stringValue(properties.host);
    if (!name) return [];
    return [{
      name,
      ipV4Addresses: stringArray(properties.ipV4Addresses ?? properties.ipv4Addresses),
      ipV6Addresses: stringArray(properties.ipV6Addresses ?? properties.ipv6Addresses)
    }];
  });
}

function collectionItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.domains)) return raw.domains;
  if (Array.isArray(raw.domainitems)) return raw.domainitems;
  if (Array.isArray(raw.nameservers)) return raw.nameservers;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

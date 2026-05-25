export interface PorkbunMoney {
  amount: number;
  currency: "USD";
}

export interface PorkbunDomainCandidate {
  domainName: string;
  tld: string;
  availability: "AVAILABLE" | "UNAVAILABLE" | "DONT_KNOW" | string;
  canRegister: boolean;
  premium: boolean;
  firstYearPromo: boolean;
  registrationPrice?: PorkbunMoney;
  renewalPrice?: PorkbunMoney;
  transferPrice?: PorkbunMoney;
  premiumPrice?: PorkbunMoney;
}

export interface PorkbunDomainSuggestion extends PorkbunDomainCandidate {
  reason: string;
}

export interface PorkbunDomainPrice {
  tld: string;
  registration?: PorkbunMoney;
  renewal?: PorkbunMoney;
  transfer?: PorkbunMoney;
}

export interface PorkbunOwnedDomain {
  domainName: string;
  tld: string;
  status?: string;
  createdAt?: string;
  expiry?: string;
  autoRenew?: boolean;
  whoisPrivacy?: boolean;
}

export interface PorkbunInventorySource {
  kind: "live" | "mock";
  apiBase: string;
  fetchedAt: string;
  responseOk: boolean;
  purchaseEnabled: boolean;
  errorMessage?: string;
}

export interface PorkbunInventoryResult {
  domains: PorkbunOwnedDomain[];
  source: PorkbunInventorySource;
}

export interface PorkbunPingResult {
  ok: boolean;
  ip: string | null;
  credentialsValid: boolean | null;
}

export interface PorkbunAdapterOptions {
  apiKey?: string;
  secretApiKey?: string;
  apiBase?: string;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  purchaseEnabled?: boolean;
  suggestionAvailabilityChecks?: number;
}

const DEFAULT_API_BASE = "https://api.porkbun.com/api/json/v3";
const DEFAULT_TTL_MS = 300_000;
const DEFAULT_SUGGESTION_AVAILABILITY_CHECKS = 1;

interface CacheEntry<T> {
  expiresAt: number;
  result: T;
}

export class PorkbunAdapter {
  private readonly apiKey: string | undefined;
  private readonly secretApiKey: string | undefined;
  private readonly apiBase: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly purchaseEnabled: boolean;
  private readonly suggestionAvailabilityChecks: number;
  private inventoryCache: CacheEntry<PorkbunInventoryResult> | null = null;
  private pricesCache: CacheEntry<PorkbunDomainPrice[]> | null = null;

  constructor(options: PorkbunAdapterOptions = {}) {
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    this.apiKey = normalizeEnvValue(options.apiKey) ?? normalizeEnvValue(env.PORKBUN_API_KEY);
    this.secretApiKey =
      normalizeEnvValue(options.secretApiKey) ??
      normalizeEnvValue(env.PORKBUN_SECRET_API_KEY) ??
      normalizeEnvValue(env.PORKBUN_SECRETAPIKEY);
    this.apiBase = trimTrailingSlash(options.apiBase ?? env.PORKBUN_BASE_URL ?? DEFAULT_API_BASE);
    this.cacheTtlMs =
      positiveNumber(options.cacheTtlMs) ??
      positiveNumber(Number(env.PORKBUN_CACHE_TTL_MS)) ??
      DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.purchaseEnabled =
      options.purchaseEnabled ??
      normalizeEnvValue(env.PORKBUN_ENABLE_PURCHASE) === "true";
    this.suggestionAvailabilityChecks =
      positiveNumber(options.suggestionAvailabilityChecks) ??
      positiveNumber(Number(env.PORKBUN_SUGGESTION_AVAILABILITY_CHECKS)) ??
      DEFAULT_SUGGESTION_AVAILABILITY_CHECKS;
  }

  isLive(): boolean {
    return Boolean(this.apiKey && this.secretApiKey);
  }

  currentSource(responseOk = true, errorMessageValue?: string): PorkbunInventorySource {
    return this.sourceMetadata(this.now(), this.isLive() ? "live" : "mock", responseOk, errorMessageValue);
  }

  async ping(): Promise<PorkbunPingResult> {
    if (!this.isLive()) {
      return {
        ok: false,
        ip: null,
        credentialsValid: null
      };
    }

    const raw = await this.porkbunJson("/ping", {});
    return {
      ok: responseStatus(raw) === "SUCCESS",
      ip: stringValue(recordValue(raw, "yourIp")) ?? stringValue(recordValue(raw, "ip")) ?? null,
      credentialsValid: booleanValue(recordValue(raw, "credentialsValid")) ?? null
    };
  }

  async checkAvailability(domainName: string): Promise<PorkbunDomainCandidate> {
    if (!this.isLive()) {
      return mockCandidate(domainName);
    }

    const raw = await this.porkbunJson(`/domain/checkDomain/${encodeURIComponent(domainName)}`, {});
    return parsePorkbunAvailability(domainName, raw);
  }

  async getSuggestions(input: {
    seed: string;
    count?: number;
  }): Promise<PorkbunDomainSuggestion[]> {
    const candidates = suggestionDomainNames(input.seed, input.count ?? 10);
    if (!this.isLive()) {
      return candidates.map((domainName) => ({
        ...mockCandidate(domainName),
        reason: "heuristic_mock_no_porkbun_credentials"
      }));
    }

    const prices = await this.listPrices(unique(candidates.map((domainName) => domainTld(domainName)).filter(isString)));
    const checkLimit = Math.max(0, Math.min(candidates.length, Math.trunc(this.suggestionAvailabilityChecks)));
    const suggestions: PorkbunDomainSuggestion[] = [];

    for (const [index, domainName] of candidates.entries()) {
      const tld = domainTld(domainName) ?? "";
      const price = prices.find((entry) => entry.tld === tld);
      if (index < checkLimit) {
        const candidate = await this.checkAvailability(domainName);
        suggestions.push({
          ...candidate,
          ...(price?.registration ? { registrationPrice: price.registration } : {}),
          ...(price?.renewal ? { renewalPrice: price.renewal } : {}),
          ...(price?.transfer ? { transferPrice: price.transfer } : {}),
          reason: "heuristic_checked_by_porkbun"
        });
        continue;
      }

      suggestions.push({
        domainName,
        tld,
        availability: "DONT_KNOW",
        canRegister: false,
        premium: false,
        firstYearPromo: false,
        ...(price?.registration ? { registrationPrice: price.registration } : {}),
        ...(price?.renewal ? { renewalPrice: price.renewal } : {}),
        ...(price?.transfer ? { transferPrice: price.transfer } : {}),
        reason: "heuristic_price_only_rate_limit_safe"
      });
    }

    return suggestions;
  }

  async listPrices(tlds: string[] = []): Promise<PorkbunDomainPrice[]> {
    if (!this.isLive()) {
      return [];
    }

    const now = this.now();
    if (this.pricesCache && this.pricesCache.expiresAt > now.getTime()) {
      return filterPrices(this.pricesCache.result, tlds);
    }

    const raw = await this.porkbunJson("/pricing/get", {});
    const prices = parsePorkbunPrices(raw);
    this.pricesCache = {
      expiresAt: now.getTime() + this.cacheTtlMs,
      result: prices
    };
    return filterPrices(prices, tlds);
  }

  async listOwnedDomains(): Promise<PorkbunOwnedDomain[]> {
    return (await this.listInventory()).domains;
  }

  async listInventory(): Promise<PorkbunInventoryResult> {
    const now = this.now();
    if (this.inventoryCache && this.inventoryCache.expiresAt > now.getTime()) {
      return this.inventoryCache.result;
    }

    if (!this.isLive()) {
      const result: PorkbunInventoryResult = {
        domains: [],
        source: this.sourceMetadata(now, "mock", true)
      };
      this.cacheInventory(now, result);
      return result;
    }

    try {
      const raw = await this.porkbunJson("/domain/listAll", {
        start: 0,
        includeLabels: "yes"
      });
      const result: PorkbunInventoryResult = {
        domains: parsePorkbunOwnedDomains(raw),
        source: this.sourceMetadata(now, "live", true)
      };
      this.cacheInventory(now, result);
      return result;
    } catch (error) {
      const result: PorkbunInventoryResult = {
        domains: [],
        source: this.sourceMetadata(now, "live", false, errorMessage(error))
      };
      this.cacheInventory(now, result);
      return result;
    }
  }

  invalidateCache(): void {
    this.inventoryCache = null;
    this.pricesCache = null;
  }

  private async porkbunJson(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "Delivrix-MailOps/0.1 (porkbun-discover)"
      },
      body: JSON.stringify({
        apikey: this.apiKey,
        secretapikey: this.secretApiKey,
        ...payload
      })
    });

    const body = await response.text();
    const parsed = parseJson(body);
    if (!response.ok) {
      throw new Error(`Porkbun API returned ${response.status} ${response.statusText}${safeApiMessage(parsed)}`);
    }
    if (isRecord(parsed) && parsed.status === "ERROR") {
      throw new Error(`Porkbun API error${safeApiMessage(parsed)}`);
    }
    return parsed;
  }

  private sourceMetadata(
    now: Date,
    kind: PorkbunInventorySource["kind"],
    responseOk: boolean,
    errorMessageValue?: string
  ): PorkbunInventorySource {
    return {
      kind,
      apiBase: this.apiBase,
      fetchedAt: now.toISOString(),
      responseOk,
      purchaseEnabled: this.purchaseEnabled,
      ...(errorMessageValue ? { errorMessage: errorMessageValue } : {})
    };
  }

  private cacheInventory(now: Date, result: PorkbunInventoryResult): void {
    this.inventoryCache = {
      expiresAt: now.getTime() + this.cacheTtlMs,
      result
    };
  }
}

export function parsePorkbunAvailability(domainName: string, raw: unknown): PorkbunDomainCandidate {
  const record = responseRecord(raw);
  const tld = domainTld(domainName) ?? "";
  const avail = stringValue(record.avail) ?? stringValue(record.availability) ?? stringValue(record.status);
  const normalizedAvailability = normalizeAvailability(avail);
  const premium =
    booleanValue(record.premium) ??
    stringValue(record.type)?.toLowerCase().includes("premium") ??
    false;
  const registrationAmount =
    numberValue(record.registration) ??
    numberValue(record.price) ??
    numberValue(record.regularPrice);
  const premiumAmount =
    numberValue(record.premiumPrice) ??
    numberValue(record.premium_price) ??
    (premium ? registrationAmount : undefined);
  const renewalAmount = numberValue(record.renewal);
  const transferAmount = numberValue(record.transfer);

  return {
    domainName,
    tld,
    availability: normalizedAvailability,
    canRegister: normalizedAvailability === "AVAILABLE" && !premium,
    premium,
    firstYearPromo:
      booleanValue(record.firstYearPromo) ??
      stringValue(record.firstYearPromo)?.toLowerCase() === "yes" ??
      false,
    ...(registrationAmount !== undefined ? { registrationPrice: money(registrationAmount) } : {}),
    ...(renewalAmount !== undefined ? { renewalPrice: money(renewalAmount) } : {}),
    ...(transferAmount !== undefined ? { transferPrice: money(transferAmount) } : {}),
    ...(premiumAmount !== undefined ? { premiumPrice: money(premiumAmount) } : {})
  };
}

export function parsePorkbunPrices(raw: unknown): PorkbunDomainPrice[] {
  const pricing = isRecord(raw) && isRecord(raw.pricing) ? raw.pricing : {};
  return Object.entries(pricing).flatMap(([rawTld, value]) => {
    if (!isRecord(value)) return [];
    const tld = normalizeTld(rawTld);
    if (!tld) return [];
    const registration = numberValue(value.registration);
    const renewal = numberValue(value.renewal);
    const transfer = numberValue(value.transfer);
    return [{
      tld,
      ...(registration !== undefined ? { registration: money(registration) } : {}),
      ...(renewal !== undefined ? { renewal: money(renewal) } : {}),
      ...(transfer !== undefined ? { transfer: money(transfer) } : {})
    }];
  }).sort((left, right) => left.tld.localeCompare(right.tld));
}

export function parsePorkbunOwnedDomains(raw: unknown): PorkbunOwnedDomain[] {
  const domains = collectionItems(raw);
  return domains.flatMap((item) => {
    if (!isRecord(item)) return [];
    const domainName =
      stringValue(item.domain) ??
      stringValue(item.domainName) ??
      stringValue(item.name);
    if (!domainName) return [];
    return [{
      domainName,
      tld: stringValue(item.tld) ?? domainTld(domainName) ?? "",
      status: stringValue(item.status),
      createdAt:
        stringValue(item.createDate) ??
        stringValue(item.createdAt) ??
        stringValue(item.registrationDate),
      expiry:
        stringValue(item.expireDate) ??
        stringValue(item.expiry) ??
        stringValue(item.expiresAt),
      autoRenew:
        booleanValue(item.autoRenew) ??
        booleanValue(item.autorenew),
      whoisPrivacy:
        booleanValue(item.whoisPrivacy) ??
        booleanValue(item.privacy)
    }];
  });
}

function suggestionDomainNames(seed: string, count: number): string[] {
  const normalizedSeed = normalizeSeed(seed);
  if (!normalizedSeed) return [];
  const base = normalizedSeed.split(".")[0];
  const variants = [
    `${base}.com`,
    `${base}.net`,
    `${base}.io`,
    `${base}.co`,
    `${base}.app`,
    `${base}mail.com`,
    `${base}send.com`,
    `${base}dx.com`,
    `${base}ops.com`,
    `${base}cloud.com`,
    `${base}mail.net`,
    `${base}send.net`
  ];
  return unique(variants).slice(0, Math.max(1, Math.min(20, Math.trunc(count))));
}

function filterPrices(prices: PorkbunDomainPrice[], tlds: string[]): PorkbunDomainPrice[] {
  const normalizedTlds = unique(tlds.map(normalizeTld).filter(isString));
  return normalizedTlds.length === 0
    ? prices
    : prices.filter((price) => normalizedTlds.includes(price.tld));
}

function normalizeAvailability(value: string | undefined): PorkbunDomainCandidate["availability"] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "yes" || normalized === "available" || normalized === "success") {
    return "AVAILABLE";
  }
  if (normalized === "no" || normalized === "unavailable" || normalized === "taken") {
    return "UNAVAILABLE";
  }
  return "DONT_KNOW";
}

function mockCandidate(domainName: string): PorkbunDomainCandidate {
  return {
    domainName,
    tld: domainTld(domainName) ?? "",
    availability: "DONT_KNOW",
    canRegister: false,
    premium: false,
    firstYearPromo: false
  };
}

function responseRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  if (isRecord(raw.response)) return raw.response;
  return raw;
}

function collectionItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  if (Array.isArray(raw.domains)) return raw.domains;
  if (isRecord(raw.response) && Array.isArray(raw.response.domains)) return raw.response.domains;
  if (Array.isArray(raw.response)) return raw.response;
  return [];
}

function responseStatus(raw: unknown): string | undefined {
  return isRecord(raw) ? stringValue(raw.status) : undefined;
}

function recordValue(raw: unknown, key: string): unknown {
  return isRecord(raw) ? raw[key] : undefined;
}

function money(amount: number): PorkbunMoney {
  return {
    amount,
    currency: "USD"
  };
}

function domainTld(domainName: string): string | undefined {
  return domainName.split(".").filter(Boolean).at(-1)?.toLowerCase();
}

function normalizeTld(tld: string | undefined): string | undefined {
  const normalized = tld?.trim().toLowerCase().replace(/^\./, "");
  return normalized && /^[a-z][a-z0-9-]{1,62}$/.test(normalized) ? normalized : undefined;
}

function normalizeSeed(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/.test(normalized)) return "";
  if (normalized.split(".").some((label) => label.length === 0 || label.startsWith("-") || label.endsWith("-"))) return "";
  return normalized;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseJson(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeApiMessage(raw: unknown): string {
  if (!isRecord(raw)) return "";
  const code = stringValue(raw.code);
  const message = stringValue(raw.message);
  if (!code && !message) return "";
  return `: ${[code, message].filter(Boolean).join(" ")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Porkbun API error";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/[^0-9.]+/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["yes", "true", "1", "enabled", "active"].includes(normalized)) return true;
  if (["no", "false", "0", "disabled", "inactive"].includes(normalized)) return false;
  return undefined;
}

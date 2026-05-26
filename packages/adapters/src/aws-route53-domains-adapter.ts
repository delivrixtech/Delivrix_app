import { createHash, createHmac } from "node:crypto";

export interface AwsRoute53DomainSummary {
  domainName: string;
  autoRenew?: boolean;
  transferLock?: boolean;
  expiry?: string;
}

export interface AwsRoute53DomainPrice {
  tld: string;
  registration?: AwsRoute53Money;
  renewal?: AwsRoute53Money;
  transfer?: AwsRoute53Money;
}

export interface AwsRoute53Money {
  amount: number;
  currency: string;
}

export interface AwsRoute53DomainCandidate {
  domainName: string;
  tld: string;
  availability: string;
  canRegister: boolean;
  registrationPrice?: AwsRoute53Money;
  renewalPrice?: AwsRoute53Money;
}

export interface AwsRoute53DomainSuggestion {
  domainName: string;
  availability?: string;
}

export interface AwsRoute53DomainsInventorySource {
  kind: "live" | "mock";
  region: string;
  apiBase: string;
  fetchedAt: string;
  responseOk: boolean;
  errorMessage?: string;
}

export interface AwsRoute53DomainsInventoryResult {
  domains: AwsRoute53DomainSummary[];
  source: AwsRoute53DomainsInventorySource;
}

export interface AwsRoute53DomainDiscoverySource extends AwsRoute53DomainsInventorySource {
  purchaseEnabled: boolean;
}

export interface AwsRoute53DomainDiscoveryResult {
  candidates: AwsRoute53DomainCandidate[];
  suggestions: AwsRoute53DomainSuggestion[];
  prices: AwsRoute53DomainPrice[];
  source: AwsRoute53DomainDiscoverySource;
}

export interface AwsRoute53DomainDiscoveryInput {
  domainNames: string[];
  suggestionSeed?: string;
  suggestionsLimit?: number;
}

export interface AwsRoute53DomainsAdapterOptions {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  region?: string;
  apiBase?: string;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  purchaseEnabled?: boolean;
}

const SERVICE = "route53domains";
const TARGET_PREFIX = "Route53Domains_v20140515";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_TTL_MS = 300_000;
const MAX_PRICE_PAGES = 20;
const LIST_PRICES_MAX_ITEMS = 100;

interface CacheEntry {
  expiresAt: number;
  result: AwsRoute53DomainsInventoryResult;
}

export class AwsRoute53DomainsAdapter {
  private readonly accessKeyId: string | undefined;
  private readonly secretAccessKey: string | undefined;
  private readonly sessionToken: string | undefined;
  private readonly region: string;
  private readonly apiBase: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly purchaseEnabled: boolean;
  private cache: CacheEntry | null = null;

  constructor(options: AwsRoute53DomainsAdapterOptions = {}) {
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    this.accessKeyId =
      normalizeEnvValue(options.accessKeyId) ??
      normalizeEnvValue(env.AWS_ROUTE53_DOMAINS_ACCESS_KEY_ID) ??
      normalizeEnvValue(env.AWS_ROUTE53_ACCESS_KEY_ID) ??
      normalizeEnvValue(env.AWS_ACCESS_KEY_ID);
    this.secretAccessKey =
      normalizeEnvValue(options.secretAccessKey) ??
      normalizeEnvValue(env.AWS_ROUTE53_DOMAINS_SECRET_ACCESS_KEY) ??
      normalizeEnvValue(env.AWS_ROUTE53_SECRET_ACCESS_KEY) ??
      normalizeEnvValue(env.AWS_SECRET_ACCESS_KEY);
    this.sessionToken =
      normalizeEnvValue(options.sessionToken) ??
      normalizeEnvValue(env.AWS_ROUTE53_DOMAINS_SESSION_TOKEN) ??
      normalizeEnvValue(env.AWS_ROUTE53_SESSION_TOKEN) ??
      normalizeEnvValue(env.AWS_SESSION_TOKEN);
    this.region =
      normalizeEnvValue(options.region) ??
      normalizeEnvValue(env.AWS_ROUTE53_DOMAINS_REGION) ??
      normalizeEnvValue(env.AWS_ROUTE53_REGION) ??
      normalizeEnvValue(env.AWS_REGION) ??
      DEFAULT_REGION;
    this.apiBase =
      options.apiBase ?? `https://route53domains.${this.region}.amazonaws.com`;
    this.cacheTtlMs =
      positiveNumber(options.cacheTtlMs) ??
      positiveNumber(Number(env.AWS_ROUTE53_DOMAINS_CACHE_TTL_MS)) ??
      positiveNumber(Number(env.AWS_ROUTE53_CACHE_TTL_MS)) ??
      DEFAULT_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.purchaseEnabled =
      options.purchaseEnabled ??
      (
        normalizeEnvValue(env.AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE) === "true" ||
        normalizeEnvValue(env.AWS_ROUTE53_ENABLE_PURCHASE) === "true"
      );
  }

  isLive(): boolean {
    return Boolean(this.accessKeyId && this.secretAccessKey);
  }

  currentSource(
    responseOk = true,
    errorMessageValue?: string
  ): AwsRoute53DomainsInventorySource {
    return this.sourceMetadata(
      this.now(),
      this.isLive() ? "live" : "mock",
      responseOk,
      errorMessageValue
    );
  }

  async checkAvailability(domainName: string): Promise<AwsRoute53DomainCandidate> {
    if (!this.isLive()) {
      return {
        domainName,
        tld: domainTld(domainName) ?? "",
        availability: "DONT_KNOW",
        canRegister: false
      };
    }
    const availabilityResponse = await this.awsJson("CheckDomainAvailability", {
      DomainName: domainName
    });
    const availability = stringValue(
      isRecord(availabilityResponse) ? availabilityResponse.Availability : undefined
    ) ?? "DONT_KNOW";
    return {
      domainName,
      tld: domainTld(domainName) ?? "",
      availability,
      canRegister: availability === "AVAILABLE"
    };
  }

  async getSuggestions(input: {
    domainName: string;
    onlyAvailable?: boolean;
    count?: number;
  }): Promise<AwsRoute53DomainSuggestion[]> {
    if (!this.isLive()) {
      return [];
    }
    return parseAwsRoute53Suggestions(await this.awsJson("GetDomainSuggestions", {
      DomainName: input.domainName,
      OnlyAvailable: input.onlyAvailable ?? true,
      SuggestionCount: Math.max(1, Math.min(20, input.count ?? 5))
    }));
  }

  async listPrices(tlds: string[] = []): Promise<AwsRoute53DomainPrice[]> {
    if (!this.isLive()) {
      return [];
    }
    const normalizedTlds = unique(tlds.map((tld) => tld.toLowerCase().replace(/^\./, "")));
    if (normalizedTlds.length > 0) {
      const prices: AwsRoute53DomainPrice[] = [];
      for (const tld of normalizedTlds) {
        prices.push(...parseAwsRoute53Prices(await this.awsJson("ListPrices", { Tld: tld })));
      }
      return uniquePrices(prices);
    }

    const prices: AwsRoute53DomainPrice[] = [];
    let marker: string | undefined;
    for (let page = 0; page < MAX_PRICE_PAGES; page += 1) {
      const payload: Record<string, unknown> = { MaxItems: LIST_PRICES_MAX_ITEMS };
      if (marker) payload.Marker = marker;
      const response = await this.awsJson("ListPrices", payload);
      prices.push(...parseAwsRoute53Prices(response));
      marker = nextPageMarker(response);
      if (!marker) break;
    }
    return normalizedTlds.length === 0
      ? uniquePrices(prices)
      : uniquePrices(prices).filter((price) => normalizedTlds.includes(price.tld));
  }

  async listOwnedDomains(): Promise<AwsRoute53DomainSummary[]> {
    return (await this.listInventory()).domains;
  }

  async listInventory(): Promise<AwsRoute53DomainsInventoryResult> {
    const now = this.now();
    if (this.cache && this.cache.expiresAt > now.getTime()) {
      return this.cache.result;
    }

    if (!this.isLive()) {
      const result: AwsRoute53DomainsInventoryResult = {
        domains: [],
        source: this.sourceMetadata(now, "mock", true)
      };
      this.cacheResult(now, result);
      return result;
    }

    try {
      const response = await this.awsJson("ListDomains", {});
      const result: AwsRoute53DomainsInventoryResult = {
        domains: parseAwsRoute53Domains(response),
        source: this.sourceMetadata(now, "live", true)
      };
      this.cacheResult(now, result);
      return result;
    } catch (error) {
      const result: AwsRoute53DomainsInventoryResult = {
        domains: [],
        source: this.sourceMetadata(now, "live", false, errorMessage(error))
      };
      this.cacheResult(now, result);
      return result;
    }
  }

  async discoverDomains(
    input: AwsRoute53DomainDiscoveryInput
  ): Promise<AwsRoute53DomainDiscoveryResult> {
    const now = this.now();
    if (!this.isLive()) {
      return {
        candidates: [],
        suggestions: [],
        prices: [],
        source: {
          ...this.sourceMetadata(now, "mock", true),
          purchaseEnabled: false
        }
      };
    }

    try {
      const tlds = unique(input.domainNames.map((domain) => domainTld(domain)).filter(isString));
      const prices = await this.listPrices(tlds);
      const candidates: AwsRoute53DomainCandidate[] = [];

      for (const domainName of unique(input.domainNames)) {
        const availabilityCandidate = await this.checkAvailability(domainName);
        const price = prices.find((entry) => entry.tld === domainTld(domainName));
        candidates.push({
          ...availabilityCandidate,
          ...(price?.registration ? { registrationPrice: price.registration } : {}),
          ...(price?.renewal ? { renewalPrice: price.renewal } : {})
        });
      }

      const suggestions = input.suggestionSeed
        ? await this.getSuggestions({
            domainName: input.suggestionSeed,
            onlyAvailable: true,
            count: input.suggestionsLimit
          })
        : [];

      return {
        candidates,
        suggestions,
        prices,
        source: {
          ...this.sourceMetadata(now, "live", true),
          purchaseEnabled: this.purchaseEnabled
        }
      };
    } catch (error) {
      return {
        candidates: [],
        suggestions: [],
        prices: [],
        source: {
          ...this.sourceMetadata(now, "live", false, errorMessage(error)),
          purchaseEnabled: this.purchaseEnabled
        }
      };
    }
  }

  invalidateCache(): void {
    this.cache = null;
  }

  private async awsJson(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify(payload);
    const now = this.now();
    const headers = signAwsJsonRequest({
      accessKeyId: this.accessKeyId ?? "",
      secretAccessKey: this.secretAccessKey ?? "",
      sessionToken: this.sessionToken,
      region: this.region,
      service: SERVICE,
      url: new URL(this.apiBase),
      target: `${TARGET_PREFIX}.${action}`,
      body,
      now
    });

    const response = await this.fetchImpl(this.apiBase, {
      method: "POST",
      headers,
      body
    });
    const responseBody = await response.text();

    if (!response.ok) {
      throw new Error(
        `AWS Route 53 Domains API returned ${response.status} ${response.statusText}: ${safePreview(responseBody)}`
      );
    }

    return responseBody.length > 0 ? JSON.parse(responseBody) : {};
  }

  private sourceMetadata(
    now: Date,
    kind: AwsRoute53DomainsInventorySource["kind"],
    responseOk: boolean,
    errorMessageValue?: string
  ): AwsRoute53DomainsInventorySource {
    return {
      kind,
      region: this.region,
      apiBase: this.apiBase,
      fetchedAt: now.toISOString(),
      responseOk,
      ...(errorMessageValue ? { errorMessage: errorMessageValue } : {})
    };
  }

  private cacheResult(now: Date, result: AwsRoute53DomainsInventoryResult): void {
    this.cache = {
      expiresAt: now.getTime() + this.cacheTtlMs,
      result
    };
  }
}

export function parseAwsRoute53Domains(raw: unknown): AwsRoute53DomainSummary[] {
  const domains = isRecord(raw) && Array.isArray(raw.Domains) ? raw.Domains : [];
  return domains.flatMap((item) => {
    if (!isRecord(item)) return [];
    const domainName = stringValue(item.DomainName);
    if (!domainName) return [];
    return [{
      domainName,
      autoRenew: booleanValue(item.AutoRenew),
      transferLock: booleanValue(item.TransferLock),
      expiry: stringValue(item.Expiry)
    }];
  });
}

export function parseAwsRoute53Prices(raw: unknown): AwsRoute53DomainPrice[] {
  const prices = isRecord(raw) && Array.isArray(raw.Prices) ? raw.Prices : [];
  return prices.flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = stringValue(item.Name) ?? stringValue(item.Tld);
    if (!name) return [];
    return [{
      tld: name.toLowerCase().replace(/^\./, ""),
      registration: moneyValue(item.RegistrationPrice),
      renewal: moneyValue(item.RenewalPrice),
      transfer: moneyValue(item.TransferPrice)
    }];
  });
}

export function parseAwsRoute53Suggestions(raw: unknown): AwsRoute53DomainSuggestion[] {
  const suggestions = isRecord(raw) && Array.isArray(raw.SuggestionsList)
    ? raw.SuggestionsList
    : [];
  return suggestions.flatMap((item) => {
    if (!isRecord(item)) return [];
    const domainName = stringValue(item.DomainName);
    if (!domainName) return [];
    return [{
      domainName,
      availability: stringValue(item.Availability)
    }];
  });
}

function nextPageMarker(raw: unknown): string | undefined {
  return isRecord(raw) ? stringValue(raw.NextPageMarker) : undefined;
}

export function signAwsJsonRequest(input: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  url: URL;
  target: string;
  body: string;
  now: Date;
}): Record<string, string> {
  const amzDate = awsTimestamp(input.now);
  const dateStamp = amzDate.slice(0, 8);
  const host = input.url.host;
  const bodyHash = sha256Hex(input.body);
  const headers: Record<string, string> = {
    "content-type": "application/x-amz-json-1.1",
    host,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": amzDate,
    "x-amz-target": input.target
  };
  if (input.sessionToken) {
    headers["x-amz-security-token"] = input.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headers[name].trim()}\n`)
    .join("");
  const canonicalRequest = [
    "POST",
    input.url.pathname || "/",
    "",
    canonicalHeaders,
    signedHeaderNames.join(";"),
    bodyHash
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = awsSigningKey(input.secretAccessKey, dateStamp, input.region, input.service);
  const signature = hmacHex(signingKey, stringToSign);

  return {
    ...headers,
    authorization: [
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}`,
      `SignedHeaders=${signedHeaderNames.join(";")}`,
      `Signature=${signature}`
    ].join(", ")
  };
}

function awsSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function awsTimestamp(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function moneyValue(value: unknown): AwsRoute53Money | undefined {
  if (!isRecord(value)) return undefined;
  const amount = numberValue(value.Price);
  const currency = stringValue(value.Currency);
  if (amount === undefined || !currency) return undefined;
  return { amount, currency };
}

function domainTld(domainName: string): string | undefined {
  const parts = domainName.toLowerCase().split(".").filter(Boolean);
  return parts.length >= 2 ? parts.at(-1) : undefined;
}

function safePreview(value: string): string {
  return value.replace(/[A-Za-z0-9/+=_-]{24,}/g, "[redacted]").slice(0, 240);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown AWS Route 53 Domains error";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniquePrices(prices: AwsRoute53DomainPrice[]): AwsRoute53DomainPrice[] {
  const byTld = new Map<string, AwsRoute53DomainPrice>();
  for (const price of prices) {
    byTld.set(price.tld, price);
  }
  return [...byTld.values()].sort((left, right) => left.tld.localeCompare(right.tld));
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveNumber(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

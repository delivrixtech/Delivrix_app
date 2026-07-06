/**
 * Namecheap Domains adapter — registrador de dominios via XML API
 * (https://api.namecheap.com/xml.response).
 *
 * Diseno alineado a las convenciones del repo:
 * - Tipos auto-contenidos (patron porkbun-adapter): sin dependencia del
 *   paquete domain.
 * - Multicuenta por env indexado: NAMECHEAP_ACCOUNT_{n}_API_USER/API_KEY/
 *   CLIENT_IP (+ _USERNAME/_LABEL/_STATUS opcionales), n=1..50 con huecos
 *   permitidos. `createNamecheapAdaptersFromEnv` devuelve una entry por
 *   cuenta ({id, label, adapter}), espejo de VpsProviderEntry.
 * - Llamadas via providerFetch: timeout 30s, retry con backoff SOLO en
 *   lecturas idempotentes, circuit breaker por cuenta.
 * - Compra de dominios SIEMPRE detras de NAMECHEAP_ENABLE_PURCHASE=false
 *   (hot-reload via runtime-env). Sin flag -> registerDomain devuelve
 *   status "blocked" sin tocar la API.
 * - Namecheap exige whitelistear la IP del gateway en cada cuenta
 *   (Profile > Tools > API Access); sin CLIENT_IP la cuenta no es live.
 */

import { createProviderFetch, type ProviderFetch } from "./provider-fetch.ts";

export type NamecheapAccountStatus = "active" | "paused" | "deprecated";

export interface NamecheapDomainCandidate {
  domainName: string;
  tld: string;
  availability: "AVAILABLE" | "UNAVAILABLE" | "DONT_KNOW";
  canRegister: boolean;
  premium: boolean;
  premiumRegistrationPrice?: number;
}

export interface NamecheapOwnedDomain {
  domainName: string;
  tld: string;
  status: string;
  createdAt?: string;
  expiry?: string;
  autoRenew?: boolean;
  whoisPrivacy?: boolean;
}

export interface NamecheapInventorySource {
  kind: "live" | "mock";
  apiBase: string;
  fetchedAt: string;
  responseOk: boolean;
  errorMessage?: string;
}

export interface NamecheapInventoryResult {
  accountId: string;
  accountLabel: string;
  accountStatus: NamecheapAccountStatus;
  domains: NamecheapOwnedDomain[];
  source: NamecheapInventorySource;
}

export interface NamecheapRegisterDomainInput {
  domainName: string;
  years?: number;
  whoisPrivacy?: boolean;
}

export interface NamecheapRegisterDomainResult {
  accountId: string;
  domainName: string;
  status: "registered" | "blocked" | "failed";
  blockedReason?: string;
  transactionId?: string;
  chargedAmountUsd?: number;
}

export interface NamecheapAdapterOptions {
  accountId?: string;
  accountLabel?: string;
  accountStatus?: NamecheapAccountStatus;
  apiUser?: string;
  apiKey?: string;
  userName?: string;
  clientIp?: string;
  apiBase?: string;
  cacheTtlMs?: number;
  providerFetch?: ProviderFetch;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  purchaseEnabled?: boolean;
}

export interface NamecheapAccountAdapterEntry {
  id: string;
  label: string;
  adapter: NamecheapDomainsAdapter;
}

const DEFAULT_API_BASE = "https://api.namecheap.com/xml.response";
const DEFAULT_TTL_MS = 300_000;
const PURCHASE_FLAG = "NAMECHEAP_ENABLE_PURCHASE";
const MAX_INDEXED_ACCOUNTS = 50;

interface CacheEntry<T> {
  expiresAt: number;
  result: T;
}

export class NamecheapDomainsAdapter {
  readonly accountId: string;
  readonly accountLabel: string;
  readonly accountStatus: NamecheapAccountStatus;
  private readonly apiUser: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly userName: string | undefined;
  private readonly clientIp: string | undefined;
  private readonly apiBase: string;
  private readonly cacheTtlMs: number;
  private readonly providerFetch: ProviderFetch;
  private readonly now: () => Date;
  private readonly env: Record<string, string | undefined>;
  private readonly purchaseEnabledOverride: boolean | undefined;
  private inventoryCache: CacheEntry<NamecheapInventoryResult> | null = null;

  constructor(options: NamecheapAdapterOptions = {}) {
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
    this.env = env;
    this.accountId = options.accountId ?? "namecheap";
    this.accountLabel = options.accountLabel ?? "Namecheap";
    this.accountStatus = options.accountStatus ?? "active";
    this.apiUser = normalizeEnvValue(options.apiUser);
    this.apiKey = normalizeEnvValue(options.apiKey);
    this.userName = normalizeEnvValue(options.userName) ?? this.apiUser;
    this.clientIp = normalizeEnvValue(options.clientIp);
    this.apiBase = trimTrailingSlash(
      options.apiBase ?? normalizeEnvValue(env.NAMECHEAP_BASE_URL) ?? DEFAULT_API_BASE
    );
    this.cacheTtlMs =
      positiveNumber(options.cacheTtlMs) ??
      positiveNumber(Number(env.NAMECHEAP_CACHE_TTL_MS)) ??
      DEFAULT_TTL_MS;
    this.providerFetch =
      options.providerFetch ??
      createProviderFetch({ env, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    this.now = options.now ?? (() => new Date());
    this.purchaseEnabledOverride = options.purchaseEnabled;
  }

  isLive(): boolean {
    return Boolean(this.apiUser && this.apiKey && this.clientIp);
  }

  purchaseEnabled(): boolean {
    // Se lee del env en cada llamada para que aplique el hot-reload de runtime-env.
    return this.purchaseEnabledOverride ?? normalizeEnvValue(this.env[PURCHASE_FLAG]) === "true";
  }

  async checkAvailability(domainName: string): Promise<NamecheapDomainCandidate> {
    if (!this.isLive()) {
      return mockCandidate(domainName);
    }

    const xml = await this.namecheapXml("namecheap.domains.check", { DomainList: domainName }, true);
    const result = firstTag(xml, "DomainCheckResult");
    const available = attrBoolean(result, "Available") ?? false;
    const premium = attrBoolean(result, "IsPremiumName") ?? false;
    const premiumPrice = attrNumber(result, "PremiumRegistrationPrice");

    return {
      domainName,
      tld: domainTld(domainName) ?? "",
      availability: available ? "AVAILABLE" : "UNAVAILABLE",
      canRegister: available && !premium,
      premium,
      ...(premiumPrice !== undefined ? { premiumRegistrationPrice: premiumPrice } : {})
    };
  }

  async listInventory(): Promise<NamecheapInventoryResult> {
    const now = this.now();
    if (this.inventoryCache && this.inventoryCache.expiresAt > now.getTime()) {
      return this.inventoryCache.result;
    }

    if (!this.isLive()) {
      return this.cacheInventory(now, [], this.sourceMetadata(now, "mock", true));
    }

    try {
      const xml = await this.namecheapXml("namecheap.domains.getList", { PageSize: "100" }, true);
      return this.cacheInventory(now, parseNamecheapOwnedDomains(xml), this.sourceMetadata(now, "live", true));
    } catch (error) {
      return this.cacheInventory(now, [], this.sourceMetadata(now, "live", false, errorMessage(error)));
    }
  }

  async registerDomain(input: NamecheapRegisterDomainInput): Promise<NamecheapRegisterDomainResult> {
    if (!this.purchaseEnabled()) {
      return {
        accountId: this.accountId,
        domainName: input.domainName,
        status: "blocked",
        blockedReason: `${PURCHASE_FLAG}_not_enabled`
      };
    }
    if (!this.isLive()) {
      return {
        accountId: this.accountId,
        domainName: input.domainName,
        status: "blocked",
        blockedReason: "namecheap_credentials_missing"
      };
    }

    const xml = await this.namecheapXml(
      "namecheap.domains.create",
      {
        DomainName: input.domainName,
        Years: String(clampYears(input.years)),
        AddFreeWhoisguard: input.whoisPrivacy === false ? "no" : "yes",
        WGEnabled: input.whoisPrivacy === false ? "no" : "yes"
      },
      false
    );
    const result = firstTag(xml, "DomainCreateResult");
    const registered = attrBoolean(result, "Registered") ?? false;
    const chargedAmount = attrNumber(result, "ChargedAmount");
    const transactionId = attrString(result, "TransactionID");

    return {
      accountId: this.accountId,
      domainName: input.domainName,
      status: registered ? "registered" : "failed",
      ...(transactionId ? { transactionId } : {}),
      ...(chargedAmount !== undefined ? { chargedAmountUsd: chargedAmount } : {})
    };
  }

  invalidateCache(): void {
    this.inventoryCache = null;
  }

  private async namecheapXml(
    command: string,
    params: Record<string, string>,
    idempotent: boolean
  ): Promise<string> {
    const query = new URLSearchParams({
      ApiUser: this.apiUser ?? "",
      ApiKey: this.apiKey ?? "",
      UserName: this.userName ?? "",
      ClientIp: this.clientIp ?? "",
      Command: command,
      ...params
    });
    const response = await this.providerFetch.fetch(
      `${this.apiBase}?${query.toString()}`,
      {
        method: "GET",
        headers: { accept: "application/xml" }
      },
      {
        idempotent,
        breakerKey: `namecheap:${this.accountId}`
      }
    );
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Namecheap API returned ${response.status} ${response.statusText}`);
    }
    const status = attrString(firstTag(body, "ApiResponse"), "Status");
    if (status?.toUpperCase() === "ERROR") {
      throw new Error(`Namecheap API error${apiErrorMessage(body)}`);
    }
    return body;
  }

  private cacheInventory(
    now: Date,
    domains: NamecheapOwnedDomain[],
    source: NamecheapInventorySource
  ): NamecheapInventoryResult {
    const result: NamecheapInventoryResult = {
      accountId: this.accountId,
      accountLabel: this.accountLabel,
      accountStatus: this.accountStatus,
      domains,
      source
    };
    this.inventoryCache = {
      expiresAt: now.getTime() + this.cacheTtlMs,
      result
    };
    return result;
  }

  private sourceMetadata(
    now: Date,
    kind: NamecheapInventorySource["kind"],
    responseOk: boolean,
    errorMessageValue?: string
  ): NamecheapInventorySource {
    return {
      kind,
      apiBase: this.apiBase,
      fetchedAt: now.toISOString(),
      responseOk,
      ...(errorMessageValue ? { errorMessage: errorMessageValue } : {})
    };
  }
}

/**
 * Una entry por cuenta indexada NAMECHEAP_ACCOUNT_{n}_*. Cuentas con
 * STATUS=deprecated se excluyen (solo quedan para teardown, no se leen).
 * Sin cuentas configuradas devuelve [].
 */
export function createNamecheapAdaptersFromEnv(
  env: Record<string, string | undefined> =
    typeof process !== "undefined" ? process.env : {},
  options: Omit<
    NamecheapAdapterOptions,
    "accountId" | "accountLabel" | "accountStatus" | "apiUser" | "apiKey" | "userName" | "clientIp" | "env"
  > = {}
): NamecheapAccountAdapterEntry[] {
  const entries: NamecheapAccountAdapterEntry[] = [];

  for (let index = 1; index <= MAX_INDEXED_ACCOUNTS; index += 1) {
    const readKey = (key: string): string | undefined =>
      normalizeEnvValue(env[`NAMECHEAP_ACCOUNT_${index}_${key}`]);

    const apiUser = readKey("API_USER");
    const apiKey = readKey("API_KEY");
    if (!apiUser || !apiKey) {
      continue;
    }
    const status = accountStatus(readKey("STATUS"));
    if (status === "deprecated") {
      continue;
    }

    const label = readKey("LABEL") ?? `Namecheap #${index}`;
    entries.push({
      id: `namecheap-${index}`,
      label,
      adapter: new NamecheapDomainsAdapter({
        ...options,
        env,
        accountId: `namecheap-${index}`,
        accountLabel: label,
        accountStatus: status,
        apiUser,
        apiKey,
        userName: readKey("USERNAME"),
        clientIp: readKey("CLIENT_IP")
      })
    });
  }

  return entries;
}

export function parseNamecheapOwnedDomains(xml: string): NamecheapOwnedDomain[] {
  return allTags(xml, "Domain").flatMap((tag) => {
    const domainName = attrString(tag, "Name");
    if (!domainName) return [];
    return [{
      domainName,
      tld: domainTld(domainName) ?? "",
      status: attrBoolean(tag, "IsExpired") === true ? "expired" : "active",
      createdAt: attrString(tag, "Created"),
      expiry: attrString(tag, "Expires"),
      autoRenew: attrBoolean(tag, "AutoRenew"),
      whoisPrivacy: whoisGuardEnabled(attrString(tag, "WhoisGuard"))
    }];
  });
}

function accountStatus(raw: string | undefined): NamecheapAccountStatus {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "paused" || normalized === "deprecated" ? normalized : "active";
}

function whoisGuardEnabled(raw: string | undefined): boolean | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized || normalized === "NOTPRESENT") return undefined;
  return normalized === "ENABLED";
}

function apiErrorMessage(xml: string): string {
  const error = firstTag(xml, "Error");
  if (!error) return "";
  const text = error.replace(/<[^>]*>/g, "").trim();
  const number = attrString(error, "Number");
  if (!text && !number) return "";
  return `: ${[number, text].filter(Boolean).join(" ")}`;
}

function firstTag(xml: string, tagName: string): string | undefined {
  const match = xml.match(new RegExp(`<${tagName}[^>]*(?:/>|>[\\s\\S]*?</${tagName}>)`, "i"));
  return match?.[0];
}

function allTags(xml: string, tagName: string): string[] {
  const matches = xml.match(new RegExp(`<${tagName}[^>]*(?:/>|>[\\s\\S]*?</${tagName}>)`, "gi"));
  return matches ?? [];
}

function attrString(tag: string | undefined, name: string): string | undefined {
  if (!tag) return undefined;
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  const value = match?.[1]?.trim();
  return value ? decodeXmlEntities(value) : undefined;
}

function attrBoolean(tag: string | undefined, name: string): boolean | undefined {
  const value = attrString(tag, name)?.toLowerCase();
  if (value === "true" || value === "yes" || value === "enabled") return true;
  if (value === "false" || value === "no" || value === "disabled") return false;
  return undefined;
}

function attrNumber(tag: string | undefined, name: string): number | undefined {
  const value = attrString(tag, name);
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(/[^0-9.]+/g, ""));
  return Number.isFinite(parsed) && value !== "" ? parsed : undefined;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function mockCandidate(domainName: string): NamecheapDomainCandidate {
  return {
    domainName,
    tld: domainTld(domainName) ?? "",
    availability: "DONT_KNOW",
    canRegister: false,
    premium: false
  };
}

function clampYears(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(10, Math.trunc(raw)));
}

function domainTld(domainName: string): string | undefined {
  return domainName.split(".").filter(Boolean).at(-1)?.toLowerCase();
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Namecheap API error";
}

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

/**
 * Un host record de la zona BasicDNS de Namecheap (namecheap.domains.dns.getHosts/setHosts).
 * La "zona" es el propio dominio; Namecheap es autoritativo (NS por default de Namecheap).
 * NO hay delegacion a terceros: es el modelo INDEPENDIENTE (espejo de IONOS autoritativo).
 */
export interface NamecheapHostRecord {
  hostName: string;
  recordType: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "URL" | "URL301" | "FRAME";
  address: string;
  mxPref?: number;
  ttl?: number;
}

export interface NamecheapHostsResult {
  accountId: string;
  domainName: string;
  hosts: NamecheapHostRecord[];
  isUsingOurDns: boolean;
}

export interface NamecheapSetHostsResult {
  accountId: string;
  domainName: string;
  hosts: NamecheapHostRecord[];
  updated: boolean;
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
  dnsWriteEnabled?: boolean;
}

export interface NamecheapAccountAdapterEntry {
  id: string;
  label: string;
  adapter: NamecheapDomainsAdapter;
}

const DEFAULT_API_BASE = "https://api.namecheap.com/xml.response";
const DEFAULT_TTL_MS = 300_000;
const PURCHASE_FLAG = "NAMECHEAP_ENABLE_PURCHASE";
const DNS_WRITE_FLAG = "NAMECHEAP_DNS_ENABLE_WRITES";
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
  private readonly dnsWriteEnabledOverride: boolean | undefined;
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
    this.dnsWriteEnabledOverride = options.dnsWriteEnabled;
  }

  isLive(): boolean {
    return Boolean(this.apiUser && this.apiKey && this.clientIp);
  }

  purchaseEnabled(): boolean {
    // Se lee del env en cada llamada para que aplique el hot-reload de runtime-env.
    return this.purchaseEnabledOverride ?? normalizeEnvValue(this.env[PURCHASE_FLAG]) === "true";
  }

  /**
   * Habilita las escrituras de DNS (setHosts/setDefault) en la zona propia de Namecheap.
   * Kill switch de escrituras DNS, hot-reload via runtime-env (espejo de IONOS_DNS_ENABLE_WRITES).
   * Independiente del flag de compra: se puede gestionar DNS sin poder comprar dominios.
   */
  isWriteEnabled(): boolean {
    return this.dnsWriteEnabledOverride ?? normalizeEnvValue(this.env[DNS_WRITE_FLAG]) === "true";
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
    // Namecheap exige los contactos WHOIS del registrante para namecheap.domains.create (incluso con
    // WhoisGuard, que solo los OCULTA). Fail-closed claro si falta alguno: el operador los configura en
    // env (NAMECHEAP_REGISTRANT_*). WhoisGuard sigue protegiendo la privacidad pública.
    const contact = resolveNamecheapRegistrantContact(this.env);
    if (!contact.ok) {
      return {
        accountId: this.accountId,
        domainName: input.domainName,
        status: "blocked",
        blockedReason: `namecheap_registrant_contact_missing:${contact.missing.join(",")}`
      };
    }

    const xml = await this.namecheapXml(
      "namecheap.domains.create",
      {
        DomainName: input.domainName,
        Years: String(clampYears(input.years)),
        AddFreeWhoisguard: input.whoisPrivacy === false ? "no" : "yes",
        WGEnabled: input.whoisPrivacy === false ? "no" : "yes",
        ...expandNamecheapContactRoles(contact.value)
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

  /**
   * Lee los host records actuales de la zona BasicDNS del dominio
   * (namecheap.domains.dns.getHosts). Lectura idempotente. Sin creds -> lanza
   * (el caller ya gatea con isLive()).
   */
  async getHosts(domainName: string): Promise<NamecheapHostsResult> {
    if (!this.isLive()) {
      throw new Error("namecheap_credentials_missing");
    }
    const { sld, tld } = splitSldTld(domainName);
    const xml = await this.namecheapXml(
      "namecheap.domains.dns.getHosts",
      { SLD: sld, TLD: tld },
      true
    );
    const result = firstTag(xml, "DomainDNSGetHostsResult");
    return {
      accountId: this.accountId,
      domainName,
      hosts: parseNamecheapHosts(xml),
      isUsingOurDns: attrBoolean(result, "IsUsingOurDNS") ?? false
    };
  }

  /**
   * Reemplaza la lista COMPLETA de host records de la zona BasicDNS del dominio
   * (namecheap.domains.dns.setHosts es full-set: lo que no mandes se borra). El caller
   * (actuator) hace getHosts + merge + setHosts para preservar records ajenos. Namecheap
   * queda como DNS autoritativo del dominio; sin dependencia de terceros (modelo
   * independiente). MUTANTE: el gating (approval/flag/kill-switch) vive en la capa de skill.
   */
  async setHosts(domainName: string, hosts: NamecheapHostRecord[]): Promise<NamecheapSetHostsResult> {
    if (!this.isLive()) {
      throw new Error("namecheap_credentials_missing");
    }
    const normalized = normalizeHosts(hosts);
    if (normalized.length === 0) {
      throw new Error("namecheap_hosts_empty");
    }
    const { sld, tld } = splitSldTld(domainName);
    const params: Record<string, string> = { SLD: sld, TLD: tld };
    normalized.forEach((host, index) => {
      const n = index + 1;
      params[`HostName${n}`] = host.hostName;
      params[`RecordType${n}`] = host.recordType;
      params[`Address${n}`] = host.address;
      params[`TTL${n}`] = String(host.ttl ?? 1800);
      if (host.recordType === "MX") {
        params[`MXPref${n}`] = String(host.mxPref ?? 10);
      }
    });
    // Con al menos un MX, Namecheap exige EmailType=MX para respetar los MX custom.
    if (normalized.some((host) => host.recordType === "MX")) {
      params.EmailType = "MX";
    }
    const xml = await this.namecheapXml("namecheap.domains.dns.setHosts", params, false);
    const result = firstTag(xml, "DomainDNSSetHostsResult");
    return {
      accountId: this.accountId,
      domainName,
      hosts: normalized,
      updated: attrBoolean(result, "IsSuccess") ?? true
    };
  }

  /**
   * Reestablece el dominio a los nameservers por default de Namecheap (BasicDNS) para que
   * Namecheap sea autoritativo y setHosts aplique (namecheap.domains.dns.setDefault).
   * Idempotente en efecto (si ya usa BasicDNS no cambia nada). MUTANTE en la API.
   */
  async setDefaultNameservers(domainName: string): Promise<NamecheapSetHostsResult> {
    if (!this.isLive()) {
      throw new Error("namecheap_credentials_missing");
    }
    const { sld, tld } = splitSldTld(domainName);
    const xml = await this.namecheapXml("namecheap.domains.dns.setDefault", { SLD: sld, TLD: tld }, false);
    const result = firstTag(xml, "DomainDNSSetDefaultResult");
    return {
      accountId: this.accountId,
      domainName,
      hosts: [],
      updated: attrBoolean(result, "Updated") ?? true
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

interface NamecheapRegistrantContact {
  firstName: string;
  lastName: string;
  address1: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  country: string;
  phone: string;
  emailAddress: string;
}

// Campos de contacto WHOIS requeridos por namecheap.domains.create. Se leen de env
// NAMECHEAP_REGISTRANT_* (el operador los provee una vez). Namecheap exige el bloque completo
// para Registrant/Tech/Admin/AuxBilling; con WhoisGuard quedan ocultos al público.
const NAMECHEAP_CONTACT_FIELDS: Array<{ key: keyof NamecheapRegistrantContact; env: string }> = [
  { key: "firstName", env: "NAMECHEAP_REGISTRANT_FIRST_NAME" },
  { key: "lastName", env: "NAMECHEAP_REGISTRANT_LAST_NAME" },
  { key: "address1", env: "NAMECHEAP_REGISTRANT_ADDRESS1" },
  { key: "city", env: "NAMECHEAP_REGISTRANT_CITY" },
  { key: "stateProvince", env: "NAMECHEAP_REGISTRANT_STATE_PROVINCE" },
  { key: "postalCode", env: "NAMECHEAP_REGISTRANT_POSTAL_CODE" },
  { key: "country", env: "NAMECHEAP_REGISTRANT_COUNTRY" },
  { key: "phone", env: "NAMECHEAP_REGISTRANT_PHONE" },
  { key: "emailAddress", env: "NAMECHEAP_REGISTRANT_EMAIL_ADDRESS" }
];

function resolveNamecheapRegistrantContact(
  env: Record<string, string | undefined>
): { ok: true; value: NamecheapRegistrantContact } | { ok: false; missing: string[] } {
  const value = {} as NamecheapRegistrantContact;
  const missing: string[] = [];
  for (const { key, env: envKey } of NAMECHEAP_CONTACT_FIELDS) {
    const raw = normalizeEnvValue(env[envKey]);
    if (!raw) {
      missing.push(envKey);
    } else {
      value[key] = raw;
    }
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, value };
}

/**
 * Namecheap exige el bloque de contacto para los 4 roles (Registrant/Tech/Admin/AuxBilling).
 * Reusamos el mismo contacto en los 4 (patron estandar). Phone debe ir en formato +NNN.NNNNNNNNNN.
 */
function expandNamecheapContactRoles(contact: NamecheapRegistrantContact): Record<string, string> {
  const params: Record<string, string> = {};
  for (const role of ["Registrant", "Tech", "Admin", "AuxBilling"]) {
    params[`${role}FirstName`] = contact.firstName;
    params[`${role}LastName`] = contact.lastName;
    params[`${role}Address1`] = contact.address1;
    params[`${role}City`] = contact.city;
    params[`${role}StateProvince`] = contact.stateProvince;
    params[`${role}PostalCode`] = contact.postalCode;
    params[`${role}Country`] = contact.country;
    params[`${role}Phone`] = contact.phone;
    params[`${role}EmailAddress`] = contact.emailAddress;
  }
  return params;
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

/**
 * Namecheap parte el dominio en SLD (etiqueta de 2do nivel) + TLD (el resto). Split en el
 * primer punto: "corpfiling-ops.com" -> {sld:"corpfiling-ops", tld:"com"};
 * "x.co.uk" -> {sld:"x", tld:"co.uk"}.
 */
function splitSldTld(domainName: string): { sld: string; tld: string } {
  const normalized = domainName.trim().toLowerCase().replace(/\.$/, "");
  const idx = normalized.indexOf(".");
  if (idx <= 0 || idx >= normalized.length - 1) {
    throw new Error(`namecheap_invalid_domain:${domainName}`);
  }
  return { sld: normalized.slice(0, idx), tld: normalized.slice(idx + 1) };
}

const NAMECHEAP_HOST_TYPES = new Set<NamecheapHostRecord["recordType"]>([
  "A", "AAAA", "CNAME", "MX", "TXT", "NS", "URL", "URL301", "FRAME"
]);

function parseNamecheapHosts(xml: string): NamecheapHostRecord[] {
  return allTags(xml, "host").flatMap((tag) => {
    const hostName = attrString(tag, "Name");
    const recordType = attrString(tag, "Type") as NamecheapHostRecord["recordType"] | undefined;
    const address = attrString(tag, "Address");
    if (!hostName || !recordType || !NAMECHEAP_HOST_TYPES.has(recordType) || address === undefined) {
      return [];
    }
    const mxPref = attrNumber(tag, "MXPref");
    const ttl = attrNumber(tag, "TTL");
    return [{
      hostName,
      recordType,
      address,
      ...(recordType === "MX" && mxPref !== undefined ? { mxPref } : {}),
      ...(ttl !== undefined ? { ttl } : {})
    }];
  });
}

/**
 * Normaliza y de-duplica host records (misma hostName+type+address+mxPref = uno solo).
 * Namecheap usa "@" para el apex; se acepta "@" tal cual.
 */
function normalizeHosts(hosts: NamecheapHostRecord[]): NamecheapHostRecord[] {
  const seen = new Set<string>();
  const normalized: NamecheapHostRecord[] = [];
  for (const raw of hosts) {
    if (!raw || !raw.recordType || !NAMECHEAP_HOST_TYPES.has(raw.recordType)) continue;
    const hostName = raw.hostName?.trim() || "@";
    const address = raw.address?.trim();
    if (!address) continue;
    const key = `${hostName.toLowerCase()}|${raw.recordType}|${address.toLowerCase()}|${raw.mxPref ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      hostName,
      recordType: raw.recordType,
      address,
      ...(raw.recordType === "MX" ? { mxPref: raw.mxPref ?? 10 } : {}),
      ...(raw.ttl !== undefined ? { ttl: raw.ttl } : {})
    });
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Namecheap API error";
}

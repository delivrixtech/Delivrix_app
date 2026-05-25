import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type {
  PorkbunDomainCandidate,
  PorkbunDomainPrice,
  PorkbunDomainSuggestion,
  PorkbunInventorySource,
  PorkbunOwnedDomain,
  PorkbunPingResult
} from "../../../../packages/adapters/src/index.ts";
import {
  buildPorkbunDomainDiscoverResponse,
  buildPorkbunDomainDiscoverySource,
  type AuditEventInput,
  type PorkbunDomainAvailabilityResponse,
  type PorkbunDomainPricesResponse,
  type PorkbunDomainSuggestionsResponse,
  type PorkbunOwnedDomainsResponse,
  type PorkbunPingResponse
} from "../../../../packages/domain/src/index.ts";

const skillInvocationHeader = "x-openclaw-skill-invocation";
const auditedSkillInvocation = "delivrix-domains-discover";
const schemaVersion = "2026-05-25.porkbun-domains-discover.v1";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface PorkbunDomainsRouteAdapter {
  checkAvailability(domainName: string): Promise<PorkbunDomainCandidate>;
  getSuggestions(input: { seed: string; count?: number }): Promise<PorkbunDomainSuggestion[]>;
  listPrices(tlds?: string[]): Promise<PorkbunDomainPrice[]>;
  listOwnedDomains(): Promise<PorkbunOwnedDomain[]>;
  ping(): Promise<PorkbunPingResult>;
  currentSource(responseOk?: boolean, errorMessage?: string): PorkbunInventorySource;
}

export interface PorkbunDomainsRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  adapter: PorkbunDomainsRouteAdapter;
  now?: () => Date;
}

export async function handlePorkbunDomainAvailabilityHttp(
  deps: PorkbunDomainsRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const domain = parseRequiredDomain(new URL(deps.request.url ?? "/", "http://127.0.0.1").searchParams);
  let candidate: PorkbunDomainCandidate = {
    domainName: domain,
    tld: domainTld(domain) ?? "",
    availability: "DONT_KNOW",
    canRegister: false,
    premium: false,
    firstYearPromo: false
  };
  let source = deps.adapter.currentSource(true);

  try {
    candidate = await deps.adapter.checkAvailability(domain);
    source = deps.adapter.currentSource(true);
  } catch (error) {
    source = deps.adapter.currentSource(false, errorMessage(error));
  }

  const payload = buildPorkbunAvailabilityResponse({ candidate, source, now });
  await auditPorkbunDiscoverIfNeeded(deps.auditLog, deps.request.headers, "availability", domain, payload);
  json(deps.response, 200, payload);
}

export async function handlePorkbunDomainSuggestionsHttp(
  deps: PorkbunDomainsRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const params = new URL(deps.request.url ?? "/", "http://127.0.0.1").searchParams;
  const seed = normalizeSeed(params.get("seed") ?? "");
  const count = clampNumber(Number(params.get("count") ?? 10), 1, 20);
  let suggestions: PorkbunDomainSuggestion[] = [];
  let source = deps.adapter.currentSource(true);

  if (seed) {
    try {
      suggestions = await deps.adapter.getSuggestions({ seed, count });
      source = deps.adapter.currentSource(true);
    } catch (error) {
      source = deps.adapter.currentSource(false, errorMessage(error));
    }
  }

  const payload = buildPorkbunSuggestionsResponse({ seed, suggestions, source, now });
  await auditPorkbunDiscoverIfNeeded(deps.auditLog, deps.request.headers, "suggestions", seed || "invalid_seed", payload);
  json(deps.response, 200, payload);
}

export async function handlePorkbunDomainPricesHttp(
  deps: PorkbunDomainsRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const params = new URL(deps.request.url ?? "/", "http://127.0.0.1").searchParams;
  const tlds = parseTlds(params.get("tlds"));
  let prices: PorkbunDomainPrice[] = [];
  let source = deps.adapter.currentSource(true);

  try {
    prices = await deps.adapter.listPrices(tlds);
    source = deps.adapter.currentSource(true);
  } catch (error) {
    source = deps.adapter.currentSource(false, errorMessage(error));
  }

  const payload = buildPorkbunPricesResponse({ prices, source, now });
  await auditPorkbunDiscoverIfNeeded(deps.auditLog, deps.request.headers, "prices", tlds.join(",") || "all", payload);
  json(deps.response, 200, payload);
}

export async function handlePorkbunOwnedDomainsHttp(
  deps: PorkbunDomainsRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  let domains: PorkbunOwnedDomain[] = [];
  let source = deps.adapter.currentSource(true);

  try {
    domains = await deps.adapter.listOwnedDomains();
    source = deps.adapter.currentSource(true);
  } catch (error) {
    source = deps.adapter.currentSource(false, errorMessage(error));
  }

  const payload = buildPorkbunOwnedDomainsResponse({ domains, source, now });
  await auditPorkbunDiscoverIfNeeded(deps.auditLog, deps.request.headers, "owned", "porkbun", payload);
  json(deps.response, 200, payload);
}

export async function handlePorkbunPingHttp(
  deps: PorkbunDomainsRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  let ping: PorkbunPingResult = {
    ok: false,
    ip: null,
    credentialsValid: null
  };
  let source = deps.adapter.currentSource(true);

  try {
    ping = await deps.adapter.ping();
    source = deps.adapter.currentSource(true);
  } catch (error) {
    source = deps.adapter.currentSource(false, errorMessage(error));
  }

  const payload = buildPorkbunPingResponse({ ping, source, now });
  await auditPorkbunDiscoverIfNeeded(deps.auditLog, deps.request.headers, "ping", "porkbun", payload);
  json(deps.response, 200, payload);
}

export function buildPorkbunAvailabilityResponse(input: {
  candidate: PorkbunDomainCandidate;
  source: PorkbunInventorySource;
  now: Date;
}): PorkbunDomainAvailabilityResponse {
  return buildPorkbunDomainDiscoverResponse({
    schemaVersion,
    generatedAt: input.now.toISOString(),
    domain: input.candidate.domainName,
    availability: input.candidate.availability,
    available: input.candidate.canRegister,
    premium: input.candidate.premium,
    firstYearPromo: input.candidate.firstYearPromo,
    regularPrice: input.candidate.registrationPrice?.amount ?? null,
    renewalPrice: input.candidate.renewalPrice?.amount ?? null,
    transferPrice: input.candidate.transferPrice?.amount ?? null,
    premiumPrice: input.candidate.premiumPrice?.amount ?? null,
    currency:
      input.candidate.registrationPrice?.currency ??
      input.candidate.renewalPrice?.currency ??
      input.candidate.transferPrice?.currency ??
      input.candidate.premiumPrice?.currency ??
      null,
    checkedAt: input.now.toISOString(),
    source: toPorkbunDiscoverySource(input.source)
  });
}

export function buildPorkbunSuggestionsResponse(input: {
  seed: string;
  suggestions: PorkbunDomainSuggestion[];
  source: PorkbunInventorySource;
  now: Date;
}): PorkbunDomainSuggestionsResponse {
  return buildPorkbunDomainDiscoverResponse({
    schemaVersion,
    generatedAt: input.now.toISOString(),
    seed: input.seed,
    suggestions: input.suggestions.map((suggestion) => ({
      domain: suggestion.domainName,
      availability: suggestion.availability,
      available: suggestion.canRegister,
      premium: suggestion.premium,
      registration: suggestion.registrationPrice?.amount ?? null,
      renewal: suggestion.renewalPrice?.amount ?? null,
      currency: suggestion.registrationPrice?.currency ?? suggestion.renewalPrice?.currency ?? null,
      reason: suggestion.reason
    })),
    source: toPorkbunDiscoverySource(input.source)
  });
}

export function buildPorkbunPricesResponse(input: {
  prices: PorkbunDomainPrice[];
  source: PorkbunInventorySource;
  now: Date;
}): PorkbunDomainPricesResponse {
  return buildPorkbunDomainDiscoverResponse({
    schemaVersion,
    generatedAt: input.now.toISOString(),
    prices: input.prices.map((price) => ({
      tld: price.tld,
      registration: price.registration?.amount ?? null,
      renewal: price.renewal?.amount ?? null,
      transfer: price.transfer?.amount ?? null,
      currency: price.registration?.currency ?? price.renewal?.currency ?? price.transfer?.currency ?? null
    })),
    source: toPorkbunDiscoverySource(input.source)
  });
}

export function buildPorkbunOwnedDomainsResponse(input: {
  domains: PorkbunOwnedDomain[];
  source: PorkbunInventorySource;
  now: Date;
}): PorkbunOwnedDomainsResponse {
  return buildPorkbunDomainDiscoverResponse({
    schemaVersion,
    generatedAt: input.now.toISOString(),
    domains: input.domains.map((domain) => ({
      domain: domain.domainName,
      tld: domain.tld,
      status: domain.status ?? null,
      expiry: domain.expiry ?? null,
      autoRenew: domain.autoRenew ?? null,
      whoisPrivacy: domain.whoisPrivacy ?? null
    })),
    source: toPorkbunDiscoverySource(input.source)
  });
}

export function buildPorkbunPingResponse(input: {
  ping: PorkbunPingResult;
  source: PorkbunInventorySource;
  now: Date;
}): PorkbunPingResponse {
  return buildPorkbunDomainDiscoverResponse({
    schemaVersion,
    generatedAt: input.now.toISOString(),
    ok: input.ping.ok,
    ip: input.ping.ip,
    credentialsValid: input.ping.credentialsValid,
    source: toPorkbunDiscoverySource(input.source)
  });
}

export function shouldAuditPorkbunDomainsDiscover(headers: IncomingHttpHeaders): boolean {
  const rawHeader = headers[skillInvocationHeader];
  const skillInvocation = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return skillInvocation === auditedSkillInvocation;
}

export class PorkbunDomainDiscoverInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "PorkbunDomainDiscoverInputError";
  }
}

export function handlePorkbunDomainDiscoverError(error: unknown, response: ServerResponse): boolean {
  if (!(error instanceof PorkbunDomainDiscoverInputError)) {
    return false;
  }
  json(response, error.statusCode, {
    error: "invalid_porkbun_domain_discover_query",
    message: error.message
  });
  return true;
}

async function auditPorkbunDiscoverIfNeeded(
  auditLog: AuditSink,
  headers: IncomingHttpHeaders,
  route: "availability" | "suggestions" | "prices" | "owned" | "ping",
  targetId: string,
  payload:
    | PorkbunDomainAvailabilityResponse
    | PorkbunDomainSuggestionsResponse
    | PorkbunDomainPricesResponse
    | PorkbunOwnedDomainsResponse
    | PorkbunPingResponse
): Promise<void> {
  if (!shouldAuditPorkbunDomainsDiscover(headers)) {
    return;
  }

  await auditLog.append({
    actorType: "openclaw",
    actorId: auditedSkillInvocation,
    action: "oc.domains.porkbun.discover",
    targetType: "domain_discovery",
    targetId,
    riskLevel: payload.source.responseOk ? "low" : "medium",
    decision: "n/a",
    metadata: {
      route,
      sourceKind: payload.source.kind,
      responseOk: payload.source.responseOk,
      purchaseEnabled: payload.source.purchaseEnabled,
      itemCount: responseItemCount(payload)
    }
  });
}

function responseItemCount(
  payload:
    | PorkbunDomainAvailabilityResponse
    | PorkbunDomainSuggestionsResponse
    | PorkbunDomainPricesResponse
    | PorkbunOwnedDomainsResponse
    | PorkbunPingResponse
): number {
  if ("suggestions" in payload) return payload.suggestions.length;
  if ("prices" in payload) return payload.prices.length;
  if ("domains" in payload) return payload.domains.length;
  return 1;
}

function toPorkbunDiscoverySource(source: PorkbunInventorySource) {
  return buildPorkbunDomainDiscoverySource({
    kind: source.kind,
    responseOk: source.responseOk,
    purchaseEnabled: source.purchaseEnabled,
    errorReason: source.errorMessage
  });
}

function parseRequiredDomain(params: URLSearchParams): string {
  const domain = normalizeDomainName(params.get("name") ?? "");
  if (!domain) {
    throw new PorkbunDomainDiscoverInputError("Missing or invalid domain name. Use ?name=example.com");
  }
  return domain;
}

function normalizeDomainName(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!normalized.includes(".")) return "";
  if (!/^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/.test(normalized)) return "";
  if (normalized.split(".").some((label) => label.length === 0 || label.startsWith("-") || label.endsWith("-"))) return "";
  return normalized;
}

function normalizeSeed(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/.test(normalized)) return "";
  if (normalized.split(".").some((label) => label.length === 0 || label.startsWith("-") || label.endsWith("-"))) return "";
  return normalized;
}

function parseTlds(raw: string | null): string[] {
  return [...new Set((raw ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase().replace(/^\./, ""))
    .filter((value) => /^[a-z][a-z0-9-]{1,62}$/.test(value)))];
}

function domainTld(domainName: string): string | undefined {
  return domainName.split(".").filter(Boolean).at(-1);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Porkbun Domains error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

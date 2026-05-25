import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type {
  AwsRoute53DomainCandidate,
  AwsRoute53DomainPrice,
  AwsRoute53DomainSuggestion,
  AwsRoute53DomainSummary,
  AwsRoute53DomainsInventorySource
} from "../../../../packages/adapters/src/index.ts";
import {
  buildDomainDiscoverResponse,
  buildDomainDiscoverySource,
  type AuditEventInput,
  type DomainAvailabilityResponse,
  type DomainPricesResponse,
  type DomainSuggestionsResponse,
  type OwnedDomainsResponse
} from "../../../../packages/domain/src/index.ts";

const skillInvocationHeader = "x-openclaw-skill-invocation";
const auditedSkillInvocation = "delivrix-domains-discover";
const schemaVersion = "2026-05-25.domains-discover.v1";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface DomainsRouteAdapter {
  checkAvailability(domainName: string): Promise<AwsRoute53DomainCandidate>;
  getSuggestions(input: {
    domainName: string;
    onlyAvailable?: boolean;
    count?: number;
  }): Promise<AwsRoute53DomainSuggestion[]>;
  listPrices(tlds?: string[]): Promise<AwsRoute53DomainPrice[]>;
  listOwnedDomains(): Promise<AwsRoute53DomainSummary[]>;
  currentSource(responseOk?: boolean, errorMessage?: string): AwsRoute53DomainsInventorySource;
}

export interface DomainsRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  adapter: DomainsRouteAdapter;
  now?: () => Date;
}

export async function handleDomainAvailabilityHttp(
  deps: DomainsRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const domain = parseRequiredDomain(new URL(deps.request.url ?? "/", "http://127.0.0.1").searchParams);
  let candidate: AwsRoute53DomainCandidate = {
    domainName: domain,
    tld: domainTld(domain) ?? "",
    availability: "DONT_KNOW",
    canRegister: false
  };
  let source = deps.adapter.currentSource(true);

  try {
    candidate = await deps.adapter.checkAvailability(domain);
    source = deps.adapter.currentSource(true);
  } catch (error) {
    source = deps.adapter.currentSource(false, errorMessage(error));
  }

  const payload = buildDomainAvailabilityResponse({ candidate, source, now });
  await auditDomainDiscoverIfNeeded(deps.auditLog, deps.request.headers, "availability", domain, payload);
  json(deps.response, 200, payload);
}

export async function handleDomainSuggestionsHttp(
  deps: DomainsRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const params = new URL(deps.request.url ?? "/", "http://127.0.0.1").searchParams;
  const seed = normalizeSeed(params.get("seed") ?? "");
  const count = clampNumber(Number(params.get("count") ?? 10), 1, 20);
  let suggestions: AwsRoute53DomainSuggestion[] = [];
  let source = deps.adapter.currentSource(true);

  if (seed) {
    try {
      suggestions = await deps.adapter.getSuggestions({
        domainName: seed.includes(".") ? seed : `${seed}.com`,
        onlyAvailable: true,
        count
      });
      source = deps.adapter.currentSource(true);
    } catch (error) {
      source = deps.adapter.currentSource(false, errorMessage(error));
    }
  }

  const payload = buildDomainSuggestionsResponse({ seed, suggestions, source, now });
  await auditDomainDiscoverIfNeeded(deps.auditLog, deps.request.headers, "suggestions", seed || "invalid_seed", payload);
  json(deps.response, 200, payload);
}

export async function handleDomainPricesHttp(
  deps: DomainsRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const params = new URL(deps.request.url ?? "/", "http://127.0.0.1").searchParams;
  const tlds = parseTlds(params.get("tlds"));
  let prices: AwsRoute53DomainPrice[] = [];
  let source = deps.adapter.currentSource(true);

  try {
    prices = await deps.adapter.listPrices(tlds);
    source = deps.adapter.currentSource(true);
  } catch (error) {
    source = deps.adapter.currentSource(false, errorMessage(error));
  }

  const payload = buildDomainPricesResponse({ prices, source, now });
  await auditDomainDiscoverIfNeeded(deps.auditLog, deps.request.headers, "prices", tlds.join(",") || "all", payload);
  json(deps.response, 200, payload);
}

export async function handleOwnedDomainsHttp(
  deps: DomainsRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  let domains: AwsRoute53DomainSummary[] = [];
  let source = deps.adapter.currentSource(true);

  try {
    domains = await deps.adapter.listOwnedDomains();
    source = deps.adapter.currentSource(true);
  } catch (error) {
    source = deps.adapter.currentSource(false, errorMessage(error));
  }

  const payload = buildOwnedDomainsResponse({ domains, source, now });
  await auditDomainDiscoverIfNeeded(deps.auditLog, deps.request.headers, "owned", "aws-route53-domains", payload);
  json(deps.response, 200, payload);
}

export function buildDomainAvailabilityResponse(input: {
  candidate: AwsRoute53DomainCandidate;
  source: AwsRoute53DomainsInventorySource;
  now: Date;
}): DomainAvailabilityResponse {
  return buildDomainDiscoverResponse({
    schemaVersion,
    generatedAt: input.now.toISOString(),
    domain: input.candidate.domainName,
    availability: input.candidate.availability,
    available: input.candidate.canRegister,
    checkedAt: input.now.toISOString(),
    source: toDomainDiscoverySource(input.source)
  });
}

export function buildDomainSuggestionsResponse(input: {
  seed: string;
  suggestions: AwsRoute53DomainSuggestion[];
  source: AwsRoute53DomainsInventorySource;
  now: Date;
}): DomainSuggestionsResponse {
  return buildDomainDiscoverResponse({
    schemaVersion,
    generatedAt: input.now.toISOString(),
    seed: input.seed,
    suggestions: input.suggestions.map((suggestion) => ({
      domain: suggestion.domainName,
      availability: suggestion.availability ?? null
    })),
    source: toDomainDiscoverySource(input.source)
  });
}

export function buildDomainPricesResponse(input: {
  prices: AwsRoute53DomainPrice[];
  source: AwsRoute53DomainsInventorySource;
  now: Date;
}): DomainPricesResponse {
  return buildDomainDiscoverResponse({
    schemaVersion,
    generatedAt: input.now.toISOString(),
    prices: input.prices.map((price) => ({
      tld: price.tld,
      registration: price.registration?.amount ?? null,
      renewal: price.renewal?.amount ?? null,
      currency: price.registration?.currency ?? price.renewal?.currency ?? null
    })),
    source: toDomainDiscoverySource(input.source)
  });
}

export function buildOwnedDomainsResponse(input: {
  domains: AwsRoute53DomainSummary[];
  source: AwsRoute53DomainsInventorySource;
  now: Date;
}): OwnedDomainsResponse {
  return buildDomainDiscoverResponse({
    schemaVersion,
    generatedAt: input.now.toISOString(),
    domains: input.domains.map((domain) => ({
      domain: domain.domainName,
      expiry: domain.expiry ?? null,
      autoRenew: domain.autoRenew ?? null,
      transferLock: domain.transferLock ?? null
    })),
    source: toDomainDiscoverySource(input.source)
  });
}

export function shouldAuditDomainsDiscover(headers: IncomingHttpHeaders): boolean {
  const rawHeader = headers[skillInvocationHeader];
  const skillInvocation = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return skillInvocation === auditedSkillInvocation;
}

export class DomainDiscoverInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "DomainDiscoverInputError";
  }
}

export function handleDomainDiscoverError(error: unknown, response: ServerResponse): boolean {
  if (!(error instanceof DomainDiscoverInputError)) {
    return false;
  }
  json(response, error.statusCode, {
    error: "invalid_domain_discover_query",
    message: error.message
  });
  return true;
}

async function auditDomainDiscoverIfNeeded(
  auditLog: AuditSink,
  headers: IncomingHttpHeaders,
  route: "availability" | "suggestions" | "prices" | "owned",
  targetId: string,
  payload: DomainAvailabilityResponse | DomainSuggestionsResponse | DomainPricesResponse | OwnedDomainsResponse
): Promise<void> {
  if (!shouldAuditDomainsDiscover(headers)) {
    return;
  }

  await auditLog.append({
    actorType: "openclaw",
    actorId: auditedSkillInvocation,
    action: "oc.domains.discover",
    targetType: "domain_discovery",
    targetId,
    riskLevel: payload.source.responseOk ? "low" : "medium",
    decision: "n/a",
    metadata: {
      route,
      sourceKind: payload.source.kind,
      responseOk: payload.source.responseOk,
      itemCount: responseItemCount(payload)
    }
  });
}

function responseItemCount(
  payload: DomainAvailabilityResponse | DomainSuggestionsResponse | DomainPricesResponse | OwnedDomainsResponse
): number {
  if ("suggestions" in payload) return payload.suggestions.length;
  if ("prices" in payload) return payload.prices.length;
  if ("domains" in payload) return payload.domains.length;
  return 1;
}

function toDomainDiscoverySource(source: AwsRoute53DomainsInventorySource) {
  return buildDomainDiscoverySource({
    kind: source.kind,
    region: source.region,
    responseOk: source.responseOk,
    errorReason: source.errorMessage
  });
}

function parseRequiredDomain(params: URLSearchParams): string {
  const domain = normalizeDomainName(params.get("name") ?? "");
  if (!domain) {
    throw new DomainDiscoverInputError("Missing or invalid domain name. Use ?name=example.com");
  }
  return domain;
}

function normalizeDomainName(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!normalized.includes(".")) {
    return "";
  }
  if (!/^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/.test(normalized)) {
    return "";
  }
  if (normalized.split(".").some((label) => label.length === 0 || label.startsWith("-") || label.endsWith("-"))) {
    return "";
  }
  return normalized;
}

function normalizeSeed(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/.test(normalized)) {
    return "";
  }
  if (normalized.split(".").some((label) => label.length === 0 || label.startsWith("-") || label.endsWith("-"))) {
    return "";
  }
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
  return error instanceof Error ? error.message : "Unknown AWS Route 53 Domains error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

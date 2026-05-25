import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AwsRoute53DomainCandidate,
  AwsRoute53DomainPrice,
  AwsRoute53DomainsInventorySource,
  PorkbunDomainCandidate,
  PorkbunDomainPrice,
  PorkbunInventorySource
} from "../../../../packages/adapters/src/index.ts";
import {
  buildDomainCompareResponse,
  type DomainCompareProvider,
  type DomainCompareResponse
} from "../../../../packages/domain/src/index.ts";

export interface DomainCompareAwsAdapter {
  checkAvailability(domainName: string): Promise<AwsRoute53DomainCandidate>;
  listPrices(tlds?: string[]): Promise<AwsRoute53DomainPrice[]>;
  currentSource(responseOk?: boolean, errorMessage?: string): AwsRoute53DomainsInventorySource;
}

export interface DomainComparePorkbunAdapter {
  checkAvailability(domainName: string): Promise<PorkbunDomainCandidate>;
  listPrices(tlds?: string[]): Promise<PorkbunDomainPrice[]>;
  currentSource(responseOk?: boolean, errorMessage?: string): PorkbunInventorySource;
}

export interface DomainCompareRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  awsAdapter: DomainCompareAwsAdapter;
  porkbunAdapter: DomainComparePorkbunAdapter;
  now?: () => Date;
}

export async function handleDomainCompareHttp(
  deps: DomainCompareRouteDependencies
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const domain = parseRequiredDomain(new URL(deps.request.url ?? "/", "http://127.0.0.1").searchParams);
  const tld = domainTld(domain) ?? "";
  const [awsProvider, porkbunProvider] = await Promise.all([
    compareAwsRoute53(deps.awsAdapter, domain, tld),
    comparePorkbun(deps.porkbunAdapter, domain, tld)
  ]);
  const providers = [awsProvider, porkbunProvider];
  const response = buildDomainCompareResponse({
    schemaVersion: "2026-05-25.domains-compare.v1",
    generatedAt: now.toISOString(),
    domain,
    providers,
    recommendation: recommendProvider(providers),
    source: {
      kind: providers.some((provider) => provider.sourceKind === "live") ? "live" : "mock",
      responseOk: providers.every((provider) => provider.responseOk)
    }
  });

  json(deps.response, 200, response);
}

export class DomainCompareInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "DomainCompareInputError";
  }
}

export function handleDomainCompareError(error: unknown, response: ServerResponse): boolean {
  if (!(error instanceof DomainCompareInputError)) {
    return false;
  }
  json(response, error.statusCode, {
    error: "invalid_domain_compare_query",
    message: error.message
  });
  return true;
}

async function compareAwsRoute53(
  adapter: DomainCompareAwsAdapter,
  domain: string,
  tld: string
): Promise<DomainCompareProvider> {
  try {
    const [candidate, prices] = await Promise.all([
      adapter.checkAvailability(domain),
      adapter.listPrices([tld])
    ]);
    const price = prices.find((entry) => entry.tld === tld);
    const source = adapter.currentSource(true);
    return {
      provider: "aws-route53-domains",
      available: candidate.canRegister,
      availability: candidate.availability,
      registration: candidate.registrationPrice?.amount ?? price?.registration?.amount ?? null,
      renewal: candidate.renewalPrice?.amount ?? price?.renewal?.amount ?? null,
      currency:
        candidate.registrationPrice?.currency ??
        price?.registration?.currency ??
        candidate.renewalPrice?.currency ??
        price?.renewal?.currency ??
        null,
      sourceKind: source.kind,
      responseOk: source.responseOk
    };
  } catch (error) {
    const source = adapter.currentSource(false, errorMessage(error));
    return {
      provider: "aws-route53-domains",
      available: false,
      availability: "DONT_KNOW",
      registration: null,
      renewal: null,
      currency: null,
      sourceKind: source.kind,
      responseOk: false,
      errorReason: source.errorMessage ?? errorMessage(error)
    };
  }
}

async function comparePorkbun(
  adapter: DomainComparePorkbunAdapter,
  domain: string,
  tld: string
): Promise<DomainCompareProvider> {
  try {
    const [candidate, prices] = await Promise.all([
      adapter.checkAvailability(domain),
      adapter.listPrices([tld])
    ]);
    const price = prices.find((entry) => entry.tld === tld);
    const source = adapter.currentSource(true);
    return {
      provider: "porkbun",
      available: candidate.canRegister,
      availability: candidate.availability,
      registration: candidate.registrationPrice?.amount ?? price?.registration?.amount ?? null,
      renewal: candidate.renewalPrice?.amount ?? price?.renewal?.amount ?? null,
      currency:
        candidate.registrationPrice?.currency ??
        price?.registration?.currency ??
        candidate.renewalPrice?.currency ??
        price?.renewal?.currency ??
        null,
      sourceKind: source.kind,
      responseOk: source.responseOk
    };
  } catch (error) {
    const source = adapter.currentSource(false, errorMessage(error));
    return {
      provider: "porkbun",
      available: false,
      availability: "DONT_KNOW",
      registration: null,
      renewal: null,
      currency: null,
      sourceKind: source.kind,
      responseOk: false,
      errorReason: source.errorMessage ?? errorMessage(error)
    };
  }
}

function recommendProvider(providers: DomainCompareProvider[]): DomainCompareResponse["recommendation"] {
  const candidates = providers
    .filter((provider) => provider.available && provider.registration !== null)
    .sort((left, right) => (left.registration ?? Number.POSITIVE_INFINITY) - (right.registration ?? Number.POSITIVE_INFINITY));
  const winner = candidates[0];
  if (!winner || winner.registration === null || !winner.currency) {
    return null;
  }
  const competitor = candidates[1];
  const reason = competitor?.registration
    ? `${winner.provider} is cheapest for initial registration by ${formatMoney(competitor.registration - winner.registration, winner.currency)}.`
    : `${winner.provider} is the only provider with an available priced result.`;
  return {
    provider: winner.provider,
    reason,
    registration: winner.registration,
    renewal: winner.renewal,
    currency: winner.currency
  };
}

function parseRequiredDomain(params: URLSearchParams): string {
  const domain = normalizeDomainName(params.get("name") ?? "");
  if (!domain) {
    throw new DomainCompareInputError("Missing or invalid domain name. Use ?name=example.com");
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

function domainTld(domainName: string): string | undefined {
  return domainName.split(".").filter(Boolean).at(-1);
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown domain compare error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

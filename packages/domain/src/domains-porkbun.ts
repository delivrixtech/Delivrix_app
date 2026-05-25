export type PorkbunDomainAvailability = "AVAILABLE" | "UNAVAILABLE" | "DONT_KNOW" | string;

export interface PorkbunDomainDiscoverySource {
  provider: "porkbun";
  kind: "live" | "mock";
  responseOk: boolean;
  purchaseEnabled: boolean;
  errorReason?: string;
}

export interface PorkbunDomainAvailabilityResponse {
  schemaVersion: "2026-05-25.porkbun-domains-discover.v1";
  generatedAt: string;
  domain: string;
  availability: PorkbunDomainAvailability;
  available: boolean;
  premium: boolean;
  firstYearPromo: boolean;
  regularPrice: number | null;
  renewalPrice: number | null;
  transferPrice: number | null;
  premiumPrice: number | null;
  currency: "USD" | null;
  checkedAt: string;
  source: PorkbunDomainDiscoverySource;
}

export interface PorkbunDomainSuggestionsResponse {
  schemaVersion: "2026-05-25.porkbun-domains-discover.v1";
  generatedAt: string;
  seed: string;
  suggestions: Array<{
    domain: string;
    availability: PorkbunDomainAvailability;
    available: boolean;
    premium: boolean;
    registration: number | null;
    renewal: number | null;
    currency: "USD" | null;
    reason: string;
  }>;
  source: PorkbunDomainDiscoverySource;
}

export interface PorkbunDomainPricesResponse {
  schemaVersion: "2026-05-25.porkbun-domains-discover.v1";
  generatedAt: string;
  prices: Array<{
    tld: string;
    registration: number | null;
    renewal: number | null;
    transfer: number | null;
    currency: "USD" | null;
  }>;
  source: PorkbunDomainDiscoverySource;
}

export interface PorkbunOwnedDomainsResponse {
  schemaVersion: "2026-05-25.porkbun-domains-discover.v1";
  generatedAt: string;
  domains: Array<{
    domain: string;
    tld: string;
    status: string | null;
    expiry: string | null;
    autoRenew: boolean | null;
    whoisPrivacy: boolean | null;
  }>;
  source: PorkbunDomainDiscoverySource;
}

export interface PorkbunPingResponse {
  schemaVersion: "2026-05-25.porkbun-domains-discover.v1";
  generatedAt: string;
  ok: boolean;
  ip: string | null;
  credentialsValid: boolean | null;
  source: PorkbunDomainDiscoverySource;
}

export type PorkbunDomainDiscoverResponse =
  | PorkbunDomainAvailabilityResponse
  | PorkbunDomainSuggestionsResponse
  | PorkbunDomainPricesResponse
  | PorkbunOwnedDomainsResponse
  | PorkbunPingResponse;

export interface DomainCompareResponse {
  schemaVersion: "2026-05-25.domains-compare.v1";
  generatedAt: string;
  domain: string;
  providers: DomainCompareProvider[];
  recommendation: {
    provider: "aws-route53-domains" | "porkbun";
    reason: string;
    registration: number;
    renewal: number | null;
    currency: string;
  } | null;
  source: {
    kind: "live" | "mock";
    responseOk: boolean;
  };
}

export interface DomainCompareProvider {
  provider: "aws-route53-domains" | "porkbun";
  available: boolean;
  availability: string;
  registration: number | null;
  renewal: number | null;
  currency: string | null;
  sourceKind: "live" | "mock";
  responseOk: boolean;
  errorReason?: string;
}

export function buildPorkbunDomainDiscoverySource(input: {
  kind: "live" | "mock";
  responseOk: boolean;
  purchaseEnabled: boolean;
  errorReason?: string;
}): PorkbunDomainDiscoverySource {
  return {
    provider: "porkbun",
    kind: input.kind,
    responseOk: input.responseOk,
    purchaseEnabled: input.purchaseEnabled,
    ...(input.errorReason ? { errorReason: input.errorReason } : {})
  };
}

export function buildPorkbunDomainDiscoverResponse<T extends PorkbunDomainDiscoverResponse>(response: T): T {
  return response;
}

export function buildDomainCompareResponse(response: DomainCompareResponse): DomainCompareResponse {
  return response;
}

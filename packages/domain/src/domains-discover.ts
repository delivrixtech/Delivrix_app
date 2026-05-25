export type DomainAvailability =
  | "AVAILABLE"
  | "AVAILABLE_RESERVED"
  | "AVAILABLE_PREORDER"
  | "UNAVAILABLE"
  | "UNAVAILABLE_PREMIUM"
  | "UNAVAILABLE_RESTRICTED"
  | "RESERVED"
  | "DONT_KNOW"
  | "INVALID_NAME_FOR_TLD"
  | "PENDING"
  | string;

export interface DomainAvailabilityResponse {
  schemaVersion: "2026-05-25.domains-discover.v1";
  generatedAt: string;
  domain: string;
  availability: DomainAvailability;
  available: boolean;
  checkedAt: string;
  source: DomainDiscoverySource;
}

export interface DomainSuggestionsResponse {
  schemaVersion: "2026-05-25.domains-discover.v1";
  generatedAt: string;
  seed: string;
  suggestions: Array<{
    domain: string;
    availability: DomainAvailability | null;
  }>;
  source: DomainDiscoverySource;
}

export interface DomainPricesResponse {
  schemaVersion: "2026-05-25.domains-discover.v1";
  generatedAt: string;
  prices: Array<{
    tld: string;
    registration: number | null;
    renewal: number | null;
    currency: string | null;
  }>;
  source: DomainDiscoverySource;
}

export interface OwnedDomainsResponse {
  schemaVersion: "2026-05-25.domains-discover.v1";
  generatedAt: string;
  domains: Array<{
    domain: string;
    expiry: string | null;
    autoRenew: boolean | null;
    transferLock: boolean | null;
  }>;
  source: DomainDiscoverySource;
}

export interface DomainDiscoverySource {
  provider: "aws-route53-domains";
  kind: "live" | "mock";
  region: string;
  responseOk: boolean;
  errorReason?: string;
}

export type DomainDiscoverResponse =
  | DomainAvailabilityResponse
  | DomainSuggestionsResponse
  | DomainPricesResponse
  | OwnedDomainsResponse;

export function buildDomainDiscoverySource(input: {
  kind: "live" | "mock";
  region: string;
  responseOk: boolean;
  errorReason?: string;
}): DomainDiscoverySource {
  return {
    provider: "aws-route53-domains",
    kind: input.kind,
    region: input.region,
    responseOk: input.responseOk,
    ...(input.errorReason ? { errorReason: input.errorReason } : {})
  };
}

export function buildDomainDiscoverResponse<T extends DomainDiscoverResponse>(response: T): T {
  return response;
}

import type {
  AwsRoute53DomainsInventoryResult,
  IonosDomainsInventoryResult,
  NamecheapInventoryResult
} from "../../../packages/adapters/src/index.ts";
import type { OwnedDomainVerification } from "./routes/orchestrator-smtp.ts";

export const REGISTRAR_PRECEDENCE = ["route53", "ionos", "namecheap"] as const;

export interface DomainOwnershipInventoryReaders {
  route53: {
    listInventory(): Promise<AwsRoute53DomainsInventoryResult> | AwsRoute53DomainsInventoryResult;
  };
  ionos: {
    listInventory(): Promise<IonosDomainsInventoryResult> | IonosDomainsInventoryResult;
  };
  namecheap?: {
    listInventory(): Promise<NamecheapInventoryResult> | NamecheapInventoryResult;
  };
  logger?: {
    warn(event: string, metadata: Record<string, unknown>): unknown;
    info?(event: string, metadata: Record<string, unknown>): unknown;
  };
}

interface RegistrarOwnershipCheck {
  id: OwnedDomainVerification["provider"];
  verify(): Promise<OwnedDomainVerification>;
}

export async function verifyOwnedDomainAcrossRegistrars(
  domain: string,
  readers: DomainOwnershipInventoryReaders
): Promise<OwnedDomainVerification> {
  const normalized = normalizeDomainForOwnership(domain);
  const checks = registrarChecks(normalized, readers);
  const misses: OwnedDomainVerification[] = [];

  // Deliberately sequential: the first owned match wins according to REGISTRAR_PRECEDENCE.
  // This keeps cross-registrar duplicates deterministic and avoids extra provider calls.
  for (const check of checks) {
    const verification = await safeVerify(check, readers.logger);
    if (verification.owned) return verification;
    misses.push(verification);
  }

  return selectOwnershipMiss(misses);
}

function registrarChecks(
  normalizedDomain: string,
  readers: DomainOwnershipInventoryReaders
): RegistrarOwnershipCheck[] {
  const checks: RegistrarOwnershipCheck[] = [];
  for (const id of REGISTRAR_PRECEDENCE) {
    if (id === "route53") {
      checks.push({ id, verify: async () => verifyRoute53Ownership(normalizedDomain, await readers.route53.listInventory()) });
    } else if (id === "ionos") {
      checks.push({ id, verify: async () => verifyIonosOwnership(normalizedDomain, await readers.ionos.listInventory()) });
    } else if (id === "namecheap" && readers.namecheap) {
      const namecheap = readers.namecheap;
      checks.push({ id, verify: async () => verifyNamecheapOwnership(normalizedDomain, await namecheap.listInventory()) });
    }
  }
  return checks;
}

function verifyRoute53Ownership(
  normalizedDomain: string,
  inventory: AwsRoute53DomainsInventoryResult
): OwnedDomainVerification {
  if (inventory.source.kind !== "live" || inventory.source.responseOk !== true) {
    return {
      owned: false,
      provider: "route53",
      reason: "route53_domain_inventory_not_live",
      sourceKind: inventory.source.kind,
      responseOk: inventory.source.responseOk
    };
  }
  const owned = inventory.domains.some((entry) =>
    normalizeDomainForOwnership(entry.domainName) === normalizedDomain
  );
  return {
    owned,
    provider: "route53",
    reason: owned ? "listed_in_route53_domains_inventory" : "domain_not_listed_in_route53_domains_inventory",
    sourceKind: inventory.source.kind,
    responseOk: inventory.source.responseOk
  };
}

function verifyIonosOwnership(
  normalizedDomain: string,
  inventory: IonosDomainsInventoryResult
): OwnedDomainVerification {
  if (inventory.source.kind !== "live" || inventory.source.responseOk !== true) {
    return {
      owned: false,
      provider: "ionos",
      reason: "ionos_domain_inventory_not_live",
      sourceKind: inventory.source.kind,
      responseOk: inventory.source.responseOk
    };
  }
  const owned = inventory.domains.some((entry) =>
    normalizeDomainForOwnership(entry.name) === normalizedDomain ||
    (typeof entry.idn === "string" && normalizeDomainForOwnership(entry.idn) === normalizedDomain)
  );
  return {
    owned,
    provider: "ionos",
    reason: owned ? "listed_in_ionos_domains_inventory" : "domain_not_listed_in_ionos_domains_inventory",
    sourceKind: inventory.source.kind,
    responseOk: inventory.source.responseOk
  };
}

function verifyNamecheapOwnership(
  normalizedDomain: string,
  inventory: NamecheapInventoryResult
): OwnedDomainVerification {
  if (inventory.source.kind !== "live" || inventory.source.responseOk !== true) {
    return {
      owned: false,
      provider: "namecheap",
      reason: "namecheap_domain_inventory_not_live",
      sourceKind: inventory.source.kind,
      responseOk: inventory.source.responseOk
    };
  }
  const owned = inventory.domains.some((entry) =>
    normalizeDomainForOwnership(entry.domainName) === normalizedDomain
  );
  return {
    owned,
    provider: "namecheap",
    reason: owned ? "listed_in_namecheap_domains_inventory" : "domain_not_listed_in_namecheap_domains_inventory",
    sourceKind: inventory.source.kind,
    responseOk: inventory.source.responseOk
  };
}

async function safeVerify(
  check: RegistrarOwnershipCheck,
  logger?: DomainOwnershipInventoryReaders["logger"]
): Promise<OwnedDomainVerification> {
  try {
    const verification = await check.verify();
    logger?.info?.("domain_ownership_check_completed", {
      provider: verification.provider,
      owned: verification.owned,
      reason: verification.reason,
      sourceKind: verification.sourceKind,
      responseOk: verification.responseOk
    });
    return verification;
  } catch (err) {
    const metadata = {
      provider: check.id,
      error: err instanceof Error ? err.message : String(err)
    };
    if (logger) {
      logger.warn("domain_ownership_check_failed", metadata);
    } else {
      console.warn("domain_ownership_check_failed", metadata);
    }
    return {
      owned: false,
      provider: check.id,
      reason: `${check.id}_domain_inventory_error`,
      sourceKind: "live",
      responseOk: false
    };
  }
}

function selectOwnershipMiss(misses: OwnedDomainVerification[]): OwnedDomainVerification {
  const liveResponsiveMiss = misses.find((entry) => entry.sourceKind === "live" && entry.responseOk === true);
  if (liveResponsiveMiss) return liveResponsiveMiss;

  const liveError = misses.find((entry) => entry.sourceKind === "live");
  if (liveError) return liveError;

  return {
    owned: false,
    provider: "route53",
    reason: "domain_inventory_not_configured",
    sourceKind: "mock",
    responseOk: true
  };
}

function normalizeDomainForOwnership(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

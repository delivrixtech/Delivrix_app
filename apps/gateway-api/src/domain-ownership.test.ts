import assert from "node:assert/strict";
import test from "node:test";
import type {
  AwsRoute53DomainsInventoryResult,
  IonosDomainsInventoryResult
} from "../../../packages/adapters/src/index.ts";
import { verifyOwnedDomainAcrossRegistrars } from "./domain-ownership.ts";

test("verifyOwnedDomainAcrossRegistrars keeps Route53 precedence and skips later registrars on owned match", async () => {
  let ionosReads = 0;

  const result = await verifyOwnedDomainAcrossRegistrars("Example.com.", {
    route53: {
      listInventory: () => route53Inventory({
        domains: [{ domainName: "example.com" }]
      })
    },
    ionos: {
      listInventory: () => {
        ionosReads += 1;
        return ionosInventory({
          domains: [{ id: "domain-1", name: "example.com", nameservers: [] }]
        });
      }
    }
  });

  assert.equal(result.owned, true);
  assert.equal(result.provider, "route53");
  assert.equal(result.reason, "listed_in_route53_domains_inventory");
  assert.equal(ionosReads, 0);
});

test("verifyOwnedDomainAcrossRegistrars adopts IONOS when Route53 is live but degraded", async () => {
  const result = await verifyOwnedDomainAcrossRegistrars("annualcorpfilings.com", {
    route53: {
      listInventory: () => route53Inventory({
        source: { kind: "live", responseOk: false },
        domains: []
      })
    },
    ionos: {
      listInventory: () => ionosInventory({
        domains: [{ id: "domain-1", name: "annualcorpfilings.com", nameservers: [] }]
      })
    }
  });

  assert.equal(result.owned, true);
  assert.equal(result.provider, "ionos");
  assert.equal(result.reason, "listed_in_ionos_domains_inventory");
});

test("verifyOwnedDomainAcrossRegistrars adopts IONOS when Route53 throws", async () => {
  const result = await verifyOwnedDomainAcrossRegistrars("annualcorpfilings.com", {
    route53: {
      listInventory: async () => {
        throw new Error("route53 inventory unavailable");
      }
    },
    ionos: {
      listInventory: () => ionosInventory({
        domains: [{ id: "domain-1", name: "annualcorpfilings.com", nameservers: [] }]
      })
    }
  });

  assert.equal(result.owned, true);
  assert.equal(result.provider, "ionos");
  assert.equal(result.reason, "listed_in_ionos_domains_inventory");
});

test("verifyOwnedDomainAcrossRegistrars returns not configured when both registrar inventories are mock", async () => {
  const result = await verifyOwnedDomainAcrossRegistrars("annualcorpfilings.com", {
    route53: {
      listInventory: () => route53Inventory({
        source: { kind: "mock", responseOk: true },
        domains: []
      })
    },
    ionos: {
      listInventory: () => ionosInventory({
        source: { kind: "mock", responseOk: true },
        domains: []
      })
    }
  });

  assert.equal(result.owned, false);
  assert.equal(result.provider, "route53");
  assert.equal(result.reason, "domain_inventory_not_configured");
  assert.equal(result.sourceKind, "mock");
  assert.equal(result.responseOk, true);
});

function route53Inventory(input: {
  domains: AwsRoute53DomainsInventoryResult["domains"];
  source?: Partial<AwsRoute53DomainsInventoryResult["source"]>;
}): AwsRoute53DomainsInventoryResult {
  return {
    domains: input.domains,
    source: {
      kind: input.source?.kind ?? "live",
      region: input.source?.region ?? "us-east-1",
      apiBase: input.source?.apiBase ?? "https://route53domains.us-east-1.amazonaws.com",
      fetchedAt: input.source?.fetchedAt ?? "2026-06-20T21:46:00.000Z",
      responseOk: input.source?.responseOk ?? true,
      ...(input.source?.errorMessage ? { errorMessage: input.source.errorMessage } : {})
    }
  };
}

function ionosInventory(input: {
  domains: IonosDomainsInventoryResult["domains"];
  source?: Partial<IonosDomainsInventoryResult["source"]>;
}): IonosDomainsInventoryResult {
  return {
    domains: input.domains,
    source: {
      kind: input.source?.kind ?? "live",
      apiBase: input.source?.apiBase ?? "https://api.hosting.ionos.com/domains/v1",
      fetchedAt: input.source?.fetchedAt ?? "2026-06-20T21:46:00.000Z",
      responseOk: input.source?.responseOk ?? true,
      tenantConfigured: input.source?.tenantConfigured ?? false,
      ...(input.source?.errorMessage ? { errorMessage: input.source.errorMessage } : {})
    }
  };
}

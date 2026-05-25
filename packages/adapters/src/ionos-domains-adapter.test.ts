import assert from "node:assert/strict";
import test from "node:test";
import { IonosDomainsAdapter } from "./ionos-domains-adapter.ts";

test("IonosDomainsAdapter returns mock empty inventory when credentials are missing", async () => {
  const adapter = new IonosDomainsAdapter({
    env: {},
    now: () => new Date("2026-05-25T15:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal(adapter.isLive(), false);
  assert.deepEqual(result, {
    domains: [],
    source: {
      kind: "mock",
      apiBase: "https://api.hosting.ionos.com/domains/v1",
      fetchedAt: "2026-05-25T15:00:00.000Z",
      responseOk: true,
      tenantConfigured: false
    }
  });
});

test("IonosDomainsAdapter lists domains and nameservers without tenant header", async () => {
  const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers });
    if (String(url).endsWith("/domainitems")) {
      return jsonResponse({
        items: [{
          id: "domain-1",
          properties: {
            name: "delivrix.io",
            domainType: "DOMAIN",
            status: {
              provisioningStatus: {
                type: "ACTIVE",
                setToExpireOn: "2027-05-25T00:00:00Z"
              }
            },
            expirationDate: "2027-05-25",
            domainLock: false,
            transferLock: true,
            autoRenew: true,
            dnsSecEnabled: false
          }
        }]
      });
    }
    if (String(url).endsWith("/domainitems/domain-1/nameservers")) {
      return jsonResponse({
        nameservers: [{
          name: "ns1.ionos.com",
          ipV4Addresses: ["203.0.113.53"]
        }]
      });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  const adapter = new IonosDomainsAdapter({
    apiKey: "public.secret",
    fetchImpl: fetchImpl as typeof fetch,
    now: () => new Date("2026-05-25T15:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal(adapter.isLive(), true);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.hosting.ionos.com/domains/v1/domainitems",
    "https://api.hosting.ionos.com/domains/v1/domainitems/domain-1/nameservers"
  ]);
  assert.equal((calls[0].headers as Record<string, string>)["x-api-key"], "public.secret");
  assert.equal((calls[0].headers as Record<string, string>)["x-tenant-id"], undefined);
  assert.equal(result.source.kind, "live");
  assert.equal(result.source.responseOk, true);
  assert.equal(result.source.tenantConfigured, false);
  assert.equal(result.domains.length, 1);
  assert.equal(result.domains[0].name, "delivrix.io");
  assert.equal(result.domains[0].type, "DOMAIN");
  assert.equal(result.domains[0].status, "ACTIVE");
  assert.equal(result.domains[0].provisioningStatus, "ACTIVE");
  assert.equal(result.domains[0].expiresAt, "2027-05-25");
  assert.equal(result.domains[0].domainLock, false);
  assert.deepEqual(result.domains[0].nameservers, [{
    name: "ns1.ionos.com",
    ipV4Addresses: ["203.0.113.53"],
    ipV6Addresses: undefined
  }]);
});

test("IonosDomainsAdapter sends tenant header when configured", async () => {
  const calls: HeadersInit[] = [];
  const adapter = new IonosDomainsAdapter({
    apiKey: "public.secret",
    tenantId: "tenant-1",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.headers ?? {});
      return jsonResponse({ domains: [] });
    }) as typeof fetch,
    now: () => new Date("2026-05-25T15:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal((calls[0] as Record<string, string>)["x-api-key"], "public.secret");
  assert.equal((calls[0] as Record<string, string>)["x-tenant-id"], "tenant-1");
  assert.equal(result.source.tenantConfigured, true);
});

test("IonosDomainsAdapter reports live error when tenant or key is rejected", async () => {
  const adapter = new IonosDomainsAdapter({
    apiKey: "bad-key",
    tenantId: "tenant-1",
    fetchImpl: (async () => new Response("forbidden", {
      status: 403,
      statusText: "Forbidden"
    })) as typeof fetch,
    now: () => new Date("2026-05-25T15:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal(result.source.kind, "live");
  assert.equal(result.source.responseOk, false);
  assert.equal(result.source.tenantConfigured, true);
  assert.equal(result.source.errorMessage, "IONOS Domains API returned 403 Forbidden");
  assert.equal(result.domains.length, 0);
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

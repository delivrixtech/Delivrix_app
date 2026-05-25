import assert from "node:assert/strict";
import test from "node:test";
import { IonosDnsAdapter } from "./ionos-dns-adapter.ts";

test("IonosDnsAdapter returns mock empty inventory when credentials are missing", async () => {
  const adapter = new IonosDnsAdapter({
    env: {},
    now: () => new Date("2026-05-25T15:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal(adapter.isLive(), false);
  assert.deepEqual(result, {
    zones: [],
    source: {
      kind: "mock",
      apiKind: "hosting-dns",
      apiBase: "https://api.hosting.ionos.com/dns",
      fetchedAt: "2026-05-25T15:00:00.000Z",
      responseOk: true
    }
  });
});

test("IonosDnsAdapter lists zones and records from IONOS Hosting DNS API shape", async () => {
  const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers });
    if (String(url).endsWith("/v1/zones")) {
      return jsonResponse([{
        id: "zone-1",
        name: "delivrix.io",
        type: "NATIVE"
      }]);
    }
    if (String(url).endsWith("/v1/zones/zone-1")) {
      return jsonResponse({
        id: "zone-1",
        name: "delivrix.io",
        type: "NATIVE",
        records: [{
          id: "record-1",
          name: "mail.delivrix.io",
          rootName: "delivrix.io",
          type: "A",
          content: "203.0.113.10",
          ttl: 3600,
          prio: 0,
          disabled: false
        }]
      });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  const adapter = new IonosDnsAdapter({
    apiKey: "public.secret",
    fetchImpl: fetchImpl as typeof fetch,
    now: () => new Date("2026-05-25T15:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal(adapter.isLive(), true);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://api.hosting.ionos.com/dns/v1/zones",
    "https://api.hosting.ionos.com/dns/v1/zones/zone-1"
  ]);
  assert.equal((calls[0].headers as Record<string, string>)["x-api-key"], "public.secret");
  assert.equal(result.source.kind, "live");
  assert.equal(result.source.apiKind, "hosting-dns");
  assert.equal(result.source.responseOk, true);
  assert.equal(result.zones.length, 1);
  assert.equal(result.zones[0].name, "delivrix.io");
  assert.equal(result.zones[0].records.length, 1);
  assert.equal(result.zones[0].records[0].name, "mail.delivrix.io");
  assert.equal(result.zones[0].records[0].priority, 0);
  assert.equal(result.zones[0].records[0].enabled, true);
});

test("IonosDnsAdapter lists zones and records from IONOS Cloud DNS API shape", async () => {
  const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers });
    if (String(url).endsWith("/zones?limit=1000")) {
      return jsonResponse({
        items: [{
          id: "zone-1",
          type: "zone",
          metadata: { state: "AVAILABLE" },
          properties: {
            name: "delivrix.io",
            enabled: true
          }
        }]
      });
    }
    if (String(url).endsWith("/zones/zone-1/records?limit=1000")) {
      return jsonResponse({
        items: [{
          id: "record-1",
          metadata: { state: "AVAILABLE" },
          properties: {
            name: "mail",
            type: "A",
            content: "203.0.113.10",
            ttl: 3600,
            enabled: true
          }
        }]
      });
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  const adapter = new IonosDnsAdapter({
    token: "ionos-token",
    fetchImpl: fetchImpl as typeof fetch,
    now: () => new Date("2026-05-25T15:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal(adapter.isLive(), true);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://dns.de-fra.ionos.com/zones?limit=1000",
    "https://dns.de-fra.ionos.com/zones/zone-1/records?limit=1000"
  ]);
  assert.equal((calls[0].headers as Record<string, string>).authorization, "Bearer ionos-token");
  assert.equal(result.source.kind, "live");
  assert.equal(result.source.apiKind, "cloud-dns");
  assert.equal(result.source.responseOk, true);
  assert.equal(result.zones.length, 1);
  assert.equal(result.zones[0].name, "delivrix.io");
  assert.equal(result.zones[0].state, "AVAILABLE");
  assert.equal(result.zones[0].records.length, 1);
  assert.equal(result.zones[0].records[0].name, "mail");
  assert.equal(result.zones[0].records[0].content, "203.0.113.10");
});

test("IonosDnsAdapter reports live error when token lacks DNS privileges", async () => {
  const adapter = new IonosDnsAdapter({
    token: "bad-token",
    fetchImpl: (async () => new Response("forbidden", {
      status: 403,
      statusText: "Forbidden"
    })) as typeof fetch,
    now: () => new Date("2026-05-25T15:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal(result.source.kind, "live");
  assert.equal(result.source.responseOk, false);
  assert.equal(result.source.errorMessage, "IONOS DNS API returned 403 Forbidden");
  assert.equal(result.zones.length, 0);
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

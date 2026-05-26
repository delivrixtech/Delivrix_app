import assert from "node:assert/strict";
import test from "node:test";
import {
  AwsRoute53DomainsAdapter,
  parseAwsRoute53Domains,
  parseAwsRoute53Prices,
  parseAwsRoute53Suggestions,
  signAwsJsonRequest
} from "./aws-route53-domains-adapter.ts";

test("AwsRoute53DomainsAdapter returns mock inventory when credentials are missing", async () => {
  const adapter = new AwsRoute53DomainsAdapter({
    env: {},
    now: () => new Date("2026-05-25T18:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal(adapter.isLive(), false);
  assert.deepEqual(result, {
    domains: [],
    source: {
      kind: "mock",
      region: "us-east-1",
      apiBase: "https://route53domains.us-east-1.amazonaws.com",
      fetchedAt: "2026-05-25T18:00:00.000Z",
      responseOk: true
    }
  });
});

test("AwsRoute53DomainsAdapter lists registered domains with SigV4 headers", async () => {
  const calls: Array<{ headers: HeadersInit | undefined; body: string | undefined }> = [];
  const adapter = new AwsRoute53DomainsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ headers: init?.headers, body: init?.body?.toString() });
      return jsonResponse({
        Domains: [{
          DomainName: "delivrix.io",
          AutoRenew: true,
          TransferLock: true,
          Expiry: "2027-05-25T00:00:00Z"
        }]
      });
    }) as typeof fetch,
    now: () => new Date("2026-05-25T18:00:00.000Z")
  });

  const result = await adapter.listInventory();

  assert.equal(adapter.isLive(), true);
  assert.equal((calls[0].headers as Record<string, string>)["x-amz-target"], "Route53Domains_v20140515.ListDomains");
  assert.match((calls[0].headers as Record<string, string>).authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(calls[0].body, "{}");
  assert.deepEqual(result.domains, [{
    domainName: "delivrix.io",
    autoRenew: true,
    transferLock: true,
    expiry: "2027-05-25T00:00:00Z"
  }]);
  assert.equal(result.source.kind, "live");
});

test("AwsRoute53DomainsAdapter caches registered domain inventory", async () => {
  let callCount = 0;
  const adapter = new AwsRoute53DomainsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    cacheTtlMs: 300_000,
    fetchImpl: (async () => {
      callCount += 1;
      return jsonResponse({
        Domains: [{ DomainName: "delivrix.io" }]
      });
    }) as typeof fetch,
    now: () => new Date("2026-05-25T18:00:00.000Z")
  });

  await adapter.listInventory();
  await adapter.listInventory();

  assert.equal(callCount, 1);
});

test("AwsRoute53DomainsAdapter discovers availability, prices, and suggestions", async () => {
  const targets: string[] = [];
  const priceTlds: string[] = [];
  const adapter = new AwsRoute53DomainsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      targets.push(headers["x-amz-target"]);
      const body = JSON.parse(init?.body?.toString() ?? "{}");
      if (headers["x-amz-target"].endsWith(".ListPrices")) {
        priceTlds.push(body.Tld);
        return jsonResponse({
          Prices: [{
            Name: body.Tld,
            RegistrationPrice: { Price: body.Tld === "net" ? 13 : 14, Currency: "USD" },
            RenewalPrice: { Price: body.Tld === "net" ? 13 : 14, Currency: "USD" }
          }]
        });
      }
      if (headers["x-amz-target"].endsWith(".CheckDomainAvailability")) {
        return jsonResponse({
          Availability: body.DomainName === "delivrix.com" ? "AVAILABLE" : "UNAVAILABLE"
        });
      }
      if (headers["x-amz-target"].endsWith(".GetDomainSuggestions")) {
        return jsonResponse({
          SuggestionsList: [{
            DomainName: "delivrixhq.com",
            Availability: "AVAILABLE"
          }]
        });
      }
      return new Response("not found", { status: 404, statusText: "Not Found" });
    }) as typeof fetch,
    now: () => new Date("2026-05-25T18:00:00.000Z")
  });

  const result = await adapter.discoverDomains({
    domainNames: ["delivrix.com", "delivrix.net"],
    suggestionSeed: "delivrix.com",
    suggestionsLimit: 3
  });

  assert.deepEqual(targets, [
    "Route53Domains_v20140515.ListPrices",
    "Route53Domains_v20140515.ListPrices",
    "Route53Domains_v20140515.CheckDomainAvailability",
    "Route53Domains_v20140515.CheckDomainAvailability",
    "Route53Domains_v20140515.GetDomainSuggestions"
  ]);
  assert.deepEqual(priceTlds, ["com", "net"]);
  assert.equal(result.candidates[0].domainName, "delivrix.com");
  assert.equal(result.candidates[0].canRegister, true);
  assert.deepEqual(result.candidates[0].registrationPrice, { amount: 14, currency: "USD" });
  assert.equal(result.candidates[1].canRegister, false);
  assert.deepEqual(result.candidates[1].registrationPrice, { amount: 13, currency: "USD" });
  assert.deepEqual(result.suggestions, [{
    domainName: "delivrixhq.com",
    availability: "AVAILABLE"
  }]);
  assert.equal(result.source.purchaseEnabled, false);
});

test("AwsRoute53DomainsAdapter requests filtered prices by TLD", async () => {
  const payloads: unknown[] = [];
  const adapter = new AwsRoute53DomainsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body?.toString() ?? "{}");
      payloads.push(body);
      return jsonResponse({
        Prices: [{
          Name: body.Tld,
          RegistrationPrice: { Price: body.Tld === "net" ? 13 : 14, Currency: "USD" },
          RenewalPrice: { Price: body.Tld === "net" ? 13 : 14, Currency: "USD" }
        }]
      });
    }) as typeof fetch,
    now: () => new Date("2026-05-25T18:00:00.000Z")
  });

  const prices = await adapter.listPrices([".net", "com", "net"]);

  assert.deepEqual(payloads, [{ Tld: "net" }, { Tld: "com" }]);
  assert.deepEqual(prices, [
    {
      tld: "com",
      registration: { amount: 14, currency: "USD" },
      renewal: { amount: 14, currency: "USD" },
      transfer: undefined
    },
    {
      tld: "net",
      registration: { amount: 13, currency: "USD" },
      renewal: { amount: 13, currency: "USD" },
      transfer: undefined
    }
  ]);
});

test("AwsRoute53DomainsAdapter paginates unfiltered prices", async () => {
  const payloads: unknown[] = [];
  const adapter = new AwsRoute53DomainsAdapter({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body?.toString() ?? "{}");
      payloads.push(body);
      if (!body.Marker) {
        return jsonResponse({
          NextPageMarker: "page-2",
          Prices: [{
            Name: "com",
            RegistrationPrice: { Price: 14, Currency: "USD" },
            RenewalPrice: { Price: 14, Currency: "USD" }
          }]
        });
      }
      return jsonResponse({
        Prices: [{
          Name: "net",
          RegistrationPrice: { Price: 13, Currency: "USD" },
          RenewalPrice: { Price: 13, Currency: "USD" }
        }]
      });
    }) as typeof fetch,
    now: () => new Date("2026-05-25T18:00:00.000Z")
  });

  const prices = await adapter.listPrices();

  assert.deepEqual(payloads, [{ MaxItems: 100 }, { MaxItems: 100, Marker: "page-2" }]);
  assert.deepEqual(prices.map((price) => price.tld), ["com", "net"]);
});

test("parse helpers accept Route53 Domains API shapes", () => {
  assert.deepEqual(parseAwsRoute53Domains({
    Domains: [{ DomainName: "example.com", AutoRenew: false, TransferLock: true }]
  }), [{
    domainName: "example.com",
    autoRenew: false,
    transferLock: true,
    expiry: undefined
  }]);
  assert.deepEqual(parseAwsRoute53Prices({
    Prices: [{
      Name: ".com",
      RegistrationPrice: { Price: 14, Currency: "USD" },
      RenewalPrice: { Price: 14, Currency: "USD" }
    }]
  }), [{
    tld: "com",
    registration: { amount: 14, currency: "USD" },
    renewal: { amount: 14, currency: "USD" },
    transfer: undefined
  }]);
  assert.deepEqual(parseAwsRoute53Suggestions({
    SuggestionsList: [{ DomainName: "examplehq.com", Availability: "AVAILABLE" }]
  }), [{
    domainName: "examplehq.com",
    availability: "AVAILABLE"
  }]);
});

test("signAwsJsonRequest produces deterministic SigV4 headers", () => {
  const headers = signAwsJsonRequest({
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    region: "us-east-1",
    service: "route53domains",
    url: new URL("https://route53domains.us-east-1.amazonaws.com"),
    target: "Route53Domains_v20140515.CheckDomainAvailability",
    body: JSON.stringify({ DomainName: "example.com" }),
    now: new Date("2026-05-25T18:00:00.000Z")
  });

  assert.equal(headers["x-amz-date"], "20260525T180000Z");
  assert.equal(headers.host, "route53domains.us-east-1.amazonaws.com");
  assert.match(headers.authorization, /Credential=AKIAEXAMPLE\/20260525\/us-east-1\/route53domains\/aws4_request/);
  assert.match(headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target/);
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

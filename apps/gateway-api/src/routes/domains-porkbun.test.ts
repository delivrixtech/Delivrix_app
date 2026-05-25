import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  PorkbunDomainCandidate,
  PorkbunDomainPrice,
  PorkbunDomainSuggestion,
  PorkbunInventorySource,
  PorkbunOwnedDomain,
  PorkbunPingResult
} from "../../../../packages/adapters/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import {
  handlePorkbunDomainAvailabilityHttp,
  handlePorkbunDomainDiscoverError,
  handlePorkbunDomainPricesHttp,
  handlePorkbunDomainSuggestionsHttp,
  handlePorkbunOwnedDomainsHttp,
  handlePorkbunPingHttp,
  type PorkbunDomainsRouteAdapter
} from "./domains-porkbun.ts";

const fixedNow = new Date("2026-05-25T20:00:00.000Z");

test("GET /v1/domains/porkbun/availability returns Porkbun pricing metadata", async () => {
  const response = await runRoute(handlePorkbunDomainAvailabilityHttp, {
    url: "/v1/domains/porkbun/availability?name=delivrix-mail.com",
    adapter: mockAdapter({
      checkAvailability: async (domainName) => ({
        domainName,
        tld: "com",
        availability: "AVAILABLE",
        canRegister: true,
        premium: false,
        firstYearPromo: false,
        registrationPrice: { amount: 11.06, currency: "USD" },
        renewalPrice: { amount: 11.06, currency: "USD" }
      })
    })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.domain, "delivrix-mail.com");
  assert.equal(response.body.available, true);
  assert.equal(response.body.regularPrice, 11.06);
  assert.equal(response.body.source.provider, "porkbun");
  assert.equal(response.body.source.purchaseEnabled, false);
});

test("GET /v1/domains/porkbun/suggestions keeps invalid seed local", async () => {
  let callCount = 0;
  const response = await runRoute(handlePorkbunDomainSuggestionsHttp, {
    url: "/v1/domains/porkbun/suggestions?seed=-bad-&count=10",
    adapter: mockAdapter({
      getSuggestions: async () => {
        callCount += 1;
        return [];
      }
    })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(callCount, 0);
  assert.deepEqual(response.body.suggestions, []);
});

test("GET /v1/domains/porkbun/prices returns requested TLD prices", async () => {
  const seenTlds: string[][] = [];
  const response = await runRoute(handlePorkbunDomainPricesHttp, {
    url: "/v1/domains/porkbun/prices?tlds=com,net",
    adapter: mockAdapter({
      listPrices: async (tlds = []) => {
        seenTlds.push(tlds);
        return tlds.map((tld) => price(tld, 11));
      }
    })
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seenTlds, [["com", "net"]]);
  assert.deepEqual(response.body.prices.map((entry: { tld: string }) => entry.tld), ["com", "net"]);
});

test("GET /v1/domains/porkbun/owned hides secrets and exposes portfolio", async () => {
  const response = await runRoute(handlePorkbunOwnedDomainsHttp, {
    url: "/v1/domains/porkbun/owned",
    adapter: mockAdapter({
      listOwnedDomains: async () => [{
        domainName: "delivrix.io",
        tld: "io",
        status: "ACTIVE",
        expiry: "2027-05-25",
        autoRenew: true,
        whoisPrivacy: true
      }]
    })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.domains[0].domain, "delivrix.io");
  assert.equal(JSON.stringify(response.body).includes("apikey"), false);
});

test("GET /v1/domains/porkbun/ping returns credential health", async () => {
  const response = await runRoute(handlePorkbunPingHttp, {
    url: "/v1/domains/porkbun/ping",
    adapter: mockAdapter({
      ping: async () => ({
        ok: true,
        ip: "203.0.113.8",
        credentialsValid: true
      })
    })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.credentialsValid, true);
});

test("Porkbun discovery audit is explicit OpenClaw-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-porkbun-audit-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const adapter = mockAdapter();

  await runRoute(handlePorkbunDomainAvailabilityHttp, {
    url: "/v1/domains/porkbun/availability?name=delivrix-mail.com",
    adapter,
    auditLog
  });
  assert.equal((await auditLog.list()).length, 0);

  await runRoute(handlePorkbunDomainAvailabilityHttp, {
    url: "/v1/domains/porkbun/availability?name=delivrix-mail.com",
    headers: { "x-openclaw-skill-invocation": "delivrix-domains-discover" },
    adapter,
    auditLog
  });
  const events = await auditLog.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "oc.domains.porkbun.discover");
  assert.equal(events[0].metadata.route, "availability");
});

test("GET /v1/domains/porkbun/availability returns 422 when name is missing", async () => {
  const response = await runRoute(handlePorkbunDomainAvailabilityHttp, {
    url: "/v1/domains/porkbun/availability",
    adapter: mockAdapter()
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "invalid_porkbun_domain_discover_query");
});

async function runRoute(
  handler: (deps: {
    request: IncomingMessage;
    response: ServerResponse;
    auditLog: LocalFileAuditLog;
    adapter: PorkbunDomainsRouteAdapter;
    now?: () => Date;
  }) => Promise<void>,
  input: {
    url: string;
    headers?: Record<string, string>;
    adapter: PorkbunDomainsRouteAdapter;
    auditLog?: LocalFileAuditLog;
  }
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  const auditLog = input.auditLog ?? new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "delivrix-porkbun-route-")), "audit-events.jsonl"));
  try {
    await handler({
      request: { url: input.url, headers: input.headers ?? {} } as IncomingMessage,
      response: response as unknown as ServerResponse,
      auditLog,
      adapter: input.adapter,
      now: () => fixedNow
    });
  } catch (error) {
    if (!handlePorkbunDomainDiscoverError(error, response as unknown as ServerResponse)) {
      throw error;
    }
  }

  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}

function mockAdapter(overrides: Partial<PorkbunDomainsRouteAdapter> = {}): PorkbunDomainsRouteAdapter {
  return {
    checkAvailability: async (domainName: string): Promise<PorkbunDomainCandidate> => ({
      domainName,
      tld: domainName.split(".").at(-1) ?? "",
      availability: "DONT_KNOW",
      canRegister: false,
      premium: false,
      firstYearPromo: false
    }),
    getSuggestions: async (): Promise<PorkbunDomainSuggestion[]> => [],
    listPrices: async (): Promise<PorkbunDomainPrice[]> => [],
    listOwnedDomains: async (): Promise<PorkbunOwnedDomain[]> => [],
    ping: async (): Promise<PorkbunPingResult> => ({
      ok: false,
      ip: null,
      credentialsValid: null
    }),
    currentSource: (responseOk = true, errorMessage?: string): PorkbunInventorySource => ({
      kind: "live",
      apiBase: "https://api.porkbun.com/api/json/v3",
      fetchedAt: fixedNow.toISOString(),
      responseOk,
      purchaseEnabled: false,
      ...(errorMessage ? { errorMessage } : {})
    }),
    ...overrides
  };
}

function price(tld: string, amount: number): PorkbunDomainPrice {
  return {
    tld,
    registration: { amount, currency: "USD" },
    renewal: { amount, currency: "USD" },
    transfer: { amount, currency: "USD" }
  };
}

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AwsRoute53DomainCandidate,
  AwsRoute53DomainPrice,
  AwsRoute53DomainSuggestion,
  AwsRoute53DomainSummary,
  AwsRoute53DomainsInventorySource
} from "../../../../packages/adapters/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import {
  handleDomainAvailabilityHttp,
  handleDomainDiscoverError,
  handleDomainPricesHttp,
  handleDomainSuggestionsHttp,
  type DomainsRouteAdapter
} from "./domains.ts";

const fixedNow = new Date("2026-05-25T18:00:00.000Z");

test("GET /v1/domains/availability returns available domain payload", async () => {
  const response = await runRoute(handleDomainAvailabilityHttp, {
    url: "/v1/domains/availability?name=delivrix-mail.com",
    adapter: mockAdapter({
      checkAvailability: async (domainName) => ({
        domainName,
        tld: "com",
        availability: "AVAILABLE",
        canRegister: true
      })
    })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.domain, "delivrix-mail.com");
  assert.equal(response.body.availability, "AVAILABLE");
  assert.equal(response.body.available, true);
  assert.equal(response.body.source.kind, "live");
});

test("GET /v1/domains/suggestions returns empty list for invalid seed without adapter call", async () => {
  let callCount = 0;
  const response = await runRoute(handleDomainSuggestionsHttp, {
    url: "/v1/domains/suggestions?seed=-bad-&count=10",
    adapter: mockAdapter({
      getSuggestions: async () => {
        callCount += 1;
        return [{ domainName: "should-not-run.com", availability: "AVAILABLE" }];
      }
    })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(callCount, 0);
  assert.equal(response.body.seed, "");
  assert.deepEqual(response.body.suggestions, []);
});

test("GET /v1/domains/prices filters three requested TLDs", async () => {
  const seenTlds: string[][] = [];
  const response = await runRoute(handleDomainPricesHttp, {
    url: "/v1/domains/prices?tlds=com,net,io",
    adapter: mockAdapter({
      listPrices: async (tlds = []) => {
        seenTlds.push(tlds);
        return tlds.map((tld) => price(tld, 14));
      }
    })
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(seenTlds, [["com", "net", "io"]]);
  assert.deepEqual(response.body.prices.map((entry: { tld: string }) => entry.tld), ["com", "net", "io"]);
  assert.equal(response.body.prices[0].currency, "USD");
});

test("GET /v1/domains/availability returns 422 when name is missing", async () => {
  const response = await runRoute(handleDomainAvailabilityHttp, {
    url: "/v1/domains/availability",
    adapter: mockAdapter()
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "invalid_domain_discover_query");
});

test("domain discovery audit is explicit OpenClaw-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-domains-audit-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const adapter = mockAdapter({
    checkAvailability: async (domainName) => ({
      domainName,
      tld: "com",
      availability: "AVAILABLE",
      canRegister: true
    })
  });

  await runRoute(handleDomainAvailabilityHttp, {
    url: "/v1/domains/availability?name=delivrix-mail.com",
    adapter,
    auditLog
  });
  assert.equal((await auditLog.list()).length, 0);

  await runRoute(handleDomainAvailabilityHttp, {
    url: "/v1/domains/availability?name=delivrix-mail.com",
    headers: { "x-openclaw-skill-invocation": "delivrix-domains-discover" },
    adapter,
    auditLog
  });
  const events = await auditLog.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "oc.domains.discover");
  assert.equal(events[0].metadata.route, "availability");
});

async function runRoute(
  handler: (deps: {
    request: IncomingMessage;
    response: ServerResponse;
    auditLog: LocalFileAuditLog;
    adapter: DomainsRouteAdapter;
    now?: () => Date;
  }) => Promise<void>,
  input: {
    url: string;
    headers?: Record<string, string>;
    adapter: DomainsRouteAdapter;
    auditLog?: LocalFileAuditLog;
  }
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  const auditLog = input.auditLog ?? new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "delivrix-domains-route-")), "audit-events.jsonl"));
  try {
    await handler({
      request: { url: input.url, headers: input.headers ?? {} } as IncomingMessage,
      response: response as unknown as ServerResponse,
      auditLog,
      adapter: input.adapter,
      now: () => fixedNow
    });
  } catch (error) {
    if (!handleDomainDiscoverError(error, response as unknown as ServerResponse)) {
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

function mockAdapter(overrides: Partial<DomainsRouteAdapter> = {}): DomainsRouteAdapter {
  return {
    checkAvailability: async (domainName: string): Promise<AwsRoute53DomainCandidate> => ({
      domainName,
      tld: domainName.split(".").at(-1) ?? "",
      availability: "DONT_KNOW",
      canRegister: false
    }),
    getSuggestions: async (): Promise<AwsRoute53DomainSuggestion[]> => [],
    listPrices: async (): Promise<AwsRoute53DomainPrice[]> => [],
    listOwnedDomains: async (): Promise<AwsRoute53DomainSummary[]> => [],
    currentSource: (responseOk = true, errorMessage?: string): AwsRoute53DomainsInventorySource => ({
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53domains.us-east-1.amazonaws.com",
      fetchedAt: fixedNow.toISOString(),
      responseOk,
      ...(errorMessage ? { errorMessage } : {})
    }),
    ...overrides
  };
}

function price(tld: string, amount: number): AwsRoute53DomainPrice {
  return {
    tld,
    registration: { amount, currency: "USD" },
    renewal: { amount, currency: "USD" }
  };
}

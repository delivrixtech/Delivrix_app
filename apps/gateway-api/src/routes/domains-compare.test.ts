import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type {
  AwsRoute53DomainCandidate,
  AwsRoute53DomainPrice,
  AwsRoute53DomainsInventorySource,
  PorkbunDomainCandidate,
  PorkbunDomainPrice,
  PorkbunInventorySource
} from "../../../../packages/adapters/src/index.ts";
import {
  handleDomainCompareError,
  handleDomainCompareHttp,
  type DomainCompareAwsAdapter,
  type DomainComparePorkbunAdapter
} from "./domains-compare.ts";

const fixedNow = new Date("2026-05-25T20:30:00.000Z");

test("GET /v1/domains/compare recommends the cheapest available registrar", async () => {
  const response = await runCompareRoute({
    url: "/v1/domains/compare?name=delivrix-mail.com",
    awsAdapter: mockAwsAdapter({
      checkAvailability: async (domainName) => ({
        domainName,
        tld: "com",
        availability: "AVAILABLE",
        canRegister: true
      }),
      listPrices: async () => [{
        tld: "com",
        registration: { amount: 14, currency: "USD" },
        renewal: { amount: 14, currency: "USD" }
      }]
    }),
    porkbunAdapter: mockPorkbunAdapter({
      checkAvailability: async (domainName) => ({
        domainName,
        tld: "com",
        availability: "AVAILABLE",
        canRegister: true,
        premium: false,
        firstYearPromo: false,
        registrationPrice: { amount: 11, currency: "USD" },
        renewalPrice: { amount: 12, currency: "USD" }
      }),
      listPrices: async () => [{
        tld: "com",
        registration: { amount: 11, currency: "USD" },
        renewal: { amount: 12, currency: "USD" }
      }]
    })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.domain, "delivrix-mail.com");
  assert.equal(response.body.recommendation.provider, "porkbun");
  assert.equal(response.body.recommendation.registration, 11);
  assert.equal(response.body.providers.length, 2);
});

test("GET /v1/domains/compare degrades when one provider errors", async () => {
  const response = await runCompareRoute({
    url: "/v1/domains/compare?name=delivrix-mail.com",
    awsAdapter: mockAwsAdapter({
      checkAvailability: async () => {
        throw new Error("Route53 unavailable");
      }
    }),
    porkbunAdapter: mockPorkbunAdapter({
      checkAvailability: async (domainName) => ({
        domainName,
        tld: "com",
        availability: "AVAILABLE",
        canRegister: true,
        premium: false,
        firstYearPromo: false,
        registrationPrice: { amount: 11, currency: "USD" }
      })
    })
  });

  const aws = response.body.providers.find((provider: { provider: string }) => provider.provider === "aws-route53-domains");
  assert.equal(response.statusCode, 200);
  assert.equal(aws.responseOk, false);
  assert.equal(response.body.recommendation.provider, "porkbun");
});

test("GET /v1/domains/compare returns 422 when name is missing", async () => {
  const response = await runCompareRoute({
    url: "/v1/domains/compare",
    awsAdapter: mockAwsAdapter(),
    porkbunAdapter: mockPorkbunAdapter()
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "invalid_domain_compare_query");
});

async function runCompareRoute(input: {
  url: string;
  awsAdapter: DomainCompareAwsAdapter;
  porkbunAdapter: DomainComparePorkbunAdapter;
}): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  try {
    await handleDomainCompareHttp({
      request: { url: input.url, headers: {} } as IncomingMessage,
      response: response as unknown as ServerResponse,
      awsAdapter: input.awsAdapter,
      porkbunAdapter: input.porkbunAdapter,
      now: () => fixedNow
    });
  } catch (error) {
    if (!handleDomainCompareError(error, response as unknown as ServerResponse)) {
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

function mockAwsAdapter(overrides: Partial<DomainCompareAwsAdapter> = {}): DomainCompareAwsAdapter {
  return {
    checkAvailability: async (domainName: string): Promise<AwsRoute53DomainCandidate> => ({
      domainName,
      tld: domainName.split(".").at(-1) ?? "",
      availability: "DONT_KNOW",
      canRegister: false
    }),
    listPrices: async (): Promise<AwsRoute53DomainPrice[]> => [],
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

function mockPorkbunAdapter(overrides: Partial<DomainComparePorkbunAdapter> = {}): DomainComparePorkbunAdapter {
  return {
    checkAvailability: async (domainName: string): Promise<PorkbunDomainCandidate> => ({
      domainName,
      tld: domainName.split(".").at(-1) ?? "",
      availability: "DONT_KNOW",
      canRegister: false,
      premium: false,
      firstYearPromo: false
    }),
    listPrices: async (): Promise<PorkbunDomainPrice[]> => [],
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

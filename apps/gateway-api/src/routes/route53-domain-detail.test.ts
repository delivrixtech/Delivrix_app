import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import {
  handleReadRoute53DomainDetail,
  route53DomainDetailClientConfigFromEnv
} from "./route53-domain-detail.ts";

const fixedNow = new Date("2026-06-01T18:00:00.000Z");
const readToken = "route53-read-token";

test("GET /v1/route53/domain-detail normalizes full Route53 Domains payload", async () => {
  const auditEvents: Array<Record<string, unknown>> = [];
  const calls: unknown[] = [];
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient({
      RegistrarName: "Amazon Registrar, Inc.",
      Nameservers: [{ Name: "ns-1.awsdns-01.com" }, { Name: "ns-2.awsdns-02.net" }],
      CreationDate: new Date("2026-05-01T10:00:00.000Z"),
      ExpirationDate: new Date("2027-05-01T10:00:00.000Z"),
      AutoRenew: true,
      TransferLock: true,
      StatusList: ["ok"],
      RegistrantContact: {
        OrganizationName: "Delivrix LLC",
        CountryCode: "CO"
      }
    }, calls),
    emitAudit: async (event) => {
      auditEvents.push(event);
    }
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    domain: "controldelivrix.app",
    registrar: "Amazon Registrar, Inc.",
    nameservers: ["ns-1.awsdns-01.com", "ns-2.awsdns-02.net"],
    registrationDate: "2026-05-01T10:00:00.000Z",
    expirationDate: "2027-05-01T10:00:00.000Z",
    autoRenew: true,
    transferLock: true,
    status: ["ok"],
    registrantContact: {
      organizationName: "Delivrix LLC",
      countryCode: "CO"
    }
  });
  assert.equal((calls[0] as { input: { DomainName: string } }).input.DomainName, "controldelivrix.app");
  assert.deepEqual(auditEvents, [{
    type: "oc.route53.domain_detail_read",
    domain: "controldelivrix.app",
    registrar: "Amazon Registrar, Inc.",
    nameserverCount: 2,
    timestamp: fixedNow.toISOString()
  }]);
});

test("GET /v1/route53/domain-detail retries throttling and returns detail on retry success", async () => {
  const calls: unknown[] = [];
  const logs: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient([
      awsError("ThrottlingException", "Rate exceeded", 429),
      { RegistrarName: "Amazon Registrar, Inc.", Nameservers: [] }
    ], calls),
    logger: testLogger(logs),
    sleep: async () => undefined,
    retryBaseDelayMs: 0,
    retryJitterMs: 0
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.registrar, "Amazon Registrar, Inc.");
  assert.equal(calls.length, 2);
  assert.equal(logs[0]?.event, "route53.domain_detail_attempt_failed");
  assert.equal(logs[0]?.metadata?.awsError, "ThrottlingException");
  assert.equal(logs[0]?.metadata?.httpStatus, 429);
});

test("GET /v1/route53/domain-detail returns empty nameservers array", async () => {
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient({ Nameservers: [] })
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.nameservers, []);
});

test("GET /v1/route53/domain-detail defaults undefined AutoRenew to false", async () => {
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient({ AutoRenew: undefined })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.autoRenew, false);
});

test("GET /v1/route53/domain-detail omits undefined registrantContact", async () => {
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient({ RegistrantContact: undefined })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(response.body, "registrantContact"), false);
});

test("GET /v1/route53/domain-detail rejects domain foo", async () => {
  const response = await route("/v1/route53/domain-detail?domain=foo");

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_domain_format");
});

test("GET /v1/route53/domain-detail requires read-boundary token", async () => {
  const calls: unknown[] = [];
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient({}, calls),
    headers: {}
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, "read_boundary_token_invalid");
  assert.equal(calls.length, 0);
});

test("GET /v1/route53/domain-detail fails closed when read token is unconfigured", async () => {
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    readBoundaryToken: null
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "read_boundary_token_unconfigured");
});

test("GET /v1/route53/domain-detail rejects domain with spaces", async () => {
  const response = await route("/v1/route53/domain-detail?domain=foo%20bar");

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_domain_format");
});

test("GET /v1/route53/domain-detail rejects URL-shaped domain", async () => {
  const response = await route("/v1/route53/domain-detail?domain=http%3A%2F%2Ffoo.com");

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_domain_format");
});

test("GET /v1/route53/domain-detail rejects empty domain", async () => {
  const response = await route("/v1/route53/domain-detail");

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_domain_format");
});

test("GET /v1/route53/domain-detail maps exhausted throttling to 429 and logs AWS metadata", async () => {
  const calls: unknown[] = [];
  const logs: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient(awsError("ThrottlingException", "Rate exceeded", 429), calls),
    logger: testLogger(logs),
    maxAttempts: 2,
    sleep: async () => undefined,
    retryBaseDelayMs: 0,
    retryJitterMs: 0
  });

  assert.equal(response.statusCode, 429);
  assert.equal(response.body.error, "route53_domain_detail_throttled");
  assert.equal(response.body.message, "Rate exceeded");
  assert.equal(response.body.domain, "controldelivrix.app");
  assert.equal(response.body.awsError, "ThrottlingException");
  assert.equal(response.body.httpStatus, 429);
  assert.equal(response.body.transient, true);
  assert.equal(response.body.retryable, true);
  assert.equal(calls.length, 2);
  assert.equal(logs.at(-1)?.event, "route53.domain_detail_failed");
  assert.equal(logs.at(-1)?.metadata?.awsError, "ThrottlingException");
  assert.equal(logs.at(-1)?.metadata?.httpStatus, 429);
});

test("GET /v1/route53/domain-detail maps Route53 domain not found to 404 without retry", async () => {
  const calls: unknown[] = [];
  const response = await route("/v1/route53/domain-detail?domain=missing.example", {
    client: mockClient(awsError("InvalidInput", "Domain was not found in this account", 400), calls),
    sleep: async () => undefined
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error, "route53_domain_detail_not_found");
  assert.equal(response.body.awsError, "InvalidInput");
  assert.equal(response.body.httpStatus, 400);
  assert.equal(response.body.transient, false);
  assert.equal(response.body.retryable, false);
  assert.equal(calls.length, 1);
});

test("GET /v1/route53/domain-detail maps timeouts to 503 after retry budget", async () => {
  const calls: unknown[] = [];
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient(awsError("TimeoutError", "request timed out", 504), calls),
    maxAttempts: 2,
    sleep: async () => undefined,
    retryBaseDelayMs: 0,
    retryJitterMs: 0
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, "route53_domain_detail_unavailable");
  assert.equal(response.body.awsError, "TimeoutError");
  assert.equal(response.body.httpStatus, 504);
  assert.equal(response.body.transient, true);
  assert.equal(response.body.retryable, true);
  assert.equal(calls.length, 2);
});

test("GET /v1/route53/domain-detail maps unknown AWS errors to 502", async () => {
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient(new Error("route53 domains unavailable"))
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "route53_domains_read_failed");
  assert.equal(response.body.message, "route53 domains unavailable");
  assert.equal(response.body.domain, "controldelivrix.app");
  assert.equal(response.body.awsError, "Error");
  assert.equal(response.body.httpStatus, null);
  assert.equal(response.body.transient, false);
  assert.equal(response.body.retryable, false);
});

test("route53DomainDetailClientConfigFromEnv uses Route53 Domains credentials", () => {
  const config = route53DomainDetailClientConfigFromEnv({
    AWS_ROUTE53_DOMAINS_ACCESS_KEY_ID: "domain-access",
    AWS_ROUTE53_DOMAINS_SECRET_ACCESS_KEY: "domain-secret",
    AWS_ROUTE53_DOMAINS_SESSION_TOKEN: "domain-session",
    AWS_ROUTE53_DOMAINS_REGION: "us-east-1"
  });

  assert.deepEqual(config, {
    region: "us-east-1",
    maxAttempts: 5,
    retryMode: "adaptive",
    credentials: {
      accessKeyId: "domain-access",
      secretAccessKey: "domain-secret",
      sessionToken: "domain-session"
    }
  });
});

test("route53DomainDetailClientConfigFromEnv falls back to shared AWS credentials", () => {
  const config = route53DomainDetailClientConfigFromEnv({
    AWS_ACCESS_KEY_ID: "shared-access",
    AWS_SECRET_ACCESS_KEY: "shared-secret",
    AWS_REGION: "us-west-2"
  });

  assert.deepEqual(config, {
    region: "us-west-2",
    maxAttempts: 5,
    retryMode: "adaptive",
    credentials: {
      accessKeyId: "shared-access",
      secretAccessKey: "shared-secret"
    }
  });
});

async function route(
  url: string,
  deps: {
    client?: { send(command: unknown): Promise<unknown> };
    emitAudit?: (event: { type: string; [k: string]: unknown }) => Promise<void>;
    logger?: { warn(event: string, message: string, metadata?: Record<string, unknown>): Promise<void> };
    headers?: Record<string, string>;
    readBoundaryToken?: string | null;
    maxAttempts?: number;
    retryBaseDelayMs?: number;
    retryJitterMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  await handleReadRoute53DomainDetail(
    request(url, deps.headers ?? { "x-delivrix-token": readToken }),
    response as unknown as ServerResponse,
    {
      client: deps.client as any,
      emitAudit: deps.emitAudit,
      logger: deps.logger,
      now: () => fixedNow,
      readBoundaryToken: deps.readBoundaryToken === null ? undefined : deps.readBoundaryToken ?? readToken,
      maxAttempts: deps.maxAttempts,
      retryBaseDelayMs: deps.retryBaseDelayMs,
      retryJitterMs: deps.retryJitterMs,
      sleep: deps.sleep
    }
  );
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

function mockClient(output: unknown, calls: unknown[] = []): { send(command: unknown): Promise<unknown> } {
  const queue = Array.isArray(output) ? [...output] : null;
  return {
    async send(command: unknown): Promise<unknown> {
      calls.push(command);
      const current = queue ? queue.shift() : output;
      if (current instanceof Error) {
        throw current;
      }
      return {
        RegistrarName: "unknown",
        Nameservers: [{ Name: "ns-1.awsdns-01.com" }],
        AutoRenew: false,
        TransferLock: false,
        StatusList: [],
        ...current as Record<string, unknown>
      };
    }
  };
}

function awsError(name: string, message: string, httpStatusCode: number): Error {
  const error = new Error(message) as Error & { $metadata?: { httpStatusCode: number } };
  error.name = name;
  error.$metadata = { httpStatusCode };
  return error;
}

function testLogger(logs: Array<{ event: string; metadata?: Record<string, unknown> }>) {
  return {
    async warn(event: string, _message: string, metadata?: Record<string, unknown>) {
      logs.push({ event, metadata });
    }
  };
}

function request(url: string, headers: Record<string, string>): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, {
    method: "GET",
    url,
    headers
  }) as IncomingMessage;
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

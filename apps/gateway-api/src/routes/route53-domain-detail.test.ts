import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import {
  handleReadRoute53DomainDetail,
  route53DomainDetailClientConfigFromEnv
} from "./route53-domain-detail.ts";

const fixedNow = new Date("2026-06-01T18:00:00.000Z");

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

test("GET /v1/route53/domain-detail maps AWS errors to 502", async () => {
  const response = await route("/v1/route53/domain-detail?domain=controldelivrix.app", {
    client: mockClient(new Error("route53 domains unavailable"))
  });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "route53_domains_read_failed");
  assert.equal(response.body.message, "route53 domains unavailable");
  assert.equal(response.body.domain, "controldelivrix.app");
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
  } = {}
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  await handleReadRoute53DomainDetail(
    request(url),
    response as unknown as ServerResponse,
    {
      client: deps.client as any,
      emitAudit: deps.emitAudit,
      now: () => fixedNow
    }
  );
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

function mockClient(output: unknown, calls: unknown[] = []): { send(command: unknown): Promise<unknown> } {
  return {
    async send(command: unknown): Promise<unknown> {
      calls.push(command);
      if (output instanceof Error) {
        throw output;
      }
      return {
        RegistrarName: "unknown",
        Nameservers: [{ Name: "ns-1.awsdns-01.com" }],
        AutoRenew: false,
        TransferLock: false,
        StatusList: [],
        ...output as Record<string, unknown>
      };
    }
  };
}

function request(url: string): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, {
    method: "GET",
    url,
    headers: {}
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

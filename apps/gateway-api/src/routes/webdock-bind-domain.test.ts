import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  WebdockServer,
  WebdockSetServerMainDomainResult,
  WebdockSetServerPtrResult
} from "../../../../packages/adapters/src/index.ts";
import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";
import {
  handleBindWebdockMainDomain,
  type BindWebdockMainDomainAdapter,
  type BindWebdockMainDomainApprovalGuard
} from "./webdock-bind-domain.ts";

const fixedNowMs = Date.parse("2026-05-31T19:30:00.000Z");

test("bind_webdock_main_domain binds hostname and PTR", async () => {
  const calls: Array<{ method: string; domain?: string }> = [];
  const harness = routeHarness({
    adapter: adapterMock({
      setServerMainDomain: async (opts) => {
        calls.push({ method: "main", domain: opts.domain });
        return { ok: true, previousMainDomain: "old.example.com", raw: {} };
      },
      setServerPtr: async () => {
        calls.push({ method: "ptr" });
        return { ok: true, supported: true, raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.ptrSet, true);
  assert.equal(response.body.alreadyBound, false);
  assert.deepEqual(calls.map((call) => call.method), ["main", "ptr"]);
  assert.equal(harness.auditEvents.at(-1)?.action, "oc.webdock.main_domain_bound");
});

test("bind_webdock_main_domain is idempotent when already bound", async () => {
  let setMainCalls = 0;
  const harness = routeHarness({
    adapter: adapterMock({
      server: serverFixture({ mainDomain: "example.com", hostname: "example.com" }),
      setServerMainDomain: async () => {
        setMainCalls += 1;
        return { ok: true, previousMainDomain: "example.com", raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.alreadyBound, true);
  assert.equal(setMainCalls, 0);
});

test("bind_webdock_main_domain returns 404 for missing server", async () => {
  const harness = routeHarness({
    adapter: adapterMock({
      getServer: async () => {
        throw new Error("missing");
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error, "server_not_found");
});

test("bind_webdock_main_domain rejects prohibited mail prefix", async () => {
  const harness = routeHarness();

  const response = await harness.request({
    ...validBody(),
    domain: "mail.example.com"
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, "invalid_params");
  assert.match(JSON.stringify(response.body.details), /domain_has_prohibited_prefix/);
});

test("bind_webdock_main_domain rolls back if PTR fails", async () => {
  const domains: string[] = [];
  const harness = routeHarness({
    adapter: adapterMock({
      setServerMainDomain: async (opts) => {
        domains.push(opts.domain);
        return {
          ok: true,
          previousMainDomain: opts.domain === "example.com" ? "old.example.com" : "example.com",
          raw: {}
        };
      },
      setServerPtr: async () => {
        throw new Error("ptr boom");
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "ptr_failed_rolled_back");
  assert.deepEqual(domains, ["example.com", "old.example.com"]);
  assert.equal(harness.auditEvents.at(-1)?.action, "oc.webdock.main_domain_rollback");
});

test("bind_webdock_main_domain reports PTR unsupported by API", async () => {
  const harness = routeHarness({
    adapter: adapterMock({
      setServerPtr: async () => ({ ok: false, supported: false, raw: { reason: "not_supported_by_api" } })
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ptrSet, false);
  assert.equal(response.body.ptrSkipReason, "not_supported_by_api");
});

test("bind_webdock_main_domain rejects invalid approval before adapter calls", async () => {
  let getServerCalls = 0;
  const harness = routeHarness({
    approvalGuard: { verify: async () => ({ ok: false }) },
    adapter: adapterMock({
      getServer: async () => {
        getServerCalls += 1;
        return serverFixture();
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.error, "approval_invalid");
  assert.equal(getServerCalls, 0);
});

test("bind_webdock_main_domain supports operator PTR opt-out", async () => {
  let ptrCalls = 0;
  const harness = routeHarness({
    adapter: adapterMock({
      setServerPtr: async () => {
        ptrCalls += 1;
        return { ok: true, supported: true, raw: {} };
      }
    })
  });

  const response = await harness.request({
    ...validBody(),
    setPtr: false
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ptrSet, false);
  assert.equal(response.body.ptrSkipReason, "operator_opt_out");
  assert.equal(ptrCalls, 0);
});

function routeHarness(input: {
  adapter?: BindWebdockMainDomainAdapter;
  approvalGuard?: BindWebdockMainDomainApprovalGuard;
} = {}) {
  const auditEvents: AuditEventInput[] = [];
  const route = async (body: unknown): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    await handleBindWebdockMainDomain({
      request: requestWithJson(body),
      response: response as unknown as ServerResponse,
      deps: {
        auditLog: {
          append: async (event) => {
            auditEvents.push(event);
            return { id: `evt-${auditEvents.length}` };
          }
        },
        approvalGuard: input.approvalGuard ?? { verify: async () => ({ ok: true, eventId: "approval-1" }) },
        webdockAdapter: input.adapter ?? adapterMock(),
        now: () => fixedNowMs + auditEvents.length
      }
    });
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return { request: route, auditEvents };
}

function adapterMock(overrides: Partial<BindWebdockMainDomainAdapter> & {
  server?: WebdockServer;
} = {}): BindWebdockMainDomainAdapter {
  return {
    getServer: overrides.getServer ?? (async () => overrides.server ?? serverFixture()),
    setServerMainDomain: overrides.setServerMainDomain ?? (async (): Promise<WebdockSetServerMainDomainResult> => ({
      ok: true,
      previousMainDomain: "old.example.com",
      raw: {}
    })),
    setServerPtr: overrides.setServerPtr ?? (async (): Promise<WebdockSetServerPtrResult> => ({
      ok: true,
      supported: true,
      raw: {}
    }))
  };
}

function serverFixture(overrides: Partial<WebdockServer> = {}): WebdockServer {
  return {
    slug: "server-abc123",
    name: "old.example.com",
    mainDomain: "old.example.com",
    hostname: "old.example.com",
    ipv4: "192.0.2.55",
    status: "running",
    ...overrides
  };
}

function validBody(): Record<string, unknown> {
  return {
    serverSlug: "server-abc123",
    domain: "example.com",
    setPtr: true,
    actorId: "operator/juanes",
    approvalToken: "approval-token"
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/skills/bind-webdock-main-domain",
    headers: { "content-type": "application/json" }
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

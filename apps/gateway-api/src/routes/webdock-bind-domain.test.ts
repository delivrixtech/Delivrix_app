import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type BindWebdockMainDomainApprovalGuard,
  type FcrdnsResolver
} from "./webdock-bind-domain.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";

const fixedNowMs = Date.parse("2026-05-31T19:30:00.000Z");

test("bind_webdock_main_domain sets Webdock identity to smtp host and verifies FCrDNS", async () => {
  const calls: Array<{ method: string; mainDomain?: string; removeDefaultAlias?: boolean }> = [];
  const harness = routeHarness({
    fcrdnsResolver: fcrdnsOkResolver(),
    adapter: adapterMock({
      setServerIdentity: async (opts) => {
        calls.push({ method: "identity", mainDomain: opts.mainDomain, removeDefaultAlias: opts.removeDefaultAlias });
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.mainDomain, "smtp.example.com");
  assert.equal(response.body.identitySet, true);
  assert.equal(response.body.identityCallbackId, "cb-identity-1");
  assert.equal(response.body.ptrSet, true);
  assert.equal(response.body.fcrdnsVerified, true);
  assert.equal(response.body.alreadyBound, false);
  assert.deepEqual(calls, [{ method: "identity", mainDomain: "smtp.example.com", removeDefaultAlias: true }]);
  assert.equal(harness.auditEvents.some((event) => event.action === "oc.webdock.identity_aligned"), true);
  const inventory = await harness.workspace.readInventoryJson<{
    bindings: Array<{ domain: string; serverSlug: string | null; serverIp: string; status: string }>;
  }>("domains.json");
  assert.deepEqual(inventory?.bindings[0], {
    domain: "example.com",
    serverSlug: "server-abc123",
    serverIp: "192.0.2.55",
    status: "main_domain_bound"
  });
});

test("bind_webdock_main_domain is idempotent when Webdock identity is already aligned", async () => {
  let setIdentityCalls = 0;
  const harness = routeHarness({
    fcrdnsResolver: fcrdnsOkResolver(),
    adapter: adapterMock({
      server: serverFixture({ mainDomain: "smtp.example.com", hostname: "smtp.example.com" }),
      setServerIdentity: async (opts) => {
        setIdentityCalls += 1;
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.alreadyBound, true);
  assert.equal(response.body.identitySet, false);
  assert.equal(response.body.ptrSet, true);
  assert.equal(setIdentityCalls, 0);
});

test("bind_webdock_main_domain does not treat hostname as confirmed Webdock identity", async () => {
  let setIdentityCalls = 0;
  const harness = routeHarness({
    fcrdnsResolver: fcrdnsOkResolver(),
    adapter: adapterMock({
      server: serverFixture({ mainDomain: undefined, hostname: "smtp.example.com", name: "smtp.example.com" }),
      setServerIdentity: async (opts) => {
        setIdentityCalls += 1;
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.identitySet, true);
  assert.equal(setIdentityCalls, 1);
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

test("bind_webdock_main_domain returns pending instead of declaring success when FCrDNS is not aligned", async () => {
  const harness = routeHarness({
    fcrdnsResolver: {
      resolve4: async () => ["192.0.2.55"],
      reverse: async () => ["server-abc123.vps.webdock.cloud."]
    },
    fcrdnsMaxWaitMs: 0,
    adapter: adapterMock({
      setServerIdentity: async (opts) => {
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 424);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.ptrSet, false);
  assert.equal(response.body.ptrSkipReason, "fcrdns_pending");
  assert.equal(response.body.fcrdnsVerified, false);
  assert.equal(response.body.error, "fcrdns_pending");
  assert.equal(harness.auditEvents.at(-1)?.action, "oc.webdock.identity_pending_fcrdns");
  const inventory = await harness.workspace.readInventoryJson<{
    bindings: Array<{ domain: string; serverSlug: string | null; serverIp: string; status: string }>;
  }>("domains.json");
  assert.equal(inventory?.bindings[0]?.status, "identity_pending_fcrdns");
});

test("bind_webdock_main_domain fails closed when Webdock identity API fails", async () => {
  const harness = routeHarness({
    adapter: adapterMock({
      setServerIdentity: async () => {
        throw new Error("identity API boom");
      }
    })
  });

  const response = await harness.request(validBody());

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, "identity_set_failed");
  assert.equal(harness.auditEvents.at(-1)?.action, "oc.webdock.identity_set_failed");
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

test("bind_webdock_main_domain rejects PTR opt-out because FCrDNS is mandatory", async () => {
  let identityCalls = 0;
  const harness = routeHarness({
    adapter: adapterMock({
      setServerIdentity: async (opts) => {
        identityCalls += 1;
        return { ok: true, serverSlug: opts.serverSlug, mainDomain: opts.mainDomain, callbackId: "cb-identity-1", raw: {} };
      }
    })
  });

  const response = await harness.request({
    ...validBody(),
    setPtr: false
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "fcrdns_required");
  assert.equal(identityCalls, 0);
});

function routeHarness(input: {
  adapter?: BindWebdockMainDomainAdapter;
  approvalGuard?: BindWebdockMainDomainApprovalGuard;
  fcrdnsResolver?: FcrdnsResolver;
  fcrdnsMaxWaitMs?: number;
} = {}) {
  const auditEvents: AuditEventInput[] = [];
  const workspace = new OpenClawWorkspace({
    rootDir: mkdtempSync(join(tmpdir(), "webdock-bind-route-"))
  });
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
        workspace,
        now: () => fixedNowMs + auditEvents.length,
        fcrdnsResolver: input.fcrdnsResolver ?? fcrdnsOkResolver(),
        fcrdnsMaxWaitMs: input.fcrdnsMaxWaitMs ?? 0,
        fcrdnsPollIntervalMs: 0
      }
    });
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return { request: route, auditEvents, workspace };
}

function adapterMock(overrides: Partial<BindWebdockMainDomainAdapter> & {
  server?: WebdockServer;
} = {}): BindWebdockMainDomainAdapter {
  return {
    getServer: overrides.getServer ?? (async () => overrides.server ?? serverFixture()),
    setServerIdentity: overrides.setServerIdentity ?? (async (opts) => ({
      ok: true,
      serverSlug: opts.serverSlug,
      mainDomain: opts.mainDomain,
      callbackId: "cb-identity-1",
      raw: {}
    })),
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

function fcrdnsOkResolver(): FcrdnsResolver {
  return {
    resolve4: async () => ["192.0.2.55"],
    reverse: async () => ["smtp.example.com."]
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

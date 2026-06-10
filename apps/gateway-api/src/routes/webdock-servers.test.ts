import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  WebdockCreateServerInput,
  WebdockCreateServerResult,
  WebdockDeleteServerResult,
  WebdockServer
} from "../../../../packages/adapters/src/index.ts";
import type {
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import {
  handleWebdockServerCreateError,
  handleWebdockServerCreateHttp,
  handleWebdockServerDeleteError,
  handleWebdockServerDeleteHttp,
  type WebdockServerCreateAdapter,
  type WebdockServerDeleteAdapter
} from "./webdock-servers.ts";

const fixedNow = new Date("2026-05-27T16:00:00.000Z");
const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatortestkey operator@delivrix";

test("POST /v1/webdock/servers/create blocks without ops key, write flag, and approval", async () => {
  const route = await routeHarness({
    adapter: mockAdapter({ isLive: () => false }),
    canvasState: canvasState([])
  });

  const response = await route({
    profile: "bit",
    locationId: "dk",
    hostname: "mail.delivrix.test",
    imageSlug: "ubuntu-2404",
    publicKey,
    actorId: "operator/juanes",
    approvalToken: "exec-missing",
    taskId: "task-webdock-blocked"
  }, { WEBDOCK_SERVERS_ENABLE_CREATE: "false" });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers.sort(), [
    "approval_not_found_or_expired",
    "webdock_create_flag_disabled",
    "webdock_ops_key_missing"
  ].sort());
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.webdock.server_create_blocked");
});

test("POST /v1/webdock/servers/create creates server, polls running, and records workspace inventory", async () => {
  const createdInputs: WebdockCreateServerInput[] = [];
  const route = await routeHarness({
    adapter: mockAdapter({
      createServer: async (opts) => {
        createdInputs.push(opts);
        return {
          serverSlug: "mail-delivrix-test",
          eventId: "cb-123",
          ipv4: null,
          status: "provisioning",
          source: {
            kind: "live",
            apiBase: "https://api.webdock.test/v1",
            fetchedAt: fixedNow.toISOString(),
            responseOk: true
          }
        };
      },
      getServer: async () => ({
        slug: "mail-delivrix-test",
        name: "mail.delivrix.test",
        ipv4: "192.0.2.44",
        status: "running"
      })
    }),
    canvasState: canvasState([{
      artifactId: "artifact-webdock-plan",
      executionId: "exec-webdock-123",
      approvedAt: "2026-05-27T15:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-webdock-plan", "exec-webdock-123");

  const response = await route({
    profile: "bit",
    locationId: "dk",
    hostname: "Mail.Delivrix.Test.",
    imageSlug: "ubuntu-2404",
    publicKey,
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-123",
    taskId: "task-webdock-create",
    pollIntervalMs: 0,
    maxPolls: 2
  }, { WEBDOCK_SERVERS_ENABLE_CREATE: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.serverSlug, "mail-delivrix-test");
  assert.equal(response.body.status, "running");
  assert.equal(response.body.ipv4, "192.0.2.44");
  assert.equal(createdInputs[0].hostname, "mail.delivrix.test");
  assert.equal(createdInputs[0].publicKey, publicKey);

  const events = await route.auditLog.list();
  const created = events.at(-1);
  assert.equal(created?.action, "oc.webdock.server_created");
  assert.equal(created?.metadata.publicKeyFingerprint, "34d676731ad95a7a");
  assert.equal(JSON.stringify(created?.metadata).includes(publicKey), false);

  const inventory = await route.workspace.readInventoryJson<{
    servers: Array<{ slug: string; status: string; ipv4: string; port25UnlockRequired: true }>;
  }>("webdock-servers.json");
  assert.equal(inventory?.servers[0].slug, "mail-delivrix-test");
  assert.equal(inventory?.servers[0].status, "running");
  assert.equal(inventory?.servers[0].port25UnlockRequired, true);
  assert.ok(route.canvasEvents.some((event) => event.type === "oc.action.now" && event.kind === "api" && event.method === "GET"));
});

test("POST /v1/webdock/servers/create reuses an existing server by hostname", async () => {
  let createCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      listServers: async () => ({
        servers: [{
          slug: "server10",
          name: "display-name",
          hostname: "controldelivrix.app",
          mainDomain: undefined,
          ipv4: "45.136.70.47",
          status: "running"
        }],
        source: liveWebdockSource()
      }),
      createServer: async () => {
        createCalled = true;
        throw new Error("createServer must not run");
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-webdock-plan",
      executionId: "exec-webdock-123",
      approvedAt: "2026-05-27T15:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-webdock-plan", "exec-webdock-123");

  const response = await route({
    runId: "run-controldelivrix",
    profile: "bit",
    locationId: "dk",
    hostname: "controldelivrix.app",
    imageSlug: "ubuntu-2404",
    publicKey,
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-123",
    taskId: "task-webdock-idempotent"
  }, { WEBDOCK_SERVERS_ENABLE_CREATE: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "idempotent_already_exists");
  assert.equal(response.body.serverSlug, "server10");
  assert.equal(response.body.costUsd, 0);
  assert.equal(createCalled, false);
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.webdock.create_idempotent");
  const inventory = await route.workspace.readInventoryJson<{
    runBindings: Array<{ runId: string; serverSlug: string; source: string }>;
  }>("webdock-servers.json");
  assert.deepEqual(inventory?.runBindings, [{
    runId: "run-controldelivrix",
    serverSlug: "server10",
    domain: "controldelivrix.app",
    boundAt: fixedNow.toISOString(),
    source: "idempotent_already_exists"
  }]);
});

test("POST /v1/webdock/servers/create reuses an existing server by mainDomain", async () => {
  let createCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      listServers: async () => ({
        servers: [{
          slug: "server10",
          name: "server10",
          mainDomain: "controldelivrix.app",
          ipv4: "45.136.70.47",
          status: "running"
        }],
        source: liveWebdockSource()
      }),
      createServer: async () => {
        createCalled = true;
        throw new Error("createServer must not run");
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-webdock-plan",
      executionId: "exec-webdock-123",
      approvedAt: "2026-05-27T15:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-webdock-plan", "exec-webdock-123");

  const response = await route({
    profile: "bit",
    locationId: "dk",
    hostname: "controldelivrix.app",
    imageSlug: "ubuntu-2404",
    publicKey,
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-123"
  }, { WEBDOCK_SERVERS_ENABLE_CREATE: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "idempotent_already_exists");
  assert.equal(response.body.serverSlug, "server10");
  assert.equal(createCalled, false);
});

test("POST /v1/webdock/servers/create fails closed on ambiguous existing servers", async () => {
  let createCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      listServers: async () => ({
        servers: [
          { slug: "server10", name: "server10", hostname: "controldelivrix.app", ipv4: "45.136.70.47", status: "running" },
          { slug: "server11", name: "server11", mainDomain: "controldelivrix.app", ipv4: "45.136.70.48", status: "running" }
        ],
        source: liveWebdockSource()
      }),
      createServer: async () => {
        createCalled = true;
        throw new Error("createServer must not run");
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-webdock-plan",
      executionId: "exec-webdock-123",
      approvedAt: "2026-05-27T15:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-webdock-plan", "exec-webdock-123");

  const response = await route({
    profile: "bit",
    locationId: "dk",
    hostname: "controldelivrix.app",
    imageSlug: "ubuntu-2404",
    publicKey,
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-123"
  }, { WEBDOCK_SERVERS_ENABLE_CREATE: "true" });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers, ["webdock_existing_server_ambiguous"]);
  assert.equal(createCalled, false);
});

test("POST /v1/webdock/servers/create fails closed on degraded inventory", async () => {
  let createCalled = false;
  const route = await routeHarness({
    adapter: mockAdapter({
      listServers: async () => ({
        servers: [],
        source: { ...liveWebdockSource(), kind: "mock", responseOk: false, errorMessage: "api down" }
      }),
      createServer: async () => {
        createCalled = true;
        throw new Error("createServer must not run");
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-webdock-plan",
      executionId: "exec-webdock-123",
      approvedAt: "2026-05-27T15:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-webdock-plan", "exec-webdock-123");

  const response = await route({
    profile: "bit",
    locationId: "dk",
    hostname: "controldelivrix.app",
    imageSlug: "ubuntu-2404",
    publicKey,
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-123"
  }, { WEBDOCK_SERVERS_ENABLE_CREATE: "true" });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers, ["webdock_inventory_degraded"]);
  assert.equal(createCalled, false);
});

test("POST /v1/webdock/servers/create classifies Webdock payment failures as recoverable", async () => {
  const route = await routeHarness({
    adapter: mockAdapter({
      createServer: async () => {
        throw new Error(
          "Webdock API returned 400 Bad Request | got: {\"message\":\"Server Creation failed. The error we encountered was: Payment failed during server creation. Please check your payment method or whether you have enough Service Credit in your account to pay for the server and try again.\"}"
        );
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-webdock-plan",
      executionId: "exec-webdock-123",
      approvedAt: "2026-05-27T15:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-webdock-plan", "exec-webdock-123");

  const response = await route({
    profile: "bit",
    locationId: "dk",
    hostname: "smtp.delivrix.test",
    imageSlug: "ubuntu-2404",
    publicKey,
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-123",
    taskId: "task-webdock-payment-failed"
  }, { WEBDOCK_SERVERS_ENABLE_CREATE: "true" });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "webdock_payment_failed");
  assert.equal(response.body.recoverable, true);
  assert.equal(response.body.operatorAction, "add_or_fix_webdock_service_credit_then_rerun_configure_complete_smtp");

  const failed = (await route.auditLog.list()).at(-1);
  assert.equal(failed?.action, "oc.webdock.server_create_failed");
  const metadata = failed?.metadata as Record<string, unknown>;
  assert.equal(metadata.errorCode, "webdock_payment_failed");
  assert.equal(metadata.recoverable, true);
  assert.equal(metadata.operatorAction, "add_or_fix_webdock_service_credit_then_rerun_configure_complete_smtp");
  assert.ok(route.canvasEvents.some((event) => event.type === "oc.action.now" && event.kind === "audit"));
});

test("DELETE /v1/webdock/servers/:slug blocks without delete flag, ops key, and approval", async () => {
  const route = await deleteRouteHarness({
    adapter: mockDeleteAdapter({ isLive: () => false, canWrite: () => false }),
    canvasState: canvasState([])
  });

  const response = await route("mail-delivrix-test", {
    actorId: "operator/juanes",
    approvalToken: "exec-missing",
    reason: "cleanup sprint smoke",
    taskId: "task-webdock-delete-blocked"
  }, { WEBDOCK_SERVERS_ENABLE_DELETE: "false" });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers.sort(), [
    "approval_not_found_or_expired",
    "webdock_delete_flag_disabled",
    "webdock_ops_key_missing"
  ].sort());
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.webdock.server_delete_blocked");
});

test("DELETE /v1/webdock/servers/:slug deletes server and removes active inventory", async () => {
  const deletedSlugs: string[] = [];
  const route = await deleteRouteHarness({
    adapter: mockDeleteAdapter({
      deleteServer: async (slug) => {
        deletedSlugs.push(slug);
        return {
          serverSlug: slug,
          eventId: "delete-cb-123",
          status: "deleting",
          source: {
            kind: "live",
            apiBase: "https://api.webdock.test/v1",
            fetchedAt: fixedNow.toISOString(),
            responseOk: true
          }
        };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-webdock-delete",
      executionId: "exec-webdock-delete-123",
      approvedAt: "2026-05-27T15:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-webdock-delete", "exec-webdock-delete-123");
  await route.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-delivrix-test",
      hostname: "mail.delivrix.test",
      locationId: "dk",
      profile: "bit",
      imageSlug: "ubuntu-2404",
      publicKeyFingerprint: "fp",
      status: "running",
      eventId: "create-cb-123",
      ipv4: "192.0.2.44",
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      port25UnlockRequired: true
    }]
  }));

  const response = await route("Mail-Delivrix-Test", {
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-delete-123",
    reason: "cleanup sprint smoke",
    taskId: "task-webdock-delete"
  }, { WEBDOCK_SERVERS_ENABLE_DELETE: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.serverSlug, "mail-delivrix-test");
  assert.equal(response.body.eventId, "delete-cb-123");
  assert.deepEqual(deletedSlugs, ["mail-delivrix-test"]);

  const inventory = await route.workspace.readInventoryJson<{
    servers: Array<{ slug: string }>;
    deletedServers: Array<{ slug: string; eventId: string; reason: string }>;
  }>("webdock-servers.json");
  assert.equal(inventory?.servers.length, 0);
  assert.equal(inventory?.deletedServers[0].slug, "mail-delivrix-test");
  assert.equal(inventory?.deletedServers[0].reason, "cleanup sprint smoke");
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.webdock.server_deleted");
});

test("DELETE /v1/webdock/servers/:slug con accountId=secondary enruta al adapter de secondary (5.12 money-path)", async () => {
  // El rollback de un run multicuenta debe borrar el VPS en la MISMA cuenta donde se creo. Si el
  // routing por accountId fallara, el delete iria a la cuenta-1 ("ops") y el server quedaria
  // huerfano (plata) en secondary. Cada adapter registra que recibio el delete.
  const opsHits: string[] = [];
  const secondaryHits: string[] = [];
  const opsAdapter = mockDeleteAdapter({
    deleteServer: async (slug) => {
      opsHits.push(slug);
      return deleteResult(slug, "delete-ops-evt");
    }
  });
  const secondaryAdapter = mockDeleteAdapter({
    deleteServer: async (slug) => {
      secondaryHits.push(slug);
      return deleteResult(slug, "delete-secondary-evt");
    }
  });
  const route = await deleteRouteHarness({
    adapter: opsAdapter,
    accountAdapters: new Map([["secondary", secondaryAdapter]]),
    canvasState: canvasState([{
      artifactId: "artifact-webdock-delete",
      executionId: "exec-webdock-delete-secondary",
      approvedAt: "2026-05-27T15:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-webdock-delete", "exec-webdock-delete-secondary");

  const response = await route("mail-secondary-test", {
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-delete-secondary",
    reason: "rollback multicuenta secondary",
    taskId: "task-webdock-delete-secondary",
    accountId: "secondary"
  }, { WEBDOCK_SERVERS_ENABLE_DELETE: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.eventId, "delete-secondary-evt");
  // El delete fue a secondary, NO a ops.
  assert.deepEqual(secondaryHits, ["mail-secondary-test"]);
  assert.deepEqual(opsHits, []);
});

test("DELETE /v1/webdock/servers/:slug sin accountId (o 'ops') enruta al adapter ops por defecto (5.12 fallback)", async () => {
  // Single-account / runState legacy: sin accountId el delete cae al adapter escalar (cuenta-1).
  // "ops" explicito hace lo mismo: byte-identico al delete previo al cableado multicuenta.
  const opsHits: string[] = [];
  const secondaryHits: string[] = [];
  const opsAdapter = mockDeleteAdapter({
    deleteServer: async (slug) => {
      opsHits.push(slug);
      return deleteResult(slug, "delete-ops-evt");
    }
  });
  const secondaryAdapter = mockDeleteAdapter({
    deleteServer: async (slug) => {
      secondaryHits.push(slug);
      return deleteResult(slug, "delete-secondary-evt");
    }
  });
  const makeRoute = async () => {
    const route = await deleteRouteHarness({
      adapter: opsAdapter,
      accountAdapters: new Map([["secondary", secondaryAdapter]]),
      canvasState: canvasState([{
        artifactId: "artifact-webdock-delete",
        executionId: "exec-webdock-delete-ops",
        approvedAt: "2026-05-27T15:59:00.000Z"
      }])
    });
    await appendApproval(route.auditLog, "artifact-webdock-delete", "exec-webdock-delete-ops");
    return route;
  };

  // (a) sin accountId en el body => adapter ops.
  const routeNoAccount = await makeRoute();
  const noAccount = await routeNoAccount("mail-default-test", {
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-delete-ops",
    reason: "delete sin accountId",
    taskId: "task-webdock-delete-default"
  }, { WEBDOCK_SERVERS_ENABLE_DELETE: "true" });
  assert.equal(noAccount.statusCode, 200);
  assert.equal(noAccount.body.eventId, "delete-ops-evt");

  // (b) accountId="ops" explicito => mismo adapter ops (no toca secondary).
  const routeOps = await makeRoute();
  const ops = await routeOps("mail-ops-test", {
    actorId: "operator/juanes",
    approvalToken: "exec-webdock-delete-ops",
    reason: "delete accountId ops",
    taskId: "task-webdock-delete-ops",
    accountId: "ops"
  }, { WEBDOCK_SERVERS_ENABLE_DELETE: "true" });
  assert.equal(ops.statusCode, 200);
  assert.equal(ops.body.eventId, "delete-ops-evt");

  assert.deepEqual(opsHits, ["mail-default-test", "mail-ops-test"]);
  assert.deepEqual(secondaryHits, []);
});

async function routeHarness(input: {
  adapter: WebdockServerCreateAdapter;
  canvasState: CanvasLiveStateSnapshot;
}) {
  const dir = await mkdtemp(join(tmpdir(), "webdock-create-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvasEvents: CanvasLiveEvent[] = [];

  const route = async (
    body: unknown,
    env: Record<string, string | undefined> = { WEBDOCK_SERVERS_ENABLE_CREATE: "true" }
  ): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleWebdockServerCreateHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        auditLog,
        adapter: input.adapter,
        workspace,
        canvasLiveEvents: {
          emit: async (event) => {
            canvasEvents.push(event);
            return event;
          }
        },
        readCanvasState: () => input.canvasState,
        env,
        now: () => fixedNow,
        sleep: async () => {}
      });
    } catch (error) {
      if (!handleWebdockServerCreateError(error, response as unknown as ServerResponse)) {
        throw error;
      }
    }
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return Object.assign(route, { auditLog, workspace, canvasEvents });
}

async function deleteRouteHarness(input: {
  adapter: WebdockServerDeleteAdapter;
  canvasState: CanvasLiveStateSnapshot;
  // 5.12 multicuenta: registry write-capable id->adapter. Si se pasa, el delete enruta por accountId.
  accountAdapters?: Map<string, WebdockServerDeleteAdapter>;
}) {
  const dir = await mkdtemp(join(tmpdir(), "webdock-delete-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvasEvents: CanvasLiveEvent[] = [];

  const route = async (
    serverSlug: string,
    body: unknown,
    env: Record<string, string | undefined> = { WEBDOCK_SERVERS_ENABLE_DELETE: "true" }
  ): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleWebdockServerDeleteHttp({
        request: requestWithJson(body, `/v1/webdock/servers/${serverSlug}`, "DELETE"),
        response: response as unknown as ServerResponse,
        auditLog,
        adapter: input.adapter,
        ...(input.accountAdapters ? { accountAdapters: input.accountAdapters } : {}),
        workspace,
        canvasLiveEvents: {
          emit: async (event) => {
            canvasEvents.push(event);
            return event;
          }
        },
        readCanvasState: () => input.canvasState,
        serverSlug,
        env,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleWebdockServerDeleteError(error, response as unknown as ServerResponse)) {
        throw error;
      }
    }
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return Object.assign(route, { auditLog, workspace, canvasEvents });
}

function mockAdapter(overrides: Partial<WebdockServerCreateAdapter> = {}): WebdockServerCreateAdapter {
  return {
    isLive: () => true,
    listServers: async () => ({ servers: [], source: liveWebdockSource() }),
    createServer: async (): Promise<WebdockCreateServerResult> => {
      throw new Error("createServer mock not implemented");
    },
    getServer: async (): Promise<WebdockServer> => {
      throw new Error("getServer mock not implemented");
    },
    ...overrides
  };
}

function liveWebdockSource() {
  return {
    kind: "live" as const,
    apiBase: "https://api.webdock.test/v1",
    fetchedAt: fixedNow.toISOString(),
    responseOk: true
  };
}

function mockDeleteAdapter(overrides: Partial<WebdockServerDeleteAdapter> = {}): WebdockServerDeleteAdapter {
  return {
    isLive: () => true,
    canWrite: () => true,
    deleteServer: async (): Promise<WebdockDeleteServerResult> => {
      throw new Error("deleteServer mock not implemented");
    },
    ...overrides
  };
}

function deleteResult(slug: string, eventId: string): WebdockDeleteServerResult {
  return {
    serverSlug: slug,
    eventId,
    status: "deleting",
    source: {
      kind: "live",
      apiBase: "https://api.webdock.test/v1",
      fetchedAt: fixedNow.toISOString(),
      responseOk: true
    }
  };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: "2026-05-27T15:59:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: artifactId,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: {
      executionId,
      approvalTokenHash: approvalTokenHash(executionId),
      blockCount: 1
    }
  });
}

function canvasState(approvals: Array<{
  artifactId: string;
  executionId: string;
  approvedAt: string;
}>): CanvasLiveStateSnapshot {
  return {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: fixedNow.toISOString(),
    tasks: [],
    artifacts: approvals.map((approval) => ({
      artifactId: approval.artifactId,
      taskId: "task-webdock-plan",
      kind: "proposal",
      title: "Provisionar Webdock",
      editable: true,
      createdAt: "2026-05-27T15:58:00.000Z",
      updatedAt: approval.approvedAt,
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: approval.approvedAt,
      executionId: approval.executionId,
      blocks: []
    }))
  };
}

function requestWithJson(body: unknown, url = "/v1/webdock/servers/create", method = "POST"): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method,
    url,
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

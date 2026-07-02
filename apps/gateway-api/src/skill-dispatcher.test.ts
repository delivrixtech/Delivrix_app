import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchSkillHandler,
  resolveContaboBindTiming,
  type SkillDispatcherDeps,
  type SkillHandlerEntry
} from "./skill-dispatcher.ts";
import { ionosUpsertParamSchema, route53RegisterParamSchema, route53UpsertParamSchema, webdockCreateParamSchema } from "./skill-schemas.ts";
import type { ApprovalToken } from "./security/approval-token.ts";
import { approvalTokenHash } from "./approval-guard.ts";
import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import type { WebdockServerCreateAdapter, WebdockServerDeleteAdapter } from "./routes/webdock-servers.ts";
import type { BindWebdockMainDomainAdapter } from "./routes/webdock-bind-domain.ts";
import {
  type AwsRoute53DnsChangeResult,
  type AwsRoute53DnsRecordInput,
  type AwsRoute53DnsSource,
  type AwsRoute53HostedZoneResult,
  type AwsRoute53HostedZoneSummary,
  type AwsRoute53ResourceRecordSet,
  createIonosDnsProviderFromEnv,
  createRoute53DnsProviderFromEnv,
  type DnsProvider,
  type VpsProvider,
  type WebdockServer
} from "../../../packages/adapters/src/index.ts";

const token: ApprovalToken = {
  tokenId: "exec-token-1",
  actionId: "register_domain",
  targetType: "domain",
  targetId: "delivrix.test",
  approverId: "operator-juanes",
  issuedAt: "2026-05-29T21:00:00.000Z",
  expiresAt: "2026-05-29T21:05:00.000Z",
  nonce: "nonce",
  signature: "signature"
};

test("dispatcher returns unknown_skill for unmapped skill", async () => {
  const result = await dispatchSkillHandler({
    skill: "missing",
    params: {},
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: {}
  });
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.summary, { error: "unknown_skill", skill: "missing" });
});

test("dispatcher requires dependencies", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema) }
  });
  assert.equal(result.statusCode, 500);
  assert.equal((result.summary as { error: string }).error, "dispatcher_dependencies_missing");
});

test("dispatcher validates params before invoking handler", async () => {
  const calls: unknown[] = [];
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "bad", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema, calls) }
  });
  assert.equal(result.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("dispatcher invokes handler with actorId and approvalToken", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1, autoRenew: true },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema, calls) }
  });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].actorId, "operator-juanes");
  assert.equal(calls[0].approvalToken, "exec-token-1");
});

test("dispatcher marks non-2xx handler response as failed", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: statusEntry(route53RegisterParamSchema, 409, { error: "blocked" }) }
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
});

test("dispatcher maps handler timeout to 504", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    timeoutMs: 5,
    deps: fakeDeps(),
    handlers: {
      register_domain_route53: {
        paramSchema: route53RegisterParamSchema,
        timeoutMs: 5,
        canRollback: true,
        invoke: async () => new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  });
  assert.equal(result.statusCode, 504);
  assert.equal((result.summary as { error: string }).error, "handler_timeout");
});

test("dispatcher supports provider-specific dynamic handler timeouts", async () => {
  const dynamicTimeoutEntry: SkillHandlerEntry = {
    paramSchema: passthroughParamSchema(),
    timeoutMs: ({ providerId }) => providerId === "contabo" ? 50 : 5,
    canRollback: true,
    invoke: async ({ response }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      json(response, 200, { ok: true });
    }
  };

  const webdockResult = await dispatchSkillHandler({
    skill: "bind_webdock_main_domain",
    params: { serverSlug: "srv-delivrix", domain: "example.com" },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { bind_webdock_main_domain: dynamicTimeoutEntry }
  });
  assert.equal(webdockResult.statusCode, 504);
  assert.deepEqual(webdockResult.summary, { error: "handler_timeout", timeoutMs: 5 });

  const contaboResult = await dispatchSkillHandler({
    skill: "bind_webdock_main_domain",
    params: { serverSlug: "contabo-123", domain: "example.com" },
    actorId: "operator-juanes",
    approvalToken: token,
    providerId: "contabo",
    deps: {
      ...fakeDeps(),
      vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", {} as VpsProvider]])
    },
    handlers: { bind_webdock_main_domain: dynamicTimeoutEntry }
  });
  assert.equal(contaboResult.statusCode, 200);
});

test("dispatcher clamps Contabo FCrDNS timing env values", () => {
  assert.deepEqual(
    resolveContaboBindTiming(undefined, {
      CONTABO_FCRDNS_MAX_WAIT_MS: "999999",
      CONTABO_FCRDNS_POLL_INTERVAL_MS: "1"
    }, 120_000),
    { handlerTimeoutMs: 120_000 }
  );

  assert.deepEqual(
    resolveContaboBindTiming("contabo", {
      CONTABO_FCRDNS_MAX_WAIT_MS: "abc",
      CONTABO_FCRDNS_POLL_INTERVAL_MS: "-10"
    }, 120_000),
    {
      handlerTimeoutMs: 240_000,
      fcrdnsMaxWaitMs: 180_000
    }
  );

  assert.deepEqual(
    resolveContaboBindTiming("contabo", {
      CONTABO_FCRDNS_MAX_WAIT_MS: "-10",
      CONTABO_FCRDNS_POLL_INTERVAL_MS: "NaN"
    }, 120_000),
    {
      handlerTimeoutMs: 240_000,
      fcrdnsMaxWaitMs: 180_000
    }
  );

  assert.deepEqual(
    resolveContaboBindTiming("contabo", {
      CONTABO_FCRDNS_MAX_WAIT_MS: "999999",
      CONTABO_FCRDNS_POLL_INTERVAL_MS: "1"
    }, 120_000),
    {
      handlerTimeoutMs: 300_000,
      fcrdnsMaxWaitMs: 240_000,
      fcrdnsPollIntervalMs: 5_000
    }
  );
});

test("dispatcher maps thrown handler to 500", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: {
      register_domain_route53: {
        paramSchema: route53RegisterParamSchema,
        timeoutMs: 1000,
        canRollback: true,
        invoke: async () => {
          throw new Error("boom");
        }
      }
    }
  });
  assert.equal(result.statusCode, 500);
  assert.equal((result.summary as { message: string }).message, "boom");
});

test("dispatcher retires infrastructure account as local-only state after ApprovalGate dispatch", async () => {
  const retiredInputs: unknown[] = [];
  const auditEvents: unknown[] = [];
  const result = await dispatchSkillHandler({
    skill: "retire_infrastructure_account",
    params: {
      providerId: "webdock",
      accountId: "secondary",
      accountLabel: "Cuenta 2",
      reason: "Cuenta Webdock perdida permanentemente, retirar del selector."
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...webdockDispatchDeps({
        webdockAdapter: makeSpyCreateAdapter("ops", []),
        webdockCreateAdapters: new Map()
      }),
      now: () => new Date("2026-06-24T12:00:00.000Z"),
      auditLog: {
        append: async (event: unknown) => {
          auditEvents.push(event);
          return {};
        },
        list: async () => []
      },
      accountLifecycleStore: {
        retire: async (input: any) => {
          retiredInputs.push(input);
          return {
            accountKey: "webdock:secondary",
            providerId: "webdock",
            accountId: "secondary",
            accountLabel: input.accountLabel,
            lifecycleStatus: "retired",
            healthStatus: "retired",
            retiredAt: input.retiredAt,
            retiredBy: input.actorId,
            retiredReason: input.reason
          };
        }
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(retiredInputs, [{
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    reason: "Cuenta Webdock perdida permanentemente, retirar del selector.",
    actorId: "operator-juanes",
    retiredAt: "2026-06-24T12:00:00.000Z"
  }]);
  assert.equal((result.summary as { physicalDelete?: boolean }).physicalDelete, false);
  assert.deepEqual((result.summary as { rollbackPlan?: unknown }).rollbackPlan, {
    mode: "manual_local_state",
    canRollbackAutomatically: false,
    procedure: "Edit LOCAL_INFRASTRUCTURE_ACCOUNT_LIFECYCLE_FILE or runtime/infrastructure-account-lifecycle.json and remove the account record, or set lifecycleStatus to active and healthStatus to healthy, then rerun inventory health.",
    futureSkill: "reactivate_infrastructure_account"
  });
  assert.equal((auditEvents[0] as any).action, "oc.infrastructure.account_retired");
  assert.equal((auditEvents[0] as any).metadata.physicalDelete, false);
  assert.equal((auditEvents[0] as any).metadata.sideEffects, "local-state-only");
  assert.deepEqual((auditEvents[0] as any).metadata.rollbackPlan, (result.summary as { rollbackPlan?: unknown }).rollbackPlan);
});

test("dispatcher resolves ambiguous SMTP inventory as local-only state after ApprovalGate dispatch", async () => {
  const workspace = new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "dispatcher-smtp-inventory-"))
  });
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      {
        serverSlug: "server85",
        domain: "legacy-one.com",
        serverIp: "192.0.2.85",
        selector: "default",
        status: "configured",
        tlsStatus: "attempted_or_pending_dns",
        configuredAt: "2026-06-30T20:00:00.000Z",
        updatedAt: "2026-06-30T20:00:00.000Z"
      },
      {
        serverSlug: "server88",
        domain: "legacy-one.com",
        serverIp: "192.0.2.88",
        selector: "default",
        status: "configured",
        tlsStatus: "attempted_or_pending_dns",
        configuredAt: "2026-06-30T20:00:00.000Z",
        updatedAt: "2026-06-30T20:00:00.000Z"
      }
    ]
  }));
  const auditEvents: Array<Record<string, unknown>> = [];

  const result = await dispatchSkillHandler({
    skill: "resolve_ambiguous_domain",
    params: {
      domain: "legacy-one.com",
      keepServerSlug: "server88",
      reason: "Resolver duplicado tras retry confirmado."
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...fakeDeps(),
      workspace,
      auditLog: {
        append: async (event: Record<string, unknown>) => { auditEvents.push(event); },
        list: async () => []
      },
      readKillSwitch: async () => ({ enabled: false }),
      readSmtpInventoryLiveServers: async () => [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running" }]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  const inventory = await workspace.readInventoryJson<{
    servers: Array<{ serverSlug: string; status: string; supersededBy?: string }>;
  }>("smtp-provisioning.json");
  assert.equal(inventory?.servers.find((server) => server.serverSlug === "server85")?.status, "superseded");
  assert.equal(inventory?.servers.find((server) => server.serverSlug === "server85")?.supersededBy, "server88");
  assert.equal(auditEvents.at(-1)?.action, "oc.smtp_inventory.ambiguous_domain_resolved");
  const metadata = auditEvents.at(-1)?.metadata as Record<string, unknown>;
  assert.equal(metadata.sideEffects, "local-state-only");
  assert.match(String((metadata.rollbackPlan as Record<string, unknown>).procedure), /No automatic inventory backup/);
  assert.deepEqual((metadata.plan as Record<string, unknown>).previousStatuses, [
    { serverSlug: "server85", status: "configured" },
    { serverSlug: "server88", status: "configured" }
  ]);
});

test("dispatcher creates SMTP inventory entry only for a live running server and audits critical approval hash", async () => {
  const workspace = new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "dispatcher-create-smtp-entry-")),
    now: () => new Date("2026-07-02T12:00:00.000Z")
  });
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [{
      serverSlug: "server57",
      domain: "controlcorpfiling.com",
      serverIp: "192.0.2.57",
      selector: "default",
      status: "configured",
      tlsStatus: "attempted_or_pending_dns"
    }]
  }));
  const auditEvents: Array<Record<string, unknown>> = [];

  const result = await dispatchSkillHandler({
    skill: "create_smtp_entry",
    params: {
      domain: "controlcorpfiling.com",
      serverSlug: "server58",
      serverIp: "45.136.70.174",
      selector: "s2026a",
      status: "configured",
      reason: "Crear entrada tras verificacion multi-proveedor.",
      dryRun: false
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...fakeDeps(),
      workspace,
      auditLog: {
        append: async (event: Record<string, unknown>) => { auditEvents.push(event); },
        list: async () => []
      },
      readKillSwitch: async () => ({ enabled: false }),
      readSmtpInventoryLiveServers: async () => [{
        serverSlug: "server58",
        ipv4: "45.136.70.174",
        status: "running",
        providerId: "webdock",
        accountId: "quinary",
        accountHealthStatus: "healthy"
      }]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  const inventory = await workspace.readInventoryJson<{
    servers: Array<{ serverSlug: string; domain: string; serverIp: string; selector: string; status: string; supersededBy?: string }>;
  }>("smtp-provisioning.json");
  assert.equal(inventory?.servers.find((server) => server.serverSlug === "server57")?.status, "superseded");
  assert.equal(inventory?.servers.find((server) => server.serverSlug === "server57")?.supersededBy, "server58");
  const created = inventory?.servers.find((server) => server.serverSlug === "server58");
  assert.equal(created?.status, "configured");
  assert.equal(created?.serverIp, "45.136.70.174");
  assert.equal(created?.selector, "s2026a");

  const audit = auditEvents.at(-1);
  assert.equal(audit?.action, "oc.smtp_inventory.entry_created");
  assert.equal(audit?.riskLevel, "critical");
  const metadata = audit?.metadata as Record<string, unknown>;
  assert.equal(metadata.approvalTokenHash, approvalTokenHash(token.tokenId));
  assert.equal(metadata.sideEffects, "local-state-only");
  assert.equal((metadata.rollbackPlan as Record<string, unknown>).futureSkill, "inspect_smtp_inventory");
  assert.equal((metadata.rollbackPlan as Record<string, unknown>).inventoryMutationKind, "created_new");
  assert.deepEqual((metadata.plan as Record<string, unknown>).supersededServerSlugs, ["server57"]);
});

test("dispatcher blocks create_smtp_entry before liveness reads when kill-switch is armed", async () => {
  const workspace = new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "dispatcher-create-smtp-entry-kill-")),
    now: () => new Date("2026-07-02T12:05:00.000Z")
  });
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({ servers: [] }));
  let liveRead = false;
  const result = await dispatchSkillHandler({
    skill: "create_smtp_entry",
    params: {
      domain: "controlcorpfiling.com",
      serverSlug: "server58",
      serverIp: "45.136.70.174",
      selector: "s2026a",
      status: "configured",
      reason: "Crear entrada tras verificacion multi-proveedor.",
      dryRun: false
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...fakeDeps(),
      workspace,
      readKillSwitch: async () => ({ enabled: true }),
      readSmtpInventoryLiveServers: async () => {
        liveRead = true;
        return [{ serverSlug: "server58", ipv4: "45.136.70.174", status: "running", accountHealthStatus: "healthy" }];
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 423);
  assert.deepEqual(result.summary, { error: "kill_switch_armed" });
  assert.equal(liveRead, false);
  const inventory = await workspace.readInventoryJson<{ servers: unknown[] }>("smtp-provisioning.json");
  assert.equal(inventory?.servers.length, 0);
});

test("dispatcher adopts a live quinary orphan into webdock-servers.json and audits critical approval hash", async () => {
  const workspace = new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "dispatcher-adopt-server-")),
    now: () => new Date("2026-07-02T12:00:00.000Z")
  });
  await workspace.updateInventoryJson("webdock-servers.json", () => ({ servers: [] }));
  const auditEvents: Array<Record<string, unknown>> = [];

  const result = await dispatchSkillHandler({
    skill: "adopt_webdock_server",
    params: {
      serverSlug: "server57",
      serverIp: "193.180.211.146",
      serverAccountId: "quinary",
      reason: "Adoptar server huerfano verificado en la flota viva multi-cuenta.",
      dryRun: false
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...fakeDeps(),
      workspace,
      auditLog: {
        append: async (event: Record<string, unknown>) => { auditEvents.push(event); },
        list: async () => []
      },
      readKillSwitch: async () => ({ enabled: false }),
      readSmtpInventoryLiveServers: async () => [{
        serverSlug: "server57",
        ipv4: "193.180.211.146",
        status: "running",
        providerId: "webdock",
        accountId: "quinary",
        accountHealthStatus: "healthy"
      }]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  const inventory = await workspace.readInventoryJson<{
    servers: Array<{ slug: string; ipv4: string; hostname: string; accountId?: string; adopted?: boolean }>;
  }>("webdock-servers.json");
  const adopted = inventory?.servers.find((server) => server.slug === "server57");
  assert.equal(adopted?.ipv4, "193.180.211.146");
  assert.equal(adopted?.hostname, "");
  assert.equal(adopted?.accountId, "quinary");
  assert.equal(adopted?.adopted, true);

  const audit = auditEvents.at(-1);
  assert.equal(audit?.action, "oc.webdock_servers.server_adopted");
  assert.equal(audit?.riskLevel, "critical");
  assert.equal(audit?.targetType, "webdock_server");
  assert.equal(audit?.targetId, "server57");
  const metadata = audit?.metadata as Record<string, unknown>;
  assert.equal(metadata.approvalTokenHash, approvalTokenHash(token.tokenId));
  assert.equal(metadata.sideEffects, "local-state-only");
  assert.match(String((metadata.rollbackPlan as Record<string, unknown>).procedure), /webdock-servers\.json/);

  const conflict = await dispatchSkillHandler({
    skill: "adopt_webdock_server",
    params: {
      serverSlug: "server57",
      serverIp: "193.180.211.146",
      serverAccountId: "quinary",
      reason: "Reintento de adopcion sobre entrada ya existente.",
      dryRun: false
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...fakeDeps(),
      workspace,
      auditLog: {
        append: async (event: Record<string, unknown>) => { auditEvents.push(event); },
        list: async () => []
      },
      readKillSwitch: async () => ({ enabled: false }),
      readSmtpInventoryLiveServers: async () => [{
        serverSlug: "server57",
        ipv4: "193.180.211.146",
        status: "running",
        providerId: "webdock",
        accountId: "quinary",
        accountHealthStatus: "healthy"
      }]
    }
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.statusCode, 409);
  const afterConflict = await workspace.readInventoryJson<{ servers: Array<{ slug: string }> }>("webdock-servers.json");
  assert.equal(afterConflict?.servers.filter((server) => server.slug === "server57").length, 1);
});

test("dispatcher blocks adopt_webdock_server before liveness reads when kill-switch is armed", async () => {
  const workspace = new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "dispatcher-adopt-kill-")),
    now: () => new Date("2026-07-02T12:05:00.000Z")
  });
  await workspace.updateInventoryJson("webdock-servers.json", () => ({ servers: [] }));
  let liveRead = false;
  const result = await dispatchSkillHandler({
    skill: "adopt_webdock_server",
    params: {
      serverSlug: "server57",
      serverIp: "193.180.211.146",
      serverAccountId: "quinary",
      reason: "Adoptar server huerfano verificado en la flota viva.",
      dryRun: false
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...fakeDeps(),
      workspace,
      readKillSwitch: async () => ({ enabled: true }),
      readSmtpInventoryLiveServers: async () => {
        liveRead = true;
        return [{ serverSlug: "server57", ipv4: "193.180.211.146", status: "running", accountId: "quinary", accountHealthStatus: "healthy" }];
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 423);
  assert.equal(liveRead, false);
  const adoptInventory = await workspace.readInventoryJson<{ servers: unknown[] }>("webdock-servers.json");
  assert.equal(adoptInventory?.servers.length, 0);
});

test("dispatcher reconciles live SMTP DNS after ApprovalGate dispatch and audits rollback plan", async () => {
  const workspace = new OpenClawWorkspace({
    rootDir: await mkdtemp(join(tmpdir(), "dispatcher-reconcile-dns-")),
    now: () => new Date("2026-07-01T12:00:00.000Z")
  });
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [{
      serverSlug: "server60",
      domain: "controlcorpfiling.com",
      serverIp: "193.180.211.182",
      selector: "s2026a",
      status: "configured"
    }]
  }));
  const route53DnsAdapter = new FakeDispatcherRoute53Adapter();
  const auditEvents: Array<Record<string, unknown>> = [];

  const result = await dispatchSkillHandler({
    skill: "reconcile_dns_to_live_smtp",
    params: {
      domain: "controlcorpfiling.com",
      serverSlug: "server60",
      repairReason: "Reconciliar DNS contra SMTP vivo confirmado.",
      dryRun: false
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...fakeDeps(),
      workspace,
      route53DnsAdapter: route53DnsAdapter as never,
      domainPurchaseAdapter: {
        getDomainNameservers: async () => ["ns-real-1.awsdns-11.com", "ns-real-2.awsdns-12.net"]
      } as never,
      auditLog: {
        append: async (event: Record<string, unknown>) => { auditEvents.push(event); },
        list: async () => []
      },
      readKillSwitch: async () => ({ enabled: false }),
      readCanvasState: () => ({ tasks: [], actions: [], artifacts: [] } as never),
      readSmtpInventoryLiveServers: async () => [{
        serverSlug: "server60",
        ipv4: "193.180.211.182",
        status: "running"
      }]
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(route53DnsAdapter.upserts.map((entry) => ({
    zoneId: entry.zoneId,
    name: entry.record.name,
    type: entry.record.type
  })), [
    { zoneId: "ZLIVE123456", name: "smtp.controlcorpfiling.com", type: "A" },
    { zoneId: "ZLIVE123456", name: "controlcorpfiling.com", type: "TXT" },
    { zoneId: "ZLIVE123456", name: "controlcorpfiling.com", type: "MX" }
  ]);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].action, "oc.dns.smtp_reconciled");
  const auditMetadata = auditEvents[0].metadata as Record<string, unknown>;
  assert.equal(auditMetadata.status, "reconciled");
  assert.match(String((auditMetadata.rollbackPlan as Record<string, unknown>).procedure), /upsert_dns_route53/);
  assert.equal((result.summary as { changed?: boolean }).changed, true);
});

test("dispatcher fails SMTP inventory mutators closed without a live inventory source", async () => {
  for (const mutator of smtpInventoryDispatchCases()) {
    const result = await dispatchSkillHandler({
      skill: mutator.skill,
      params: mutator.params,
      actorId: "operator-juanes",
      approvalToken: token,
      deps: fakeDeps()
    });

    assert.equal(result.ok, false, mutator.skill);
    assert.equal(result.statusCode, 503, mutator.skill);
    assert.deepEqual(result.summary, { error: "smtp_inventory_live_source_missing" }, mutator.skill);
  }
});

test("dispatcher blocks SMTP inventory mutators with kill-switch before reading live source", async () => {
  for (const mutator of smtpInventoryDispatchCases()) {
    let liveSourceRead = false;
    const result = await dispatchSkillHandler({
      skill: mutator.skill,
      params: mutator.params,
      actorId: "operator-juanes",
      approvalToken: token,
      deps: {
        ...fakeDeps(),
        readKillSwitch: async () => ({ enabled: true }),
        readSmtpInventoryLiveServers: async () => {
          liveSourceRead = true;
          return [];
        }
      }
    });

    assert.equal(result.ok, false, mutator.skill);
    assert.equal(result.statusCode, 423, mutator.skill);
    assert.deepEqual(result.summary, { error: "kill_switch_armed" }, mutator.skill);
    assert.equal(liveSourceRead, false, mutator.skill);
  }
});

test("dispatcher rejects invalid infrastructure retire params before touching lifecycle store", async () => {
  const retiredInputs: unknown[] = [];
  const deps: SkillDispatcherDeps = {
    ...webdockDispatchDeps({
      webdockAdapter: makeSpyCreateAdapter("ops", []),
      webdockCreateAdapters: new Map()
    }),
    accountLifecycleStore: {
      retire: async (input: any) => {
        retiredInputs.push(input);
        throw new Error("should_not_call_retire");
      }
    }
  };

  const wrongProvider = await dispatchSkillHandler({
    skill: "retire_infrastructure_account",
    params: {
      providerId: "contabo",
      accountId: "secondary",
      reason: "Cuenta perdida permanentemente, retirar del selector."
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps
  });
  const shortReason = await dispatchSkillHandler({
    skill: "retire_infrastructure_account",
    params: {
      providerId: "webdock",
      accountId: "secondary",
      reason: "short"
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps
  });
  const controlCharReason = await dispatchSkillHandler({
    skill: "retire_infrastructure_account",
    params: {
      providerId: "webdock",
      accountId: "secondary",
      accountLabel: "Cuenta\n2",
      reason: "Cuenta perdida permanentemente,\nretirar del selector."
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps
  });

  assert.equal(wrongProvider.statusCode, 400);
  assert.equal(shortReason.statusCode, 400);
  assert.equal(controlCharReason.statusCode, 400);
  assert.deepEqual(retiredInputs, []);
});

test("route53 register schema accepts durationYears alias and normalizes to years", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "Delivrix.TEST.", durationYears: 2 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema, calls) }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].domain, "delivrix.test");
  assert.equal(calls[0].years, 2);
});

test("route53 dns schema accepts zoneName alias and emits domain", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await dispatchSkillHandler({
    skill: "upsert_dns_route53",
    params: {
      zoneName: "Delivrix.TEST.",
      records: [{ name: "@", type: "A", ttl: 300, values: ["1.2.3.4"] }]
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { upsert_dns_route53: okEntry(route53UpsertParamSchema, calls) }
  });
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].domain, "delivrix.test");
});

test("route53 dns schema rejects unsupported record type", async () => {
  const result = await dispatchSkillHandler({
    skill: "upsert_dns_route53",
    params: {
      domain: "delivrix.test",
      records: [{ name: "@", type: "SRV", ttl: 300, values: ["bad"] }]
    },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { upsert_dns_route53: okEntry(route53UpsertParamSchema) }
  });
  assert.equal(result.statusCode, 400);
});

test("dispatcher returns parsed JSON summary", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: statusEntry(route53RegisterParamSchema, 202, { status: "accepted" }) }
  });
  assert.deepEqual(result.summary, { status: "accepted" });
});

test("dispatcher records durationMs", async () => {
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: fakeDeps(),
    handlers: { register_domain_route53: okEntry(route53RegisterParamSchema) }
  });
  assert.equal(typeof result.durationMs, "number");
  assert.equal(result.durationMs >= 0, true);
});

test("dispatcher threads accountId (canal paralelo 5.12) to the handler invoke", async () => {
  const seen: Array<string | undefined> = [];
  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    accountId: "secondary",
    deps: fakeDeps(),
    handlers: {
      register_domain_route53: {
        paramSchema: route53RegisterParamSchema,
        timeoutMs: 1000,
        canRollback: true,
        invoke: async ({ response, accountId }) => {
          seen.push(accountId);
          json(response, 200, { ok: true });
        }
      }
    }
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(seen, ["secondary"]);
});

test("DoD#2 routing: create_webdock_server con accountId='secondary' usa el adapter de la cuenta-2 (no el de ops)", async () => {
  // El handler real de create bloquea sin approval/flag, pero ANTES consulta canCreate() del adapter
  // RESUELTO. Espiamos canCreate de cada cuenta para probar que el registry enruta a la cuenta-2.
  const opsCalls: string[] = [];
  const secondaryCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const secondaryAdapter = makeSpyCreateAdapter("secondary", secondaryCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter], ["secondary", secondaryAdapter]])
  });

  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlsecondary.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    accountId: "secondary",
    deps
  });

  assert.deepEqual(secondaryCalls, ["canCreate"], "el handler consulto el adapter de la cuenta-2");
  assert.deepEqual(opsCalls, [], "NO toco el adapter de la cuenta-1");
});

test("DoD#2 routing: create_webdock_server sin accountId usa el webdockAdapter (cuenta-1 ops), byte-identico", async () => {
  const opsCalls: string[] = [];
  const secondaryCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const secondaryAdapter = makeSpyCreateAdapter("secondary", secondaryCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter], ["secondary", secondaryAdapter]])
  });

  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlops.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    // sin accountId => cuenta-1
    deps
  });

  assert.deepEqual(opsCalls, ["canCreate"], "sin accountId enruta a la cuenta-1 (ops)");
  assert.deepEqual(secondaryCalls, [], "no toca la cuenta-2");
});

test("routing fail-closed: create_webdock_server con accountId desconocido responde 409 sin caer a la cuenta-1", async () => {
  const opsCalls: string[] = [];
  const secondaryCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const secondaryAdapter = makeSpyCreateAdapter("secondary", secondaryCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter], ["secondary", secondaryAdapter]])
  });

  const result = await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controltypo.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    accountId: "quinarie",
    deps
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal((result.summary as { error?: string }).error, "unknown_server_account");
  assert.deepEqual(opsCalls, [], "NO cae silenciosamente a la cuenta-1");
  assert.deepEqual(secondaryCalls, [], "no toca otras cuentas");
});

test("routing: bind_webdock_main_domain con accountId='secondary' usa el adapter de esa cuenta", async () => {
  const opsCalls: string[] = [];
  const secondaryCalls: string[] = [];
  const opsAdapter = makeSpyBindAdapter("ops", opsCalls);
  const secondaryAdapter = makeSpyBindAdapter("secondary", secondaryCalls);
  const deps = webdockBindDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter], ["secondary", secondaryAdapter]])
  });

  const result = await dispatchSkillHandler({
    skill: "bind_webdock_main_domain",
    params: { serverSlug: "server140", domain: "bizreport-control.com" },
    actorId: "operator-juanes",
    approvalToken: token,
    accountId: "secondary",
    deps
  });

  assert.equal(result.statusCode, 424);
  assert.equal((result.summary as { error?: string }).error, "ipv4_missing");
  assert.deepEqual(secondaryCalls, ["getServer:server140"], "bind consulto el adapter de la cuenta-2");
  assert.deepEqual(opsCalls, [], "bind NO consulto el adapter default ops");
});

test("routing: bind_webdock_main_domain sin accountId usa webdockAdapter ops, byte-identico", async () => {
  const opsCalls: string[] = [];
  const secondaryCalls: string[] = [];
  const opsAdapter = makeSpyBindAdapter("ops", opsCalls);
  const secondaryAdapter = makeSpyBindAdapter("secondary", secondaryCalls);
  const deps = webdockBindDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter], ["secondary", secondaryAdapter]])
  });

  const result = await dispatchSkillHandler({
    skill: "bind_webdock_main_domain",
    params: { serverSlug: "server140", domain: "bizreport-control.com" },
    actorId: "operator-juanes",
    approvalToken: token,
    deps
  });

  assert.equal(result.statusCode, 424);
  assert.equal((result.summary as { error?: string }).error, "ipv4_missing");
  assert.deepEqual(opsCalls, ["getServer:server140"], "bind sin accountId conserva ops");
  assert.deepEqual(secondaryCalls, [], "bind default no toca la cuenta secundaria");
});

test("PROVIDER#b routing: create_webdock_server con providerId='contabo' usa el adapter del proveedor (no Webdock)", async () => {
  // El handler real de create bloquea sin approval/flag, pero ANTES consulta canCreate() del adapter
  // RESUELTO. Espiamos canCreate de cada adapter para probar que el providerId enruta a Contabo.
  const opsCalls: string[] = [];
  const contaboCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const contaboAdapter = makeSpyCreateAdapter("contabo", contaboCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter]]),
    vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", contaboAdapter]])
  });

  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlcontabo.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    providerId: "contabo",
    deps
  });

  assert.deepEqual(contaboCalls, ["canCreate"], "el handler consulto el adapter de Contabo (createServer enrutaria alli)");
  assert.deepEqual(opsCalls, [], "NO toco el adapter Webdock (ops)");
});

test("PROVIDER#b2 routing: create_webdock_server sin providerId (o 'webdock') usa el webdockAdapter; NUNCA toca el mock Contabo", async () => {
  const opsCalls: string[] = [];
  const contaboCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const contaboAdapter = makeSpyCreateAdapter("contabo", contaboCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter]]),
    vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", contaboAdapter]])
  });

  // Sin providerId => Webdock (cuenta-1 ops).
  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlops.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    deps
  });
  assert.deepEqual(opsCalls, ["canCreate"], "sin providerId enruta a Webdock (ops)");
  assert.deepEqual(contaboCalls, [], "el mock Contabo NUNCA se toca sin providerId");

  // providerId='webdock' => tambien Webdock (se trata como ausente en el resolver).
  await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlwebdock.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    providerId: "webdock",
    deps
  });
  assert.deepEqual(opsCalls, ["canCreate", "canCreate"], "providerId='webdock' enruta a Webdock (ops)");
  assert.deepEqual(contaboCalls, [], "el mock Contabo sigue intacto con providerId='webdock'");
});

test("PROVIDER#guard providerId desconocido falla 422 y no cae a Webdock", async () => {
  const opsCalls: string[] = [];
  const contaboCalls: string[] = [];
  const opsAdapter = makeSpyCreateAdapter("ops", opsCalls);
  const contaboAdapter = makeSpyCreateAdapter("contabo", contaboCalls);
  const deps = webdockDispatchDeps({
    webdockAdapter: opsAdapter,
    webdockCreateAdapters: new Map([["ops", opsAdapter]]),
    vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", contaboAdapter]])
  });

  const result = await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controltypo.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    providerId: "contaboo",
    deps
  });

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 422);
  assert.deepEqual(result.summary, { error: "unknown_vps_provider", providerId: "contaboo" });
  assert.deepEqual(opsCalls, [], "typo de provider NO cae al adapter Webdock");
  assert.deepEqual(contaboCalls, [], "typo de provider NO toca Contabo");
});

test("PROVIDER#c el providerId (canal paralelo) NO entra en los params pasados a invoke", async () => {
  const seenParams: Array<Record<string, unknown>> = [];
  const seenProviderId: Array<string | undefined> = [];
  const result = await dispatchSkillHandler({
    skill: "create_webdock_server",
    params: { profile: "bit", locationId: "dk", hostname: "smtp.controlchannel.com", imageSlug: "ubuntu-2404", publicKey: "ssh-ed25519 AAAA test" },
    actorId: "operator-juanes",
    approvalToken: token,
    providerId: "contabo",
    deps: {
      ...fakeDeps(),
      vpsProviderAdapters: new Map<string, VpsProvider>([["contabo", {} as VpsProvider]])
    },
    handlers: {
      create_webdock_server: {
        paramSchema: webdockCreateParamSchema,
        timeoutMs: 1000,
        canRollback: false,
        invoke: async ({ response, params, providerId }) => {
          seenParams.push(params);
          seenProviderId.push(providerId);
          json(response, 200, { ok: true });
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  // El providerId viaja por el canal paralelo (arg de invoke), NO dentro de params.
  assert.deepEqual(seenProviderId, ["contabo"]);
  assert.equal(seenParams.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(seenParams[0], "providerId"), false);
  // Sanidad: los params validados son exactamente el dict Webdock (sin providerId ni provider).
  assert.deepEqual(Object.keys(seenParams[0]).sort(), ["hostname", "imageSlug", "locationId", "profile", "publicKey"]);
});

test("DNS#stage2 registry factories inject dnsProviderAdapters without touching params", async () => {
  const dnsProviderEntries = [
    ...createRoute53DnsProviderFromEnv({
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secret"
    }),
    ...createIonosDnsProviderFromEnv({
      IONOS_API_TOKEN: "ionos-token",
      IONOS_DNS_ENABLE_WRITES: "true"
    })
  ];
  const dnsProviderAdapters = new Map<string, DnsProvider>(
    dnsProviderEntries.map((entry): [string, DnsProvider] => [entry.id, entry.adapter])
  );
  const seenKeys: string[][] = [];
  const seenParams: Array<Record<string, unknown>> = [];

  const result = await dispatchSkillHandler({
    skill: "register_domain_route53",
    params: { domain: "delivrix.test", years: 1 },
    actorId: "operator-juanes",
    approvalToken: token,
    deps: {
      ...fakeDeps(),
      dnsProviderAdapters
    },
    handlers: {
      register_domain_route53: {
        paramSchema: route53RegisterParamSchema,
        timeoutMs: 1000,
        canRollback: true,
        invoke: async ({ response, params, deps }) => {
          seenKeys.push([...(deps.dnsProviderAdapters?.keys() ?? [])].sort());
          seenParams.push(params);
          json(response, 200, { ok: true });
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(seenKeys, [["ionos", "route53"]]);
  assert.equal(dnsProviderAdapters.get("route53")?.isLive(), true);
  assert.equal(dnsProviderAdapters.get("ionos")?.isLive(), true);
  assert.equal(dnsProviderAdapters.get("ionos")?.isWriteEnabled(), true);
  assert.equal(Object.prototype.hasOwnProperty.call(seenParams[0], "dnsProviderId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(seenParams[0], "registrarId"), false);
});

test("DNS#stage4 dnsProviderId travels as sibling and never enters params", async () => {
  const dnsProviderAdapters = new Map<string, DnsProvider>([["ionos", {} as DnsProvider]]);
  const seenParams: Array<Record<string, unknown>> = [];
  const seenDnsProviderIds: Array<string | undefined> = [];

  const result = await dispatchSkillHandler({
    skill: "upsert_dns_ionos",
    params: {
      zone: "annualcorpfilings.com",
      records: [{ name: "smtp.annualcorpfilings.com", type: "A", ttl: 300, content: "203.0.113.10" }]
    },
    actorId: "operator-juanes",
    approvalToken: token,
    dnsProviderId: "ionos",
    deps: {
      ...fakeDeps(),
      dnsProviderAdapters
    },
    handlers: {
      upsert_dns_ionos: {
        paramSchema: ionosUpsertParamSchema,
        timeoutMs: 1000,
        canRollback: true,
        invoke: async ({ response, params, dnsProviderId }) => {
          seenParams.push(params);
          seenDnsProviderIds.push(dnsProviderId);
          json(response, 200, { ok: true });
        }
      }
    }
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(seenDnsProviderIds, ["ionos"]);
  assert.equal(Object.prototype.hasOwnProperty.call(seenParams[0], "dnsProviderId"), false);
  assert.deepEqual(seenParams[0], {
    zone: "annualcorpfilings.com",
    records: [{ name: "smtp.annualcorpfilings.com", type: "A", ttl: 300, content: "203.0.113.10" }]
  });
});

test("DNS#stage4 unknown dnsProviderId fails 422 before handler invoke", async () => {
  const calls: unknown[] = [];
  const result = await dispatchSkillHandler({
    skill: "upsert_dns_ionos",
    params: {
      zone: "annualcorpfilings.com",
      records: [{ name: "smtp.annualcorpfilings.com", type: "A", ttl: 300, content: "203.0.113.10" }]
    },
    actorId: "operator-juanes",
    approvalToken: token,
    dnsProviderId: "cloudflare",
    deps: {
      ...fakeDeps(),
      dnsProviderAdapters: new Map<string, DnsProvider>([["ionos", {} as DnsProvider]])
    },
    handlers: { upsert_dns_ionos: okEntry(ionosUpsertParamSchema, calls) }
  });

  assert.equal(result.statusCode, 422);
  assert.deepEqual(result.summary, { error: "unknown_dns_provider", dnsProviderId: "cloudflare" });
  assert.deepEqual(calls, []);
});

function makeSpyCreateAdapter(
  id: string,
  calls: string[]
): WebdockServerCreateAdapter & WebdockServerDeleteAdapter {
  return {
    isLive: () => true,
    canWrite: () => { calls.push("canWrite"); return false; },
    canCreate: () => { calls.push("canCreate"); return false; },
    async createServer() { calls.push("createServer"); throw new Error(`createServer should not run for ${id} in blocked path`); },
    async getServer() { throw new Error("getServer not expected"); },
    async deleteServer() { calls.push("deleteServer"); throw new Error("deleteServer not expected"); }
  };
}

function makeSpyBindAdapter(
  id: string,
  calls: string[]
): WebdockServerCreateAdapter & WebdockServerDeleteAdapter & BindWebdockMainDomainAdapter {
  return {
    isLive: () => true,
    canWrite: () => true,
    canCreate: () => true,
    async createServer() { calls.push("createServer"); throw new Error(`createServer should not run for ${id} in bind path`); },
    async getServer(serverSlug: string): Promise<WebdockServer> {
      calls.push(`getServer:${serverSlug}`);
      return {
        slug: serverSlug,
        name: `${id}.example.test`,
        mainDomain: `${id}.example.test`,
        ipv4: "",
        status: "running"
      };
    },
    async deleteServer() { calls.push("deleteServer"); throw new Error("deleteServer not expected"); },
    async setServerIdentity() { calls.push("setServerIdentity"); throw new Error("setServerIdentity not expected without ipv4"); },
    async setServerMainDomain() { calls.push("setServerMainDomain"); throw new Error("setServerMainDomain not expected without ipv4"); },
    async setServerPtr() { calls.push("setServerPtr"); throw new Error("setServerPtr not expected without ipv4"); }
  };
}

function webdockDispatchDeps(overrides: {
  webdockAdapter: WebdockServerCreateAdapter;
  webdockCreateAdapters: Map<string, WebdockServerCreateAdapter & Partial<WebdockServerDeleteAdapter> & Partial<BindWebdockMainDomainAdapter>>;
  vpsProviderAdapters?: SkillDispatcherDeps["vpsProviderAdapters"];
}): SkillDispatcherDeps {
  return {
    auditLog: { append: async () => ({}), list: async () => [] },
    workspace: {
      readLearnings: async () => [],
      writeExecutionRecord: async () => null,
      updateInventoryJson: async () => undefined
    } as unknown as SkillDispatcherDeps["workspace"],
    readCanvasState: () => ({ tasks: [], actions: [], artifacts: [] } as never),
    domainPurchaseAdapter: {} as never,
    route53DnsAdapter: {} as never,
    ionosDnsAdapter: {} as never,
    webdockAdapter: overrides.webdockAdapter as never,
    webdockCreateAdapters: overrides.webdockCreateAdapters,
    ...(overrides.vpsProviderAdapters ? { vpsProviderAdapters: overrides.vpsProviderAdapters } : {}),
    smtpSshRunner: {} as never,
    rampScheduler: {} as never,
    env: { WEBDOCK_SERVERS_ENABLE_CREATE: "false" }
  };
}

function webdockBindDispatchDeps(overrides: {
  webdockAdapter: WebdockServerCreateAdapter & BindWebdockMainDomainAdapter;
  webdockCreateAdapters: Map<string, WebdockServerCreateAdapter & Partial<WebdockServerDeleteAdapter> & Partial<BindWebdockMainDomainAdapter>>;
  vpsProviderAdapters?: SkillDispatcherDeps["vpsProviderAdapters"];
}): SkillDispatcherDeps {
  const approvedAt = "2026-05-29T21:02:00.000Z";
  return {
    ...webdockDispatchDeps(overrides),
    auditLog: {
      append: async () => ({}),
      list: async () => [{
        id: "audit-approved-1",
        occurredAt: approvedAt,
        action: "oc.artifact.approved",
        actorType: "operator",
        actorId: "operator-juanes",
        targetType: "artifact",
        targetId: "artifact-bind-1",
        riskLevel: "high",
        decision: "allow",
        humanApproved: true,
        metadata: { approvalTokenHash: approvalTokenHash(token.tokenId) }
      }]
    },
    readCanvasState: () => ({
      tasks: [],
      actions: [],
      artifacts: [{
        artifactId: "artifact-bind-1",
        executionId: token.tokenId,
        approvalStatus: "approved",
        approvedAt
      }]
    }) as never,
    now: () => new Date("2026-05-29T21:03:00.000Z")
  };
}

function okEntry(schema: SkillHandlerEntry["paramSchema"], calls: Array<Record<string, unknown>> = []): SkillHandlerEntry {
  return {
    paramSchema: schema,
    timeoutMs: 1000,
    canRollback: true,
    invoke: async ({ request, response }) => {
      const body = await readJson(request);
      calls.push(body);
      json(response, 200, { ok: true, body });
    }
  };
}

function statusEntry(
  schema: SkillHandlerEntry["paramSchema"],
  statusCode: number,
  body: unknown
): SkillHandlerEntry {
  return {
    paramSchema: schema,
    timeoutMs: 1000,
    canRollback: true,
    invoke: async ({ response }) => {
      json(response, statusCode, body);
    }
  };
}

class FakeDispatcherRoute53Adapter {
  readonly upserts: Array<{ zoneId: string; record: AwsRoute53DnsRecordInput }> = [];

  isLive(): boolean {
    return true;
  }

  isWriteEnabled(): boolean {
    return true;
  }

  currentSource(): AwsRoute53DnsSource {
    return {
      kind: "live",
      region: "us-east-1",
      apiBase: "https://route53.amazonaws.com",
      fetchedAt: "2026-07-01T12:00:00.000Z",
      responseOk: true,
      writeEnabled: true
    };
  }

  async createHostedZone(): Promise<AwsRoute53HostedZoneResult> {
    throw new Error("unexpected createHostedZone");
  }

  async listHostedZones(): Promise<AwsRoute53HostedZoneSummary[]> {
    return this.hostedZones();
  }

  async listHostedZonesByName(): Promise<AwsRoute53HostedZoneSummary[]> {
    return this.hostedZones();
  }

  async upsertRecord(zoneId: string, record: AwsRoute53DnsRecordInput): Promise<AwsRoute53DnsChangeResult> {
    this.upserts.push({ zoneId, record });
    return { changeId: `change-${this.upserts.length}` };
  }

  async listResourceRecordSets(zoneId: string): Promise<AwsRoute53ResourceRecordSet[]> {
    if (zoneId !== "ZLIVE123456") return [];
    return [
      {
        name: "controlcorpfiling.com.",
        type: "NS",
        ttl: 172800,
        values: ["ns-real-1.awsdns-11.com.", "ns-real-2.awsdns-12.net."]
      },
      {
        name: "s2026a._domainkey.controlcorpfiling.com.",
        type: "TXT",
        ttl: 300,
        values: ["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"]
      }
    ];
  }

  private hostedZones(): AwsRoute53HostedZoneSummary[] {
    return [{
      zoneId: "ZLIVE123456",
      name: "controlcorpfiling.com.",
      nameServers: ["ns-real-1.awsdns-11.com.", "ns-real-2.awsdns-12.net."]
    }];
  }
}

function fakeDeps(): any {
  return {};
}

function smtpInventoryDispatchCases(): Array<{ skill: string; params: Record<string, unknown> }> {
  return [
    {
      skill: "resolve_ambiguous_domain",
      params: {
        domain: "legacy-one.com",
        keepServerSlug: "server88",
        reason: "Resolver duplicado confirmado por inventario vivo."
      }
    },
    {
      skill: "retire_smtp_entry",
      params: {
        domain: "legacy-one.com",
        serverSlug: "server92",
        reason: "Retirar entrada espuria confirmada por auditoria."
      }
    },
    {
      skill: "reassign_domain_server",
      params: {
        domain: "legacy-one.com",
        fromServerSlug: "server92",
        toServerSlug: "server88",
        reason: "Reasignar canonico tras drift confirmado."
      }
    },
    {
      skill: "create_smtp_entry",
      params: {
        domain: "legacy-one.com",
        serverSlug: "server88",
        serverIp: "192.0.2.88",
        selector: "s2026a",
        status: "configured",
        reason: "Crear entrada confirmada por inventario vivo."
      }
    },
    {
      skill: "update_smtp_entry",
      params: {
        domain: "legacy-one.com",
        serverSlug: "server88",
        status: "configured",
        reason: "Actualizar estado local confirmado por operador."
      }
    }
  ];
}

function passthroughParamSchema(): SkillHandlerEntry["paramSchema"] {
  return {
    safeParse(value: unknown) {
      return { success: true, data: value as Record<string, unknown> };
    }
  } as SkillHandlerEntry["paramSchema"];
}

async function readJson(request: AsyncIterable<unknown>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

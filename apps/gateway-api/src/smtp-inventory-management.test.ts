import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import {
  createConfiguredSmtpInventoryEntry,
  inspectSmtpInventory,
  reassignSmtpDomainServer,
  resolveAmbiguousSmtpDomain,
  retireSmtpInventoryEntry,
  updateSmtpInventoryEntry,
  upsertConfiguredSmtpInventoryEntry,
  type SmtpProvisioningInventory
} from "./smtp-inventory-management.ts";

const fixedNow = new Date("2026-06-30T20:15:00.000Z");

test("upsertConfiguredSmtpInventoryEntry supersedes previous configured entries for the same domain", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [entry("server85", "legacy-one.com", "configured")]
  }));

  await upsertConfiguredSmtpInventoryEntry(workspace, {
    ...entry("server88", "legacy-one.com", "configured"),
    serverIp: "192.0.2.88"
  }, () => fixedNow);

  const inventory = await readInventory(workspace);
  assert.equal(inventory.servers.filter((server) => server.domain === "legacy-one.com" && server.status === "configured").length, 1);
  assert.equal(inventory.servers.find((server) => server.serverSlug === "server85")?.status, "superseded");
  assert.equal(inventory.servers.find((server) => server.serverSlug === "server85")?.supersededBy, "server88");
  assert.equal(inventory.servers.find((server) => server.serverSlug === "server88")?.status, "configured");
});

test("createConfiguredSmtpInventoryEntry dry-runs by default and writes only with dryRun false", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [entry("server85", "legacy-one.com", "configured")]
  }));
  const liveServers = [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running", accountHealthStatus: "healthy" }];

  const defaultDryRun = await createConfiguredSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    liveServers,
    actorId: "operator-juanes",
    now: () => fixedNow
  });
  assert.equal(defaultDryRun.status, "dry_run");
  assert.equal(defaultDryRun.changed, false);
  assert.equal((await readInventory(workspace)).servers.find((server) => server.serverSlug === "server88"), undefined);

  const created = await createConfiguredSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    liveServers,
    actorId: "operator-juanes",
    reason: "Crear entrada tras verificacion live.",
    dryRun: false,
    now: () => fixedNow
  });
  assert.equal(created.ok, true);
  assert.equal(created.status, "created");
  assert.deepEqual(created.supersededServerSlugs, ["server85"]);
  assert.equal((created.plan?.previousStatuses as unknown[]).length, 1);
  const inventory = await readInventory(workspace);
  assert.equal(inventory.servers.find((server) => server.serverSlug === "server85")?.status, "superseded");
  const server88 = inventory.servers.find((server) => server.serverSlug === "server88");
  assert.equal(server88?.status, "configured");
  assert.equal(server88?.serverIp, "192.0.2.88");
  assert.equal(server88?.selector, "s2026a");
});

test("createConfiguredSmtpInventoryEntry rejects non-live, IP mismatch, non-running and degraded accounts", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({ servers: [] }));

  const missing = await createConfiguredSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    liveServers: [],
    actorId: "operator-juanes",
    dryRun: false
  });
  assert.equal(missing.status, "server_not_live");

  const ipMismatch = await createConfiguredSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    serverIp: "192.0.2.99",
    selector: "s2026a",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running", accountHealthStatus: "healthy" }],
    actorId: "operator-juanes",
    dryRun: false
  });
  assert.equal(ipMismatch.status, "server_ip_mismatch");

  const stopped = await createConfiguredSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "stopped", accountHealthStatus: "healthy" }],
    actorId: "operator-juanes",
    dryRun: false
  });
  assert.equal(stopped.status, "server_status_not_running");

  const degraded = await createConfiguredSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running", accountHealthStatus: "degraded" }],
    actorId: "operator-juanes",
    dryRun: false
  });
  assert.equal(degraded.status, "account_not_healthy");
  assert.equal((await readInventory(workspace)).servers.length, 0);
});

test("resolveAmbiguousSmtpDomain keeps the explicit live server and supersedes the rest", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      entry("server85", "legacy-one.com", "configured"),
      entry("server88", "legacy-one.com", "configured")
    ]
  }));

  const result = await resolveAmbiguousSmtpDomain({
    workspace,
    domain: "legacy-one.com",
    keepServerSlug: "server88",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running" }],
    actorId: "operator/juanes",
    reason: "Resolver duplicado tras retry.",
    now: () => fixedNow
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  const inventory = await readInventory(workspace);
  assert.equal(inventory.servers.find((server) => server.serverSlug === "server85")?.status, "superseded");
  assert.equal(inventory.servers.find((server) => server.serverSlug === "server88")?.status, "configured");
});

test("resolveAmbiguousSmtpDomain auto-keeps the live server backed by a completed SMTP run", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      entry("server60", "incident-real.com", "configured", { configuredAt: "2026-06-20T10:00:00.000Z" }),
      entry("server92", "incident-real.com", "configured", { configuredAt: "2026-06-30T10:00:00.000Z" })
    ]
  }));
  await writeRunState(workspace, {
    runId: "run-canonical",
    status: "completed",
    chosenDomain: "incident-real.com",
    serverSlug: "server60",
    updatedAt: "2026-06-21T10:00:00.000Z"
  });
  await writeRunState(workspace, {
    runId: "run-spurious",
    status: "failed",
    chosenDomain: "incident-real.com",
    serverSlug: "server92",
    updatedAt: "2026-06-30T10:00:00.000Z"
  });

  const result = await resolveAmbiguousSmtpDomain({
    workspace,
    domain: "incident-real.com",
    liveServers: [
      { serverSlug: "server60", ipv4: "192.0.2.60", status: "stopped" },
      { serverSlug: "server92", ipv4: "192.0.2.92", status: "running" }
    ],
    actorId: "openclaw",
    reason: "Resolver duplicado real con run completado.",
    now: () => fixedNow
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.canonicalServerSlug, "server60");
  assert.deepEqual(result.supersededServerSlugs, ["server92"]);
  assert.equal((result.plan?.canonicalEvidence as Record<string, unknown>).source, "completed_smtp_run");
  const inventory = await readInventory(workspace);
  assert.equal(inventory.servers.find((server) => server.serverSlug === "server60")?.status, "configured");
  assert.equal(inventory.servers.find((server) => server.serverSlug === "server92")?.status, "superseded");
});

test("resolveAmbiguousSmtpDomain fails closed when live configured candidates remain tied", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      entry("server60", "incident-real.com", "configured", { configuredAt: "2026-06-30T10:00:00.000Z" }),
      entry("server92", "incident-real.com", "configured", { configuredAt: "2026-06-30T10:00:00.000Z" })
    ]
  }));

  const result = await resolveAmbiguousSmtpDomain({
    workspace,
    domain: "incident-real.com",
    liveServers: [
      { serverSlug: "server60", ipv4: "192.0.2.60", status: "running" },
      { serverSlug: "server92", ipv4: "192.0.2.92", status: "running" }
    ],
    actorId: "openclaw",
    now: () => fixedNow
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "canonical_server_required");
});

test("SMTP inventory mutations support dry-run, retire, reassign and guarded update", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      entry("server85", "legacy-one.com", "configured"),
      entry("server88", "legacy-one.com", "retired")
    ]
  }));
  const liveServers = [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running" }];

  const dryRun = await reassignSmtpDomainServer({
    workspace,
    domain: "legacy-one.com",
    fromServerSlug: "server85",
    toServerSlug: "server88",
    liveServers,
    actorId: "operator/juanes",
    reason: "Mover canonico al servidor vivo.",
    dryRun: true,
    now: () => fixedNow
  });
  assert.equal(dryRun.status, "dry_run");
  assert.equal((await readInventory(workspace)).servers.find((server) => server.serverSlug === "server85")?.status, "configured");

  const reassigned = await reassignSmtpDomainServer({
    workspace,
    domain: "legacy-one.com",
    fromServerSlug: "server85",
    toServerSlug: "server88",
    liveServers,
    actorId: "operator/juanes",
    reason: "Mover canonico al servidor vivo.",
    now: () => fixedNow
  });
  assert.equal(reassigned.status, "reassigned");
  assert.equal((await readInventory(workspace)).servers.find((server) => server.serverSlug === "server85")?.status, "superseded");

  const updated = await updateSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    patch: { selector: "s2026a", tlsStatus: "attempted_or_pending_dns" },
    liveServers,
    actorId: "operator/juanes",
    now: () => fixedNow
  });
  assert.equal(updated.status, "updated");
  assert.equal((await readInventory(workspace)).servers.find((server) => server.serverSlug === "server88")?.selector, "s2026a");

  const retired = await retireSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    liveServers,
    actorId: "operator/juanes",
    reason: "Retiro local por reemplazo auditado.",
    now: () => fixedNow
  });
  assert.equal(retired.status, "retired");
  assert.equal((await readInventory(workspace)).servers.find((server) => server.serverSlug === "server88")?.retiredBy, "operator/juanes");
});

test("SMTP inventory guards live source and dry-runs do not mutate", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      entry("server85", "legacy-one.com", "configured"),
      entry("server88", "legacy-one.com", "configured")
    ]
  }));

  const requestedNotLive = await resolveAmbiguousSmtpDomain({
    workspace,
    domain: "legacy-one.com",
    keepServerSlug: "server85",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running" }],
    actorId: "operator-juanes"
  });
  assert.equal(requestedNotLive.status, "requested_server_not_live");

  const reassignNotLive = await reassignSmtpDomainServer({
    workspace,
    domain: "legacy-one.com",
    fromServerSlug: "server85",
    toServerSlug: "server99",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running" }],
    actorId: "operator-juanes",
    reason: "Destino no existe en fuente viva."
  });
  assert.equal(reassignNotLive.status, "target_server_not_live");

  const updateNotLive = await updateSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server85",
    patch: { status: "configured" },
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running" }],
    actorId: "operator-juanes"
  });
  assert.equal(updateNotLive.status, "server_not_live");
  assert.equal((await readInventory(workspace)).servers.find((server) => server.serverSlug === "server85")?.status, "configured");

  const resolveDryRun = await resolveAmbiguousSmtpDomain({
    workspace,
    domain: "legacy-one.com",
    keepServerSlug: "server88",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running" }],
    actorId: "operator-juanes",
    dryRun: true
  });
  assert.equal(resolveDryRun.status, "dry_run");
  assert.equal((await readInventory(workspace)).servers.filter((server) => server.status === "configured").length, 2);

  const retireDryRun = await retireSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running" }],
    actorId: "operator-juanes",
    reason: "Solo simulacion de retiro.",
    dryRun: true
  });
  assert.equal(retireDryRun.status, "dry_run");
  assert.equal((await readInventory(workspace)).servers.find((server) => server.serverSlug === "server88")?.status, "configured");

  const updateDryRun = await updateSmtpInventoryEntry({
    workspace,
    domain: "legacy-one.com",
    serverSlug: "server88",
    patch: { status: "retired" },
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running" }],
    actorId: "operator-juanes",
    dryRun: true
  });
  assert.equal(updateDryRun.status, "dry_run");
  assert.equal((await readInventory(workspace)).servers.find((server) => server.serverSlug === "server88")?.status, "configured");
});

test("inspectSmtpInventory cross-checks configured entries against live servers", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      entry("server85", "legacy-one.com", "configured"),
      entry("server88", "legacy-one.com", "configured")
    ]
  }));

  const report = await inspectSmtpInventory({
    workspace,
    domain: "legacy-one.com",
    liveServers: [{ serverSlug: "server88", ipv4: "192.0.2.88", status: "running", providerId: "webdock" }]
  });

  assert.equal(report.ok, false);
  assert.deepEqual((report.ambiguousDomains as any[])[0].liveConfiguredServerSlugs, ["server88"]);
  assert.equal((report.servers as any[]).find((server) => server.serverSlug === "server85").existsInLiveInventory, false);
});

async function setupWorkspace(): Promise<OpenClawWorkspace> {
  const rootDir = await mkdtemp(join(tmpdir(), "smtp-inventory-management-"));
  return new OpenClawWorkspace({ rootDir, now: () => fixedNow });
}

async function readInventory(workspace: OpenClawWorkspace): Promise<SmtpProvisioningInventory & { servers: NonNullable<SmtpProvisioningInventory["servers"]> }> {
  const inventory = await workspace.readInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json");
  return { ...(inventory ?? {}), servers: inventory?.servers ?? [] };
}

async function writeRunState(
  workspace: OpenClawWorkspace,
  input: { runId: string; status: "completed" | "failed"; chosenDomain: string; serverSlug: string; updatedAt: string }
): Promise<void> {
  await workspace.writeWorkspaceFileAtomic(`inventory/smtp-runs/${input.runId}.json`, `${JSON.stringify({
    schemaVersion: "smtp-run-state/v1",
    runId: input.runId,
    status: input.status,
    chosenDomain: input.chosenDomain,
    serverSlug: input.serverSlug,
    updatedAt: input.updatedAt,
    steps: {
      "14": {
        step: 14,
        skill: "send_real_email",
        status: input.status === "completed" ? "done" : "pending",
        completedAt: input.status === "completed" ? input.updatedAt : undefined,
        updatedAt: input.updatedAt
      }
    }
  }, null, 2)}\n`);
}

function entry(
  serverSlug: string,
  domain: string,
  status: "configured" | "superseded" | "retired",
  overrides: Partial<NonNullable<SmtpProvisioningInventory["servers"]>[number]> = {}
) {
  return {
    serverSlug,
    domain,
    serverIp: serverSlug === "server88" ? "192.0.2.88" : "192.0.2.85",
    selector: "default",
    status,
    tlsStatus: "attempted_or_pending_dns",
    configuredAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    ...overrides
  };
}

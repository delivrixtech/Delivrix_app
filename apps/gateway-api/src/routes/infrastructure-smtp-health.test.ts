import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAccountSmtpHealth,
  type BuildAccountSmtpHealthInput,
  type SmtpHealthUnit
} from "./infrastructure-smtp-health.ts";

const now = new Date("2026-07-13T18:00:00.000Z");

function baseInput(overrides: Partial<BuildAccountSmtpHealthInput> = {}): BuildAccountSmtpHealthInput {
  return {
    providerId: "contabo",
    accountId: "contabo-2",
    accountLabel: "infravps",
    liveServers: [],
    now,
    ...overrides
  };
}

function unitFor(units: SmtpHealthUnit[], domain: string): SmtpHealthUnit | undefined {
  return units.find((unit) => unit.domain === domain);
}

test("active: configured provisioning + running server + credential", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [{ slug: "contabo-1", ipv4: "10.0.0.1", status: "running" }],
    provisioningInventory: {
      servers: [{ serverSlug: "contabo-1", domain: "good.com", serverIp: "10.0.0.1", selector: "s2026a", status: "configured", tlsStatus: "attempted_or_pending_dns" }]
    },
    credentialsInventory: {
      smtpCredentials: [{ domain: "good.com", serverSlug: "contabo-1", host: "smtp.good.com", status: "configured" }]
    }
  }));
  const unit = unitFor(health.units, "good.com");
  assert.equal(unit?.state, "active");
  assert.equal(unit?.credentialStatus, "configured");
  assert.equal(health.summary.active, 1);
});

test("down: configured provisioning but server not running", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [{ slug: "contabo-2", status: "stopped" }],
    provisioningInventory: {
      servers: [{ serverSlug: "contabo-2", domain: "down.com", serverIp: "10.0.0.2", selector: "s", status: "configured" }]
    }
  }));
  const unit = unitFor(health.units, "down.com");
  assert.equal(unit?.state, "down");
  assert.equal(unit?.issues[0]?.code, "smtp_server_down");
  assert.equal(health.summary.down, 1);
});

test("error: failed run referencing the domain surfaces evidence + suggested fix", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [{ slug: "contabo-3", status: "running" }],
    provisioningInventory: {
      servers: [{ serverSlug: "contabo-3", domain: "err.com", serverIp: "10.0.0.3", selector: "s", status: "configured" }]
    },
    domainsInventory: { domains: [{ domain: "err.com", status: "owned", costUsd: 16 }] },
    smtpRuns: [{ runId: "smtp-err-contabo2-v1", status: "failed", chosenDomain: "err.com", serverSlug: "contabo-3", providerId: "contabo-2", budgetSpentUsd: 16, lastCompletedStep: 8 }]
  }));
  const unit = unitFor(health.units, "err.com");
  assert.equal(unit?.state, "error");
  assert.ok(unit?.evidence.some((ev) => ev.source === "smtp-runs" && ev.runId === "smtp-err-contabo2-v1"));
  assert.equal(unit?.issues[0]?.code, "domain_purchased_without_smtp");
  assert.equal(health.summary.error, 1);
});

test("error: ambiguous domain (>1 configured server)", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [{ slug: "contabo-4", status: "running" }],
    provisioningInventory: {
      servers: [{ serverSlug: "contabo-4", domain: "amb.com", serverIp: "10.0.0.4", selector: "s", status: "configured" }]
    },
    ambiguousDomains: ["amb.com"]
  }));
  assert.equal(unitFor(health.units, "amb.com")?.issues[0]?.code, "ambiguous_domain_multi_server");
});

test("no_smtp: server running + bound domain but no provisioning entry", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [{ slug: "contabo-5", status: "running" }],
    domainsInventory: { bindings: [{ domain: "fresh.com", serverSlug: "contabo-5", status: "bound" }] }
  }));
  const unit = unitFor(health.units, "fresh.com");
  assert.equal(unit?.state, "no_smtp");
  assert.equal(health.summary.noSmtp, 1);
});

test("server_no_domain: live server without domain nor SMTP goes to unattachedOrphans", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [{ slug: "contabo-6", status: "running" }]
  }));
  assert.equal(health.units.length, 0);
  assert.equal(health.unattachedOrphans[0]?.state, "server_no_domain");
  assert.equal(health.unattachedOrphans[0]?.issues[0]?.code, "server_without_domain");
});

test("orphan_domain_no_smtp: owned domain, paid failed run, no configured provisioning", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [],
    domainsInventory: { domains: [{ domain: "orphan.com", status: "owned", costUsd: 16 }] },
    smtpRuns: [{ runId: "smtp-orphan-contabo2-v1", status: "failed", chosenDomain: "orphan.com", providerId: "contabo-2", budgetSpentUsd: 16, lastCompletedStep: 4 }]
  }));
  const orphan = health.unattachedOrphans.find((unit) => unit.domain === "orphan.com");
  assert.equal(orphan?.state, "orphan_domain_no_smtp");
  assert.equal(orphan?.issues[0]?.code, "domain_purchased_without_smtp");
  assert.equal(health.summary.orphans, 1);
});

test("pending_registration: domain still pending at the registrar", () => {
  const health = buildAccountSmtpHealth(baseInput({
    domainsInventory: { domains: [{ domain: "pending.com", status: "pending", costUsd: 15 }] },
    smtpRuns: [{ runId: "smtp-pending-contabo2-v1", status: "failed", chosenDomain: "pending.com", providerId: "contabo-2", budgetSpentUsd: 15, lastCompletedStep: 2 }]
  }));
  const pending = health.unattachedOrphans.find((unit) => unit.domain === "pending.com");
  assert.equal(pending?.state, "pending_registration");
  assert.equal(pending?.issues[0]?.code, "domain_registration_pending");
  assert.equal(health.summary.pendingRegistration, 1);
});

test("credential_no_server: credential slug not live and matching provider prefix", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [{ slug: "contabo-live", status: "running" }],
    allLiveServerSlugs: ["contabo-live"],
    credentialsInventory: {
      smtpCredentials: [{ domain: "ghost.com", serverSlug: "contabo-dead", host: "smtp.ghost.com", status: "configured" }]
    }
  }));
  const ghost = health.unattachedOrphans.find((unit) => unit.serverSlug === "contabo-dead");
  assert.equal(ghost?.state, "credential_no_server");
  assert.equal(ghost?.issues[0]?.code, "credential_without_server");
});

test("credentials are redacted: no username field, only status + host", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [{ slug: "contabo-9", status: "running" }],
    provisioningInventory: {
      servers: [{ serverSlug: "contabo-9", domain: "secret.com", serverIp: "10.0.0.9", selector: "s", status: "configured" }]
    },
    credentialsInventory: {
      smtpCredentials: [{ domain: "secret.com", serverSlug: "contabo-9", host: "smtp.secret.com", status: "configured" }]
    }
  }));
  const serialized = JSON.stringify(health);
  assert.doesNotMatch(serialized, /mailer@/);
  assert.doesNotMatch(serialized, /smtpCredentialEncrypted/);
  assert.doesNotMatch(serialized, /username/);
});

test("tolerates fully-null inventories without throwing", () => {
  const health = buildAccountSmtpHealth(baseInput({
    liveServers: [],
    domainsInventory: null,
    provisioningInventory: null,
    credentialsInventory: null,
    webdockServersInventory: null
  }));
  assert.equal(health.summary.total, 0);
  assert.equal(health.units.length, 0);
});

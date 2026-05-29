import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AutoRollbackManager,
  createAutoRollbackManagerFromEnv,
  createSafeDigFn,
  type RollbackSnapshot
} from "./auto-rollback.ts";

test("captureSnapshot creates a kind-auditId file with capturedAt", async () => {
  const snapshotDir = await tempDir();
  const manager = new AutoRollbackManager({ snapshotDir, now: fixedNow });

  await manager.captureSnapshot({
    auditId: "audit-1",
    kind: "dns",
    beforeState: { records: [] },
    metadata: { domain: "example.com" }
  });

  const raw = await readFile(join(snapshotDir, "dns-audit-1.json"), "utf-8");
  const parsed = JSON.parse(raw) as RollbackSnapshot;
  assert.equal(parsed.capturedAt, "2026-05-29T18:00:00.000Z");
  assert.equal(parsed.metadata.domain, "example.com");
});

test("loadSnapshot returns null when the snapshot does not exist", async () => {
  const manager = new AutoRollbackManager({ snapshotDir: await tempDir() });
  assert.equal(await manager.loadSnapshot("missing", "dns"), null);
});

test("loadSnapshot returns a complete snapshot when present", async () => {
  const snapshotDir = await tempDir();
  const manager = new AutoRollbackManager({ snapshotDir, now: fixedNow });
  await manager.captureSnapshot({
    auditId: "audit-2",
    kind: "smtp",
    beforeState: { state: "running" },
    metadata: { rampId: "ramp-1" }
  });

  const snapshot = await manager.loadSnapshot("audit-2", "smtp");

  assert.equal(snapshot?.kind, "smtp");
  assert.deepEqual(snapshot?.beforeState, { state: "running" });
});

test("waitForDnsPropagation returns propagated true when all records match", async () => {
  const manager = new AutoRollbackManager({ snapshotDir: await tempDir(), now: fixedNow });

  const result = await manager.waitForDnsPropagation({
    auditId: "audit-3",
    domain: "example.com",
    expectedRecords: [
      { type: "TXT", value: "v=spf1 include:_spf.example.com ~all" },
      { type: "MX", value: "mail.example.com" }
    ],
    digFn: async (_domain, type) =>
      type === "TXT"
        ? ["v=spf1 include:_spf.example.com ~all"]
        : ["10 mail.example.com."]
  });

  assert.equal(result.propagated, true);
  assert.equal(result.elapsedMs, 0);
});

test("waitForDnsPropagation returns false after timeout", async () => {
  let nowMs = Date.parse("2026-05-29T18:00:00.000Z");
  const manager = new AutoRollbackManager({
    snapshotDir: await tempDir(),
    now: () => new Date(nowMs),
    sleep: async (ms) => {
      nowMs += ms;
    },
    dnsPolicy: { propagationTimeoutMs: 100, pollIntervalMs: 25 }
  });

  const result = await manager.waitForDnsPropagation({
    auditId: "audit-4",
    domain: "example.com",
    expectedRecords: [{ type: "A", value: "203.0.113.10" }],
    digFn: async () => []
  });

  assert.equal(result.propagated, false);
  assert.equal(result.elapsedMs, 100);
});

test("shouldAutoPauseWarmup does not pause before the minimum sample", () => {
  const manager = new AutoRollbackManager({
    smtpPolicy: { maxBounceRate: 0.05, minSendsBeforeCheck: 10 }
  });

  const result = manager.shouldAutoPauseWarmup({ sent: 9, bounced: 9 });

  assert.deepEqual(result, { pause: false, reason: "insufficient_sample", bounceRate: 0 });
});

test("shouldAutoPauseWarmup pauses when bounce rate exceeds threshold", () => {
  const manager = new AutoRollbackManager({
    smtpPolicy: { maxBounceRate: 0.05, minSendsBeforeCheck: 10 }
  });

  const result = manager.shouldAutoPauseWarmup({ sent: 20, bounced: 2 });

  assert.equal(result.pause, true);
  assert.equal(result.bounceRate, 0.1);
  assert.match(result.reason, /bounce_rate_10\.0pct/);
});

test("shouldAutoPauseWarmup stays within threshold", () => {
  const manager = new AutoRollbackManager({
    smtpPolicy: { maxBounceRate: 0.05, minSendsBeforeCheck: 10 }
  });

  const result = manager.shouldAutoPauseWarmup({ sent: 100, bounced: 5 });

  assert.deepEqual(result, { pause: false, reason: "within_threshold", bounceRate: 0.05 });
});

test("applyRollback executes restoreFn with the loaded snapshot", async () => {
  const snapshotDir = await tempDir();
  const manager = new AutoRollbackManager({ snapshotDir, now: fixedNow });
  await manager.captureSnapshot({
    auditId: "audit-5",
    kind: "dns",
    beforeState: { records: [{ type: "A" }] },
    metadata: {}
  });
  let restored: RollbackSnapshot | null = null;

  const result = await manager.applyRollback({
    auditId: "audit-5",
    kind: "dns",
    reason: "propagation_timeout",
    restoreFn: async (snapshot) => {
      restored = snapshot;
    }
  });

  assert.equal(result.applied, true);
  assert.equal(restored?.auditId, "audit-5");
});

test("applyRollback returns applied false when snapshot is missing", async () => {
  const manager = new AutoRollbackManager({ snapshotDir: await tempDir(), now: fixedNow });

  const result = await manager.applyRollback({
    auditId: "missing",
    kind: "dns",
    reason: "propagation_timeout",
    restoreFn: async () => assert.fail("restoreFn should not run")
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "snapshot_not_found:propagation_timeout");
});

test("listSnapshots filters by kind and skips corrupted files", async () => {
  const snapshotDir = await tempDir();
  const manager = new AutoRollbackManager({ snapshotDir, now: fixedNow });
  await manager.captureSnapshot({ auditId: "dns-1", kind: "dns", beforeState: {}, metadata: {} });
  await manager.captureSnapshot({ auditId: "smtp-1", kind: "smtp", beforeState: {}, metadata: {} });
  await writeFile(join(snapshotDir, "dns-corrupted.json"), "{bad-json}", "utf-8");

  const dns = await manager.listSnapshots("dns");

  assert.equal(dns.length, 1);
  assert.equal(dns[0]?.auditId, "dns-1");
});

test("createAutoRollbackManagerFromEnv respects numeric env vars", () => {
  const manager = createAutoRollbackManagerFromEnv({
    ROLLBACK_SNAPSHOT_DIR: "/tmp/rollback-test",
    DNS_ROLLBACK_TIMEOUT_MS: "1234",
    DNS_ROLLBACK_POLL_MS: "56",
    SMTP_MAX_BOUNCE_RATE: "0.2",
    SMTP_MIN_SENDS_BEFORE_CHECK: "7",
    WEBDOCK_CLOUDINIT_TIMEOUT_MS: "890"
  });

  assert.deepEqual(manager.policies(), {
    dns: { propagationTimeoutMs: 1234, pollIntervalMs: 56 },
    smtp: { maxBounceRate: 0.2, minSendsBeforeCheck: 7 },
    webdock: { cloudInitTimeoutMs: 890 }
  });
});

test("shouldSnapshotWebdockCloudInit trips only after timeout", () => {
  const manager = new AutoRollbackManager({
    now: () => new Date("2026-05-29T18:16:00.000Z"),
    webdockPolicy: { cloudInitTimeoutMs: 15 * 60 * 1000 }
  });

  assert.equal(
    manager.shouldSnapshotWebdockCloudInit({
      startedAt: "2026-05-29T18:00:00.000Z"
    }).snapshot,
    true
  );
  assert.equal(
    manager.shouldSnapshotWebdockCloudInit({
      startedAt: "2026-05-29T18:00:00.000Z",
      completedAt: "2026-05-29T18:03:00.000Z"
    }).snapshot,
    false
  );
});

test("createSafeDigFn normalizes array and object DNS responses", async () => {
  const dig = createSafeDigFn({
    timeoutMs: 100,
    resolveFn: async (_domain, type) =>
      type === "MX" ? [{ priority: 10, exchange: "mail.example.com" }] : [["txt-one", "txt-two"]]
  });

  assert.deepEqual(await dig("example.com", "TXT"), ["txt-one", "txt-two"]);
  assert.deepEqual(await dig("example.com", "MX"), ["10 mail.example.com"]);
});

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "delivrix-auto-rollback-"));
}

function fixedNow(): Date {
  return new Date("2026-05-29T18:00:00.000Z");
}

void access;

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuditEvent } from "../../../packages/domain/src/index.ts";
import {
  AuditChainStore,
  backupAuditChainFile,
  verifyAuditChainEvents,
  verifyAuditChainFile
} from "./audit-chain.ts";
import { computeAuditHash, GENESIS_PREV_HASH } from "./audit/hash-chain.ts";

test("verify returns ok for a missing or empty audit chain", async () => {
  const missingPath = join(await tempDir(), "missing.jsonl");
  assert.deepEqual(await verifyAuditChainFile(missingPath), {
    ok: true,
    totalEvents: 0,
    emptyChain: true,
    lastHash: GENESIS_PREV_HASH,
    sourcePath: missingPath
  });

  const emptyPath = await chainPath();
  await writeFile(emptyPath, "", "utf-8");
  assert.deepEqual(await verifyAuditChainFile(emptyPath), {
    ok: true,
    totalEvents: 0,
    emptyChain: true,
    lastHash: GENESIS_PREV_HASH,
    sourcePath: emptyPath
  });
});

test("verify returns ok for an intact in-memory chain of five events", () => {
  const events = buildChain(5);

  const result = verifyAuditChainEvents(events, ".audit/audit-events.jsonl");

  assert.equal(result.ok, true);
  assert.equal(result.totalEvents, 5);
  assert.equal(result.emptyChain, false);
  assert.equal(result.lastHash, events[4]?.hash);
});

test("verify reads and validates JSONL audit files", async () => {
  const filePath = await writeChainFile(buildChain(5));

  const result = await verifyAuditChainFile(filePath);

  assert.equal(result.ok, true);
  assert.equal(result.totalEvents, 5);
  assert.equal(result.emptyChain, false);
});

test("verify reads and validates legacy JSON array audit files", async () => {
  const filePath = await chainPath();
  await writeFile(filePath, JSON.stringify(buildChain(3)), "utf-8");

  const result = await verifyAuditChainFile(filePath);

  assert.equal(result.ok, true);
  assert.equal(result.totalEvents, 3);
  assert.equal(result.emptyChain, false);
});

test("verify detects corruption in the last event body", () => {
  const events = buildChain(5);
  events[4]!.action = "oc.audit.corrupted";

  const result = verifyAuditChainEvents(events, ".audit/audit-events.jsonl");

  assert.equal(result.ok, false);
  assert.equal(result.brokenAt?.seq, 5);
  assert.equal(result.brokenAt?.reason, "hash_mismatch");
});

test("verify detects corruption in an intermediate event body", () => {
  const events = buildChain(5);
  events[2]!.action = "oc.audit.corrupted";

  const result = verifyAuditChainEvents(events, ".audit/audit-events.jsonl");

  assert.equal(result.ok, false);
  assert.equal(result.brokenAt?.seq, 3);
  assert.equal(result.brokenAt?.reason, "hash_mismatch");
});

test("verify detects a broken prevHash link", () => {
  const events = buildChain(5);
  events[3]!.prevHash = "bad-prev-hash";

  const result = verifyAuditChainEvents(events, ".audit/audit-events.jsonl");

  assert.equal(result.ok, false);
  assert.equal(result.brokenAt?.seq, 4);
  assert.equal(result.brokenAt?.reason, "prev_hash_mismatch");
});

test("verify detects mutation of nested metadata.hash fields", () => {
  const events = buildChain(3, { includeNestedHash: true });
  events[1]!.metadata.hash = "mutated-evidence-checksum";

  const result = verifyAuditChainEvents(events, ".audit/audit-events.jsonl");

  assert.equal(result.ok, false);
  assert.equal(result.brokenAt?.seq, 2);
  assert.equal(result.brokenAt?.reason, "hash_mismatch");
});

test("verify returns structured failure for malformed JSONL", async () => {
  const filePath = await chainPath();
  const [first] = buildChain(1);
  await writeFile(filePath, `${JSON.stringify(first)}\n{bad-json}\n`, "utf-8");

  const result = await verifyAuditChainFile(filePath);

  assert.equal(result.ok, false);
  assert.equal(result.totalEvents, 2);
  assert.equal(result.brokenAt?.seq, 2);
  assert.equal(result.brokenAt?.reason, "malformed_json");
});

test("backupAuditChainFile creates a verifiable backup copy", async () => {
  const filePath = await writeChainFile(buildChain(2));
  const backupDir = await tempDir();

  const result = await backupAuditChainFile({ sourcePath: filePath, backupDir, nowMs: 123 });

  await access(result.backupPath);
  assert.equal(await readFile(result.backupPath, "utf-8"), await readFile(filePath, "utf-8"));
  assert.equal(result.backupExists, true);
});

test("AuditChainStore verifies the configured source path and creates backups", async () => {
  const filePath = await writeChainFile(buildChain(2));
  const backupDir = await tempDir();
  const store = new AuditChainStore({ filePath, backupDir });

  const [verify, backup] = await Promise.all([store.verify(), store.backup()]);

  assert.equal(verify.ok, true);
  assert.equal(verify.totalEvents, 2);
  await access(backup.backupPath);
});

test("backfill compatibility validates existing chained log and returns backup path", async () => {
  const filePath = await writeChainFile(buildChain(10));
  const backupDir = await tempDir();
  const store = new AuditChainStore({ backupDir });

  const result = await store.backfillFromLocalFileAuditLog(filePath);

  assert.equal(result.backfilled, 10);
  assert.equal(result.alreadyChained, true);
  await access(result.backupPath);
});

function buildChain(
  count: number,
  options: { includeNestedHash?: boolean } = {}
): AuditEvent[] {
  const events: AuditEvent[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let index = 0; index < count; index += 1) {
    const event = buildEvent(index + 1, prevHash, options);
    event.hash = computeAuditHash(event as unknown as Record<string, unknown>, prevHash);
    events.push(event);
    prevHash = event.hash;
  }
  return events;
}

function buildEvent(
  seq: number,
  prevHash: string,
  options: { includeNestedHash?: boolean } = {}
): AuditEvent {
  return {
    id: `018f7b54-7d4d-7cc2-9c90-df7486c5a${String(seq).padStart(3, "0")}`,
    occurredAt: `2026-05-29T17:00:${String(seq).padStart(2, "0")}.000Z`,
    actorType: "system",
    actorId: "audit-chain-test",
    action: "oc.audit.chain_verified",
    targetType: "audit_log",
    targetId: "audit-events.jsonl",
    riskLevel: "low",
    metadata: {
      seq,
      nested: { z: "last", a: "first" },
      ...(options.includeNestedHash ? { hash: `evidence-checksum-${seq}` } : {})
    },
    decision: "n/a",
    rejectReason: null,
    humanApproved: false,
    approverIds: [],
    killSwitchState: "armed",
    rollbackToken: null,
    schemaVersion: "2026-05-18.v1",
    promptVersion: null,
    modelVersion: null,
    evidenceRefs: [],
    prevHash,
    hash: ""
  };
}

async function writeChainFile(events: AuditEvent[]): Promise<string> {
  const filePath = await chainPath();
  await writeFile(filePath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf-8");
  return filePath;
}

async function chainPath(): Promise<string> {
  return join(await tempDir(), "audit-events.jsonl");
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "delivrix-audit-chain-"));
}

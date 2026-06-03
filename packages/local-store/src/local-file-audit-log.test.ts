import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEventInput } from "../../domain/src/index.ts";
import { verifyAuditChainFile } from "../../../apps/gateway-api/src/audit-chain.ts";
import { LocalFileAuditLog } from "./local-file-audit-log.ts";

test("LocalFileAuditLog rereads disk hash across sequential instances", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-audit-chain-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const filePath = join(dir, "audit-events.jsonl");
  const first = new LocalFileAuditLog(filePath);
  const second = new LocalFileAuditLog(filePath);

  await first.append(event("a1"));
  await second.append(event("b1"));
  await first.append(event("a2"));

  const verify = await verifyAuditChainFile(filePath);
  assert.equal(verify.ok, true);
  assert.equal((await first.list()).length, 3);
});

test("LocalFileAuditLog getLastHashSync reads external appends from disk", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-audit-last-hash-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const filePath = join(dir, "audit-events.jsonl");
  const first = new LocalFileAuditLog(filePath);
  const second = new LocalFileAuditLog(filePath);

  const firstEvent = await first.append(event("a1"));
  assert.equal(first.getLastHashSync(), firstEvent.hash);

  const secondEvent = await second.append(event("b1"));
  assert.equal(first.getLastHashSync(), secondEvent.hash);
});

function event(targetId: string): AuditEventInput {
  return {
    actorType: "system",
    actorId: "local-file-audit-log-test",
    action: "oc.audit.test",
    targetType: "test",
    targetId,
    riskLevel: "low",
    decision: "allow"
  };
}

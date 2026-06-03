import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { LocalFileRunbookExecutionStore } from "./local-file-runbook-execution-store.ts";

test("LocalFileRunbookExecutionStore persists proposal reservations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-runbook-executions-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const filePath = join(dir, "runbook-executions.json");
  const first = new LocalFileRunbookExecutionStore(filePath);

  assert.equal(await first.reserve({
    proposalId: "proposal-1",
    runbookId: "pause-ip",
    occurredAt: "2026-06-02T12:00:00.000Z"
  }), "reserved");

  const second = new LocalFileRunbookExecutionStore(filePath);
  assert.equal(await second.reserve({
    proposalId: "proposal-1",
    runbookId: "pause-ip",
    occurredAt: "2026-06-02T12:01:00.000Z"
  }), "already_reserved");
  assert.deepEqual((await second.list()).map((record) => record.proposalId), ["proposal-1"]);
});

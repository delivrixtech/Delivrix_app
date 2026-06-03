import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { SendRequest } from "../../domain/src/index.ts";
import { LocalFileSendQueue } from "./local-file-send-queue.ts";

test("LocalFileSendQueue preserves concurrent adds", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-send-queue-add-");
  t.after(cleanup);
  const queue = new LocalFileSendQueue(filePath);

  await Promise.all(Array.from({ length: 20 }, (_, index) => queue.add(request(index))));

  const jobs = await queue.list();
  assert.equal(jobs.length, 20);
  assert.equal(new Set(jobs.map((job) => job.id)).size, 20);
});

test("LocalFileSendQueue claimNext claims a queued job once", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-send-queue-claim-");
  t.after(cleanup);
  const queue = new LocalFileSendQueue(filePath);
  await queue.add(request(1));

  const claims = await Promise.all([
    queue.claimNext(),
    queue.claimNext()
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await queue.list()).filter((job) => job.status === "processing").length, 1);
});

async function tempFile(prefix: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    filePath: join(dir, "queue.json"),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

function request(index: number): SendRequest {
  return {
    campaignId: `campaign-${index}`,
    recipient: {
      email: `recipient-${index}@example.com`,
      consentProofId: `proof-${index}`
    },
    sender: {
      address: "ops@sender.example",
      domain: "sender.example"
    },
    subject: "Operational update",
    bodyText: "Authorized operational update.",
    classification: "operational"
  };
}

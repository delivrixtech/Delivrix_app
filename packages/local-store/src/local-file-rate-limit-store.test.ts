import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { RateLimitRule } from "../../domain/src/index.ts";
import { LocalFileRateLimitStore } from "./local-file-rate-limit-store.ts";

const rule: RateLimitRule = {
  scope: "campaign",
  id: "campaign-1",
  limit: 100,
  window: "daily"
};

test("LocalFileRateLimitStore preserves concurrent increments", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-rate-increments-");
  t.after(cleanup);
  const store = new LocalFileRateLimitStore(filePath);

  await Promise.all(Array.from({ length: 20 }, () => store.increment(rule, "2026-06-02", 1)));

  assert.equal((await store.get(rule, "2026-06-02")).count, 20);
});

test("LocalFileRateLimitStore consumes atomically at the limit boundary", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-rate-consume-");
  t.after(cleanup);
  const store = new LocalFileRateLimitStore(filePath);
  const limitedRule = { ...rule, limit: 1 };

  const decisions = await Promise.all([
    store.tryConsume([limitedRule], "2026-06-02", 1),
    store.tryConsume([limitedRule], "2026-06-02", 1)
  ]);

  assert.equal(decisions.filter((decision) => decision.allowed).length, 1);
  assert.equal((await store.get(limitedRule, "2026-06-02")).count, 1);
});

async function tempFile(prefix: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    filePath: join(dir, "store.json"),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

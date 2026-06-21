import assert from "node:assert/strict";
import test from "node:test";
import { runWithTransientSshRetry } from "./ssh-retry.ts";

test("runWithTransientSshRetry retries transient SSH failures with shared 30s/60s policy", async () => {
  const sleeps: number[] = [];
  let attempts = 0;

  const result = await runWithTransientSshRetry({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    operation: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(attempts === 1 ? "SSH command timed out." : "SSH command failed with exit 255.");
      }
      return "ok";
    }
  });

  assert.deepEqual(result, { result: "ok", attempts: 3, settleMs: 90_000 });
  assert.deepEqual(sleeps, [30_000, 60_000]);
});

test("runWithTransientSshRetry does not retry non-transient failures", async () => {
  const sleeps: number[] = [];
  let attempts = 0;

  await assert.rejects(
    () => runWithTransientSshRetry({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      operation: async () => {
        attempts += 1;
        throw new Error("permission denied by remote policy");
      }
    }),
    /SSH connect failed after 1 attempt\(s\): permission denied by remote policy/
  );

  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

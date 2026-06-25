import assert from "node:assert/strict";
import test from "node:test";
import { startInfrastructureAccountHealthPoller } from "./infrastructure-health-poller.ts";

test("Infrastructure account health poller runs startup and interval without keeping the event loop alive", async () => {
  const calls: string[] = [];
  let intervalHandler: (() => void) | null = null;
  let unrefCalled = false;

  startInfrastructureAccountHealthPoller({
    intervalMs: 1234,
    runPoll: async (trigger) => {
      calls.push(trigger);
    },
    logger: loggerStub(),
    setIntervalFn: (handler, intervalMs) => {
      assert.equal(intervalMs, 1234);
      intervalHandler = handler;
      return {
        unref: () => {
          unrefCalled = true;
        }
      };
    }
  });
  await flush();
  assert.deepEqual(calls, ["startup"]);
  assert.equal(unrefCalled, true);

  requireCallback(intervalHandler)();
  await flush();
  assert.deepEqual(calls, ["startup", "interval"]);
});

test("Infrastructure account health poller skips overlapping interval polls", async () => {
  const calls: string[] = [];
  const warnings: string[] = [];
  let intervalHandler: (() => void) | null = null;
  let releaseStartup: (() => void) | null = null;

  startInfrastructureAccountHealthPoller({
    intervalMs: 1000,
    runPoll: async (trigger) => {
      calls.push(trigger);
      if (trigger === "startup") {
        await new Promise<void>((resolve) => {
          releaseStartup = resolve;
        });
      }
    },
    logger: loggerStub({ warnings }),
    setIntervalFn: (handler) => {
      intervalHandler = handler;
      return { unref: () => undefined };
    }
  });
  await flush();
  requireCallback(intervalHandler)();
  await flush();
  assert.deepEqual(calls, ["startup"]);
  assert.deepEqual(warnings, ["infrastructure.account_health_poll_skipped"]);

  requireCallback(releaseStartup)();
  await flush();
  requireCallback(intervalHandler)();
  await flush();
  assert.deepEqual(calls, ["startup", "interval"]);
});

function loggerStub(options: { warnings?: string[] } = {}) {
  return {
    logPath: "",
    info: async () => undefined,
    warn: async (event: string) => {
      options.warnings?.push(event);
    },
    error: async () => undefined
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function requireCallback(callback: (() => void) | null): () => void {
  if (callback === null) {
    throw new Error("Expected poller callback to be registered.");
  }
  return callback;
}

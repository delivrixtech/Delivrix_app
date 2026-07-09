import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForServerRunning,
  type ServerRunningAdapter,
  type ServerRunningAdapterRegistry
} from "./server-running-wait.ts";

test("waitForServerRunning times out with real sleep and a short maxWaitMs", async () => {
  let calls = 0;
  const adapter = provisioningAdapter(() => {
    calls += 1;
  });

  const started = Date.now();
  const result = await waitForServerRunning({
    params: { serverSlug: "server10", maxWaitMs: 25 },
    adapters: registry(adapter),
    env: { WEBDOCK_PROVISION_POLL_INTERVAL_MS: "10" }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout_waiting_for_server_ip");
  assert.equal(result.reason, "max_wait_elapsed");
  assert.ok(calls >= 2);
  assert.ok(Date.now() - started >= 20);
});

test("waitForServerRunning exits by max iterations even if the clock is frozen", async () => {
  let calls = 0;
  const adapter = provisioningAdapter(() => {
    calls += 1;
  });

  const result = await waitForServerRunning({
    params: { serverSlug: "server10", maxWaitMs: 5 },
    adapters: registry(adapter),
    env: { WEBDOCK_PROVISION_POLL_INTERVAL_MS: "1" },
    sleep: async () => {},
    now: () => 1_000
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout_waiting_for_server_ip");
  assert.equal(result.reason, "max_iterations_exceeded");
  assert.equal(result.pollCount, 105);
  assert.equal(calls, 105);
});

function provisioningAdapter(onCall: () => void): ServerRunningAdapter {
  return {
    async getServer(slug) {
      onCall();
      return {
        slug,
        ipv4: "",
        status: "provisioning"
      };
    }
  } as ServerRunningAdapter;
}

function registry(adapter: ServerRunningAdapter): ServerRunningAdapterRegistry {
  return {
    webdockOpsAdapter: adapter,
    webdockCreateAdapters: new Map(),
    vpsProviderAdapters: new Map()
  };
}

test("waitForServerRunning con serverAccountId desconocido falla limpio sin consultar ops", async () => {
  let opsCalls = 0;
  const opsAdapter = provisioningAdapter(() => {
    opsCalls += 1;
  });

  await assert.rejects(
    waitForServerRunning({
      params: { serverSlug: "server10", maxWaitMs: 5 },
      adapters: registry(opsAdapter),
      serverAccountId: "cuenta-typo",
      env: { WEBDOCK_PROVISION_POLL_INTERVAL_MS: "1" },
      sleep: async () => {},
      now: () => 1_000
    }),
    /unknown_server_account:cuenta-typo/
  );
  assert.equal(opsCalls, 0, "el fallback silencioso a ops esperaria el server en la cuenta equivocada");
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createProviderFetch,
  ProviderCircuitOpenError,
  ProviderFetchTimeoutError
} from "./provider-fetch.ts";

function jsonResponse(status: number): Response {
  return new Response("{}", { status });
}

function testClock(startMs = 1_000_000): { now: () => Date; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    }
  };
}

test("providerFetch retries idempotent calls on retryable status and succeeds", async () => {
  const statuses = [503, 502, 200];
  let calls = 0;
  const provider = createProviderFetch({
    fetchImpl: async () => jsonResponse(statuses[calls++]),
    sleep: async () => undefined,
    random: () => 0,
    maxRetries: 2
  });

  const response = await provider.fetch("https://api.example.com/things", { method: "GET" }, { idempotent: true });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test("providerFetch never retries non-idempotent calls", async () => {
  let calls = 0;
  const provider = createProviderFetch({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(503);
    },
    sleep: async () => undefined,
    maxRetries: 5
  });

  const response = await provider.fetch("https://api.example.com/servers", { method: "POST" });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});

test("providerFetch aborts with timeout error", async () => {
  const provider = createProviderFetch({
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      }),
    sleep: async () => undefined
  });

  await assert.rejects(
    provider.fetch("https://api.example.com/slow?apikey=secret", { method: "GET" }, { timeoutMs: 5 }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderFetchTimeoutError);
      assert.ok(!error.message.includes("secret"));
      return true;
    }
  );
});

test("circuit breaker opens after consecutive failures and blocks further calls", async () => {
  const clock = testClock();
  let calls = 0;
  const provider = createProviderFetch({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("connection refused");
    },
    sleep: async () => undefined,
    now: clock.now,
    breakerFailureThreshold: 3,
    breakerOpenMs: 60_000
  });

  const options = { breakerKey: "contabo:contabo-1" };
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(provider.fetch("https://api.example.com/x", { method: "POST" }, options));
  }
  assert.equal(provider.breakerState("contabo:contabo-1"), "open");
  await assert.rejects(
    provider.fetch("https://api.example.com/x", { method: "POST" }, options),
    ProviderCircuitOpenError
  );
  assert.equal(calls, 3);
});

test("circuit breaker half-opens after the open window and closes on success", async () => {
  const clock = testClock();
  let shouldFail = true;
  const provider = createProviderFetch({
    fetchImpl: async () => {
      if (shouldFail) throw new Error("boom");
      return jsonResponse(200);
    },
    sleep: async () => undefined,
    now: clock.now,
    breakerFailureThreshold: 2,
    breakerOpenMs: 60_000
  });

  const options = { breakerKey: "namecheap:namecheap-1" };
  await assert.rejects(provider.fetch("https://api.example.com/x", { method: "POST" }, options));
  await assert.rejects(provider.fetch("https://api.example.com/x", { method: "POST" }, options));
  assert.equal(provider.breakerState("namecheap:namecheap-1"), "open");

  clock.advance(61_000);
  assert.equal(provider.breakerState("namecheap:namecheap-1"), "half-open");

  shouldFail = false;
  const response = await provider.fetch("https://api.example.com/x", { method: "POST" }, options);
  assert.equal(response.status, 200);
  assert.equal(provider.breakerState("namecheap:namecheap-1"), "closed");
});

test("breaker keys are isolated per account", async () => {
  const clock = testClock();
  const provider = createProviderFetch({
    fetchImpl: async () => {
      throw new Error("down");
    },
    sleep: async () => undefined,
    now: clock.now,
    breakerFailureThreshold: 1
  });

  await assert.rejects(provider.fetch("https://api.example.com/x", { method: "POST" }, { breakerKey: "contabo:contabo-1" }));
  assert.equal(provider.breakerState("contabo:contabo-1"), "open");
  assert.equal(provider.breakerState("contabo:contabo-2"), "closed");
});

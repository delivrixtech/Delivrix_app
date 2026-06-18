import assert from "node:assert/strict";
import test from "node:test";

import { MxtoolboxAdapter, createMxtoolboxAdapterFromEnv } from "./mxtoolbox-adapter.ts";

const rawClean = {
  UID: "uid-1",
  Command: "blacklist",
  CommandArgument: "8.8.8.8",
  TimeRecorded: "2026-06-18T10:00:00Z",
  Failed: [],
  Warnings: [],
  Passed: [
    { ID: 1, Name: "Spamhaus", Info: "OK", Url: "https://example.test" },
    { ID: 2, Name: "Barracuda", Info: "OK", Url: "https://example.test" }
  ],
  Timeouts: []
};

test("lookup parses MXToolbox response and returns clean summary without raw body", async () => {
  const adapter = new MxtoolboxAdapter({
    apiKey: "test-key",
    now: () => new Date("2026-06-18T10:01:00Z"),
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://api.mxtoolbox.com/api/v1/Lookup/blacklist/?argument=8.8.8.8");
      assert.equal((init?.headers as Record<string, string>).Authorization, "test-key");
      return jsonResponse(200, rawClean);
    }
  });

  const result = await adapter.lookup({ target: "8.8.8.8", command: "blacklist" });

  assert.equal(result.cacheHit, false);
  assert.equal(result.source.kind, "live");
  assert.equal(result.source.responseOk, true);
  assert.equal(result.summary.status, "clean");
  assert.equal(result.summary.passedCount, 2);
  assert.equal(result.summary.timeoutCount, 0);
  assert.equal(result.summary.rawRef.length, 64);
  assert.equal("raw" in result.summary, false);
});

test("lookup status follows failed, warning, timeout precedence", async () => {
  const statuses: Array<[unknown, string]> = [
    [{ ...rawClean, Failed: [{ ID: 10, Name: "Listed", Info: "", Url: "" }] }, "listed"],
    [{ ...rawClean, Warnings: [{ ID: 11, Name: "Slow SMTP", Info: "", Url: "" }] }, "warning"],
    [{ ...rawClean, Timeouts: [{ ID: 12, Name: "Timeout", Info: "", Url: "" }] }, "error"]
  ];

  for (const [body, expected] of statuses) {
    const adapter = new MxtoolboxAdapter({
      apiKey: "test-key",
      cacheTtlMs: 1,
      fetchImpl: async () => jsonResponse(200, body)
    });
    const result = await adapter.lookup({ target: "mail.example.com", command: "smtp" });
    assert.equal(result.summary.status, expected);
  }
});

test("lookup caches per target and command", async () => {
  let calls = 0;
  const adapter = new MxtoolboxAdapter({
    apiKey: "test-key",
    cacheTtlMs: 60_000,
    now: () => new Date("2026-06-18T10:01:00Z"),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, rawClean);
    }
  });

  const first = await adapter.lookup({ target: "8.8.8.8", command: "blacklist" });
  const second = await adapter.lookup({ target: "8.8.8.8", command: "blacklist" });

  assert.equal(calls, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
});

test("lookup retries 5xx twice and 429 once", async () => {
  const statuses = [500, 502, 200, 429, 200];
  const seen: string[] = [];
  const adapter = new MxtoolboxAdapter({
    apiKey: "test-key",
    cacheTtlMs: 1,
    retryBaseDelayMs: 1,
    retryJitterMs: 0,
    sleep: async () => undefined,
    fetchImpl: async (url) => {
      seen.push(String(url));
      const status = statuses.shift() ?? 200;
      return jsonResponse(status, status === 200 ? rawClean : { error: status });
    }
  });

  await adapter.lookup({ target: "8.8.8.8", command: "blacklist" });
  await adapter.lookup({ target: "1.1.1.1", command: "blacklist" });

  assert.equal(seen.length, 5);
});

test("lookup converts network failures into error summaries", async () => {
  const adapter = new MxtoolboxAdapter({
    apiKey: "test-key",
    fetchImpl: async () => {
      throw new Error("network_down");
    },
    now: () => new Date("2026-06-18T10:01:00Z")
  });

  const result = await adapter.lookup({ target: "8.8.8.8", command: "blacklist" });

  assert.equal(result.summary.status, "error");
  assert.equal(result.source.responseOk, false);
  assert.equal(result.source.errorMessage, "network_down");
});

test("factory returns null without API key", () => {
  assert.equal(createMxtoolboxAdapterFromEnv({}), null);
  assert.ok(createMxtoolboxAdapterFromEnv({ MXTOOLBOX_API_KEY: "key" }));
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import { handleWarmupTrends, type WarmupTrendsDeps } from "./warmup-trends.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";
import type { PgClient } from "../../../warmup-engine/src/store/pg-stores.ts";

const readToken = "warmup-read-token";
const fixedNow = new Date("2026-07-09T18:00:00.000Z");

function request(headers: Record<string, string>): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, {
    method: "GET",
    url: "/v1/warmup/trends",
    headers
  }) as IncomingMessage;
}

function captureResponse() {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}

async function route(
  overrides: Partial<WarmupTrendsDeps> & { headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; body: any }> {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  const { headers, ...deps } = overrides;
  await handleWarmupTrends(
    request(headers ?? { "x-delivrix-token": readToken }),
    response as unknown as ServerResponse,
    {
      pgClient: null,
      readBoundaryToken: readToken,
      now: () => fixedNow,
      ...deps
    }
  );
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

// Fake PgClient that routes each query by matching a substring of the SQL text. Read-only:
// listRecentRollups -> warmup_placement_rollups, aggregateByProvider -> warmup_placement_results,
// countRecent -> warmup_signals.
function fakePgClient(handlers: {
  rollups?: () => unknown[];
  providers?: () => unknown[];
  signals?: () => unknown[];
  throwOn?: string;
}): PgClient {
  return {
    async query(text: string): Promise<{ rows: any[]; rowCount: number | null }> {
      if (handlers.throwOn && text.includes(handlers.throwOn)) {
        throw new Error("relation does not exist");
      }
      if (text.includes("warmup_placement_rollups")) {
        const rows = handlers.rollups ? handlers.rollups() : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("warmup_placement_results")) {
        const rows = handlers.providers ? handlers.providers() : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("warmup_signals")) {
        const rows = handlers.signals ? handlers.signals() : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

test("rejects a request without a token", async () => {
  const res = await route({ headers: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "read_boundary_token_invalid");
});

test("rejects an invalid token", async () => {
  const res = await route({ headers: { "x-delivrix-token": "nope" } });
  assert.equal(res.statusCode, 401);
});

test("returns trends from a live pgClient", async () => {
  const pgClient = fakePgClient({
    rollups: () => [
      { window_end: new Date("2026-07-09T00:00:00Z"), inbox_wilson_lb: "0.72", inbox_ewma: "0.75", spam_rate: "0.1", samples: 30 },
      { window_end: new Date("2026-07-08T00:00:00Z"), inbox_wilson_lb: "0.60", inbox_ewma: "0.62", spam_rate: "0.2", samples: 20 }
    ],
    providers: () => [{ provider: "gmail", inbox: "8", tabs: "2", spam: "1", missing: "1", total: "10" }],
    signals: () => [{ bounces: "2", complaints: "1" }]
  });
  const res = await route({ pgClient });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.generatedAt, fixedNow.toISOString());
  // invertida a orden cronológico: más viejo primero
  assert.equal(res.body.placementSeries.length, 2);
  assert.equal(res.body.placementSeries[0].windowEnd, "2026-07-08T00:00:00.000Z");
  assert.equal(res.body.perProvider[0].provider, "gmail");
  assert.equal(res.body.perProvider[0].inboxRate, 0.8);
  assert.deepEqual(res.body.signals, { bounces: 2, complaints: 1 });
  assert.ok(res.body.ramp.length > 0);
});

test("returns degraded trends when pgClient is null", async () => {
  const res = await route({ pgClient: null });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.note, "postgres_unavailable");
  assert.deepEqual(res.body.placementSeries, []);
  assert.deepEqual(res.body.perProvider, []);
  assert.deepEqual(res.body.signals, { bounces: 0, complaints: 0 });
});

test("returns degraded trends when a query throws", async () => {
  const warnings: unknown[] = [];
  const pgClient = fakePgClient({ throwOn: "warmup_placement_rollups" });
  const res = await route({
    pgClient,
    logger: { warn: async (...args: unknown[]) => { warnings.push(args); } } as any
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.note, "warmup_tables_unavailable");
  assert.deepEqual(res.body.placementSeries, []);
  assert.equal(warnings.length, 1);
});

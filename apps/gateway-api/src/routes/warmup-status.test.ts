import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import { handleWarmupStatus, type WarmupStatusDeps } from "./warmup-status.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";
import type { PgClient } from "../../../warmup-engine/src/store/pg-stores.ts";

const readToken = "warmup-read-token";
const fixedNow = new Date("2026-07-09T18:00:00.000Z");

function request(headers: Record<string, string>): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, {
    method: "GET",
    url: "/v1/warmup/status",
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
  overrides: Partial<WarmupStatusDeps> & { headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; body: any }> {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  const { headers, ...deps } = overrides;
  await handleWarmupStatus(
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

// A fake PgClient that routes each query by matching a substring of the SQL text. Read-only:
// listActiveNodes -> warmup_nodes, listQueued -> warmup_sends.
function fakePgClient(handlers: {
  nodes?: () => unknown[];
  sends?: () => unknown[];
  throwOn?: string;
}): PgClient {
  return {
    async query(text: string): Promise<{ rows: any[]; rowCount: number | null }> {
      if (handlers.throwOn && text.includes(handlers.throwOn)) {
        throw new Error("relation does not exist");
      }
      if (text.includes("warmup_nodes")) {
        const rows = handlers.nodes ? handlers.nodes() : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes("warmup_sends")) {
        const rows = handlers.sends ? handlers.sends() : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

function nodeRow(id: string, state: string) {
  return {
    id,
    mailbox: `${id}@warm.example`,
    domain: "warm.example",
    infra_type: "vps",
    state,
    auth_ready: true,
    contract_expires_at: null,
    sending_ip: null,
    helo_fqdn: null,
    daily_limit: 10,
    increase_by_day: 2,
    day_index: 3,
    weekdays_only: false,
    health_score: null,
    placement_score: 0.9
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

test("returns the snapshot from a live pgClient", async () => {
  const pgClient = fakePgClient({
    nodes: () => [nodeRow("n1", "warm"), nodeRow("n2", "fresh")],
    sends: () => [{ id: "s1", node_id: "n1", slot_key: "k1", to_address: "x@y.z", status: "queued", attempts: 0 }]
  });
  const res = await route({ pgClient });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.generatedAt, fixedNow.toISOString());
  assert.equal(res.body.totals.activeNodes, 2);
  assert.equal(res.body.totals.queuedSends, 1);
  assert.deepEqual(res.body.byState, { warm: 1, fresh: 1 });
  assert.equal(res.body.nodes.length, 2);
  assert.equal(res.body.nodes[0].id, "n1");
});

test("reflects the enabled flag from env", async () => {
  const pgClient = fakePgClient({ nodes: () => [], sends: () => [] });
  const res = await route({ pgClient, env: { WARMUP_ENGINE_ENABLE: "true" } as NodeJS.ProcessEnv });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, true);
});

test("returns a degraded snapshot when pgClient is null", async () => {
  const res = await route({ pgClient: null });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.note, "postgres_unavailable");
  assert.equal(res.body.totals.activeNodes, 0);
  assert.deepEqual(res.body.nodes, []);
});

test("returns a degraded snapshot when the query throws", async () => {
  const warnings: unknown[] = [];
  const pgClient = fakePgClient({ throwOn: "warmup_nodes" });
  const res = await route({
    pgClient,
    logger: { warn: async (...args: unknown[]) => { warnings.push(args); } } as any
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, false);
  assert.equal(res.body.note, "warmup_tables_unavailable");
  assert.equal(res.body.totals.activeNodes, 0);
  assert.equal(warnings.length, 1);
});

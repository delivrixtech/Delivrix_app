import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { Readable } from "node:stream";
import { handleWarmupActivity, type WarmupActivityDeps } from "./warmup-activity.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";
import type { PgClient } from "../../../warmup-engine/src/store/pg-stores.ts";

const readToken = "warmup-read-token";
const fixedNow = new Date("2026-07-20T18:00:00.000Z");

function request(headers: Record<string, string>): IncomingMessage {
  const stream = Readable.from([]);
  return Object.assign(stream, { method: "GET", url: "/v1/warmup/activity", headers }) as IncomingMessage;
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
  overrides: Partial<WarmupActivityDeps> & { headers?: Record<string, string> } = {}
): Promise<{ statusCode: number; body: any }> {
  resetSensitiveReadAuthBucketsForTests();
  const response = captureResponse();
  const { headers, ...deps } = overrides;
  await handleWarmupActivity(
    request(headers ?? { "x-delivrix-token": readToken }),
    response as unknown as ServerResponse,
    { pgClient: null, readBoundaryToken: readToken, now: () => fixedNow, ...deps }
  );
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

function activityRow(kind: string, extra: Record<string, unknown> = {}) {
  return {
    id: `id-${kind}`,
    occurred_at: fixedNow,
    cycle_id: "cyc-1",
    node_domain: "infranationalcorp.com",
    seed_inbox: "seed@example.com",
    kind,
    placement: null,
    subject: "Café la semana que viene?",
    detail: {},
    test_id: "warmup-cycle-1",
    ...extra
  };
}

function fakePgClient(rows: unknown[], opts: { throw?: boolean } = {}): PgClient {
  return {
    async query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> {
      if (opts.throw) throw new Error("relation \"warmup_activity\" does not exist");
      assert.ok(text.includes("warmup_activity"), "queries the activity table");
      assert.ok(Array.isArray(params) && typeof params[0] === "number", "passes a numeric limit param");
      return { rows: rows as any[], rowCount: rows.length };
    }
  };
}

test("rechaza sin token", async () => {
  const res = await route({ headers: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "read_boundary_token_invalid");
});

test("feed vacío cuando pgClient es null (degradado, 200)", async () => {
  const res = await route({ pgClient: null });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.events, []);
  assert.equal(res.body.note, "postgres_unavailable");
});

test("mapea las filas al shape del feed", async () => {
  const pgClient = fakePgClient([
    activityRow("replied"),
    activityRow("engaged", { placement: "INBOX" }),
    activityRow("measured", { placement: "SPAM" }),
    activityRow("sent")
  ]);
  const res = await route({ pgClient });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.generatedAt, fixedNow.toISOString());
  assert.equal(res.body.events.length, 4);
  const first = res.body.events[0];
  assert.equal(first.kind, "replied");
  assert.equal(first.cycleId, "cyc-1");
  assert.equal(first.nodeDomain, "infranationalcorp.com");
  assert.equal(first.seedInbox, "seed@example.com");
  assert.equal(first.subject, "Café la semana que viene?");
  assert.equal(first.testId, "warmup-cycle-1");
  assert.equal(res.body.events[1].placement, "INBOX");
});

test("kind desconocido cae a 'error' (defensivo)", async () => {
  const pgClient = fakePgClient([activityRow("weird")]);
  const res = await route({ pgClient });
  assert.equal(res.body.events[0].kind, "error");
});

test("clampa el límite al tope duro (200)", async () => {
  let seenLimit = 0;
  const pgClient: PgClient = {
    async query(_text: string, params?: unknown[]) {
      seenLimit = (params as number[])[0];
      return { rows: [], rowCount: 0 };
    }
  };
  await route({ pgClient, limit: 99999 });
  assert.equal(seenLimit, 200);
});

test("feed vacío (no 500) cuando la query rompe", async () => {
  const warnings: unknown[] = [];
  const pgClient = fakePgClient([], { throw: true });
  const res = await route({
    pgClient,
    logger: { warn: async (...args: unknown[]) => { warnings.push(args); } } as any
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.events, []);
  assert.equal(res.body.note, "warmup_activity_unavailable");
  assert.equal(warnings.length, 1);
});

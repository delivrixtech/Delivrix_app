import assert from "node:assert/strict";
import test from "node:test";
import { insertEpisodicEntry, type InsertEntryInput } from "../../../../packages/storage/src/index.ts";
import { createInternalHttpAdapter } from "../internal-http-adapter.ts";
import { handleReadEpisodicScratchHttp } from "./episodic-scratch.ts";
import { compactIntent, handleCompactIntentHttp } from "./openclaw-compact-intent.ts";

test("handleReadEpisodicScratchHttp returns redacted scratch rows by intent", async () => {
  const pool = new MemoryScratchPool();
  await insertEpisodicEntry(pool, entry({
    outcomeData: {
      ok: true,
      apiKey: "secret-value",
      nested: { token: "secret-token", visible: "kept" }
    }
  }));
  const { request, response, getResponse } = createInternalHttpAdapter({
    method: "GET",
    url: "/v1/openclaw/scratch?intentId=intent-1"
  });

  await handleReadEpisodicScratchHttp({ request, response, pool });

  const captured = getResponse();
  assert.equal(captured.statusCode, 200);
  const body = captured.body as { entries: Array<{ outcomeData: Record<string, unknown> }> };
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].outcomeData.apiKey, "[redacted]");
  assert.deepEqual(body.entries[0].outcomeData.nested, { token: "[redacted]", visible: "kept" });
});

test("handleReadEpisodicScratchHttp preserves scratch Date fields as ISO strings", async () => {
  const pool = new MemoryScratchPool();
  await insertEpisodicEntry(pool, entry());
  const { request, response, getResponse } = createInternalHttpAdapter({
    method: "GET",
    url: "/v1/openclaw/scratch?intentId=intent-1"
  });

  await handleReadEpisodicScratchHttp({ request, response, pool });

  const captured = getResponse();
  assert.equal(captured.statusCode, 200);
  const body = captured.body as { entries: Array<{ createdAt: string; ttlExpiresAt: string }> };
  assert.match(body.entries[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(body.entries[0].ttlExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("handleReadEpisodicScratchHttp enforces read boundary token when configured", async () => {
  const pool = new MemoryScratchPool();
  const { request, response, getResponse } = createInternalHttpAdapter({
    method: "GET",
    url: "/v1/openclaw/scratch?intentId=intent-1"
  });

  await handleReadEpisodicScratchHttp({
    request,
    response,
    pool,
    readBoundaryToken: "expected-token"
  });

  assert.equal(getResponse().statusCode, 401);
});

test("compactIntent writes entries and appends hash-only audit metadata", async () => {
  const pool = new MemoryScratchPool();
  const auditEvents: Array<{ action: string; targetId: string; metadata?: Record<string, unknown> }> = [
    { action: "oc.skill.invoked", targetId: "intent-1", metadata: { intentId: "intent-1" } },
    {
      action: "oc.proposal.signed",
      targetId: "proposal-2",
      metadata: { signatureId: "sig-2" },
      actorType: "operator",
      actorId: "juanescanar-cto",
      decision: "allow",
      humanApproved: true,
      id: "audit-sig-2",
      occurredAt: "2026-06-01T11:59:00.000Z",
      hash: "hash-sig-2"
    } as never
  ];

  const output = await compactIntent({
    intentId: "intent-1",
    finalStatus: "completed",
    decision: "completed smtp setup",
    steps: [
      {
        step: 1,
        tool: "suggest_safe_domain",
        inputHash: "a".repeat(64),
        outcome: "success",
        outcomeData: { domain: "example.com" }
      },
      {
        step: 2,
        tool: "create_webdock_server",
        inputHash: "b".repeat(64),
        outcome: "success",
        outcomeData: { slug: "server10" },
        proposalId: "proposal-2",
        signatureId: "sig-2"
      }
    ]
  }, {
    pool,
    auditLog: {
      async append(event) {
        auditEvents.push(event as { action: string; targetId: string; metadata?: Record<string, unknown> });
        return { id: `audit-${auditEvents.length}`, ...event };
      },
      async list() {
        return auditEvents as never;
      }
    },
    now: () => new Date("2026-06-01T12:00:00.000Z")
  });

  assert.equal(output.entriesWritten, 2);
  assert.equal(pool.rows.length, 2);
  assert.equal(pool.rows[0].source, "openclaw");
  assert.equal(pool.rows[1].source, "operator");
  const compactAudit = auditEvents.find((event) => event.action === "oc.episodic.intent_compacted");
  assert.equal(compactAudit?.targetId, "intent-1");
  assert.equal(typeof compactAudit?.metadata?.entriesHash, "string");
  assert.equal(compactAudit?.metadata?.decision, undefined);
});

test("compactIntent rejects unknown intent ids", async () => {
  const pool = new MemoryScratchPool();
  await assert.rejects(
    () => compactIntent({
      intentId: "missing-intent",
      finalStatus: "failed",
      decision: "not found",
      steps: [{ step: 1, tool: "x", inputHash: "a".repeat(64), outcome: "failed" }]
    }, {
      pool,
      auditLog: {
        async append(event) { return event; },
        async list() { return []; }
      }
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "intent_id_not_found" &&
      /oc\.skill\.invoked/.test(error.message)
  );
});

test("compactIntent rejects intents that only have orchestrator or chat audit events", async () => {
  const pool = new MemoryScratchPool();
  await assert.rejects(
    () => compactIntent({
      intentId: "intent-1",
      finalStatus: "failed",
      decision: "wrong provenance",
      steps: [{ step: 1, tool: "x", inputHash: "a".repeat(64), outcome: "failed" }]
    }, {
      pool,
      auditLog: {
        async append(event) { return event; },
        async list() {
          return [
            { action: "oc.orchestrator.run_started", targetId: "intent-1", metadata: { runId: "intent-1" } },
            { action: "oc.chat.operator_message", targetId: "intent-1", metadata: { intentId: "intent-1" } }
          ] as never;
        }
      }
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "intent_id_not_found"
  );
  assert.equal(pool.rows.length, 0);
});

test("handleCompactIntentHttp accepts unsigned local mode for internal smoke tests", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const pool = new MemoryScratchPool();
  const auditEvents: Array<{ action: string; targetId: string; metadata?: Record<string, unknown> }> = [
    { action: "oc.skill.invoked", targetId: "intent-1", metadata: { intentId: "intent-1" } }
  ];
  const { request, response, getResponse } = createInternalHttpAdapter({
    method: "POST",
    url: "/v1/openclaw/compact-intent",
    body: {
      intentId: "intent-1",
      finalStatus: "completed",
      decision: "stored",
      steps: [{ step: 1, tool: "read_episodic_scratch", inputHash: "a".repeat(64), outcome: "success" }]
    }
  });

  try {
    await handleCompactIntentHttp({
      request,
      response,
      pool,
      allowUnsignedLocal: true,
      auditLog: {
        async append(event) {
          auditEvents.push(event as { action: string; targetId: string; metadata?: Record<string, unknown> });
          return { id: `audit-${auditEvents.length}`, ...event };
        },
        async list() {
          return auditEvents as never;
        }
      }
    });
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }

  const captured = getResponse();
  assert.equal(captured.statusCode, 200);
  assert.equal((captured.body as { entriesWritten: number }).entriesWritten, 1);
});

test("handleCompactIntentHttp returns 400 intent_id_not_found for invented intent ids", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const pool = new MemoryScratchPool();
  const { request, response, getResponse } = createInternalHttpAdapter({
    method: "POST",
    url: "/v1/openclaw/compact-intent",
    body: {
      intentId: "invented-intent",
      finalStatus: "failed",
      decision: "poison attempt",
      steps: [{ step: 1, tool: "x", inputHash: "a".repeat(64), outcome: "failed" }]
    }
  });

  try {
    await handleCompactIntentHttp({
      request,
      response,
      pool,
      allowUnsignedLocal: true,
      auditLog: {
        async append(event) { return event; },
        async list() { return []; }
      }
    });
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }

  const captured = getResponse();
  assert.equal(captured.statusCode, 400);
  assert.equal((captured.body as { error: string }).error, "intent_id_not_found");
  assert.equal(pool.rows.length, 0);
});

test("handleCompactIntentHttp rejects unsigned local mode outside tests", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const pool = new MemoryScratchPool();
  const { request, response, getResponse } = createInternalHttpAdapter({
    method: "POST",
    url: "/v1/openclaw/compact-intent",
    body: {
      intentId: "intent-1",
      finalStatus: "completed",
      decision: "stored",
      steps: [{ step: 1, tool: "read_episodic_scratch", inputHash: "a".repeat(64), outcome: "success" }]
    }
  });

  try {
    await handleCompactIntentHttp({
      request,
      response,
      pool,
      allowUnsignedLocal: true,
      auditLog: {
        async append(event) { return event; },
        async list() { return []; }
      }
    });
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
  }

  const captured = getResponse();
  assert.equal(captured.statusCode, 401);
  assert.equal((captured.body as { error: string }).error, "hmac_secret_unconfigured");
  assert.equal(pool.rows.length, 0);
});

function entry(overrides: Partial<InsertEntryInput> = {}): InsertEntryInput {
  return {
    intentId: "intent-1",
    step: 1,
    tool: "suggest_safe_domain",
    inputHash: "0123456789abcdef",
    outcome: "success",
    outcomeData: { ok: true },
    source: "openclaw",
    ...overrides
  };
}

interface MemoryRow {
  id: string;
  intent_id: string;
  step: number;
  tool: string;
  input_hash: string;
  outcome: string;
  outcome_data: Record<string, unknown> | null;
  error_class: string | null;
  error_message: string | null;
  source: string;
  trust_score: number;
  ttl_expires_at: Date;
  created_at: Date;
  metadata: Record<string, unknown>;
}

class MemoryScratchPool {
  rows: MemoryRow[] = [];
  now = new Date();
  #id = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: MemoryRow[]; rowCount: number }> {
    if (sql.includes("INSERT INTO openclaw_episodic_scratch")) {
      const ttlDays = Number(params[10]);
      const row: MemoryRow = {
        id: `scratch-${++this.#id}`,
        intent_id: String(params[0]),
        step: Number(params[1]),
        tool: String(params[2]),
        input_hash: String(params[3]),
        outcome: String(params[4]),
        outcome_data: parseJsonRecord(params[5]),
        error_class: typeof params[6] === "string" ? params[6] : null,
        error_message: typeof params[7] === "string" ? params[7] : null,
        source: String(params[8]),
        trust_score: Number(params[9]),
        ttl_expires_at: new Date(this.now.getTime() + ttlDays * 24 * 60 * 60 * 1000),
        created_at: new Date(this.now.getTime() + this.#id),
        metadata: parseJsonRecord(params[11]) ?? {}
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    let rows = this.rows.filter((row) => row.ttl_expires_at > this.now);
    if (sql.includes("intent_id = $1")) {
      rows = rows.filter((row) => row.intent_id === params[0]);
      rows.sort((left, right) => left.step - right.step || left.created_at.getTime() - right.created_at.getTime());
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("input_hash = $1")) {
      rows = rows.filter((row) => row.input_hash === params[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("tool = $1") && sql.includes("outcome = $2")) {
      rows = rows.filter((row) => row.tool === params[0] && row.outcome === params[1]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("ORDER BY (trust_score * 100")) {
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  EpisodicScratchValidationError,
  expireOldEntries,
  insertEpisodicEntry,
  queryByInputHash,
  queryByIntent,
  queryByToolAndOutcome,
  retrieveTrustWeighted,
  type InsertEntryInput
} from "./episodic-scratch.ts";

test("insertEpisodicEntry writes and queryByIntent returns ordered live entries", async () => {
  const pool = new MemoryScratchPool();
  await insertEpisodicEntry(pool, entry({ step: 2, tool: "create_webdock_server" }));
  await insertEpisodicEntry(pool, entry({ step: 1, tool: "suggest_safe_domain" }));

  const rows = await queryByIntent(pool, "intent-1");

  assert.deepEqual(rows.map((row) => row.step), [1, 2]);
  assert.equal(rows[0].tool, "suggest_safe_domain");
});

test("queryByInputHash finds reusable evidence across intents", async () => {
  const pool = new MemoryScratchPool();
  await insertEpisodicEntry(pool, entry({ intentId: "intent-a", inputHash: "a".repeat(64) }));
  await insertEpisodicEntry(pool, entry({ intentId: "intent-b", inputHash: "a".repeat(64) }));
  await insertEpisodicEntry(pool, entry({ intentId: "intent-c", inputHash: "b".repeat(64) }));

  const rows = await queryByInputHash(pool, "a".repeat(64));

  assert.deepEqual(rows.map((row) => row.intentId).sort(), ["intent-a", "intent-b"]);
});

test("expired rows are hidden unless includeExpired is true", async () => {
  const pool = new MemoryScratchPool();
  await insertEpisodicEntry(pool, entry({ intentId: "intent-live", step: 1 }));
  await insertEpisodicEntry(pool, entry({ intentId: "intent-live", step: 2 }));
  pool.rows[1].ttl_expires_at = new Date(Date.now() - 60_000);

  assert.deepEqual((await queryByIntent(pool, "intent-live")).map((row) => row.step), [1]);
  assert.deepEqual((await queryByIntent(pool, "intent-live", { includeExpired: true })).map((row) => row.step), [1, 2]);
});

test("queryByToolAndOutcome filters tool and outcome", async () => {
  const pool = new MemoryScratchPool();
  await insertEpisodicEntry(pool, entry({ tool: "upsert_dns_route53", outcome: "success" }));
  await insertEpisodicEntry(pool, entry({ tool: "upsert_dns_route53", outcome: "failed" }));
  await insertEpisodicEntry(pool, entry({ tool: "create_webdock_server", outcome: "success" }));

  const rows = await queryByToolAndOutcome(pool, "upsert_dns_route53", "success");

  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, "upsert_dns_route53");
  assert.equal(rows[0].outcome, "success");
});

test("retrieveTrustWeighted prefers higher trust and recency", async () => {
  const pool = new MemoryScratchPool();
  await insertEpisodicEntry(pool, entry({ intentId: "low", trustScore: 20 }));
  await insertEpisodicEntry(pool, entry({ intentId: "high", trustScore: 90 }));
  pool.rows[0].created_at = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

  const rows = await retrieveTrustWeighted(pool, { tool: "suggest_safe_domain" }, 2);

  assert.deepEqual(rows.map((row) => row.intentId), ["high", "low"]);
});

test("expireOldEntries deletes expired rows", async () => {
  const pool = new MemoryScratchPool();
  await insertEpisodicEntry(pool, entry({ intentId: "old" }));
  await insertEpisodicEntry(pool, entry({ intentId: "new" }));
  pool.rows[0].ttl_expires_at = new Date(Date.now() - 60_000);

  assert.equal(await expireOldEntries(pool), 1);
  assert.deepEqual(pool.rows.map((row) => row.intent_id), ["new"]);
});

test("insertEpisodicEntry rejects invalid outcome, source, trust and input hash", async () => {
  const pool = new MemoryScratchPool();

  await assert.rejects(
    () => insertEpisodicEntry(pool, entry({ outcome: "bad" as never })),
    (error) => error instanceof EpisodicScratchValidationError && error.code === "invalid_outcome"
  );
  await assert.rejects(
    () => insertEpisodicEntry(pool, entry({ source: "bad" as never })),
    (error) => error instanceof EpisodicScratchValidationError && error.code === "invalid_source"
  );
  await assert.rejects(
    () => insertEpisodicEntry(pool, entry({ trustScore: 101 })),
    (error) => error instanceof EpisodicScratchValidationError && error.code === "invalid_trustScore"
  );
  await assert.rejects(
    () => insertEpisodicEntry(pool, entry({ inputHash: "not-hex" })),
    (error) => error instanceof EpisodicScratchValidationError && error.code === "invalid_inputHash"
  );
});

test("operator memory requires verified signature provenance", async () => {
  const pool = new MemoryScratchPool();

  await assert.rejects(
    () => insertEpisodicEntry(pool, entry({ source: "operator", metadata: { signatureId: "sig-1" } })),
    (error) =>
      error instanceof EpisodicScratchValidationError &&
      error.code === "operator_provenance_invalid"
  );

  const row = await insertEpisodicEntry(pool, entry({
    source: "operator",
    metadata: { signatureId: "sig-1", operatorSignatureVerified: true }
  }));

  assert.equal(row.trustScore, 95);
});

test("tool output memory requires tool-call provenance", async () => {
  const pool = new MemoryScratchPool();

  await assert.rejects(
    () => insertEpisodicEntry(pool, entry({ source: "tool_output" })),
    (error) =>
      error instanceof EpisodicScratchValidationError &&
      error.code === "tool_output_provenance_invalid"
  );

  const row = await insertEpisodicEntry(pool, entry({
    source: "tool_output",
    metadata: { toolUseId: "toolu-1" }
  }));

  assert.equal(row.trustScore, 70);
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
  #id = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: MemoryRow[]; rowCount: number }> {
    if (sql.includes("INSERT INTO openclaw_episodic_scratch")) {
      const now = new Date(Date.now() + this.#id);
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
        ttl_expires_at: params[10] instanceof Date ? params[10] : new Date(String(params[10])),
        created_at: now,
        metadata: parseJsonRecord(params[11]) ?? {}
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("DELETE FROM openclaw_episodic_scratch")) {
      const before = params[0] instanceof Date ? params[0] : new Date(String(params[0]));
      const deleted = this.rows.filter((row) => row.ttl_expires_at < before);
      this.rows = this.rows.filter((row) => row.ttl_expires_at >= before);
      return { rows: deleted, rowCount: deleted.length };
    }

    let rows = [...this.rows];
    if (sql.includes("intent_id = $1")) {
      rows = rows.filter((row) => row.intent_id === params[0]);
      if (sql.includes("ttl_expires_at > NOW()")) rows = onlyLive(rows);
      rows.sort((left, right) => left.step - right.step || left.created_at.getTime() - right.created_at.getTime());
      return { rows, rowCount: rows.length };
    }

    if (sql.includes("input_hash = $1")) {
      rows = onlyLive(rows).filter((row) => row.input_hash === params[0]);
      if (sql.includes("tool = $2")) rows = rows.filter((row) => row.tool === params[1]);
      rows.sort((left, right) => right.created_at.getTime() - left.created_at.getTime());
      return { rows, rowCount: rows.length };
    }

    if (sql.includes("ORDER BY (trust_score * 100")) {
      rows = onlyLive(rows);
      let index = 0;
      if (sql.includes("tool = $")) {
        const value = params[index++];
        rows = rows.filter((row) => row.tool === value);
      }
      if (sql.includes("outcome = $")) {
        const value = params[index++];
        rows = rows.filter((row) => row.outcome === value);
      }
      if (sql.includes("input_hash = $")) {
        const value = params[index++];
        rows = rows.filter((row) => row.input_hash === value);
      }
      const limit = Number(params.at(-1) ?? 10);
      rows.sort((left, right) =>
        weightedScore(right) - weightedScore(left) ||
        right.created_at.getTime() - left.created_at.getTime()
      );
      return { rows: rows.slice(0, limit), rowCount: Math.min(limit, rows.length) };
    }

    if (sql.includes("tool = $1") && sql.includes("outcome = $2")) {
      rows = onlyLive(rows)
        .filter((row) => row.tool === params[0] && row.outcome === params[1])
        .sort((left, right) => right.created_at.getTime() - left.created_at.getTime());
      const limit = Number(params.at(-1) ?? rows.length);
      return { rows: rows.slice(0, limit), rowCount: Math.min(limit, rows.length) };
    }

    return { rows: [], rowCount: 0 };
  }
}

function onlyLive(rows: MemoryRow[]): MemoryRow[] {
  const now = new Date();
  return rows.filter((row) => row.ttl_expires_at > now);
}

function weightedScore(row: MemoryRow): number {
  return row.trust_score * 100 - (Date.now() - row.created_at.getTime()) / 86_400_000;
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

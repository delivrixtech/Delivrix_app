import assert from "node:assert/strict";
import test from "node:test";
import { insertEpisodicEntry, type InsertEntryInput } from "../../../packages/storage/src/index.ts";
import { runEpisodicScratchTtlJob } from "./episodic-scratch-ttl.ts";

test("runEpisodicScratchTtlJob expires old rows and emits audit/canvas when work happened", async () => {
  const pool = new MemoryScratchPool();
  pool.now = new Date("2026-06-01T12:00:00.000Z");
  await insertEpisodicEntry(pool, entry({ intentId: "old" }));
  await insertEpisodicEntry(pool, entry({ intentId: "new" }));
  pool.rows[0].ttl_expires_at = new Date("2026-06-01T11:00:00.000Z");
  pool.rows[1].ttl_expires_at = new Date("2026-06-01T13:00:00.000Z");
  const auditEvents: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const canvasEvents: Array<{ action?: string }> = [];

  const result = await runEpisodicScratchTtlJob({
    pool,
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    auditLog: {
      async append(event) {
        auditEvents.push(event as { action: string; metadata?: Record<string, unknown> });
        return event;
      }
    },
    canvasLiveEvents: {
      async emit(event) {
        canvasEvents.push(event as { action?: string });
        return event;
      }
    }
  });

  assert.equal(result.expired, 1);
  assert.deepEqual(pool.rows.map((row) => row.intent_id), ["new"]);
  assert.equal(auditEvents[0]?.action, "oc.episodic.scratch_expired");
  assert.equal(auditEvents[0]?.metadata?.expired, 1);
  assert.equal(canvasEvents[0]?.action, "oc.episodic.scratch_expired");
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
  plane: string;
  provenance: Record<string, unknown>;
  reliability: number;
  valid_at: Date;
  invalid_at: Date | null;
  ttl_expires_at: Date;
  created_at: Date;
  metadata: Record<string, unknown>;
}

class MemoryScratchPool {
  rows: MemoryRow[] = [];
  now = new Date();
  deleteSql?: string;
  #id = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: MemoryRow[]; rowCount: number }> {
    if (sql.includes("INSERT INTO openclaw_episodic_scratch")) {
      const ttlDays = Number(params[15]);
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
        plane: String(params[10]),
        provenance: parseJsonRecord(params[11]) ?? {},
        reliability: Number(params[12]),
        valid_at: params[13] instanceof Date ? params[13] : new Date(String(params[13])),
        invalid_at: params[14] instanceof Date ? params[14] : null,
        ttl_expires_at: new Date(this.now.getTime() + ttlDays * 24 * 60 * 60 * 1000),
        created_at: new Date(Date.now() + this.#id),
        metadata: parseJsonRecord(params[16]) ?? {}
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("WITH invalidated")) {
      this.deleteSql = sql;
      let affected = 0;
      this.rows = this.rows.filter((row) => {
        if (row.ttl_expires_at > this.now || row.invalid_at) return true;
        if (row.plane === "verified_fact" || row.source === "operator") {
          row.invalid_at = this.now;
          affected++;
          return true;
        }
        affected++;
        return false;
      });
      return { rows: [{ affected } as unknown as MemoryRow], rowCount: 1 };
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  checkEpisodicScratchHealth,
  dependencyStatus,
  type DependencyCheck,
  type QueryablePool
} from "./dependency-health.ts";

test("dependencyStatus returns the public status enum", () => {
  const check: DependencyCheck = {
    status: "ok",
    checkedAt: "2026-05-28T00:00:00.000Z"
  };

  assert.equal(dependencyStatus(check), "ok");
});

test("checkEpisodicScratchHealth reports ok when table and guard columns exist", async () => {
  const result = await checkEpisodicScratchHealth({
    pool: mockScratchPool(new Set([
      "id",
      "intent_id",
      "tool",
      "input_hash",
      "outcome",
      "outcome_data",
      "ttl_expires_at",
      "plane",
      "provenance",
      "reliability",
      "valid_at",
      "invalid_at"
    ])),
    now: () => new Date("2026-06-24T12:00:00.000Z")
  });

  assert.deepEqual(result, {
    status: "ok",
    checkedAt: "2026-06-24T12:00:00.000Z"
  });
});

test("checkEpisodicScratchHealth distinguishes missing table and schema drift", async () => {
  assert.equal((await checkEpisodicScratchHealth({
    pool: {
      async query(sql) {
        if (sql.includes("to_regclass")) return { rows: [{ table_name: null }] };
        return { rows: [] };
      }
    },
    now: () => new Date("2026-06-24T12:00:00.000Z")
  })).status, "missing_table");

  const drift = await checkEpisodicScratchHealth({
    pool: mockScratchPool(new Set(["id", "intent_id", "tool"])),
    now: () => new Date("2026-06-24T12:00:00.000Z")
  });

  assert.equal(drift.status, "schema_drift");
  assert.equal(drift.missingColumns?.includes("plane"), true);
});

test("checkEpisodicScratchHealth sanitizes unexpected dependency failures", async () => {
  const result = await checkEpisodicScratchHealth({
    pool: {
      async query() {
        throw new Error("password=secret host=db.internal user=delivrix");
      }
    },
    now: () => new Date("2026-06-24T12:00:00.000Z")
  });

  assert.deepEqual(result, {
    status: "down",
    checkedAt: "2026-06-24T12:00:00.000Z",
    reason: "episodic_scratch_health_failed"
  });
});

function mockScratchPool(columns: Set<string>): QueryablePool {
  return {
    async query(sql: string, _params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
      if (sql.includes("to_regclass")) return { rows: [{ table_name: "openclaw_episodic_scratch" }] };
      if (sql.includes("information_schema.columns")) {
        return { rows: [...columns].map((column_name) => ({ column_name })) };
      }
      return { rows: [] };
    }
  };
}

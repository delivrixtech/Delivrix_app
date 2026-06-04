import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEpisodicReviewSeedAllowed,
  buildEpisodicReviewSeedEntries,
  runEpisodicReviewSeed
} from "./seed-episodic.mjs";
import { insertEpisodicEntry } from "../../packages/storage/src/index.ts";

const localEnv = {
  NODE_ENV: "development",
  POSTGRES_URL: "postgres://delivrix:delivrix_dev_password@127.0.0.1:5432/delivrix_mailops",
  POSTGRES_CONTAINER: "",
  OPENCLAW_OPERATOR_HMAC_SECRET: "operator-review-secret"
};

test("buildEpisodicReviewSeedEntries creates representative review-only memory", () => {
  const entries = buildEpisodicReviewSeedEntries(localEnv);

  assert.equal(entries.length, 25);
  assert.equal(entries.some((entry) => entry.plane === "verified_fact"), true);
  assert.equal(entries.some((entry) => entry.plane === "observation"), true);
  assert.equal(entries.some((entry) => entry.invalidAt instanceof Date), true);
  assert.equal(entries.some((entry) => entry.source === "operator"), true);
  assert.equal(
    entries
      .filter((entry) => entry.outcomeData.decisionCode === "production_sender_stack_active")
      .every((entry) => entry.outcomeData.scopeGuard?.mode === "explicit_plan_signature"),
    true
  );
  assert.equal(entries.every((entry) => entry.metadata.seedKind === "review"), true);
  assert.equal(
    entries.filter((entry) => entry.source === "operator")
      .every((entry) => typeof entry.metadata.operatorSignatureHmac === "string"),
    true
  );
});

test("runEpisodicReviewSeed uses one transaction and injected insert without real database", async () => {
  const client = new FakeClient();
  const pool = { async connect() { return client; } };
  const inserted = [];
  const logs = [];

  const result = await runEpisodicReviewSeed({
    env: localEnv,
    pool,
    insert: async (_client, entry) => {
      inserted.push(entry);
      return { id: entry.intentId };
    },
    log: (message) => logs.push(message)
  });

  assert.deepEqual(client.queries, [
    "BEGIN",
    "SET LOCAL search_path TO delivrix, public",
    "COMMIT"
  ]);
  assert.equal(client.released, true);
  assert.equal(result.inserted, 25);
  assert.equal(inserted.length, 25);
  assert.deepEqual(logs, ["episodic review seed complete: 25 deterministic entries"]);
});

test("episodic review seed entries pass the real scratch write gate", async () => {
  const pool = new FakeScratchPool();
  const entries = buildEpisodicReviewSeedEntries(localEnv);

  await withOperatorSecret(localEnv.OPENCLAW_OPERATOR_HMAC_SECRET, async () => {
    for (const entry of entries) {
      await insertEpisodicEntry(pool, entry);
    }
  });

  assert.equal(pool.rows.length, 25);
  assert.equal(
    pool.rows
      .filter((row) => row.source === "openclaw")
      .every((row) => row.reliability === 0.35),
    true
  );
});

test("episodic review seed producer keys stay synchronized with the write gate", () => {
  const keys = collectOutcomeDataKeys(buildEpisodicReviewSeedEntries(localEnv));

  assert.deepEqual(keys, [
    "appliesTo",
    "approvedLimitPerDay",
    "autoRenew",
    "continuity",
    "decisionCode",
    "domain",
    "gates",
    "highImpactAction",
    "invalidationReason",
    "maxDailyRamp",
    "mode",
    "noteCode",
    "productionSenderStack",
    "recordType",
    "rejectionCode",
    "reputationSignals",
    "rollbackCode",
    "schedule",
    "scopeGuard",
    "serverSlug",
    "zoneId"
  ]);
});

test("episodic review seed refuses production and non-local targets", () => {
  assert.throws(
    () => assertEpisodicReviewSeedAllowed({ ...localEnv, NODE_ENV: "production" }),
    /NODE_ENV=production/
  );
  assert.throws(
    () => assertEpisodicReviewSeedAllowed({
      ...localEnv,
      POSTGRES_URL: "postgres://delivrix:secret@db.example.com:5432/delivrix_mailops"
    }),
    /non-local POSTGRES_URL/
  );
  assert.throws(
    () => assertEpisodicReviewSeedAllowed({ ...localEnv, OPENCLAW_OPERATOR_HMAC_SECRET: "" }),
    /OPENCLAW_OPERATOR_HMAC_SECRET/
  );
});

class FakeClient {
  queries = [];
  released = false;

  async query(sql) {
    this.queries.push(sql);
    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

class FakeScratchPool {
  rows = [];
  now = new Date("2026-06-03T12:00:00.000Z");
  #id = 0;

  async query(sql, params = []) {
    if (!sql.includes("INSERT INTO openclaw_episodic_scratch")) {
      throw new Error(`Unexpected SQL in seed write-gate test: ${sql}`);
    }
    const ttlDays = Number(params[15]);
    const row = {
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
      created_at: new Date(this.now.getTime() + this.#id),
      metadata: parseJsonRecord(params[16]) ?? {}
    };
    this.rows.push(row);
    return { rows: [row], rowCount: 1 };
  }
}

function parseJsonRecord(value) {
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

async function withOperatorSecret(secret, fn) {
  const previous = process.env.OPENCLAW_OPERATOR_HMAC_SECRET;
  process.env.OPENCLAW_OPERATOR_HMAC_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_OPERATOR_HMAC_SECRET;
    } else {
      process.env.OPENCLAW_OPERATOR_HMAC_SECRET = previous;
    }
  }
}

function collectOutcomeDataKeys(entries) {
  const keys = new Set();
  for (const entry of entries) {
    collectKeys(entry.outcomeData, keys);
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

function collectKeys(value, keys) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    keys.add(key);
    collectKeys(item, keys);
  }
}

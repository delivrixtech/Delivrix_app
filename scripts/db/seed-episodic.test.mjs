import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEpisodicReviewSeedAllowed,
  buildEpisodicReviewSeedEntries,
  runEpisodicReviewSeed
} from "./seed-episodic.mjs";

const localEnv = {
  NODE_ENV: "development",
  POSTGRES_URL: "postgres://delivrix:delivrix_dev_password@127.0.0.1:5432/delivrix_mailops",
  POSTGRES_CONTAINER: "",
  OPENCLAW_OPERATOR_HMAC_SECRET: "operator-review-secret"
};

test("buildEpisodicReviewSeedEntries creates representative review-only memory", () => {
  const entries = buildEpisodicReviewSeedEntries(localEnv);

  assert.equal(entries.length, 18);
  assert.equal(entries.some((entry) => entry.plane === "verified_fact"), true);
  assert.equal(entries.some((entry) => entry.plane === "observation"), true);
  assert.equal(entries.some((entry) => entry.invalidAt instanceof Date), true);
  assert.equal(entries.some((entry) => entry.source === "operator"), true);
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
  assert.equal(result.inserted, 18);
  assert.equal(inserted.length, 18);
  assert.deepEqual(logs, ["episodic review seed complete: 18 deterministic entries"]);
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

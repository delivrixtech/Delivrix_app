import assert from "node:assert/strict";
import test from "node:test";
import {
  hybridSearchMemoryVectors,
  insertMemoryVector,
  keywordSearchMemoryVectors,
  MemoryVectorValidationError,
  semanticSearchMemoryVectors,
  type MemoryVectorDbRow,
  type MemoryVisibility
} from "./memory-vectors.ts";

// --- test doubles ----------------------------------------------------------

type Responder = (sql: string, params: unknown[]) => MemoryVectorDbRow[];

class FakeVectorPool {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  private readonly responder: Responder;

  constructor(responder?: Responder) {
    this.responder = responder ?? (() => []);
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: MemoryVectorDbRow[] }> {
    this.calls.push({ sql, params });
    return { rows: this.responder(sql, params) };
  }

  get lastSql(): string {
    return this.calls.at(-1)?.sql ?? "";
  }

  get lastParams(): unknown[] {
    return this.calls.at(-1)?.params ?? [];
  }
}

const emb = (): number[] => Array.from({ length: 1024 }, (_, i) => (i % 7) / 7);

function dbRow(overrides: Partial<MemoryVectorDbRow> = {}): MemoryVectorDbRow {
  return {
    id: "mem-1",
    agent_id: "openclaw",
    memory_type: "finding",
    visibility: "private",
    content: "bizreport cayó en spam con 10/10 técnico",
    metadata: { domain: "bizreport-control.com" },
    source_path: null,
    task_id: null,
    has_embedding: true,
    created_at: "2026-06-27T23:00:00.000Z",
    updated_at: "2026-06-27T23:00:00.000Z",
    ...overrides
  };
}

// --- insert ----------------------------------------------------------------

test("insertMemoryVector inserts with vector + jsonb casts and maps the row", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);

  const entry = await insertMemoryVector(pool, {
    agentId: "openclaw",
    memoryType: "finding",
    content: "bizreport cayó en spam con 10/10 técnico",
    embedding: emb(),
    metadata: { domain: "bizreport-control.com" }
  });

  assert.match(pool.lastSql, /INSERT INTO openclaw_memory_vectors/);
  assert.match(pool.lastSql, /\$6::vector/);
  assert.match(pool.lastSql, /\$7::jsonb/);
  assert.match(pool.lastSql, /RETURNING/);
  assert.equal(pool.lastParams[2], "private"); // default visibility
  assert.equal(pool.lastParams[5], `[${emb().join(",")}]`); // vector literal
  assert.equal(pool.lastParams[6], JSON.stringify({ domain: "bizreport-control.com" }));
  assert.equal(typeof pool.lastParams[8], "string"); // computed audit hash
  assert.equal((pool.lastParams[8] as string).length, 64); // sha256 hex
  assert.equal(entry.agentId, "openclaw");
  assert.equal(entry.hasEmbedding, true);
  assert.equal(entry.visibility, "private");
});

test("insertMemoryVector allows FTS-only memory without an embedding", async () => {
  const pool = new FakeVectorPool(() => [dbRow({ has_embedding: false })]);

  const entry = await insertMemoryVector(pool, {
    agentId: "openclaw",
    memoryType: "note",
    content: "memoria sin embedding todavía"
  });

  assert.equal(pool.lastParams[5], null); // embedding param is null
  assert.equal(entry.hasEmbedding, false);
});

test("insertMemoryVector rejects embeddings that are not 1024-dim", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);
  await assert.rejects(
    () =>
      insertMemoryVector(pool, {
        agentId: "openclaw",
        memoryType: "finding",
        content: "x",
        embedding: [1, 2, 3]
      }),
    (error: unknown) =>
      error instanceof MemoryVectorValidationError && error.code === "invalid_embedding"
  );
});

test("insertMemoryVector rejects invalid visibility and empty content", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);

  await assert.rejects(
    () =>
      insertMemoryVector(pool, {
        agentId: "openclaw",
        memoryType: "finding",
        content: "x",
        visibility: "world" as MemoryVisibility
      }),
    (error: unknown) =>
      error instanceof MemoryVectorValidationError && error.code === "invalid_visibility"
  );

  await assert.rejects(
    () => insertMemoryVector(pool, { agentId: "openclaw", memoryType: "finding", content: "   " }),
    (error: unknown) =>
      error instanceof MemoryVectorValidationError && error.code === "invalid_content"
  );
});

// --- semantic search -------------------------------------------------------

test("semanticSearchMemoryVectors builds a cosine search and maps the score", async () => {
  const pool = new FakeVectorPool(() => [dbRow({ score: 0.91 })]);

  const out = await semanticSearchMemoryVectors(pool, {
    agentId: "openclaw",
    embedding: emb(),
    limit: 5
  });

  assert.match(pool.lastSql, /embedding <=> \$1::vector/);
  assert.match(pool.lastSql, /ORDER BY embedding <=> \$1::vector/);
  assert.equal(pool.lastParams[0], `[${emb().join(",")}]`);
  assert.equal(pool.lastParams[1], "openclaw");
  assert.deepEqual(pool.lastParams[2], ["shared_family", "shared_global", "human_authored"]);
  assert.equal(pool.lastParams[3], 5); // limit param
  assert.equal(out[0].score, 0.91);
});

test("semanticSearchMemoryVectors applies the minScore floor", async () => {
  const pool = new FakeVectorPool(() => [
    dbRow({ id: "low", score: 0.4 }),
    dbRow({ id: "high", score: 0.85 })
  ]);

  const out = await semanticSearchMemoryVectors(pool, {
    agentId: "openclaw",
    embedding: emb(),
    minScore: 0.7
  });

  assert.deepEqual(out.map((entry) => entry.id), ["high"]);
});

// --- keyword (FTS) search --------------------------------------------------

test("keywordSearchMemoryVectors builds a Spanish full-text query", async () => {
  const pool = new FakeVectorPool(() => [dbRow({ score: 0.12 })]);

  await keywordSearchMemoryVectors(pool, {
    agentId: "openclaw",
    queryText: "spam bizreport"
  });

  assert.match(pool.lastSql, /content_tsv @@ websearch_to_tsquery\('spanish', \$1\)/);
  assert.equal(pool.lastParams[0], "spam bizreport");
});

// --- hybrid (RRF) ----------------------------------------------------------

test("hybridSearchMemoryVectors fuses vector + keyword and dedupes by id", async () => {
  const pool = new FakeVectorPool((sql) =>
    /<=>/.test(sql)
      ? [dbRow({ id: "shared" }), dbRow({ id: "vector-only" })]
      : [dbRow({ id: "shared" }), dbRow({ id: "keyword-only" })]
  );

  const out = await hybridSearchMemoryVectors(pool, {
    agentId: "openclaw",
    queryText: "spam placement",
    embedding: emb(),
    limit: 10
  });

  const ids = out.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate ids after fusion");
  assert.ok(ids.includes("shared"));
  assert.equal(ids[0], "shared", "the doc present in both rankings ranks first via RRF");
});

test("hybridSearchMemoryVectors degrades to keyword-only without an embedding", async () => {
  const seen: string[] = [];
  const pool = new FakeVectorPool((sql) => {
    seen.push(sql);
    return [dbRow()];
  });

  await hybridSearchMemoryVectors(pool, { agentId: "openclaw", queryText: "spam" });

  assert.equal(seen.length, 1, "only the FTS query runs when no embedding is supplied");
  assert.match(seen[0], /websearch_to_tsquery/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVENANCE_METADATA_KEY,
  semanticRecall,
  semanticRemember,
  SemanticMemoryValidationError
} from "./openclaw-semantic-memory.ts";
import type { EmbeddingService } from "../openclaw-embedding-service.ts";
import type {
  MemoryVectorDbRow,
  MemoryVisibility
} from "../../../../packages/storage/src/index.ts";

type RowsFor = (sql: string, params: unknown[]) => MemoryVectorDbRow[];

class FakeVectorPool {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  private readonly rowsFor: RowsFor;

  constructor(rowsFor: RowsFor) {
    this.rowsFor = rowsFor;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: MemoryVectorDbRow[] }> {
    this.calls.push({ sql, params });
    return { rows: this.rowsFor(sql, params) };
  }
}

function fakeEmbedding(opts: { enabled: boolean; throws?: boolean }): EmbeddingService {
  return {
    enabled: opts.enabled,
    modelId: "fake-embed",
    async embed(): Promise<number[]> {
      if (opts.throws) throw new Error("bedrock down");
      return Array.from({ length: 1024 }, (_, i) => (i % 5) / 5);
    }
  };
}

function dbRow(overrides: Partial<MemoryVectorDbRow> = {}): MemoryVectorDbRow {
  return {
    id: "mem-1",
    agent_id: "openclaw",
    memory_type: "finding",
    visibility: "private",
    content: "memoria de prueba",
    metadata: {},
    source_path: null,
    task_id: null,
    has_embedding: true,
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
    ...overrides
  };
}

// --- remember --------------------------------------------------------------

test("semanticRemember embeds and stores when the embedding service is enabled", async () => {
  const pool = new FakeVectorPool((_sql, params) => [dbRow({ has_embedding: params[5] != null })]);

  const out = await semanticRemember(
    { agentId: "openclaw", memoryType: "finding", content: "bizreport cayó en spam con 10/10" },
    { pool, embeddingService: fakeEmbedding({ enabled: true }) }
  );

  assert.equal(out.embedded, true);
  const insert = pool.calls.at(-1);
  assert.match(insert?.sql ?? "", /INSERT INTO openclaw_memory_vectors/);
  assert.equal(typeof insert?.params[5], "string");
  assert.match(String(insert?.params[5]), /^\[/); // vector literal
});

test("semanticRemember stores full-text-only when embeddings are disabled", async () => {
  const pool = new FakeVectorPool((_sql, params) => [dbRow({ has_embedding: params[5] != null })]);

  const out = await semanticRemember(
    { agentId: "openclaw", memoryType: "note", content: "memoria sin embedding" },
    { pool, embeddingService: fakeEmbedding({ enabled: false }) }
  );

  assert.equal(out.embedded, false);
  assert.equal(pool.calls.at(-1)?.params[5], null);
});

test("semanticRemember degrades gracefully when the embedding call errors", async () => {
  const pool = new FakeVectorPool((_sql, params) => [dbRow({ has_embedding: params[5] != null })]);

  const out = await semanticRemember(
    { agentId: "openclaw", memoryType: "note", content: "memoria con bedrock caído" },
    { pool, embeddingService: fakeEmbedding({ enabled: true, throws: true }) }
  );

  assert.equal(out.embedded, false); // written anyway, FTS-only
});

test("semanticRemember rejects invalid visibility and empty content", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);

  await assert.rejects(
    () =>
      semanticRemember(
        { agentId: "openclaw", memoryType: "finding", content: "x", visibility: "world" as MemoryVisibility },
        { pool }
      ),
    (error: unknown) =>
      error instanceof SemanticMemoryValidationError && error.code === "invalid_visibility"
  );

  await assert.rejects(
    () => semanticRemember({ agentId: "openclaw", memoryType: "finding", content: "   " }, { pool }),
    (error: unknown) =>
      error instanceof SemanticMemoryValidationError && error.code === "invalid_content"
  );
});

// --- recall ----------------------------------------------------------------

test("semanticRecall uses the embedding for hybrid retrieval when enabled", async () => {
  const pool = new FakeVectorPool((sql) =>
    /<=>/.test(sql) ? [dbRow({ id: "vector-hit" })] : [dbRow({ id: "keyword-hit" })]
  );

  const out = await semanticRecall(
    { agentId: "openclaw", query: "por qué cae en spam" },
    { pool, embeddingService: fakeEmbedding({ enabled: true }) }
  );

  assert.equal(out.embeddingUsed, true);
  assert.ok(out.results.length >= 1);
  assert.ok(pool.calls.some((call) => /<=>/.test(call.sql)), "a vector query ran");
  assert.ok(pool.calls.some((call) => /websearch_to_tsquery/.test(call.sql)), "an FTS query ran");
});

test("semanticRecall falls back to full-text-only when embeddings are disabled", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);

  const out = await semanticRecall(
    { agentId: "openclaw", query: "plan de warmup" },
    { pool, embeddingService: fakeEmbedding({ enabled: false }) }
  );

  assert.equal(out.embeddingUsed, false);
  assert.ok(pool.calls.every((call) => !/<=>/.test(call.sql)), "no vector query ran");
});

test("semanticRecall rejects a too-short query", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);

  await assert.rejects(
    () => semanticRecall({ agentId: "openclaw", query: "x" }, { pool }),
    (error: unknown) => error instanceof SemanticMemoryValidationError && error.code === "invalid_query"
  );
});

// --- procedencia -----------------------------------------------------------
//
// La tabla openclaw_memory_vectors no tiene DELETE, ni TTL, ni expires_at: lo que entra queda.
// Si el modelo guarda texto de terceros con instrucciones, semantic_recall se lo devuelve como
// conocimiento propio en cualquier sesion posterior. Sin procedencia esa fila es indistinguible
// de una legitima, asi que no hay forma de encontrarla para darla de baja.

function metadataDeLaInsercion(pool: FakeVectorPool): Record<string, unknown> {
  const insert = pool.calls.find((call) => /INSERT INTO openclaw_memory_vectors/.test(call.sql));
  assert.ok(insert, "no se ejecuto ningun INSERT");
  // El metadata es el 7mo parametro del INSERT y viaja serializado.
  return JSON.parse(insert.params[6] as string) as Record<string, unknown>;
}

test("semanticRemember sella el actorId firmado dentro del metadata", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);

  await semanticRemember(
    {
      agentId: "openclaw",
      memoryType: "finding",
      content: "el nodo contabo-3 quedo sin base SASL",
      actorId: "chat-session-42"
    },
    { pool, embeddingService: fakeEmbedding({ enabled: true }) }
  );

  assert.deepEqual(metadataDeLaInsercion(pool)[PROVENANCE_METADATA_KEY], { actorId: "chat-session-42" });
});

test("semanticRemember deja la procedencia explicita cuando la llamada no viene atribuida", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);

  await semanticRemember(
    { agentId: "openclaw", memoryType: "finding", content: "escritura sin sesion" },
    { pool }
  );

  // null, no ausente: distingue "vino sin atribuir" de "fila anterior a este cambio".
  assert.deepEqual(metadataDeLaInsercion(pool)[PROVENANCE_METADATA_KEY], { actorId: null });
});

test("semanticRemember no deja falsificar la procedencia desde el metadata del modelo", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);

  await semanticRemember(
    {
      agentId: "openclaw",
      memoryType: "finding",
      content: "intento de suplantacion",
      actorId: "chat-session-42",
      metadata: { [PROVENANCE_METADATA_KEY]: { actorId: "operator/juanes" }, nota: "se conserva" }
    },
    { pool }
  );

  const metadata = metadataDeLaInsercion(pool);
  assert.deepEqual(metadata[PROVENANCE_METADATA_KEY], { actorId: "chat-session-42" });
  assert.equal(metadata.nota, "se conserva", "el resto del metadata del modelo no se toca");
});

test("semanticRemember rechaza un actorId que no es string", async () => {
  const pool = new FakeVectorPool(() => [dbRow()]);

  await assert.rejects(
    () =>
      semanticRemember(
        {
          agentId: "openclaw",
          memoryType: "finding",
          content: "actorId invalido",
          actorId: 42 as unknown as string
        },
        { pool }
      ),
    (error: unknown) => error instanceof SemanticMemoryValidationError && error.code === "invalid_actorId"
  );
});

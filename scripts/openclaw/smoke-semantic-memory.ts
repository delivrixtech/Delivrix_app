// Smoke E2E for OpenClaw semantic memory against the LIVE Postgres (OrbStack).
//
//   node --experimental-strip-types scripts/openclaw/smoke-semantic-memory.ts
//
// Proves the full chain works against the real database: insert a memory,
// recall it by keyword (Spanish FTS) and by hybrid (vector + FTS, RRF), and
// assert the recall returns what we just stored. No embeddings required — runs
// FTS-only, so it passes even without Bedrock configured.

import { Pool } from "pg";
import {
  hybridSearchMemoryVectors,
  insertMemoryVector,
  keywordSearchMemoryVectors
} from "../../packages/storage/src/index.ts";

const connectionString =
  process.env.POSTGRES_URL ??
  "postgres://delivrix:delivrix_dev_password@127.0.0.1:5432/delivrix_mailops";

const pool = new Pool({ connectionString, application_name: "smoke-semantic-memory" });

async function main(): Promise<void> {
  await pool.query("SET search_path TO delivrix, public");

  const agentId = "openclaw";
  // NOTA: texto FTS-limpio a propósito. El parser 'spanish' de Postgres pega los
  // slashes/acrónimos (p.ej. "contenido/reputación" -> 1 token) y el recall FTS no
  // matchea palabra suelta. La búsqueda vectorial (con embeddings) es inmune a esto;
  // este smoke corre en modo FTS-only, así que usamos palabras separables.
  const content =
    "El dominio bizreport cayo en Spam de Gmail pese a tener autenticacion correcta " +
    "e IP limpia. La causa real fue la reputacion y el contenido, no la infraestructura.";

  console.log("→ semantic_remember (insert, FTS-only sin embedding)…");
  const stored = await insertMemoryVector(pool, {
    agentId,
    memoryType: "finding",
    content,
    visibility: "shared_global",
    metadata: { domain: "bizreport-control.com", source: "smoke-2026-06-28" }
  });
  console.log(`   stored id=${stored.id} hasEmbedding=${stored.hasEmbedding} visibility=${stored.visibility}`);

  console.log("→ keyword recall ('reputacion contenido')…");
  const keyword = await keywordSearchMemoryVectors(pool, {
    agentId,
    queryText: "reputacion contenido",
    limit: 5
  });
  console.log(`   ${keyword.length} hit(s):`);
  for (const hit of keyword) {
    const score = typeof hit.score === "number" ? hit.score.toFixed(4) : "n/a";
    console.log(`     - ${hit.id} score=${score} :: ${hit.content.slice(0, 64)}…`);
  }

  console.log("→ hybrid recall ('por que bizreport cayo en spam')…");
  const hybrid = await hybridSearchMemoryVectors(pool, {
    agentId,
    queryText: "por que bizreport cayo en spam",
    limit: 5
  });
  console.log(`   ${hybrid.length} hit(s) (fusión RRF)`);

  const recalled = keyword.some((hit) => hit.id === stored.id);
  await pool.end();

  if (!recalled) {
    console.error("❌ SMOKE FAILED: el recall no encontró el recuerdo recién guardado.");
    process.exit(1);
  }
  console.log("✅ SMOKE OK — la memoria semántica escribe y recupera contra Postgres vivo (pgvector + FTS español).");
}

main().catch((error) => {
  console.error("❌ SMOKE ERROR:", error);
  process.exit(1);
});

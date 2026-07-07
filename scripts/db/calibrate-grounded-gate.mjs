// Calibracion del gate de confianza CRAG de la memoria grounded.
//
// Barre minScore contra un set de queries doradas construido desde el corpus
// real de hechos verificados y reporta, por umbral:
//   - recall+ : % de queries positivas (tool + dominio reales) que quedan grounded
//   - fp-     : % de queries negativas (fuera de dominio del producto) que quedan grounded (debe ser 0)
//   - fp-x    : % de queries cruzadas (tool real + dominio inexistente) que inyectan
//               memoria de OTRO dominio como grounded (debe tender a 0)
// Emula el pipeline real: candidatos = top (limit*4) por reliability/recency,
// despues assessGroundedMemoryCandidates con los mismos pesos del runtime.
//
// Uso:
//   node scripts/db/calibrate-grounded-gate.mjs                     # corpus desde Postgres local
//   node scripts/db/calibrate-grounded-gate.mjs --source executions --dir <path>
//   node scripts/db/calibrate-grounded-gate.mjs --min 0.3 --max 0.7 --step 0.02
import pg from "pg";
import { assessGroundedMemoryCandidates } from "../../packages/storage/src/index.ts";
import { assertEpisodicExecutionSeedAllowed, buildExecutionSeedEntries, collectExecutionRecordFiles, parseExecutionRecord } from "./seed-episodic-executions.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const dayMs = 24 * 60 * 60 * 1000;

export async function loadVerifiedFactsFromDb(env = process.env) {
  const { config } = assertEpisodicExecutionSeedAllowed(env);
  const pool = new Pool({ connectionString: config.url });
  try {
    const result = await pool.query(`
      SELECT * FROM delivrix.openclaw_episodic_scratch
      WHERE plane = 'verified_fact' AND invalid_at IS NULL AND ttl_expires_at > NOW()
        AND source <> 'openclaw'
    `);
    return result.rows.map(rowToCalibrationEntry);
  } finally {
    await pool.end();
  }
}

export function loadVerifiedFactsFromExecutions(dir) {
  const files = collectExecutionRecordFiles(dir);
  const records = files
    .map((file) => parseExecutionRecord({ date: file.date, filename: file.filename, content: readFileSync(file.path, "utf8") }))
    .filter(Boolean);
  return buildExecutionSeedEntries(records).map((entry, index) => ({
    id: `calib-${index}`,
    intentId: entry.intentId,
    step: entry.step,
    tool: entry.tool,
    inputHash: entry.inputHash,
    outcome: entry.outcome,
    outcomeData: entry.outcomeData,
    errorClass: entry.errorClass,
    source: entry.source,
    trustScore: 70,
    plane: entry.plane,
    provenance: entry.provenance,
    reliability: entry.reliability,
    validAt: entry.validAt ?? new Date(),
    ttlExpiresAt: new Date(Date.now() + (entry.ttlDays ?? 180) * dayMs),
    createdAt: entry.validAt ?? new Date(),
    metadata: entry.metadata
  }));
}

export function buildGoldenQueries(entries, opts = {}) {
  const maxPositives = opts.maxPositives ?? 60;
  const positives = [];
  const seen = new Set();
  for (const entry of entries) {
    const domain = typeof entry.outcomeData?.domain === "string" ? entry.outcomeData.domain : undefined;
    if (!domain || entry.outcome !== "success") continue;
    const key = `${entry.tool}:${domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    positives.push({ kind: "positive", query: `${entry.tool} ${domain}`, tool: entry.tool, domain });
    if (positives.length >= maxPositives) break;
  }

  const negatives = [
    "kubernetes autoscaler nodo caido",
    "factura electronica sunat rechazada",
    "wordpress elementor licencia vencida",
    "impresora laser atasco papel bandeja",
    "spotify playlist sincronizar offline",
    "vuelo demorado compensacion aerolinea"
  ].map((query) => ({ kind: "negative", query }));

  const crossTools = [...new Set(positives.map((item) => item.tool))].slice(0, 8);
  const cross = crossTools.map((tool) => ({
    kind: "cross",
    tool,
    domain: "dominio-inexistente-zz.test",
    query: `${tool} dominio-inexistente-zz.test`
  }));

  return [...positives, ...negatives, ...cross];
}

export function evaluateGate(entries, goldenQueries, { minScore, ambiguousScore, limit = 10 }) {
  const counters = {
    positive: { total: 0, grounded: 0, ambiguous: 0, abstain: 0 },
    negative: { total: 0, grounded: 0, ambiguous: 0, abstain: 0 },
    cross: { total: 0, grounded: 0, groundedWrongDomain: 0, ambiguous: 0, abstain: 0 }
  };

  for (const golden of goldenQueries) {
    // Emula queryVerifiedMemoryCandidates: top limit*4 por reliability/recency.
    const candidates = [...entries]
      .sort((a, b) => b.reliability - a.reliability || b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit * 4);
    const assessed = assessGroundedMemoryCandidates(candidates, {
      query: golden.query,
      minScore,
      ambiguousScore,
      limit
    });
    const memories = assessed.filter((item) => item.assessment === "correct");
    const hasAmbiguous = assessed.some((item) => item.assessment === "ambiguous");
    const status = memories.length > 0 ? "grounded" : hasAmbiguous ? "ambiguous" : "abstain";

    const bucket = counters[golden.kind];
    bucket.total += 1;
    bucket[status] += 1;
    if (golden.kind === "cross" && status === "grounded") {
      const wrongDomain = memories.every((item) => item.memory.outcomeData?.domain !== golden.domain);
      if (wrongDomain) bucket.groundedWrongDomain += 1;
    }
  }
  return counters;
}

export function sweep(entries, goldenQueries, opts = {}) {
  const min = opts.min ?? 0.3;
  const max = opts.max ?? 0.7;
  const step = opts.step ?? 0.02;
  const ambiguousScore = opts.ambiguousScore ?? 0.35;
  const rows = [];
  for (let threshold = min; threshold <= max + 1e-9; threshold += step) {
    const minScore = Number(threshold.toFixed(2));
    const result = evaluateGate(entries, goldenQueries, {
      minScore,
      ambiguousScore: Math.min(ambiguousScore, minScore)
    });
    rows.push({
      minScore,
      positiveGrounded: rate(result.positive.grounded, result.positive.total),
      negativeGrounded: rate(result.negative.grounded, result.negative.total),
      crossWrongDomain: rate(result.cross.groundedWrongDomain, result.cross.total),
      positiveAbstain: rate(result.positive.abstain, result.positive.total)
    });
  }
  return rows;
}

export function recommend(rows) {
  const safe = rows.filter((row) => row.negativeGrounded === 0 && row.crossWrongDomain === 0);
  if (safe.length === 0) return undefined;
  return safe.reduce((best, row) => (row.positiveGrounded > best.positiveGrounded ? row : best));
}

function rate(hits, total) {
  return total === 0 ? 0 : Number((hits / total).toFixed(3));
}

function rowToCalibrationEntry(row) {
  return {
    id: String(row.id),
    intentId: row.intent_id,
    step: Number(row.step),
    tool: row.tool,
    inputHash: row.input_hash,
    outcome: row.outcome,
    outcomeData: row.outcome_data ?? undefined,
    errorClass: row.error_class ?? undefined,
    source: row.source,
    trustScore: Number(row.trust_score),
    plane: row.plane,
    provenance: row.provenance ?? {},
    reliability: Number(row.reliability),
    validAt: new Date(row.valid_at ?? row.created_at),
    ttlExpiresAt: new Date(row.ttl_expires_at),
    createdAt: new Date(row.created_at),
    metadata: row.metadata ?? {}
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = args.indexOf(name);
    return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
  };
  const source = flag("--source", "db");
  const entries = source === "executions"
    ? loadVerifiedFactsFromExecutions(flag("--dir", "runtime/openclaw-workspace/executions"))
    : await loadVerifiedFactsFromDb();

  if (entries.length === 0) {
    console.error("no verified facts available; run a seed first (seed-episodic-executions.mjs or seed-episodic.mjs)");
    process.exitCode = 1;
  } else {
    const goldenQueries = buildGoldenQueries(entries);
    const rows = sweep(entries, goldenQueries, {
      min: Number(flag("--min", "0.3")),
      max: Number(flag("--max", "0.7")),
      step: Number(flag("--step", "0.02")),
      ambiguousScore: Number(flag("--ambiguous", "0.35"))
    });
    console.log(`corpus: ${entries.length} hechos verificados · queries: ${goldenQueries.length} (positivas/negativas/cruzadas)`);
    console.log("minScore  recall+  fp-  fp-x  abstain+");
    for (const row of rows) {
      console.log(
        `${row.minScore.toFixed(2).padEnd(9)} ${String(row.positiveGrounded).padEnd(8)} ${String(row.negativeGrounded).padEnd(4)} ${String(row.crossWrongDomain).padEnd(5)} ${row.positiveAbstain}`
      );
    }
    const best = recommend(rows);
    console.log(best
      ? `recomendado: OPENCLAW_GROUNDED_MIN_SCORE=${best.minScore} (recall+ ${best.positiveGrounded}, fp- 0, fp-x 0)`
      : "ningun umbral del rango elimina los falsos positivos; subir --max o revisar el corpus");
  }
}

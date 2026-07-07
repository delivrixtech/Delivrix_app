// Seed de memoria episodica derivado de EJECUCIONES REALES.
//
// Fuente: los registros markdown que el runtime de OpenClaw persiste en
// runtime/openclaw-workspace/executions/<YYYY-MM-DD>/<HHMMSS>-<tool>-<target>-<status>.md
// (Params + Evidence en bloques JSON). Cada registro se convierte en un hecho
// verificado `source=tool_output` con provenance `tool_evidence` y metadata
// `seedKind=execution_import`, claramente distinguible del seed sintetico de
// revision (`seedKind=review` en seed-episodic.mjs).
//
// Todo pasa por el write-gate real de storage: outcomeData se filtra con
// conformOutcomeData y las entradas se prevalidan completas antes de insertar
// (cero filas parciales, mismo invariante S22 del defect ledger).
//
// Uso:
//   node scripts/db/seed-episodic-executions.mjs [--dry-run] [--dir <path>]
//   OPENCLAW_EXECUTIONS_DIR=<path> node scripts/db/seed-episodic-executions.mjs
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { defaultPostgresContainer, postgresConfig, repoRoot } from "./common.mjs";
import {
  conformOutcomeData,
  insertEpisodicEntry,
  machineErrorCode,
  stableStringify,
  validateEpisodicEntryInput
} from "../../packages/storage/src/index.ts";

const { Pool } = pg;
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "postgres", defaultPostgresContainer]);
export const executionSeedVersion = "episodic-exec-import-2026-07-06";
const defaultExecutionsDir = join(repoRoot, "runtime/openclaw-workspace/executions");
const recordFilePattern = /^(\d{6})-([a-z0-9_]+)-(.+)-(success|blocked|failed)\.md$/;
const dateDirPattern = /^\d{4}-\d{2}-\d{2}$/;

export function assertEpisodicExecutionSeedAllowed(env = process.env) {
  if (env.NODE_ENV === "production") {
    throw new Error("episodic execution seed is disabled when NODE_ENV=production");
  }

  const config = postgresConfig(env);
  const parsed = new URL(config.url);
  const host = parsed.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!localHosts.has(host)) {
    throw new Error(`episodic execution seed refuses non-local POSTGRES_URL host: ${host}`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (/prod|production/i.test(database)) {
    throw new Error(`episodic execution seed refuses production-looking database name: ${database}`);
  }

  return { config };
}

export function collectExecutionRecordFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const dateDir of readdirSync(dir).filter((name) => dateDirPattern.test(name)).sort()) {
    const datePath = join(dir, dateDir);
    for (const filename of readdirSync(datePath).sort()) {
      if (recordFilePattern.test(filename)) {
        files.push({ date: dateDir, filename, path: join(datePath, filename) });
      }
    }
  }
  return files;
}

export function parseExecutionRecord({ date, filename, content }) {
  const match = recordFilePattern.exec(filename);
  if (!match) return undefined;
  const [, time, tool, target, status] = match;
  const occurredAtMatch = /- occurredAt: (\S+)/.exec(content);
  const durationMatch = /- durationMs: (\d+)/.exec(content);
  const occurredAt = occurredAtMatch ? new Date(occurredAtMatch[1]) : undefined;
  return {
    date,
    time,
    filename,
    tool,
    target,
    status,
    occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : undefined,
    durationMs: durationMatch ? Number(durationMatch[1]) : undefined,
    params: jsonSection(content, "Params"),
    evidence: jsonSection(content, "Evidence"),
    contentHash: sha256(content)
  };
}

export function buildExecutionSeedEntries(records, opts = {}) {
  const seedVersion = opts.seedVersion ?? executionSeedVersion;
  const entries = [];
  for (const record of records) {
    if (!record) continue;
    const execId = executionId(record);
    const outcome = record.status === "success" ? "success" : "failed";
    const errorClass = record.status === "success" ? undefined : executionErrorClass(record);
    const outcomeData = executionOutcomeData(record);
    entries.push({
      intentId: execId,
      step: 1,
      tool: record.tool,
      inputHash: sha256(stableStringify(record.params ?? { target: record.target })),
      outcome,
      ...(outcomeData ? { outcomeData } : {}),
      ...(errorClass ? { errorClass } : {}),
      source: "tool_output",
      plane: "verified_fact",
      reliability: record.status === "success" ? 0.85 : 0.7,
      ...(record.occurredAt ? { validAt: record.occurredAt } : {}),
      ttlDays: opts.ttlDays ?? 180,
      provenance: { kind: "tool_evidence", toolCallId: execId },
      metadata: {
        toolCallId: execId,
        seedKind: "execution_import",
        seedVersion,
        executionDate: record.date,
        executionStatus: record.status,
        executionRecordHash: record.contentHash,
        ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs })
      }
    });
  }
  return entries;
}

export async function runEpisodicExecutionSeed(options = {}) {
  const env = options.env ?? process.env;
  const dir = options.dir ?? env.OPENCLAW_EXECUTIONS_DIR ?? defaultExecutionsDir;
  const log = options.log ?? console.log;
  const files = options.files ?? collectExecutionRecordFiles(dir);
  if (files.length === 0) {
    log(`episodic execution seed: no execution records found in ${dir}`);
    log("fallback: run `node scripts/db/seed-episodic.mjs` for the synthetic review seed (seedKind=review).");
    return { files: 0, inserted: 0, skipped: 0 };
  }

  const records = [];
  let skipped = 0;
  for (const file of files) {
    const record = parseExecutionRecord({
      date: file.date,
      filename: file.filename,
      content: options.readFile ? options.readFile(file.path) : readFileSync(file.path, "utf8")
    });
    if (record) records.push(record);
    else skipped += 1;
  }

  const entries = buildExecutionSeedEntries(records, options);
  // Prevalidacion completa contra el write-gate real antes de tocar la base:
  // o entran todas las filas o ninguna (invariante S22).
  for (const entry of entries) {
    validateEpisodicEntryInput(entry);
  }

  if (options.dryRun) {
    log(`episodic execution seed (dry-run): ${entries.length} entries from ${files.length} records (${skipped} skipped) in ${dir}`);
    return { files: files.length, inserted: 0, validated: entries.length, skipped, entries };
  }

  const { config } = assertEpisodicExecutionSeedAllowed(env);
  const pool = options.pool ?? new Pool({ connectionString: config.url });
  const insert = options.insert ?? insertEpisodicEntry;
  const ownsPool = options.pool === undefined;
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO delivrix, public");
    for (const entry of entries) {
      await insert(client, entry);
    }
    await client.query("COMMIT");
    log(`episodic execution seed complete: ${entries.length} entries from ${files.length} real execution records (${skipped} skipped)`);
    return { files: files.length, inserted: entries.length, skipped };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (typeof client.release === "function") client.release();
    if (ownsPool && typeof pool.end === "function") await pool.end();
  }
}

function executionId(record) {
  const digest = sha256(`${record.date}/${record.filename}`).slice(0, 8);
  return `exec-${record.date.replaceAll("-", "")}-${record.time}-${digest}`;
}

function executionErrorClass(record) {
  const blockers = Array.isArray(record.evidence?.blockers) ? record.evidence.blockers : [];
  const primary = blockers.find((item) => typeof item === "string" && item.trim().length > 0);
  if (primary) return machineErrorCode(primary);
  if (typeof record.evidence?.error === "string") return machineErrorCode(record.evidence.error);
  return record.status === "blocked" ? "blocked" : "execution_failed";
}

function executionOutcomeData(record) {
  const evidenceScalars = {};
  if (isRecord(record.evidence)) {
    for (const [key, value] of Object.entries(record.evidence)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        evidenceScalars[key] = value;
      }
      if (key === "blockers" && Array.isArray(value)) {
        evidenceScalars.blockers = value.filter((item) => typeof item === "string");
      }
    }
  }
  const conformed = conformOutcomeData({
    ...(isRecord(record.params) ? record.params : {}),
    ...evidenceScalars,
    status: record.status
  });
  return isRecord(conformed) && Object.keys(conformed).length > 0 ? conformed : undefined;
}

function jsonSection(content, heading) {
  const pattern = new RegExp(`## ${heading}\\s*\\n+\\x60\\x60\\x60json\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`);
  const match = pattern.exec(content);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf("--dir");
  runEpisodicExecutionSeed({
    dryRun: args.includes("--dry-run"),
    ...(dirIndex !== -1 && args[dirIndex + 1] ? { dir: args[dirIndex + 1] } : {})
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

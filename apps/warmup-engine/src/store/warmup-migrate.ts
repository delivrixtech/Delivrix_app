// Runner idempotente de migraciones del warmup-engine (Track B, roadmap 5.5).
// Aplica apps/warmup-engine/migrations/*.sql en orden lexicográfico contra el pool del warmup
// (WARMUP_DB_URL con fallback a POSTGRES_URL — lo resuelve el llamador). Idempotente por partida
// doble: (1) todas las migraciones usan IF NOT EXISTS, así que re-correrlas es inofensivo; (2) una
// tabla de control `warmup_schema_migrations` registra cada archivo aplicado y salta los ya aplicados.
//
// Reglas duras:
//  - No importa 'pg': recibe el mismo `PgClient` inyectable que pg-stores.ts (Pool.query-compatible).
//    Los tests usan un fake; ningún test toca una DB real.
//  - Cada archivo .sql se ejecuta como una sola simple-query (múltiples statements por `;`), sin
//    parámetros de usuario: los nombres de archivo se validan contra una allowlist estricta antes de
//    interpolarse en el registro de control (anti-inyección: el valor viaja como $1, igual).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgClient } from "./pg-stores.ts";

/** Directorio real de migraciones del módulo (apps/warmup-engine/migrations). */
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Sólo aceptamos nombres `NNN_slug.sql` — evita que un archivo espurio se ejecute como migración. */
const MIGRATION_FILENAME = /^[0-9]{3,}_[a-z0-9_]+\.sql$/;

const CONTROL_TABLE_DDL =
  "CREATE TABLE IF NOT EXISTS warmup_schema_migrations (" +
  "filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())";

export interface RunWarmupMigrationsOptions {
  /** Override del directorio de migraciones (para tests). Default: migrations/ del módulo. */
  dir?: string;
  /** Logger opcional para trazar cada migración aplicada/saltada. */
  logger?: { info?: (message: string) => void };
}

export interface WarmupMigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Aplica las migraciones pendientes. Devuelve qué se aplicó y qué se saltó (ya registrado).
 * Es seguro invocarla en cada arranque: idempotente y sin efectos si todo está al día.
 */
export async function runWarmupMigrations(
  client: PgClient,
  options: RunWarmupMigrationsOptions = {}
): Promise<WarmupMigrationResult> {
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;

  await client.query(CONTROL_TABLE_DDL);

  const { rows } = await client.query<{ filename: string }>(
    "SELECT filename FROM warmup_schema_migrations"
  );
  const alreadyApplied = new Set(rows.map((row) => row.filename));

  const entries = await readdir(dir);
  const migrations = entries
    .filter((name) => MIGRATION_FILENAME.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of migrations) {
    if (alreadyApplied.has(filename)) {
      skipped.push(filename);
      continue;
    }
    const sql = await readFile(join(dir, filename), "utf8");
    await client.query(sql);
    await client.query(
      "INSERT INTO warmup_schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
      [filename]
    );
    applied.push(filename);
    options.logger?.info?.(`warmup migration applied: ${filename}`);
  }

  return { applied, skipped };
}

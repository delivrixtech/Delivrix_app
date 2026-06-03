import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrationFiles, runPsql } from "./common.mjs";

const directRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

export function runMigrations({
  files = migrationFiles(),
  psql = runPsql,
  log = console.log
} = {}) {
  psql(`
CREATE SCHEMA IF NOT EXISTS delivrix;
CREATE TABLE IF NOT EXISTS delivrix.schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum TEXT
);
ALTER TABLE delivrix.schema_migrations
  ADD COLUMN IF NOT EXISTS checksum TEXT;
`);

  const applied = parseAppliedMigrations(
    psql("SELECT filename || E'\\t' || COALESCE(checksum, '') FROM delivrix.schema_migrations ORDER BY filename;", {
      command: true,
      tuplesOnly: true
    })
  );

  let appliedCount = 0;
  let adoptedChecksumCount = 0;

  for (const migration of files) {
    const checksum = migrationChecksum(migration.sql);
    const storedChecksum = applied.get(migration.filename);

    if (storedChecksum !== undefined) {
      validateAppliedMigrationChecksum(migration.filename, storedChecksum, checksum);

      if (!storedChecksum) {
        psql(adoptChecksumSql(migration.filename, checksum), { command: true });
        adoptedChecksumCount += 1;
        log(`adopted checksum ${migration.filename}`);
      } else {
        log(`skip ${migration.filename}`);
      }
      continue;
    }

    for (const statement of migrationRunStatements(migration, checksum)) {
      psql(statement.sql, statement.options);
    }
    appliedCount += 1;
    log(`applied ${migration.filename}`);
  }

  log(`db:migrate complete (${appliedCount} applied, ${adoptedChecksumCount} checksums adopted)`);
  return { appliedCount, adoptedChecksumCount };
}

export function parseAppliedMigrations(output) {
  const rows = new Map();

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const [filename, checksum = ""] = line.split("\t");
    rows.set(filename, checksum);
  }

  return rows;
}

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export function hasNoTransactionSentinel(sql) {
  return /^\s*--\s*migrate:no-transaction\b/im.test(sql);
}

export function migrationRunStatements(migration, checksum = migrationChecksum(migration.sql)) {
  const insert = insertMigrationSql(migration.filename, checksum);

  if (hasNoTransactionSentinel(migration.sql)) {
    return [
      { sql: migration.sql },
      { sql: insert, options: { command: true } }
    ];
  }

  return [
    {
      sql: `
BEGIN;
${migration.sql}
${insert}
COMMIT;
`
    }
  ];
}

export function validateAppliedMigrationChecksum(filename, storedChecksum, currentChecksum) {
  if (!storedChecksum) {
    return;
  }

  if (storedChecksum !== currentChecksum) {
    throw new Error(
      `Migration checksum mismatch for ${filename}. ` +
        `Applied ${storedChecksum}, current ${currentChecksum}. ` +
        "Create a new migration instead of editing an applied migration."
    );
  }
}

export function insertMigrationSql(filename, checksum) {
  return `
INSERT INTO delivrix.schema_migrations (filename, checksum)
VALUES (${sqlLiteral(filename)}, ${sqlLiteral(checksum)})
ON CONFLICT (filename) DO UPDATE
SET checksum = EXCLUDED.checksum
WHERE delivrix.schema_migrations.checksum IS NULL
   OR delivrix.schema_migrations.checksum = '';
`;
}

export function adoptChecksumSql(filename, checksum) {
  return `
UPDATE delivrix.schema_migrations
SET checksum = ${sqlLiteral(checksum)}
WHERE filename = ${sqlLiteral(filename)}
  AND (checksum IS NULL OR checksum = '');
`;
}

export function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

if (directRun) {
  runMigrations();
}

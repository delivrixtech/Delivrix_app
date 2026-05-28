import { migrationFiles, runPsql } from "./common.mjs";

runPsql(`
CREATE SCHEMA IF NOT EXISTS delivrix;
CREATE TABLE IF NOT EXISTS delivrix.schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`);

const applied = new Set(
  runPsql("SELECT filename FROM delivrix.schema_migrations ORDER BY filename;", {
    command: true,
    tuplesOnly: true
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
);

let appliedCount = 0;

for (const migration of migrationFiles()) {
  if (applied.has(migration.filename)) {
    console.log(`skip ${migration.filename}`);
    continue;
  }

  runPsql(`
BEGIN;
${migration.sql}
INSERT INTO delivrix.schema_migrations (filename)
VALUES ('${migration.filename.replace(/'/g, "''")}')
ON CONFLICT (filename) DO NOTHING;
COMMIT;
`);
  appliedCount += 1;
  console.log(`applied ${migration.filename}`);
}

console.log(`db:migrate complete (${appliedCount} applied)`);

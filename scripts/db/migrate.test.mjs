import assert from "node:assert/strict";
import test from "node:test";
import {
  hasNoTransactionSentinel,
  migrationChecksum,
  migrationRunStatements,
  parseAppliedMigrations,
  validateAppliedMigrationChecksum
} from "./migrate.mjs";

test("migrationChecksum produces stable sha256 hex", () => {
  const checksum = migrationChecksum("SELECT 1;\n");

  assert.match(checksum, /^[0-9a-f]{64}$/);
  assert.equal(checksum, migrationChecksum("SELECT 1;\n"));
  assert.notEqual(checksum, migrationChecksum("SELECT 2;\n"));
});

test("parseAppliedMigrations reads filename and checksum rows", () => {
  const applied = parseAppliedMigrations("001_init.sql\tabc123\n002_pgvector.sql\t\n");

  assert.equal(applied.get("001_init.sql"), "abc123");
  assert.equal(applied.get("002_pgvector.sql"), "");
});

test("validateAppliedMigrationChecksum fails when an applied migration changed", () => {
  assert.throws(
    () => validateAppliedMigrationChecksum("001_init.sql", "old", "new"),
    /Migration checksum mismatch for 001_init\.sql/
  );

  assert.doesNotThrow(() => validateAppliedMigrationChecksum("001_init.sql", "", "new"));
  assert.doesNotThrow(() => validateAppliedMigrationChecksum("001_init.sql", "same", "same"));
});

test("migrationRunStatements wraps ordinary migrations in a transaction", () => {
  const statements = migrationRunStatements({
    filename: "001_init.sql",
    sql: "CREATE TABLE example(id int);"
  });

  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /BEGIN;/);
  assert.match(statements[0].sql, /COMMIT;/);
  assert.match(statements[0].sql, /INSERT INTO delivrix\.schema_migrations \(filename, checksum\)/);
});

test("migrationRunStatements keeps no-transaction migrations outside BEGIN/COMMIT", () => {
  const sql = "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx ON example(id);";
  const statements = migrationRunStatements({
    filename: "007_index.sql",
    sql
  });

  assert.equal(hasNoTransactionSentinel(sql), true);
  assert.equal(statements.length, 2);
  assert.equal(statements[0].sql, sql);
  assert.equal(statements[1].options.command, true);
  assert.equal(/BEGIN;|COMMIT;/.test(statements.map((statement) => statement.sql).join("\n")), false);
});

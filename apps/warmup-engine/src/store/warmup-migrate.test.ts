import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PgClient } from "./pg-stores.ts";
import { runWarmupMigrations } from "./warmup-migrate.ts";

interface Call {
  text: string;
  params: readonly unknown[];
}

/** Fake PgClient: registra cada query y devuelve filas canned en orden. Ninguna DB real. */
function fakeClient(responses: Array<{ rows: any[]; rowCount: number | null }> = []) {
  const calls: Call[] = [];
  let idx = 0;
  const client: PgClient = {
    async query<T = any>(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params });
      const r = responses[idx] ?? { rows: [], rowCount: 0 };
      idx += 1;
      return r as { rows: T[]; rowCount: number | null };
    }
  };
  return { client, calls };
}

function sql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function tempMigrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "warmup-migrate-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, "utf8");
  }
  return dir;
}

test("runWarmupMigrations: crea la tabla de control y aplica las migraciones pendientes en orden", async () => {
  const dir = await tempMigrationsDir({
    "002_second.sql": "CREATE TABLE IF NOT EXISTS b ();",
    "001_first.sql": "CREATE TABLE IF NOT EXISTS a ();",
    "README.md": "no soy una migración"
  });
  const { client, calls } = fakeClient([
    { rows: [], rowCount: 0 }, // CREATE TABLE control
    { rows: [], rowCount: 0 } // SELECT filenames aplicados (ninguno)
  ]);

  const result = await runWarmupMigrations(client, { dir });

  // 1) tabla de control
  assert.match(sql(calls[0].text), /CREATE TABLE IF NOT EXISTS warmup_schema_migrations/);
  // 2) select de aplicadas
  assert.match(sql(calls[1].text), /SELECT filename FROM warmup_schema_migrations/);
  // 3) orden lexicográfico: 001 antes que 002; el .md se ignora
  assert.deepEqual(result.applied, ["001_first.sql", "002_second.sql"]);
  assert.deepEqual(result.skipped, []);
  // cada migración: ejecuta el SQL y registra el filename como param
  assert.match(sql(calls[2].text), /CREATE TABLE IF NOT EXISTS a/);
  assert.match(sql(calls[3].text), /INSERT INTO warmup_schema_migrations \(filename\) VALUES \(\$1\)/);
  assert.deepEqual(calls[3].params, ["001_first.sql"]);
  assert.match(sql(calls[4].text), /CREATE TABLE IF NOT EXISTS b/);
  assert.deepEqual(calls[5].params, ["002_second.sql"]);
});

test("runWarmupMigrations: idempotente — salta las ya registradas en la tabla de control", async () => {
  const dir = await tempMigrationsDir({
    "001_first.sql": "CREATE TABLE IF NOT EXISTS a ();",
    "002_second.sql": "CREATE TABLE IF NOT EXISTS b ();"
  });
  const { client, calls } = fakeClient([
    { rows: [], rowCount: 0 }, // CREATE control
    { rows: [{ filename: "001_first.sql" }], rowCount: 1 } // 001 ya aplicada
  ]);

  const result = await runWarmupMigrations(client, { dir });
  assert.deepEqual(result.applied, ["002_second.sql"]);
  assert.deepEqual(result.skipped, ["001_first.sql"]);
  // sólo se ejecuta la 002 + su registro (2 queries tras el select)
  assert.equal(calls.length, 4);
});

test("runWarmupMigrations: nada pendiente ⇒ applied vacío, todas skipped", async () => {
  const dir = await tempMigrationsDir({ "001_first.sql": "CREATE TABLE IF NOT EXISTS a ();" });
  const { client } = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [{ filename: "001_first.sql" }], rowCount: 1 }
  ]);
  const result = await runWarmupMigrations(client, { dir });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, ["001_first.sql"]);
});

test("runWarmupMigrations: contra las migraciones reales del módulo aplica 001 y 002", async () => {
  const { client } = fakeClient([
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 }
  ]);
  const result = await runWarmupMigrations(client);
  assert.ok(result.applied.includes("001_init.sql"));
  assert.ok(result.applied.includes("002_engaged_recipients.sql"));
  // orden: 001 antes que 002
  assert.ok(result.applied.indexOf("001_init.sql") < result.applied.indexOf("002_engaged_recipients.sql"));
});

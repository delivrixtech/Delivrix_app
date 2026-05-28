import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const migrationDir = join(repoRoot, "infra/postgres/migrations");
export const seedFile = join(repoRoot, "infra/postgres/seed/seed-dev.sql");

export function postgresConfig() {
  const url = new URL(process.env.POSTGRES_URL ?? "postgres://delivrix:delivrix_dev_password@localhost:5432/delivrix_mailops");
  return {
    container: process.env.POSTGRES_CONTAINER ?? "delivrix-postgres",
    user: decodeURIComponent(url.username || "delivrix"),
    database: decodeURIComponent(url.pathname.replace(/^\//, "") || "delivrix_mailops")
  };
}

export function runPsql(sql, options = {}) {
  const config = postgresConfig();
  const args = [
    "exec",
    "-i",
    config.container,
    "psql",
    "-U",
    config.user,
    "-d",
    config.database,
    "-v",
    "ON_ERROR_STOP=1"
  ];

  if (options.tuplesOnly) {
    args.push("-At");
  }

  if (options.command) {
    args.push("-c", sql);
    return execFileSync("docker", args, { encoding: "utf8" });
  }

  return execFileSync("docker", args, { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
}

export function migrationFiles() {
  return readdirSync(migrationDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      filename: file,
      sql: readFileSync(join(migrationDir, file), "utf8")
    }));
}

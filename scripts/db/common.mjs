import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const migrationDir = join(repoRoot, "infra/postgres/migrations");
export const seedFile = join(repoRoot, "infra/postgres/seed/seed-dev.sql");
export const defaultPostgresUrl = "postgres://delivrix:delivrix_dev_password@localhost:5432/delivrix_mailops";
export const defaultPostgresContainer = "delivrix-postgres";

export function postgresConfig(env = process.env) {
  const hasExplicitUrl = Boolean(env.POSTGRES_URL);
  const rawUrl = env.POSTGRES_URL ?? defaultPostgresUrl;
  const url = new URL(rawUrl);
  const host = normalizeHost(url.hostname);
  const targetsDefaultContainer = host === defaultPostgresContainer || host === "postgres";
  const container = env.POSTGRES_CONTAINER || (!hasExplicitUrl || targetsDefaultContainer ? defaultPostgresContainer : "");
  const isContainerTarget = container && (isLocalHost(host) || host === normalizeHost(container) || host === "postgres");

  if (container && !isContainerTarget) {
    throw new Error(
      `POSTGRES_CONTAINER=${container} can only be used with a local/container POSTGRES_URL. ` +
        "Unset POSTGRES_CONTAINER to run psql directly against a non-container URL."
    );
  }

  const password = decodeURIComponent(url.password);
  const psqlUrl = new URL(url.toString());
  psqlUrl.password = "";

  return {
    mode: isContainerTarget ? "container" : "direct",
    url: rawUrl,
    psqlUrl: psqlUrl.toString(),
    password,
    container: container || null,
    user: decodeURIComponent(url.username || "delivrix"),
    database: decodeURIComponent(url.pathname.replace(/^\//, "") || "delivrix_mailops")
  };
}

export function runPsql(sql, options = {}) {
  const invocation = buildPsqlInvocation(sql, options);
  return execFileSync(invocation.command, invocation.args, invocation.execOptions);
}

export function buildPsqlInvocation(sql, options = {}, env = process.env) {
  const config = postgresConfig(env);
  const args = config.mode === "container"
    ? [
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
      ]
    : [
        config.psqlUrl,
        "-v",
        "ON_ERROR_STOP=1"
      ];

  if (options.tuplesOnly) {
    args.push("-At");
  }

  const execOptions = config.mode === "direct" && config.password
    ? { env: { ...process.env, PGPASSWORD: config.password } }
    : {};

  if (options.command) {
    args.push("-c", sql);
    return {
      command: config.mode === "container" ? "docker" : "psql",
      args,
      execOptions: { ...execOptions, encoding: "utf8" }
    };
  }

  return {
    command: config.mode === "container" ? "docker" : "psql",
    args,
    execOptions: { ...execOptions, input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }
  };
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

function normalizeHost(host) {
  return host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function isLocalHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

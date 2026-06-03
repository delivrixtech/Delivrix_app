import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPostgresContainer, postgresConfig, repoRoot } from "./common.mjs";

const composeFile = join(repoRoot, "infra/docker-compose.yml");
const directRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

export async function main({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  exec = execFileSync
} = {}) {
  await assertResetAllowed({ env, stdin, stdout });
  const postgres = postgresConfig({ ...env, POSTGRES_CONTAINER: env.POSTGRES_CONTAINER ?? defaultPostgresContainer });
  const postgresContainer = postgres.container ?? defaultPostgresContainer;

  exec("docker", ["compose", "-f", composeFile, "down", "-v"], { stdio: "inherit" });
  exec("docker", ["compose", "-f", composeFile, "up", "-d"], { stdio: "inherit" });

  waitForService("postgres", () => {
    exec("docker", ["exec", postgresContainer, "pg_isready", "-U", postgres.user, "-d", postgres.database], { stdio: "ignore" });
  });
  waitForService("redis", () => {
    exec("docker", ["exec", "delivrix-redis", "redis-cli", "ping"], { stdio: "ignore" });
  });
  exec("npm", ["run", "db:migrate"], { cwd: repoRoot, stdio: "inherit" });
  exec("npm", ["run", "db:seed"], { cwd: repoRoot, stdio: "inherit" });
}

export async function assertResetAllowed({ env = process.env, stdin = process.stdin, stdout = process.stdout } = {}) {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing db:reset while NODE_ENV=production.");
  }

  if (env.DELIVRIX_CONFIRM_RESET === "1") {
    return;
  }

  if (!stdin.isTTY) {
    throw new Error("Refusing db:reset without DELIVRIX_CONFIRM_RESET=1 in a non-interactive shell.");
  }

  const answer = await promptResetConfirmation({ stdin, stdout });
  if (answer !== "RESET") {
    throw new Error("Refusing db:reset because the confirmation prompt was not accepted.");
  }
}

export async function promptResetConfirmation({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question("db:reset deletes the local Postgres volume. Type RESET to continue: ")).trim();
  } finally {
    rl.close();
  }
}

function waitForService(name, check, timeoutMs = 30_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      check();
      console.log(`${name} healthy`);
      return;
    } catch {
      sleep(1_000);
    }
  }

  throw new Error(`${name} did not become healthy within ${timeoutMs}ms`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (directRun) {
  await main();
}

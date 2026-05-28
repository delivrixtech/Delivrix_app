import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "./common.mjs";

const composeFile = join(repoRoot, "infra/docker-compose.yml");

execFileSync("docker", ["compose", "-f", composeFile, "down", "-v"], { stdio: "inherit" });
execFileSync("docker", ["compose", "-f", composeFile, "up", "-d"], { stdio: "inherit" });
waitForService("postgres", () => {
  execFileSync("docker", ["exec", "delivrix-postgres", "pg_isready", "-U", "delivrix", "-d", "delivrix_mailops"], { stdio: "ignore" });
});
waitForService("redis", () => {
  execFileSync("docker", ["exec", "delivrix-redis", "redis-cli", "ping"], { stdio: "ignore" });
});
execFileSync("npm", ["run", "db:migrate"], { cwd: repoRoot, stdio: "inherit" });
execFileSync("npm", ["run", "db:seed"], { cwd: repoRoot, stdio: "inherit" });

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

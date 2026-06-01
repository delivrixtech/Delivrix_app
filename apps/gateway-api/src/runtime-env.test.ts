import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { createRuntimeEnvReloader, parseRuntimeEnvFile } from "./runtime-env.ts";

test("parseRuntimeEnvFile only returns allowlisted runtime flags", () => {
  assert.deepEqual(parseRuntimeEnvFile([
    "# ignored",
    "WEBDOCK_SERVERS_ENABLE_CREATE=true",
    "AWS_BEDROCK_SECRET_ACCESS_KEY=must-not-load",
    "SMTP_PROVISIONING_ENABLE_SSH=\"true\"",
    "SEND_REAL_EMAIL_ENABLE='false'"
  ].join("\n")), {
    WEBDOCK_SERVERS_ENABLE_CREATE: "true",
    SMTP_PROVISIONING_ENABLE_SSH: "true",
    SEND_REAL_EMAIL_ENABLE: "false"
  });
});

test("runtime env reloader updates operational flags without process restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-runtime-env-"));
  const envFilePath = join(dir, ".env.local");
  const env: NodeJS.ProcessEnv = {
    WEBDOCK_SERVERS_ENABLE_CREATE: "false"
  };
  const reloader = createRuntimeEnvReloader({ env, envFilePath, intervalMs: 60 });

  await writeFile(envFilePath, "WEBDOCK_SERVERS_ENABLE_CREATE=true\nAWS_BEDROCK_SECRET_ACCESS_KEY=ignored\n", "utf8");
  const first = await reloader.refreshNow();

  assert.equal(env.WEBDOCK_SERVERS_ENABLE_CREATE, "true");
  assert.equal(first.WEBDOCK_SERVERS_ENABLE_CREATE, "true");
  assert.equal(env.AWS_BEDROCK_SECRET_ACCESS_KEY, undefined);

  await writeFile(envFilePath, "WEBDOCK_SERVERS_ENABLE_CREATE=false\n", "utf8");
  const second = await reloader.refreshNow();

  assert.equal(env.WEBDOCK_SERVERS_ENABLE_CREATE, "false");
  assert.equal(second.WEBDOCK_SERVERS_ENABLE_CREATE, "false");
});

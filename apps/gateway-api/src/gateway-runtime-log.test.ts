import assert from "node:assert/strict";
import test from "node:test";
import {
  formatGatewayRuntimeLogLine,
  redactRuntimeLogSecrets,
  summarizeOperationalParams
} from "./gateway-runtime-log.ts";

test("runtime log line is structured and redacts sensitive metadata", () => {
  const line = formatGatewayRuntimeLogLine({
    ts: "2026-06-01T14:00:00.000Z",
    level: "error",
    event: "OpenClaw Bedrock Failed!",
    message: "Bedrock failed with Authorization: Bearer abc.def",
    metadata: {
      proposalId: "p-1",
      missing: undefined,
      apiKey: "secret",
      nested: { token: "hidden", domain: "controldelivrix.app" }
    }
  });

  assert.match(line, /^2026-06-01T14:00:00\.000Z \[error\] event=openclaw_bedrock_failed_/);
  assert.match(line, /proposalId/);
  assert.match(line, /controldelivrix\.app/);
  assert.doesNotMatch(line, /abc\.def/);
  assert.doesNotMatch(line, /secret/);
  assert.doesNotMatch(line, /hidden/);
  assert.doesNotMatch(line, /undefined/);
});

test("runtime log redacts common credential forms", () => {
  const redacted = redactRuntimeLogSecrets("token=abc Bearer xyz AKIA1234567890ABCDEF password=supersecret");

  assert.doesNotMatch(redacted, /abc/);
  assert.doesNotMatch(redacted, /xyz/);
  assert.doesNotMatch(redacted, /AKIA1234567890ABCDEF/);
  assert.doesNotMatch(redacted, /supersecret/);
});

test("summarizeOperationalParams keeps only useful non-secret operator fields", () => {
  assert.deepEqual(summarizeOperationalParams({
    domain: "controldelivrix.app",
    serverSlug: "server10",
    password: "hidden",
    dkimPrivateKey: "hidden",
    budgetUsdMax: 30
  }), {
    budgetUsdMax: 30,
    domain: "controldelivrix.app",
    serverSlug: "server10"
  });
});

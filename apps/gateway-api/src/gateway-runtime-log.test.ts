import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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

test("runtime log redacts SMTP-adjacent secret assignments without hiding hosts", () => {
  const redacted = redactRuntimeLogSecrets([
    "smtp: Xk9mPq2vLr7wNb3tQ4sA9vLm",
    "sasl=Yp8mQw2nAs6bLc9dRf3tHg7j",
    "dovecot: smtp.controlnationalreport.com"
  ].join("\n"));

  assert.doesNotMatch(redacted, /Xk9mPq2vLr7wNb3tQ4sA9vLm/);
  assert.doesNotMatch(redacted, /Yp8mQw2nAs6bLc9dRf3tHg7j/);
  assert.match(redacted, /smtp=\[REDACTED\]/);
  assert.match(redacted, /sasl=\[REDACTED\]/);
  assert.match(redacted, /smtp\.controlnationalreport\.com/);
});

test("runtime log redacts complete, partial, and body-only PEM private keys before caps", () => {
  const pem = generatedPrivateKeyPem();
  const keyLine = pemBodyLine(pem);
  const partialPem = pem.slice(0, 500);
  const redacted = redactRuntimeLogSecrets(`${pem}\n${partialPem}`);
  const bodyOnly = redactRuntimeLogSecrets(keyLine);

  assert.match(redacted, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(redacted, /\[REDACTED_PARTIAL_KEY\]/);
  assert.equal(bodyOnly, "[REDACTED_PEM_BODY]");
  assert.doesNotMatch(redacted, /-----BEGIN PRIVATE KEY-----/);
  assert.doesNotMatch(redacted, /-----END PRIVATE KEY-----/);
  assert.equal(redacted.includes(keyLine), false);
});

test("runtime log redacts metadata strings before truncating them", () => {
  const pem = generatedPrivateKeyPem();
  const keyLine = pemBodyLine(pem);
  const line = formatGatewayRuntimeLogLine({
    ts: "2026-06-01T14:00:00.000Z",
    level: "error",
    event: "OpenClaw PEM leak",
    message: "tool failed",
    metadata: {
      details: `stderr=${pem}`,
      message: pem.slice(0, 500)
    }
  });

  assert.doesNotMatch(line, /-----BEGIN PRIVATE KEY-----/);
  assert.doesNotMatch(line, /-----END PRIVATE KEY-----/);
  assert.equal(line.includes(keyLine), false);
  assert.match(line, /\[REDACTED_PRIVATE_KEY\]|\[REDACTED_PARTIAL_KEY\]/);
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

function generatedPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  }).privateKey;
}

function pemBodyLine(pem: string): string {
  const line = pem.split(/\r?\n/).find((candidate) => /^[A-Za-z0-9+/]{48,}={0,2}$/.test(candidate));
  assert.ok(line);
  return line;
}

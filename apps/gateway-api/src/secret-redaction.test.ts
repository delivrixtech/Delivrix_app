import assert from "node:assert/strict";
import test from "node:test";
import {
  chatSensitiveAssignmentKeyPattern,
  isAlwaysSensitiveChatKey,
  isSensitiveKeyName,
  looksLikeSecretLiteral,
  sensitiveAssignmentKeyPattern
} from "./secret-redaction.ts";
import { redactRuntimeLogSecrets } from "./gateway-runtime-log.ts";
import { redactChatHistoryText } from "./routes/openclaw-chat-history.ts";

test("shared secret redaction helpers classify tokens without hiding operational identifiers", () => {
  assert.equal(looksLikeSecretLiteral("0123456789abcdef0123456789abcdef"), true);
  assert.equal(looksLikeSecretLiteral("Xk9mPq2vLr7wNb3tQ4sA9vLm"), true);
  assert.equal(looksLikeSecretLiteral("smtp.controlnationalreport.com"), false);
  assert.equal(looksLikeSecretLiteral("203.0.113.10"), false);
  assert.equal(looksLikeSecretLiteral("server10"), false);
  assert.equal(looksLikeSecretLiteral("hash:abcdef0123456789abcdef0123456789"), false);
});

test("shared redaction key patterns stay aligned across runtime logs and chat history", () => {
  assert.match("password", new RegExp(`^(${sensitiveAssignmentKeyPattern})$`, "i"));
  assert.match("api_key", new RegExp(`^(${sensitiveAssignmentKeyPattern})$`, "i"));
  assert.match("smtp_password", new RegExp(`^(${sensitiveAssignmentKeyPattern})$`, "i"));
  assert.match("approval_token", new RegExp(`^(${sensitiveAssignmentKeyPattern})$`, "i"));
  assert.match("smtp password", new RegExp(`^(${chatSensitiveAssignmentKeyPattern})$`, "i"));
  assert.match("approval token", new RegExp(`^(${chatSensitiveAssignmentKeyPattern})$`, "i"));
  assert.equal(isSensitiveKeyName("smtpPassword"), true);
  assert.equal(isSensitiveKeyName("domain"), false);
  assert.equal(isAlwaysSensitiveChatKey("password"), true);
  assert.equal(isAlwaysSensitiveChatKey("smtp"), false);
});

test("shared redaction covers JSON and bare secret assignments on runtime logs and chat history", () => {
  const payload = [
    "{\"password\":\"json-password\"}",
    "{\"smtp_password\":\"json-smtp-password\"}",
    "{\"approval_token\":\"json-approval-token\"}",
    "smtp_password=bare-smtp-password",
    "ip 193.181.213.29",
    "host smtp.corpfiling-ops.com",
    "slug server85"
  ].join("\n");

  for (const redacted of [
    redactRuntimeLogSecrets(payload),
    redactChatHistoryText(payload)
  ]) {
    assert.doesNotMatch(redacted, /json-password/);
    assert.doesNotMatch(redacted, /json-smtp-password/);
    assert.doesNotMatch(redacted, /json-approval-token/);
    assert.doesNotMatch(redacted, /bare-smtp-password/);
    assert.match(redacted, /"password"\s*:\s*"\[REDACTED\]"/);
    assert.match(redacted, /"smtp_password"\s*:\s*"\[REDACTED\]"/);
    assert.match(redacted, /"approval_token"\s*:\s*"\[REDACTED\]"/);
    assert.match(redacted, /smtp_password=\[REDACTED\]/);
    assert.equal(redacted.split("\n").find((line) => line.startsWith("smtp_password=")), "smtp_password=[REDACTED]");
    assert.match(redacted, /193\.181\.213\.29/);
    assert.match(redacted, /smtp\.corpfiling-ops\.com/);
    assert.match(redacted, /server85/);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  chatSensitiveAssignmentKeyPattern,
  isAlwaysSensitiveChatKey,
  isSensitiveKeyName,
  looksLikeSecretLiteral,
  sensitiveAssignmentKeyPattern
} from "./secret-redaction.ts";

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
  assert.match("smtp password", new RegExp(`^(${chatSensitiveAssignmentKeyPattern})$`, "i"));
  assert.match("approval token", new RegExp(`^(${chatSensitiveAssignmentKeyPattern})$`, "i"));
  assert.equal(isSensitiveKeyName("smtpPassword"), true);
  assert.equal(isSensitiveKeyName("domain"), false);
  assert.equal(isAlwaysSensitiveChatKey("password"), true);
  assert.equal(isAlwaysSensitiveChatKey("smtp"), false);
});

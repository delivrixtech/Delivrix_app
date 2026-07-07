import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyGithubSignature } from "./webhook-hmac.ts";

const secret = "supersecret";
const body = JSON.stringify({ action: "opened", number: 1 });
const valid = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

test("verifyGithubSignature acepta una firma valida", () => {
  assert.equal(verifyGithubSignature(body, valid, secret), true);
});

test("verifyGithubSignature rechaza firma alterada, secreto incorrecto o header ausente", () => {
  assert.equal(verifyGithubSignature(body, valid, "otro-secreto-de-igual-uso"), false);
  assert.equal(verifyGithubSignature(`${body}x`, valid, secret), false);
  assert.equal(verifyGithubSignature(body, undefined, secret), false);
  assert.equal(verifyGithubSignature(body, "sha256=deadbeef", secret), false);
  assert.equal(verifyGithubSignature(body, valid, ""), false);
});

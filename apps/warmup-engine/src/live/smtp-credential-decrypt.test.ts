import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import {
  resolveCredentialKey,
  decryptInventoryCredential,
  findAndDecryptBox,
  encryptForTest,
  type InventoryCredentialStore
} from "./smtp-credential-decrypt.ts";

const key = randomBytes(32);

function record(domain: string, password: string) {
  const host = "smtp." + domain;
  const username = "mailer@" + domain;
  return { domain, host, username, smtpCredentialEncrypted: encryptForTest(password, key, { domain, host, username }) };
}

test("round-trip: encripta y desencripta el password con AAD correcto", () => {
  const rec = record("infranationalcorp.com", "s3cr3t-pass");
  assert.equal(decryptInventoryCredential(rec, key), "s3cr3t-pass");
});

test("AAD manipulada ⇒ falla (auth tag no valida)", () => {
  const rec = record("infranationalcorp.com", "abc");
  const tampered = { ...rec, domain: "otro.com" }; // cambia el AAD
  assert.throws(() => decryptInventoryCredential(tampered, key));
});

test("findAndDecryptBox encuentra por dominio y desencripta", () => {
  const store: InventoryCredentialStore = { smtpCredentials: [record("a.com", "pa"), record("b.com", "pb")] };
  const { record: rec, password } = findAndDecryptBox(store, "b.com", key);
  assert.equal(rec.username, "mailer@b.com");
  assert.equal(password, "pb");
});

test("findAndDecryptBox lanza si el box no está", () => {
  const store: InventoryCredentialStore = { smtpCredentials: [record("a.com", "pa")] };
  assert.throws(() => findAndDecryptBox(store, "nope.com", key), /no_smtp_credential_for_box/);
});

test("resolveCredentialKey acepta base64/hex/utf8 de 32 bytes y rechaza el resto", () => {
  assert.equal(resolveCredentialKey(key.toString("base64")).length, 32);
  assert.equal(resolveCredentialKey(key.toString("hex")).length, 32);
  assert.equal(resolveCredentialKey("x".repeat(32)).length, 32);
  assert.throws(() => resolveCredentialKey(""), /missing/);
  assert.throws(() => resolveCredentialKey("corto"), /invalid/);
});

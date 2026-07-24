import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import { generateOpsSshKeyPair, sanitizeComment } from "./ssh-ops-key.ts";

function parseAuthorizedKeysRsa(line: string): { e: Buffer; n: Buffer } {
  const parts = line.split(" ");
  assert.equal(parts[0], "ssh-rsa");
  const blob = Buffer.from(parts[1] ?? "", "base64");
  let offset = 0;
  const readString = (): Buffer => {
    const length = blob.readUInt32BE(offset);
    offset += 4;
    const out = blob.subarray(offset, offset + length);
    offset += length;
    return out;
  };
  const type = readString();
  assert.equal(type.toString("utf8"), "ssh-rsa");
  const e = readString();
  const n = readString();
  assert.equal(offset, blob.length, "no debe sobrar bytes en el blob");
  return { e, n };
}

function mpintToBase64url(value: Buffer): string {
  // Quitar el único byte de signo 0x00 que agrega el wire format cuando el bit alto está prendido.
  const magnitude = value.length > 1 && value[0] === 0 ? value.subarray(1) : value;
  return magnitude.toString("base64url");
}

test("generateOpsSshKeyPair: PEM privada + authorized_keys que corresponde a la privada", () => {
  const { privateKeyPem, authorizedKeysLine } = generateOpsSshKeyPair("delivrix-ops@example.com");

  assert.match(privateKeyPem, /-----BEGIN PRIVATE KEY-----/);
  assert.match(authorizedKeysLine, /^ssh-rsa [A-Za-z0-9+/=]+ delivrix-ops@example\.com$/);

  // Reconstruir la pública desde la línea authorized_keys (lo que se instala en el box).
  const { e, n } = parseAuthorizedKeysRsa(authorizedKeysLine);
  const publicFromLine = createPublicKey({
    key: { kty: "RSA", n: mpintToBase64url(n), e: mpintToBase64url(e) },
    format: "jwk"
  });

  // Firmar con la privada entregada y verificar con la pública instalada => corresponden.
  const privateKey = createPrivateKey(privateKeyPem);
  const message = Buffer.from("delivrix-ops-ssh-roundtrip");
  const signature = sign("sha256", message, privateKey);
  assert.equal(verify("sha256", message, publicFromLine, signature), true);
});

test("generateOpsSshKeyPair: cada llamada genera una clave distinta", () => {
  const a = generateOpsSshKeyPair("delivrix-ops@host");
  const b = generateOpsSshKeyPair("delivrix-ops@host");
  assert.notEqual(a.authorizedKeysLine, b.authorizedKeysLine);
  assert.notEqual(a.privateKeyPem, b.privateKeyPem);
});

test("sanitizeComment: una sola linea, sin caracteres raros, fallback si queda vacio", () => {
  assert.equal(sanitizeComment("delivrix-ops@host"), "delivrix-ops@host");
  assert.equal(sanitizeComment("a b\nc"), "a_b_c");
  assert.equal(sanitizeComment("!!!"), "delivrix-ops");
});

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createAppJwt, getInstallationToken } from "./app-auth.ts";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();

test("createAppJwt produce un JWT RS256 verificable con claims correctos", () => {
  const now = 1_000_000;
  const jwt = createAppJwt("4090313", privatePem, now);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  assert.equal(header.alg, "RS256");
  assert.equal(payload.iss, "4090313");
  assert.equal(payload.iat, now - 60);
  assert.equal(payload.exp, now + 540);

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  assert.equal(verifier.verify(publicPem, Buffer.from(parts[2], "base64url")), true);
});

test("getInstallationToken intercambia el JWT por un installation token", async () => {
  let capturedAuth = "";
  const fetchImpl = (async (_url: any, init: any) => {
    capturedAuth = init.headers.authorization;
    return {
      ok: true,
      status: 201,
      json: async () => ({ token: "ghs_abc", expires_at: "2026-06-18T23:00:00Z" }),
      text: async () => ""
    };
  }) as unknown as typeof fetch;

  const result = await getInstallationToken({
    appId: "4090313",
    privateKeyPem: privatePem,
    installationId: 141217494,
    fetchImpl
  });
  assert.equal(result.token, "ghs_abc");
  assert.match(capturedAuth, /^Bearer eyJ/);
});

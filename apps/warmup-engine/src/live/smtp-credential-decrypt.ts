// Desencriptado de la credencial SMTP del box para el daemon LIVE del warmup.
//
// Espeja la cripto PROBADA del gateway (apps/gateway-api/src/smtp-credentials.ts): AES-256-GCM con
// AAD={domain,host,username} y la misma resolución de clave (base64url/base64/hex/utf8 → 32 bytes).
// La diferencia: el daemon lee el store de ARCHIVO (runtime/openclaw-workspace/inventory/
// smtp-credentials.json), no la DB. Nunca loguea el password ni la clave.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export interface EncryptedPayload {
  algorithm: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface InventoryCredentialRecord {
  domain: string;
  host: string;
  username: string;
  smtpCredentialEncrypted: EncryptedPayload;
}

export interface InventoryCredentialStore {
  smtpCredentials: InventoryCredentialRecord[];
}

/** Resuelve la CREDENTIAL_ENCRYPTION_KEY cruda a un Buffer de 32 bytes (o lanza). Igual que el gateway. */
export function resolveCredentialKey(raw: string | undefined): Buffer {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) throw new Error("credential_encryption_key_missing");
  const candidates = [
    Buffer.from(trimmed, "base64url"),
    Buffer.from(trimmed, "base64"),
    /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.alloc(0),
    Buffer.from(trimmed, "utf8")
  ];
  const key = candidates.find((c) => c.length === 32);
  if (!key) throw new Error("credential_encryption_key_invalid");
  return key;
}

/** Desencripta el password de un registro del inventario. AAD={domain,host,username}. */
export function decryptInventoryCredential(record: InventoryCredentialRecord, key: Buffer): string {
  const payload = record.smtpCredentialEncrypted;
  if (payload.algorithm !== ALGORITHM) throw new Error("smtp_credential_unsupported_algorithm");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64url"));
  decipher.setAAD(Buffer.from(JSON.stringify({ domain: record.domain, host: record.host, username: record.username })));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

/** Busca el box por dominio en el store y devuelve el registro + su password desencriptado. */
export function findAndDecryptBox(
  store: InventoryCredentialStore,
  domain: string,
  key: Buffer
): { record: InventoryCredentialRecord; password: string } {
  const record = store.smtpCredentials.find((c) => c.domain === domain);
  if (!record) throw new Error(`no_smtp_credential_for_box:${domain}`);
  return { record, password: decryptInventoryCredential(record, key) };
}

/** Sólo para tests: encripta con la misma cripto/AAD, para round-trips sin tocar la clave real. */
export function encryptForTest(
  password: string,
  key: Buffer,
  aad: { domain: string; host: string; username: string }
): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return {
    algorithm: ALGORITHM,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

// Generación del par de claves para el usuario SSH "ops" dedicado por nodo SMTP.
//
// La clave es DISTINTA de la clave root de la automatización (SMTP_PROVISION_SSH_KEY_PATH):
// se genera una por nodo, la privada se entrega cifrada al operador y es revocable sin
// tocar la automatización. Usamos RSA-3072 con la privada en PKCS#8 PEM porque `ssh -i`
// la acepta en cualquier versión de OpenSSH del VPS (un ed25519 en PKCS#8 puede fallar en
// clientes viejos). La pública se codifica al formato `authorized_keys` (ssh-rsa <blob>).

import { generateKeyPairSync, type KeyObject } from "node:crypto";

export interface OpsSshKeyPair {
  /** Clave privada PKCS#8 PEM. OpenSSH la lee con `ssh -i`. */
  privateKeyPem: string;
  /** Línea lista para authorized_keys: `ssh-rsa <base64> <comentario>`. */
  authorizedKeysLine: string;
}

const RSA_MODULUS_BITS = 3072;

export function generateOpsSshKeyPair(comment: string): OpsSshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: RSA_MODULUS_BITS
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const authorizedKeysLine = `ssh-rsa ${encodeRsaOpensshBase64(publicKey)} ${sanitizeComment(comment)}`.trimEnd();
  return { privateKeyPem, authorizedKeysLine };
}

/**
 * Codifica una clave pública RSA al blob base64 del formato OpenSSH:
 * string("ssh-rsa") || mpint(e) || mpint(n).
 */
export function encodeRsaOpensshBase64(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { n?: string; e?: string };
  if (!jwk.n || !jwk.e) {
    throw new Error("rsa public key export missing modulus/exponent");
  }
  const modulus = Buffer.from(jwk.n, "base64url");
  const exponent = Buffer.from(jwk.e, "base64url");
  const blob = Buffer.concat([
    sshString(Buffer.from("ssh-rsa", "utf8")),
    sshMpint(exponent),
    sshMpint(modulus)
  ]);
  return blob.toString("base64");
}

/** Prefijo de longitud (uint32 big-endian) + bytes, según el wire format SSH. */
function sshString(buffer: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(buffer.length, 0);
  return Buffer.concat([length, buffer]);
}

/**
 * Entero con signo del wire format SSH: magnitud big-endian mínima, con un 0x00
 * delante si el bit alto está prendido (para que quede positivo).
 */
function sshMpint(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) {
    start += 1;
  }
  let magnitude = value.subarray(start);
  if (magnitude.length > 0 && (magnitude[0]! & 0x80) !== 0) {
    magnitude = Buffer.concat([Buffer.from([0x00]), magnitude]);
  }
  return sshString(magnitude);
}

/** Comentario seguro para authorized_keys (una sola línea, sin espacios raros). */
export function sanitizeComment(comment: string): string {
  const cleaned = comment
    .replace(/[^A-Za-z0-9@._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return cleaned.length > 0 ? cleaned : "delivrix-ops";
}

// Verificacion de la firma del webhook de GitHub (X-Hub-Signature-256).
// GitHub firma el cuerpo crudo con HMAC-SHA256 usando el webhook secret.
// Comparacion en tiempo constante. Mismo principio que apps/gateway-api hmac.ts.

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || secret.length === 0) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

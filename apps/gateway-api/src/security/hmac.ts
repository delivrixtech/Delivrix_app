import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const timestampToleranceSeconds = 60;

export type HmacRejectReason =
  | "hmac_missing"
  | "hmac_timestamp_drift"
  | "hmac_invalid"
  | "hmac_secret_unconfigured";

export type HmacValidation =
  | { ok: true }
  | { ok: false; rejectReason: HmacRejectReason };

export function validateOpenClawHmac(
  headers: IncomingHttpHeaders,
  rawBody: string,
  nowMs = Date.now()
): HmacValidation {
  const secret = process.env.OPENCLAW_HMAC_SECRET ?? "";

  if (!secret) {
    return { ok: false, rejectReason: "hmac_secret_unconfigured" };
  }

  const signature = singleHeader(headers["x-openclaw-signature"])?.replace(/^sha256=/, "");
  const timestamp = singleHeader(headers["x-openclaw-timestamp"]);

  if (!signature || !timestamp) {
    return { ok: false, rejectReason: "hmac_missing" };
  }

  const timestampSeconds = Number(timestamp);

  if (!Number.isFinite(timestampSeconds)) {
    return { ok: false, rejectReason: "hmac_missing" };
  }

  const nowSeconds = Math.floor(nowMs / 1000);

  if (Math.abs(nowSeconds - timestampSeconds) > timestampToleranceSeconds) {
    return { ok: false, rejectReason: "hmac_timestamp_drift" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  return signaturesEqual(signature, expected)
    ? { ok: true }
    : { ok: false, rejectReason: "hmac_invalid" };
}

export function signOpenClawPayload(rawBody: string, timestampSeconds: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function signaturesEqual(signature: string, expected: string): boolean {
  if (!/^[a-f0-9]+$/i.test(signature)) {
    return false;
  }

  const actualBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { validateOpenClawHmac } from "./hmac.ts";

export function validateGatewayMutationHmac(
  request: IncomingMessage,
  raw: string,
  nowMs = Date.now()
): { ok: true } | { ok: false; rejectReason: string } {
  return validateOpenClawHmac(request.headers, raw, nowMs);
}

export function operatorIdFromHeaders(headers: IncomingHttpHeaders): string | null {
  const value = headers["x-operator-id"];
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

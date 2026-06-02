import type { IncomingMessage } from "node:http";
import { validateOpenClawHmac } from "./hmac.ts";

export function validateRunbookExecuteAuthorization(
  request: IncomingMessage,
  raw: string,
  nowMs = Date.now()
): { ok: true } | { ok: false; rejectReason: string } {
  return validateOpenClawHmac(request.headers, raw, nowMs);
}

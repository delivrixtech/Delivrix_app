import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { signOpenClawPayload } from "./hmac.ts";
import { validateRunbookExecuteAuthorization } from "./runbook-authorization.ts";

process.env.OPENCLAW_HMAC_SECRET = "test-runbook-secret";

test("runbook execute auth rejects spoofed local panel headers without HMAC", () => {
  const request = {
    headers: {
      "x-operator-id": "op-local",
      host: "localhost:5173",
      origin: "http://localhost:5173",
      referer: "http://localhost:5173/canvas"
    }
  } as IncomingMessage;

  const result = validateRunbookExecuteAuthorization(request, "{\"ok\":true}", Date.parse("2026-06-02T12:00:00.000Z"));

  assert.deepEqual(result, { ok: false, rejectReason: "hmac_missing" });
});

test("runbook execute auth accepts a valid OpenClaw HMAC", () => {
  const raw = "{\"ok\":true}";
  const timestamp = Math.floor(Date.parse("2026-06-02T12:00:00.000Z") / 1000);
  const signature = signOpenClawPayload(raw, timestamp, process.env.OPENCLAW_HMAC_SECRET!);
  const request = {
    headers: {
      "x-openclaw-timestamp": String(timestamp),
      "x-openclaw-signature": signature
    }
  } as IncomingMessage;

  const result = validateRunbookExecuteAuthorization(request, raw, Date.parse("2026-06-02T12:00:00.000Z"));

  assert.deepEqual(result, { ok: true });
});

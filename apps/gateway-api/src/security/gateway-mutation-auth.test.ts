import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { signOpenClawPayload } from "./hmac.ts";
import {
  operatorIdFromHeaders,
  validateGatewayMutationHmac
} from "./gateway-mutation-auth.ts";

process.env.OPENCLAW_HMAC_SECRET = "test-gateway-mutation-secret";

test("gateway mutation auth rejects spoofed operator headers without HMAC", () => {
  const request = {
    headers: {
      "x-operator-id": "op-local",
      host: "localhost:3000",
      origin: "http://localhost:5173"
    }
  } as IncomingMessage;

  const result = validateGatewayMutationHmac(request, "{\"nodes\":[]}", Date.parse("2026-06-02T12:00:00.000Z"));

  assert.deepEqual(result, { ok: false, rejectReason: "hmac_missing" });
});

test("gateway mutation auth accepts valid HMAC and extracts operator id", () => {
  const raw = "{\"nodes\":[]}";
  const timestamp = Math.floor(Date.parse("2026-06-02T12:00:00.000Z") / 1000);
  const signature = signOpenClawPayload(raw, timestamp, process.env.OPENCLAW_HMAC_SECRET!);
  const request = {
    headers: {
      "x-openclaw-timestamp": String(timestamp),
      "x-openclaw-signature": signature,
      "x-operator-id": "op-auditor"
    }
  } as IncomingMessage;

  assert.deepEqual(validateGatewayMutationHmac(request, raw, Date.parse("2026-06-02T12:00:00.000Z")), { ok: true });
  assert.equal(operatorIdFromHeaders(request.headers), "op-auditor");
});

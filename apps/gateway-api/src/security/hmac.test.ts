import assert from "node:assert/strict";
import test from "node:test";
import {
  signOpenClawPayload,
  validateOpenClawHmac
} from "./hmac.ts";

process.env.OPENCLAW_HMAC_SECRET = "test-hmac-secret";

test("validateOpenClawHmac rejects missing signature headers", () => {
  const result = validateOpenClawHmac({}, "{}");

  assert.deepEqual(result, { ok: false, rejectReason: "hmac_missing" });
});

test("validateOpenClawHmac rejects timestamp drift", () => {
  const raw = "{}";
  const timestamp = 1_000;
  const signature = signOpenClawPayload(raw, timestamp, process.env.OPENCLAW_HMAC_SECRET!);
  const result = validateOpenClawHmac({
    "x-openclaw-signature": signature,
    "x-openclaw-timestamp": String(timestamp)
  }, raw, 1_200_000);

  assert.deepEqual(result, { ok: false, rejectReason: "hmac_timestamp_drift" });
});

test("validateOpenClawHmac rejects body tampering", () => {
  const timestamp = 2_000;
  const signature = signOpenClawPayload("{\"ok\":true}", timestamp, process.env.OPENCLAW_HMAC_SECRET!);
  const result = validateOpenClawHmac({
    "x-openclaw-signature": signature,
    "x-openclaw-timestamp": String(timestamp)
  }, "{\"ok\":false}", 2_000_000);

  assert.deepEqual(result, { ok: false, rejectReason: "hmac_invalid" });
});

test("validateOpenClawHmac accepts valid signature", () => {
  const raw = "{\"proposal\":{\"id\":\"p1\"}}";
  const timestamp = 3_000;
  const signature = signOpenClawPayload(raw, timestamp, process.env.OPENCLAW_HMAC_SECRET!);
  const result = validateOpenClawHmac({
    "x-openclaw-signature": signature,
    "x-openclaw-timestamp": String(timestamp)
  }, raw, 3_000_000);

  assert.deepEqual(result, { ok: true });
});

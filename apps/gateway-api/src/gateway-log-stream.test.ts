import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayLogEventFromLine,
  inferGatewayLogLevel,
  redactGatewayLogSecrets,
  shouldEmitGatewayLogLevel
} from "./gateway-log-stream.ts";

test("gateway log stream redacts tokens, bearer credentials, and AWS access keys", () => {
  const line = "Authorization: Bearer abc.def token=secret-value AWS=AKIA1234567890ABCDEF";
  const redacted = redactGatewayLogSecrets(line);

  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, /token=\[REDACTED\]/);
  assert.match(redacted, /\[REDACTED_AWS_ACCESS_KEY\]/);
  assert.doesNotMatch(redacted, /abc\.def/);
  assert.doesNotMatch(redacted, /secret-value/);
});

test("gateway log stream infers and filters levels monotonically", () => {
  assert.equal(inferGatewayLogLevel("gateway-api listening on http://127.0.0.1:3000"), "info");
  assert.equal(inferGatewayLogLevel("[gateway] WARN: dependency degraded"), "warn");
  assert.equal(inferGatewayLogLevel("OpenClaw bridge failed with error"), "error");
  assert.equal(inferGatewayLogLevel("2026-06-01T14:00:00.000Z [info] event=oc.step_failed handled"), "info");
  assert.equal(inferGatewayLogLevel("2026-06-01T14:00:00.000Z [error] event=oc.step_failed handled"), "error");

  assert.equal(shouldEmitGatewayLogLevel("warn", "info"), true);
  assert.equal(shouldEmitGatewayLogLevel("info", "warn"), false);
  assert.equal(shouldEmitGatewayLogLevel("error", "warn"), true);
});

test("gateway log event keeps timestamp and caps message", () => {
  const event = gatewayLogEventFromLine("2026-05-29T12:00:00.000Z password=supersecret " + "x".repeat(9_000), new Date("2026-05-29T12:01:00.000Z"));

  assert.ok(event);
  assert.equal(event.ts, "2026-05-29T12:00:00.000Z");
  assert.equal(event.message.includes("supersecret"), false);
  assert.equal(event.message.length, 8_000);
});

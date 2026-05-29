import assert from "node:assert/strict";
import test from "node:test";
import { classifyLiveActionMutation } from "./live-action-kill-switch.ts";

test("classifyLiveActionMutation covers A3 live external mutation routes", () => {
  const routes = [
    ["POST", "/v1/domains/route53/register"],
    ["POST", "/v1/domains/route53/dns/upsert"],
    ["DELETE", "/v1/domains/route53/hosted-zones/Z123"],
    ["POST", "/v1/domains/auth/configure"],
    ["POST", "/v1/domains/bind"],
    ["POST", "/v1/dns/ionos/upsert"],
    ["POST", "/v1/webdock/servers/create"],
    ["DELETE", "/v1/webdock/servers/mail-test"],
    ["POST", "/v1/servers/mail-test/provision-smtp"],
    ["POST", "/v1/warmup/start"],
    ["POST", "/v1/warmup/seed"],
    ["POST", "/v1/warmup/ramp/start"],
    ["POST", "/v1/warmup/ramp/ramp-abc-123/resume"],
    ["POST", "/v1/flows/onboard-sender-domain"],
    ["POST", "/v1/flows/onboard-batch"]
  ] as const;

  for (const [method, path] of routes) {
    const classified = classifyLiveActionMutation(method, path);
    assert.ok(classified, `${method} ${path} should be classified`);
    assert.equal(classified.operation, "apply_live_infrastructure_action");
  }
});

test("classifyLiveActionMutation leaves safe/read or stop routes outside live-action block", () => {
  assert.equal(classifyLiveActionMutation("GET", "/v1/audit-chain/verify"), null);
  assert.equal(classifyLiveActionMutation("GET", "/v1/kill-switch"), null);
  assert.equal(classifyLiveActionMutation("POST", "/v1/kill-switch"), null);
  assert.equal(classifyLiveActionMutation("POST", "/v1/warmup/ramp/ramp-abc-123/pause"), null);
  assert.equal(classifyLiveActionMutation("POST", "/v1/canvas/artifact/artifact-1/approve"), null);
});

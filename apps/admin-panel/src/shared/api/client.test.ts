import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReadEndpoint,
  listReadEndpoints,
  READ_ENDPOINTS
} from "./client.ts";

test("admin panel exposes only approved GET endpoints", () => {
  assert.deepEqual(listReadEndpoints().sort(), [
    "/health",
    "/v1/admin/clusters",
    "/v1/admin/overview",
    "/v1/admin/workflow",
    "/v1/devops/collector/status",
    "/v1/devops/collector/supervised-plan",
    "/v1/hardware/physical-host",
    "/v1/hardware/telemetry/history",
    "/v1/hardware/telemetry/latest",
    "/v1/kill-switch",
    "/v1/openclaw/learning-plan",
    "/v1/openclaw/live-canvas",
    "/v1/openclaw/onboarding/state",
    "/v1/openclaw/provisioning/state",
    "/v1/openclaw/readiness-signals",
    "/v1/operating-north"
  ]);
});

test("admin panel rejects endpoints outside the read boundary", () => {
  assert.throws(
    () => assertReadEndpoint("/v1/demo/mvp/final-report"),
    /outside the admin panel read boundary/
  );
});

test("admin panel has no write endpoint constants", () => {
  for (const endpoint of Object.values(READ_ENDPOINTS)) {
    assert.ok(!endpoint.includes("final-report"));
    assert.ok(!endpoint.includes("recover"));
    assert.ok(!endpoint.includes("seed"));
    assert.ok(!endpoint.includes("evaluate"));
    assert.ok(!endpoint.includes("dry-run"));
  }
});

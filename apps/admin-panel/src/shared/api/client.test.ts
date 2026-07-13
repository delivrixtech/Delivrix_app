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
    "/v1/audit-events",
    "/v1/canvas/live/state",
    "/v1/compliance/status",
    "/v1/devops/collector/snapshot-ingestion",
    "/v1/devops/collector/status",
    "/v1/devops/collector/supervised-plan",
    "/v1/domains/availability",
    "/v1/domains/owned",
    "/v1/domains/prices",
    "/v1/domains/suggestions",
    "/v1/hardware/physical-host",
    "/v1/hardware/telemetry/history",
    "/v1/hardware/telemetry/latest",
    "/v1/iam/roles",
    "/v1/iam/sessions",
    "/v1/infrastructure/domain-discovery",
    "/v1/infrastructure/inventory",
    "/v1/ip-reputation/reports",
    "/v1/kill-switch",
    "/v1/mxtoolbox/daily-report",
    "/v1/mxtoolbox/health",
    "/v1/openclaw/evidence",
    "/v1/openclaw/learning-plan",
    "/v1/openclaw/live-canvas",
    "/v1/openclaw/onboarding/state",
    "/v1/openclaw/proposals",
    "/v1/openclaw/provisioning/state",
    "/v1/openclaw/readiness-signals",
    "/v1/openclaw/skills/audit",
    "/v1/openclaw/workspace/file",
    "/v1/openclaw/workspace/tree",
    "/v1/operating-north",
    "/v1/operational-summary",
    "/v1/send-results",
    "/v1/sender-nodes",
    "/v1/sender-pool/credentials/export",
    "/v1/sender-pool/status",
    "/v1/stuck-jobs",
    "/v1/warmup/ramp/by-domain",
    "/v1/warmup/status",
    "/v1/webdock/inventory"
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
    assert.ok(!endpoint.includes("manual-snapshots"));
  }
});

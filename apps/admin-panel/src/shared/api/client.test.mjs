import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReadEndpoint,
  listReadEndpoints,
  READ_ENDPOINTS
} from "./client.js";

test("admin panel exposes only the initial GET endpoints", () => {
  assert.deepEqual(listReadEndpoints().sort(), [
    "/health",
    "/v1/admin/overview",
    "/v1/admin/workflow",
    "/v1/kill-switch",
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
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { dependencyStatus, type DependencyCheck } from "./dependency-health.ts";

test("dependencyStatus returns the public status enum", () => {
  const check: DependencyCheck = {
    status: "ok",
    checkedAt: "2026-05-28T00:00:00.000Z"
  };

  assert.equal(dependencyStatus(check), "ok");
});

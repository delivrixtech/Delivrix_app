import test from "node:test";
import assert from "node:assert/strict";
import { buildBackupPlan, simulateBackup } from "./backup-plan.ts";

test("builds dry-run backup plan without external side effects", () => {
  const plan = buildBackupPlan({}, new Date("2026-05-18T00:00:00.000Z"));

  assert.equal(plan.dryRun, true);
  assert.equal(plan.sideEffects, "none");
  assert.equal(plan.target.kind, "local-dry-run");
  assert.equal(plan.blockedOperations.includes("s3-put-object"), true);
});

test("requires bucket for s3-compatible backup targets", () => {
  assert.throws(() => buildBackupPlan({
    targetKind: "s3-compatible"
  }), /bucket/);
});

test("simulates backup when all requested resources are counted", () => {
  const plan = buildBackupPlan({
    resources: ["audit_events", "sender_nodes"]
  });
  const simulation = simulateBackup(plan, [
    {
      resource: "audit_events",
      count: 10,
      source: "local-file:audit_events"
    },
    {
      resource: "sender_nodes",
      count: 2,
      source: "local-file:sender_nodes"
    }
  ]);

  assert.equal(simulation.status, "simulated");
  assert.equal(simulation.warnings.length, 0);
});

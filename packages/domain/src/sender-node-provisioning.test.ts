import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSenderNodeProvisioningPlan,
  simulateSenderNodeProvisioningRun
} from "./sender-node-provisioning.ts";

test("builds a safe Proxmox provisioning plan with stable step order", () => {
  const plan = buildSenderNodeProvisioningPlan({
    id: "proxmox_1",
    label: "Proxmox Sender 1",
    provider: "proxmox",
    ipAddress: "203.0.113.10"
  }, new Date("2026-05-18T00:00:00.000Z"));

  assert.equal(plan.provider, "proxmox");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.sideEffects, "none");
  assert.equal(plan.targetSenderNode.status, "warming");
  assert.deepEqual(plan.steps.map((step) => step.name), [
    "create_compute",
    "assign_ip",
    "configure_postfix",
    "configure_opendkim",
    "configure_tls",
    "register_dns",
    "start_warmup"
  ]);
  assert.equal(plan.blockedOperations.includes("smtp-send"), true);
});

test("simulates provisioning without external side effects", () => {
  const plan = buildSenderNodeProvisioningPlan({
    id: "proxmox_1",
    label: "Proxmox Sender 1",
    provider: "proxmox"
  });
  const run = simulateSenderNodeProvisioningRun(plan);

  assert.equal(run.status, "simulated");
  assert.equal(run.summary.completedSteps, 7);
  assert.equal(run.summary.externalSideEffects, false);
  assert.equal(run.summary.smtpEnabled, false);
  assert.equal(run.steps.every((step) => step.status === "completed"), true);
});

test("rejects invalid provisioning capacity values", () => {
  assert.throws(() => buildSenderNodeProvisioningPlan({
    id: "proxmox_1",
    label: "Proxmox Sender 1",
    provider: "proxmox",
    dailyLimit: -1
  }), /dailyLimit/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSenderNodeManualControl } from "./sender-node-manual-control.ts";
import type { SenderNode, SenderNodeStatus } from "./types.ts";

test("allows pausing active sender nodes with a reason", () => {
  const decision = evaluateSenderNodeManualControl({
    node: senderNode("active"),
    action: "pause",
    reason: "Provider maintenance"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.nextStatus, "paused");
  assert.equal(decision.auditAction, "sender_node.manual_paused");
  assert.equal(decision.riskLevel, "medium");
});

test("allows quarantining degraded sender nodes", () => {
  const decision = evaluateSenderNodeManualControl({
    node: senderNode("degraded"),
    action: "quarantine",
    reason: "Complaint spike"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.nextStatus, "quarantined");
  assert.equal(decision.riskLevel, "critical");
});

test("allows reactivating paused sender nodes", () => {
  const decision = evaluateSenderNodeManualControl({
    node: senderNode("paused"),
    action: "reactivate",
    reason: "Provider issue resolved"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.nextStatus, "active");
  assert.equal(decision.riskLevel, "high");
});

test("blocks reactivation from quarantined without dedicated approval flow", () => {
  const decision = evaluateSenderNodeManualControl({
    node: senderNode("quarantined"),
    action: "reactivate",
    reason: "Trying to restore"
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "manual_control_quarantine_reactivation_blocked");
  assert.equal(decision.riskLevel, "critical");
});

test("requires reason for every manual control", () => {
  const decision = evaluateSenderNodeManualControl({
    node: senderNode("active"),
    action: "pause"
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "manual_control_reason_required");
});

test("blocks retired pending approval nodes", () => {
  const decision = evaluateSenderNodeManualControl({
    node: senderNode("retired_pending_approval"),
    action: "quarantine",
    reason: "Late incident"
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "manual_control_retired_node_blocked");
});

function senderNode(status: SenderNodeStatus): SenderNode {
  return {
    id: "sender_control_test_001",
    label: "Sender Control Test",
    provider: "webdock",
    status,
    dailyLimit: 100,
    warmupDay: 1
  };
}

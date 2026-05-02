import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSenderNodeHealth } from "./sender-node-health.ts";
import type { SendResult, SenderNode } from "./types.ts";

test("recommends quarantined when a node has a complaint", () => {
  const [decision] = evaluateSenderNodeHealth([node("sender_1", "active")], [
    result("sender_1", "complaint")
  ]);

  assert.equal(decision?.severity, "critical");
  assert.equal(decision?.recommendedStatus, "quarantined");
});

test("recommends degraded when bounces cross warning threshold", () => {
  const [decision] = evaluateSenderNodeHealth([node("sender_1", "warming")], [
    result("sender_1", "bounce"),
    result("sender_1", "bounce")
  ]);

  assert.equal(decision?.severity, "warning");
  assert.equal(decision?.recommendedStatus, "degraded");
});

test("keeps healthy nodes in their current active or warming state", () => {
  const [decision] = evaluateSenderNodeHealth([node("sender_1", "warming")], [
    result("sender_1", "sent")
  ]);

  assert.equal(decision?.severity, "healthy");
  assert.equal(decision?.recommendedStatus, "warming");
});

test("does not override retired pending approval", () => {
  const [decision] = evaluateSenderNodeHealth([node("sender_1", "retired_pending_approval")], [
    result("sender_1", "complaint")
  ]);

  assert.equal(decision?.recommendedStatus, "retired_pending_approval");
  assert.equal(decision?.reasons.includes("node_retirement_requires_human_approval"), true);
});

function node(id: string, status: SenderNode["status"]): SenderNode {
  return {
    id,
    label: id,
    provider: "webdock",
    status,
    dailyLimit: 50,
    warmupDay: 1
  };
}

function result(senderNodeId: string, status: SendResult["status"]): SendResult {
  return {
    id: `result_${senderNodeId}_${status}`,
    sendJobId: "job_1",
    senderNodeId,
    status,
    metadata: {},
    occurredAt: "2026-05-02T00:00:00.000Z"
  };
}

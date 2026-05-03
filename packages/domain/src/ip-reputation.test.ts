import test from "node:test";
import assert from "node:assert/strict";
import { evaluateIpReputation } from "./ip-reputation.ts";
import type { SendResult, SenderNode } from "./types.ts";

test("recommends quarantine when a blacklist signal is critical", () => {
  const [report] = evaluateIpReputation([node("sender_1")], [], [{
    senderNodeId: "sender_1",
    type: "blacklist",
    source: "mock-rbl",
    severity: "critical"
  }]);

  assert.equal(report?.state, "critical");
  assert.equal(report?.recommendedStatus, "quarantined");
  assert.equal(report?.recommendedAction, "quarantine");
});

test("recommends quarantine when bounce rate crosses critical threshold", () => {
  const results = [
    result("sender_1", "sent", 1),
    result("sender_1", "sent", 2),
    result("sender_1", "sent", 3),
    result("sender_1", "sent", 4),
    result("sender_1", "sent", 5),
    result("sender_1", "sent", 6),
    result("sender_1", "sent", 7),
    result("sender_1", "sent", 8),
    result("sender_1", "sent", 9),
    result("sender_1", "bounce", 10)
  ];
  const [report] = evaluateIpReputation([node("sender_1")], results);

  assert.equal(report?.state, "critical");
  assert.equal(report?.recommendedStatus, "quarantined");
});

test("keeps retired nodes unchanged", () => {
  const [report] = evaluateIpReputation([node("sender_1", "retired")], [
    result("sender_1", "complaint", 1)
  ]);

  assert.equal(report?.recommendedStatus, "retired");
  assert.equal(report?.recommendedAction, "none");
});

function node(id: string, status: SenderNode["status"] = "warming"): SenderNode {
  return {
    id,
    label: id,
    provider: "proxmox",
    status,
    dailyLimit: 10,
    warmupDay: 0
  };
}

function result(senderNodeId: string, status: SendResult["status"], suffix: number): SendResult {
  return {
    id: `result_${suffix}`,
    sendJobId: `job_${suffix}`,
    senderNodeId,
    status,
    metadata: {},
    occurredAt: "2026-05-18T00:00:00.000Z"
  };
}

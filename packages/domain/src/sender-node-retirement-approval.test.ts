import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSenderNodeRetirementApproval } from "./sender-node-retirement-approval.ts";
import type { SenderNode } from "./types.ts";

test("approves retirement only from retired_pending_approval", () => {
  const decision = evaluateSenderNodeRetirementApproval({
    node: node("retired_pending_approval"),
    reason: "Decommission approved after migration."
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.nextStatus, "retired");
});

test("requires reason for retirement approval", () => {
  const decision = evaluateSenderNodeRetirementApproval({
    node: node("retired_pending_approval")
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "retirement_approval_reason_required");
});

test("blocks retirement approval for active nodes", () => {
  const decision = evaluateSenderNodeRetirementApproval({
    node: node("active"),
    reason: "Not eligible."
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "retirement_approval_status_blocked");
});

function node(status: SenderNode["status"]): SenderNode {
  return {
    id: "sender_1",
    label: "Sender 1",
    provider: "proxmox",
    status,
    dailyLimit: 10,
    warmupDay: 0
  };
}

import type { AuditRiskLevel } from "./audit-log.ts";
import type { SenderNode, SenderNodeStatus } from "./types.ts";

export interface SenderNodeRetirementApprovalInput {
  node: SenderNode;
  reason?: string;
}

export interface SenderNodeRetirementApprovalDecision {
  allowed: boolean;
  senderNodeId: string;
  currentStatus: SenderNodeStatus;
  nextStatus?: SenderNodeStatus;
  code:
    | "retirement_approval_allowed"
    | "retirement_approval_reason_required"
    | "retirement_approval_status_blocked";
  message: string;
  riskLevel: AuditRiskLevel;
  auditAction: string;
  reason?: string;
}

export function evaluateSenderNodeRetirementApproval(
  input: SenderNodeRetirementApprovalInput
): SenderNodeRetirementApprovalDecision {
  const reason = input.reason?.trim();

  if (!reason) {
    return {
      allowed: false,
      senderNodeId: input.node.id,
      currentStatus: input.node.status,
      code: "retirement_approval_reason_required",
      message: "A reason is required to approve sender node retirement.",
      riskLevel: "high",
      auditAction: "sender_node.retirement_approval_rejected"
    };
  }

  if (input.node.status !== "retired_pending_approval") {
    return {
      allowed: false,
      senderNodeId: input.node.id,
      currentStatus: input.node.status,
      code: "retirement_approval_status_blocked",
      message: "Only sender nodes in retired_pending_approval can be retired.",
      riskLevel: "high",
      auditAction: "sender_node.retirement_approval_rejected",
      reason
    };
  }

  return {
    allowed: true,
    senderNodeId: input.node.id,
    currentStatus: input.node.status,
    nextStatus: "retired",
    code: "retirement_approval_allowed",
    message: "Sender node retirement can be approved.",
    riskLevel: "high",
    auditAction: "sender_node.retirement_approved",
    reason
  };
}

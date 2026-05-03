import type { AuditRiskLevel } from "./audit-log.ts";
import type { SenderNode, SenderNodeStatus } from "./types.ts";

export type SenderNodeManualAction = "pause" | "reactivate" | "degrade" | "quarantine";

export interface SenderNodeManualControlInput {
  node: SenderNode;
  action: SenderNodeManualAction;
  reason?: string;
}

export interface SenderNodeManualControlDecision {
  allowed: boolean;
  action: SenderNodeManualAction;
  senderNodeId: string;
  currentStatus: SenderNodeStatus;
  nextStatus?: SenderNodeStatus;
  code:
    | "manual_control_allowed"
    | "manual_control_reason_required"
    | "manual_control_retired_node_blocked"
    | "manual_control_quarantine_reactivation_blocked"
    | "manual_control_transition_blocked";
  message: string;
  riskLevel: AuditRiskLevel;
  auditAction: string;
  reason?: string;
}

interface SenderNodeManualControlPolicy {
  nextStatus: SenderNodeStatus;
  allowedFrom: SenderNodeStatus[];
  blockedMessage: string;
  riskLevel: AuditRiskLevel;
  auditAction: string;
}

const manualControlPolicies: Record<SenderNodeManualAction, SenderNodeManualControlPolicy> = {
  pause: {
    nextStatus: "paused",
    allowedFrom: ["active", "warming", "degraded", "paused"],
    blockedMessage: "Only active, warming, degraded, or already paused sender nodes can be paused.",
    riskLevel: "medium",
    auditAction: "sender_node.manual_paused"
  },
  reactivate: {
    nextStatus: "active",
    allowedFrom: ["paused", "degraded", "active"],
    blockedMessage: "Only paused, degraded, or already active sender nodes can be reactivated manually.",
    riskLevel: "high",
    auditAction: "sender_node.manual_reactivated"
  },
  degrade: {
    nextStatus: "degraded",
    allowedFrom: ["active", "warming", "paused", "degraded"],
    blockedMessage: "Only active, warming, paused, or already degraded sender nodes can be degraded manually.",
    riskLevel: "high",
    auditAction: "sender_node.manual_degraded"
  },
  quarantine: {
    nextStatus: "quarantined",
    allowedFrom: ["active", "warming", "paused", "degraded", "quarantined"],
    blockedMessage: "Retired sender nodes cannot be quarantined through manual operational controls.",
    riskLevel: "critical",
    auditAction: "sender_node.manual_quarantined"
  }
};

export function evaluateSenderNodeManualControl(
  input: SenderNodeManualControlInput
): SenderNodeManualControlDecision {
  const policy = manualControlPolicies[input.action];
  const reason = input.reason?.trim();

  if (!reason) {
    return blockedDecision(input, {
      code: "manual_control_reason_required",
      message: "A reason is required for manual sender node controls.",
      riskLevel: policy.riskLevel
    });
  }

  if (input.node.status === "retired_pending_approval" || input.node.status === "retired") {
    return blockedDecision(input, {
      code: "manual_control_retired_node_blocked",
      message: "Retired sender nodes cannot be changed by manual operational controls.",
      riskLevel: "high",
      reason
    });
  }

  if (input.action === "reactivate" && input.node.status === "quarantined") {
    return blockedDecision(input, {
      code: "manual_control_quarantine_reactivation_blocked",
      message: "Quarantined sender nodes cannot be reactivated manually without a dedicated approval flow.",
      riskLevel: "critical",
      reason
    });
  }

  if (!policy.allowedFrom.includes(input.node.status)) {
    return blockedDecision(input, {
      code: "manual_control_transition_blocked",
      message: policy.blockedMessage,
      riskLevel: policy.riskLevel,
      reason
    });
  }

  return {
    allowed: true,
    action: input.action,
    senderNodeId: input.node.id,
    currentStatus: input.node.status,
    nextStatus: policy.nextStatus,
    code: "manual_control_allowed",
    message: `Manual control ${input.action} can transition sender node to ${policy.nextStatus}.`,
    riskLevel: policy.riskLevel,
    auditAction: policy.auditAction,
    reason
  };
}

export function isSenderNodeManualAction(value: unknown): value is SenderNodeManualAction {
  return value === "pause" || value === "reactivate" || value === "degrade" || value === "quarantine";
}

function blockedDecision(
  input: SenderNodeManualControlInput,
  block: {
    code: SenderNodeManualControlDecision["code"];
    message: string;
    riskLevel: AuditRiskLevel;
    reason?: string;
  }
): SenderNodeManualControlDecision {
  return {
    allowed: false,
    action: input.action,
    senderNodeId: input.node.id,
    currentStatus: input.node.status,
    code: block.code,
    message: block.message,
    riskLevel: block.riskLevel,
    auditAction: "sender_node.manual_control_rejected",
    reason: block.reason
  };
}

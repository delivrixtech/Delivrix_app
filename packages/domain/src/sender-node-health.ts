import type { SendResult, SenderNode, SenderNodeStatus } from "./types.ts";

export type SenderNodeHealthSeverity = "healthy" | "warning" | "critical";

export interface SenderNodeHealthThresholds {
  bounceWarningCount: number;
  deferredWarningCount: number;
  failedWarningCount: number;
  complaintCriticalCount: number;
}

export interface SenderNodeHealthMetrics {
  sent: number;
  bounce: number;
  complaint: number;
  deferred: number;
  failed: number;
  total: number;
}

export interface SenderNodeHealthDecision {
  senderNodeId: string;
  currentStatus: SenderNodeStatus;
  recommendedStatus: SenderNodeStatus;
  severity: SenderNodeHealthSeverity;
  reasons: string[];
  metrics: SenderNodeHealthMetrics;
}

export const defaultSenderNodeHealthThresholds: SenderNodeHealthThresholds = {
  bounceWarningCount: 2,
  deferredWarningCount: 3,
  failedWarningCount: 2,
  complaintCriticalCount: 1
};

export function evaluateSenderNodeHealth(
  senderNodes: SenderNode[],
  sendResults: SendResult[],
  thresholds = defaultSenderNodeHealthThresholds
): SenderNodeHealthDecision[] {
  return senderNodes.map((node) => evaluateOneNode(node, sendResults, thresholds));
}

function evaluateOneNode(
  node: SenderNode,
  sendResults: SendResult[],
  thresholds: SenderNodeHealthThresholds
): SenderNodeHealthDecision {
  const metrics = metricsForNode(node.id, sendResults);
  const reasons: string[] = [];
  let severity: SenderNodeHealthSeverity = "healthy";
  let recommendedStatus = normalizeHealthyStatus(node.status);

  if (metrics.complaint >= thresholds.complaintCriticalCount) {
    severity = "critical";
    recommendedStatus = "quarantined";
    reasons.push(`complaint_count ${metrics.complaint} >= ${thresholds.complaintCriticalCount}`);
  } else if (
    metrics.bounce >= thresholds.bounceWarningCount
    || metrics.deferred >= thresholds.deferredWarningCount
    || metrics.failed >= thresholds.failedWarningCount
  ) {
    severity = "warning";
    recommendedStatus = "degraded";

    if (metrics.bounce >= thresholds.bounceWarningCount) {
      reasons.push(`bounce_count ${metrics.bounce} >= ${thresholds.bounceWarningCount}`);
    }

    if (metrics.deferred >= thresholds.deferredWarningCount) {
      reasons.push(`deferred_count ${metrics.deferred} >= ${thresholds.deferredWarningCount}`);
    }

    if (metrics.failed >= thresholds.failedWarningCount) {
      reasons.push(`failed_count ${metrics.failed} >= ${thresholds.failedWarningCount}`);
    }
  } else {
    reasons.push("within_thresholds");
  }

  if (node.status === "retired_pending_approval") {
    return {
      senderNodeId: node.id,
      currentStatus: node.status,
      recommendedStatus: node.status,
      severity: "critical",
      reasons: ["node_retirement_requires_human_approval"],
      metrics
    };
  }

  return {
    senderNodeId: node.id,
    currentStatus: node.status,
    recommendedStatus,
    severity,
    reasons,
    metrics
  };
}

function normalizeHealthyStatus(status: SenderNodeStatus): SenderNodeStatus {
  if (status === "degraded" || status === "quarantined" || status === "paused") {
    return status;
  }

  return status;
}

function metricsForNode(senderNodeId: string, sendResults: SendResult[]): SenderNodeHealthMetrics {
  const metrics: SenderNodeHealthMetrics = {
    sent: 0,
    bounce: 0,
    complaint: 0,
    deferred: 0,
    failed: 0,
    total: 0
  };

  for (const result of sendResults) {
    if (result.senderNodeId !== senderNodeId) {
      continue;
    }

    metrics[result.status] += 1;
    metrics.total += 1;
  }

  return metrics;
}

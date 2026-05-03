import { createId } from "./ids.ts";
import type { SendResult, SenderNode, SenderNodeStatus } from "./types.ts";

export type IpReputationState = "healthy" | "watch" | "degraded" | "critical";
export type IpReputationSignalSeverity = "info" | "warning" | "critical";
export type IpReputationSignalType =
  | "no_results_yet"
  | "bounce_rate"
  | "deferred_rate"
  | "failed_count"
  | "complaint_count"
  | "blacklist"
  | "manual_review";
export type IpReputationRecommendedAction = "none" | "monitor" | "degrade" | "quarantine";

export interface IpReputationExternalSignal {
  senderNodeId: string;
  type: Extract<IpReputationSignalType, "blacklist" | "manual_review">;
  source: string;
  severity: IpReputationSignalSeverity;
  message?: string;
  observedAt?: string;
}

export interface IpReputationSignal {
  type: IpReputationSignalType;
  severity: IpReputationSignalSeverity;
  message: string;
  source: string;
  observedAt: string;
}

export interface IpReputationMetrics {
  sent: number;
  bounce: number;
  complaint: number;
  deferred: number;
  failed: number;
  total: number;
  bounceRate: number;
  complaintRate: number;
  deferredRate: number;
}

export interface IpReputationThresholds {
  minimumVolumeForRateChecks: number;
  bounceWatchRate: number;
  bounceCriticalRate: number;
  deferredWatchRate: number;
  failedWarningCount: number;
  complaintCriticalCount: number;
}

export interface IpReputationReport {
  id: string;
  generatedAt: string;
  senderNodeId: string;
  provider: SenderNode["provider"];
  ipAddress?: string;
  currentStatus: SenderNodeStatus;
  recommendedStatus: SenderNodeStatus;
  recommendedAction: IpReputationRecommendedAction;
  state: IpReputationState;
  score: number;
  metrics: IpReputationMetrics;
  signals: IpReputationSignal[];
  thresholds: IpReputationThresholds;
}

export const defaultIpReputationThresholds: IpReputationThresholds = {
  minimumVolumeForRateChecks: 10,
  bounceWatchRate: 0.05,
  bounceCriticalRate: 0.1,
  deferredWatchRate: 0.1,
  failedWarningCount: 2,
  complaintCriticalCount: 1
};

export function evaluateIpReputation(
  senderNodes: SenderNode[],
  sendResults: SendResult[],
  externalSignals: IpReputationExternalSignal[] = [],
  thresholds = defaultIpReputationThresholds,
  now = new Date()
): IpReputationReport[] {
  const generatedAt = now.toISOString();

  return senderNodes.map((node) => evaluateNodeReputation(
    node,
    sendResults,
    externalSignals.filter((signal) => signal.senderNodeId === node.id),
    thresholds,
    generatedAt
  ));
}

function evaluateNodeReputation(
  node: SenderNode,
  sendResults: SendResult[],
  externalSignals: IpReputationExternalSignal[],
  thresholds: IpReputationThresholds,
  generatedAt: string
): IpReputationReport {
  const metrics = metricsForNode(node.id, sendResults);
  const signals = buildSignals(metrics, externalSignals, thresholds, generatedAt);
  const state = stateFromSignals(signals);
  const score = scoreFromStateAndSignals(state, signals);

  return {
    id: createId("iprep"),
    generatedAt,
    senderNodeId: node.id,
    provider: node.provider,
    ipAddress: node.ipAddress,
    currentStatus: node.status,
    recommendedStatus: recommendedStatusFor(node.status, state),
    recommendedAction: recommendedActionFor(node.status, state),
    state,
    score,
    metrics,
    signals,
    thresholds
  };
}

function buildSignals(
  metrics: IpReputationMetrics,
  externalSignals: IpReputationExternalSignal[],
  thresholds: IpReputationThresholds,
  generatedAt: string
): IpReputationSignal[] {
  const signals: IpReputationSignal[] = externalSignals.map((signal) => ({
    type: signal.type,
    severity: signal.severity,
    message: signal.message ?? `${signal.type} signal from ${signal.source}`,
    source: signal.source,
    observedAt: signal.observedAt ?? generatedAt
  }));

  if (metrics.total === 0) {
    signals.push({
      type: "no_results_yet",
      severity: "info",
      message: "No send results recorded for this sender node yet.",
      source: "delivrix-local",
      observedAt: generatedAt
    });
  }

  if (metrics.complaint >= thresholds.complaintCriticalCount) {
    signals.push({
      type: "complaint_count",
      severity: "critical",
      message: `Complaint count ${metrics.complaint} crossed critical threshold ${thresholds.complaintCriticalCount}.`,
      source: "delivrix-local",
      observedAt: generatedAt
    });
  }

  if (metrics.total >= thresholds.minimumVolumeForRateChecks) {
    if (metrics.bounceRate >= thresholds.bounceCriticalRate) {
      signals.push({
        type: "bounce_rate",
        severity: "critical",
        message: `Bounce rate ${formatRate(metrics.bounceRate)} crossed critical threshold ${formatRate(thresholds.bounceCriticalRate)}.`,
        source: "delivrix-local",
        observedAt: generatedAt
      });
    } else if (metrics.bounceRate >= thresholds.bounceWatchRate) {
      signals.push({
        type: "bounce_rate",
        severity: "warning",
        message: `Bounce rate ${formatRate(metrics.bounceRate)} crossed watch threshold ${formatRate(thresholds.bounceWatchRate)}.`,
        source: "delivrix-local",
        observedAt: generatedAt
      });
    }

    if (metrics.deferredRate >= thresholds.deferredWatchRate) {
      signals.push({
        type: "deferred_rate",
        severity: "warning",
        message: `Deferred rate ${formatRate(metrics.deferredRate)} crossed watch threshold ${formatRate(thresholds.deferredWatchRate)}.`,
        source: "delivrix-local",
        observedAt: generatedAt
      });
    }
  }

  if (metrics.failed >= thresholds.failedWarningCount) {
    signals.push({
      type: "failed_count",
      severity: "warning",
      message: `Failed count ${metrics.failed} crossed warning threshold ${thresholds.failedWarningCount}.`,
      source: "delivrix-local",
      observedAt: generatedAt
    });
  }

  return signals;
}

function stateFromSignals(signals: IpReputationSignal[]): IpReputationState {
  if (signals.some((signal) => signal.severity === "critical")) {
    return "critical";
  }

  if (signals.some((signal) => signal.severity === "warning")) {
    return "degraded";
  }

  if (signals.some((signal) => signal.type === "no_results_yet")) {
    return "watch";
  }

  return "healthy";
}

function recommendedStatusFor(currentStatus: SenderNodeStatus, state: IpReputationState): SenderNodeStatus {
  if (currentStatus === "retired" || currentStatus === "retired_pending_approval") {
    return currentStatus;
  }

  if (state === "critical") {
    return "quarantined";
  }

  if (state === "degraded") {
    return "degraded";
  }

  return currentStatus;
}

function recommendedActionFor(
  currentStatus: SenderNodeStatus,
  state: IpReputationState
): IpReputationRecommendedAction {
  if (currentStatus === "retired" || currentStatus === "retired_pending_approval") {
    return "none";
  }

  if (state === "critical") {
    return "quarantine";
  }

  if (state === "degraded") {
    return "degrade";
  }

  if (state === "watch") {
    return "monitor";
  }

  return "none";
}

function scoreFromStateAndSignals(state: IpReputationState, signals: IpReputationSignal[]): number {
  const baseScore = state === "healthy" ? 100 : state === "watch" ? 85 : state === "degraded" ? 60 : 20;
  const blacklistPenalty = signals.some((signal) => signal.type === "blacklist") ? 10 : 0;
  return Math.max(0, baseScore - blacklistPenalty);
}

function metricsForNode(senderNodeId: string, sendResults: SendResult[]): IpReputationMetrics {
  const metrics: IpReputationMetrics = {
    sent: 0,
    bounce: 0,
    complaint: 0,
    deferred: 0,
    failed: 0,
    total: 0,
    bounceRate: 0,
    complaintRate: 0,
    deferredRate: 0
  };

  for (const result of sendResults) {
    if (result.senderNodeId !== senderNodeId) {
      continue;
    }

    metrics[result.status] += 1;
    metrics.total += 1;
  }

  if (metrics.total > 0) {
    metrics.bounceRate = metrics.bounce / metrics.total;
    metrics.complaintRate = metrics.complaint / metrics.total;
    metrics.deferredRate = metrics.deferred / metrics.total;
  }

  return metrics;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

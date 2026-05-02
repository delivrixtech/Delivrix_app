import type { AuditEvent } from "./audit-log.ts";
import type { KillSwitchState } from "./kill-switch.ts";
import type { OperationalSummary } from "./operational-summary.ts";
import type { SenderNodeHealthDecision } from "./sender-node-health.ts";

export type AdminAlertSeverity = "info" | "warning" | "critical";
export type AdminOperationalState = "healthy" | "warning" | "critical";

export interface AdminAlert {
  id: string;
  severity: AdminAlertSeverity;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
}

export interface AdminOverview {
  generatedAt: string;
  state: AdminOperationalState;
  summary: OperationalSummary;
  health: SenderNodeHealthDecision[];
  killSwitch?: KillSwitchState;
  alerts: AdminAlert[];
  recentAuditEvents: AuditEvent[];
}

export interface AdminOverviewInput {
  summary: OperationalSummary;
  health: SenderNodeHealthDecision[];
  auditEvents: AuditEvent[];
  killSwitch?: KillSwitchState;
  recentAuditLimit?: number;
  now?: Date;
}

export function buildAdminOverview(input: AdminOverviewInput): AdminOverview {
  const alerts = buildAdminAlerts(input.summary, input.health, input.killSwitch);

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    state: stateFromAlerts(alerts),
    summary: input.summary,
    health: input.health,
    killSwitch: input.killSwitch,
    alerts,
    recentAuditEvents: recentAuditEvents(input.auditEvents, input.recentAuditLimit ?? 10)
  };
}

function buildAdminAlerts(
  summary: OperationalSummary,
  health: SenderNodeHealthDecision[],
  killSwitch: KillSwitchState | undefined
): AdminAlert[] {
  const alerts: AdminAlert[] = [];
  const criticalHealth = health.filter((decision) => decision.severity === "critical");
  const warningHealth = health.filter((decision) => decision.severity === "warning");

  if (killSwitch?.enabled) {
    alerts.push({
      id: "kill_switch_active",
      severity: "critical",
      title: "Kill switch active",
      message: "The send pipeline is paused by the operational kill switch.",
      metadata: {
        reason: killSwitch.reason,
        updatedAt: killSwitch.updatedAt,
        updatedBy: killSwitch.updatedBy
      }
    });
  }

  if (criticalHealth.length > 0) {
    alerts.push({
      id: "sender_nodes_critical",
      severity: "critical",
      title: "Sender nodes require quarantine attention",
      message: `${criticalHealth.length} sender node(s) have critical health decisions.`,
      metadata: {
        senderNodeIds: criticalHealth.map((decision) => decision.senderNodeId)
      }
    });
  }

  if (warningHealth.length > 0) {
    alerts.push({
      id: "sender_nodes_warning",
      severity: "warning",
      title: "Sender nodes degraded",
      message: `${warningHealth.length} sender node(s) have warning health decisions.`,
      metadata: {
        senderNodeIds: warningHealth.map((decision) => decision.senderNodeId)
      }
    });
  }

  if (summary.senderNodesByStatus.quarantined > 0) {
    alerts.push({
      id: "sender_nodes_quarantined",
      severity: "critical",
      title: "Quarantined sender nodes present",
      message: `${summary.senderNodesByStatus.quarantined} sender node(s) are quarantined.`,
      metadata: {
        count: summary.senderNodesByStatus.quarantined
      }
    });
  }

  if (summary.senderNodesByStatus.degraded > 0) {
    alerts.push({
      id: "sender_nodes_degraded",
      severity: "warning",
      title: "Degraded sender nodes present",
      message: `${summary.senderNodesByStatus.degraded} sender node(s) are degraded.`,
      metadata: {
        count: summary.senderNodesByStatus.degraded
      }
    });
  }

  if (summary.jobsByStatus.processing > 0) {
    alerts.push({
      id: "jobs_processing_present",
      severity: "warning",
      title: "Processing jobs present",
      message: `${summary.jobsByStatus.processing} job(s) are currently processing. Verify they are not stuck.`,
      metadata: {
        count: summary.jobsByStatus.processing
      }
    });
  }

  if (summary.jobsByStatus.blocked > 0) {
    alerts.push({
      id: "jobs_blocked_present",
      severity: "warning",
      title: "Blocked jobs present",
      message: `${summary.jobsByStatus.blocked} job(s) are blocked by policy, rate limits, or operational gates.`,
      metadata: {
        count: summary.jobsByStatus.blocked
      }
    });
  }

  if (summary.sendResultsByStatus.complaint > 0) {
    alerts.push({
      id: "complaints_present",
      severity: "critical",
      title: "Complaints detected",
      message: `${summary.sendResultsByStatus.complaint} complaint result(s) are recorded.`,
      metadata: {
        count: summary.sendResultsByStatus.complaint
      }
    });
  }

  if (summary.sendResultsByStatus.bounce > 0) {
    alerts.push({
      id: "bounces_present",
      severity: "warning",
      title: "Bounces detected",
      message: `${summary.sendResultsByStatus.bounce} bounce result(s) are recorded.`,
      metadata: {
        count: summary.sendResultsByStatus.bounce
      }
    });
  }

  if (summary.senderNodesByStatus.active + summary.senderNodesByStatus.warming === 0) {
    alerts.push({
      id: "no_available_sender_nodes",
      severity: "critical",
      title: "No available sender nodes",
      message: "There are no active or warming sender nodes available for dry-run processing.",
      metadata: {}
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      id: "system_nominal",
      severity: "info",
      title: "System nominal",
      message: "No operational alerts detected.",
      metadata: {}
    });
  }

  return alerts.sort(compareAlerts);
}

function stateFromAlerts(alerts: AdminAlert[]): AdminOperationalState {
  if (alerts.some((alert) => alert.severity === "critical")) {
    return "critical";
  }

  if (alerts.some((alert) => alert.severity === "warning")) {
    return "warning";
  }

  return "healthy";
}

function recentAuditEvents(events: AuditEvent[], limit: number): AuditEvent[] {
  return [...events]
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, limit);
}

function compareAlerts(left: AdminAlert, right: AdminAlert): number {
  const severityRank = rankSeverity(left.severity) - rankSeverity(right.severity);
  return severityRank || left.id.localeCompare(right.id);
}

function rankSeverity(severity: AdminAlertSeverity): number {
  if (severity === "critical") {
    return 0;
  }

  if (severity === "warning") {
    return 1;
  }

  return 2;
}

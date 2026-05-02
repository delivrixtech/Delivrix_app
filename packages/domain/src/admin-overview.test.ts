import test from "node:test";
import assert from "node:assert/strict";
import { buildAdminOverview } from "./admin-overview.ts";
import type { AuditEvent } from "./audit-log.ts";
import type { OperationalSummary } from "./operational-summary.ts";
import type { SenderNodeHealthDecision } from "./sender-node-health.ts";

test("builds critical admin overview when complaints and quarantined nodes exist", () => {
  const overview = buildAdminOverview({
    summary: summaryFixture({
      complaints: 1,
      quarantinedNodes: 1,
      processingJobs: 1
    }),
    health: [
      healthDecision("sender_critical", "critical")
    ],
    auditEvents: [
      audit("older", "2026-05-02T10:00:00.000Z"),
      audit("newer", "2026-05-02T11:00:00.000Z")
    ],
    now: new Date("2026-05-02T12:00:00.000Z")
  });

  assert.equal(overview.generatedAt, "2026-05-02T12:00:00.000Z");
  assert.equal(overview.state, "critical");
  assert.equal(overview.alerts[0]?.severity, "critical");
  assert.equal(overview.recentAuditEvents[0]?.id, "newer");
});

test("builds healthy overview with nominal alert when no risks exist", () => {
  const overview = buildAdminOverview({
    summary: summaryFixture({}),
    health: [
      healthDecision("sender_healthy", "healthy")
    ],
    auditEvents: []
  });

  assert.equal(overview.state, "healthy");
  assert.equal(overview.alerts.length, 1);
  assert.equal(overview.alerts[0]?.id, "system_nominal");
});

test("builds critical overview when kill switch is active", () => {
  const overview = buildAdminOverview({
    summary: summaryFixture({}),
    health: [
      healthDecision("sender_healthy", "healthy")
    ],
    killSwitch: {
      enabled: true,
      reason: "Manual incident response",
      updatedAt: "2026-05-02T12:00:00.000Z",
      updatedBy: "operator_001"
    },
    auditEvents: []
  });

  assert.equal(overview.state, "critical");
  assert.equal(overview.alerts[0]?.id, "kill_switch_active");
  assert.equal(overview.killSwitch?.enabled, true);
});

function summaryFixture(overrides: {
  complaints?: number;
  bounces?: number;
  quarantinedNodes?: number;
  degradedNodes?: number;
  processingJobs?: number;
  blockedJobs?: number;
}): OperationalSummary {
  return {
    generatedAt: "2026-05-02T00:00:00.000Z",
    totals: {
      jobs: 0,
      auditEvents: 0,
      senderNodes: 1,
      sendResults: 0
    },
    jobsByStatus: {
      queued: 0,
      processing: overrides.processingJobs ?? 0,
      completed: 0,
      failed: 0,
      blocked: overrides.blockedJobs ?? 0
    },
    sendResultsByStatus: {
      sent: 0,
      bounce: overrides.bounces ?? 0,
      complaint: overrides.complaints ?? 0,
      deferred: 0,
      failed: 0
    },
    senderNodesByStatus: {
      active: 1,
      warming: 0,
      paused: 0,
      quarantined: overrides.quarantinedNodes ?? 0,
      degraded: overrides.degradedNodes ?? 0,
      retired_pending_approval: 0
    },
    jobsByCampaign: [],
    sendResultsByCampaign: [],
    jobsBySenderNode: [],
    sendResultsBySenderNode: [],
    jobsBySenderDomain: [],
    jobsByRecipientDomain: [],
    auditActions: [],
    rateLimitCounters: []
  };
}

function healthDecision(senderNodeId: string, severity: SenderNodeHealthDecision["severity"]): SenderNodeHealthDecision {
  return {
    senderNodeId,
    currentStatus: severity === "critical" ? "quarantined" : "active",
    recommendedStatus: severity === "critical" ? "quarantined" : "active",
    severity,
    reasons: ["test"],
    metrics: {
      sent: 0,
      bounce: 0,
      complaint: severity === "critical" ? 1 : 0,
      deferred: 0,
      failed: 0,
      total: severity === "critical" ? 1 : 0
    }
  };
}

function audit(id: string, occurredAt: string): AuditEvent {
  return {
    id,
    occurredAt,
    actorType: "system",
    actorId: "test",
    action: "test.action",
    targetType: "test",
    targetId: "test",
    riskLevel: "low",
    metadata: {}
  };
}

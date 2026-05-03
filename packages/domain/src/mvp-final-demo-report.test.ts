import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdminOverview,
  buildMvpFinalDemoReport,
  buildOperationalSummary,
  getOperatingNorthSnapshot,
  type AuditEvent,
  type SenderNode
} from "./index.ts";

test("builds sponsor-ready final report when phase 5 evidence is complete", () => {
  const summary = buildOperationalSummary({
    jobs: [],
    sendResults: [],
    auditEvents: completeAuditEvents(),
    senderNodes: [senderNode()],
    rateLimitCounters: [],
    now: new Date("2026-05-03T00:00:00.000Z")
  });
  const adminOverview = buildAdminOverview({
    summary,
    health: [],
    auditEvents: completeAuditEvents(),
    now: new Date("2026-05-03T00:00:00.000Z")
  });
  const report = buildMvpFinalDemoReport({
    id: "mvp_final_report_001",
    actorId: "operator_1",
    auditEvents: completeAuditEvents(),
    operationalSummary: summary,
    adminOverview,
    operatingNorth: getOperatingNorthSnapshot()
  }, new Date("2026-05-03T00:01:00.000Z"));

  assert.equal(report.phase, "5.3-final-demo-report");
  assert.equal(report.decision.status, "ready_for_sponsor");
  assert.equal(report.decision.canPresentToSponsor, true);
  assert.equal(report.decision.canStartLimitedProduction, false);
  assert.equal(report.decision.canSendRealEmail, false);
  assert.equal(report.safety.volumePromiseEnabled, false);
  assert.equal(report.evidence.every((item) => item.status === "proven"), true);
  assert.ok(report.limitedProductionGates.some((item) => item.gate === "Warming and reputation review"));
  assert.ok(report.residualRisks.some((item) => item.code === "volume_not_promised"));
});

test("marks final report as needs review when phase 5 evidence is missing", () => {
  const auditEvents = [audit("demo.mvp_blueprint_created", "mvp_demo_001", "ready_for_demo")];
  const summary = buildOperationalSummary({
    jobs: [],
    sendResults: [],
    auditEvents,
    senderNodes: [senderNode()],
    rateLimitCounters: []
  });
  const adminOverview = buildAdminOverview({
    summary,
    health: [],
    auditEvents
  });
  const report = buildMvpFinalDemoReport({
    auditEvents,
    operationalSummary: summary,
    adminOverview,
    operatingNorth: getOperatingNorthSnapshot()
  });

  assert.equal(report.decision.status, "needs_review");
  assert.ok(report.decision.warnings.includes("phase_5_evidence_missing"));
  assert.equal(report.evidence.filter((item) => item.status === "missing").length, 2);
});

test("keeps limited production disabled even when sponsor report is ready", () => {
  const auditEvents = completeAuditEvents();
  const summary = buildOperationalSummary({
    jobs: [],
    sendResults: [],
    auditEvents,
    senderNodes: [senderNode()],
    rateLimitCounters: []
  });
  const adminOverview = buildAdminOverview({
    summary,
    health: [],
    auditEvents
  });
  const report = buildMvpFinalDemoReport({
    auditEvents,
    operationalSummary: summary,
    adminOverview,
    operatingNorth: getOperatingNorthSnapshot()
  });

  assert.equal(report.decision.status, "ready_for_sponsor");
  assert.equal(report.decision.canStartLimitedProduction, false);
  assert.equal(report.limitedProductionGates.some((item) => item.status === "needs_review"), true);
  assert.ok(report.decision.warnings.includes("limited_production_gates_need_review"));
});

function completeAuditEvents(): AuditEvent[] {
  return [
    audit("demo.mvp_blueprint_created", "mvp_demo_001", "ready_for_demo", "2026-05-03T00:00:00.000Z"),
    audit("demo.mvp_run.completed", "demo_run_001", "completed", "2026-05-03T00:01:00.000Z"),
    audit("demo.openclaw_incident.completed", "openclaw_incident_demo_001", "completed", "2026-05-03T00:02:00.000Z")
  ];
}

function audit(
  action: string,
  targetId: string,
  decisionStatus: string,
  occurredAt = "2026-05-03T00:00:00.000Z"
): AuditEvent {
  return {
    id: `audit_${action}`,
    occurredAt,
    actorType: "system",
    actorId: "test",
    action,
    targetType: "mvp_demo",
    targetId,
    riskLevel: "low",
    metadata: {
      decision: {
        status: decisionStatus
      }
    }
  };
}

function senderNode(): SenderNode {
  return {
    id: "sender_demo_001",
    label: "Demo sender",
    provider: "manual",
    status: "warming",
    ipAddress: "203.0.113.10",
    hostname: "mx001.delivrix.example",
    dailyLimit: 50,
    warmupDay: 1
  };
}

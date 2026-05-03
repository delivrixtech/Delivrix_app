import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKillSwitchState,
  buildDelivrixMvpDemoBlueprint,
  buildDelivrixMvpDemoRunReport,
  buildOpenClawIncidentDemoReport,
  type SenderNodeHealthDecision,
  type SendJob,
  type SendResult
} from "./index.ts";

test("builds completed OpenClaw incident demo with supervised local quarantine", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({
    simulatedResultStatus: "complaint"
  }, new Date("2026-05-03T00:00:00.000Z"));
  const demoRun = buildDelivrixMvpDemoRunReport({
    id: "demo_run_incident_001",
    blueprint,
    senderNode: blueprint.pipeline.senderNode,
    job: demoJob("completed"),
    result: demoResult("complaint"),
    healthDecisions: [demoHealth("sender_demo_001", "critical")]
  }, new Date("2026-05-03T00:01:00.000Z"));
  const report = buildOpenClawIncidentDemoReport({
    id: "openclaw_incident_demo_001",
    demoRun,
    humanApproved: true,
    appliedSenderNode: {
      ...blueprint.pipeline.senderNode,
      status: "quarantined"
    },
    auditEventIds: ["audit_1", "audit_2"]
  }, new Date("2026-05-03T00:02:00.000Z"));

  assert.equal(report.phase, "5.2-openclaw-incident-demo");
  assert.equal(report.decision.status, "completed");
  assert.equal(report.detection.detected, true);
  assert.equal(report.detection.status, "complaint");
  assert.equal(report.proposal.action, "quarantine_local_sender_node");
  assert.equal(report.proposal.manualAction, "quarantine");
  assert.equal(report.permissionChecks.withoutHumanApproval?.allowed, false);
  assert.ok(report.permissionChecks.withoutHumanApproval?.blockedBy.includes("human_approval_required"));
  assert.equal(report.permissionChecks.withHumanApproval?.allowed, true);
  assert.equal(report.permissionChecks.withKillSwitchActive?.allowed, false);
  assert.ok(report.permissionChecks.withKillSwitchActive?.blockedBy.includes("kill_switch_active"));
  assert.equal(report.localAction.applied, true);
  assert.equal(report.localAction.currentStatus, "quarantined");
  assert.deepEqual(report.auditEventIds, ["audit_1", "audit_2"]);
  assert.equal(report.safety.liveEmailSendingEnabled, false);
});

test("keeps OpenClaw incident demo in review without human approval", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({
    simulatedResultStatus: "bounce"
  }, new Date("2026-05-03T00:00:00.000Z"));
  const demoRun = buildDelivrixMvpDemoRunReport({
    blueprint,
    senderNode: blueprint.pipeline.senderNode,
    job: demoJob("completed"),
    result: demoResult("bounce")
  }, new Date("2026-05-03T00:01:00.000Z"));
  const report = buildOpenClawIncidentDemoReport({
    demoRun,
    humanApproved: false
  }, new Date("2026-05-03T00:02:00.000Z"));

  assert.equal(report.decision.status, "needs_review");
  assert.ok(report.decision.warnings.includes("human_approval_missing"));
  assert.ok(report.decision.warnings.includes("local_action_not_applied"));
  assert.equal(report.proposal.action, "degrade_local_sender_node");
  assert.equal(report.localAction.applied, false);
});

test("blocks OpenClaw incident demo when kill switch is active", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({
    simulatedResultStatus: "complaint"
  }, new Date("2026-05-03T00:00:00.000Z"));
  const demoRun = buildDelivrixMvpDemoRunReport({
    blueprint,
    senderNode: blueprint.pipeline.senderNode,
    job: demoJob("completed"),
    result: demoResult("complaint")
  }, new Date("2026-05-03T00:01:00.000Z"));
  const activeKillSwitch = buildKillSwitchState({
    enabled: true,
    reason: "Incident response freeze",
    updatedBy: "operator_local"
  });
  const report = buildOpenClawIncidentDemoReport({
    demoRun,
    killSwitch: activeKillSwitch,
    humanApproved: true
  }, new Date("2026-05-03T00:02:00.000Z"));

  assert.equal(report.decision.status, "blocked");
  assert.ok(report.decision.blockers.includes("runbook_permission_blocked"));
  assert.equal(report.permissionChecks.withHumanApproval?.allowed, false);
  assert.ok(report.permissionChecks.withHumanApproval?.blockedBy.includes("kill_switch_active"));
});

test("blocks OpenClaw incident demo without an incident", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({}, new Date("2026-05-03T00:00:00.000Z"));
  const demoRun = buildDelivrixMvpDemoRunReport({
    blueprint,
    senderNode: blueprint.pipeline.senderNode,
    job: demoJob("completed"),
    result: demoResult("sent")
  }, new Date("2026-05-03T00:01:00.000Z"));
  const report = buildOpenClawIncidentDemoReport({
    demoRun,
    humanApproved: true
  }, new Date("2026-05-03T00:02:00.000Z"));

  assert.equal(report.decision.status, "blocked");
  assert.ok(report.decision.blockers.includes("incident_missing"));
  assert.equal(report.proposal.action, null);
});

function demoJob(status: SendJob["status"]): SendJob {
  return {
    id: "sendjob_demo_001",
    request: buildDelivrixMvpDemoBlueprint().pipeline.sendRequest,
    status,
    createdAt: "2026-05-03T00:00:00.000Z",
    completedAt: status === "completed" ? "2026-05-03T00:01:00.000Z" : undefined,
    senderNodeId: "sender_demo_001"
  };
}

function demoResult(status: SendResult["status"]): SendResult {
  return {
    id: "sendresult_demo_001",
    sendJobId: "sendjob_demo_001",
    senderNodeId: "sender_demo_001",
    status,
    smtpResponse: status === "sent" ? "250 2.0.0 queued as dry-run" : undefined,
    complaintSource: status === "complaint" ? "simulated-feedback-loop" : undefined,
    bounceCode: status === "bounce" ? "5.1.1" : undefined,
    metadata: {
      simulated: true,
      reason: "test"
    },
    occurredAt: "2026-05-03T00:01:00.000Z"
  };
}

function demoHealth(
  senderNodeId: string,
  severity: SenderNodeHealthDecision["severity"]
): SenderNodeHealthDecision {
  return {
    senderNodeId,
    currentStatus: severity === "critical" ? "warming" : "warming",
    recommendedStatus: severity === "critical" ? "quarantined" : "warming",
    severity,
    reasons: severity === "critical" ? ["complaint_count 1 >= 1"] : ["within_thresholds"],
    metrics: {
      sent: 0,
      bounce: 0,
      complaint: severity === "critical" ? 1 : 0,
      deferred: 0,
      failed: 0,
      total: 1
    }
  };
}

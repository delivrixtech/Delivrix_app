import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDelivrixMvpDemoBlueprint,
  buildDelivrixMvpDemoRunReport,
  type SenderNodeHealthDecision,
  type SendJob,
  type SendResult
} from "./index.ts";

test("builds completed demo run report with linked local artifacts", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({}, new Date("2026-05-03T00:00:00.000Z"));
  const job = demoJob("completed");
  const result = demoResult("sent");
  const report = buildDelivrixMvpDemoRunReport({
    id: "demo_run_001",
    blueprint,
    senderNode: blueprint.pipeline.senderNode,
    job,
    result,
    auditEventIds: ["audit_1", "audit_2"]
  }, new Date("2026-05-03T00:00:00.000Z"));

  assert.equal(report.phase, "5.1-demo-runner-local-state");
  assert.equal(report.sideEffects, "local-state-only");
  assert.equal(report.decision.status, "completed");
  assert.equal(report.decision.canPresentToSponsor, true);
  assert.equal(report.decision.canSendRealEmail, false);
  assert.equal(report.artifacts.sendJobId, "sendjob_demo_001");
  assert.equal(report.artifacts.sendResultId, "sendresult_demo_001");
  assert.deepEqual(report.artifacts.auditEventIds, ["audit_1", "audit_2"]);
  assert.equal(report.safety.liveEmailSendingEnabled, false);
});

test("marks demo run as needs review when simulated result is an incident", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({}, new Date("2026-05-03T00:00:00.000Z"));
  const report = buildDelivrixMvpDemoRunReport({
    blueprint,
    senderNode: blueprint.pipeline.senderNode,
    job: demoJob("completed"),
    result: demoResult("complaint")
  });

  assert.equal(report.decision.status, "needs_review");
  assert.ok(report.decision.warnings.includes("simulated_result_complaint"));
  assert.equal(report.decision.nextRecommendedMilestone, "5.2_openclaw_incident_demo");
});

test("scopes health review to the demo sender node", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({}, new Date("2026-05-03T00:00:00.000Z"));
  const report = buildDelivrixMvpDemoRunReport({
    blueprint,
    senderNode: blueprint.pipeline.senderNode,
    job: demoJob("completed"),
    result: demoResult("sent"),
    healthDecisions: [
      demoHealth("sender_unrelated_001", "critical"),
      demoHealth("sender_demo_001", "healthy")
    ]
  });

  assert.equal(report.decision.status, "completed");
  assert.equal(report.decision.warnings.includes("health_needs_review"), false);
});

test("blocks demo run when required artifacts are missing", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({}, new Date("2026-05-03T00:00:00.000Z"));
  const report = buildDelivrixMvpDemoRunReport({
    blueprint,
    blockedReason: "Policy rejected the demo request."
  });

  assert.equal(report.decision.status, "blocked");
  assert.equal(report.decision.canPresentToSponsor, false);
  assert.ok(report.decision.blockers.includes("runner_blocked"));
  assert.ok(report.decision.blockers.includes("send_job_missing"));
});

test("blocks demo run when result was not simulated", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({}, new Date("2026-05-03T00:00:00.000Z"));
  const result = {
    ...demoResult("sent"),
    metadata: {
      simulated: false
    }
  };
  const report = buildDelivrixMvpDemoRunReport({
    blueprint,
    senderNode: blueprint.pipeline.senderNode,
    job: demoJob("completed"),
    result
  });

  assert.equal(report.decision.status, "blocked");
  assert.ok(report.decision.blockers.includes("result_not_simulated"));
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
    currentStatus: severity === "critical" ? "quarantined" : "warming",
    recommendedStatus: severity === "critical" ? "quarantined" : "warming",
    severity,
    reasons: severity === "critical" ? ["complaint_count 1 >= 1"] : ["within_thresholds"],
    metrics: {
      sent: severity === "healthy" ? 1 : 0,
      bounce: 0,
      complaint: severity === "critical" ? 1 : 0,
      deferred: 0,
      failed: 0,
      total: 1
    }
  };
}

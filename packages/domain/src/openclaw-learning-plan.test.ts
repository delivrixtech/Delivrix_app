import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenClawLearningPlan } from "./openclaw-learning-plan.ts";
import type { AuditEvent } from "./audit-log.ts";
import type { SenderNodeProvisioningRun } from "./sender-node-provisioning.ts";
import type { SendResult } from "./types.ts";

test("keeps OpenClaw learning in supervised evaluation mode", () => {
  const plan = buildOpenClawLearningPlan({
    auditEvents: [],
    provisioningRuns: [],
    sendResults: [],
    now: new Date("2026-05-03T21:30:00.000Z")
  });

  assert.equal(plan.generatedAt, "2026-05-03T21:30:00.000Z");
  assert.equal(plan.mode, "supervised_evaluation_only");
  assert.equal(plan.promotionPolicy.canSelfPromote, false);
  assert.equal(plan.safety.externalTrainingCallsEnabled, false);
  assert.equal(plan.safety.autonomousLiveActionsEnabled, false);
  assert.equal(plan.stages.find((stage) => stage.id === "observe")?.status, "needs_evidence");
  assert.equal(plan.stages.find((stage) => stage.id === "promote")?.status, "blocked");
});

test("marks learning stages ready when evidence exists", () => {
  const plan = buildOpenClawLearningPlan({
    auditEvents: [auditFixture()],
    provisioningRuns: [provisioningRunFixture()],
    sendResults: [sendResultFixture()]
  });

  assert.equal(plan.dataSources.find((source) => source.id === "audit_events")?.status, "ready");
  assert.equal(plan.dataSources.find((source) => source.id === "provisioning_dry_runs")?.evidenceCount, 1);
  assert.equal(plan.stages.find((stage) => stage.id === "evaluate")?.status, "ready");
  assert.equal(plan.evaluationGates.find((gate) => gate.id === "reputation_feedback")?.status, "ready");
});

function auditFixture(): AuditEvent {
  return {
    id: "audit_test",
    occurredAt: "2026-05-03T00:00:00.000Z",
    actorType: "openclaw",
    actorId: "openclaw-runbook",
    action: "openclaw.proposed_action",
    targetType: "sender_node",
    targetId: "sender_test",
    riskLevel: "medium",
    metadata: {
      decision: "needs_review"
    }
  };
}

function sendResultFixture(): SendResult {
  return {
    id: "result_test",
    sendJobId: "job_test",
    senderNodeId: "sender_test",
    status: "deferred",
    metadata: {},
    occurredAt: "2026-05-03T00:00:00.000Z"
  };
}

function provisioningRunFixture(): SenderNodeProvisioningRun {
  return {
    id: "provisioning_run_test",
    planId: "provisioning_plan_test",
    provider: "proxmox",
    senderNodeId: "sender_test",
    status: "simulated",
    dryRun: true,
    sideEffects: "local-state-only",
    createdAt: "2026-05-03T00:00:00.000Z",
    completedAt: "2026-05-03T00:00:01.000Z",
    steps: [],
    summary: {
      completedSteps: 0,
      blockedSteps: 0,
      externalSideEffects: false,
      smtpEnabled: false
    },
    plan: {
      id: "provisioning_plan_test",
      createdAt: "2026-05-03T00:00:00.000Z",
      provider: "proxmox",
      dryRun: true,
      sideEffects: "none",
      targetSenderNode: {
        id: "sender_test",
        label: "Sender test",
        provider: "proxmox",
        dailyLimit: 25
      },
      compute: {
        type: "lxc",
        cpuCores: 1,
        memoryMb: 1024,
        diskGb: 20,
        template: "debian-12",
        networkBridge: "vmbr0"
      },
      gates: [],
      blockedOperations: [],
      steps: []
    }
  };
}

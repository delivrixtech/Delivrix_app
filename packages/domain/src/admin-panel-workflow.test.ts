import assert from "node:assert/strict";
import test from "node:test";
import { buildAdminPanelWorkflow } from "./admin-panel-workflow.ts";
import type { AdminOverview } from "./admin-overview.ts";
import type { KillSwitchState } from "./kill-switch.ts";
import type { OperatingNorthSnapshot } from "./operating-north.ts";

test("builds the admin panel workflow as a GET-only route contract", () => {
  const workflow = buildAdminPanelWorkflow({
    overview: overviewFixture("healthy"),
    operatingNorth: northFixture(),
    killSwitch: killSwitchFixture(),
    now: new Date("2026-05-03T20:00:00.000Z")
  });

  assert.equal(workflow.generatedAt, "2026-05-03T20:00:00.000Z");
  assert.equal(workflow.mode, "read_only");
  assert.deepEqual(workflow.readBoundary.allowedMethods, ["GET"]);
  assert.deepEqual(workflow.readBoundary.blockedMethods, ["POST", "PUT", "PATCH", "DELETE"]);
  assert.ok(workflow.readBoundary.allowedEndpoints.includes("/v1/admin/workflow"));
  assert.ok(workflow.readBoundary.allowedEndpoints.includes("/v1/admin/clusters"));
  assert.ok(workflow.readBoundary.allowedEndpoints.includes("/v1/openclaw/learning-plan"));
  assert.equal(workflow.steps[0]?.id, "workflow");
  assert.equal(workflow.steps.at(-1)?.id, "safety");
  assert.ok(workflow.steps.some((step) => step.id === "clusters"));
  assert.ok(workflow.steps.some((step) => step.id === "learning"));
});

test("marks workflow sections blocked when overview has critical state", () => {
  const workflow = buildAdminPanelWorkflow({
    overview: overviewFixture("critical"),
    operatingNorth: northFixture(),
    killSwitch: killSwitchFixture()
  });

  assert.equal(workflow.steps.find((step) => step.id === "overview")?.status, "blocked");
  assert.equal(workflow.steps.find((step) => step.id === "fleet")?.status, "blocked");
});

test("blocks safety when operating north violates MVP boundary", () => {
  const workflow = buildAdminPanelWorkflow({
    overview: overviewFixture("healthy"),
    operatingNorth: {
      ...northFixture(),
      liveInfrastructureWritesEnabled: true
    },
    killSwitch: killSwitchFixture()
  });

  assert.equal(workflow.steps.find((step) => step.id === "safety")?.status, "blocked");
});

function overviewFixture(state: AdminOverview["state"]): AdminOverview {
  const severity = state === "critical" ? "critical" : state === "warning" ? "warning" : "healthy";

  return {
    generatedAt: "2026-05-03T00:00:00.000Z",
    state,
    summary: {
      generatedAt: "2026-05-03T00:00:00.000Z",
      totals: {
        jobs: 0,
        auditEvents: 1,
        senderNodes: 1,
        sendResults: 0
      },
      jobsByStatus: {
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        blocked: 0
      },
      sendResultsByStatus: {
        sent: 0,
        bounce: 0,
        complaint: 0,
        deferred: 0,
        failed: 0
      },
      senderNodesByStatus: {
        active: 1,
        warming: 0,
        paused: 0,
        quarantined: state === "critical" ? 1 : 0,
        degraded: state === "warning" ? 1 : 0,
        retired_pending_approval: 0,
        retired: 0
      },
      jobsByCampaign: [],
      sendResultsByCampaign: [],
      jobsBySenderNode: [],
      sendResultsBySenderNode: [],
      jobsBySenderDomain: [],
      jobsByRecipientDomain: [],
      auditActions: [],
      rateLimitCounters: []
    },
    health: [
      {
        senderNodeId: "sender_test",
        currentStatus: severity === "critical" ? "quarantined" : severity === "warning" ? "degraded" : "active",
        recommendedStatus: severity === "critical" ? "quarantined" : severity === "warning" ? "degraded" : "active",
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
      }
    ],
    alerts: [],
    recentAuditEvents: [
      {
        id: "audit_test",
        occurredAt: "2026-05-03T00:00:00.000Z",
        actorType: "system",
        actorId: "test",
        action: "test.action",
        targetType: "test",
        targetId: "test",
        riskLevel: "low",
        metadata: {}
      }
    ]
  };
}

function northFixture(): OperatingNorthSnapshot {
  return {
    sourceOfTruth: "NORTE_OPERATIVO_DELIVRIX.md",
    phase: "5.4C-admin-cluster-learning-contracts",
    delivrixRole: "control_plane",
    nfcRole: "future_optional_external_integration",
    openClawRole: "intelligent_cluster_operator_read_only",
    delivrixSendsRealEmail: false,
    nfcSendsRealEmail: false,
    liveInfrastructureWritesEnabled: false,
    nfcProductionWritesEnabled: false,
    allowedActions: [],
    blockedActions: [],
    gates: []
  };
}

function killSwitchFixture(): KillSwitchState {
  return {
    enabled: false,
    reason: "Kill switch disabled.",
    updatedAt: "2026-05-03T00:00:00.000Z",
    updatedBy: "test"
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { buildAdminClusterOverview } from "./admin-cluster-overview.ts";
import type { KillSwitchState } from "./kill-switch.ts";
import type { SenderNodeHealthDecision } from "./sender-node-health.ts";
import type { SenderNodeProvisioningRun } from "./sender-node-provisioning.ts";
import type { SenderNode } from "./types.ts";

test("builds a read-only cluster contract when onboarding still has no nodes", () => {
  const overview = buildAdminClusterOverview({
    senderNodes: [],
    health: [],
    provisioningRuns: [],
    killSwitch: killSwitchFixture(),
    now: new Date("2026-05-03T21:00:00.000Z")
  });

  assert.equal(overview.generatedAt, "2026-05-03T21:00:00.000Z");
  assert.equal(overview.mode, "read_only");
  assert.equal(overview.safety.liveInfrastructureWritesEnabled, false);
  assert.equal(overview.clusters[0]?.managementState, "needs_onboarding");
  assert.ok(overview.nextActions.some((action) => action.id === "complete_openclaw_onboarding"));
  assert.ok(overview.openClawDelegation.blockedInMvp.includes("smtp-send"));
});

test("groups sender nodes by provider and marks healthy clusters dry-run ready", () => {
  const node = senderNodeFixture("sender_1", "proxmox", "warming");
  const health = healthFixture(node.id, "healthy");
  const run = provisioningRunFixture(node.id);
  const overview = buildAdminClusterOverview({
    senderNodes: [node],
    health: [health],
    provisioningRuns: [run],
    killSwitch: killSwitchFixture()
  });

  assert.equal(overview.totals.senderNodes, 1);
  assert.equal(overview.totals.activeOrWarmingNodes, 1);
  assert.equal(overview.totals.simulatedProvisioningRuns, 1);
  assert.equal(overview.clusters[0]?.provider, "proxmox");
  assert.equal(overview.clusters[0]?.managementState, "dry_run_ready");
  assert.equal(overview.clusters[0]?.senderNodes[0]?.healthSeverity, "healthy");
});

test("blocks cluster administration when a critical node exists", () => {
  const node = senderNodeFixture("sender_critical", "proxmox", "quarantined");
  const overview = buildAdminClusterOverview({
    senderNodes: [node],
    health: [healthFixture(node.id, "critical")],
    provisioningRuns: [],
    killSwitch: killSwitchFixture()
  });

  assert.equal(overview.clusters[0]?.managementState, "blocked");
  assert.equal(overview.totals.blockedNodes, 1);
  assert.ok(overview.nextActions.some((action) => action.id === "review_quarantine_candidates"));
});

function senderNodeFixture(
  id: string,
  provider: SenderNode["provider"],
  status: SenderNode["status"]
): SenderNode {
  return {
    id,
    label: "Sender test",
    provider,
    status,
    hostname: `${id}.delivrix.local`,
    ipAddress: "192.0.2.10",
    dailyLimit: 25,
    warmupDay: 1
  };
}

function healthFixture(
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
      sent: 0,
      bounce: 0,
      complaint: severity === "critical" ? 1 : 0,
      deferred: 0,
      failed: 0,
      total: severity === "critical" ? 1 : 0
    }
  };
}

function provisioningRunFixture(senderNodeId: string): SenderNodeProvisioningRun {
  return {
    id: "provisioning_run_test",
    planId: "provisioning_plan_test",
    provider: "proxmox",
    senderNodeId,
    status: "simulated",
    dryRun: true,
    sideEffects: "local-state-only",
    createdAt: "2026-05-03T00:00:00.000Z",
    completedAt: "2026-05-03T00:00:01.000Z",
    registeredSenderNodeId: senderNodeId,
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
        id: senderNodeId,
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

function killSwitchFixture(): KillSwitchState {
  return {
    enabled: false,
    reason: "disabled",
    updatedAt: "2026-05-03T00:00:00.000Z",
    updatedBy: "test"
  };
}

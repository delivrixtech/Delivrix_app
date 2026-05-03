import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKillSwitchState,
  buildOpenClawOperationalRunbook,
  buildOpenClawProvisioningDryRun,
  evaluateOpenClawActionPermission,
  runOpenClawScheduler,
  type OpenClawOnboardingInput
} from "./index.ts";

test("builds Hito 4.5 runbook with permission matrix and kill switch proof", () => {
  const runbook = buildOpenClawOperationalRunbook({
    actorId: "operator_1",
    schedulerRun: readySchedulerRun()
  }, new Date("2026-05-03T00:00:00.000Z"));

  assert.equal(runbook.phase, "4.5-runbook-permissions-kill-switch");
  assert.equal(runbook.dryRun, true);
  assert.equal(runbook.sideEffects, "none");
  assert.equal(runbook.decision.status, "ready_for_phase_5_demo");
  assert.equal(runbook.decision.canRunPhase5Demo, true);
  assert.equal(runbook.decision.canStartLimitedProduction, false);
  assert.ok(runbook.permissionMatrix.some((item) => item.action === "run_scheduler_observer"));
  assert.ok(runbook.permissionMatrix.some((item) => item.action === "proxmox_live_create" && !item.allowedInHito45));
  assert.equal(runbook.killSwitchProof.blocksOpenClawProposedActions, true);
  assert.equal(runbook.killSwitchProof.blocksLiveInfrastructureActions, true);
  assert.equal(runbook.safety.liveEmailSendingEnabled, false);
  assert.equal(runbook.safety.killSwitchRequiredForSupervisedActions, true);
});

test("allows read-only scheduler action without requiring inactive kill switch", () => {
  const activeKillSwitch = buildKillSwitchState({
    enabled: true,
    reason: "Incident response",
    updatedBy: "operator_1"
  });
  const decision = evaluateOpenClawActionPermission({
    action: "run_scheduler_observer",
    mode: "read_only",
    killSwitch: activeKillSwitch
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
  assert.equal(decision.requiresKillSwitchInactive, false);
});

test("requires human approval and inactive kill switch for supervised local actions", () => {
  const activeKillSwitch = buildKillSwitchState({
    enabled: true,
    reason: "Incident response",
    updatedBy: "operator_1"
  });
  const withoutApproval = evaluateOpenClawActionPermission({
    action: "register_local_sender_node",
    mode: "supervised"
  });
  const withActiveKillSwitch = evaluateOpenClawActionPermission({
    action: "register_local_sender_node",
    mode: "supervised",
    humanApproved: true,
    killSwitch: activeKillSwitch
  });

  assert.equal(withoutApproval.allowed, false);
  assert.ok(withoutApproval.blockedBy.includes("human_approval_required"));
  assert.equal(withActiveKillSwitch.allowed, false);
  assert.ok(withActiveKillSwitch.blockedBy.includes("kill_switch_active"));
});

test("blocks live infrastructure and real email actions in Hito 4.5", () => {
  const proxmox = evaluateOpenClawActionPermission({
    action: "proxmox_live_create",
    mode: "live",
    humanApproved: true
  });
  const smtp = evaluateOpenClawActionPermission({
    action: "smtp_send",
    mode: "live",
    humanApproved: true
  });

  assert.equal(proxmox.allowed, false);
  assert.deepEqual(proxmox.blockedBy, ["phase_4_5_gate", "future_phase_required"]);
  assert.equal(smtp.allowed, false);
  assert.deepEqual(smtp.blockedBy, ["prohibited_action"]);
});

test("marks runbook as needs review when scheduler report is not ready", () => {
  const schedulerRun = runOpenClawScheduler({}, new Date("2026-05-03T00:00:00.000Z"));
  const runbook = buildOpenClawOperationalRunbook({
    schedulerRun
  }, new Date("2026-05-03T00:00:00.000Z"));

  assert.equal(schedulerRun.decision.status, "blocked");
  assert.equal(runbook.decision.status, "needs_review");
  assert.equal(runbook.decision.canRunPhase5Demo, false);
  assert.ok(runbook.checklist.some((item) => item.code === "scheduler_report_available" && item.status === "needs_review"));
});

function readySchedulerRun() {
  const provisioningPlan = buildOpenClawProvisioningDryRun({
    actorId: "operator_1",
    topologyInput: {
      actorId: "operator_1",
      clusterName: "delivrix-pilot",
      onboarding: completeOnboarding()
    }
  }, new Date("2026-05-03T00:00:00.000Z"));

  return runOpenClawScheduler({
    actorId: "operator_1",
    provisioningPlan
  }, new Date("2026-05-03T00:00:00.000Z"));
}

function completeOnboarding(): OpenClawOnboardingInput {
  return {
    actorId: "operator_1",
    server: {
      model: "IBM System x3630 M4",
      location: "Popayan",
      cpuCores: 24,
      ramGb: 128,
      storage: {
        type: "ssd",
        usableGb: 2000,
        redundant: true
      },
      network: {
        provider: "business-isp",
        uplinkMbps: 500,
        staticIp: true
      },
      upsReady: true,
      coolingMonitored: true
    },
    proxmox: {
      status: "installed",
      version: "8.x",
      apiReachable: true
    },
    ipPool: {
      totalIps: 32,
      type: "leased",
      cidrs: ["203.0.113.0/27"],
      providerApproval: true,
      reputationChecked: true,
      ptrDelegation: true
    },
    domains: [
      {
        domain: "delivrix.example",
        dnsProvider: "route53",
        ownershipVerified: true,
        spfReady: true,
        dkimReady: true,
        dmarcReady: true,
        ptrPlanReady: true
      }
    ],
    dns: {
      provider: "route53",
      apiAccess: true,
      canManageSpfDkimDmarc: true,
      canManagePtr: true
    },
    compliance: {
      physicalAddressReady: true,
      optOutReady: true,
      suppressionListReady: true,
      consentProofAvailable: true,
      trafficAuthorizedByProvider: true
    },
    limits: {
      targetDailyVolume: 150,
      initialSenderNodes: 3,
      maxSenderNodes: 30,
      dailyLimitPerNode: 50,
      warmupDays: 21
    },
    security: {
      secretsManagerReady: true,
      sshKeyPolicyReady: true,
      auditLogRequired: true,
      killSwitchRequired: true
    },
    autonomy: {
      mode: "supervised",
      humanApprovalRequired: true
    }
  };
}

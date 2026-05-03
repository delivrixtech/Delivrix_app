import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenClawProvisioningDryRun,
  runOpenClawScheduler,
  type OpenClawOnboardingInput
} from "./index.ts";

test("runs OpenClaw scheduler with default tasks and no LLM", () => {
  const run = runOpenClawScheduler({
    actorId: "operator_1",
    provisioningPlan: readyProvisioningPlan()
  }, new Date("2026-05-02T00:00:00.000Z"));

  assert.equal(run.phase, "4.4-openclaw-scheduler-and-skills");
  assert.equal(run.dryRun, true);
  assert.equal(run.sideEffects, "none");
  assert.equal(run.decision.status, "report_ready");
  assert.equal(run.decision.canExecuteLiveActions, false);
  assert.equal(run.llmRouter.mode, "disabled");
  assert.equal(run.llmRouter.provider, "none");
  assert.equal(run.llmRouter.promptBudgetUsedUsd, 0);
  assert.deepEqual(run.tasks.map((task) => task.name), [
    "health-check",
    "fleet-analysis",
    "ip-reputation-check",
    "daily-report"
  ]);
  assert.equal(run.tasks.every((task) => task.liveActionsEnabled === false), true);
  assert.equal(run.skills.map((skill) => skill.name).join(","), "fleet-ops,alert-ops,report-ops");
  assert.equal(run.dailyReport.mode, "observer");
  assert.equal(run.dailyReport.humanReviewRequired, false);
  assert.equal(run.safety.sshEnabled, false);
  assert.equal(run.safety.smtpEnabled, false);
  assert.ok(run.blockedActions.includes("openclaw-live-action-execute"));
});

test("blocks scheduler when provisioning dry-run source is missing", () => {
  const run = runOpenClawScheduler({}, new Date("2026-05-02T00:00:00.000Z"));

  assert.equal(run.decision.status, "blocked");
  assert.equal(run.sourceProvisioningId, null);
  assert.equal(run.dailyReport.fleet.provisioningDecision, "missing");
  assert.equal(run.skills.every((skill) => skill.status === "blocked"), true);
  assert.ok(run.proposedActions.some((action) => action.code === "complete-provisioning-dry-run"));
});

test("keeps scheduler in review mode when provisioning has high risk", () => {
  const onboarding = completeOnboarding();
  onboarding.ipPool = {
    ...onboarding.ipPool,
    reputationChecked: false
  };

  const run = runOpenClawScheduler({
    provisioningInput: {
      actorId: "operator_1",
      topologyInput: {
        onboarding
      }
    }
  });

  assert.equal(run.decision.status, "needs_review");
  assert.equal(run.dailyReport.humanReviewRequired, true);
  assert.ok(run.proposedActions.some((action) => action.requiresHumanApproval));
  assert.equal(run.safety.proxmoxApiEnabled, false);
  assert.equal(run.safety.dnsLiveChangesEnabled, false);
});

test("supports mock LLM router without external model calls", () => {
  const run = runOpenClawScheduler({
    llmMode: "mock",
    provisioningPlan: readyProvisioningPlan()
  });

  assert.equal(run.llmRouter.mode, "mock");
  assert.equal(run.llmRouter.provider, "mock");
  assert.equal(run.llmRouter.degradedMode, true);
  assert.equal(run.llmRouter.fallback, "deterministic_rule_based_skills");
  assert.equal(run.llmRouter.promptBudgetUsedUsd, 0);
});

function readyProvisioningPlan() {
  return buildOpenClawProvisioningDryRun({
    actorId: "operator_1",
    topologyInput: {
      actorId: "operator_1",
      clusterName: "delivrix-pilot",
      onboarding: completeOnboarding()
    }
  }, new Date("2026-05-02T00:00:00.000Z"));
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

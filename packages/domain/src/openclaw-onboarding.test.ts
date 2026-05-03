import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOpenClawOnboarding,
  getOpenClawOnboardingQuestionnaire,
  type OpenClawOnboardingInput
} from "./openclaw-onboarding.ts";

test("returns guided questions for critical infrastructure onboarding", () => {
  const questionnaire = getOpenClawOnboardingQuestionnaire(new Date("2026-05-02T00:00:00.000Z"));

  assert.equal(questionnaire.phase, "4.1-openclaw-intelligent-onboarding");
  assert.equal(questionnaire.dryRun, true);
  assert.equal(questionnaire.sideEffects, "none");
  assert.ok(questionnaire.questions.some((question) => question.id === "server.model"));
  assert.ok(questionnaire.questions.some((question) => question.id === "compliance.opt_out"));
  assert.ok(questionnaire.gates.includes("no_topology_plan_without_critical_onboarding_data"));
});

test("blocks topology planning when critical onboarding data is missing", () => {
  const snapshot = evaluateOpenClawOnboarding({
    actorId: "operator_1",
    server: {
      model: "IBM System x3630 M4"
    }
  }, new Date("2026-05-02T00:00:00.000Z"));

  assert.equal(snapshot.actorId, "operator_1");
  assert.equal(snapshot.decision.status, "no_go");
  assert.equal(snapshot.decision.canGenerateTopologyPlan, false);
  assert.equal(snapshot.dryRun, true);
  assert.equal(snapshot.safety.liveInfrastructureWritesEnabled, false);
  assert.ok(snapshot.missingCriticalFields.includes("server.cpu_cores"));
  assert.ok(snapshot.missingCriticalFields.includes("compliance.opt_out"));
  assert.ok(snapshot.recommendedNextQuestions.some((question) => question.id === "compliance.opt_out"));
});

test("returns go when the onboarding data is complete and conservative", () => {
  const snapshot = evaluateOpenClawOnboarding(completeInput(), new Date("2026-05-02T00:00:00.000Z"));

  assert.equal(snapshot.decision.status, "go");
  assert.equal(snapshot.decision.canGenerateTopologyPlan, true);
  assert.equal(snapshot.decision.canRunProvisioningDryRun, false);
  assert.equal(snapshot.decision.nextRecommendedMilestone, "4.2_cluster_topology_planner");
  assert.equal(snapshot.blockers.length, 0);
  assert.equal(snapshot.warnings.length, 0);
  assert.equal(snapshot.readiness.total, 100);
});

test("allows topology planning with review when Proxmox is planned but not installed", () => {
  const input = completeInput();
  input.proxmox = {
    status: "planned"
  };

  const snapshot = evaluateOpenClawOnboarding(input);

  assert.equal(snapshot.decision.status, "needs_review");
  assert.equal(snapshot.decision.canGenerateTopologyPlan, true);
  assert.ok(snapshot.warnings.includes("proxmox_planned_not_installed"));
});

test("blocks unsafe autonomy mode before OpenClaw can continue", () => {
  const input = completeInput();
  input.autonomy = {
    mode: "limited",
    humanApprovalRequired: true
  };

  const snapshot = evaluateOpenClawOnboarding(input);

  assert.equal(snapshot.decision.status, "no_go");
  assert.equal(snapshot.decision.canGenerateTopologyPlan, false);
  assert.ok(snapshot.blockers.includes("missing_or_unsafe_autonomy_mode"));
});

function completeInput(): OpenClawOnboardingInput {
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
      targetDailyVolume: 5000,
      initialSenderNodes: 5,
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenClawTopologyPlan,
  type OpenClawOnboardingInput
} from "./index.ts";

test("builds a conservative dry-run topology plan from complete onboarding", () => {
  const plan = buildOpenClawTopologyPlan({
    actorId: "operator_1",
    clusterName: "delivrix-pilot",
    strategy: "conservative",
    onboarding: completeOnboarding()
  }, new Date("2026-05-02T00:00:00.000Z"));

  assert.equal(plan.phase, "4.2-cluster-topology-planner");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.sideEffects, "none");
  assert.equal(plan.decision.status, "plan_ready");
  assert.equal(plan.decision.canRunProvisioningDryRun, true);
  assert.equal(plan.summary.plannedSenderNodes, 5);
  assert.equal(plan.summary.estimatedInitialDailyCapacity, 250);
  assert.equal(plan.clusters.length, 1);
  assert.equal(plan.clusters[0].nodes[0].compute.type, "lxc");
  assert.equal(plan.clusters[0].nodes[0].compute.cpuCores, 1);
  assert.equal(plan.clusters[0].nodes[0].network.hostname, "mx001.delivrix.example");
  assert.equal(plan.clusters[0].nodes[0].network.ipAssignment.mode, "reserved_from_pool");
  assert.equal(plan.safety.proxmoxApiEnabled, false);
  assert.ok(plan.blockedActions.includes("smtp-send"));
});

test("blocks topology plan when onboarding is no-go", () => {
  const plan = buildOpenClawTopologyPlan({
    onboarding: {
      server: {
        model: "IBM System x3630 M4"
      }
    }
  });

  assert.equal(plan.decision.status, "blocked");
  assert.equal(plan.decision.canRunProvisioningDryRun, false);
  assert.equal(plan.summary.plannedSenderNodes, 0);
  assert.equal(plan.clusters.length, 0);
  assert.ok(plan.risks.some((risk) => risk.code === "onboarding_no_go"));
});

test("requires review when requested nodes exceed safe budget", () => {
  const onboarding = completeOnboarding();
  onboarding.limits = {
    ...onboarding.limits,
    initialSenderNodes: 40,
    maxSenderNodes: 40
  };
  onboarding.ipPool = {
    ...onboarding.ipPool,
    totalIps: 8
  };

  const plan = buildOpenClawTopologyPlan({
    onboarding
  });

  assert.equal(plan.decision.status, "needs_review");
  assert.equal(plan.decision.canRunProvisioningDryRun, false);
  assert.equal(plan.summary.requestedSenderNodes, 40);
  assert.equal(plan.summary.plannedSenderNodes, 8);
  assert.ok(plan.risks.some((risk) => risk.code === "requested_nodes_exceed_safe_budget"));
});

test("requires review when IP reputation is not checked", () => {
  const onboarding = completeOnboarding();
  onboarding.ipPool = {
    ...onboarding.ipPool,
    reputationChecked: false
  };

  const plan = buildOpenClawTopologyPlan({
    onboarding
  });

  assert.equal(plan.decision.status, "needs_review");
  assert.equal(plan.decision.riskLevel, "high");
  assert.ok(plan.risks.some((risk) => risk.code === "ip_reputation_not_checked"));
});

test("uses balanced sizing when requested", () => {
  const plan = buildOpenClawTopologyPlan({
    strategy: "balanced",
    onboarding: completeOnboarding()
  });

  assert.equal(plan.strategy, "balanced");
  assert.equal(plan.resourceBudget.nodeCpuCores, 2);
  assert.equal(plan.resourceBudget.nodeMemoryMb, 2048);
  assert.equal(plan.clusters[0].nodes[0].compute.diskGb, 32);
});

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
      targetDailyVolume: 250,
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

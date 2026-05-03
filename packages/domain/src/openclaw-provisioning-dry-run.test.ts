import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOpenClawProvisioningDryRun,
  buildOpenClawTopologyPlan,
  type OpenClawOnboardingInput
} from "./index.ts";

test("builds dry-run provisioning plans for every topology node", () => {
  const topologyPlan = buildOpenClawTopologyPlan({
    actorId: "operator_1",
    clusterName: "delivrix-pilot",
    onboarding: completeOnboarding()
  }, new Date("2026-05-02T00:00:00.000Z"));
  const dryRun = buildOpenClawProvisioningDryRun({
    actorId: "operator_1",
    topologyPlan
  }, new Date("2026-05-02T00:00:00.000Z"));

  assert.equal(dryRun.phase, "4.3-provisioning-dry-run-executor");
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.sideEffects, "none");
  assert.equal(dryRun.decision.status, "dry_run_ready");
  assert.equal(dryRun.decision.canApplyLiveInfrastructure, false);
  assert.equal(dryRun.summary.nodesPlanned, 3);
  assert.equal(dryRun.summary.proxmoxPlans, 3);
  assert.equal(dryRun.summary.dnsRecordsPlanned, 18);
  assert.equal(dryRun.nodePlans[0].proxmox.dryRun, true);
  assert.equal(dryRun.nodePlans[0].postfix.smtpDeliveryEnabled, false);
  assert.equal(dryRun.nodePlans[0].openDkim.keyGenerationMode, "dry_run_only");
  assert.equal(dryRun.nodePlans[0].tls.certificateMode, "planned_only");
  assert.equal(dryRun.nodePlans[0].dns.records.every((record) => record.liveChange === false), true);
  assert.equal(dryRun.safety.proxmoxApiEnabled, false);
  assert.ok(dryRun.blockedActions.includes("ssh-connect"));
});

test("blocks provisioning dry-run when topology is blocked", () => {
  const dryRun = buildOpenClawProvisioningDryRun({
    topologyInput: {
      onboarding: {
        server: {
          model: "IBM System x3630 M4"
        }
      }
    }
  });

  assert.equal(dryRun.decision.status, "blocked");
  assert.equal(dryRun.summary.nodesPlanned, 0);
  assert.equal(dryRun.nodePlans.length, 0);
  assert.ok(dryRun.risks.some((risk) => risk.code === "topology_blocked"));
});

test("requires review when topology plan requires review", () => {
  const onboarding = completeOnboarding();
  onboarding.ipPool = {
    ...onboarding.ipPool,
    reputationChecked: false
  };

  const dryRun = buildOpenClawProvisioningDryRun({
    topologyInput: {
      onboarding
    }
  });

  assert.equal(dryRun.decision.status, "needs_review");
  assert.equal(dryRun.decision.canApplyLiveInfrastructure, false);
  assert.ok(dryRun.risks.some((risk) => risk.code === "topology_needs_review"));
});

test("generates DNS, DKIM, TLS and warming placeholders without secrets", () => {
  const dryRun = buildOpenClawProvisioningDryRun({
    topologyInput: {
      onboarding: completeOnboarding()
    }
  });
  const node = dryRun.nodePlans[0];

  assert.equal(node.dns.records.some((record) => record.type === "PTR"), true);
  assert.equal(node.dns.records.some((record) => record.value.includes("pending-secret-managed-public-key")), true);
  assert.equal(node.openDkim.keyStorage, "secrets_manager_required");
  assert.equal(node.tls.privateKeyStorage, "secrets_manager_required");
  assert.equal(node.warming.checkpoints.length, 3);
  assert.ok(node.warming.blockedOperations.includes("smtp-send-live"));
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

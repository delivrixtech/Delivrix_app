import { createId } from "./ids.ts";
import {
  buildOpenClawTopologyPlan,
  type OpenClawTopologyPlan,
  type OpenClawTopologyPlannerInput,
  type OpenClawTopologyRiskSeverity
} from "./openclaw-topology-planner.ts";
import {
  buildSenderNodeProvisioningPlan,
  type SenderNodeProvisioningPlan
} from "./sender-node-provisioning.ts";

export type OpenClawProvisioningDecisionStatus = "dry_run_ready" | "needs_review" | "blocked";
export type OpenClawProvisioningRiskSeverity = OpenClawTopologyRiskSeverity;
export type DnsRecordType = "A" | "MX" | "TXT" | "PTR";

export interface OpenClawProvisioningDryRunInput {
  actorId?: string;
  topologyPlan?: OpenClawTopologyPlan;
  topologyInput?: OpenClawTopologyPlannerInput;
}

export interface OpenClawProvisioningRisk {
  code: string;
  severity: OpenClawProvisioningRiskSeverity;
  message: string;
  recommendation: string;
}

export interface OpenClawPostfixPlan {
  hostname: string;
  domain: string;
  configProfile: "sender-node-baseline";
  queueMode: "local-only-until-approved";
  smtpDeliveryEnabled: false;
  plannedMainCf: Record<string, string>;
  blockedOperations: string[];
}

export interface OpenClawOpenDkimPlan {
  domain: string;
  selector: string;
  keyGenerationMode: "dry_run_only";
  keyStorage: "secrets_manager_required";
  signingTablePreview: string;
  blockedOperations: string[];
}

export interface OpenClawTlsPlan {
  hostname: string;
  certificateMode: "planned_only";
  commonName: string;
  subjectAlternativeNames: string[];
  privateKeyStorage: "secrets_manager_required";
  blockedOperations: string[];
}

export interface OpenClawDnsRecordPlan {
  type: DnsRecordType;
  name: string;
  value: string;
  ttl: number;
  purpose: string;
  liveChange: false;
}

export interface OpenClawDnsPlan {
  providerMode: "planned_only";
  domain: string;
  records: OpenClawDnsRecordPlan[];
  blockedOperations: string[];
}

export interface OpenClawWarmingPlan {
  dayStart: 0;
  warmupDays: number;
  initialDailyLimit: number;
  emailsPerMinute: number;
  checkpoints: Array<{
    day: number;
    maxDailyLimit: number;
    gate: string;
  }>;
  blockedOperations: string[];
}

export interface OpenClawProvisioningNodeDryRun {
  senderNodeId: string;
  provisioningOrder: number;
  dryRun: true;
  sideEffects: "none";
  proxmox: SenderNodeProvisioningPlan;
  postfix: OpenClawPostfixPlan;
  openDkim: OpenClawOpenDkimPlan;
  tls: OpenClawTlsPlan;
  dns: OpenClawDnsPlan;
  warming: OpenClawWarmingPlan;
  blockedActions: string[];
  requiredApprovals: string[];
}

export interface OpenClawProvisioningDecision {
  status: OpenClawProvisioningDecisionStatus;
  canApplyLiveInfrastructure: false;
  nextRecommendedMilestone: "continue_onboarding" | "review_topology_plan" | "review_provisioning_dry_run" | "4.4_openclaw_scheduler_and_skills";
  riskLevel: OpenClawProvisioningRiskSeverity;
  reason: string;
}

export interface OpenClawProvisioningDryRunPlan {
  id: string;
  createdAt: string;
  phase: "4.3-provisioning-dry-run-executor";
  actorId: string;
  sourceTopologyId: string;
  dryRun: true;
  sideEffects: "none";
  topology: {
    decisionStatus: OpenClawTopologyPlan["decision"]["status"];
    clusterName: string;
    plannedSenderNodes: number;
    estimatedInitialDailyCapacity: number;
  };
  decision: OpenClawProvisioningDecision;
  summary: {
    nodesPlanned: number;
    proxmoxPlans: number;
    postfixPlans: number;
    openDkimPlans: number;
    tlsPlans: number;
    dnsRecordsPlanned: number;
    warmingPlans: number;
  };
  nodePlans: OpenClawProvisioningNodeDryRun[];
  risks: OpenClawProvisioningRisk[];
  gates: string[];
  requiredApprovals: string[];
  blockedActions: string[];
  safety: {
    liveInfrastructureWritesEnabled: false;
    proxmoxApiEnabled: false;
    sshEnabled: false;
    postfixLiveApplyEnabled: false;
    openDkimLiveKeyGenerationEnabled: false;
    tlsLiveCertificateRequestEnabled: false;
    dnsLiveChangesEnabled: false;
    smtpEnabled: false;
    nfcWritesEnabled: false;
  };
}

const requiredApprovals = [
  "operator_approval_before_any_live_apply",
  "proxmox_resource_review",
  "ssh_access_review",
  "dns_records_review",
  "dkim_key_management_review",
  "tls_certificate_review",
  "warming_limits_review"
];

const blockedActions = [
  "proxmox-live-create",
  "ssh-connect",
  "postfix-apply-live",
  "opendkim-live-key-generation",
  "tls-live-certificate-request",
  "dns-live-change",
  "smtp-send",
  "increase-volume",
  "nfc-production-write"
];

export function buildOpenClawProvisioningDryRun(
  input: OpenClawProvisioningDryRunInput,
  now = new Date()
): OpenClawProvisioningDryRunPlan {
  const topology = resolveTopologyPlan(input, now);
  const actorId = input.actorId?.trim() || topology.actorId;
  const risks = buildRisks(topology);
  const shouldBuildNodePlans = topology.decision.status !== "blocked";
  const nodePlans = shouldBuildNodePlans
    ? topology.clusters.flatMap((cluster) =>
      cluster.nodes.map((node) => buildNodeDryRun(topology, node, now))
    )
    : [];
  const decision = buildDecision(topology, risks, nodePlans.length);

  return {
    id: createId("openclaw_provisioning"),
    createdAt: now.toISOString(),
    phase: "4.3-provisioning-dry-run-executor",
    actorId,
    sourceTopologyId: topology.id,
    dryRun: true,
    sideEffects: "none",
    topology: {
      decisionStatus: topology.decision.status,
      clusterName: topology.summary.clusterName,
      plannedSenderNodes: topology.summary.plannedSenderNodes,
      estimatedInitialDailyCapacity: topology.summary.estimatedInitialDailyCapacity
    },
    decision,
    summary: {
      nodesPlanned: nodePlans.length,
      proxmoxPlans: nodePlans.length,
      postfixPlans: nodePlans.length,
      openDkimPlans: nodePlans.length,
      tlsPlans: nodePlans.length,
      dnsRecordsPlanned: nodePlans.reduce((total, node) => total + node.dns.records.length, 0),
      warmingPlans: nodePlans.length
    },
    nodePlans,
    risks,
    gates: [
      "topology_plan_must_not_be_blocked",
      "provisioning_dry_run_before_any_live_action",
      "operator_approval_required_for_live_infrastructure",
      "secret_management_required_before_ssh_or_dkim",
      "dns_review_required_before_live_changes",
      "smtp_disabled_until_reputation_gate_passes",
      "warming_required_before_volume_increase"
    ],
    requiredApprovals,
    blockedActions,
    safety: {
      liveInfrastructureWritesEnabled: false,
      proxmoxApiEnabled: false,
      sshEnabled: false,
      postfixLiveApplyEnabled: false,
      openDkimLiveKeyGenerationEnabled: false,
      tlsLiveCertificateRequestEnabled: false,
      dnsLiveChangesEnabled: false,
      smtpEnabled: false,
      nfcWritesEnabled: false
    }
  };
}

function resolveTopologyPlan(
  input: OpenClawProvisioningDryRunInput,
  now: Date
): OpenClawTopologyPlan {
  if (input.topologyPlan) {
    return input.topologyPlan;
  }

  if (input.topologyInput) {
    return buildOpenClawTopologyPlan({
      ...input.topologyInput,
      actorId: input.actorId ?? input.topologyInput.actorId
    }, now);
  }

  throw new Error("Provisioning dry-run requires topologyPlan or topologyInput.");
}

function buildNodeDryRun(
  topology: OpenClawTopologyPlan,
  node: OpenClawTopologyPlan["clusters"][number]["nodes"][number],
  now: Date
): OpenClawProvisioningNodeDryRun {
  const proxmox = buildSenderNodeProvisioningPlan({
    id: node.id,
    label: node.label,
    provider: "proxmox",
    hostname: node.network.hostname,
    dailyLimit: node.limits.dailyLimit,
    warmupDay: node.limits.warmupDay,
    computeType: node.compute.type,
    cpuCores: node.compute.cpuCores,
    memoryMb: node.compute.memoryMb,
    diskGb: node.compute.diskGb,
    template: node.compute.template,
    networkBridge: node.compute.networkBridge
  }, now);

  return {
    senderNodeId: node.id,
    provisioningOrder: node.provisioningOrder,
    dryRun: true,
    sideEffects: "none",
    proxmox,
    postfix: buildPostfixPlan(node),
    openDkim: buildOpenDkimPlan(node),
    tls: buildTlsPlan(node),
    dns: buildDnsPlan(topology, node),
    warming: buildWarmingPlan(node),
    blockedActions,
    requiredApprovals
  };
}

function buildPostfixPlan(
  node: OpenClawTopologyPlan["clusters"][number]["nodes"][number]
): OpenClawPostfixPlan {
  return {
    hostname: node.network.hostname,
    domain: node.network.domain,
    configProfile: "sender-node-baseline",
    queueMode: "local-only-until-approved",
    smtpDeliveryEnabled: false,
    plannedMainCf: {
      myhostname: node.network.hostname,
      mydomain: node.network.domain,
      inet_interfaces: "loopback-only-until-approved",
      smtp_tls_security_level: "may",
      smtpd_tls_security_level: "may",
      milter_default_action: "accept",
      non_smtpd_milters: "inet:localhost:8891",
      smtpd_milters: "inet:localhost:8891"
    },
    blockedOperations: [
      "postfix-main-cf-write-live",
      "postfix-reload",
      "smtp-send"
    ]
  };
}

function buildOpenDkimPlan(
  node: OpenClawTopologyPlan["clusters"][number]["nodes"][number]
): OpenClawOpenDkimPlan {
  const selector = `s${String(node.provisioningOrder).padStart(3, "0")}`;

  return {
    domain: node.network.domain,
    selector,
    keyGenerationMode: "dry_run_only",
    keyStorage: "secrets_manager_required",
    signingTablePreview: `${selector}._domainkey.${node.network.domain} ${node.network.domain}:${selector}`,
    blockedOperations: [
      "opendkim-keygen-live",
      "write-private-key-to-disk",
      "postfix-milter-activate-live"
    ]
  };
}

function buildTlsPlan(
  node: OpenClawTopologyPlan["clusters"][number]["nodes"][number]
): OpenClawTlsPlan {
  return {
    hostname: node.network.hostname,
    certificateMode: "planned_only",
    commonName: node.network.hostname,
    subjectAlternativeNames: [node.network.hostname],
    privateKeyStorage: "secrets_manager_required",
    blockedOperations: [
      "acme-request-live",
      "tls-private-key-write-live",
      "postfix-tls-activate-live"
    ]
  };
}

function buildDnsPlan(
  topology: OpenClawTopologyPlan,
  node: OpenClawTopologyPlan["clusters"][number]["nodes"][number]
): OpenClawDnsPlan {
  const placeholderIp = `reserved-ip-${node.network.ipAssignment.ordinal}`;
  const ipValue = node.network.ipAssignment.mode === "reserved_from_pool"
    ? `${node.network.ipAssignment.pool}:${node.network.ipAssignment.ordinal}`
    : placeholderIp;
  const selector = `s${String(node.provisioningOrder).padStart(3, "0")}`;

  return {
    providerMode: "planned_only",
    domain: node.network.domain,
    records: [
      {
        type: "A",
        name: node.network.hostname,
        value: ipValue,
        ttl: 300,
        purpose: "Map sender hostname to reserved sender IP.",
        liveChange: false
      },
      {
        type: "MX",
        name: node.network.domain,
        value: `10 ${node.network.hostname}`,
        ttl: 300,
        purpose: "Prepare inbound bounce path only after approval.",
        liveChange: false
      },
      {
        type: "TXT",
        name: node.network.domain,
        value: "v=spf1 ip4:reserved-sender-ip -all",
        ttl: 300,
        purpose: "Prepare SPF placeholder for sender IP review.",
        liveChange: false
      },
      {
        type: "TXT",
        name: `${selector}._domainkey.${node.network.domain}`,
        value: "v=DKIM1; k=ed25519; p=pending-secret-managed-public-key",
        ttl: 300,
        purpose: "Prepare DKIM record placeholder without generating live keys.",
        liveChange: false
      },
      {
        type: "TXT",
        name: `_dmarc.${node.network.domain}`,
        value: "v=DMARC1; p=none; rua=mailto:dmarc-aggregate@delivrix.example",
        ttl: 300,
        purpose: "Prepare conservative DMARC monitoring policy.",
        liveChange: false
      },
      {
        type: "PTR",
        name: ipValue,
        value: node.network.hostname,
        ttl: 300,
        purpose: `Prepare PTR mapping for ${topology.summary.clusterName}.`,
        liveChange: false
      }
    ],
    blockedOperations: [
      "dns-provider-api-write",
      "ptr-live-change",
      "dkim-record-publish-live",
      "spf-record-publish-live",
      "dmarc-record-publish-live"
    ]
  };
}

function buildWarmingPlan(
  node: OpenClawTopologyPlan["clusters"][number]["nodes"][number]
): OpenClawWarmingPlan {
  const warmupDays = Math.max(1, node.limits.warmupDays);
  const checkpoints = [1, Math.ceil(warmupDays / 2), warmupDays]
    .filter((day, index, all) => all.indexOf(day) === index)
    .map((day) => ({
      day,
      maxDailyLimit: Math.max(1, Math.floor((node.limits.dailyLimit * day) / warmupDays)),
      gate: "reputation_bounce_complaint_blacklist_review"
    }));

  return {
    dayStart: 0,
    warmupDays,
    initialDailyLimit: node.limits.dailyLimit,
    emailsPerMinute: node.limits.emailsPerMinute,
    checkpoints,
    blockedOperations: [
      "increase-volume-without-reputation-gate",
      "rotate-ip-to-sustain-volume",
      "smtp-send-live"
    ]
  };
}

function buildRisks(topology: OpenClawTopologyPlan): OpenClawProvisioningRisk[] {
  const risks: OpenClawProvisioningRisk[] = topology.risks.map((risk) => ({
    ...risk
  }));

  if (topology.decision.status === "blocked") {
    risks.push(risk(
      "topology_blocked",
      "critical",
      "The topology plan is blocked.",
      "Return to onboarding or topology planning before provisioning dry-run."
    ));
  }

  if (topology.decision.status === "needs_review") {
    risks.push(risk(
      "topology_needs_review",
      topology.decision.riskLevel,
      "The topology plan requires review before provisioning dry-run.",
      "Review topology risks and approvals before moving forward."
    ));
  }

  if (topology.summary.plannedSenderNodes > 0 && topology.summary.domainsCount === 1) {
    risks.push(risk(
      "single_domain_topology",
      "medium",
      "All sender nodes currently depend on one verified domain.",
      "Use subdomain isolation and watch reputation carefully."
    ));
  }

  return risks;
}

function buildDecision(
  topology: OpenClawTopologyPlan,
  risks: OpenClawProvisioningRisk[],
  nodePlansCount: number
): OpenClawProvisioningDecision {
  const highestRisk = highestRiskLevel(risks);

  if (topology.decision.status === "blocked" || nodePlansCount === 0) {
    return {
      status: "blocked",
      canApplyLiveInfrastructure: false,
      nextRecommendedMilestone: "continue_onboarding",
      riskLevel: highestRisk,
      reason: "Provisioning dry-run is blocked until topology planning passes."
    };
  }

  if (topology.decision.status === "needs_review" || highestRisk === "critical" || highestRisk === "high") {
    return {
      status: "needs_review",
      canApplyLiveInfrastructure: false,
      nextRecommendedMilestone: "review_topology_plan",
      riskLevel: highestRisk,
      reason: "Provisioning dry-run was generated, but review is required before using it for the next milestone."
    };
  }

  return {
    status: "dry_run_ready",
    canApplyLiveInfrastructure: false,
    nextRecommendedMilestone: "4.4_openclaw_scheduler_and_skills",
    riskLevel: highestRisk,
    reason: "Provisioning dry-run is ready for review. Live infrastructure remains disabled."
  };
}

function risk(
  code: string,
  severity: OpenClawProvisioningRiskSeverity,
  message: string,
  recommendation: string
): OpenClawProvisioningRisk {
  return {
    code,
    severity,
    message,
    recommendation
  };
}

function highestRiskLevel(risks: OpenClawProvisioningRisk[]): OpenClawProvisioningRiskSeverity {
  if (risks.some((item) => item.severity === "critical")) {
    return "critical";
  }

  if (risks.some((item) => item.severity === "high")) {
    return "high";
  }

  if (risks.some((item) => item.severity === "medium")) {
    return "medium";
  }

  return "low";
}

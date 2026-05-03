import { createId } from "./ids.ts";
import {
  evaluateOpenClawOnboarding,
  type OpenClawOnboardingInput,
  type OpenClawOnboardingRiskLevel,
  type OpenClawOnboardingSnapshot
} from "./openclaw-onboarding.ts";
import type { ProxmoxComputeType } from "./sender-node-provisioning.ts";

export type OpenClawTopologyStrategy = "conservative" | "balanced";
export type OpenClawTopologyDecisionStatus = "plan_ready" | "needs_review" | "blocked";
export type OpenClawTopologyRiskSeverity = "low" | "medium" | "high" | "critical";

export interface OpenClawTopologyPlannerInput {
  actorId?: string;
  clusterName?: string;
  strategy?: OpenClawTopologyStrategy;
  onboarding: OpenClawOnboardingInput;
}

export interface OpenClawTopologyRisk {
  code: string;
  severity: OpenClawTopologyRiskSeverity;
  message: string;
  recommendation: string;
}

export interface OpenClawTopologyNodePlan {
  id: string;
  label: string;
  provisioningOrder: number;
  compute: {
    type: ProxmoxComputeType;
    cpuCores: number;
    memoryMb: number;
    diskGb: number;
    template: string;
    networkBridge: string;
  };
  network: {
    hostname: string;
    domain: string;
    ipAssignment: {
      mode: "reserved_from_pool" | "pending_pool";
      pool?: string;
      ordinal: number;
    };
  };
  limits: {
    dailyLimit: number;
    emailsPerMinute: number;
    warmupDay: 0;
    warmupDays: number;
  };
  risks: string[];
}

export interface OpenClawTopologyClusterPlan {
  id: string;
  name: string;
  provider: "proxmox";
  computeType: ProxmoxComputeType;
  nodes: OpenClawTopologyNodePlan[];
  summary: {
    plannedSenderNodes: number;
    estimatedInitialDailyCapacity: number;
    warmupDays: number;
  };
}

export interface OpenClawTopologyResourceBudget {
  serverCpuCores: number;
  serverRamGb: number;
  serverStorageGb: number;
  reservedCpuCores: number;
  reservedRamGb: number;
  reservedStorageGb: number;
  nodeCpuCores: number;
  nodeMemoryMb: number;
  nodeDiskGb: number;
  maxNodesByCpu: number;
  maxNodesByRam: number;
  maxNodesByStorage: number;
  maxNodesByIpPool: number;
  safeMaxSenderNodes: number;
}

export interface OpenClawTopologyDecision {
  status: OpenClawTopologyDecisionStatus;
  canRunProvisioningDryRun: boolean;
  nextRecommendedMilestone: "continue_onboarding" | "review_topology_plan" | "4.3_provisioning_dry_run_executor";
  riskLevel: OpenClawTopologyRiskSeverity;
  reason: string;
}

export interface OpenClawTopologyPlan {
  id: string;
  createdAt: string;
  phase: "4.2-cluster-topology-planner";
  actorId: string;
  sourceOnboardingId: string;
  dryRun: true;
  sideEffects: "none";
  strategy: OpenClawTopologyStrategy;
  onboarding: {
    decisionStatus: OpenClawOnboardingSnapshot["decision"]["status"];
    readiness: OpenClawOnboardingSnapshot["readiness"];
    blockers: string[];
    warnings: string[];
  };
  decision: OpenClawTopologyDecision;
  summary: {
    clusterName: string;
    requestedSenderNodes: number;
    plannedSenderNodes: number;
    totalIpsAvailable: number;
    domainsCount: number;
    estimatedInitialDailyCapacity: number;
    targetDailyVolume: number;
    warmupDays: number;
  };
  resourceBudget: OpenClawTopologyResourceBudget;
  clusters: OpenClawTopologyClusterPlan[];
  risks: OpenClawTopologyRisk[];
  gates: string[];
  requiredApprovals: string[];
  blockedActions: string[];
  safety: {
    liveInfrastructureWritesEnabled: false;
    proxmoxApiEnabled: false;
    sshEnabled: false;
    smtpEnabled: false;
    dnsLiveChangesEnabled: false;
    nfcWritesEnabled: false;
  };
}

const requiredApprovals = [
  "operator_approval_before_provisioning_dry_run",
  "resource_budget_review",
  "ip_and_ptr_review",
  "dns_plan_review",
  "warming_plan_review"
];

const blockedActions = [
  "proxmox-live-create",
  "ssh-connect",
  "dns-live-change",
  "postfix-apply-live",
  "smtp-send",
  "increase-volume",
  "nfc-production-write"
];

export function buildOpenClawTopologyPlan(
  input: OpenClawTopologyPlannerInput,
  now = new Date()
): OpenClawTopologyPlan {
  const actorId = input.actorId?.trim() || input.onboarding.actorId?.trim() || "operator_local";
  const strategy = input.strategy ?? "conservative";
  const onboarding = evaluateOpenClawOnboarding({
    ...input.onboarding,
    actorId
  }, now);
  const clusterName = input.clusterName?.trim() || "delivrix-primary-mailops";
  const budget = buildResourceBudget(input.onboarding, strategy);
  const risks = buildRisks(input.onboarding, onboarding, budget);
  const requestedSenderNodes = normalizePositiveInteger(input.onboarding.limits?.initialSenderNodes);
  const plannedSenderNodes = onboarding.decision.status === "no_go"
    ? 0
    : Math.min(requestedSenderNodes, budget.safeMaxSenderNodes);
  const nodes = plannedSenderNodes > 0
    ? buildNodePlans(input.onboarding, plannedSenderNodes, strategy, risks)
    : [];
  const estimatedInitialDailyCapacity = nodes.reduce((total, node) => total + node.limits.dailyLimit, 0);
  const decision = buildDecision(onboarding, risks, plannedSenderNodes, requestedSenderNodes);

  return {
    id: createId("openclaw_topology"),
    createdAt: now.toISOString(),
    phase: "4.2-cluster-topology-planner",
    actorId,
    sourceOnboardingId: onboarding.id,
    dryRun: true,
    sideEffects: "none",
    strategy,
    onboarding: {
      decisionStatus: onboarding.decision.status,
      readiness: onboarding.readiness,
      blockers: onboarding.blockers,
      warnings: onboarding.warnings
    },
    decision,
    summary: {
      clusterName,
      requestedSenderNodes,
      plannedSenderNodes,
      totalIpsAvailable: normalizePositiveInteger(input.onboarding.ipPool?.totalIps),
      domainsCount: verifiedDomains(input.onboarding).length,
      estimatedInitialDailyCapacity,
      targetDailyVolume: normalizePositiveInteger(input.onboarding.limits?.targetDailyVolume),
      warmupDays: normalizePositiveInteger(input.onboarding.limits?.warmupDays)
    },
    resourceBudget: budget,
    clusters: nodes.length > 0
      ? [{
        id: createId("cluster"),
        name: clusterName,
        provider: "proxmox",
        computeType: "lxc",
        nodes,
        summary: {
          plannedSenderNodes: nodes.length,
          estimatedInitialDailyCapacity,
          warmupDays: normalizePositiveInteger(input.onboarding.limits?.warmupDays)
        }
      }]
      : [],
    risks,
    gates: [
      "topology_plan_requires_onboarding_go_or_review",
      "capacity_is_estimate_not_volume_promise",
      "warming_required_before_volume_increase",
      "dns_and_ptr_review_before_provisioning",
      "no_live_infrastructure_write",
      "no_smtp_activation",
      "no_external_bridge_dependency"
    ],
    requiredApprovals,
    blockedActions,
    safety: {
      liveInfrastructureWritesEnabled: false,
      proxmoxApiEnabled: false,
      sshEnabled: false,
      smtpEnabled: false,
      dnsLiveChangesEnabled: false,
      nfcWritesEnabled: false
    }
  };
}

function buildResourceBudget(
  onboarding: OpenClawOnboardingInput,
  strategy: OpenClawTopologyStrategy
): OpenClawTopologyResourceBudget {
  const serverCpuCores = normalizePositiveInteger(onboarding.server?.cpuCores);
  const serverRamGb = normalizePositiveInteger(onboarding.server?.ramGb);
  const serverStorageGb = normalizePositiveInteger(onboarding.server?.storage?.usableGb);
  const reservedCpuCores = Math.max(2, Math.ceil(serverCpuCores * 0.15));
  const reservedRamGb = Math.max(8, Math.ceil(serverRamGb * 0.15));
  const reservedStorageGb = Math.max(80, Math.ceil(serverStorageGb * 0.15));
  const nodeCpuCores = strategy === "balanced" ? 2 : 1;
  const nodeMemoryMb = strategy === "balanced" ? 2048 : 1024;
  const nodeDiskGb = strategy === "balanced" ? 32 : 24;
  const availableCpu = Math.max(0, serverCpuCores - reservedCpuCores);
  const availableRamMb = Math.max(0, (serverRamGb - reservedRamGb) * 1024);
  const availableStorageGb = Math.max(0, serverStorageGb - reservedStorageGb);
  const maxNodesByCpu = Math.floor(availableCpu / nodeCpuCores);
  const maxNodesByRam = Math.floor(availableRamMb / nodeMemoryMb);
  const maxNodesByStorage = Math.floor(availableStorageGb / nodeDiskGb);
  const maxNodesByIpPool = normalizePositiveInteger(onboarding.ipPool?.totalIps);
  const safeMaxSenderNodes = Math.max(0, Math.min(
    maxNodesByCpu,
    maxNodesByRam,
    maxNodesByStorage,
    maxNodesByIpPool
  ));

  return {
    serverCpuCores,
    serverRamGb,
    serverStorageGb,
    reservedCpuCores,
    reservedRamGb,
    reservedStorageGb,
    nodeCpuCores,
    nodeMemoryMb,
    nodeDiskGb,
    maxNodesByCpu,
    maxNodesByRam,
    maxNodesByStorage,
    maxNodesByIpPool,
    safeMaxSenderNodes
  };
}

function buildNodePlans(
  onboarding: OpenClawOnboardingInput,
  plannedSenderNodes: number,
  strategy: OpenClawTopologyStrategy,
  planRisks: OpenClawTopologyRisk[]
): OpenClawTopologyNodePlan[] {
  const domains = verifiedDomains(onboarding);
  const cidrs = onboarding.ipPool?.cidrs?.filter((cidr) => cidr.trim()).map((cidr) => cidr.trim()) ?? [];
  const dailyLimit = normalizePositiveInteger(onboarding.limits?.dailyLimitPerNode);
  const warmupDays = normalizePositiveInteger(onboarding.limits?.warmupDays);
  const nodeCpuCores = strategy === "balanced" ? 2 : 1;
  const nodeMemoryMb = strategy === "balanced" ? 2048 : 1024;
  const nodeDiskGb = strategy === "balanced" ? 32 : 24;
  const nodeRisks = planRisks
    .filter((risk) => risk.severity === "medium" || risk.severity === "high" || risk.severity === "critical")
    .map((risk) => risk.code);

  return Array.from({ length: plannedSenderNodes }, (_, index) => {
    const ordinal = index + 1;
    const domain = domains[index % domains.length] ?? "pending-domain.local";
    const pool = cidrs[index % cidrs.length];

    return {
      id: `sender_proxmox_${String(ordinal).padStart(3, "0")}`,
      label: `Proxmox Sender ${String(ordinal).padStart(3, "0")}`,
      provisioningOrder: ordinal,
      compute: {
        type: "lxc",
        cpuCores: nodeCpuCores,
        memoryMb: nodeMemoryMb,
        diskGb: nodeDiskGb,
        template: "debian-12-mailops-base",
        networkBridge: "vmbr0"
      },
      network: {
        hostname: `mx${String(ordinal).padStart(3, "0")}.${domain}`,
        domain,
        ipAssignment: pool
          ? {
            mode: "reserved_from_pool",
            pool,
            ordinal
          }
          : {
            mode: "pending_pool",
            ordinal
          }
      },
      limits: {
        dailyLimit,
        emailsPerMinute: Math.max(1, Math.floor(dailyLimit / 480)),
        warmupDay: 0,
        warmupDays
      },
      risks: nodeRisks
    };
  });
}

function buildRisks(
  onboarding: OpenClawOnboardingInput,
  snapshot: OpenClawOnboardingSnapshot,
  budget: OpenClawTopologyResourceBudget
): OpenClawTopologyRisk[] {
  const risks: OpenClawTopologyRisk[] = [];
  const requestedSenderNodes = normalizePositiveInteger(onboarding.limits?.initialSenderNodes);
  const targetDailyVolume = normalizePositiveInteger(onboarding.limits?.targetDailyVolume);
  const dailyLimitPerNode = normalizePositiveInteger(onboarding.limits?.dailyLimitPerNode);
  const estimatedInitialDailyCapacity = Math.min(requestedSenderNodes, budget.safeMaxSenderNodes) * dailyLimitPerNode;

  if (snapshot.decision.status === "no_go") {
    risks.push(risk(
      "onboarding_no_go",
      "critical",
      "The onboarding gate is no_go.",
      "Complete critical onboarding fields before topology planning."
    ));
  }

  if (snapshot.decision.status === "needs_review") {
    risks.push(risk(
      "onboarding_needs_review",
      onboardingRiskToTopologyRisk(snapshot.decision.riskLevel),
      "The onboarding gate requires operator review.",
      "Review onboarding warnings before accepting the topology plan."
    ));
  }

  if (requestedSenderNodes > budget.safeMaxSenderNodes) {
    risks.push(risk(
      "requested_nodes_exceed_safe_budget",
      budget.safeMaxSenderNodes === 0 ? "critical" : "high",
      "Requested sender nodes exceed the safe local resource budget.",
      "Reduce initial sender nodes or increase CPU, RAM, storage, or IP pool."
    ));
  }

  if (targetDailyVolume > estimatedInitialDailyCapacity && estimatedInitialDailyCapacity > 0) {
    risks.push(risk(
      "target_volume_above_initial_capacity",
      "medium",
      "Target daily volume is higher than the first topology capacity estimate.",
      "Treat the first topology as warmup capacity only; scale later by gates."
    ));
  }

  if (verifiedDomains(onboarding).length < Math.min(requestedSenderNodes, budget.safeMaxSenderNodes)) {
    risks.push(risk(
      "domain_reuse_required",
      "medium",
      "There are fewer verified domains than planned sender nodes.",
      "Use controlled subdomain allocation and review reputation isolation."
    ));
  }

  if (snapshot.warnings.includes("ip_reputation_not_checked")) {
    risks.push(risk(
      "ip_reputation_not_checked",
      "high",
      "IP reputation has not been checked yet.",
      "Run reputation checks before provisioning sender nodes."
    ));
  }

  if (snapshot.warnings.includes("proxmox_planned_not_installed")) {
    risks.push(risk(
      "proxmox_not_installed",
      "medium",
      "Proxmox is planned but not installed.",
      "Keep topology as design-only until Proxmox is available."
    ));
  }

  if (snapshot.warnings.includes("warmup_window_short")) {
    risks.push(risk(
      "warmup_window_short",
      "medium",
      "Warmup window is shorter than the conservative recommendation.",
      "Use at least 14 days of gradual warmup for new IPs."
    ));
  }

  return risks;
}

function buildDecision(
  onboarding: OpenClawOnboardingSnapshot,
  risks: OpenClawTopologyRisk[],
  plannedSenderNodes: number,
  requestedSenderNodes: number
): OpenClawTopologyDecision {
  const highestRisk = highestRiskLevel(risks);

  if (onboarding.decision.status === "no_go" || plannedSenderNodes <= 0) {
    return {
      status: "blocked",
      canRunProvisioningDryRun: false,
      nextRecommendedMilestone: "continue_onboarding",
      riskLevel: highestRisk,
      reason: "Topology planning is blocked until critical onboarding and resource gates pass."
    };
  }

  if (highestRisk === "critical" || highestRisk === "high" || plannedSenderNodes < requestedSenderNodes || onboarding.decision.status === "needs_review") {
    return {
      status: "needs_review",
      canRunProvisioningDryRun: false,
      nextRecommendedMilestone: "review_topology_plan",
      riskLevel: highestRisk,
      reason: "A topology plan was generated, but human review is required before provisioning dry-run."
    };
  }

  return {
    status: "plan_ready",
    canRunProvisioningDryRun: true,
    nextRecommendedMilestone: "4.3_provisioning_dry_run_executor",
    riskLevel: highestRisk,
    reason: "Topology plan is ready for provisioning dry-run."
  };
}

function risk(
  code: string,
  severity: OpenClawTopologyRiskSeverity,
  message: string,
  recommendation: string
): OpenClawTopologyRisk {
  return {
    code,
    severity,
    message,
    recommendation
  };
}

function verifiedDomains(onboarding: OpenClawOnboardingInput): string[] {
  return (onboarding.domains ?? [])
    .filter((domain) => Boolean(domain.domain?.trim()) && domain.ownershipVerified === true)
    .map((domain) => domain.domain?.trim() ?? "");
}

function normalizePositiveInteger(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.floor(value);
}

function onboardingRiskToTopologyRisk(riskLevel: OpenClawOnboardingRiskLevel): OpenClawTopologyRiskSeverity {
  return riskLevel;
}

function highestRiskLevel(risks: OpenClawTopologyRisk[]): OpenClawTopologyRiskSeverity {
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

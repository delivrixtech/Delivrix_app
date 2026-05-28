import {
  buildContractBase,
  type ControlPlaneContractBase,
  type ControlPlaneReadinessStatus,
  mockSource,
  qualityFromUnknownFields
} from "./control-plane-contract.ts";
import type { OpenClawOnboardingQuestion, OpenClawOnboardingSnapshot } from "./openclaw-onboarding.ts";
import type { OpenClawProvisioningDryRunPlan } from "./openclaw-provisioning-dry-run.ts";

export interface OpenClawOnboardingSectionState {
  id: string;
  displayName: string;
  detectedFieldCount: number;
  totalFieldCount: number;
  source: "onboarding.snapshot" | "fallback.mock";
}

export interface OpenClawOnboardingState extends ControlPlaneContractBase {
  environment: "mvp.local";
  releasePhase: "5.9-manual-snapshot-ingestion-ux";
  readinessByCategory: Record<string, number>;
  sections: OpenClawOnboardingSectionState[];
  pendingQuestions: OpenClawOnboardingQuestion[];
  knownInputs: Record<string, unknown>;
  blockers: string[];
  warnings: string[];
  nextRecommendedQuestion: OpenClawOnboardingQuestion | null;
  canGenerateTopologyPlan: boolean;
}

export interface OpenClawProvisioningState extends ControlPlaneContractBase {
  topologySource: {
    id: string | null;
    decisionStatus: string;
  };
  steps: Array<{
    id: string;
    label: string;
    status: ControlPlaneReadinessStatus | "not_started" | "disabled_by_mvp";
    requiresHumanApproval: boolean;
    evidenceRefs: string[];
  }>;
  requiredApprovals: string[];
  blockedActions: string[];
  dryRunArtifacts: string[];
}

export interface BuildOpenClawOnboardingStateInput {
  snapshot?: OpenClawOnboardingSnapshot;
  now?: Date;
}

export interface BuildOpenClawProvisioningStateInput {
  plan?: OpenClawProvisioningDryRunPlan;
  now?: Date;
}

export function buildOpenClawOnboardingState(
  input: BuildOpenClawOnboardingStateInput = {}
): OpenClawOnboardingState {
  const snapshot = input.snapshot;
  const pendingQuestions = snapshot?.recommendedNextQuestions ?? [];
  const unknownFields = snapshot ? [] : ["onboarding.snapshot"];

  return {
    ...buildContractBase(input.now, mockSource(), qualityFromUnknownFields(unknownFields, snapshot ? 0.7 : 0)),
    environment: "mvp.local",
    releasePhase: "5.9-manual-snapshot-ingestion-ux",
    readinessByCategory: snapshot?.readiness
      ? {
        infrastructure: snapshot.readiness.infrastructure,
        network: snapshot.readiness.network,
        dns: snapshot.readiness.dns,
        compliance: snapshot.readiness.compliance,
        security: snapshot.readiness.security,
        autonomy: snapshot.readiness.autonomy,
        total: snapshot.readiness.total
      }
      : {},
    sections: buildOnboardingSections(snapshot, pendingQuestions),
    pendingQuestions,
    knownInputs: snapshot?.inputSummary ?? {},
    blockers: snapshot?.blockers ?? ["onboarding_snapshot_unavailable"],
    warnings: snapshot?.warnings ?? [],
    nextRecommendedQuestion: pendingQuestions[0] ?? null,
    canGenerateTopologyPlan: snapshot?.decision.canGenerateTopologyPlan ?? false
  };
}

export function buildOpenClawProvisioningState(
  input: BuildOpenClawProvisioningStateInput = {}
): OpenClawProvisioningState {
  const plan = input.plan;
  const unknownFields = plan ? [] : ["provisioning.plan"];

  return {
    ...buildContractBase(input.now, mockSource(), qualityFromUnknownFields(unknownFields, plan ? 0.7 : 0)),
    topologySource: {
      id: plan?.sourceTopologyId ?? null,
      decisionStatus: plan?.topology.decisionStatus ?? "unknown"
    },
    steps: plan
      ? plan.nodePlans.flatMap((nodePlan) =>
        nodePlan.proxmox.steps.map((step) => ({
          id: `${nodePlan.senderNodeId}.${step.name}`,
          label: step.label,
          status: step.status === "completed" ? "ready" : step.status === "blocked" ? "blocked" : "needs_review",
          requiresHumanApproval: step.requiresHumanApproval,
          evidenceRefs: [nodePlan.senderNodeId, nodePlan.proxmox.id]
        }))
      )
      : defaultProvisioningSteps(),
    requiredApprovals: plan?.requiredApprovals ?? [
      "operator_approval_before_any_live_apply",
      "provisioning_dry_run_required"
    ],
    blockedActions: plan?.blockedActions ?? [
      "proxmox-live-create",
      "ssh-connect",
      "dns-live-change",
      "smtp-send"
    ],
    dryRunArtifacts: plan ? [plan.id, plan.sourceTopologyId] : []
  };
}

function defaultProvisioningSteps(): OpenClawProvisioningState["steps"] {
  return [
    "Proxmox compute",
    "IP assignment",
    "Postfix",
    "OpenDKIM",
    "TLS",
    "DNS",
    "Warming"
  ].map((label, index) => ({
    id: `planned_step_${index + 1}`,
    label,
    status: "not_started",
    requiresHumanApproval: index !== 6,
    evidenceRefs: []
  }));
}

function buildOnboardingSections(
  snapshot: OpenClawOnboardingSnapshot | undefined,
  pendingQuestions: OpenClawOnboardingQuestion[]
): OpenClawOnboardingSectionState[] {
  const pending = new Set(pendingQuestions.map((question) => question.id));
  return onboardingSections.map((section) => {
    const totalFieldCount = section.questionIds.length;
    const missingFieldCount = snapshot
      ? section.questionIds.filter((questionId) => pending.has(questionId)).length
      : totalFieldCount;
    return {
      id: section.id,
      displayName: section.displayName,
      detectedFieldCount: totalFieldCount - missingFieldCount,
      totalFieldCount,
      source: snapshot ? "onboarding.snapshot" : "fallback.mock"
    };
  });
}

const onboardingSections = [
  {
    id: "server",
    displayName: "Servidor",
    questionIds: [
      "server.model",
      "server.cpu_cores",
      "server.ram_gb",
      "server.storage_usable_gb",
      "proxmox.status"
    ]
  },
  {
    id: "network",
    displayName: "IPs y dominios",
    questionIds: [
      "server.network_uplink",
      "ip_pool.total_ips",
      "ip_pool.type",
      "ip_pool.provider_approval",
      "ip_pool.ptr_delegation",
      "domains.verified"
    ]
  },
  {
    id: "dns",
    displayName: "DNS",
    questionIds: [
      "dns.provider"
    ]
  },
  {
    id: "limits",
    displayName: "Límites",
    questionIds: [
      "limits.target_daily_volume",
      "limits.initial_sender_nodes",
      "limits.daily_per_node",
      "limits.warmup_days"
    ]
  },
  {
    id: "compliance",
    displayName: "Cumplimiento",
    questionIds: [
      "compliance.physical_address",
      "compliance.opt_out",
      "compliance.suppression_list",
      "compliance.consent_proof",
      "compliance.provider_authorization"
    ]
  },
  {
    id: "review",
    displayName: "Revisión",
    questionIds: [
      "security.secrets_manager",
      "security.audit_log",
      "security.kill_switch",
      "autonomy.mode",
      "autonomy.human_approval"
    ]
  }
] as const;

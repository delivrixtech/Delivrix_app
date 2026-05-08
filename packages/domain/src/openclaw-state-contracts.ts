import {
  buildContractBase,
  type ControlPlaneContractBase,
  type ControlPlaneReadinessStatus,
  mockSource,
  qualityFromUnknownFields
} from "./control-plane-contract.ts";
import type { OpenClawOnboardingQuestion, OpenClawOnboardingSnapshot } from "./openclaw-onboarding.ts";
import type { OpenClawProvisioningDryRunPlan } from "./openclaw-provisioning-dry-run.ts";

export interface OpenClawOnboardingState extends ControlPlaneContractBase {
  readinessByCategory: Record<string, number>;
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

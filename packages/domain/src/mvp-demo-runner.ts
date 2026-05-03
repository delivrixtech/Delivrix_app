import { createId } from "./ids.ts";
import type { DelivrixMvpDemoBlueprint, MvpDemoComponentStep } from "./mvp-demo-blueprint.ts";
import type { OperationalSummary } from "./operational-summary.ts";
import type { SenderNodeHealthDecision } from "./sender-node-health.ts";
import type { SendJob, SendResult, SenderNode } from "./types.ts";

export type MvpDemoRunDecisionStatus = "completed" | "needs_review" | "blocked";

export interface DelivrixMvpDemoRunInput {
  id?: string;
  actorId?: string;
  blueprint: DelivrixMvpDemoBlueprint;
  senderNode?: SenderNode;
  job?: SendJob;
  result?: SendResult;
  healthDecisions?: SenderNodeHealthDecision[];
  operationalSummary?: OperationalSummary;
  auditEventIds?: string[];
  blockedReason?: string;
}

export interface MvpDemoRunArtifactLinks {
  blueprintId: string;
  senderNodeId: string | null;
  sendJobId: string | null;
  sendResultId: string | null;
  auditEventIds: string[];
}

export interface MvpDemoRunDecision {
  status: MvpDemoRunDecisionStatus;
  canPresentToSponsor: boolean;
  canSendRealEmail: false;
  canMutateLiveInfrastructure: false;
  reason: string;
  blockers: string[];
  warnings: string[];
  nextRecommendedMilestone: "5.2_openclaw_incident_demo" | "review_demo_run" | "remain_in_5.1";
}

export interface DelivrixMvpDemoRunReport {
  id: string;
  createdAt: string;
  phase: "5.1-demo-runner-local-state";
  actorId: string;
  dryRun: true;
  sideEffects: "local-state-only";
  blueprintId: string;
  route: DelivrixMvpDemoBlueprint["pipeline"]["route"];
  artifacts: MvpDemoRunArtifactLinks;
  steps: MvpDemoComponentStep[];
  senderNode: SenderNode | null;
  job: SendJob | null;
  result: SendResult | null;
  healthDecisions: SenderNodeHealthDecision[];
  operationalSummary: OperationalSummary | null;
  decision: MvpDemoRunDecision;
  gates: string[];
  safety: {
    liveEmailSendingEnabled: false;
    liveInfrastructureWritesEnabled: false;
    liveDnsChangesEnabled: false;
    sshEnabled: false;
    nfcProductionWritesEnabled: false;
    localStateOnly: true;
    auditLinkedByDemoRunId: true;
  };
}

export function buildDelivrixMvpDemoRunReport(
  input: DelivrixMvpDemoRunInput,
  now = new Date()
): DelivrixMvpDemoRunReport {
  const decision = buildDecision(input);

  return {
    id: input.id ?? createId("demo_run"),
    createdAt: now.toISOString(),
    phase: "5.1-demo-runner-local-state",
    actorId: input.actorId?.trim() || input.blueprint.actorId,
    dryRun: true,
    sideEffects: "local-state-only",
    blueprintId: input.blueprint.id,
    route: input.blueprint.pipeline.route,
    artifacts: {
      blueprintId: input.blueprint.id,
      senderNodeId: input.senderNode?.id ?? null,
      sendJobId: input.job?.id ?? null,
      sendResultId: input.result?.id ?? null,
      auditEventIds: input.auditEventIds ?? []
    },
    steps: markSteps(input.blueprint.demoScript, decision.status),
    senderNode: input.senderNode ?? null,
    job: input.job ?? null,
    result: input.result ?? null,
    healthDecisions: input.healthDecisions ?? [],
    operationalSummary: input.operationalSummary ?? null,
    decision,
    gates: [
      "blueprint_ready_before_runner",
      "kill_switch_inactive_before_local_state_actions",
      "policy_accepts_request_before_queue",
      "sender_node_registered_before_worker_processing",
      "worker_records_simulated_result_only",
      "result_tracking_before_health_review",
      "audit_events_linked_by_demo_run_id",
      "smtp_disabled_for_demo_runner",
      "no_live_infrastructure_mutation"
    ],
    safety: {
      liveEmailSendingEnabled: false,
      liveInfrastructureWritesEnabled: false,
      liveDnsChangesEnabled: false,
      sshEnabled: false,
      nfcProductionWritesEnabled: false,
      localStateOnly: true,
      auditLinkedByDemoRunId: true
    }
  };
}

function buildDecision(input: DelivrixMvpDemoRunInput): MvpDemoRunDecision {
  const blockers = [
    input.blueprint.decision.status !== "ready_for_demo" ? "blueprint_not_ready" : null,
    input.blockedReason ? "runner_blocked" : null,
    !input.senderNode ? "sender_node_missing" : null,
    !input.job ? "send_job_missing" : null,
    !input.result ? "send_result_missing" : null,
    input.result && input.result.metadata?.simulated !== true ? "result_not_simulated" : null
  ].filter((item): item is string => item !== null);
  const warnings = [
    input.result && input.result.status !== "sent" ? `simulated_result_${input.result.status}` : null,
    hasDemoSenderHealthWarning(input) ? "health_needs_review" : null
  ].filter((item): item is string => item !== null);

  if (blockers.length > 0) {
    return {
      status: "blocked",
      canPresentToSponsor: false,
      canSendRealEmail: false,
      canMutateLiveInfrastructure: false,
      reason: input.blockedReason ?? "Demo runner is blocked until all local-state artifacts are produced safely.",
      blockers,
      warnings,
      nextRecommendedMilestone: "remain_in_5.1"
    };
  }

  if (warnings.length > 0) {
    return {
      status: "needs_review",
      canPresentToSponsor: true,
      canSendRealEmail: false,
      canMutateLiveInfrastructure: false,
      reason: "Demo runner completed with a simulated incident that should be reviewed by OpenClaw.",
      blockers,
      warnings,
      nextRecommendedMilestone: "5.2_openclaw_incident_demo"
    };
  }

  return {
    status: "completed",
    canPresentToSponsor: true,
    canSendRealEmail: false,
    canMutateLiveInfrastructure: false,
    reason: "Demo runner completed the local-state-only path with linked audit evidence.",
    blockers,
    warnings,
    nextRecommendedMilestone: "5.2_openclaw_incident_demo"
  };
}

function hasDemoSenderHealthWarning(input: DelivrixMvpDemoRunInput): boolean {
  const senderNodeId = input.result?.senderNodeId ?? input.senderNode?.id;

  if (!senderNodeId) {
    return false;
  }

  return input.healthDecisions?.some((decision) => (
    decision.senderNodeId === senderNodeId && decision.severity !== "healthy"
  )) ?? false;
}

function markSteps(
  steps: MvpDemoComponentStep[],
  status: MvpDemoRunDecisionStatus
): MvpDemoComponentStep[] {
  const mappedStatus = status === "blocked" ? "blocked" : status === "needs_review" ? "needs_review" : "ready";

  return steps.map((step) => ({
    ...step,
    status: mappedStatus
  }));
}

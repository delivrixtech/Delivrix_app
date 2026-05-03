import {
  buildKillSwitchState,
  defaultKillSwitchState,
  type KillSwitchState
} from "./kill-switch.ts";
import type { DelivrixMvpDemoRunReport } from "./mvp-demo-runner.ts";
import {
  evaluateOpenClawActionPermission,
  type OpenClawActionPermissionDecision,
  type OpenClawRunbookAction,
  type OpenClawRunbookRiskLevel
} from "./openclaw-runbook.ts";
import {
  evaluateSenderNodeManualControl,
  type SenderNodeManualAction,
  type SenderNodeManualControlDecision
} from "./sender-node-manual-control.ts";
import type { SendResultStatus, SenderNode } from "./types.ts";
import { createId } from "./ids.ts";

export type OpenClawIncidentDemoDecisionStatus = "completed" | "needs_review" | "blocked";
export type OpenClawIncidentDemoIncidentStatus = Exclude<SendResultStatus, "sent">;

export interface OpenClawIncidentDemoInput {
  id?: string;
  actorId?: string;
  demoRun: DelivrixMvpDemoRunReport;
  killSwitch?: KillSwitchState;
  humanApproved?: boolean;
  appliedSenderNode?: SenderNode;
  auditEventIds?: string[];
}

export interface OpenClawIncidentDetection {
  detected: boolean;
  status: OpenClawIncidentDemoIncidentStatus | null;
  senderNodeId: string | null;
  sendResultId: string | null;
  severity: OpenClawRunbookRiskLevel;
  reasons: string[];
}

export interface OpenClawIncidentProposal {
  skill: "alert-ops";
  action: OpenClawRunbookAction | null;
  manualAction: SenderNodeManualAction | null;
  targetSenderNodeId: string | null;
  rationale: string;
  sideEffects: "none" | "local-state-only";
  requiresHumanApproval: boolean;
}

export interface OpenClawIncidentPermissionChecks {
  withoutHumanApproval: OpenClawActionPermissionDecision | null;
  withHumanApproval: OpenClawActionPermissionDecision | null;
  withKillSwitchActive: OpenClawActionPermissionDecision | null;
}

export interface OpenClawIncidentLocalAction {
  attempted: boolean;
  applied: boolean;
  previousStatus: SenderNode["status"] | null;
  currentStatus: SenderNode["status"] | null;
  decision: SenderNodeManualControlDecision | null;
}

export interface OpenClawIncidentDemoDecision {
  status: OpenClawIncidentDemoDecisionStatus;
  canPresentToSponsor: boolean;
  canSendRealEmail: false;
  canMutateLiveInfrastructure: false;
  reason: string;
  blockers: string[];
  warnings: string[];
  nextRecommendedMilestone: "5.3_final_demo_report" | "review_openclaw_incident" | "remain_in_5.2";
}

export interface OpenClawIncidentDemoReport {
  id: string;
  createdAt: string;
  phase: "5.2-openclaw-incident-demo";
  actorId: string;
  dryRun: true;
  sideEffects: "local-state-only";
  demoRunId: string;
  detection: OpenClawIncidentDetection;
  proposal: OpenClawIncidentProposal;
  permissionChecks: OpenClawIncidentPermissionChecks;
  localAction: OpenClawIncidentLocalAction;
  auditEventIds: string[];
  decision: OpenClawIncidentDemoDecision;
  gates: string[];
  safety: {
    liveEmailSendingEnabled: false;
    liveInfrastructureWritesEnabled: false;
    liveDnsChangesEnabled: false;
    sshEnabled: false;
    nfcProductionWritesEnabled: false;
    localStateOnly: true;
    requiresHumanApprovalForLocalAction: true;
    killSwitchBlocksSupervisedAction: true;
  };
}

export function buildOpenClawIncidentDemoReport(
  input: OpenClawIncidentDemoInput,
  now = new Date()
): OpenClawIncidentDemoReport {
  const actorId = input.actorId?.trim() || input.demoRun.actorId;
  const killSwitch = input.killSwitch ?? defaultKillSwitchState(now);
  const detection = detectIncident(input.demoRun);
  const proposal = buildProposal(detection);
  const permissionChecks = buildPermissionChecks(proposal, killSwitch);
  const localAction = buildLocalAction(input.demoRun.senderNode, proposal, input.appliedSenderNode);
  const decision = buildDecision(input, detection, proposal, permissionChecks, localAction);

  return {
    id: input.id ?? createId("openclaw_incident_demo"),
    createdAt: now.toISOString(),
    phase: "5.2-openclaw-incident-demo",
    actorId,
    dryRun: true,
    sideEffects: "local-state-only",
    demoRunId: input.demoRun.id,
    detection,
    proposal,
    permissionChecks,
    localAction,
    auditEventIds: input.auditEventIds ?? [],
    decision,
    gates: [
      "incident_must_be_simulated",
      "openclaw_observes_before_proposing",
      "alert_ops_proposes_local_state_action_only",
      "runbook_permission_before_local_action",
      "human_approval_before_supervised_local_action",
      "kill_switch_blocks_supervised_local_action",
      "audit_required_for_detection_proposal_permission_and_action",
      "no_real_email",
      "no_live_infrastructure",
      "no_nfc_production_write"
    ],
    safety: {
      liveEmailSendingEnabled: false,
      liveInfrastructureWritesEnabled: false,
      liveDnsChangesEnabled: false,
      sshEnabled: false,
      nfcProductionWritesEnabled: false,
      localStateOnly: true,
      requiresHumanApprovalForLocalAction: true,
      killSwitchBlocksSupervisedAction: true
    }
  };
}

function detectIncident(demoRun: DelivrixMvpDemoRunReport): OpenClawIncidentDetection {
  const result = demoRun.result;

  if (!result || result.status === "sent") {
    return {
      detected: false,
      status: null,
      senderNodeId: result?.senderNodeId ?? demoRun.senderNode?.id ?? null,
      sendResultId: result?.id ?? null,
      severity: "low",
      reasons: result ? ["simulated_result_sent"] : ["send_result_missing"]
    };
  }

  const healthDecision = demoRun.healthDecisions.find((decision) => (
    decision.senderNodeId === (result.senderNodeId ?? demoRun.senderNode?.id)
  ));
  const severity = result.status === "complaint" || healthDecision?.severity === "critical"
    ? "critical"
    : healthDecision?.severity === "warning"
      ? "high"
      : "medium";

  return {
    detected: true,
    status: result.status,
    senderNodeId: result.senderNodeId ?? demoRun.senderNode?.id ?? null,
    sendResultId: result.id,
    severity,
    reasons: [
      `simulated_result_${result.status}`,
      ...(healthDecision?.reasons ?? [])
    ]
  };
}

function buildProposal(detection: OpenClawIncidentDetection): OpenClawIncidentProposal {
  if (!detection.detected || !detection.senderNodeId || !detection.status) {
    return {
      skill: "alert-ops",
      action: null,
      manualAction: null,
      targetSenderNodeId: detection.senderNodeId,
      rationale: "OpenClaw did not detect a simulated incident that requires local state action.",
      sideEffects: "none",
      requiresHumanApproval: true
    };
  }

  const shouldQuarantine = detection.status === "complaint" || detection.severity === "critical";
  const action: OpenClawRunbookAction = shouldQuarantine
    ? "quarantine_local_sender_node"
    : "degrade_local_sender_node";
  const manualAction: SenderNodeManualAction = shouldQuarantine ? "quarantine" : "degrade";

  return {
    skill: "alert-ops",
    action,
    manualAction,
    targetSenderNodeId: detection.senderNodeId,
    rationale: shouldQuarantine
      ? "OpenClaw detected a simulated critical reputation event and proposes local quarantine before any volume increase."
      : "OpenClaw detected a simulated delivery incident and proposes local degradation before further warming.",
    sideEffects: "local-state-only",
    requiresHumanApproval: true
  };
}

function buildPermissionChecks(
  proposal: OpenClawIncidentProposal,
  killSwitch: KillSwitchState
): OpenClawIncidentPermissionChecks {
  if (!proposal.action) {
    return {
      withoutHumanApproval: null,
      withHumanApproval: null,
      withKillSwitchActive: null
    };
  }

  const activeKillSwitch = buildKillSwitchState({
    enabled: true,
    reason: "Hito 5.2 simulated incident kill switch proof",
    updatedBy: "openclaw-incident-demo"
  });

  return {
    withoutHumanApproval: evaluateOpenClawActionPermission({
      action: proposal.action,
      mode: "supervised",
      humanApproved: false,
      killSwitch
    }),
    withHumanApproval: evaluateOpenClawActionPermission({
      action: proposal.action,
      mode: "supervised",
      humanApproved: true,
      killSwitch
    }),
    withKillSwitchActive: evaluateOpenClawActionPermission({
      action: proposal.action,
      mode: "supervised",
      humanApproved: true,
      killSwitch: activeKillSwitch
    })
  };
}

function buildLocalAction(
  node: SenderNode | null,
  proposal: OpenClawIncidentProposal,
  appliedSenderNode: SenderNode | undefined
): OpenClawIncidentLocalAction {
  if (!node || !proposal.manualAction) {
    return {
      attempted: false,
      applied: false,
      previousStatus: node?.status ?? null,
      currentStatus: appliedSenderNode?.status ?? node?.status ?? null,
      decision: null
    };
  }

  const decision = evaluateSenderNodeManualControl({
    node,
    action: proposal.manualAction,
    reason: proposal.rationale
  });

  return {
    attempted: true,
    applied: appliedSenderNode?.status === decision.nextStatus,
    previousStatus: node.status,
    currentStatus: appliedSenderNode?.status ?? node.status,
    decision
  };
}

function buildDecision(
  input: OpenClawIncidentDemoInput,
  detection: OpenClawIncidentDetection,
  proposal: OpenClawIncidentProposal,
  permissionChecks: OpenClawIncidentPermissionChecks,
  localAction: OpenClawIncidentLocalAction
): OpenClawIncidentDemoDecision {
  const blockers = [
    input.demoRun.decision.status === "blocked" ? "demo_run_blocked" : null,
    input.demoRun.result?.metadata?.simulated !== true ? "incident_not_simulated" : null,
    !detection.detected ? "incident_missing" : null,
    proposal.action && permissionChecks.withHumanApproval?.allowed !== true ? "runbook_permission_blocked" : null,
    localAction.decision && !localAction.decision.allowed ? "local_manual_control_blocked" : null
  ].filter((item): item is string => item !== null);
  const warnings = [
    !input.humanApproved ? "human_approval_missing" : null,
    proposal.action && permissionChecks.withoutHumanApproval?.allowed === false ? "human_in_loop_proven" : null,
    proposal.action && permissionChecks.withKillSwitchActive?.allowed === false ? "kill_switch_block_proven" : null,
    localAction.attempted && !localAction.applied ? "local_action_not_applied" : null
  ].filter((item): item is string => item !== null);

  if (blockers.length > 0) {
    return {
      status: "blocked",
      canPresentToSponsor: false,
      canSendRealEmail: false,
      canMutateLiveInfrastructure: false,
      reason: "OpenClaw incident demo is blocked until the simulated incident and runbook permission checks are valid.",
      blockers,
      warnings,
      nextRecommendedMilestone: "remain_in_5.2"
    };
  }

  if (warnings.includes("human_approval_missing") || warnings.includes("local_action_not_applied")) {
    return {
      status: "needs_review",
      canPresentToSponsor: true,
      canSendRealEmail: false,
      canMutateLiveInfrastructure: false,
      reason: "OpenClaw detected and proposed correctly, but the supervised local action still needs operator approval or application.",
      blockers,
      warnings,
      nextRecommendedMilestone: "review_openclaw_incident"
    };
  }

  return {
    status: "completed",
    canPresentToSponsor: true,
    canSendRealEmail: false,
    canMutateLiveInfrastructure: false,
    reason: "OpenClaw detected the simulated incident, proposed a supervised local action, proved kill switch blocking, and applied only local state.",
    blockers,
    warnings,
    nextRecommendedMilestone: "5.3_final_demo_report"
  };
}

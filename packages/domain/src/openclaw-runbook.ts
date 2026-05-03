import { createId } from "./ids.ts";
import {
  buildKillSwitchState,
  defaultKillSwitchState,
  evaluateKillSwitch,
  type KillSwitchState
} from "./kill-switch.ts";
import type { OpenClawSchedulerRun } from "./openclaw-scheduler.ts";

export type OpenClawRunbookAction =
  | "read_operating_north"
  | "evaluate_onboarding"
  | "build_topology_plan"
  | "build_provisioning_dry_run"
  | "run_scheduler_observer"
  | "generate_daily_report"
  | "prepare_inventory_payload"
  | "register_local_sender_node"
  | "simulate_provisioning"
  | "pause_local_sender_node"
  | "degrade_local_sender_node"
  | "quarantine_local_sender_node"
  | "proxmox_live_create"
  | "ssh_connect"
  | "dns_live_change"
  | "postfix_live_apply"
  | "smtp_send"
  | "nfc_production_write"
  | "increase_volume"
  | "rotate_ip_for_volume";

export type OpenClawRunbookPermissionCategory =
  | "allowed_read_only"
  | "allowed_dry_run"
  | "supervised_local_state"
  | "future_live_requires_new_phase"
  | "prohibited";

export type OpenClawRunbookDecisionStatus =
  | "ready_for_phase_5_demo"
  | "needs_review"
  | "blocked";

export type OpenClawRunbookRiskLevel = "low" | "medium" | "high" | "critical";

export interface OpenClawRunbookInput {
  actorId?: string;
  killSwitch?: KillSwitchState;
  schedulerRun?: OpenClawSchedulerRun;
}

export interface OpenClawPermissionMatrixItem {
  action: OpenClawRunbookAction;
  category: OpenClawRunbookPermissionCategory;
  mode: "read_only" | "dry_run" | "supervised" | "live";
  owner: "openclaw" | "operator" | "system";
  allowedInHito45: boolean;
  humanApprovalRequired: boolean;
  killSwitchMustBeInactive: boolean;
  auditRequired: boolean;
  rollback: "not_applicable" | "local_state_revert" | "manual_runbook_required" | "not_allowed";
  reason: string;
}

export interface OpenClawActionPermissionInput {
  action: OpenClawRunbookAction;
  mode?: "read_only" | "dry_run" | "supervised" | "live";
  humanApproved?: boolean;
  killSwitch?: KillSwitchState;
}

export interface OpenClawActionPermissionDecision {
  allowed: boolean;
  action: OpenClawRunbookAction;
  category: OpenClawRunbookPermissionCategory;
  requiresHumanApproval: boolean;
  requiresKillSwitchInactive: boolean;
  blockedBy: string[];
  riskLevel: OpenClawRunbookRiskLevel;
  reason: string;
}

export interface OpenClawRunbookStep {
  order: number;
  name: string;
  owner: "operator" | "openclaw" | "system";
  trigger: string;
  allowedActions: OpenClawRunbookAction[];
  stopCondition: string;
  auditAction: string;
}

export interface OpenClawLimitedProductionChecklistItem {
  code: string;
  status: "pass" | "needs_review" | "blocked";
  required: true;
  evidence: string;
}

export interface OpenClawKillSwitchProof {
  currentState: KillSwitchState;
  simulatedActiveState: KillSwitchState;
  blocksOpenClawProposedActions: true;
  blocksSupervisedLocalActions: true;
  blocksLiveInfrastructureActions: true;
  blocksQueueProcessing: true;
  decisions: Array<{
    operation: string;
    allowed: boolean;
    code: string;
    message: string;
  }>;
}

export interface OpenClawRunbookDecision {
  status: OpenClawRunbookDecisionStatus;
  canStartLimitedProduction: false;
  canRunPhase5Demo: boolean;
  riskLevel: OpenClawRunbookRiskLevel;
  reason: string;
  nextRecommendedMilestone: "phase_5_demo" | "review_scheduler_report" | "remain_in_phase_4";
}

export interface OpenClawOperationalRunbook {
  id: string;
  createdAt: string;
  phase: "4.5-runbook-permissions-kill-switch";
  actorId: string;
  dryRun: true;
  sideEffects: "none";
  permissionMatrix: OpenClawPermissionMatrixItem[];
  runbook: OpenClawRunbookStep[];
  checklist: OpenClawLimitedProductionChecklistItem[];
  killSwitchProof: OpenClawKillSwitchProof;
  sampleDecisions: OpenClawActionPermissionDecision[];
  decision: OpenClawRunbookDecision;
  gates: string[];
  blockedActions: string[];
  requiredApprovals: string[];
  safety: {
    liveInfrastructureWritesEnabled: false;
    liveEmailSendingEnabled: false;
    nfcProductionWritesEnabled: false;
    sshEnabled: false;
    dnsLiveChangesEnabled: false;
    proxmoxApiEnabled: false;
    llmAutonomousExecutionEnabled: false;
    killSwitchRequiredForSupervisedActions: true;
    auditRequiredForEveryAction: true;
  };
}

const matrix: OpenClawPermissionMatrixItem[] = [
  allowedReadOnly("read_operating_north", "system", "Read the current operating boundary."),
  allowedReadOnly("evaluate_onboarding", "openclaw", "Evaluate onboarding data and missing prerequisites."),
  allowedDryRun("build_topology_plan", "openclaw", "Build cluster topology plans without live infrastructure changes."),
  allowedDryRun("build_provisioning_dry_run", "openclaw", "Build Proxmox/Postfix/OpenDKIM/TLS/DNS/warming plans without side effects."),
  allowedReadOnly("run_scheduler_observer", "openclaw", "Run scheduler as observer: read, report and propose only."),
  allowedReadOnly("generate_daily_report", "openclaw", "Generate the daily infrastructure report for operator review."),
  allowedDryRun("prepare_inventory_payload", "openclaw", "Prepare local sender-node inventory payloads without registering live capacity."),
  supervisedLocal("register_local_sender_node", "operator", "Register local inventory only after human approval and inactive kill switch."),
  supervisedLocal("simulate_provisioning", "operator", "Simulate provisioning locally with audit and inactive kill switch."),
  supervisedLocal("pause_local_sender_node", "operator", "Pause a local sender-node state with audit."),
  supervisedLocal("degrade_local_sender_node", "operator", "Degrade a local sender-node state with audit."),
  supervisedLocal("quarantine_local_sender_node", "operator", "Quarantine a local sender-node state with audit."),
  futureLive("proxmox_live_create", "operator", "Live Proxmox create requires a future phase, explicit approval and rollback runbook."),
  futureLive("ssh_connect", "operator", "Real SSH requires a future phase, scope review and explicit approval."),
  futureLive("dns_live_change", "operator", "Live DNS changes require prior dry-run, review and future phase authorization."),
  futureLive("postfix_live_apply", "operator", "Live Postfix apply requires future phase authorization and rollback."),
  prohibited("smtp_send", "system", "Delivrix does not send real email in the MVP."),
  prohibited("nfc_production_write", "system", "NFC production writes are outside the MVP and require a future bridge contract."),
  prohibited("increase_volume", "openclaw", "Volume cannot increase without warming and reputation gates."),
  prohibited("rotate_ip_for_volume", "openclaw", "IP rotation to sustain volume after reputation events is prohibited.")
];

export function buildOpenClawOperationalRunbook(
  input: OpenClawRunbookInput = {},
  now = new Date()
): OpenClawOperationalRunbook {
  const actorId = input.actorId?.trim() || input.schedulerRun?.actorId || "operator_local";
  const killSwitch = input.killSwitch ?? defaultKillSwitchState(now);
  const killSwitchProof = buildKillSwitchProof(killSwitch, now);
  const checklist = buildChecklist(input.schedulerRun, killSwitchProof);
  const sampleDecisions = buildSampleDecisions(killSwitch);
  const decision = buildDecision(input.schedulerRun, checklist, killSwitchProof);

  return {
    id: createId("openclaw_runbook"),
    createdAt: now.toISOString(),
    phase: "4.5-runbook-permissions-kill-switch",
    actorId,
    dryRun: true,
    sideEffects: "none",
    permissionMatrix: matrix,
    runbook: buildRunbookSteps(),
    checklist,
    killSwitchProof,
    sampleDecisions,
    decision,
    gates: [
      "permission_matrix_before_limited_execution",
      "human_approval_before_supervised_local_state_change",
      "kill_switch_must_block_supervised_and_live_actions",
      "audit_required_for_every_human_or_openclaw_action",
      "daily_report_review_before_execution",
      "no_live_infrastructure_in_phase_4_5",
      "no_real_email_from_delivrix",
      "no_external_bridge_dependency"
    ],
    blockedActions: matrix.filter((item) => !item.allowedInHito45).map((item) => item.action),
    requiredApprovals: [
      "operator_approval_before_supervised_local_state_change",
      "risk_review_before_capacity_change",
      "runbook_review_before_phase_5_demo",
      "kill_switch_proof_review_before_limited_production"
    ],
    safety: {
      liveInfrastructureWritesEnabled: false,
      liveEmailSendingEnabled: false,
      nfcProductionWritesEnabled: false,
      sshEnabled: false,
      dnsLiveChangesEnabled: false,
      proxmoxApiEnabled: false,
      llmAutonomousExecutionEnabled: false,
      killSwitchRequiredForSupervisedActions: true,
      auditRequiredForEveryAction: true
    }
  };
}

export function evaluateOpenClawActionPermission(
  input: OpenClawActionPermissionInput
): OpenClawActionPermissionDecision {
  const item = matrix.find((candidate) => candidate.action === input.action);

  if (!item) {
    return {
      allowed: false,
      action: input.action,
      category: "prohibited",
      requiresHumanApproval: true,
      requiresKillSwitchInactive: true,
      blockedBy: ["unknown_action"],
      riskLevel: "critical",
      reason: "Unknown OpenClaw action is blocked by default."
    };
  }

  if (item.category === "prohibited") {
    return blockedDecision(item, ["prohibited_action"], "Action is explicitly prohibited in the MVP.", "critical");
  }

  if (item.category === "future_live_requires_new_phase") {
    return blockedDecision(item, ["phase_4_5_gate", "future_phase_required"], "Live action requires a future phase and remains blocked in Hito 4.5.", "critical");
  }

  if (item.mode !== input.mode && input.mode !== undefined) {
    return blockedDecision(item, ["mode_mismatch"], `Action requires ${item.mode} mode.`, "high");
  }

  if (item.humanApprovalRequired && !input.humanApproved) {
    return blockedDecision(item, ["human_approval_required"], "Action requires explicit human approval.", "high");
  }

  if (item.killSwitchMustBeInactive) {
    const state = input.killSwitch ?? defaultKillSwitchState();
    const killSwitchDecision = evaluateKillSwitch(state, "apply_supervised_local_action");

    if (!killSwitchDecision.allowed) {
      return blockedDecision(item, ["kill_switch_active"], killSwitchDecision.message, "critical");
    }
  }

  return {
    allowed: true,
    action: item.action,
    category: item.category,
    requiresHumanApproval: item.humanApprovalRequired,
    requiresKillSwitchInactive: item.killSwitchMustBeInactive,
    blockedBy: [],
    riskLevel: item.category === "supervised_local_state" ? "medium" : "low",
    reason: item.reason
  };
}

function buildKillSwitchProof(currentState: KillSwitchState, now: Date): OpenClawKillSwitchProof {
  const simulatedActiveState = buildKillSwitchState({
    enabled: true,
    reason: "Hito 4.5 kill switch proof",
    updatedBy: "openclaw-runbook",
    now
  });
  const decisions = [
    evaluateKillSwitch(simulatedActiveState, "execute_openclaw_proposed_action"),
    evaluateKillSwitch(simulatedActiveState, "apply_supervised_local_action"),
    evaluateKillSwitch(simulatedActiveState, "apply_live_infrastructure_action"),
    evaluateKillSwitch(simulatedActiveState, "claim_send_job")
  ].map((decision) => ({
    operation: decision.operation,
    allowed: decision.allowed,
    code: decision.code,
    message: decision.message
  }));

  return {
    currentState,
    simulatedActiveState,
    blocksOpenClawProposedActions: decisions[0].allowed === false,
    blocksSupervisedLocalActions: decisions[1].allowed === false,
    blocksLiveInfrastructureActions: decisions[2].allowed === false,
    blocksQueueProcessing: decisions[3].allowed === false,
    decisions
  };
}

function buildChecklist(
  schedulerRun: OpenClawSchedulerRun | undefined,
  killSwitchProof: OpenClawKillSwitchProof
): OpenClawLimitedProductionChecklistItem[] {
  return [
    checklist("permission_matrix_defined", "pass", "Hito 4.5 defines allowed, supervised, future-live and prohibited actions."),
    checklist("audit_required", "pass", "Every matrix action requires audit when executed or rejected."),
    checklist("human_approval_required", "pass", "Supervised local state actions require explicit human approval."),
    checklist("kill_switch_blocks_actions", killSwitchProofPasses(killSwitchProof) ? "pass" : "blocked", "Kill switch proof blocks OpenClaw, supervised, live and queue processing operations."),
    checklist("scheduler_report_available", !schedulerRun || schedulerRun.decision.status === "report_ready" ? "pass" : "needs_review", schedulerRun ? `Scheduler decision is ${schedulerRun.decision.status}.` : "Runbook can be created without scheduler input, but daily report remains required before execution."),
    checklist("live_actions_blocked", "pass", "Proxmox live, SSH, DNS live, SMTP and NFC writes remain blocked."),
    checklist("nfc_bridge_not_required", "pass", "External bridge remains disabled or mock and is not a Phase 4 dependency."),
    checklist("limited_production_not_enabled", "pass", "Hito 4.5 does not enable limited production; it prepares gates for Phase 5 demo.")
  ];
}

function buildSampleDecisions(killSwitch: KillSwitchState): OpenClawActionPermissionDecision[] {
  const activeKillSwitch = buildKillSwitchState({
    enabled: true,
    reason: "Sample blocked state",
    updatedBy: "openclaw-runbook"
  });

  return [
    evaluateOpenClawActionPermission({ action: "run_scheduler_observer", mode: "read_only", killSwitch }),
    evaluateOpenClawActionPermission({ action: "register_local_sender_node", mode: "supervised", humanApproved: true, killSwitch }),
    evaluateOpenClawActionPermission({ action: "register_local_sender_node", mode: "supervised", humanApproved: true, killSwitch: activeKillSwitch }),
    evaluateOpenClawActionPermission({ action: "proxmox_live_create", mode: "live", humanApproved: true, killSwitch }),
    evaluateOpenClawActionPermission({ action: "smtp_send", mode: "live", humanApproved: true, killSwitch })
  ];
}

function buildDecision(
  schedulerRun: OpenClawSchedulerRun | undefined,
  checklistItems: OpenClawLimitedProductionChecklistItem[],
  killSwitchProof: OpenClawKillSwitchProof
): OpenClawRunbookDecision {
  const blocked = checklistItems.some((item) => item.status === "blocked");
  const needsReview = checklistItems.some((item) => item.status === "needs_review");

  if (blocked || !killSwitchProofPasses(killSwitchProof)) {
    return {
      status: "blocked",
      canStartLimitedProduction: false,
      canRunPhase5Demo: false,
      riskLevel: "critical",
      reason: "Runbook is blocked because kill switch proof or required checklist items failed.",
      nextRecommendedMilestone: "remain_in_phase_4"
    };
  }

  if (needsReview || (schedulerRun && schedulerRun.decision.status !== "report_ready")) {
    return {
      status: "needs_review",
      canStartLimitedProduction: false,
      canRunPhase5Demo: false,
      riskLevel: "medium",
      reason: "Runbook is defined, but scheduler report or checklist items require human review.",
      nextRecommendedMilestone: "review_scheduler_report"
    };
  }

  return {
    status: "ready_for_phase_5_demo",
    canStartLimitedProduction: false,
    canRunPhase5Demo: true,
    riskLevel: "low",
    reason: "Fase 4 gates are documented and kill switch proof passed. Limited production still remains disabled.",
    nextRecommendedMilestone: "phase_5_demo"
  };
}

function buildRunbookSteps(): OpenClawRunbookStep[] {
  return [
    {
      order: 1,
      name: "Review daily report",
      owner: "operator",
      trigger: "daily-report generated by OpenClaw",
      allowedActions: ["read_operating_north", "generate_daily_report", "run_scheduler_observer"],
      stopCondition: "Report is blocked, high risk is unresolved, or kill switch is active.",
      auditAction: "openclaw_runbook.daily_report_reviewed"
    },
    {
      order: 2,
      name: "Approve supervised local state changes",
      owner: "operator",
      trigger: "OpenClaw proposes a local inventory or node-state action",
      allowedActions: ["register_local_sender_node", "pause_local_sender_node", "degrade_local_sender_node", "quarantine_local_sender_node"],
      stopCondition: "No explicit approval, missing reason, or kill switch active.",
      auditAction: "openclaw_runbook.supervised_local_action_reviewed"
    },
    {
      order: 3,
      name: "Validate kill switch before any action",
      owner: "system",
      trigger: "Any supervised or future live action is requested",
      allowedActions: ["simulate_provisioning"],
      stopCondition: "Kill switch active or unavailable.",
      auditAction: "openclaw_runbook.kill_switch_checked"
    },
    {
      order: 4,
      name: "Escalate future live infrastructure",
      owner: "operator",
      trigger: "OpenClaw proposes SSH, Proxmox live, DNS live, Postfix live or SMTP",
      allowedActions: [],
      stopCondition: "Always blocked in Hito 4.5.",
      auditAction: "openclaw_runbook.future_live_action_blocked"
    }
  ];
}

function allowedReadOnly(
  action: OpenClawRunbookAction,
  owner: OpenClawPermissionMatrixItem["owner"],
  reason: string
): OpenClawPermissionMatrixItem {
  return {
    action,
    category: "allowed_read_only",
    mode: "read_only",
    owner,
    allowedInHito45: true,
    humanApprovalRequired: false,
    killSwitchMustBeInactive: false,
    auditRequired: true,
    rollback: "not_applicable",
    reason
  };
}

function allowedDryRun(
  action: OpenClawRunbookAction,
  owner: OpenClawPermissionMatrixItem["owner"],
  reason: string
): OpenClawPermissionMatrixItem {
  return {
    action,
    category: "allowed_dry_run",
    mode: "dry_run",
    owner,
    allowedInHito45: true,
    humanApprovalRequired: false,
    killSwitchMustBeInactive: false,
    auditRequired: true,
    rollback: "not_applicable",
    reason
  };
}

function supervisedLocal(
  action: OpenClawRunbookAction,
  owner: OpenClawPermissionMatrixItem["owner"],
  reason: string
): OpenClawPermissionMatrixItem {
  return {
    action,
    category: "supervised_local_state",
    mode: "supervised",
    owner,
    allowedInHito45: true,
    humanApprovalRequired: true,
    killSwitchMustBeInactive: true,
    auditRequired: true,
    rollback: "local_state_revert",
    reason
  };
}

function futureLive(
  action: OpenClawRunbookAction,
  owner: OpenClawPermissionMatrixItem["owner"],
  reason: string
): OpenClawPermissionMatrixItem {
  return {
    action,
    category: "future_live_requires_new_phase",
    mode: "live",
    owner,
    allowedInHito45: false,
    humanApprovalRequired: true,
    killSwitchMustBeInactive: true,
    auditRequired: true,
    rollback: "manual_runbook_required",
    reason
  };
}

function prohibited(
  action: OpenClawRunbookAction,
  owner: OpenClawPermissionMatrixItem["owner"],
  reason: string
): OpenClawPermissionMatrixItem {
  return {
    action,
    category: "prohibited",
    mode: "live",
    owner,
    allowedInHito45: false,
    humanApprovalRequired: true,
    killSwitchMustBeInactive: true,
    auditRequired: true,
    rollback: "not_allowed",
    reason
  };
}

function blockedDecision(
  item: OpenClawPermissionMatrixItem,
  blockedBy: string[],
  reason: string,
  riskLevel: OpenClawRunbookRiskLevel
): OpenClawActionPermissionDecision {
  return {
    allowed: false,
    action: item.action,
    category: item.category,
    requiresHumanApproval: item.humanApprovalRequired,
    requiresKillSwitchInactive: item.killSwitchMustBeInactive,
    blockedBy,
    riskLevel,
    reason
  };
}

function checklist(
  code: string,
  status: OpenClawLimitedProductionChecklistItem["status"],
  evidence: string
): OpenClawLimitedProductionChecklistItem {
  return {
    code,
    status,
    required: true,
    evidence
  };
}

function killSwitchProofPasses(proof: OpenClawKillSwitchProof): boolean {
  return proof.blocksOpenClawProposedActions
    && proof.blocksSupervisedLocalActions
    && proof.blocksLiveInfrastructureActions
    && proof.blocksQueueProcessing;
}

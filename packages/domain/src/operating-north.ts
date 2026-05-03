export type OperatingAction =
  | "evaluate_openclaw_onboarding"
  | "build_cluster_topology_plan"
  | "build_provisioning_dry_run"
  | "run_openclaw_scheduler"
  | "evaluate_openclaw_runbook"
  | "build_mvp_demo_blueprint"
  | "run_mvp_demo_local"
  | "build_capacity_plan"
  | "build_nfc_bridge_payload"
  | "ingest_observed_result"
  | "register_local_sender_node"
  | "simulate_provisioning"
  | "activate_nfc_provider"
  | "dns_live_change"
  | "proxmox_live_mutation"
  | "purge_remote_queue"
  | "send_email_real"
  | "ssh_real"
  | "write_nfc_production";

export type OperatingMode = "read_only" | "dry_run" | "supervised" | "live";

export interface OperatingActionGateInput {
  action: OperatingAction;
  mode: OperatingMode;
  humanApproved?: boolean;
}

export interface OperatingActionGateDecision {
  allowed: boolean;
  requiresHumanApproval: boolean;
  reason: string;
  blockedBy: string[];
  riskLevel: "low" | "medium" | "high" | "critical";
}

export interface OperatingNorthSnapshot {
  sourceOfTruth: "NORTE_OPERATIVO_DELIVRIX.md";
  phase: "5.1-demo-runner-local-state";
  delivrixRole: "control_plane";
  nfcRole: "future_optional_external_integration";
  openClawRole: "intelligent_demo_runner_guarded_operator";
  delivrixSendsRealEmail: false;
  nfcSendsRealEmail: false;
  liveInfrastructureWritesEnabled: false;
  nfcProductionWritesEnabled: false;
  allowedActions: OperatingAction[];
  blockedActions: OperatingAction[];
  gates: string[];
}

const allowedActions: OperatingAction[] = [
  "evaluate_openclaw_onboarding",
  "build_cluster_topology_plan",
  "build_provisioning_dry_run",
  "run_openclaw_scheduler",
  "evaluate_openclaw_runbook",
  "build_mvp_demo_blueprint",
  "run_mvp_demo_local",
  "build_capacity_plan",
  "build_nfc_bridge_payload",
  "ingest_observed_result",
  "register_local_sender_node",
  "simulate_provisioning"
];

const blockedActions: OperatingAction[] = [
  "activate_nfc_provider",
  "dns_live_change",
  "proxmox_live_mutation",
  "purge_remote_queue",
  "send_email_real",
  "ssh_real",
  "write_nfc_production"
];

export function getOperatingNorthSnapshot(): OperatingNorthSnapshot {
  return {
    sourceOfTruth: "NORTE_OPERATIVO_DELIVRIX.md",
    phase: "5.1-demo-runner-local-state",
    delivrixRole: "control_plane",
    nfcRole: "future_optional_external_integration",
    openClawRole: "intelligent_demo_runner_guarded_operator",
    delivrixSendsRealEmail: false,
    nfcSendsRealEmail: false,
    liveInfrastructureWritesEnabled: false,
    nfcProductionWritesEnabled: false,
    allowedActions,
    blockedActions,
    gates: [
      "no_real_email_from_delivrix",
      "openclaw_onboarding_before_topology_planner",
      "topology_plan_before_provisioning_dry_run",
      "provisioning_dry_run_before_live_apply",
      "scheduler_must_observe_report_and_propose_first",
      "permission_matrix_before_limited_execution",
      "kill_switch_proof_before_phase_5_demo",
      "mvp_demo_blueprint_before_demo_runner",
      "mvp_demo_runner_local_state_only",
      "no_nfc_production_write_without_contract_and_approval",
      "no_real_ssh_without_human_approval",
      "no_live_dns_change_without_dry_run_and_approval",
      "no_volume_increase_without_warming_and_reputation",
      "no_ip_rotation_to_sustain_volume_after_reputation_events",
      "no_plaintext_smtp_credentials_in_production",
      "kill_switch_must_block_processing"
    ]
  };
}

export function evaluateOperatingActionGate(
  input: OperatingActionGateInput
): OperatingActionGateDecision {
  if (allowedActions.includes(input.action) && (input.mode === "read_only" || input.mode === "dry_run")) {
    return {
      allowed: true,
      requiresHumanApproval: false,
      reason: "Action is inside the Delivrix control-plane boundary for Hito 5.1.",
      blockedBy: [],
      riskLevel: "low"
    };
  }

  if (allowedActions.includes(input.action) && input.mode === "supervised" && input.humanApproved) {
    return {
      allowed: true,
      requiresHumanApproval: true,
      reason: "Action is allowed because it remains local/control-plane scoped and human approval was provided.",
      blockedBy: [],
      riskLevel: "medium"
    };
  }

  if (blockedActions.includes(input.action)) {
    return {
      allowed: false,
      requiresHumanApproval: true,
      reason: "Action is outside Hito 5.1. Delivrix may not perform real sending, live infrastructure mutation, or NFC production writes yet.",
      blockedBy: ["north_operating_boundary", "phase_5_1_gate"],
      riskLevel: "critical"
    };
  }

  return {
    allowed: false,
    requiresHumanApproval: true,
    reason: "Action requires explicit gate review before execution.",
    blockedBy: ["unclassified_action"],
    riskLevel: "high"
  };
}

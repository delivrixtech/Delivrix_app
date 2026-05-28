export type OperatingAction =
  | "build_admin_cluster_overview"
  | "build_openclaw_learning_plan"
  | "read_devops_collector_status"
  | "read_collector_snapshot_ingestion_contract"
  | "read_supervised_collector_plan"
  | "read_hardware_telemetry_contract"
  | "read_openclaw_live_canvas"
  | "read_openclaw_readiness_signals"
  | "read_openclaw_state_contracts"
  | "read_physical_host_contract"
  | "evaluate_openclaw_onboarding"
  | "build_cluster_topology_plan"
  | "build_provisioning_dry_run"
  | "run_openclaw_scheduler"
  | "evaluate_openclaw_runbook"
  | "build_mvp_demo_blueprint"
  | "run_mvp_demo_local"
  | "run_openclaw_incident_demo"
  | "build_mvp_final_demo_report"
  | "build_capacity_plan"
  | "build_nfc_bridge_payload"
  | "ingest_observed_result"
  | "ingest_manual_collector_snapshot"
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

export interface OperatingNorthGateDetail {
  id: string;
  displayLabel: string;
  description?: string;
}

export interface OperatingNorthRoleDisplayNames {
  control_plane: string;
  future_optional_external_integration: string;
  intelligent_cluster_operator_read_only: string;
}

export interface OperatingNorthSnapshot {
  sourceOfTruth: "NORTE_OPERATIVO_DELIVRIX.md";
  phase: "5.9-manual-snapshot-ingestion-ux";
  environment: "mvp.local";
  releasePhase: "5.9-manual-snapshot-ingestion-ux";
  delivrixRole: "control_plane";
  nfcRole: "future_optional_external_integration";
  openClawRole: "intelligent_cluster_operator_read_only";
  roleDisplayNames: OperatingNorthRoleDisplayNames;
  delivrixSendsRealEmail: false;
  nfcSendsRealEmail: false;
  liveInfrastructureWritesEnabled: false;
  nfcProductionWritesEnabled: false;
  allowedActions: OperatingAction[];
  blockedActions: OperatingAction[];
  gates: string[];
  gateDetails: OperatingNorthGateDetail[];
}

const allowedActions: OperatingAction[] = [
  "build_admin_cluster_overview",
  "build_openclaw_learning_plan",
  "read_devops_collector_status",
  "read_collector_snapshot_ingestion_contract",
  "read_supervised_collector_plan",
  "read_hardware_telemetry_contract",
  "read_openclaw_live_canvas",
  "read_openclaw_readiness_signals",
  "read_openclaw_state_contracts",
  "read_physical_host_contract",
  "evaluate_openclaw_onboarding",
  "build_cluster_topology_plan",
  "build_provisioning_dry_run",
  "run_openclaw_scheduler",
  "evaluate_openclaw_runbook",
  "build_mvp_demo_blueprint",
  "run_mvp_demo_local",
  "run_openclaw_incident_demo",
  "build_mvp_final_demo_report",
  "build_capacity_plan",
  "build_nfc_bridge_payload",
  "ingest_observed_result",
  "ingest_manual_collector_snapshot",
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

const northGates = [
  "no_real_email_from_delivrix",
  "admin_panel_reads_cluster_state_from_backend_contract",
  "admin_panel_reads_canvas_and_hardware_from_backend_contracts",
  "openclaw_learning_uses_curated_evidence_only",
  "hardware_telemetry_starts_mock_or_read_only",
  "devops_collector_must_declare_source_freshness",
  "supervised_collector_sources_require_read_only_scope",
  "collector_snapshots_must_be_redacted_and_audited",
  "manual_snapshot_ingestion_requires_supervised_human_approval",
  "admin_panel_must_not_post_manual_snapshots",
  "ml_readiness_signals_must_not_self_promote",
  "openclaw_onboarding_before_topology_planner",
  "topology_plan_before_provisioning_dry_run",
  "provisioning_dry_run_before_live_apply",
  "scheduler_must_observe_report_and_propose_first",
  "permission_matrix_before_limited_execution",
  "kill_switch_proof_before_phase_5_demo",
  "mvp_demo_blueprint_before_demo_runner",
  "mvp_demo_runner_local_state_only",
  "openclaw_incident_demo_requires_simulated_incident",
  "openclaw_incident_demo_requires_runbook_permission",
  "openclaw_incident_demo_requires_human_approval_for_local_state",
  "final_demo_report_must_not_promise_volume",
  "final_demo_report_must_show_residual_risks",
  "no_nfc_production_write_without_contract_and_approval",
  "no_real_ssh_without_human_approval",
  "no_live_dns_change_without_dry_run_and_approval",
  "no_volume_increase_without_warming_and_reputation",
  "no_ip_rotation_to_sustain_volume_after_reputation_events",
  "no_plaintext_smtp_credentials_in_production",
  "kill_switch_must_block_processing"
] as const;

const gateDisplay: Record<typeof northGates[number], OperatingNorthGateDetail> = {
  no_real_email_from_delivrix: {
    id: "no_real_email_from_delivrix",
    displayLabel: "Sin envío real desde Delivrix",
    description: "El MVP solo observa, planifica y simula; no dispara correo real."
  },
  admin_panel_reads_cluster_state_from_backend_contract: {
    id: "admin_panel_reads_cluster_state_from_backend_contract",
    displayLabel: "Panel lee clusters desde contrato backend"
  },
  admin_panel_reads_canvas_and_hardware_from_backend_contracts: {
    id: "admin_panel_reads_canvas_and_hardware_from_backend_contracts",
    displayLabel: "Panel lee canvas y hardware desde contratos backend"
  },
  openclaw_learning_uses_curated_evidence_only: {
    id: "openclaw_learning_uses_curated_evidence_only",
    displayLabel: "OpenClaw aprende solo con evidencia curada"
  },
  hardware_telemetry_starts_mock_or_read_only: {
    id: "hardware_telemetry_starts_mock_or_read_only",
    displayLabel: "Telemetría hardware inicia mock o solo lectura"
  },
  devops_collector_must_declare_source_freshness: {
    id: "devops_collector_must_declare_source_freshness",
    displayLabel: "Collector declara frescura de cada fuente"
  },
  supervised_collector_sources_require_read_only_scope: {
    id: "supervised_collector_sources_require_read_only_scope",
    displayLabel: "Fuentes supervisadas requieren alcance solo lectura"
  },
  collector_snapshots_must_be_redacted_and_audited: {
    id: "collector_snapshots_must_be_redacted_and_audited",
    displayLabel: "Snapshots del collector se redactan y auditan"
  },
  manual_snapshot_ingestion_requires_supervised_human_approval: {
    id: "manual_snapshot_ingestion_requires_supervised_human_approval",
    displayLabel: "Ingesta manual exige aprobación humana supervisada"
  },
  admin_panel_must_not_post_manual_snapshots: {
    id: "admin_panel_must_not_post_manual_snapshots",
    displayLabel: "Panel admin no publica snapshots manuales"
  },
  ml_readiness_signals_must_not_self_promote: {
    id: "ml_readiness_signals_must_not_self_promote",
    displayLabel: "Readiness ML no se autopromueve"
  },
  openclaw_onboarding_before_topology_planner: {
    id: "openclaw_onboarding_before_topology_planner",
    displayLabel: "Onboarding antes del planner de topología"
  },
  topology_plan_before_provisioning_dry_run: {
    id: "topology_plan_before_provisioning_dry_run",
    displayLabel: "Plan de topología antes del dry-run de provisión"
  },
  provisioning_dry_run_before_live_apply: {
    id: "provisioning_dry_run_before_live_apply",
    displayLabel: "Dry-run de provisión antes de aplicar en vivo"
  },
  scheduler_must_observe_report_and_propose_first: {
    id: "scheduler_must_observe_report_and_propose_first",
    displayLabel: "Scheduler observa, reporta y propone primero"
  },
  permission_matrix_before_limited_execution: {
    id: "permission_matrix_before_limited_execution",
    displayLabel: "Matriz de permisos antes de ejecución limitada"
  },
  kill_switch_proof_before_phase_5_demo: {
    id: "kill_switch_proof_before_phase_5_demo",
    displayLabel: "Prueba del kill switch antes del demo de fase 5"
  },
  mvp_demo_blueprint_before_demo_runner: {
    id: "mvp_demo_blueprint_before_demo_runner",
    displayLabel: "Blueprint MVP antes del demo runner"
  },
  mvp_demo_runner_local_state_only: {
    id: "mvp_demo_runner_local_state_only",
    displayLabel: "Demo runner usa solo estado local"
  },
  openclaw_incident_demo_requires_simulated_incident: {
    id: "openclaw_incident_demo_requires_simulated_incident",
    displayLabel: "Demo de incidente requiere incidente simulado"
  },
  openclaw_incident_demo_requires_runbook_permission: {
    id: "openclaw_incident_demo_requires_runbook_permission",
    displayLabel: "Demo de incidente requiere permiso de runbook"
  },
  openclaw_incident_demo_requires_human_approval_for_local_state: {
    id: "openclaw_incident_demo_requires_human_approval_for_local_state",
    displayLabel: "Incidente local requiere aprobación humana"
  },
  final_demo_report_must_not_promise_volume: {
    id: "final_demo_report_must_not_promise_volume",
    displayLabel: "Reporte final no promete volumen"
  },
  final_demo_report_must_show_residual_risks: {
    id: "final_demo_report_must_show_residual_risks",
    displayLabel: "Reporte final muestra riesgos residuales"
  },
  no_nfc_production_write_without_contract_and_approval: {
    id: "no_nfc_production_write_without_contract_and_approval",
    displayLabel: "Sin escritura NFC producción sin contrato y aprobación"
  },
  no_real_ssh_without_human_approval: {
    id: "no_real_ssh_without_human_approval",
    displayLabel: "Sin SSH real sin aprobación humana"
  },
  no_live_dns_change_without_dry_run_and_approval: {
    id: "no_live_dns_change_without_dry_run_and_approval",
    displayLabel: "Sin DNS live sin dry-run y aprobación"
  },
  no_volume_increase_without_warming_and_reputation: {
    id: "no_volume_increase_without_warming_and_reputation",
    displayLabel: "Sin aumento de volumen sin warming y reputación"
  },
  no_ip_rotation_to_sustain_volume_after_reputation_events: {
    id: "no_ip_rotation_to_sustain_volume_after_reputation_events",
    displayLabel: "Sin rotación de IP para sostener volumen tras eventos"
  },
  no_plaintext_smtp_credentials_in_production: {
    id: "no_plaintext_smtp_credentials_in_production",
    displayLabel: "Sin credenciales SMTP en texto plano"
  },
  kill_switch_must_block_processing: {
    id: "kill_switch_must_block_processing",
    displayLabel: "Kill switch bloquea procesamiento"
  }
};

export function getOperatingNorthSnapshot(): OperatingNorthSnapshot {
  return {
    sourceOfTruth: "NORTE_OPERATIVO_DELIVRIX.md",
    phase: "5.9-manual-snapshot-ingestion-ux",
    environment: "mvp.local",
    releasePhase: "5.9-manual-snapshot-ingestion-ux",
    delivrixRole: "control_plane",
    nfcRole: "future_optional_external_integration",
    openClawRole: "intelligent_cluster_operator_read_only",
    roleDisplayNames: {
      control_plane: "Plano de control",
      future_optional_external_integration: "Integración externa futura opcional",
      intelligent_cluster_operator_read_only: "Operador supervisado (sólo lectura)"
    },
    delivrixSendsRealEmail: false,
    nfcSendsRealEmail: false,
    liveInfrastructureWritesEnabled: false,
    nfcProductionWritesEnabled: false,
    allowedActions,
    blockedActions,
    gates: [...northGates],
    gateDetails: northGates.map((gate) => gateDisplay[gate])
  };
}

export function evaluateOperatingActionGate(
  input: OperatingActionGateInput
): OperatingActionGateDecision {
  if (input.action === "ingest_manual_collector_snapshot") {
    if (input.mode === "supervised" && input.humanApproved) {
      return {
        allowed: true,
        requiresHumanApproval: true,
        reason: "Manual collector snapshot ingestion is allowed only as a supervised operator action with audit and redaction.",
        blockedBy: [],
        riskLevel: "medium"
      };
    }

    return {
      allowed: false,
      requiresHumanApproval: true,
      reason: "Manual collector snapshot ingestion requires supervised mode and explicit human approval.",
      blockedBy: ["human_approval_required", "manual_snapshot_ingestion_gate"],
      riskLevel: "medium"
    };
  }

  if (allowedActions.includes(input.action) && (input.mode === "read_only" || input.mode === "dry_run")) {
    return {
      allowed: true,
      requiresHumanApproval: false,
      reason: "Action is inside the Delivrix control-plane boundary for Hito 5.9.",
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
      reason: "Action is outside Hito 5.9. Delivrix may not perform real sending, live infrastructure mutation, or NFC production writes yet.",
      blockedBy: ["north_operating_boundary", "phase_5_9_gate"],
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

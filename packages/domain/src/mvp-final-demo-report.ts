import type { AdminOverview } from "./admin-overview.ts";
import type { AuditEvent } from "./audit-log.ts";
import { createId } from "./ids.ts";
import type { OperatingNorthSnapshot } from "./operating-north.ts";
import type { OperationalSummary } from "./operational-summary.ts";

export type MvpFinalDemoDecisionStatus = "ready_for_sponsor" | "needs_review" | "blocked";
export type MvpFinalDemoEvidenceStatus = "proven" | "needs_review" | "missing" | "blocked";
export type MvpFinalDemoRiskSeverity = "low" | "medium" | "high" | "critical";

export interface MvpFinalDemoReportInput {
  id?: string;
  actorId?: string;
  auditEvents: AuditEvent[];
  operationalSummary: OperationalSummary;
  adminOverview: AdminOverview;
  operatingNorth: OperatingNorthSnapshot;
}

export interface MvpFinalDemoMilestoneEvidence {
  milestone: "5.0" | "5.1" | "5.2";
  title: string;
  status: MvpFinalDemoEvidenceStatus;
  artifactId: string | null;
  auditAction: string;
  auditEventId: string | null;
  occurredAt: string | null;
  evidence: string;
}

export interface MvpFinalDemoResidualRisk {
  code: string;
  severity: MvpFinalDemoRiskSeverity;
  description: string;
  mitigation: string;
  requiredBeforeLimitedProduction: boolean;
}

export interface MvpFinalDemoLimitedProductionGate {
  order: number;
  gate: string;
  owner: "operator" | "openclaw" | "system";
  status: "ready" | "needs_review" | "blocked";
  evidence: string;
}

export interface MvpFinalDemoDecision {
  status: MvpFinalDemoDecisionStatus;
  canPresentToSponsor: boolean;
  canStartLimitedProduction: false;
  canSendRealEmail: false;
  canMutateLiveInfrastructure: false;
  reason: string;
  blockers: string[];
  warnings: string[];
  nextRecommendedMilestone: "phase_6_limited_production_readiness" | "review_phase_5_evidence" | "remain_in_phase_5";
}

export interface MvpFinalDemoReport {
  id: string;
  createdAt: string;
  phase: "5.3-final-demo-report";
  actorId: string;
  dryRun: true;
  sideEffects: "none";
  title: "Delivrix MVP Final Demo Report";
  executiveSummary: {
    oneLiner: string;
    demonstratedOutcome: string;
    capacityClaim: string;
    sponsorMessage: string;
  };
  evidence: MvpFinalDemoMilestoneEvidence[];
  operationalSnapshot: {
    generatedAt: string;
    adminState: AdminOverview["state"];
    totals: OperationalSummary["totals"];
    senderNodesByStatus: OperationalSummary["senderNodesByStatus"];
    sendResultsByStatus: OperationalSummary["sendResultsByStatus"];
    criticalAlerts: number;
    warningAlerts: number;
  };
  residualRisks: MvpFinalDemoResidualRisk[];
  limitedProductionGates: MvpFinalDemoLimitedProductionGate[];
  decision: MvpFinalDemoDecision;
  safety: {
    liveEmailSendingEnabled: false;
    liveInfrastructureWritesEnabled: false;
    liveDnsChangesEnabled: false;
    sshEnabled: false;
    nfcProductionWritesEnabled: false;
    volumePromiseEnabled: false;
    localStateOnlyEvidence: true;
  };
}

export function buildMvpFinalDemoReport(
  input: MvpFinalDemoReportInput,
  now = new Date()
): MvpFinalDemoReport {
  const evidence = buildEvidence(input.auditEvents);
  const residualRisks = buildResidualRisks(input.adminOverview, input.operationalSummary);
  const limitedProductionGates = buildLimitedProductionGates(input, evidence);
  const decision = buildDecision(evidence, limitedProductionGates, input.operatingNorth);

  return {
    id: input.id ?? createId("mvp_final_demo_report"),
    createdAt: now.toISOString(),
    phase: "5.3-final-demo-report",
    actorId: input.actorId?.trim() || "operator_local",
    dryRun: true,
    sideEffects: "none",
    title: "Delivrix MVP Final Demo Report",
    executiveSummary: {
      oneLiner: "Delivrix demuestra un control plane inteligente para preparar y gobernar infraestructura de mailing autorizado sin envio real en el MVP.",
      demonstratedOutcome: "La demo prueba onboarding, topology/provisioning dry-run, pipeline local, auditoria, reputacion, OpenClaw, runbook, aprobacion humana y kill switch.",
      capacityClaim: "No se promete volumen. La capacidad futura queda condicionada por warming, reputacion, compliance, proveedor, IPs y aprobacion humana.",
      sponsorMessage: "El sistema esta listo para presentacion de MVP si la evidencia 5.0, 5.1 y 5.2 esta completa; produccion limitada requiere gates adicionales."
    },
    evidence,
    operationalSnapshot: {
      generatedAt: input.operationalSummary.generatedAt,
      adminState: input.adminOverview.state,
      totals: input.operationalSummary.totals,
      senderNodesByStatus: input.operationalSummary.senderNodesByStatus,
      sendResultsByStatus: input.operationalSummary.sendResultsByStatus,
      criticalAlerts: input.adminOverview.alerts.filter((alert) => alert.severity === "critical").length,
      warningAlerts: input.adminOverview.alerts.filter((alert) => alert.severity === "warning").length
    },
    residualRisks,
    limitedProductionGates,
    decision,
    safety: {
      liveEmailSendingEnabled: false,
      liveInfrastructureWritesEnabled: false,
      liveDnsChangesEnabled: false,
      sshEnabled: false,
      nfcProductionWritesEnabled: false,
      volumePromiseEnabled: false,
      localStateOnlyEvidence: true
    }
  };
}

function buildEvidence(events: AuditEvent[]): MvpFinalDemoMilestoneEvidence[] {
  return [
    evidenceItem(
      "5.0",
      "Blueprint MVP and pattern review",
      "demo.mvp_blueprint_created",
      latestByAction(events, "demo.mvp_blueprint_created"),
      "Blueprint generated with OpenClaw onboarding, topology, provisioning, scheduler, runbook, pattern review and gates."
    ),
    evidenceItem(
      "5.1",
      "Local-state demo runner",
      "demo.mvp_run.completed",
      latestByAction(events, "demo.mvp_run.completed"),
      "Local runner completed Gateway -> Policy -> Queue -> Worker -> Sender Node -> Result Tracking -> Reputation -> Admin/OpenClaw."
    ),
    evidenceItem(
      "5.2",
      "OpenClaw simulated incident response",
      "demo.openclaw_incident.completed",
      latestByAction(events, "demo.openclaw_incident.completed"),
      "OpenClaw detected a simulated incident, proposed local action, proved human approval and kill switch gates, and applied local state only."
    )
  ];
}

function evidenceItem(
  milestone: MvpFinalDemoMilestoneEvidence["milestone"],
  title: string,
  auditAction: string,
  event: AuditEvent | null,
  evidence: string
): MvpFinalDemoMilestoneEvidence {
  const decisionStatus = decisionStatusFromEvent(event);
  return {
    milestone,
    title,
    status: !event ? "missing" : decisionStatus === "blocked" ? "blocked" : decisionStatus === "needs_review" ? "needs_review" : "proven",
    artifactId: event?.targetId ?? null,
    auditAction,
    auditEventId: event?.id ?? null,
    occurredAt: event?.occurredAt ?? null,
    evidence: event ? evidence : `Missing audit action ${auditAction}.`
  };
}

function latestByAction(events: AuditEvent[], action: string): AuditEvent | null {
  return events
    .filter((event) => event.action === action)
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))[0] ?? null;
}

function decisionStatusFromEvent(event: AuditEvent | null): string | null {
  const decision = event?.metadata?.decision;

  if (typeof decision !== "object" || decision === null || !("status" in decision)) {
    return null;
  }

  const status = (decision as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function buildResidualRisks(
  adminOverview: AdminOverview,
  summary: OperationalSummary
): MvpFinalDemoResidualRisk[] {
  const risks: MvpFinalDemoResidualRisk[] = [
    {
      code: "limited_production_not_enabled",
      severity: "medium",
      description: "El MVP demuestra control operativo, pero no habilita produccion limitada ni envio real.",
      mitigation: "Crear fase 6 con gates de proveedor, warming, IP reputation, rollback, secretos y aprobacion humana.",
      requiredBeforeLimitedProduction: true
    },
    {
      code: "volume_not_promised",
      severity: "medium",
      description: "La demo no prueba volumen comercial; solo capacidad gobernada y condicionada.",
      mitigation: "Validar warming real, limites por sender node, reputacion, provider approval y metricas antes de ampliar volumen.",
      requiredBeforeLimitedProduction: true
    },
    {
      code: "external_bridges_disabled",
      severity: "low",
      description: "NFC y otros bridges externos siguen apagados o mock.",
      mitigation: "Versionar contrato API futuro y mantener writes de produccion bloqueados hasta aprobacion formal.",
      requiredBeforeLimitedProduction: false
    }
  ];

  if (adminOverview.state === "critical") {
    risks.push({
      code: "operational_alerts_present",
      severity: "high",
      description: "El snapshot operativo contiene alertas criticas, posiblemente por incidentes simulados usados en la demo.",
      mitigation: "Separar datos demo de datos de preproduccion, revisar sender nodes en cuarentena y confirmar que la causa sea simulada.",
      requiredBeforeLimitedProduction: true
    });
  }

  if (summary.senderNodesByStatus.quarantined > 0 || summary.senderNodesByStatus.degraded > 0) {
    risks.push({
      code: "sender_nodes_need_review",
      severity: "high",
      description: "Existen sender nodes degradados o en cuarentena dentro del estado local.",
      mitigation: "Mantenerlos fuera de capacidad disponible hasta revision humana y evidencia de reputacion saludable.",
      requiredBeforeLimitedProduction: true
    });
  }

  return risks;
}

function buildLimitedProductionGates(
  input: MvpFinalDemoReportInput,
  evidence: MvpFinalDemoMilestoneEvidence[]
): MvpFinalDemoLimitedProductionGate[] {
  const allEvidenceProven = evidence.every((item) => item.status === "proven");

  return [
    gate(1, "Phase 5 evidence complete", "system", allEvidenceProven ? "ready" : "needs_review", allEvidenceProven ? "5.0, 5.1 and 5.2 audit evidence is present." : "One or more Phase 5 audit actions are missing or not proven."),
    gate(2, "No real email in MVP", "system", input.operatingNorth.delivrixSendsRealEmail ? "blocked" : "ready", "Operating north keeps Delivrix real email sending disabled."),
    gate(3, "No live infrastructure mutation", "system", input.operatingNorth.liveInfrastructureWritesEnabled ? "blocked" : "ready", "Operating north keeps live infrastructure writes disabled."),
    gate(4, "NFC production writes disabled", "system", input.operatingNorth.nfcProductionWritesEnabled ? "blocked" : "ready", "NFC remains future optional and disabled/mock in MVP."),
    gate(5, "Human approval for supervised action", "operator", "needs_review", "Production-limited operations require a fresh approval workflow, not demo approval."),
    gate(6, "Warming and reputation review", "openclaw", "needs_review", "Any future volume must be conditional on warming, bounces, complaints, blacklist signals and provider approval.")
  ];
}

function gate(
  order: number,
  gateName: string,
  owner: MvpFinalDemoLimitedProductionGate["owner"],
  status: MvpFinalDemoLimitedProductionGate["status"],
  evidence: string
): MvpFinalDemoLimitedProductionGate {
  return {
    order,
    gate: gateName,
    owner,
    status,
    evidence
  };
}

function buildDecision(
  evidence: MvpFinalDemoMilestoneEvidence[],
  gates: MvpFinalDemoLimitedProductionGate[],
  operatingNorth: OperatingNorthSnapshot
): MvpFinalDemoDecision {
  const blockers = [
    evidence.some((item) => item.status === "blocked") ? "phase_5_evidence_blocked" : null,
    gates.some((gateItem) => gateItem.status === "blocked") ? "limited_production_gate_blocked" : null,
    operatingNorth.delivrixSendsRealEmail ? "real_email_enabled_in_mvp" : null,
    operatingNorth.liveInfrastructureWritesEnabled ? "live_infrastructure_enabled_in_mvp" : null,
    operatingNorth.nfcProductionWritesEnabled ? "nfc_production_writes_enabled" : null
  ].filter((item): item is string => item !== null);
  const warnings = [
    evidence.some((item) => item.status === "missing") ? "phase_5_evidence_missing" : null,
    evidence.some((item) => item.status === "needs_review") ? "phase_5_evidence_needs_review" : null,
    gates.some((gateItem) => gateItem.status === "needs_review") ? "limited_production_gates_need_review" : null
  ].filter((item): item is string => item !== null);

  if (blockers.length > 0) {
    return {
      status: "blocked",
      canPresentToSponsor: false,
      canStartLimitedProduction: false,
      canSendRealEmail: false,
      canMutateLiveInfrastructure: false,
      reason: "Final demo report is blocked because a non-negotiable safety or evidence gate failed.",
      blockers,
      warnings,
      nextRecommendedMilestone: "remain_in_phase_5"
    };
  }

  if (warnings.includes("phase_5_evidence_missing") || warnings.includes("phase_5_evidence_needs_review")) {
    return {
      status: "needs_review",
      canPresentToSponsor: true,
      canStartLimitedProduction: false,
      canSendRealEmail: false,
      canMutateLiveInfrastructure: false,
      reason: "Final report can be reviewed, but some Phase 5 evidence still needs confirmation.",
      blockers,
      warnings,
      nextRecommendedMilestone: "review_phase_5_evidence"
    };
  }

  return {
    status: "ready_for_sponsor",
    canPresentToSponsor: true,
    canStartLimitedProduction: false,
    canSendRealEmail: false,
    canMutateLiveInfrastructure: false,
    reason: "Phase 5 evidence is complete for sponsor demo. Limited production remains gated and not enabled.",
    blockers,
    warnings,
    nextRecommendedMilestone: "phase_6_limited_production_readiness"
  };
}

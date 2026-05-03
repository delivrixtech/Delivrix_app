import type { AuditEvent } from "./audit-log.ts";
import type { SenderNodeProvisioningRun } from "./sender-node-provisioning.ts";
import type { SendResult } from "./types.ts";

export type OpenClawLearningStageStatus = "ready" | "needs_evidence" | "blocked";

export interface OpenClawLearningDataSource {
  id: string;
  label: string;
  status: OpenClawLearningStageStatus;
  evidenceCount: number;
  purpose: string;
  allowedFields: string[];
  excludedFields: string[];
}

export interface OpenClawLearningStage {
  id: string;
  order: number;
  title: string;
  goal: string;
  evidence: string[];
  exitGate: string;
  status: OpenClawLearningStageStatus;
}

export interface OpenClawLearningEvaluationGate {
  id: string;
  label: string;
  required: true;
  status: OpenClawLearningStageStatus;
  reason: string;
}

export interface OpenClawLearningPlan {
  generatedAt: string;
  phase: "5.4C-openclaw-learning-loop";
  mode: "supervised_evaluation_only";
  title: "Aprendizaje supervisado de OpenClaw";
  summary: string;
  principle: string;
  dataSources: OpenClawLearningDataSource[];
  stages: OpenClawLearningStage[];
  evaluationGates: OpenClawLearningEvaluationGate[];
  promotionPolicy: {
    canSelfPromote: false;
    requiresHumanApproval: true;
    minimumEvidence: string[];
  };
  safety: {
    externalTrainingCallsEnabled: false;
    secretsAllowedInLearningData: false;
    productionPiiAllowedInLearningData: false;
    autonomousLiveActionsEnabled: false;
    nfcProductionWritesEnabled: false;
  };
}

export interface OpenClawLearningPlanInput {
  auditEvents: AuditEvent[];
  provisioningRuns: SenderNodeProvisioningRun[];
  sendResults: SendResult[];
  now?: Date;
}

export function buildOpenClawLearningPlan(input: OpenClawLearningPlanInput): OpenClawLearningPlan {
  const dataSources = buildDataSources(input);
  const hasAuditEvidence = input.auditEvents.length > 0;
  const hasProvisioningEvidence = input.provisioningRuns.length > 0;
  const hasDeliveryEvidence = input.sendResults.length > 0;

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    phase: "5.4C-openclaw-learning-loop",
    mode: "supervised_evaluation_only",
    title: "Aprendizaje supervisado de OpenClaw",
    summary: "OpenClaw aprende por evidencia curada, evaluaciones y feedback humano; no se auto-entrena ni ejecuta live actions en el MVP.",
    principle: "Primero observar, luego proponer, despues evaluar, y solo promover con aprobacion humana documentada.",
    dataSources,
    stages: [
      stage(
        "observe",
        1,
        "Observar evidencia operacional",
        "Consolidar eventos, dry-runs y resultados simulados sin tocar infraestructura real.",
        evidenceLabels(dataSources),
        "evidencia_minima_disponible",
        hasAuditEvidence || hasProvisioningEvidence || hasDeliveryEvidence ? "ready" : "needs_evidence"
      ),
      stage(
        "label",
        2,
        "Etiquetar decisiones",
        "Convertir acciones humanas y decisiones de runbook en ejemplos auditables.",
        [
          "actor",
          "accion",
          "riesgo",
          "decision",
          "resultado"
        ],
        "dataset_curado_sin_secretos",
        hasAuditEvidence ? "ready" : "needs_evidence"
      ),
      stage(
        "propose",
        3,
        "Proponer siguiente accion",
        "Permitir que OpenClaw recomiende topologia, warming, cuarentena o revision.",
        [
          "topologia dry-run",
          "provisioning dry-run",
          "health por nodo",
          "kill switch"
        ],
        "propuesta_sin_mutacion_live",
        hasProvisioningEvidence ? "ready" : "needs_evidence"
      ),
      stage(
        "evaluate",
        4,
        "Evaluar regresiones",
        "Probar que una propuesta no rompe gates de seguridad, compliance o operacion.",
        [
          "casos go/no-go",
          "incidentes simulados",
          "bloqueos esperados",
          "aprobaciones requeridas"
        ],
        "evals_aprobadas_por_humano",
        hasAuditEvidence && hasProvisioningEvidence ? "ready" : "needs_evidence"
      ),
      stage(
        "promote",
        5,
        "Promover capacidad",
        "Subir una capacidad de read-only a supervised solo con evidencia y aprobacion.",
        [
          "pruebas verdes",
          "documentacion actualizada",
          "rollback definido",
          "aprobacion del operador"
        ],
        "decision_humana_documentada",
        "blocked"
      )
    ],
    evaluationGates: buildEvaluationGates(hasAuditEvidence, hasProvisioningEvidence, hasDeliveryEvidence),
    promotionPolicy: {
      canSelfPromote: false,
      requiresHumanApproval: true,
      minimumEvidence: [
        "auditoria append-only de decisiones",
        "dry-runs reproducibles",
        "evals con casos no-go",
        "revision humana antes de cualquier live action"
      ]
    },
    safety: {
      externalTrainingCallsEnabled: false,
      secretsAllowedInLearningData: false,
      productionPiiAllowedInLearningData: false,
      autonomousLiveActionsEnabled: false,
      nfcProductionWritesEnabled: false
    }
  };
}

function buildDataSources(input: OpenClawLearningPlanInput): OpenClawLearningDataSource[] {
  return [
    {
      id: "audit_events",
      label: "Audit events",
      status: input.auditEvents.length > 0 ? "ready" : "needs_evidence",
      evidenceCount: input.auditEvents.length,
      purpose: "Explicar quien decidio, que propuso y que riesgo tuvo cada accion.",
      allowedFields: ["actorType", "actorId", "action", "targetType", "riskLevel", "metadata decision"],
      excludedFields: ["secrets", "tokens", "private keys", "raw recipient content"]
    },
    {
      id: "provisioning_dry_runs",
      label: "Provisioning dry-runs",
      status: input.provisioningRuns.length > 0 ? "ready" : "needs_evidence",
      evidenceCount: input.provisioningRuns.length,
      purpose: "Aprender patrones de preparacion VPS/LXC sin ejecutar Proxmox live.",
      allowedFields: ["planId", "senderNodeId", "steps", "blockedOperations", "summary"],
      excludedFields: ["ssh private keys", "provider credentials", "live API tokens"]
    },
    {
      id: "send_result_signals",
      label: "Signals de reputacion simulados",
      status: input.sendResults.length > 0 ? "ready" : "needs_evidence",
      evidenceCount: input.sendResults.length,
      purpose: "Relacionar warming, bounces, complaints y deferred con recomendaciones operativas.",
      allowedFields: ["status", "senderNodeId", "bounceCode", "complaintSource", "occurredAt"],
      excludedFields: ["recipient email raw", "message body", "PII no necesaria"]
    }
  ];
}

function buildEvaluationGates(
  hasAuditEvidence: boolean,
  hasProvisioningEvidence: boolean,
  hasDeliveryEvidence: boolean
): OpenClawLearningEvaluationGate[] {
  return [
    gate(
      "no_secret_leakage",
      "Dataset sin secretos ni llaves privadas",
      "ready",
      "El contrato excluye credenciales, tokens y llaves."
    ),
    gate(
      "auditability",
      "Cada recomendacion debe trazarse a evidencia",
      hasAuditEvidence ? "ready" : "needs_evidence",
      hasAuditEvidence ? "Existe auditoria para explicar decisiones." : "Faltan eventos auditables."
    ),
    gate(
      "dry_run_reproducibility",
      "Las propuestas deben reproducirse en dry-run",
      hasProvisioningEvidence ? "ready" : "needs_evidence",
      hasProvisioningEvidence ? "Existen dry-runs para comparar." : "Faltan dry-runs de provisioning."
    ),
    gate(
      "reputation_feedback",
      "El warming debe aprender de resultados",
      hasDeliveryEvidence ? "ready" : "needs_evidence",
      hasDeliveryEvidence ? "Existen signals de resultado." : "Faltan results simulados o historicos permitidos."
    ),
    gate(
      "human_promotion",
      "Ninguna capacidad se promueve sola",
      "blocked",
      "La promocion a acciones supervisadas queda bloqueada en MVP."
    )
  ];
}

function stage(
  id: string,
  order: number,
  title: string,
  goal: string,
  evidence: string[],
  exitGate: string,
  status: OpenClawLearningStageStatus
): OpenClawLearningStage {
  return {
    id,
    order,
    title,
    goal,
    evidence,
    exitGate,
    status
  };
}

function gate(
  id: string,
  label: string,
  status: OpenClawLearningStageStatus,
  reason: string
): OpenClawLearningEvaluationGate {
  return {
    id,
    label,
    required: true,
    status,
    reason
  };
}

function evidenceLabels(dataSources: OpenClawLearningDataSource[]): string[] {
  return dataSources.map((source) => `${source.label}: ${source.evidenceCount}`);
}

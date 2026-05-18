import {
  buildContractBase,
  type ControlPlaneContractBase,
  type ControlPlaneReadinessStatus,
  type ControlPlaneRiskLevel,
  mockSource,
  qualityFromUnknownFields
} from "./control-plane-contract.ts";
import type { DevOpsCollectorStatus } from "./devops-collector-status.ts";
import type { HardwareTelemetrySnapshot } from "./hardware-telemetry.ts";
import type { PhysicalHostSnapshot } from "./hardware-inventory.ts";
import type { OpenClawReadinessSignals } from "./openclaw-readiness-signals.ts";
import type {
  OpenClawOnboardingState,
  OpenClawProvisioningState
} from "./openclaw-state-contracts.ts";

export type OpenClawCanvasNodeStatus =
  | "unknown"
  | "not_started"
  | "collecting"
  | "ready"
  | "needs_review"
  | "blocked"
  | "requires_approval"
  | "disabled_by_mvp"
  | "error";

export type OpenClawCanvasNodeKind =
  | "hardware"
  | "telemetry"
  | "virtualization"
  | "planning"
  | "sender_node"
  | "dns"
  | "warming"
  | "reputation"
  | "capacity"
  | "onboarding";

/**
 * H.23 — Swimlanes Pencil literal. 5 carriles operacionales con colores
 * canónicos del .pen (NO inventar fuera de este set):
 *   onboarding     #15803D
 *   hardware       #1D4ED8
 *   provisioning   #EA580C
 *   warming        #B45309
 *   reputation     #57534E
 */
export type OpenClawCanvasLane =
  | "onboarding"
  | "hardware"
  | "provisioning"
  | "warming"
  | "reputation";

export interface OpenClawCanvasDrilldown {
  endpoint: string;
  label: string;
}

export interface OpenClawCanvasMetric {
  id: string;
  label: string;
  value: number | string | null;
  unit: string | null;
  quality: "observed" | "unknown" | "stale" | "mock";
}

export interface OpenClawCanvasNode {
  id: string;
  kind: OpenClawCanvasNodeKind;
  /** H.23: en qué carril del swimlane se dibuja. */
  lane: OpenClawCanvasLane;
  label: string;
  status: OpenClawCanvasNodeStatus;
  progressPercent: number;
  riskLevel: ControlPlaneRiskLevel;
  summary: string;
  metrics: OpenClawCanvasMetric[];
  badges: string[];
  drilldown: OpenClawCanvasDrilldown;
}

export interface OpenClawCanvasEdge {
  id: string;
  from: string;
  to: string;
  status: OpenClawCanvasNodeStatus;
  label: string;
}

export interface OpenClawCanvasTimelineEvent {
  id: string;
  occurredAt: string;
  actor: "openclaw" | "operator" | "system" | "collector";
  action: string;
  status: OpenClawCanvasNodeStatus;
  evidenceRefs: string[];
}

export type OpenClawCanvasBlockerCategory = "hardware" | "openclaw" | "network" | "provider" | "other";
export type OpenClawCanvasBlockerSeverity = "warning" | "critical";

export interface OpenClawCanvasBlocker {
  code: string;
  label: string;
  category: OpenClawCanvasBlockerCategory;
  severity: OpenClawCanvasBlockerSeverity;
}

/**
 * H.23 — Selector de clúster del Pencil toolbar. El operador escoge sobre qué
 * clúster ver el canvas. Los IDs son canónicos del MVP (svc-warmup-01 es el
 * cluster A de pruebas supervisadas).
 */
export interface OpenClawCanvasClusterOption {
  id: string;
  label: string;
}

export interface OpenClawCanvasClusterState {
  activeId: string;
  options: OpenClawCanvasClusterOption[];
}

export type OpenClawCanvasTimeRangeId = "1h" | "24h" | "7d";

export interface OpenClawCanvasTimeRangeState {
  active: OpenClawCanvasTimeRangeId;
  options: OpenClawCanvasTimeRangeId[];
}

export interface OpenClawCanvasScaleState {
  zoomPercent: number;
}

export interface OpenClawCanvasLastActivity {
  actor: string;
  occurredAt: string;
  auditHash: string;
}

/**
 * H.23 — Card de propuesta de OpenClaw debajo del canvas. El bundle es
 * GET-only; el `primaryAction` y `secondaryAction` solo describen el call to
 * action que el operador ejecuta FUERA del panel. `runbookRef` apunta al .md
 * con los pasos firmados. No hay POST detrás.
 */
export interface OpenClawCanvasPromptAction {
  label: string;
  runbookRef?: string;
  kind: "open_runbook" | "snooze" | "ack" | "view_evidence";
}

export interface OpenClawCanvasPromptCard {
  /** Nodo en el que se ancla visualmente la propuesta (border gradient + shadow). */
  nodeId: string;
  headline: string;
  body: string;
  primaryAction: OpenClawCanvasPromptAction;
  secondaryAction: OpenClawCanvasPromptAction;
  /** Hashes de evidencia que justifican esta propuesta (ver Detail panel sec3). */
  evidenceRefs: string[];
}

export interface OpenClawLiveCanvasSnapshot extends ControlPlaneContractBase {
  currentStepId: string;
  nodes: OpenClawCanvasNode[];
  edges: OpenClawCanvasEdge[];
  timeline: OpenClawCanvasTimelineEvent[];
  blockedBy: OpenClawCanvasBlocker[];
  requiresHumanApproval: string[];
  /** H.23 — orden literal de carriles del Pencil. */
  lanes: OpenClawCanvasLane[];
  cluster: OpenClawCanvasClusterState;
  timeRange: OpenClawCanvasTimeRangeState;
  scale: OpenClawCanvasScaleState;
  lastActivity: OpenClawCanvasLastActivity;
  /** Nodo enfocado en el Detail panel; null si nada está seleccionado. */
  selectedNodeId: string | null;
  /** Propuesta visible de OpenClaw o null si no hay nada pendiente. */
  prompt: OpenClawCanvasPromptCard | null;
}

export interface BuildOpenClawLiveCanvasInput {
  physicalHost?: PhysicalHostSnapshot;
  telemetry?: HardwareTelemetrySnapshot;
  onboardingState?: OpenClawOnboardingState;
  provisioningState?: OpenClawProvisioningState;
  readinessSignals?: OpenClawReadinessSignals;
  collector?: DevOpsCollectorStatus;
  now?: Date;
}

const approvalGates = [
  "operator_approval_before_live_infrastructure",
  "ssh_access_approval",
  "dns_change_approval",
  "smtp_activation_approval",
  "volume_increase_approval"
];

export function buildOpenClawLiveCanvas(
  input: BuildOpenClawLiveCanvasInput = {}
): OpenClawLiveCanvasSnapshot {
  const now = input.now ?? new Date();
  const blockedBy = collectBlockers(input);
  const requiresHumanApproval = collectHumanApprovals(input.provisioningState);
  const nodes = buildNodes(input, blockedBy);
  const edges = buildEdges(nodes);
  const unknownFields = collectUnknownFields(input);
  const prompt = buildPromptCard(nodes, blockedBy);
  const currentStepId = resolveCurrentStepId(nodes);

  return {
    ...buildContractBase(now, mockSource(), qualityFromUnknownFields(unknownFields, unknownFields.length === 0 ? 0.6 : 0)),
    currentStepId,
    nodes,
    edges,
    timeline: buildTimeline(now, input, blockedBy),
    blockedBy,
    requiresHumanApproval,
    lanes: ["onboarding", "hardware", "provisioning", "warming", "reputation"],
    cluster: buildClusterState(),
    timeRange: { active: "24h", options: ["1h", "24h", "7d"] },
    scale: { zoomPercent: 100 },
    lastActivity: buildLastActivity(now),
    selectedNodeId: prompt?.nodeId ?? currentStepId,
    prompt
  };
}

function buildClusterState(): OpenClawCanvasClusterState {
  return {
    activeId: "svc-warmup-01",
    options: [
      { id: "svc-warmup-01", label: "svc-warmup-01" },
      { id: "svc-warmup-02", label: "svc-warmup-02" },
      { id: "svc-prod-eu-01", label: "svc-prod-eu-01" }
    ]
  };
}

function buildLastActivity(now: Date): OpenClawCanvasLastActivity {
  return {
    actor: "operador@delivrix",
    occurredAt: new Date(now.getTime() - 14_000).toISOString(),
    auditHash: "sha256:4f1a-canvas"
  };
}

/**
 * H.23 — Construye la card de propuesta. Solo aparece cuando hay al menos un
 * nodo que requiere revisión humana o aprobación. El bundle frontend es
 * GET-only: las acciones describen el camino para aprobar afuera, nunca
 * mutan estado desde el panel.
 */
function buildPromptCard(
  nodes: OpenClawCanvasNode[],
  blockedBy: OpenClawCanvasBlocker[]
): OpenClawCanvasPromptCard | null {
  // Priorizar el primer nodo que necesita revisión humana en el orden
  // canónico de lanes (warming antes que reputation, etc).
  const candidate =
    nodes.find((node) => node.status === "needs_review" || node.status === "requires_approval") ??
    nodes.find((node) => node.status === "blocked");
  if (!candidate) return null;

  const evidenceRefs = blockedBy
    .slice(0, 3)
    .map((b) => `evidence:${b.code}`);

  return {
    nodeId: candidate.id,
    headline: `${candidate.label}: revisión humana pendiente`,
    body: `${candidate.summary} Revisa la evidencia y los gates antes de continuar.`,
    primaryAction: {
      kind: "open_runbook",
      label: "Revisar plan dry-run",
      runbookRef: runbookForLane(candidate.lane)
    },
    secondaryAction: {
      kind: "snooze",
      label: "Posponer"
    },
    evidenceRefs
  };
}

function runbookForLane(lane: OpenClawCanvasLane): string {
  if (lane === "onboarding") return "openclaw-onboarding-runbook.md";
  if (lane === "hardware") return "hardware-readiness-runbook.md";
  if (lane === "provisioning") return "provisioning-dry-run-runbook.md";
  if (lane === "warming") return "warming-plan-runbook.md";
  return "reputation-gates-runbook.md";
}

function buildNodes(input: BuildOpenClawLiveCanvasInput, blockedBy: OpenClawCanvasBlocker[]): OpenClawCanvasNode[] {
  const physicalHostStatus = mapReadinessStatus(input.physicalHost?.readiness.status ?? "unknown");
  const telemetryStatus = mapTelemetryStatus(input.telemetry);
  const onboardingStatus = mapOnboardingStatus(input.onboardingState);
  const provisioningStatus = mapProvisioningStatus(input.provisioningState);
  const readinessStatus = mapReadinessStatus(input.readinessSignals?.scores.provisioningReadiness.status ?? "needs_review");
  const collectorStatus = input.collector?.status === "ready" ? "ready" : input.collector?.status === "degraded" ? "needs_review" : "unknown";
  const captureStatus = onboardingStatus === "ready" ? "ready" : onboardingStatus === "blocked" ? "blocked" : "needs_review";
  const validateStatus = onboardingStatus === "ready" ? "ready" : "needs_review";

  return [
    /* ===== onboarding lane (2 nodos: Captura + Validaciones) ===== */
    {
      id: "onboarding_capture",
      kind: "onboarding",
      lane: "onboarding",
      label: "Captura",
      status: captureStatus,
      progressPercent: progressFor(captureStatus),
      riskLevel: captureStatus === "blocked" ? "high" : "low",
      summary: input.onboardingState
        ? `Operador capturó ${Object.keys(input.onboardingState.knownInputs).length} insumos del onboarding.`
        : "Esperando captura inicial del operador.",
      metrics: [
        metric(
          "pending_questions",
          "Preguntas pendientes",
          input.onboardingState?.pendingQuestions.length ?? null,
          "count"
        )
      ],
      badges: ["operator_input", "supervised"],
      drilldown: {
        endpoint: "/v1/openclaw/onboarding/state",
        label: "Ver onboarding"
      }
    },
    {
      id: "onboarding_validate",
      kind: "onboarding",
      lane: "onboarding",
      label: "Validaciones",
      status: validateStatus,
      progressPercent: progressFor(validateStatus),
      riskLevel: validateStatus === "needs_review" ? "medium" : "low",
      summary: input.onboardingState?.canGenerateTopologyPlan
        ? "Validaciones completas. OpenClaw puede sugerir topología."
        : "OpenClaw valida coherencia de datos del onboarding antes de proponer plan.",
      metrics: [
        metric("warnings", "Avisos", input.onboardingState?.warnings.length ?? null, "count")
      ],
      badges: ["human_gate"],
      drilldown: {
        endpoint: "/v1/openclaw/onboarding/state",
        label: "Ver validaciones"
      }
    },
    /* ===== hardware lane (2 nodos: Telemetría + Inventario) ===== */
    {
      id: "physical_host",
      kind: "hardware",
      lane: "hardware",
      label: "Inventario del servidor",
      status: physicalHostStatus,
      progressPercent: progressFor(physicalHostStatus),
      riskLevel: physicalHostStatus === "blocked" ? "high" : "unknown",
      summary: input.physicalHost
        ? `Base ${input.physicalHost.identity.vendor} en ${input.physicalHost.identity.location}.`
        : "Esperando inventario seguro del servidor fisico.",
      metrics: [
        metric("cpu_cores", "CPU cores", input.physicalHost?.capacity.cpuCores ?? null, "cores"),
        metric("memory_gb", "RAM", input.physicalHost?.capacity.memoryGb ?? null, "GB"),
        metric("storage_gb", "Storage usable", input.physicalHost?.capacity.storageUsableGb ?? null, "GB")
      ],
      badges: ["read_only", input.physicalHost?.source.kind ?? "mock"],
      drilldown: {
        endpoint: "/v1/hardware/physical-host",
        label: "Ver hardware"
      }
    },
    {
      id: "hardware_telemetry",
      kind: "telemetry",
      lane: "hardware",
      label: "Hardware telemetry",
      status: telemetryStatus,
      progressPercent: progressFor(telemetryStatus),
      riskLevel: input.telemetry?.summary.riskLevel ?? "unknown",
      summary: input.telemetry?.summary.stale
        ? "La telemetria esta stale o aun no existe collector real."
        : "Telemetry read-only disponible para evaluacion.",
      metrics: [
        metric("cpu_usage", "CPU usage", input.telemetry?.cpu.usagePercent ?? null, "%"),
        metric("cpu_temp", "CPU temp", input.telemetry?.cpu.temperatureCelsius ?? null, "C"),
        metric("power_watts", "Power", input.telemetry?.power.watts ?? null, "W")
      ],
      badges: ["read_only", input.telemetry?.source.freshness ?? "unknown"],
      drilldown: {
        endpoint: "/v1/hardware/telemetry/latest",
        label: "Ver telemetria"
      }
    },
    {
      id: "devops_collector",
      kind: "telemetry",
      lane: "hardware",
      label: "DevOps collector",
      status: collectorStatus,
      progressPercent: progressFor(collectorStatus),
      riskLevel: collectorStatus === "ready" ? "low" : "unknown",
      summary: input.collector
        ? `Collector en modo ${input.collector.collectorMode}.`
        : "Collector real pendiente; MVP usa mock read-only.",
      metrics: [
        metric("sources", "Fuentes", input.collector?.sources.length ?? 0, "count"),
        metric("unknown_capabilities", "Campos unknown", input.collector?.unknownCapabilities.length ?? null, "count")
      ],
      badges: ["no_ssh", "read_only"],
      drilldown: {
        endpoint: "/v1/devops/collector/status",
        label: "Ver collector"
      }
    },
    /* ===== provisioning lane (4 nodos: Proxmox + Cluster + VPS + DNS) ===== */
    {
      id: "proxmox_host",
      kind: "virtualization",
      lane: "provisioning",
      label: "Proxmox host",
      status: onboardingStatus,
      progressPercent: progressFor(onboardingStatus),
      riskLevel: hasBlocker(blockedBy, "missing_or_unknown_proxmox_status") ? "high" : "unknown",
      summary: "Proxmox se valida por onboarding antes de cualquier accion real.",
      metrics: [
        metric("proxmox_readiness", "Readiness", input.onboardingState?.readinessByCategory.infrastructure ?? null, "%")
      ],
      badges: ["live_apply_disabled", "dry_run_first"],
      drilldown: {
        endpoint: "/v1/openclaw/onboarding/state",
        label: "Ver onboarding"
      }
    },
    {
      id: "cluster_plan",
      kind: "planning",
      lane: "provisioning",
      label: "Cluster plan",
      status: readinessStatus,
      progressPercent: progressFor(readinessStatus),
      riskLevel: readinessStatus === "blocked" ? "high" : "medium",
      summary: "OpenClaw convierte capacidad y limites en topologia solo con datos suficientes.",
      metrics: [
        metric("hardware_capacity_score", "Hardware score", input.readinessSignals?.scores.hardwareCapacity.score ?? null, "score"),
        metric("provisioning_score", "Provisioning score", input.readinessSignals?.scores.provisioningReadiness.score ?? null, "score")
      ],
      badges: ["rules_and_evals", "human_gate"],
      drilldown: {
        endpoint: "/v1/openclaw/readiness-signals",
        label: "Ver senales"
      }
    },
    {
      id: "vps_lxc_plan",
      kind: "planning",
      lane: "provisioning",
      label: "VPS/LXC plan",
      status: provisioningStatus,
      progressPercent: progressFor(provisioningStatus),
      riskLevel: provisioningStatus === "blocked" ? "high" : "medium",
      summary: "El pipeline de provisioning permanece en dry-run hasta aprobacion humana.",
      metrics: [
        metric("provisioning_steps", "Pasos", input.provisioningState?.steps.length ?? null, "count"),
        metric("required_approvals", "Aprobaciones", input.provisioningState?.requiredApprovals.length ?? approvalGates.length, "count")
      ],
      badges: ["dry_run", "no_ssh"],
      drilldown: {
        endpoint: "/v1/openclaw/provisioning/state",
        label: "Ver provisioning"
      }
    },
    {
      id: "dns_identity",
      kind: "dns",
      lane: "provisioning",
      label: "DNS / PTR / DKIM / TLS",
      status: "requires_approval",
      progressPercent: 0,
      riskLevel: "medium",
      summary: "Cambios DNS reales quedan bloqueados en MVP y requieren aprobación.",
      metrics: [],
      badges: ["dns_live_disabled", "secrets_required"],
      drilldown: {
        endpoint: "/v1/openclaw/provisioning/state",
        label: "Ver DNS plan"
      }
    },
    /* ===== warming lane (3 nodos: Sender nodes + Plan + Rampa) ===== */
    {
      id: "sender_nodes",
      kind: "sender_node",
      lane: "warming",
      label: "Sender nodes",
      status: "not_started",
      progressPercent: 0,
      riskLevel: "unknown",
      summary: "Los sender nodes se registran despues del dry-run y aprobaciones.",
      metrics: [],
      badges: ["smtp_disabled", "warming_required"],
      drilldown: {
        endpoint: "/v1/admin/clusters",
        label: "Ver clusters"
      }
    },
    {
      id: "warming_plan",
      kind: "warming",
      lane: "warming",
      label: "Plan de calentamiento",
      status: "needs_review",
      progressPercent: 50,
      riskLevel: "medium",
      summary: "OpenClaw propone elevar warming al día 10 con quejas bajo 0.18%. Necesita aprobación humana.",
      metrics: [
        metric("complaint_rate", "Quejas", 0.18, "%"),
        metric("day_target", "Día objetivo", 10, "día")
      ],
      badges: ["rate_limits", "human_gate"],
      drilldown: {
        endpoint: "/v1/admin/workflow",
        label: "Ver ruta"
      }
    },
    {
      id: "warming_ramp",
      kind: "warming",
      lane: "warming",
      label: "Rampa supervisada",
      status: "not_started",
      progressPercent: 0,
      riskLevel: "medium",
      summary: "La rampa real solo arranca tras aprobación humana del plan dry-run.",
      metrics: [],
      badges: ["dry_run", "smtp_disabled"],
      drilldown: {
        endpoint: "/v1/admin/workflow",
        label: "Ver rampa"
      }
    },
    /* ===== reputation lane (3 nodos: Gates + Escalación + Capacidad) ===== */
    {
      id: "reputation_gates",
      kind: "reputation",
      lane: "reputation",
      label: "Reputation gates",
      status: "not_started",
      progressPercent: 0,
      riskLevel: "medium",
      summary: "Bounces, complaints, blacklist y cuarentena se evaluan antes de escalar.",
      metrics: [],
      badges: ["audit_required", "kill_switch"],
      drilldown: {
        endpoint: "/v1/admin/overview",
        label: "Ver operacion"
      }
    },
    {
      id: "reputation_escalation",
      kind: "reputation",
      lane: "reputation",
      label: "Escalación supervisada",
      status: "not_started",
      progressPercent: 0,
      riskLevel: "medium",
      summary: "OpenClaw escala alertas a panel humano cuando los gates de reputación se tensionan.",
      metrics: [],
      badges: ["audit_required", "human_gate"],
      drilldown: {
        endpoint: "/v1/admin/overview",
        label: "Ver alertas"
      }
    },
    {
      id: "prepared_capacity",
      kind: "capacity",
      lane: "reputation",
      label: "Capacidad preparada",
      status: "disabled_by_mvp",
      progressPercent: 0,
      riskLevel: "unknown",
      summary: "La capacidad para sistemas externos queda apagada hasta fase autorizada.",
      metrics: [],
      badges: ["nfc_bridge_disabled", "smtp_disabled"],
      drilldown: {
        endpoint: "/v1/operating-north",
        label: "Ver norte"
      }
    }
  ];
}

function buildEdges(nodes: OpenClawCanvasNode[]): OpenClawCanvasEdge[] {
  const statusById = new Map(nodes.map((node) => [node.id, node.status]));
  const pairs: Array<[string, string, string, string]> = [
    /* onboarding lane */
    ["capture_to_validate", "onboarding_capture", "onboarding_validate", "validación humana"],
    /* hardware lane */
    ["physical_to_telemetry", "physical_host", "hardware_telemetry", "observabilidad base"],
    ["telemetry_to_collector", "hardware_telemetry", "devops_collector", "fuente y frescura"],
    /* hardware → provisioning */
    ["collector_to_proxmox", "devops_collector", "proxmox_host", "lectura segura"],
    /* provisioning lane */
    ["proxmox_to_cluster", "proxmox_host", "cluster_plan", "base para topología"],
    ["cluster_to_vps", "cluster_plan", "vps_lxc_plan", "plan de virtualización"],
    ["vps_to_dns", "vps_lxc_plan", "dns_identity", "identidad SMTP"],
    /* provisioning → warming */
    ["dns_to_sender", "dns_identity", "sender_nodes", "preparación de nodos"],
    /* warming lane */
    ["sender_to_warming", "sender_nodes", "warming_plan", "plan de calentamiento"],
    ["warming_plan_to_ramp", "warming_plan", "warming_ramp", "rampa supervisada"],
    /* warming → reputation */
    ["warming_to_reputation", "warming_ramp", "reputation_gates", "monitoreo de reputación"],
    /* reputation lane */
    ["reputation_to_escalation", "reputation_gates", "reputation_escalation", "escalación humana"],
    ["escalation_to_capacity", "reputation_escalation", "prepared_capacity", "capacidad autorizada"]
  ];

  return pairs.map(([id, from, to, label]) => ({
    id,
    from,
    to,
    status: statusById.get(to) ?? "unknown",
    label
  }));
}

function buildTimeline(
  now: Date,
  input: BuildOpenClawLiveCanvasInput,
  blockedBy: OpenClawCanvasBlocker[]
): OpenClawCanvasTimelineEvent[] {
  const occurredAt = now.toISOString();
  const timeline: OpenClawCanvasTimelineEvent[] = [
    {
      id: "event_hardware_contract_loaded",
      occurredAt,
      actor: "system",
      action: input.physicalHost ? "physical_host_contract_available" : "physical_host_contract_pending",
      status: input.physicalHost ? mapReadinessStatus(input.physicalHost.readiness.status) : "unknown",
      evidenceRefs: ["/v1/hardware/physical-host"]
    },
    {
      id: "event_telemetry_contract_loaded",
      occurredAt,
      actor: "collector",
      action: input.telemetry?.summary.stale === false ? "telemetry_fresh" : "telemetry_stale_or_mock",
      status: mapTelemetryStatus(input.telemetry),
      evidenceRefs: ["/v1/hardware/telemetry/latest", "/v1/devops/collector/status"]
    },
    {
      id: "event_openclaw_readiness_evaluated",
      occurredAt,
      actor: "openclaw",
      action: blockedBy.length > 0 ? "readiness_blocked_by_missing_evidence" : "readiness_requires_human_review",
      status: blockedBy.length > 0 ? "blocked" : "needs_review",
      evidenceRefs: ["/v1/openclaw/readiness-signals"]
    }
  ];

  return timeline;
}

function collectBlockers(input: BuildOpenClawLiveCanvasInput): OpenClawCanvasBlocker[] {
  return dedupe([
    ...(input.physicalHost?.readiness.blockers ?? ["physical_host_contract_missing"]),
    ...(input.telemetry?.summary.stale ? ["telemetry_stale"] : []),
    ...(input.telemetry ? [] : ["hardware_telemetry_missing"]),
    ...(input.onboardingState?.blockers ?? ["onboarding_state_missing"]),
    ...(input.provisioningState?.blockedActions ?? ["provisioning_state_missing"])
  ]).map(buildBlocker);
}

function collectHumanApprovals(provisioningState: OpenClawProvisioningState | undefined): string[] {
  return dedupe([
    ...approvalGates,
    ...(provisioningState?.requiredApprovals ?? [])
  ]);
}

function collectUnknownFields(input: BuildOpenClawLiveCanvasInput): string[] {
  const fields: string[] = [];

  if (!input.physicalHost || input.physicalHost.quality.unknownFields.length > 0) {
    fields.push("physicalHost");
  }

  if (!input.telemetry || input.telemetry.quality.unknownFields.length > 0) {
    fields.push("telemetry");
  }

  if (!input.onboardingState || input.onboardingState.quality.unknownFields.length > 0) {
    fields.push("onboardingState");
  }

  if (!input.provisioningState || input.provisioningState.quality.unknownFields.length > 0) {
    fields.push("provisioningState");
  }

  if (!input.readinessSignals || input.readinessSignals.quality.unknownFields.length > 0) {
    fields.push("readinessSignals");
  }

  if (!input.collector || input.collector.quality.unknownFields.length > 0) {
    fields.push("collector");
  }

  return fields;
}

function mapReadinessStatus(status: ControlPlaneReadinessStatus): OpenClawCanvasNodeStatus {
  if (status === "ready") return "ready";
  if (status === "needs_review") return "needs_review";
  if (status === "blocked") return "blocked";
  return "unknown";
}

function mapTelemetryStatus(telemetry: HardwareTelemetrySnapshot | undefined): OpenClawCanvasNodeStatus {
  if (!telemetry) {
    return "unknown";
  }

  if (telemetry.summary.status === "critical") {
    return "blocked";
  }

  if (telemetry.summary.status === "warning" || telemetry.summary.stale) {
    return "needs_review";
  }

  if (telemetry.summary.status === "healthy") {
    return "ready";
  }

  return "unknown";
}

function mapOnboardingStatus(onboardingState: OpenClawOnboardingState | undefined): OpenClawCanvasNodeStatus {
  if (!onboardingState) {
    return "unknown";
  }

  if (onboardingState.blockers.length > 0) {
    return "blocked";
  }

  if (onboardingState.canGenerateTopologyPlan) {
    return "ready";
  }

  return "needs_review";
}

function mapProvisioningStatus(provisioningState: OpenClawProvisioningState | undefined): OpenClawCanvasNodeStatus {
  if (!provisioningState) {
    return "unknown";
  }

  if (provisioningState.blockedActions.length > 0) {
    return "needs_review";
  }

  if (provisioningState.steps.some((step) => step.status === "blocked")) {
    return "blocked";
  }

  if (provisioningState.steps.every((step) => step.status === "ready")) {
    return "ready";
  }

  return "not_started";
}

function resolveCurrentStepId(nodes: OpenClawCanvasNode[]): string {
  return nodes.find((node) => node.status === "blocked" || node.status === "needs_review" || node.status === "unknown")?.id
    ?? "prepared_capacity";
}

function progressFor(status: OpenClawCanvasNodeStatus): number {
  if (status === "ready") return 100;
  if (status === "needs_review" || status === "requires_approval") return 50;
  if (status === "collecting") return 25;
  return 0;
}

function metric(
  id: string,
  label: string,
  value: number | string | null,
  unit: string | null
): OpenClawCanvasMetric {
  return {
    id,
    label,
    value,
    unit,
    quality: value === null ? "unknown" : "mock"
  };
}

function hasBlocker(blockedBy: OpenClawCanvasBlocker[], code: string): boolean {
  return blockedBy.some((blocker) => blocker.code === code);
}

function buildBlocker(code: string): OpenClawCanvasBlocker {
  return {
    code,
    label: labelForBlocker(code),
    category: categoryForBlocker(code),
    severity: severityForBlocker(code)
  };
}

function labelForBlocker(code: string): string {
  return code
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryForBlocker(code: string): OpenClawCanvasBlockerCategory {
  const normalized = code.toLowerCase();

  if (/cpu|ram|memory|storage|smart|power|fan|chassis|thermal|hardware|temperature|psu|ups|uptime|kernel|model|server|capacity|physical_host/.test(normalized)) {
    return "hardware";
  }

  if (/openclaw|readiness|learning|plan|stage|signal|evidence|onboarding|topology|provisioning|scheduler|skill|llm/.test(normalized)) {
    return "openclaw";
  }

  if (/network|ip_pool|ip_type|uplink|dns|interface|rx_mbps|tx_mbps|latency|ptr|dkim|tls|telemetry/.test(normalized)) {
    return "network";
  }

  if (/provider|isp|webdock|proxmox|ipmi|prometheus|bmc|ssh|hostinger|aws|approval|operator/.test(normalized)) {
    return "provider";
  }

  return "other";
}

function severityForBlocker(code: string): OpenClawCanvasBlockerSeverity {
  const normalized = code.toLowerCase();

  if (/stale|warning|review/.test(normalized)) {
    return "warning";
  }

  return "critical";
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

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
  | "capacity";

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

export interface OpenClawLiveCanvasSnapshot extends ControlPlaneContractBase {
  currentStepId: string;
  nodes: OpenClawCanvasNode[];
  edges: OpenClawCanvasEdge[];
  timeline: OpenClawCanvasTimelineEvent[];
  blockedBy: string[];
  requiresHumanApproval: string[];
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

  return {
    ...buildContractBase(now, mockSource(), qualityFromUnknownFields(unknownFields, unknownFields.length === 0 ? 0.6 : 0)),
    currentStepId: resolveCurrentStepId(nodes),
    nodes,
    edges,
    timeline: buildTimeline(now, input, blockedBy),
    blockedBy,
    requiresHumanApproval
  };
}

function buildNodes(input: BuildOpenClawLiveCanvasInput, blockedBy: string[]): OpenClawCanvasNode[] {
  const physicalHostStatus = mapReadinessStatus(input.physicalHost?.readiness.status ?? "unknown");
  const telemetryStatus = mapTelemetryStatus(input.telemetry);
  const onboardingStatus = mapOnboardingStatus(input.onboardingState);
  const provisioningStatus = mapProvisioningStatus(input.provisioningState);
  const readinessStatus = mapReadinessStatus(input.readinessSignals?.scores.provisioningReadiness.status ?? "needs_review");
  const collectorStatus = input.collector?.status === "ready" ? "ready" : input.collector?.status === "degraded" ? "needs_review" : "unknown";

  return [
    {
      id: "physical_host",
      kind: "hardware",
      label: "Servidor fisico",
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
    {
      id: "proxmox_host",
      kind: "virtualization",
      label: "Proxmox host",
      status: onboardingStatus,
      progressPercent: progressFor(onboardingStatus),
      riskLevel: blockedBy.includes("missing_or_unknown_proxmox_status") ? "high" : "unknown",
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
      id: "sender_nodes",
      kind: "sender_node",
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
      id: "dns_identity",
      kind: "dns",
      label: "DNS / PTR / DKIM / TLS",
      status: "requires_approval",
      progressPercent: 0,
      riskLevel: "medium",
      summary: "Cambios DNS reales quedan bloqueados en MVP y requieren aprobacion.",
      metrics: [],
      badges: ["dns_live_disabled", "secrets_required"],
      drilldown: {
        endpoint: "/v1/openclaw/provisioning/state",
        label: "Ver DNS plan"
      }
    },
    {
      id: "warming",
      kind: "warming",
      label: "Warming",
      status: "not_started",
      progressPercent: 0,
      riskLevel: "medium",
      summary: "El calentamiento depende de nodos preparados, reputacion y limites conservadores.",
      metrics: [],
      badges: ["rate_limits", "human_gate"],
      drilldown: {
        endpoint: "/v1/admin/workflow",
        label: "Ver ruta"
      }
    },
    {
      id: "reputation_gates",
      kind: "reputation",
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
      id: "prepared_capacity",
      kind: "capacity",
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
    ["physical_to_telemetry", "physical_host", "hardware_telemetry", "observabilidad base"],
    ["telemetry_to_collector", "hardware_telemetry", "devops_collector", "fuente y frescura"],
    ["collector_to_proxmox", "devops_collector", "proxmox_host", "lectura segura"],
    ["proxmox_to_cluster", "proxmox_host", "cluster_plan", "base para topologia"],
    ["cluster_to_vps", "cluster_plan", "vps_lxc_plan", "plan de virtualizacion"],
    ["vps_to_sender", "vps_lxc_plan", "sender_nodes", "preparacion de nodos"],
    ["sender_to_dns", "sender_nodes", "dns_identity", "identidad SMTP"],
    ["dns_to_warming", "dns_identity", "warming", "calentamiento gradual"],
    ["warming_to_reputation", "warming", "reputation_gates", "monitoreo de reputacion"],
    ["reputation_to_capacity", "reputation_gates", "prepared_capacity", "capacidad autorizada"]
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
  blockedBy: string[]
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

function collectBlockers(input: BuildOpenClawLiveCanvasInput): string[] {
  return dedupe([
    ...(input.physicalHost?.readiness.blockers ?? ["physical_host_contract_missing"]),
    ...(input.telemetry?.summary.stale ? ["telemetry_stale"] : []),
    ...(input.telemetry ? [] : ["hardware_telemetry_missing"]),
    ...(input.onboardingState?.blockers ?? ["onboarding_state_missing"]),
    ...(input.provisioningState?.blockedActions ?? ["provisioning_state_missing"])
  ]);
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

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

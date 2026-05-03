import type { KillSwitchState } from "./kill-switch.ts";
import type { SenderNodeHealthDecision } from "./sender-node-health.ts";
import type { SenderNodeProvisioningRun } from "./sender-node-provisioning.ts";
import type { SenderNode } from "./types.ts";

export type AdminClusterManagementState =
  | "needs_onboarding"
  | "dry_run_ready"
  | "needs_review"
  | "blocked";

export interface AdminClusterSenderNode {
  id: string;
  label: string;
  provider: SenderNode["provider"];
  status: SenderNode["status"];
  hostname?: string;
  ipAddress?: string;
  dailyLimit: number;
  warmupDay: number;
  healthSeverity: SenderNodeHealthDecision["severity"];
  recommendedStatus: SenderNodeHealthDecision["recommendedStatus"];
  healthReasons: string[];
}

export interface AdminClusterCard {
  id: string;
  label: string;
  provider: "proxmox" | "mixed" | "none";
  role: "physical_host_cluster" | "sender_node_pool";
  managementState: AdminClusterManagementState;
  managementStateReason: string;
  senderNodes: AdminClusterSenderNode[];
  provisioningRunIds: string[];
  readinessGates: string[];
}

export interface AdminClusterAction {
  id: string;
  label: string;
  owner: "openclaw" | "human_operator";
  mode: "observe" | "propose" | "approve_later";
  status: AdminClusterManagementState;
  blockedInMvp: boolean;
}

export interface AdminClusterOverview {
  generatedAt: string;
  phase: "5.4C-admin-cluster-control-contract";
  mode: "read_only";
  title: "Administracion de clusters y VPS";
  summary: string;
  managementScope: {
    currentGoal: string;
    openClawOwns: string[];
    humanOwns: string[];
    notInMvp: string[];
  };
  totals: {
    clusters: number;
    senderNodes: number;
    provisioningRuns: number;
    activeOrWarmingNodes: number;
    blockedNodes: number;
    simulatedProvisioningRuns: number;
  };
  openClawDelegation: {
    canObserve: string[];
    canPropose: string[];
    requiresHumanApproval: string[];
    blockedInMvp: string[];
  };
  clusters: AdminClusterCard[];
  nextActions: AdminClusterAction[];
  safety: {
    liveInfrastructureWritesEnabled: false;
    proxmoxApiWritesEnabled: false;
    sshWritesEnabled: false;
    smtpEnabled: false;
    nfcWritesEnabled: false;
  };
}

export interface AdminClusterOverviewInput {
  senderNodes: SenderNode[];
  health: SenderNodeHealthDecision[];
  provisioningRuns: SenderNodeProvisioningRun[];
  killSwitch?: KillSwitchState;
  now?: Date;
}

export function buildAdminClusterOverview(input: AdminClusterOverviewInput): AdminClusterOverview {
  const healthByNodeId = new Map(input.health.map((decision) => [decision.senderNodeId, decision]));
  const clusters = buildClusters(input.senderNodes, input.provisioningRuns, healthByNodeId, input.killSwitch);

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    phase: "5.4C-admin-cluster-control-contract",
    mode: "read_only",
    title: "Administracion de clusters y VPS",
    summary: "El panel observa clusters/VPS, muestra salud y prepara decisiones para OpenClaw sin ejecutar cambios reales.",
    managementScope: {
      currentGoal: "Onboarding inteligente para crear y preparar clusters/VPS desde servidor fisico propio.",
      openClawOwns: [
        "leer estado del cluster",
        "proponer topologia VPS/LXC",
        "proponer warming por sender node",
        "detectar riesgos operativos"
      ],
      humanOwns: [
        "aprobar accesos SSH",
        "aprobar cambios DNS/PTR/DKIM",
        "aprobar creacion live en Proxmox",
        "aprobar activacion SMTP real"
      ],
      notInMvp: [
        "crear VPS live desde el panel",
        "enviar email real",
        "modificar contratos o produccion NFC",
        "auto-escalar volumen sin revision humana"
      ]
    },
    totals: {
      clusters: clusters.length,
      senderNodes: input.senderNodes.length,
      provisioningRuns: input.provisioningRuns.length,
      activeOrWarmingNodes: input.senderNodes.filter((node) => node.status === "active" || node.status === "warming").length,
      blockedNodes: input.health.filter((decision) => decision.severity === "critical").length,
      simulatedProvisioningRuns: input.provisioningRuns.filter((run) => run.status === "simulated").length
    },
    openClawDelegation: {
      canObserve: [
        "inventario de sender nodes",
        "estado de provisioning dry-run",
        "health/reputacion por nodo",
        "estado de kill switch"
      ],
      canPropose: [
        "topologia de clusters",
        "capacidad inicial por VPS",
        "orden de provisioning",
        "acciones de warming y cuarentena"
      ],
      requiresHumanApproval: [
        "crear VPS/LXC reales",
        "usar SSH contra servidores",
        "aplicar cambios DNS/PTR/DKIM",
        "activar Postfix para envio real"
      ],
      blockedInMvp: [
        "proxmox-live-create",
        "ssh-connect-live",
        "dns-live-change",
        "smtp-send",
        "nfc-production-write"
      ]
    },
    clusters,
    nextActions: buildNextActions(input.senderNodes, input.health, input.provisioningRuns, input.killSwitch),
    safety: {
      liveInfrastructureWritesEnabled: false,
      proxmoxApiWritesEnabled: false,
      sshWritesEnabled: false,
      smtpEnabled: false,
      nfcWritesEnabled: false
    }
  };
}

function buildClusters(
  senderNodes: SenderNode[],
  provisioningRuns: SenderNodeProvisioningRun[],
  healthByNodeId: Map<string, SenderNodeHealthDecision>,
  killSwitch: KillSwitchState | undefined
): AdminClusterCard[] {
  if (senderNodes.length === 0) {
    return [
      {
        id: "primary-physical-server",
        label: "Servidor fisico primario",
        provider: "none",
        role: "physical_host_cluster",
        managementState: "needs_onboarding",
        managementStateReason: "No hay sender nodes registrados; OpenClaw debe completar onboarding antes de proponer VPS.",
        senderNodes: [],
        provisioningRunIds: provisioningRuns.map((run) => run.id),
        readinessGates: baseReadinessGates()
      }
    ];
  }

  const byProvider = groupSenderNodes(senderNodes);

  return [...byProvider.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, nodes]) => {
      const runIds = provisioningRuns
        .filter((run) => nodes.some((node) => node.id === run.senderNodeId || node.id === run.registeredSenderNodeId))
        .map((run) => run.id);
      const state = clusterState(nodes, healthByNodeId, killSwitch);

      return {
        id: `${provider}-sender-node-cluster`,
        label: `${providerLabel(provider)} sender cluster`,
        provider: provider === "proxmox" ? "proxmox" : "mixed",
        role: provider === "proxmox" ? "physical_host_cluster" : "sender_node_pool",
        managementState: state.status,
        managementStateReason: state.reason,
        senderNodes: nodes.map((node) => clusterSenderNode(node, healthByNodeId)),
        provisioningRunIds: runIds,
        readinessGates: baseReadinessGates()
      };
    });
}

function buildNextActions(
  senderNodes: SenderNode[],
  health: SenderNodeHealthDecision[],
  provisioningRuns: SenderNodeProvisioningRun[],
  killSwitch: KillSwitchState | undefined
): AdminClusterAction[] {
  const actions: AdminClusterAction[] = [];

  if (senderNodes.length === 0) {
    actions.push(action(
      "complete_openclaw_onboarding",
      "Completar onboarding fisico/proxmox/IP pool",
      "openclaw",
      "propose",
      "needs_onboarding",
      false
    ));
  }

  if (provisioningRuns.length === 0) {
    actions.push(action(
      "create_topology_and_dry_run",
      "Generar topologia y provisioning dry-run",
      "openclaw",
      "propose",
      "dry_run_ready",
      false
    ));
  }

  if (health.some((decision) => decision.severity === "critical")) {
    actions.push(action(
      "review_quarantine_candidates",
      "Revisar nodos con recomendacion critica",
      "human_operator",
      "approve_later",
      "blocked",
      false
    ));
  }

  if (killSwitch?.enabled) {
    actions.push(action(
      "review_kill_switch_context",
      "Revisar kill switch antes de cualquier avance",
      "human_operator",
      "approve_later",
      "blocked",
      false
    ));
  }

  actions.push(action(
    "enable_live_cluster_mutations_future",
    "Preparar mutaciones supervisadas para una fase futura",
    "human_operator",
    "approve_later",
    "needs_review",
    true
  ));

  return actions;
}

function action(
  id: string,
  label: string,
  owner: AdminClusterAction["owner"],
  mode: AdminClusterAction["mode"],
  status: AdminClusterManagementState,
  blockedInMvp: boolean
): AdminClusterAction {
  return {
    id,
    label,
    owner,
    mode,
    status,
    blockedInMvp
  };
}

function clusterSenderNode(
  node: SenderNode,
  healthByNodeId: Map<string, SenderNodeHealthDecision>
): AdminClusterSenderNode {
  const health = healthByNodeId.get(node.id);

  return {
    id: node.id,
    label: node.label,
    provider: node.provider,
    status: node.status,
    hostname: node.hostname,
    ipAddress: node.ipAddress,
    dailyLimit: node.dailyLimit,
    warmupDay: node.warmupDay,
    healthSeverity: health?.severity ?? "healthy",
    recommendedStatus: health?.recommendedStatus ?? node.status,
    healthReasons: health?.reasons ?? ["no_health_evidence"]
  };
}

function clusterState(
  nodes: SenderNode[],
  healthByNodeId: Map<string, SenderNodeHealthDecision>,
  killSwitch: KillSwitchState | undefined
): { status: AdminClusterManagementState; reason: string } {
  if (killSwitch?.enabled) {
    return {
      status: "blocked",
      reason: "Kill switch activo; no se debe avanzar hasta revisar el incidente."
    };
  }

  if (nodes.some((node) => healthByNodeId.get(node.id)?.severity === "critical")) {
    return {
      status: "blocked",
      reason: "Existe al menos un sender node con decision critica."
    };
  }

  if (
    nodes.some((node) => healthByNodeId.get(node.id)?.severity === "warning")
    || nodes.some((node) => node.status === "degraded" || node.status === "paused" || node.status === "quarantined")
  ) {
    return {
      status: "needs_review",
      reason: "La flota tiene nodos degradados, pausados o con warning."
    };
  }

  return {
    status: "dry_run_ready",
    reason: "La lectura actual permite continuar con propuestas dry-run."
  };
}

function groupSenderNodes(senderNodes: SenderNode[]): Map<SenderNode["provider"], SenderNode[]> {
  const groups = new Map<SenderNode["provider"], SenderNode[]>();

  for (const node of senderNodes) {
    const current = groups.get(node.provider) ?? [];
    current.push(node);
    groups.set(node.provider, current);
  }

  return groups;
}

function baseReadinessGates(): string[] {
  return [
    "onboarding_critico_completo",
    "topologia_dry_run_revisada",
    "provisioning_dry_run_sin_efectos_externos",
    "aprobacion_humana_antes_de_live_apply",
    "smtp_real_apagado_en_mvp"
  ];
}

function providerLabel(provider: SenderNode["provider"]): string {
  if (provider === "proxmox") {
    return "Proxmox";
  }

  if (provider === "webdock") {
    return "Webdock";
  }

  if (provider === "racknerd") {
    return "RackNerd";
  }

  return "Manual";
}

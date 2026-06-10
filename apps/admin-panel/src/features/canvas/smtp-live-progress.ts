import type { CanvasLiveActionNowEventWire, CanvasLiveRunProgressWire } from "./live-tool-types.ts";

export type LiveRunStatus = "running" | "completed" | "failed" | string;
export type LiveRunStepStatus = "in_progress" | "ready" | "error";
export type SmtpBuildStepVisualStatus = "pending" | "in_progress" | "ready" | "error";
export type TopologyOverlayStatus = "in_progress" | "ready" | "error";
export type RecorridoEdgeStatus = "ready" | "in_progress" | "pending";

export interface LiveRunStepProgress {
  skill: string;
  status: LiveRunStepStatus;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface LiveRunProgress {
  runStatus: LiveRunStatus;
  currentStep: number | null;
  lastCompletedStep: number;
  steps: Map<number, LiveRunStepProgress>;
}

export type LiveRunProgressMap = Map<string, LiveRunProgress>;

export interface SmtpBuildStepDefinition {
  step: number;
  skill: string;
  label: string;
  eta: string;
  nodeId: string;
}

export const SMTP_BUILD_STEPS: SmtpBuildStepDefinition[] = [
  { step: 1, skill: "suggest_safe_domain", label: "Eligiendo dominio seguro", eta: "~2s", nodeId: "proxmox_host" },
  { step: 2, skill: "register_domain_route53", label: "Registrando dominio", eta: "~30s", nodeId: "dns_identity" },
  { step: 3, skill: "wait_for_dns_propagation", label: "Esperando propagación NS", eta: "~1-10min", nodeId: "dns_identity" },
  { step: 4, skill: "create_webdock_server", label: "Creando VPS", eta: "~3min", nodeId: "vps_lxc_plan" },
  { step: 5, skill: "wait_server_running", label: "Esperando VPS listo", eta: "~1-3min", nodeId: "vps_lxc_plan" },
  { step: 6, skill: "upsert_dns_route53", label: "Configurando DNS (A/MX)", eta: "~30-60s", nodeId: "dns_identity" },
  { step: 7, skill: "wait_for_dns_propagation", label: "Esperando propagación A", eta: "~30-90s", nodeId: "dns_identity" },
  { step: 8, skill: "bind_webdock_main_domain", label: "Alineando identidad + FCrDNS", eta: "~1-2min", nodeId: "vps_lxc_plan" },
  { step: 9, skill: "provision_smtp_postfix", label: "Instalando Postfix + DKIM + TLS", eta: "~90s", nodeId: "sender_nodes" },
  { step: 10, skill: "configure_email_auth", label: "Configurando SPF/DKIM/DMARC", eta: "~5s", nodeId: "dns_identity" },
  { step: 11, skill: "wait_for_dns_propagation", label: "Esperando propagación DKIM", eta: "~30-60s", nodeId: "dns_identity" },
  { step: 12, skill: "seed_warmup_pool", label: "Iniciando warmup", eta: "~10s", nodeId: "warming_plan" },
  { step: 13, skill: "wait_warmup_initial", label: "Calentamiento inicial", eta: "minutos", nodeId: "warming_ramp" },
  { step: 14, skill: "send_real_email", label: "Enviando correo de prueba", eta: "~10s", nodeId: "sender_nodes" }
];

const SMTP_BUILD_STEP_BY_STEP = new Map(SMTP_BUILD_STEPS.map((item) => [item.step, item]));

export const RECORRIDO_EDGES = [
  { id: "proxmox_to_cluster", from: "proxmox_host", to: "cluster_plan" },
  { id: "cluster_to_vps", from: "cluster_plan", to: "vps_lxc_plan" },
  { id: "vps_to_dns", from: "vps_lxc_plan", to: "dns_identity" },
  { id: "dns_to_sender", from: "dns_identity", to: "sender_nodes" },
  { id: "sender_to_warming", from: "sender_nodes", to: "warming_plan" },
  { id: "warming_plan_to_ramp", from: "warming_plan", to: "warming_ramp" },
  { id: "warming_to_reputation", from: "warming_ramp", to: "reputation_gates" }
] as const;

export type RecorridoEdgeId = (typeof RECORRIDO_EDGES)[number]["id"];

export interface RecorridoOverlay {
  nodes: Record<string, TopologyOverlayStatus>;
  edges: Record<string, RecorridoEdgeStatus>;
  activeNodeId: string | null;
  buildNodeIds: string[];
}

const RECORRIDO_BUILD_NODE_IDS = [
  RECORRIDO_EDGES[0]!.from,
  ...RECORRIDO_EDGES.map((edge) => edge.to)
];

interface RecorridoCanvasLike {
  nodes: Array<{ id: string; status: string }>;
  edges: Array<{ id: string; status: string }>;
}

export interface ParsedOrchestratorProgress {
  runId: string;
  kind: "run" | "step";
  runStatus?: LiveRunStatus;
  step?: number;
  skill?: string;
  stepStatus?: LiveRunStepStatus;
  occurredAt: string;
}

export function parseOrchestratorAuditProgress(
  event: CanvasLiveActionNowEventWire
): ParsedOrchestratorProgress | null {
  if (event.kind !== "audit" || !event.action.startsWith("oc.orchestrator.")) {
    return null;
  }

  if (event.action === "oc.orchestrator.run_started") {
    return { runId: event.targetId, kind: "run", runStatus: "running", occurredAt: event.occurredAt };
  }
  if (event.action === "oc.orchestrator.run_completed") {
    return { runId: event.targetId, kind: "run", runStatus: "completed", occurredAt: event.occurredAt };
  }
  if (event.action === "oc.orchestrator.run_failed") {
    return { runId: event.targetId, kind: "run", runStatus: "failed", occurredAt: event.occurredAt };
  }

  const stepStatus = stepStatusFromAction(event.action);
  if (!stepStatus) return null;
  const [runId, stepStr, ...skillParts] = event.targetId.split(":");
  const step = Number(stepStr);
  const skill = skillParts.join(":");
  if (!runId || !Number.isInteger(step) || step <= 0 || !skill) return null;
  return {
    runId,
    kind: "step",
    step,
    skill,
    stepStatus,
    occurredAt: event.occurredAt
  };
}

function stepStatusFromAction(action: string): LiveRunStepStatus | null {
  if (action === "oc.orchestrator.step_started") return "in_progress";
  if (action === "oc.orchestrator.step_completed") return "ready";
  if (action === "oc.orchestrator.step_failed") return "error";
  return null;
}

export function applyOrchestratorProgressEvent(
  progress: LiveRunProgressMap,
  event: CanvasLiveActionNowEventWire
): boolean {
  const parsed = parseOrchestratorAuditProgress(event);
  if (!parsed) return false;
  const run = ensureRunProgress(progress, parsed.runId);
  if (parsed.kind === "run") {
    run.runStatus = parsed.runStatus ?? run.runStatus;
    if (run.runStatus !== "running") run.currentStep = null;
    return true;
  }
  if (parsed.step == null || !parsed.skill || !parsed.stepStatus) return false;
  const existing = run.steps.get(parsed.step);
  run.steps.set(parsed.step, {
    skill: parsed.skill,
    status: parsed.stepStatus,
    startedAt: parsed.stepStatus === "in_progress" ? parsed.occurredAt : existing?.startedAt,
    completedAt: parsed.stepStatus === "ready" ? parsed.occurredAt : existing?.completedAt,
    updatedAt: parsed.occurredAt
  });
  if (parsed.stepStatus === "in_progress") {
    run.runStatus = "running";
    run.currentStep = parsed.step;
  } else if (run.currentStep === parsed.step) {
    run.currentStep = null;
  }
  if (parsed.stepStatus === "ready") {
    run.lastCompletedStep = Math.max(run.lastCompletedStep, contiguousCompletedStep(run.steps));
  }
  if (parsed.stepStatus === "error") {
    run.runStatus = "failed";
  }
  return true;
}

function ensureRunProgress(progress: LiveRunProgressMap, runId: string): LiveRunProgress {
  const existing = progress.get(runId);
  if (existing) return existing;
  const next: LiveRunProgress = {
    runStatus: "running",
    currentStep: null,
    lastCompletedStep: 0,
    steps: new Map()
  };
  progress.set(runId, next);
  return next;
}

function contiguousCompletedStep(steps: Map<number, LiveRunStepProgress>): number {
  let cursor = 0;
  for (let step = 1; step <= SMTP_BUILD_STEPS.length; step += 1) {
    if (steps.get(step)?.status !== "ready") break;
    cursor = step;
  }
  return cursor;
}

export function liveRunProgressFromSnapshot(
  snapshotProgress: CanvasLiveRunProgressWire[] | undefined
): LiveRunProgressMap {
  const out: LiveRunProgressMap = new Map();
  for (const run of snapshotProgress ?? []) {
    const steps = new Map<number, LiveRunStepProgress>();
    let currentStep: number | null = null;
    for (const step of run.steps) {
      const status = liveStepStatusFromSnapshot(step.status);
      if (!status) continue;
      steps.set(step.step, { skill: step.skill, status });
      if (status === "in_progress") currentStep = step.step;
    }
    out.set(run.runId, {
      runStatus: run.status,
      currentStep: run.status === "running" ? currentStep : null,
      lastCompletedStep: run.lastCompletedStep,
      steps
    });
  }
  return out;
}

function liveStepStatusFromSnapshot(status: CanvasLiveRunProgressWire["steps"][number]["status"]): LiveRunStepStatus | null {
  if (status === "in_flight") return "in_progress";
  if (status === "done") return "ready";
  return null;
}

export function cloneLiveRunProgressMap(progress: LiveRunProgressMap): LiveRunProgressMap {
  const copy: LiveRunProgressMap = new Map();
  for (const [runId, run] of progress.entries()) {
    copy.set(runId, {
      runStatus: run.runStatus,
      currentStep: run.currentStep,
      lastCompletedStep: run.lastCompletedStep,
      steps: new Map([...run.steps.entries()].map(([step, value]) => [step, { ...value }]))
    });
  }
  return copy;
}

export function selectActiveRunProgress(
  progress: LiveRunProgressMap,
  activeTaskId: string | null
): LiveRunProgress | null {
  // Caso bueno: el activeTaskId ES el runId de un run del orquestador.
  if (activeTaskId) {
    const direct = progress.get(activeTaskId);
    if (direct) return direct;
  }
  // Fallback: el activeTaskId NO corresponde a un run del orquestador. Pasa cuando
  // pickPreferredTaskId elige una sub-tarea genérica que eclipsa al run (p.ej. la
  // sub-tarea webdock-create-* que el paso 4 declara y nunca cierra). El progreso SMTP
  // se indexa por runId; si hay EXACTAMENTE un run en curso (el caso normal: un orquestador
  // a la vez), lo mostramos. Con 0 o varios no adivinamos -> null (scopeo explicito por activeTaskId).
  const runningRuns: LiveRunProgress[] = [];
  for (const run of progress.values()) {
    if (run.runStatus === "running") runningRuns.push(run);
  }
  return runningRuns.length === 1 ? runningRuns[0]! : null;
}

export function buildTopologyStatusOverlay(run: LiveRunProgress | null): Record<string, TopologyOverlayStatus> {
  if (!run) return {};
  const grouped = new Map<string, TopologyOverlayStatus[]>();
  for (const [step, state] of run.steps.entries()) {
    const nodeId = nodeIdForSmtpStep(step, state.skill);
    if (!nodeId) continue;
    const status = run.runStatus === "running" ? state.status : state.status === "in_progress" ? null : state.status;
    if (!status) continue;
    const list = grouped.get(nodeId);
    if (list) list.push(status);
    else grouped.set(nodeId, [status]);
  }
  const overlay: Record<string, TopologyOverlayStatus> = {};
  for (const [nodeId, statuses] of grouped.entries()) {
    overlay[nodeId] = aggregateNodeStatus(statuses);
  }
  if (run.runStatus === "running" && run.currentStep === 14) {
    overlay.reputation_gates = aggregateNodeStatus([overlay.reputation_gates, "in_progress"].filter(Boolean) as TopologyOverlayStatus[]);
  }
  return overlay;
}

function aggregateNodeStatus(statuses: TopologyOverlayStatus[]): TopologyOverlayStatus {
  if (statuses.includes("error")) return "error";
  if (statuses.includes("in_progress")) return "in_progress";
  return "ready";
}

export function buildRecorridoOverlay(run: LiveRunProgress | null): RecorridoOverlay {
  if (!run) return emptyRecorridoOverlay();
  if (run.runStatus !== "running") return buildRecorridoTerminalOverlay(run);

  const activeStep = run.currentStep == null ? null : run.steps.get(run.currentStep);
  const activeNodeId = run.currentStep == null ? null : nodeIdForSmtpStep(run.currentStep, activeStep?.skill);
  const frontierIdx = recorridoFrontierForRun(run, activeNodeId);
  const edges: Record<string, RecorridoEdgeStatus> = {};
  const hasActiveStep = activeNodeId !== null;

  for (let index = 0; index < RECORRIDO_EDGES.length; index += 1) {
    const edge = RECORRIDO_EDGES[index]!;
    edges[edge.id] = recorridoEdgeStatus(index, frontierIdx, hasActiveStep);
  }

  return {
    nodes: buildTopologyStatusOverlay(run),
    edges,
    activeNodeId,
    buildNodeIds: [...RECORRIDO_BUILD_NODE_IDS]
  };
}

function buildRecorridoTerminalOverlay(run: LiveRunProgress): RecorridoOverlay {
  const nodes = buildTopologyStatusOverlay(run);
  const edges: Record<string, RecorridoEdgeStatus> = {};
  for (const edge of RECORRIDO_EDGES) {
    edges[edge.id] = nodes[edge.from] === "ready" && nodes[edge.to] === "ready" ? "ready" : "pending";
  }
  return {
    nodes,
    edges,
    activeNodeId: null,
    buildNodeIds: [...RECORRIDO_BUILD_NODE_IDS]
  };
}

export function applyRecorridoOverlayToCanvas<T extends RecorridoCanvasLike>(data: T, overlay: RecorridoOverlay): T {
  if (Object.keys(overlay.nodes).length === 0 && Object.keys(overlay.edges).length === 0) return data;
  return {
    ...data,
    nodes: data.nodes.map((node) => ({
      ...node,
      status: overlay.nodes[node.id] ?? node.status
    })),
    edges: data.edges.map((edge) => ({
      ...edge,
      status: overlay.edges[edge.id] ?? edge.status
    }))
  } as T;
}

function emptyRecorridoOverlay(): RecorridoOverlay {
  return {
    nodes: {},
    edges: {},
    activeNodeId: null,
    buildNodeIds: []
  };
}

function recorridoFrontierForRun(run: LiveRunProgress, activeNodeId: string | null): number | null {
  let frontierIdx: number | null = activeNodeId ? frontierIndexForActiveNode(activeNodeId) : null;
  for (const [step, state] of run.steps.entries()) {
    if (state.status === "error") continue;
    const nodeId = nodeIdForSmtpStep(step, state.skill);
    const stepFrontierIdx = nodeId ? frontierIndexForActiveNode(nodeId) : null;
    if (stepFrontierIdx == null) continue;
    frontierIdx = frontierIdx == null ? stepFrontierIdx : Math.max(frontierIdx, stepFrontierIdx);
  }
  if (frontierIdx != null || run.lastCompletedStep <= 0) return frontierIdx;
  for (let step = 1; step <= run.lastCompletedStep; step += 1) {
    const nodeId = SMTP_BUILD_STEP_BY_STEP.get(step)?.nodeId ?? null;
    const stepFrontierIdx = nodeId ? frontierIndexForActiveNode(nodeId) : null;
    if (stepFrontierIdx == null) continue;
    frontierIdx = frontierIdx == null ? stepFrontierIdx : Math.max(frontierIdx, stepFrontierIdx);
  }
  return frontierIdx;
}

function frontierIndexForActiveNode(activeNodeId: string): number | null {
  const incomingIdx = RECORRIDO_EDGES.findIndex((edge) => edge.to === activeNodeId);
  if (incomingIdx >= 0) return incomingIdx;
  if (RECORRIDO_EDGES[0]?.from === activeNodeId) return -1;
  return null;
}

function recorridoEdgeStatus(index: number, frontierIdx: number | null, hasActiveStep: boolean): RecorridoEdgeStatus {
  if (frontierIdx == null) return "pending";
  if (index < frontierIdx) return "ready";
  if (!hasActiveStep) return index <= frontierIdx ? "ready" : "pending";
  if (index === frontierIdx || index === frontierIdx + 1) return "in_progress";
  return "pending";
}

export function nodeIdForSmtpStep(step: number, skill?: string): string | null {
  const known = SMTP_BUILD_STEP_BY_STEP.get(step);
  if (known) return known.nodeId;
  if (skill === "suggest_safe_domain") return "proxmox_host";
  if (skill === "register_domain_route53" || skill === "wait_for_dns_propagation" || skill === "upsert_dns_route53" || skill === "configure_email_auth") return "dns_identity";
  if (skill === "create_webdock_server" || skill === "wait_server_running" || skill === "bind_webdock_main_domain") return "vps_lxc_plan";
  if (skill === "provision_smtp_postfix" || skill === "send_real_email") return "sender_nodes";
  if (skill === "seed_warmup_pool") return "warming_plan";
  if (skill === "wait_warmup_initial") return "warming_ramp";
  return null;
}

export interface SmtpBuildStepView {
  step: number;
  skill: string;
  label: string;
  eta: string;
  status: SmtpBuildStepVisualStatus;
  startedAt?: string;
  completedAt?: string;
}

export function buildSmtpBuildStepViews(run: LiveRunProgress | null): SmtpBuildStepView[] {
  return SMTP_BUILD_STEPS.map((definition) => {
    const live = run?.steps.get(definition.step);
    return {
      step: definition.step,
      skill: live?.skill ?? definition.skill,
      label: definition.label,
      eta: definition.eta,
      status: stepperStatusForRun(run?.runStatus, live?.status),
      startedAt: live?.startedAt,
      completedAt: live?.completedAt
    };
  });
}

function stepperStatusForRun(
  runStatus: LiveRunStatus | undefined,
  stepStatus: LiveRunStepStatus | undefined
): SmtpBuildStepVisualStatus {
  if (!stepStatus) return "pending";
  if (stepStatus !== "in_progress") return stepStatus;
  if (runStatus === "running" || runStatus == null) return "in_progress";
  if (runStatus === "failed") return "error";
  return "pending";
}

export function currentBuildStepNumber(run: LiveRunProgress | null): number {
  if (!run) return 0;
  if (run.currentStep != null) return run.currentStep;
  return Math.min(SMTP_BUILD_STEPS.length, Math.max(0, run.lastCompletedStep));
}

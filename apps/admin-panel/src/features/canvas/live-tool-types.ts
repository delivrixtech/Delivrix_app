/**
 * Tipos del contrato Canvas Live v6 (OPS Codex Bloque 7, commit 91d3643).
 *
 * Mirror de `packages/domain/src/canvas-live.ts`. Patrón del panel admin:
 * cada feature copia los types del contract en vez de importar @delivrix/domain
 * directamente, para mantener el bundle acotado.
 *
 * Si Codex cambia el contract canónico, este mirror debe sincronizarse.
 */

/* ============================================================
 * Contract canónico (mirror de packages/domain)
 * ============================================================ */

export type CanvasLiveTaskStatusWire = "running" | "idle" | "awaiting_approval" | "completed" | "failed";
export type CanvasLiveActionKindWire = "api" | "file" | "audit" | "command";
export type CanvasLiveArtifactKindWire = "plan" | "proposal" | "template" | "report";
export type CanvasLiveArtifactBlockKindWire = "step" | "title" | "paragraph" | "table_row" | "code";
export type CanvasLiveArtifactBlockStatusWire = "complete" | "streaming";
export type CanvasLiveArtifactApprovalStatusWire = "pending" | "approved" | "rejected";

export interface CanvasLiveTaskDeclareEventWire {
  type: "oc.task.declare";
  taskId: string;
  /**
   * Si está presente, esta task es sub-task del taskId indicado.
   * Bloque 10 T7C/T8 (commit 79cd89f) — supervisor multi-agent spawneé
   * N sub-agentes y el contract los reporta con parentTaskId apuntando al
   * supervisor padre para que el frontend los renderee anidados.
   */
  parentTaskId?: string;
  title: string;
  status: CanvasLiveTaskStatusWire;
  createdAt: string;
  actorId: string;
}

export interface CanvasLiveTaskUpdateEventWire {
  type: "oc.task.update";
  taskId: string;
  status: CanvasLiveTaskStatusWire;
  updatedAt: string;
}

export interface CanvasLiveActionNextWire {
  kind: CanvasLiveActionKindWire;
  method?: string;
  url?: string;
  context?: string;
  operation?: string;
  path?: string;
  cmd?: string;
}

export interface CanvasLiveApiActionEventWire {
  type: "oc.action.now";
  taskId: string;
  kind: "api";
  method: string;
  url: string;
  status: number;
  durationMs: number;
  responseBytes: number;
  responseBody?: unknown;
  next?: CanvasLiveActionNextWire;
  occurredAt: string;
}

export interface CanvasLiveFileActionEventWire {
  type: "oc.action.now";
  taskId: string;
  kind: "file";
  operation: "read" | "write" | "delete" | string;
  path: string;
  diffSummary?: string;
  preview?: string;
  occurredAt: string;
}

export interface CanvasLiveCommandActionEventWire {
  type: "oc.action.now";
  taskId: string;
  kind: "command";
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  occurredAt: string;
}

export interface CanvasLiveAuditActionEventWire {
  type: "oc.action.now";
  taskId: string;
  kind: "audit";
  action: string;
  targetType: string;
  targetId: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  occurredAt: string;
}

export type CanvasLiveActionNowEventWire =
  | CanvasLiveApiActionEventWire
  | CanvasLiveFileActionEventWire
  | CanvasLiveCommandActionEventWire
  | CanvasLiveAuditActionEventWire;

export interface CanvasLiveArtifactDeclareEventWire {
  type: "oc.artifact.declare";
  taskId: string;
  artifactId: string;
  kind: CanvasLiveArtifactKindWire;
  title: string;
  editable: boolean;
  createdAt: string;
}

export interface CanvasLiveArtifactBlockEventWire {
  type: "oc.artifact.block";
  artifactId: string;
  blockId: string;
  order: number;
  kind: CanvasLiveArtifactBlockKindWire;
  content: string;
  editable: boolean;
  status: CanvasLiveArtifactBlockStatusWire;
  occurredAt: string;
}

export interface CanvasLiveArtifactStreamingEventWire {
  type: "oc.artifact.streaming";
  artifactId: string;
  blockId: string;
  chunk: string;
  occurredAt: string;
}

export type CanvasLiveEventWire =
  | CanvasLiveTaskDeclareEventWire
  | CanvasLiveTaskUpdateEventWire
  | CanvasLiveActionNowEventWire
  | CanvasLiveArtifactDeclareEventWire
  | CanvasLiveArtifactBlockEventWire
  | CanvasLiveArtifactStreamingEventWire;

export interface CanvasLiveTaskSnapshotWire {
  taskId: string;
  /** Mirror del contract canónico (commit 79cd89f). Ver CanvasLiveTaskDeclareEventWire. */
  parentTaskId?: string;
  title: string;
  status: CanvasLiveTaskStatusWire;
  createdAt: string;
  updatedAt: string;
  actorId: string;
  lastAction?: CanvasLiveActionNowEventWire;
}

export interface CanvasLiveArtifactBlockSnapshotWire {
  blockId: string;
  order: number;
  kind: CanvasLiveArtifactBlockKindWire;
  content: string;
  editable: boolean;
  status: CanvasLiveArtifactBlockStatusWire;
  updatedAt: string;
}

export interface CanvasLiveArtifactSnapshotWire {
  artifactId: string;
  taskId: string;
  kind: CanvasLiveArtifactKindWire;
  title: string;
  editable: boolean;
  createdAt: string;
  updatedAt: string;
  approvalStatus: CanvasLiveArtifactApprovalStatusWire;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  executionId?: string;
  blocks: CanvasLiveArtifactBlockSnapshotWire[];
}

export type CanvasLiveRunProgressStepStatusWire = "pending" | "in_flight" | "done";

export interface CanvasLiveRunProgressStepWire {
  step: number;
  skill: string;
  status: CanvasLiveRunProgressStepStatusWire;
  label?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface CanvasLiveRunIdentityWire {
  brand?: string;
  domain?: string;
  smtpHost?: string;
  serverSlug?: string;
  serverIpv4?: string;
  serverAccountId?: string;
  providerId?: string;
  dkimSelector?: string;
  dkimPublicKey?: string;
  dnsRecords?: Array<{
    name: string;
    type: string;
    value: string;
  }>;
  finalDeliveryStatus?: string;
  finalEmailMessageId?: string;
  budgetSpentUsd?: number;
}

export interface CanvasLiveRunProgressWire {
  runId: string;
  status: "running" | "completed" | "failed" | string;
  lastCompletedStep: number;
  steps: CanvasLiveRunProgressStepWire[];
  identity?: CanvasLiveRunIdentityWire;
}

export interface CanvasLiveStateSnapshotWire {
  schemaVersion: "2026-05-25.canvas-live.v1";
  generatedAt: string;
  tasks: CanvasLiveTaskSnapshotWire[];
  artifacts: CanvasLiveArtifactSnapshotWire[];
  progress?: CanvasLiveRunProgressWire[];
}

/* ============================================================
 * Shape interno del LiveTool
 * ============================================================ */


export type LiveTaskStatus = "running" | "idle" | "awaiting_approval" | "completed" | "failed";
export type LiveArtifactApprovalStatus = "pending" | "approved" | "rejected";

export interface LiveTask {
  id: string;
  title: string;
  status: LiveTaskStatus;
  /** Subruta visible en el header tipo "blacklists / 14 de 64". */
  subPath?: string;
  createdAt: string;
  actorId: string;
  /**
   * Si está presente, esta tarea es sub-tarea del taskId indicado. Permite
   * que el supervisor multi-agent (Bloque 10 T7C) spawneé N sub-agentes y el
   * frontend los renderee anidados bajo el padre con indent visual.
   */
  parentTaskId?: string | null;
}

export interface LiveApiAction {
  kind: "api";
  taskId: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  status: number;
  durationMs: number;
  responseBytes?: number;
  cache?: "cache miss" | "cache hit" | string;
  /** JSON parseado del response. El renderer lo formatea pretty. */
  responseBody?: unknown;
  next?: {
    kind: "api";
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    url: string;
    context?: string;
  };
  occurredAt: string;
}

export interface LiveFileAction {
  kind: "file";
  taskId: string;
  operation: "read" | "write" | "delete" | "rename";
  path: string;
  diffSummary?: string;
  preview?: string;
  occurredAt: string;
}

export interface LiveCommandAction {
  kind: "command";
  taskId: string;
  cmd: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  durationMs: number;
  occurredAt: string;
}

export interface LiveAuditAction {
  kind: "audit";
  taskId: string;
  eventName: string;
  summary?: string;
  hashShort?: string;
  occurredAt: string;
}

export type LiveAction = LiveApiAction | LiveFileAction | LiveCommandAction | LiveAuditAction;

export interface LiveArtifactBlock {
  id: string;
  order: number;
  kind: "step" | "title" | "paragraph" | "table_row" | "code";
  content: string;
  editable: boolean;
  status: "complete" | "streaming";
}

export interface LiveArtifact {
  id: string;
  taskId: string;
  kind: "plan" | "proposal" | "template" | "report";
  title: string;
  editable: boolean;
  approvalStatus: LiveArtifactApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  executionId?: string;
  blocks: LiveArtifactBlock[];
  createdAt: string;
}

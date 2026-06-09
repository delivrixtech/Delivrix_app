export type CanvasLiveTaskStatus =
  | "running"
  | "idle"
  | "awaiting_approval"
  | "completed"
  | "failed";

export type CanvasLiveActionKind = "api" | "file" | "audit" | "command";
export type CanvasLiveArtifactKind = "plan" | "proposal" | "template" | "report";
export type CanvasLiveArtifactBlockKind = "step" | "title" | "paragraph" | "table_row" | "code";
export type CanvasLiveArtifactBlockStatus = "complete" | "streaming";
export type CanvasLiveArtifactApprovalStatus = "pending" | "approved" | "rejected";

export interface CanvasLiveTaskDeclareEvent {
  type: "oc.task.declare";
  taskId: string;
  parentTaskId?: string;
  title: string;
  status: CanvasLiveTaskStatus;
  createdAt: string;
  actorId: string;
}

export interface CanvasLiveTaskUpdateEvent {
  type: "oc.task.update";
  taskId: string;
  status: CanvasLiveTaskStatus;
  updatedAt: string;
}

export interface CanvasLiveActionNext {
  kind: CanvasLiveActionKind;
  method?: string;
  url?: string;
  context?: string;
  operation?: string;
  path?: string;
  cmd?: string;
}

export interface CanvasLiveApiActionEvent {
  type: "oc.action.now";
  taskId: string;
  kind: "api";
  method: string;
  url: string;
  status: number;
  durationMs: number;
  responseBytes: number;
  responseBody?: unknown;
  next?: CanvasLiveActionNext;
  occurredAt: string;
}

export interface CanvasLiveFileActionEvent {
  type: "oc.action.now";
  taskId: string;
  kind: "file";
  operation: "read" | "write" | "delete" | string;
  path: string;
  diffSummary?: string;
  preview?: string;
  occurredAt: string;
}

export interface CanvasLiveCommandActionEvent {
  type: "oc.action.now";
  taskId: string;
  kind: "command";
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  progressDetail?: string;
  occurredAt: string;
}

export interface CanvasLiveAuditActionEvent {
  type: "oc.action.now";
  taskId: string;
  kind: "audit";
  action: string;
  targetType: string;
  targetId: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  metadata?: Record<string, unknown>;
  occurredAt: string;
}

export type CanvasLiveActionNowEvent =
  | CanvasLiveApiActionEvent
  | CanvasLiveFileActionEvent
  | CanvasLiveCommandActionEvent
  | CanvasLiveAuditActionEvent;

export interface CanvasLiveArtifactDeclareEvent {
  type: "oc.artifact.declare";
  taskId: string;
  artifactId: string;
  kind: CanvasLiveArtifactKind;
  title: string;
  editable: boolean;
  createdAt: string;
}

export interface CanvasLiveArtifactBlockEvent {
  type: "oc.artifact.block";
  artifactId: string;
  blockId: string;
  order: number;
  kind: CanvasLiveArtifactBlockKind;
  content: string;
  editable: boolean;
  status: CanvasLiveArtifactBlockStatus;
  occurredAt: string;
}

export interface CanvasLiveArtifactStreamingEvent {
  type: "oc.artifact.streaming";
  artifactId: string;
  blockId: string;
  chunk: string;
  occurredAt: string;
}

export type CanvasLiveEvent =
  | CanvasLiveTaskDeclareEvent
  | CanvasLiveTaskUpdateEvent
  | CanvasLiveActionNowEvent
  | CanvasLiveArtifactDeclareEvent
  | CanvasLiveArtifactBlockEvent
  | CanvasLiveArtifactStreamingEvent;

export interface CanvasLiveTaskSnapshot {
  taskId: string;
  parentTaskId?: string;
  title: string;
  status: CanvasLiveTaskStatus;
  createdAt: string;
  updatedAt: string;
  actorId: string;
  lastAction?: CanvasLiveActionNowEvent;
}

export interface CanvasLiveArtifactBlockSnapshot {
  blockId: string;
  order: number;
  kind: CanvasLiveArtifactBlockKind;
  content: string;
  editable: boolean;
  status: CanvasLiveArtifactBlockStatus;
  updatedAt: string;
}

export interface CanvasLiveArtifactSnapshot {
  artifactId: string;
  taskId: string;
  kind: CanvasLiveArtifactKind;
  title: string;
  editable: boolean;
  createdAt: string;
  updatedAt: string;
  approvalStatus: CanvasLiveArtifactApprovalStatus;
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  executionId?: string;
  blocks: CanvasLiveArtifactBlockSnapshot[];
}

export type CanvasLiveRunProgressStepStatus = "pending" | "in_flight" | "done";

export interface CanvasLiveRunProgressStep {
  step: number;
  skill: string;
  status: CanvasLiveRunProgressStepStatus;
}

export interface CanvasLiveRunProgress {
  runId: string;
  status: "running" | "completed" | "failed" | string;
  lastCompletedStep: number;
  steps: CanvasLiveRunProgressStep[];
}

export interface CanvasLiveStateSnapshot {
  schemaVersion: "2026-05-25.canvas-live.v1";
  generatedAt: string;
  tasks: CanvasLiveTaskSnapshot[];
  artifacts: CanvasLiveArtifactSnapshot[];
  progress?: CanvasLiveRunProgress[];
}

export interface CanvasArtifactApproveInput {
  actorId: string;
  blocks: Array<{
    blockId: string;
    content: string;
  }>;
}

export interface CanvasArtifactApproveResponse {
  ok: true;
  executionId: string;
}

export interface CanvasArtifactRejectInput {
  actorId: string;
  reason: string;
}

export interface CanvasArtifactRejectResponse {
  ok: true;
}

export interface CanvasArtifactBlockPatchInput {
  actorId: string;
  content: string;
}

export interface CanvasArtifactBlockPatchResponse {
  ok: true;
  updatedAt: string;
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { redactRuntimeLogSecrets } from "../gateway-runtime-log.ts";
import type {
  CanvasLiveActionNext,
  CanvasLiveActionNowEvent,
  CanvasLiveArtifactBlockEvent,
  CanvasLiveArtifactBlockKind,
  CanvasLiveArtifactBlockSnapshot,
  CanvasLiveArtifactBlockStatus,
  CanvasLiveArtifactDeclareEvent,
  CanvasLiveArtifactKind,
  CanvasLiveArtifactSnapshot,
  CanvasLiveArtifactStreamingEvent,
  CanvasLiveEvent,
  CanvasLiveRunProgress,
  CanvasLiveStateSnapshot,
  CanvasLiveTaskDeclareEvent,
  CanvasLiveTaskSnapshot,
  CanvasLiveTaskStatus,
  CanvasLiveTaskUpdateEvent
} from "../../../../packages/domain/src/index.ts";

const defaultStateDir = "state/canvas-live";
const tasksFileName = "tasks.jsonl";
const artifactsFileName = "artifacts.jsonl";
const defaultWebSocketHeartbeatIntervalMs = 30_000;
const maxCanvasTextChars = 8_000;
const maxCanvasValueArrayItems = 50;
const maxCanvasValueObjectKeys = 80;
const maxCanvasValueDepth = 5;

export interface CanvasLiveEventClient {
  sendJson(event: CanvasLiveEvent): void;
  close(): void;
}

interface ClientEntry {
  client: CanvasLiveEventClient;
  taskId?: string;
}

export interface CanvasLiveEventServiceOptions {
  stateDir?: string;
  now?: () => Date;
  streamToken?: string;
  heartbeatIntervalMs?: number;
  smtpProgressReader?: CanvasLiveSmtpProgressReader;
}

export interface CanvasLiveSmtpProgressReaderInput {
  taskId?: string;
  runIds: string[];
}

export interface CanvasLiveSmtpProgressReader {
  (input: CanvasLiveSmtpProgressReaderInput): Promise<CanvasLiveRunProgress[]> | CanvasLiveRunProgress[];
}

export interface CanvasLiveArtifactDecisionRecord {
  type: "oc.artifact.approved" | "oc.artifact.rejected";
  artifactId: string;
  actorId: string;
  occurredAt: string;
  executionId?: string;
  reason?: string;
}

type PersistedArtifactRecord =
  | CanvasLiveArtifactDeclareEvent
  | CanvasLiveArtifactBlockEvent
  | CanvasLiveArtifactStreamingEvent
  | CanvasLiveArtifactDecisionRecord;

const maxRecentProgressRuns = 5;

export function canvasLiveSnapshotProgressRunIds(
  taskId: string | undefined,
  tasks: CanvasLiveTaskSnapshot[]
): string[] {
  if (taskId) return [taskId];
  const selected = new Set<string>();
  for (const task of tasks) {
    if (task.status === "running") selected.add(task.taskId);
  }
  for (const task of [...tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    if (selected.size >= maxRecentProgressRuns) break;
    selected.add(task.taskId);
  }
  return [...selected];
}

export class CanvasLiveEventService {
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly streamToken: string;
  private readonly heartbeatIntervalMs: number;
  private readonly smtpProgressReader?: CanvasLiveSmtpProgressReader;
  private readonly clients = new Set<ClientEntry>();
  private readonly tasks = new Map<string, CanvasLiveTaskSnapshot>();
  private readonly artifacts = new Map<string, CanvasLiveArtifactSnapshot>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeQueue = Promise.resolve();

  constructor(options: CanvasLiveEventServiceOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? process.env.CANVAS_LIVE_STATE_DIR ?? defaultStateDir);
    this.now = options.now ?? (() => new Date());
    this.streamToken = options.streamToken ?? process.env.CANVAS_LIVE_STREAM_TOKEN ?? process.env.DELIVRIX_READ_BOUNDARY_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? defaultWebSocketHeartbeatIntervalMs;
    this.smtpProgressReader = options.smtpProgressReader;
  }

  async emit(rawEvent: unknown): Promise<CanvasLiveEvent> {
    await this.ensureLoaded();
    const event = normalizeCanvasLiveEvent(rawEvent, this.now);
    this.applyLiveEvent(event);
    await this.persistLiveEvent(event);
    this.broadcast(event);
    return event;
  }

  async snapshot(taskId?: string): Promise<CanvasLiveStateSnapshot> {
    await this.ensureLoaded();
    const tasks = [...this.tasks.values()]
      .filter((task) => !taskId || task.taskId === taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const taskIds = new Set(tasks.map((task) => task.taskId));
    const artifacts = [...this.artifacts.values()]
      .filter((artifact) => !taskId || taskIds.has(artifact.taskId))
      .map((artifact) => ({
        ...artifact,
        blocks: [...artifact.blocks].sort((left, right) => left.order - right.order)
      }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const progress = await this.snapshotProgress(taskId, tasks);

    return {
      schemaVersion: "2026-05-25.canvas-live.v1",
      generatedAt: this.now().toISOString(),
      tasks,
      artifacts,
      ...(progress.length > 0 ? { progress } : {})
    };
  }

  private async snapshotProgress(
    taskId: string | undefined,
    tasks: CanvasLiveTaskSnapshot[]
  ): Promise<CanvasLiveRunProgress[]> {
    if (!this.smtpProgressReader) return [];
    const runIds = canvasLiveSnapshotProgressRunIds(taskId, tasks);
    if (runIds.length === 0) return [];
    return this.smtpProgressReader({ taskId, runIds });
  }

  async patchBlock(input: {
    artifactId: string;
    blockId: string;
    content: string;
    actorId: string;
  }): Promise<{ updatedAt: string; event: CanvasLiveArtifactBlockEvent }> {
    await this.ensureLoaded();
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact) {
      throw new CanvasLiveStateError(404, "artifact_not_found", `Artifact ${input.artifactId} does not exist.`);
    }
    assertActorId(input.actorId);
    const existing = artifact.blocks.find((block) => block.blockId === input.blockId);
    if (!existing) {
      throw new CanvasLiveStateError(404, "artifact_block_not_found", `Block ${input.blockId} does not exist.`);
    }

    const updatedAt = this.now().toISOString();
    const event: CanvasLiveArtifactBlockEvent = {
      type: "oc.artifact.block",
      artifactId: input.artifactId,
      blockId: input.blockId,
      order: existing.order,
      kind: existing.kind,
      content: redactCanvasLiveText(input.content, maxCanvasTextChars),
      editable: existing.editable,
      status: "complete",
      occurredAt: updatedAt
    };
    this.applyLiveEvent(event);
    await this.persistArtifactRecord(event);
    this.broadcast(event);
    return { updatedAt, event };
  }

  async approveArtifact(input: {
    artifactId: string;
    actorId: string;
    blocks: Array<{ blockId: string; content: string }>;
  }): Promise<{ executionId: string; occurredAt: string }> {
    await this.ensureLoaded();
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact) {
      throw new CanvasLiveStateError(404, "artifact_not_found", `Artifact ${input.artifactId} does not exist.`);
    }
    assertActorId(input.actorId);
    if (!Array.isArray(input.blocks)) {
      throw new CanvasLiveStateError(422, "invalid_blocks", "blocks must be an array.");
    }

    for (const block of input.blocks) {
      if (!isRecord(block) || !stringValue(block.blockId) || typeof block.content !== "string") {
        throw new CanvasLiveStateError(422, "invalid_blocks", "Each block must include blockId and content.");
      }
      const existing = artifact.blocks.find((candidate) => candidate.blockId === block.blockId);
      if (existing) {
        const event: CanvasLiveArtifactBlockEvent = {
          type: "oc.artifact.block",
          artifactId: input.artifactId,
          blockId: existing.blockId,
          order: existing.order,
          kind: existing.kind,
          content: redactCanvasLiveText(block.content, maxCanvasTextChars),
          editable: existing.editable,
          status: "complete",
          occurredAt: this.now().toISOString()
        };
        this.applyLiveEvent(event);
        await this.persistArtifactRecord(event);
        this.broadcast(event);
      }
    }

    const executionId = `exec-${randomUUID()}`;
    const occurredAt = this.now().toISOString();
    const record: CanvasLiveArtifactDecisionRecord = {
      type: "oc.artifact.approved",
      artifactId: input.artifactId,
      actorId: input.actorId,
      executionId,
      occurredAt
    };
    this.applyDecisionRecord(record);
    await this.persistArtifactRecord(record);
    return { executionId, occurredAt };
  }

  async rejectArtifact(input: {
    artifactId: string;
    actorId: string;
    reason: string;
  }): Promise<{ occurredAt: string }> {
    await this.ensureLoaded();
    const artifact = this.artifacts.get(input.artifactId);
    if (!artifact) {
      throw new CanvasLiveStateError(404, "artifact_not_found", `Artifact ${input.artifactId} does not exist.`);
    }
    assertActorId(input.actorId);
    const reason = stringValue(input.reason);
    if (!reason) {
      throw new CanvasLiveStateError(422, "invalid_reason", "reason is required.");
    }

    const occurredAt = this.now().toISOString();
    const record: CanvasLiveArtifactDecisionRecord = {
      type: "oc.artifact.rejected",
      artifactId: input.artifactId,
      actorId: input.actorId,
      reason,
      occurredAt
    };
    this.applyDecisionRecord(record);
    await this.persistArtifactRecord(record);
    return { occurredAt };
  }

  async upsertArtifactSnapshot(input: CanvasLiveArtifactSnapshot): Promise<void> {
    await this.ensureLoaded();
    const snapshot: CanvasLiveArtifactSnapshot = {
      ...input,
      blocks: input.blocks
        .map((block, index) => ({
          ...block,
          content: redactCanvasLiveText(block.content, maxCanvasTextChars),
          order: normalizeSnapshotBlockOrder(block.order, index + 1)
        }))
        .sort((left, right) => left.order - right.order)
    };
    this.artifacts.set(snapshot.artifactId, snapshot);

    await this.persistArtifactRecord({
      type: "oc.artifact.declare",
      taskId: snapshot.taskId,
      artifactId: snapshot.artifactId,
      kind: snapshot.kind,
      title: snapshot.title,
      editable: snapshot.editable,
      createdAt: snapshot.createdAt
    });
    for (const block of snapshot.blocks) {
      await this.persistArtifactRecord({
        type: "oc.artifact.block",
        artifactId: snapshot.artifactId,
        blockId: block.blockId,
        order: block.order,
        kind: block.kind,
        content: block.content,
        editable: block.editable,
        status: block.status,
        occurredAt: block.updatedAt
      });
    }

    if (snapshot.approvalStatus === "approved" && snapshot.approvedBy && snapshot.approvedAt) {
      await this.persistArtifactRecord({
        type: "oc.artifact.approved",
        artifactId: snapshot.artifactId,
        actorId: snapshot.approvedBy,
        executionId: snapshot.executionId,
        occurredAt: snapshot.approvedAt
      });
    }
    if (snapshot.approvalStatus === "rejected" && snapshot.rejectedBy && snapshot.rejectedAt) {
      await this.persistArtifactRecord({
        type: "oc.artifact.rejected",
        artifactId: snapshot.artifactId,
        actorId: snapshot.rejectedBy,
        reason: snapshot.rejectionReason,
        occurredAt: snapshot.rejectedAt
      });
    }
  }

  acceptPanelSocket(request: IncomingMessage, socket: Socket, head?: Buffer): void {
    if (!isWebSocketUpgrade(request)) {
      socket.destroy();
      return;
    }

    if (!isAuthorizedCanvasStream(request, this.streamToken)) {
      rejectWebSocket(socket, 401, "Unauthorized");
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const acceptKey = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      ""
    ].join("\r\n"));

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const taskId = normalizeId(url.searchParams.get("task") ?? "");
    const entry: ClientEntry = {
      client: new RawCanvasLiveWebSocketClient(socket, (closedClient) => {
        for (const candidate of this.clients) {
          if (candidate.client === closedClient) {
            this.clients.delete(candidate);
          }
        }
      }, this.heartbeatIntervalMs),
      ...(taskId ? { taskId } : {})
    };
    this.clients.add(entry);

    if (head && head.length > 0) {
      socket.unshift(head);
    }
  }

  close(): void {
    for (const entry of this.clients) {
      entry.client.close();
    }
    this.clients.clear();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    try {
      await this.loadPromise;
    } catch (error) {
      this.loadPromise = null;
      throw error;
    }
  }

  private async loadFromDisk(): Promise<void> {
    for (const record of await readJsonl(this.tasksPath())) {
      const event = normalizeCanvasLiveEvent(record, this.now);
      if (event.type === "oc.task.declare" || event.type === "oc.task.update" || event.type === "oc.action.now") {
        this.applyLiveEvent(event);
      }
    }

    for (const record of await readJsonl(this.artifactsPath())) {
      if (isArtifactDecisionRecord(record)) {
        this.applyDecisionRecord(record);
        continue;
      }
      const event = normalizeCanvasLiveEvent(this.repairPersistedArtifactRecord(record), this.now);
      if (
        event.type === "oc.artifact.declare" ||
        event.type === "oc.artifact.block" ||
        event.type === "oc.artifact.streaming"
      ) {
        this.applyLiveEvent(event);
      }
    }

    this.loaded = true;
  }

  private repairPersistedArtifactRecord(record: unknown): unknown {
    if (!isRecord(record) || record.type !== "oc.artifact.block" || isPositiveIntegerValue(record.order)) {
      return record;
    }
    const artifactId = stringValue(record.artifactId);
    const artifact = artifactId ? this.artifacts.get(artifactId) : undefined;
    const repairedOrder = artifact ? artifact.blocks.length + 1 : 1;
    console.warn("[canvas-live] repaired persisted artifact block with invalid order", {
      artifactId: artifactId ?? "unknown",
      blockId: stringValue(record.blockId) ?? "unknown",
      rawOrder: record.order,
      repairedOrder
    });
    return {
      ...record,
      order: repairedOrder
    };
  }

  private async persistLiveEvent(event: CanvasLiveEvent): Promise<void> {
    if (event.type === "oc.task.declare" || event.type === "oc.task.update" || event.type === "oc.action.now") {
      await this.persistTaskEvent(event);
      return;
    }

    if (
      event.type === "oc.artifact.declare" ||
      event.type === "oc.artifact.block" ||
      event.type === "oc.artifact.streaming"
    ) {
      await this.persistArtifactRecord(event);
    }
  }

  private async persistTaskEvent(
    event: CanvasLiveTaskDeclareEvent | CanvasLiveTaskUpdateEvent | CanvasLiveActionNowEvent
  ): Promise<void> {
    await this.appendJsonl(this.tasksPath(), event);
  }

  private async persistArtifactRecord(record: PersistedArtifactRecord): Promise<void> {
    await this.appendJsonl(this.artifactsPath(), record);
  }

  private async appendJsonl(filePath: string, record: unknown): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
    });
    await this.writeQueue;
  }

  private applyLiveEvent(event: CanvasLiveEvent): void {
    switch (event.type) {
      case "oc.task.declare":
        this.tasks.set(event.taskId, {
          taskId: event.taskId,
          ...(event.parentTaskId ? { parentTaskId: event.parentTaskId } : {}),
          title: event.title,
          status: event.status,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          actorId: event.actorId
        });
        return;
      case "oc.task.update": {
        const existing = this.tasks.get(event.taskId);
        this.tasks.set(event.taskId, {
          taskId: event.taskId,
          ...(existing?.parentTaskId ? { parentTaskId: existing.parentTaskId } : {}),
          title: existing?.title ?? event.taskId,
          status: event.status,
          createdAt: existing?.createdAt ?? event.updatedAt,
          updatedAt: event.updatedAt,
          actorId: existing?.actorId ?? "openclaw",
          ...(existing?.lastAction ? { lastAction: existing.lastAction } : {})
        });
        return;
      }
      case "oc.action.now": {
        const existing = this.tasks.get(event.taskId);
        if (existing) {
          this.tasks.set(event.taskId, {
            ...existing,
            updatedAt: event.occurredAt,
            lastAction: event
          });
        }
        return;
      }
      case "oc.artifact.declare":
        this.artifacts.set(event.artifactId, {
          artifactId: event.artifactId,
          taskId: event.taskId,
          kind: event.kind,
          title: event.title,
          editable: event.editable,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          approvalStatus: "pending",
          blocks: []
        });
        return;
      case "oc.artifact.streaming":
        this.applyArtifactStreaming(event);
        return;
      case "oc.artifact.block":
        this.applyArtifactBlock(event);
        return;
    }
  }

  private applyArtifactStreaming(event: CanvasLiveArtifactStreamingEvent): void {
    const artifact = this.artifacts.get(event.artifactId);
    if (!artifact) {
      return;
    }
    const existing = artifact.blocks.find((block) => block.blockId === event.blockId);
    if (existing) {
      existing.content = (existing.content + event.chunk).slice(-50000);
      existing.status = "streaming";
      existing.updatedAt = event.occurredAt;
    } else {
      artifact.blocks.push({
        blockId: event.blockId,
        order: artifact.blocks.length + 1,
        kind: "paragraph",
        content: event.chunk,
        editable: true,
        status: "streaming",
        updatedAt: event.occurredAt
      });
    }
    artifact.updatedAt = event.occurredAt;
  }

  private applyArtifactBlock(event: CanvasLiveArtifactBlockEvent): void {
    const artifact = this.artifacts.get(event.artifactId);
    if (!artifact) {
      return;
    }
    const nextBlock: CanvasLiveArtifactBlockSnapshot = {
      blockId: event.blockId,
      order: event.order,
      kind: event.kind,
      content: event.content,
      editable: event.editable,
      status: event.status,
      updatedAt: event.occurredAt
    };
    const index = artifact.blocks.findIndex((block) => block.blockId === event.blockId);
    if (index >= 0) {
      artifact.blocks[index] = nextBlock;
    } else {
      artifact.blocks.push(nextBlock);
    }
    artifact.updatedAt = event.occurredAt;
  }

  private applyDecisionRecord(record: CanvasLiveArtifactDecisionRecord): void {
    const artifact = this.artifacts.get(record.artifactId);
    if (!artifact) {
      return;
    }
    artifact.updatedAt = record.occurredAt;
    if (record.type === "oc.artifact.approved") {
      artifact.approvalStatus = "approved";
      artifact.approvedBy = record.actorId;
      artifact.approvedAt = record.occurredAt;
      artifact.executionId = record.executionId;
      return;
    }
    artifact.approvalStatus = "rejected";
    artifact.rejectedBy = record.actorId;
    artifact.rejectedAt = record.occurredAt;
    artifact.rejectionReason = record.reason;
  }

  private broadcast(event: CanvasLiveEvent): void {
    for (const entry of this.clients) {
      if (entry.taskId && eventTaskId(event, this.artifacts) !== entry.taskId) {
        continue;
      }
      try {
        entry.client.sendJson(event);
      } catch {
        this.clients.delete(entry);
        entry.client.close();
      }
    }
  }

  private tasksPath(): string {
    return join(this.stateDir, tasksFileName);
  }

  private artifactsPath(): string {
    return join(this.stateDir, artifactsFileName);
  }
}

export class CanvasLiveStateError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "CanvasLiveStateError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeCanvasLiveEvent(raw: unknown, now: () => Date = () => new Date()): CanvasLiveEvent {
  if (!isRecord(raw)) {
    throw new CanvasLiveStateError(422, "invalid_canvas_live_event", "Canvas live event must be an object.");
  }

  if (raw.type === "oc.task.declare") {
    const taskId = requiredId(raw.taskId, "taskId");
    return {
      type: "oc.task.declare",
      taskId,
      ...optionalParentTaskId(raw, taskId),
      title: normalizeCanvasTaskTitle(requiredString(raw.title, "title")),
      status: normalizeTaskStatus(raw.status),
      createdAt: normalizeDate(raw.createdAt, now),
      actorId: requiredString(raw.actorId, "actorId")
    };
  }

  if (raw.type === "oc.task.update") {
    return {
      type: "oc.task.update",
      taskId: requiredId(raw.taskId, "taskId"),
      status: normalizeTaskStatus(raw.status),
      updatedAt: normalizeDate(raw.updatedAt, now)
    };
  }

  if (raw.type === "oc.action.now") {
    return normalizeActionNowEvent(raw, now);
  }

  if (raw.type === "oc.artifact.declare") {
    return {
      type: "oc.artifact.declare",
      taskId: requiredId(raw.taskId, "taskId"),
      artifactId: requiredId(raw.artifactId, "artifactId"),
      kind: normalizeArtifactKind(raw.kind),
      title: requiredString(raw.title, "title"),
      editable: raw.editable === true,
      createdAt: normalizeDate(raw.createdAt, now)
    };
  }

  if (raw.type === "oc.artifact.block") {
    return {
      type: "oc.artifact.block",
      artifactId: requiredId(raw.artifactId, "artifactId"),
      blockId: requiredId(raw.blockId, "blockId"),
      order: positiveInteger(raw.order, "order"),
      kind: normalizeBlockKind(raw.kind),
      content: redactCanvasLiveText(requiredText(raw.content, "content"), maxCanvasTextChars),
      editable: raw.editable === true,
      status: normalizeBlockStatus(raw.status),
      occurredAt: normalizeDate(raw.occurredAt, now)
    };
  }

  if (raw.type === "oc.artifact.streaming") {
    return {
      type: "oc.artifact.streaming",
      artifactId: requiredId(raw.artifactId, "artifactId"),
      blockId: requiredId(raw.blockId, "blockId"),
      chunk: redactCanvasLiveText(requiredText(raw.chunk, "chunk"), maxCanvasTextChars),
      occurredAt: normalizeDate(raw.occurredAt, now)
    };
  }

  throw new CanvasLiveStateError(422, "unknown_canvas_live_event", `Unsupported canvas live event type ${String(raw.type)}.`);
}

function normalizeActionNowEvent(raw: Record<string, unknown>, now: () => Date): CanvasLiveActionNowEvent {
  const taskId = requiredId(raw.taskId, "taskId");
  const occurredAt = normalizeDate(raw.occurredAt, now);
  if (raw.kind === "api") {
    return {
      type: "oc.action.now",
      taskId,
      kind: "api",
      method: requiredString(raw.method, "method").toUpperCase(),
      url: redactCanvasLiveText(requiredString(raw.url, "url"), 1_000),
      status: positiveInteger(raw.status, "status"),
      durationMs: nonNegativeInteger(raw.durationMs, "durationMs"),
      responseBytes: nonNegativeInteger(raw.responseBytes, "responseBytes"),
      ...(raw.responseBody === undefined ? {} : { responseBody: redactCanvasLiveValue(raw.responseBody) }),
      ...(isRecord(raw.next) ? { next: normalizeActionNext(raw.next) } : {}),
      occurredAt
    };
  }
  if (raw.kind === "file") {
    return {
      type: "oc.action.now",
      taskId,
      kind: "file",
      operation: redactCanvasLiveText(requiredString(raw.operation, "operation"), 120),
      path: redactCanvasLiveText(requiredString(raw.path, "path"), 2_000),
      ...(typeof raw.diffSummary === "string" ? { diffSummary: redactCanvasLiveText(raw.diffSummary, maxCanvasTextChars) } : {}),
      ...(typeof raw.preview === "string" ? { preview: redactCanvasLiveText(raw.preview, maxCanvasTextChars) } : {}),
      occurredAt
    };
  }
  if (raw.kind === "command") {
    return {
      type: "oc.action.now",
      taskId,
      kind: "command",
      cmd: redactCanvasLiveText(requiredString(raw.cmd, "cmd"), 2_000),
      exitCode: Number.isInteger(raw.exitCode) ? Number(raw.exitCode) : 0,
      stdout: typeof raw.stdout === "string" ? redactCanvasLiveText(raw.stdout, maxCanvasTextChars) : "",
      stderr: typeof raw.stderr === "string" ? redactCanvasLiveText(raw.stderr, maxCanvasTextChars) : "",
      durationMs: nonNegativeInteger(raw.durationMs, "durationMs"),
      ...(typeof raw.progressDetail === "string" ? { progressDetail: redactCanvasLiveText(raw.progressDetail, 1_000) } : {}),
      occurredAt
    };
  }
  if (raw.kind === "audit") {
    return {
      type: "oc.action.now",
      taskId,
      kind: "audit",
      action: redactCanvasLiveText(requiredString(raw.action, "action"), 200),
      targetType: redactCanvasLiveText(requiredString(raw.targetType, "targetType"), 200),
      targetId: redactCanvasLiveText(requiredString(raw.targetId, "targetId"), 500),
      riskLevel: normalizeRiskLevel(raw.riskLevel),
      ...(isRecord(raw.metadata) ? { metadata: redactCanvasLiveValue(raw.metadata) as Record<string, unknown> } : {}),
      occurredAt
    };
  }
  throw new CanvasLiveStateError(422, "invalid_action_kind", "kind must be api, file, audit, or command.");
}

function normalizeActionNext(raw: Record<string, unknown>): CanvasLiveActionNext {
  const kind = raw.kind;
  if (kind !== "api" && kind !== "file" && kind !== "audit" && kind !== "command") {
    throw new CanvasLiveStateError(422, "invalid_next_action_kind", "next.kind is invalid.");
  }
  return {
    kind,
    ...(typeof raw.method === "string" ? { method: redactCanvasLiveText(raw.method.toUpperCase(), 40) } : {}),
    ...(typeof raw.url === "string" ? { url: redactCanvasLiveText(raw.url, 1_000) } : {}),
    ...(typeof raw.context === "string" ? { context: redactCanvasLiveText(raw.context, 1_000) } : {}),
    ...(typeof raw.operation === "string" ? { operation: redactCanvasLiveText(raw.operation, 120) } : {}),
    ...(typeof raw.path === "string" ? { path: redactCanvasLiveText(raw.path, 2_000) } : {}),
    ...(typeof raw.cmd === "string" ? { cmd: redactCanvasLiveText(raw.cmd, 2_000) } : {})
  };
}

function redactCanvasLiveValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return redactCanvasLiveText(value, maxCanvasTextChars);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= maxCanvasValueDepth) {
      return "[REDACTED_DEPTH_LIMIT]";
    }
    return value.slice(0, maxCanvasValueArrayItems).map((item) => redactCanvasLiveValue(item, depth + 1));
  }
  if (isRecord(value)) {
    if (depth >= maxCanvasValueDepth) {
      return "[REDACTED_DEPTH_LIMIT]";
    }
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, maxCanvasValueObjectKeys)) {
      normalized[key] = isSensitiveCanvasKey(key) ? "[REDACTED]" : redactCanvasLiveValue(item, depth + 1);
    }
    return normalized;
  }
  return String(value);
}

function redactCanvasLiveText(value: string, maxChars: number): string {
  return redactRuntimeLogSecrets(value).slice(0, maxChars);
}

function isSensitiveCanvasKey(key: string): boolean {
  return /authorization|bearer|cookie|password|passwd|secret|token|session[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key|signature|hmac|nonce/i.test(key);
}

function eventTaskId(event: CanvasLiveEvent, artifacts: Map<string, CanvasLiveArtifactSnapshot>): string | undefined {
  if ("taskId" in event) {
    return event.taskId;
  }
  if ("artifactId" in event) {
    return artifacts.get(event.artifactId)?.taskId;
  }
  return undefined;
}

class RawCanvasLiveWebSocketClient implements CanvasLiveEventClient {
  private closed = false;
  private readonly socket: Socket;
  private readonly onClose: (client: CanvasLiveEventClient) => void;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimer: NodeJS.Timeout | null;
  private lastPongAt = Date.now();

  constructor(
    socket: Socket,
    onClose: (client: CanvasLiveEventClient) => void,
    heartbeatIntervalMs: number
  ) {
    this.socket = socket;
    this.onClose = onClose;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimer = heartbeatIntervalMs > 0
      ? setInterval(() => this.sendPing(), heartbeatIntervalMs)
      : null;
    this.heartbeatTimer?.unref?.();
    socket.on("data", (chunk: Buffer) => {
      if (hasCloseFrame(chunk)) {
        this.close();
        return;
      }
      if (hasPingFrame(chunk)) {
        this.socket.write(encodeWebSocketPongFrame());
        return;
      }
      if (hasPongFrame(chunk)) {
        this.lastPongAt = Date.now();
      }
    });
    socket.on("close", () => {
      this.closed = true;
      this.clearHeartbeat();
      this.onClose(this);
    });
    socket.on("error", () => {
      this.closed = true;
      this.clearHeartbeat();
      this.onClose(this);
    });
  }

  sendJson(event: CanvasLiveEvent): void {
    if (this.closed) return;
    this.socket.write(encodeWebSocketTextFrame(JSON.stringify(event)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHeartbeat();
    this.socket.end(encodeWebSocketCloseFrame());
  }

  private sendPing(): void {
    if (this.closed) return;
    if (this.heartbeatIntervalMs > 0 && Date.now() - this.lastPongAt > this.heartbeatIntervalMs * 4) {
      this.close();
      return;
    }
    try {
      this.socket.write(encodeWebSocketPingFrame());
    } catch {
      this.close();
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
  }
}

function encodeWebSocketTextFrame(text: string): Buffer {
  return encodeWebSocketFrame(0x1, Buffer.from(text, "utf8"));
}

function encodeWebSocketCloseFrame(): Buffer {
  return encodeWebSocketFrame(0x8, Buffer.alloc(0));
}

function encodeWebSocketPingFrame(): Buffer {
  return encodeWebSocketFrame(0x9, Buffer.alloc(0));
}

function encodeWebSocketPongFrame(): Buffer {
  return encodeWebSocketFrame(0x0a, Buffer.alloc(0));
}

function encodeWebSocketFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function hasCloseFrame(chunk: Buffer): boolean {
  return (chunk[0] & 0x0f) === 0x8;
}

function hasPingFrame(chunk: Buffer): boolean {
  return (chunk[0] & 0x0f) === 0x09;
}

function hasPongFrame(chunk: Buffer): boolean {
  return (chunk[0] & 0x0f) === 0x0a;
}

function isWebSocketUpgrade(request: IncomingMessage): boolean {
  return request.headers.upgrade?.toLowerCase() === "websocket";
}

function isAuthorizedCanvasStream(request: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken) {
    return false;
  }
  const supplied = bearerToken(request.headers.authorization) ??
    headerValue(request.headers["x-openclaw-gateway-token"]) ??
    headerValue(request.headers["x-delivrix-token"]) ??
    tokenQueryParam(request.url);
  return typeof supplied === "string" && safeTokenEqual(supplied, expectedToken);
}

function bearerToken(value: string | string[] | undefined): string | null {
  const normalized = headerValue(value);
  if (!normalized) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(normalized.trim());
  return match?.[1] ?? null;
}

function tokenQueryParam(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const parsed = new URL(url, "http://127.0.0.1");
  return parsed.searchParams.get("token");
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function rejectWebSocket(socket: Socket, statusCode: number, reason: string): void {
  const body = JSON.stringify({ error: reason.toLowerCase(), message: reason });
  socket.end([
    `HTTP/1.1 ${statusCode} ${reason}`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body
  ].join("\r\n"));
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, "utf8");
  const records: unknown[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      records.push(JSON.parse(trimmed) as unknown);
    } catch (error) {
      console.warn("[canvas-live] skipped corrupt JSONL line", {
        filePath,
        line: index + 1,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return records;
}

function isArtifactDecisionRecord(raw: unknown): raw is CanvasLiveArtifactDecisionRecord {
  return isRecord(raw) &&
    (raw.type === "oc.artifact.approved" || raw.type === "oc.artifact.rejected") &&
    typeof raw.artifactId === "string" &&
    typeof raw.actorId === "string" &&
    typeof raw.occurredAt === "string";
}

function assertActorId(actorId: unknown): asserts actorId is string {
  if (!stringValue(actorId)) {
    throw new CanvasLiveStateError(422, "invalid_actor_id", "actorId is required.");
  }
}

function normalizeTaskStatus(value: unknown): CanvasLiveTaskStatus {
  if (value === "running" || value === "idle" || value === "awaiting_approval" || value === "completed" || value === "failed") {
    return value;
  }
  throw new CanvasLiveStateError(422, "invalid_task_status", "Invalid task status.");
}

function normalizeArtifactKind(value: unknown): CanvasLiveArtifactKind {
  if (value === "plan" || value === "proposal" || value === "template" || value === "report") return value;
  throw new CanvasLiveStateError(422, "invalid_artifact_kind", "Invalid artifact kind.");
}

function normalizeBlockKind(value: unknown): CanvasLiveArtifactBlockKind {
  if (value === "step" || value === "title" || value === "paragraph" || value === "table_row" || value === "code") return value;
  throw new CanvasLiveStateError(422, "invalid_artifact_block_kind", "Invalid artifact block kind.");
}

function normalizeBlockStatus(value: unknown): CanvasLiveArtifactBlockStatus {
  if (value === "complete" || value === "streaming") return value;
  throw new CanvasLiveStateError(422, "invalid_artifact_block_status", "Invalid artifact block status.");
}

function normalizeCanvasTaskTitle(title: string): string {
  const normalized = title.trim();
  return taskTitleDisplayLabels[normalized] ?? title;
}

const taskTitleDisplayLabels: Record<string, string> = {
  "B8 B9 finish T5 T6 cleanup": "Cierre demo SMTP staging (T5+T6)",
  "B8 finish": "Cierre Bloque 8 — provisioning",
  "B9 finish": "Cierre Bloque 9 — extractor de intent",
  "T7B extractor": "Extractor de intent",
  "T7C supervisor": "Supervisor multi-agent"
};

function normalizeRiskLevel(value: unknown): "low" | "medium" | "high" | "critical" {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
  return "low";
}

function requiredId(value: unknown, field: string): string {
  const normalized = normalizeId(value);
  if (!normalized) {
    throw new CanvasLiveStateError(422, "invalid_identifier", `${field} is required.`);
  }
  return normalized;
}

function optionalParentTaskId(raw: Record<string, unknown>, taskId: string): { parentTaskId?: string } {
  const parentTaskId = normalizeId(raw.parentTaskId ?? raw.parent_task_id);
  if (!parentTaskId || parentTaskId === taskId) {
    return {};
  }
  return { parentTaskId };
}

function normalizeId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(trimmed) ? trimmed : "";
}

function requiredString(value: unknown, field: string): string {
  const normalized = stringValue(value);
  if (!normalized) {
    throw new CanvasLiveStateError(422, "invalid_string", `${field} is required.`);
  }
  return normalized;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CanvasLiveStateError(422, "invalid_string", `${field} is required.`);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeSnapshotBlockOrder(value: unknown, fallback: number): number {
  return isPositiveIntegerValue(value) ? Number(value) : fallback;
}

function isPositiveIntegerValue(value: unknown): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CanvasLiveStateError(422, "invalid_number", `${field} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CanvasLiveStateError(422, "invalid_number", `${field} must be a non-negative integer.`);
  }
  return parsed;
}

function normalizeDate(value: unknown, now: () => Date): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return now().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

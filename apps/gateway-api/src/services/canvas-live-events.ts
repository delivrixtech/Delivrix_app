import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import type {
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
  CanvasLiveStateSnapshot,
  CanvasLiveTaskDeclareEvent,
  CanvasLiveTaskSnapshot,
  CanvasLiveTaskStatus,
  CanvasLiveTaskUpdateEvent
} from "../../../../packages/domain/src/index.ts";

const defaultStateDir = "state/canvas-live";
const tasksFileName = "tasks.jsonl";
const artifactsFileName = "artifacts.jsonl";

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

export class CanvasLiveEventService {
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly clients = new Set<ClientEntry>();
  private readonly tasks = new Map<string, CanvasLiveTaskSnapshot>();
  private readonly artifacts = new Map<string, CanvasLiveArtifactSnapshot>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeQueue = Promise.resolve();

  constructor(options: CanvasLiveEventServiceOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? process.env.CANVAS_LIVE_STATE_DIR ?? defaultStateDir);
    this.now = options.now ?? (() => new Date());
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

    return {
      schemaVersion: "2026-05-25.canvas-live.v1",
      generatedAt: this.now().toISOString(),
      tasks,
      artifacts
    };
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
      content: input.content,
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
          content: block.content,
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
      }),
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
    await this.loadPromise;
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
      existing.content += event.chunk;
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
      content: requiredText(raw.content, "content"),
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
      chunk: requiredText(raw.chunk, "chunk"),
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
      url: requiredString(raw.url, "url"),
      status: positiveInteger(raw.status, "status"),
      durationMs: nonNegativeInteger(raw.durationMs, "durationMs"),
      responseBytes: nonNegativeInteger(raw.responseBytes, "responseBytes"),
      ...(raw.responseBody === undefined ? {} : { responseBody: raw.responseBody }),
      ...(isRecord(raw.next) ? { next: normalizeActionNext(raw.next) } : {}),
      occurredAt
    };
  }
  if (raw.kind === "file") {
    return {
      type: "oc.action.now",
      taskId,
      kind: "file",
      operation: requiredString(raw.operation, "operation"),
      path: requiredString(raw.path, "path"),
      ...(typeof raw.diffSummary === "string" ? { diffSummary: raw.diffSummary } : {}),
      ...(typeof raw.preview === "string" ? { preview: raw.preview } : {}),
      occurredAt
    };
  }
  if (raw.kind === "command") {
    return {
      type: "oc.action.now",
      taskId,
      kind: "command",
      cmd: requiredString(raw.cmd, "cmd"),
      exitCode: Number.isInteger(raw.exitCode) ? Number(raw.exitCode) : 0,
      stdout: typeof raw.stdout === "string" ? raw.stdout : "",
      stderr: typeof raw.stderr === "string" ? raw.stderr : "",
      durationMs: nonNegativeInteger(raw.durationMs, "durationMs"),
      ...(typeof raw.progressDetail === "string" ? { progressDetail: raw.progressDetail } : {}),
      occurredAt
    };
  }
  if (raw.kind === "audit") {
    return {
      type: "oc.action.now",
      taskId,
      kind: "audit",
      action: requiredString(raw.action, "action"),
      targetType: requiredString(raw.targetType, "targetType"),
      targetId: requiredString(raw.targetId, "targetId"),
      riskLevel: normalizeRiskLevel(raw.riskLevel),
      occurredAt
    };
  }
  throw new CanvasLiveStateError(422, "invalid_action_kind", "kind must be api, file, audit, or command.");
}

function normalizeActionNext(raw: Record<string, unknown>) {
  const kind = raw.kind;
  if (kind !== "api" && kind !== "file" && kind !== "audit" && kind !== "command") {
    throw new CanvasLiveStateError(422, "invalid_next_action_kind", "next.kind is invalid.");
  }
  return {
    kind,
    ...(typeof raw.method === "string" ? { method: raw.method.toUpperCase() } : {}),
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    ...(typeof raw.context === "string" ? { context: raw.context } : {}),
    ...(typeof raw.operation === "string" ? { operation: raw.operation } : {}),
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
    ...(typeof raw.cmd === "string" ? { cmd: raw.cmd } : {})
  };
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

  constructor(
    socket: Socket,
    onClose: (client: CanvasLiveEventClient) => void
  ) {
    this.socket = socket;
    this.onClose = onClose;
    socket.on("data", (chunk: Buffer) => {
      if (hasCloseFrame(chunk)) {
        this.close();
      }
    });
    socket.on("close", () => {
      this.closed = true;
      this.onClose(this);
    });
    socket.on("error", () => {
      this.closed = true;
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
    this.socket.end(encodeWebSocketCloseFrame());
  }
}

function encodeWebSocketTextFrame(text: string): Buffer {
  return encodeWebSocketFrame(0x1, Buffer.from(text, "utf8"));
}

function encodeWebSocketCloseFrame(): Buffer {
  return encodeWebSocketFrame(0x8, Buffer.alloc(0));
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

function isWebSocketUpgrade(request: IncomingMessage): boolean {
  return request.headers.upgrade?.toLowerCase() === "websocket";
}

async function readJsonl(filePath: string): Promise<unknown[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
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

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import type { CanvasLiveEvent } from "../../../../packages/domain/src/index.ts";
import { CanvasLiveEventService } from "../services/canvas-live-events.ts";
import {
  handleCanvasArtifactApproveHttp,
  handleCanvasArtifactBlockPatchHttp,
  handleCanvasArtifactRejectHttp,
  handleCanvasLiveError,
  handleCanvasLiveEventIngestHttp,
  handleCanvasLiveStateHttp
} from "./canvas-live.ts";

const fixedNow = new Date("2026-05-25T22:00:00.000Z");

test("WSS /v1/canvas/live/stream connects and receives events in order", async () => {
  const service = await testService();
  const socket = connectFakeSocket(service, "/v1/canvas/live/stream");

  await service.emit(taskDeclare("task-a"));
  await service.emit(taskUpdate("task-a", "completed"));
  const messages = socket.messages();

  assert.deepEqual(messages.map((event) => event.type), ["oc.task.declare", "oc.task.update"]);
  assert.equal(messages[0].taskId, "task-a");
  assert.ok(socket.handshake().includes("101 Switching Protocols"));
  service.close();
});

test("WSS task filter only receives matching task events", async () => {
  const service = await testService();
  const socket = connectFakeSocket(service, "/v1/canvas/live/stream?task=task-a");

  await service.emit(taskDeclare("task-b"));
  await service.emit(taskDeclare("task-a"));
  const messages = socket.messages();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].taskId, "task-a");
  service.close();
});

test("oc.action.now supports api, file, and command events", async () => {
  const service = await testService();
  await service.emit(taskDeclare("task-action"));
  const api = await service.emit({
    type: "oc.action.now",
    taskId: "task-action",
    kind: "api",
    method: "GET",
    url: "https://example.test/health",
    status: 200,
    durationMs: 12,
    responseBytes: 42,
    responseBody: { ok: true },
    next: {
      kind: "api",
      method: "GET",
      url: "https://example.test/next",
      context: "next-domain"
    },
    occurredAt: fixedNow.toISOString()
  });
  const file = await service.emit({
    type: "oc.action.now",
    taskId: "task-action",
    kind: "file",
    operation: "write",
    path: "/var/openclaw/state/demo.json",
    diffSummary: "+ 2 lines · - 0 lines",
    preview: "{\"ok\":true}",
    occurredAt: fixedNow.toISOString()
  });
  const command = await service.emit({
    type: "oc.action.now",
    taskId: "task-action",
    kind: "command",
    cmd: "dig +short TXT _dmarc.example.test",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 312,
    occurredAt: fixedNow.toISOString()
  });

  assert.equal(api.kind, "api");
  assert.equal(file.kind, "file");
  assert.equal(command.kind, "command");
  const snapshot = await service.snapshot();
  assert.equal(snapshot.tasks[0].lastAction?.kind, "command");
});

test("task update preserves last action for completed live tasks", async () => {
  const service = await testService();
  await service.emit(taskDeclare("task-preserve-action"));
  await service.emit({
    type: "oc.action.now",
    taskId: "task-preserve-action",
    kind: "api",
    method: "GET",
    url: "/v1/infrastructure/inventory#ionos-domains",
    status: 200,
    durationMs: 42,
    responseBytes: 128,
    responseBody: { domains: 16 },
    occurredAt: fixedNow.toISOString()
  });
  await service.emit(taskUpdate("task-preserve-action", "completed"));

  const snapshot = await service.snapshot();
  assert.equal(snapshot.tasks[0].status, "completed");
  assert.equal(snapshot.tasks[0].lastAction?.kind, "api");
  assert.equal(snapshot.tasks[0].lastAction?.taskId, "task-preserve-action");
});

test("task hierarchy preserves parentTaskId in live snapshot and reload", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  await service.emit(taskDeclare("batch-parent"));
  await service.emit({
    ...taskDeclare("batch-child"),
    parent_task_id: "batch-parent"
  });
  await service.emit(taskUpdate("batch-child", "completed"));

  const snapshot = await service.snapshot();
  assert.equal(snapshot.tasks.find((task) => task.taskId === "batch-child")?.parentTaskId, "batch-parent");

  const reloaded = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  const reloadedSnapshot = await reloaded.snapshot();
  assert.equal(reloadedSnapshot.tasks.find((task) => task.taskId === "batch-child")?.parentTaskId, "batch-parent");
});

test("canvas-live reload preserves last action for completed tasks", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  await service.emit(taskDeclare("task-reload-action"));
  await service.emit({
    type: "oc.action.now",
    taskId: "task-reload-action",
    kind: "api",
    method: "GET",
    url: "/v1/domains/prices?tlds=net",
    status: 200,
    durationMs: 42,
    responseBytes: 128,
    responseBody: { prices: [{ tld: "net" }] },
    occurredAt: fixedNow.toISOString()
  });
  await service.emit(taskUpdate("task-reload-action", "completed"));

  const reloaded = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  const snapshot = await reloaded.snapshot();

  assert.equal(snapshot.tasks[0].status, "completed");
  assert.equal(snapshot.tasks[0].lastAction?.kind, "api");
  assert.equal(snapshot.tasks[0].lastAction?.taskId, "task-reload-action");
});

test("artifact streaming accumulates chunks and closes with complete block", async () => {
  const service = await testService();
  await service.emit(taskDeclare("task-stream"));
  await service.emit(artifactDeclare("task-stream", "artifact-stream"));
  await service.emit({
    type: "oc.artifact.streaming",
    artifactId: "artifact-stream",
    blockId: "step-01",
    chunk: "Validar con dig ",
    occurredAt: fixedNow.toISOString()
  });
  await service.emit({
    type: "oc.artifact.streaming",
    artifactId: "artifact-stream",
    blockId: "step-01",
    chunk: "que el TXT existe",
    occurredAt: fixedNow.toISOString()
  });

  let snapshot = await service.snapshot();
  assert.equal(snapshot.artifacts[0].blocks[0].content, "Validar con dig que el TXT existe");
  assert.equal(snapshot.artifacts[0].blocks[0].status, "streaming");

  await service.emit(artifactBlock("artifact-stream", "step-01", "Validar con dig que el TXT existe", "complete"));
  snapshot = await service.snapshot();
  assert.equal(snapshot.artifacts[0].blocks[0].status, "complete");
});

test("approve/reject endpoints validate actorId, audit critical events, and persist state", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-audit-")), "audit.jsonl"));
  await seedArtifact(service, "task-approve", "artifact-approve");
  await runRoute(
    (request, response) => handleCanvasArtifactApproveHttp({
      request,
      response,
      service,
      auditLog
    }, "artifact-approve"),
    {
      method: "POST",
      url: "/v1/canvas/artifact/artifact-approve/approve",
      body: {
        actorId: "operator/juanes",
        blocks: [{ blockId: "step-01", content: "Plan aprobado" }]
      }
    }
  );

  await seedArtifact(service, "task-reject", "artifact-reject");
  await runRoute(
    (request, response) => handleCanvasArtifactRejectHttp({
      request,
      response,
      service,
      auditLog
    }, "artifact-reject"),
    {
      method: "POST",
      url: "/v1/canvas/artifact/artifact-reject/reject",
      body: {
        actorId: "operator/juanes",
        reason: "Ajustar alcance"
      }
    }
  );

  const events = await auditLog.list();
  assert.deepEqual(events.map((event) => event.action), ["oc.artifact.approved", "oc.artifact.rejected"]);
  assert.equal(events[0].riskLevel, "critical");

  const reloaded = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  const snapshot = await reloaded.snapshot();
  assert.equal(snapshot.artifacts.find((artifact) => artifact.artifactId === "artifact-approve")?.approvalStatus, "approved");
  assert.equal(snapshot.artifacts.find((artifact) => artifact.artifactId === "artifact-reject")?.approvalStatus, "rejected");
});

test("approve endpoint rejects missing actorId before audit append", async () => {
  const service = await testService();
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-invalid-audit-")), "audit.jsonl"));
  await seedArtifact(service, "task-invalid", "artifact-invalid");

  const response = await runRoute(
    (request, response) => handleCanvasArtifactApproveHttp({
      request,
      response,
      service,
      auditLog
    }, "artifact-invalid"),
    {
      method: "POST",
      url: "/v1/canvas/artifact/artifact-invalid/approve",
      body: {
        actorId: "",
        blocks: [{ blockId: "step-01", content: "Plan aprobado" }]
      }
    }
  );

  assert.equal(response.statusCode, 422);
  assert.equal(response.body.error, "invalid_actor_id");
  assert.equal((await auditLog.list()).length, 0);
});

test("PATCH block updates content without marking artifact approved", async () => {
  const service = await testService();
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-patch-audit-")), "audit.jsonl"));
  await seedArtifact(service, "task-patch", "artifact-patch");

  const response = await runRoute(
    (request, response) => handleCanvasArtifactBlockPatchHttp({
      request,
      response,
      service,
      auditLog
    }, "artifact-patch", "step-01"),
    {
      method: "PATCH",
      url: "/v1/canvas/artifact/artifact-patch/block/step-01",
      body: {
        actorId: "operator/juanes",
        content: "Contenido editado"
      }
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  const snapshot = await service.snapshot();
  assert.equal(snapshot.artifacts[0].blocks[0].content, "Contenido editado");
  assert.equal(snapshot.artifacts[0].approvalStatus, "pending");
  const events = await auditLog.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "oc.artifact.block_edited");
});

test("GET /v1/canvas/live/state returns persisted snapshot", async () => {
  const service = await testService();
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-state-audit-")), "audit.jsonl"));
  await seedArtifact(service, "task-state", "artifact-state");
  const response = await runRoute(
    (request, response) => handleCanvasLiveStateHttp({
      request,
      response,
      service,
      auditLog
    }),
    {
      method: "GET",
      url: "/v1/canvas/live/state"
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.schemaVersion, "2026-05-25.canvas-live.v1");
  assert.equal(response.body.tasks.length, 1);
  assert.equal(response.body.artifacts.length, 1);
});

test("POST /v1/canvas/live/events ingests events without writing audit chain", async () => {
  const service = await testService();
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-ingest-audit-")), "audit.jsonl"));
  const response = await runRoute(
    (request, response) => handleCanvasLiveEventIngestHttp({
      request,
      response,
      service,
      auditLog
    }),
    {
      method: "POST",
      url: "/v1/canvas/live/events",
      headers: process.env.OPENCLAW_GATEWAY_TOKEN
        ? { authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}` }
        : {},
      body: taskDeclare("task-ingest")
    }
  );

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.eventCount, 1);
  assert.equal((await auditLog.list()).length, 0);
});

test("canvas-live state writes append-only JSONL files", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  await seedArtifact(service, "task-jsonl", "artifact-jsonl");

  const tasks = await readFile(join(stateDir, "tasks.jsonl"), "utf8");
  const artifacts = await readFile(join(stateDir, "artifacts.jsonl"), "utf8");
  assert.equal(tasks.trim().split("\n").length, 1);
  assert.equal(artifacts.trim().split("\n").length, 2);
});

async function seedArtifact(
  service: CanvasLiveEventService,
  taskId: string,
  artifactId: string
): Promise<void> {
  await service.emit(taskDeclare(taskId));
  await service.emit(artifactDeclare(taskId, artifactId));
  await service.emit(artifactBlock(artifactId, "step-01", "Paso inicial", "complete"));
}

function taskDeclare(taskId: string): CanvasLiveEvent {
  return {
    type: "oc.task.declare",
    taskId,
    title: `Task ${taskId}`,
    status: "running",
    createdAt: fixedNow.toISOString(),
    actorId: "openclaw/openclaw-hostinger-prod"
  };
}

function taskUpdate(taskId: string, status: "completed" | "failed" | "idle" | "awaiting_approval"): CanvasLiveEvent {
  return {
    type: "oc.task.update",
    taskId,
    status,
    updatedAt: fixedNow.toISOString()
  };
}

function artifactDeclare(taskId: string, artifactId: string): CanvasLiveEvent {
  return {
    type: "oc.artifact.declare",
    taskId,
    artifactId,
    kind: "plan",
    title: "Plan editable",
    editable: true,
    createdAt: fixedNow.toISOString()
  };
}

function artifactBlock(
  artifactId: string,
  blockId: string,
  content: string,
  status: "complete" | "streaming"
): CanvasLiveEvent {
  return {
    type: "oc.artifact.block",
    artifactId,
    blockId,
    order: 1,
    kind: "step",
    content,
    editable: true,
    status,
    occurredAt: fixedNow.toISOString()
  };
}

async function testService(): Promise<CanvasLiveEventService> {
  return new CanvasLiveEventService({
    stateDir: await stateDirForTest(),
    now: () => fixedNow
  });
}

async function stateDirForTest(): Promise<string> {
  return mkdtemp(join(tmpdir(), "canvas-live-state-"));
}

async function runRoute(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  input: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }
): Promise<{ statusCode: number; body: any }> {
  const response = captureResponse();
  const request = requestWithBody(input);
  try {
    await handler(request, response as unknown as ServerResponse);
  } catch (error) {
    if (!handleCanvasLiveError(error, response as unknown as ServerResponse)) {
      throw error;
    }
  }
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body)
  };
}

function requestWithBody(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const raw = input.body === undefined ? "" : JSON.stringify(input.body);
  const request = Readable.from(raw ? [raw] : []) as IncomingMessage;
  request.method = input.method;
  request.url = input.url;
  request.headers = input.headers ?? {};
  return request;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}

function connectFakeSocket(service: CanvasLiveEventService, path: string): FakeSocket {
  const request = {
    method: "GET",
    url: path,
    headers: {
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ=="
    }
  } as unknown as IncomingMessage;
  const socket = new FakeSocket();
  service.acceptPanelSocket(request, socket as unknown as Socket);
  return socket;
}

class FakeSocket extends EventEmitter {
  private readonly writes: Array<string | Buffer> = [];

  write(chunk: string | Buffer): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) {
      this.writes.push(chunk);
    }
    this.emit("close");
  }

  destroy(): void {
    this.emit("close");
  }

  unshift(chunk: Buffer): void {
    this.writes.push(chunk);
  }

  handshake(): string {
    return this.writes
      .filter((chunk): chunk is string => typeof chunk === "string")
      .join("");
  }

  messages(): CanvasLiveEvent[] {
    return this.writes
      .filter((chunk): chunk is Buffer => Buffer.isBuffer(chunk) && (chunk[0] & 0x0f) === 0x1)
      .map((chunk) => JSON.parse(decodeTextFrame(chunk)) as CanvasLiveEvent);
  }
}

function decodeTextFrame(frame: Buffer): string {
  const second = frame[1];
  let offset = 2;
  let length = second & 0x7f;
  if (length === 126) {
    length = frame.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(frame.readBigUInt64BE(offset));
    offset += 8;
  }
  return frame.subarray(offset, offset + length).toString("utf8");
}

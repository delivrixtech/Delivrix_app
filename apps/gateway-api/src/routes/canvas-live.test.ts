import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("WSS /v1/canvas/live/stream rejects missing token", async () => {
  const service = await testService();
  const socket = connectFakeSocket(service, "/v1/canvas/live/stream", null);

  assert.ok(socket.handshake().includes("401 Unauthorized"));
  await service.emit(taskDeclare("task-unauthorized"));
  assert.equal(socket.messages().length, 0);
  service.close();
});

test("WSS /v1/canvas/live/stream heartbeats with ping and responds to client ping", async () => {
  const service = await testService({ heartbeatIntervalMs: 5 });
  const socket = connectFakeSocket(service, "/v1/canvas/live/stream");

  await wait(20);
  assert.ok(socket.frames(0x09).length >= 1);

  socket.emit("data", Buffer.from([0x89, 0x00]));
  assert.ok(socket.frames(0x0a).length >= 1);
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

test("oc.action.now redacts secrets before broadcast, snapshot, and JSONL persistence", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({
    stateDir,
    now: () => fixedNow,
    streamToken: "canvas-token"
  });
  const socket = connectFakeSocket(service, "/v1/canvas/live/stream");
  await service.emit(taskDeclare("task-redact"));
  await service.emit({
    type: "oc.action.now",
    taskId: "task-redact",
    kind: "api",
    method: "POST",
    url: "https://api.example.test/run?token=canvas-secret-token",
    status: 200,
    durationMs: 10,
    responseBytes: 128,
    responseBody: {
      ok: true,
      token: "canvas-secret-token",
      nested: {
        sessionToken: "session-secret-value",
        message: "Authorization: Bearer bearer-secret-value"
      }
    },
    occurredAt: fixedNow.toISOString()
  });
  await service.emit({
    type: "oc.action.now",
    taskId: "task-redact",
    kind: "command",
    cmd: "curl -H 'Authorization: Bearer bearer-secret-value' https://api.example.test",
    exitCode: 0,
    stdout: "signature=sig-secret-value",
    stderr: "private_key=private-secret-value",
    durationMs: 4,
    occurredAt: fixedNow.toISOString()
  });

  const snapshot = await service.snapshot();
  const persisted = await readFile(join(stateDir, "tasks.jsonl"), "utf8");
  const broadcast = JSON.stringify(socket.messages());
  const combined = `${JSON.stringify(snapshot)}\n${persisted}\n${broadcast}`;

  assert.doesNotMatch(combined, /canvas-secret-token/);
  assert.doesNotMatch(combined, /session-secret-value/);
  assert.doesNotMatch(combined, /bearer-secret-value/);
  assert.doesNotMatch(combined, /sig-secret-value/);
  assert.doesNotMatch(combined, /private-secret-value/);
  assert.match(combined, /\[REDACTED\]/);
  service.close();
});

test("audit action metadata survives broadcast, snapshot, and JSONL persistence with redaction", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({
    stateDir,
    now: () => fixedNow,
    streamToken: "canvas-token"
  });
  const socket = connectFakeSocket(service, "/v1/canvas/live/stream");

  await service.emit(taskDeclare("task-audit-metadata"));
  const event = await service.emit({
    type: "oc.action.now",
    taskId: "task-audit-metadata",
    kind: "audit",
    action: "oc.orchestrator.creation_rate_exceeded",
    targetType: "webdock_account",
    targetId: "ops",
    riskLevel: "critical",
    metadata: {
      accountId: "ops",
      createdInWindow: 4,
      cap: 4,
      apiKey: "canvas-secret-token"
    },
    occurredAt: fixedNow.toISOString()
  });

  const emittedMetadata = event.kind === "audit" ? event.metadata : undefined;
  const snapshot = await service.snapshot();
  const persisted = await readFile(join(stateDir, "tasks.jsonl"), "utf8");
  const broadcast = JSON.stringify(socket.messages());
  const combined = `${JSON.stringify(snapshot)}\n${persisted}\n${broadcast}`;

  assert.deepEqual(emittedMetadata, {
    accountId: "ops",
    createdInWindow: 4,
    cap: 4,
    apiKey: "[REDACTED]"
  });
  assert.equal(snapshot.tasks[0].lastAction?.kind, "audit");
  assert.deepEqual(snapshot.tasks[0].lastAction?.kind === "audit" ? snapshot.tasks[0].lastAction.metadata : undefined, emittedMetadata);
  assert.match(persisted, /"metadata"/);
  assert.match(broadcast, /creation_rate_exceeded/);
  assert.doesNotMatch(combined, /canvas-secret-token/);
  service.close();
});

test("Canvas Live redacts complete and truncated DKIM PEM before broadcast, snapshot, and JSONL persistence", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({
    stateDir,
    now: () => fixedNow,
    streamToken: "canvas-token"
  });
  const socket = connectFakeSocket(service, "/v1/canvas/live/stream");
  const completePem = generatedPrivateKeyPem();
  const pemLine = pemBodyLine(completePem);
  const truncatedPem = completePem.slice(0, 500);

  assert.equal(truncatedPem.includes("-----BEGIN PRIVATE KEY-----"), true);
  assert.equal(truncatedPem.includes("-----END PRIVATE KEY-----"), false);

  await service.emit(taskDeclare("task-redact-pem"));
  await service.emit({
    type: "oc.action.now",
    taskId: "task-redact-pem",
    kind: "api",
    method: "POST",
    url: "https://api.example.test/provision",
    status: 424,
    durationMs: 12,
    responseBytes: 256,
    responseBody: {
      ok: false,
      error: completePem,
      nested: { stderr: truncatedPem }
    },
    occurredAt: fixedNow.toISOString()
  });
  await service.emit({
    type: "oc.action.now",
    taskId: "task-redact-pem",
    kind: "command",
    cmd: "opendkim-testkey -d example.test -s default",
    exitCode: 1,
    stdout: completePem,
    stderr: truncatedPem,
    durationMs: 8,
    occurredAt: fixedNow.toISOString()
  });
  await service.emit({
    type: "oc.artifact.declare",
    taskId: "task-redact-pem",
    artifactId: "artifact-redact-pem",
    kind: "report",
    title: "PEM redaction check",
    editable: false,
    createdAt: fixedNow.toISOString()
  });
  await service.emit({
    type: "oc.artifact.block",
    artifactId: "artifact-redact-pem",
    blockId: "block-complete",
    order: 1,
    kind: "paragraph",
    content: completePem,
    editable: false,
    status: "complete",
    occurredAt: fixedNow.toISOString()
  });
  await service.emit({
    type: "oc.artifact.streaming",
    artifactId: "artifact-redact-pem",
    blockId: "block-partial",
    chunk: truncatedPem,
    occurredAt: fixedNow.toISOString()
  });

  const snapshot = await service.snapshot();
  const tasksJsonl = await readFile(join(stateDir, "tasks.jsonl"), "utf8");
  const artifactsJsonl = await readFile(join(stateDir, "artifacts.jsonl"), "utf8");
  const combined = [
    JSON.stringify(socket.messages()),
    JSON.stringify(snapshot),
    tasksJsonl,
    artifactsJsonl
  ].join("\n");

  assert.doesNotMatch(combined, /-----BEGIN PRIVATE KEY-----/);
  assert.doesNotMatch(combined, /-----END PRIVATE KEY-----/);
  assert.equal(combined.includes(pemLine), false);
  assert.match(combined, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(combined, /\[REDACTED_PARTIAL_KEY\]/);
  service.close();
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

test("canvas-live normalizes known internal task titles to operator labels", async () => {
  const service = await testService();
  await service.emit({
    ...taskDeclare("task-b8"),
    title: "B8 B9 finish T5 T6 cleanup"
  });

  const snapshot = await service.snapshot();

  assert.equal(snapshot.tasks[0].title, "Cierre demo SMTP staging (T5+T6)");
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
  const pem = generatedPrivateKeyPem();
  const pemLine = pemBodyLine(pem);
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
        blocks: [{ blockId: "step-01", content: pem }]
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
  const approvedBlockContent = snapshot.artifacts.find((artifact) => artifact.artifactId === "artifact-approve")?.blocks[0]?.content ?? "";
  assert.equal(approvedBlockContent.includes(pemLine), false);
  assert.match(approvedBlockContent, /\[REDACTED_PRIVATE_KEY\]/);
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
  const pem = generatedPrivateKeyPem();
  const pemLine = pemBodyLine(pem);
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
        content: pem.slice(0, 500)
      }
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  const snapshot = await service.snapshot();
  assert.equal(snapshot.artifacts[0].blocks[0].content.includes(pemLine), false);
  assert.match(snapshot.artifacts[0].blocks[0].content, /\[REDACTED_PARTIAL_KEY\]/);
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
      auditLog,
      readBoundaryToken: "read-token"
    }),
    {
      method: "GET",
      url: "/v1/canvas/live/state",
      headers: { "x-delivrix-token": "read-token" }
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.schemaVersion, "2026-05-25.canvas-live.v1");
  assert.equal(response.body.tasks.length, 1);
  assert.equal(response.body.artifacts.length, 1);
});

test("GET /v1/canvas/live/state rejects missing read boundary token", async () => {
  const service = await testService();
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-state-audit-")), "audit.jsonl"));
  const response = await runRoute(
    (request, response) => handleCanvasLiveStateHttp({
      request,
      response,
      service,
      auditLog,
      readBoundaryToken: "read-token"
    }),
    {
      method: "GET",
      url: "/v1/canvas/live/state"
    }
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, "read_boundary_token_invalid");
  const events = await auditLog.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "oc.canvas_live_state.read_denied");
  assert.equal(events[0].decision, "reject");
});

test("POST /v1/canvas/live/events ingests events without writing audit chain", async () => {
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = "canvas-token";
  const service = await testService();
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-ingest-audit-")), "audit.jsonl"));
  let response: Awaited<ReturnType<typeof runRoute>>;
  try {
    response = await runRoute(
      (request, response) => handleCanvasLiveEventIngestHttp({
        request,
        response,
        service,
        auditLog
      }),
      {
        method: "POST",
        url: "/v1/canvas/live/events",
        headers: { authorization: "Bearer canvas-token" },
        body: taskDeclare("task-ingest")
      }
    );
  } finally {
    process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
  }

  assert.equal(response.statusCode, 202);
  assert.equal(response.body.eventCount, 1);
  assert.equal((await auditLog.list()).length, 0);
});

test("POST /v1/canvas/live/events fails closed when gateway token is unconfigured", async () => {
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  const service = await testService();
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-ingest-closed-audit-")), "audit.jsonl"));
  let response: Awaited<ReturnType<typeof runRoute>>;
  try {
    response = await runRoute(
      (request, response) => handleCanvasLiveEventIngestHttp({
        request,
        response,
        service,
        auditLog
      }),
      {
        method: "POST",
        url: "/v1/canvas/live/events",
        body: taskDeclare("task-ingest-closed")
      }
    );
  } finally {
    process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
  }

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error, "canvas_live_unauthorized");
  assert.equal((await service.snapshot()).tasks.length, 0);
});

test("POST /v1/canvas/live/events rejects batches over the event cap before persisting", async () => {
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousMaxEvents = process.env.CANVAS_LIVE_EVENTS_MAX_EVENTS;
  process.env.OPENCLAW_GATEWAY_TOKEN = "canvas-token";
  process.env.CANVAS_LIVE_EVENTS_MAX_EVENTS = "1";
  const service = await testService();
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-ingest-cap-audit-")), "audit.jsonl"));
  let response: Awaited<ReturnType<typeof runRoute>>;
  try {
    response = await runRoute(
      (request, response) => handleCanvasLiveEventIngestHttp({
        request,
        response,
        service,
        auditLog
      }),
      {
        method: "POST",
        url: "/v1/canvas/live/events",
        headers: { authorization: "Bearer canvas-token" },
        body: { events: [taskDeclare("task-cap-a"), taskDeclare("task-cap-b")] }
      }
    );
  } finally {
    process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
    process.env.CANVAS_LIVE_EVENTS_MAX_EVENTS = previousMaxEvents;
  }

  assert.equal(response.statusCode, 413);
  assert.equal(response.body.error, "canvas_live_events_too_many");
  assert.equal((await service.snapshot()).tasks.length, 0);
});

test("POST /v1/canvas/live/events rejects request bodies over the byte cap", async () => {
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousMaxBytes = process.env.CANVAS_LIVE_EVENTS_MAX_BODY_BYTES;
  process.env.OPENCLAW_GATEWAY_TOKEN = "canvas-token";
  process.env.CANVAS_LIVE_EVENTS_MAX_BODY_BYTES = "32";
  const service = await testService();
  const auditLog = new LocalFileAuditLog(join(await mkdtemp(join(tmpdir(), "canvas-live-ingest-size-audit-")), "audit.jsonl"));
  let response: Awaited<ReturnType<typeof runRoute>>;
  try {
    response = await runRoute(
      (request, response) => handleCanvasLiveEventIngestHttp({
        request,
        response,
        service,
        auditLog
      }),
      {
        method: "POST",
        url: "/v1/canvas/live/events",
        headers: { authorization: "Bearer canvas-token" },
        body: taskDeclare("task-body-too-large")
      }
    );
  } finally {
    process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
    process.env.CANVAS_LIVE_EVENTS_MAX_BODY_BYTES = previousMaxBytes;
  }

  assert.equal(response.statusCode, 413);
  assert.equal(response.body.error, "request_body_too_large");
  assert.equal((await service.snapshot()).tasks.length, 0);
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

test("canvas-live reload skips corrupt JSONL lines and keeps valid records", async () => {
  const stateDir = await stateDirForTest();
  await writeFile(join(stateDir, "tasks.jsonl"), [
    JSON.stringify(taskDeclare("task-valid-a")),
    "{not valid json",
    JSON.stringify(taskUpdate("task-valid-a", "completed")),
    ""
  ].join("\n"), "utf8");

  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  const snapshot = await service.snapshot();

  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].taskId, "task-valid-a");
  assert.equal(snapshot.tasks[0].status, "completed");
});

test("canvas-live reload retries after a failed disk load instead of caching the rejection", async () => {
  const stateDir = await stateDirForTest();
  await mkdir(join(stateDir, "tasks.jsonl"));
  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });

  await assert.rejects(() => service.snapshot());
  await rm(join(stateDir, "tasks.jsonl"), { recursive: true, force: true });
  await writeFile(join(stateDir, "tasks.jsonl"), `${JSON.stringify(taskDeclare("task-retry"))}\n`, "utf8");

  const snapshot = await service.snapshot();
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(snapshot.tasks[0].taskId, "task-retry");
});

test("canvas-live reload repairs legacy artifact blocks with non-positive order", async () => {
  const stateDir = await stateDirForTest();
  await writeFile(join(stateDir, "artifacts.jsonl"), [
    JSON.stringify({
      type: "oc.artifact.declare",
      taskId: "task-legacy",
      artifactId: "artifact-legacy",
      kind: "proposal",
      title: "Legacy proposal",
      editable: true,
      createdAt: fixedNow.toISOString()
    }),
    JSON.stringify({
      type: "oc.artifact.block",
      artifactId: "artifact-legacy",
      blockId: "summary",
      order: 0,
      kind: "paragraph",
      content: "Legacy summary",
      editable: true,
      status: "complete",
      occurredAt: fixedNow.toISOString()
    })
  ].join("\n"), "utf8");

  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  const snapshot = await service.snapshot();

  assert.equal(snapshot.artifacts[0].blocks[0].order, 1);
});

test("canvas-live snapshot includes flat SMTP progress for filtered task runs", async () => {
  const readerInputs: Array<{ taskId?: string; runIds: string[] }> = [];
  const service = new CanvasLiveEventService({
    stateDir: await stateDirForTest(),
    now: () => fixedNow,
    streamToken: "canvas-token",
    smtpProgressReader: async (input) => {
      readerInputs.push(input);
      return input.runIds.map((runId) => ({
        runId,
        status: "running",
        lastCompletedStep: 1,
        steps: [
          { step: 1, skill: "suggest_safe_domain", status: "done", durationMs: 14 },
          { step: 2, skill: "register_domain_route53", status: "in_flight", error: "waiting_for_route53_operation" }
        ],
        identity: {
          domain: "annualrenewalnational.com",
          smtpHost: "smtp.annualrenewalnational.com",
          serverIpv4: "203.0.113.42",
          dkimSelector: "s2026a",
          dkimPublicKey: "PUBLICKEY",
          dnsRecords: [
            { name: "smtp.annualrenewalnational.com", type: "A", value: "203.0.113.42" }
          ]
        }
      }));
    }
  });

  await service.emit(taskDeclare("run-a"));
  await service.emit(taskDeclare("run-b"));

  const filtered = await service.snapshot("run-b");
  assert.deepEqual(readerInputs.at(-1), { taskId: "run-b", runIds: ["run-b"] });
  assert.deepEqual(filtered.progress, [{
    runId: "run-b",
    status: "running",
    lastCompletedStep: 1,
    steps: [
      { step: 1, skill: "suggest_safe_domain", status: "done", durationMs: 14 },
      { step: 2, skill: "register_domain_route53", status: "in_flight", error: "waiting_for_route53_operation" }
    ],
    identity: {
      domain: "annualrenewalnational.com",
      smtpHost: "smtp.annualrenewalnational.com",
      serverIpv4: "203.0.113.42",
      dkimSelector: "s2026a",
      dkimPublicKey: "PUBLICKEY",
      dnsRecords: [
        { name: "smtp.annualrenewalnational.com", type: "A", value: "203.0.113.42" }
      ]
    }
  }]);

  const missingTask = await service.snapshot("run-without-canvas-task");
  assert.deepEqual(readerInputs.at(-1), {
    taskId: "run-without-canvas-task",
    runIds: ["run-without-canvas-task"]
  });
  assert.equal(missingTask.tasks.length, 0);
  assert.equal(missingTask.progress?.[0]?.runId, "run-without-canvas-task");
});

test("canvas-live upsertArtifactSnapshot normalizes non-positive block order before persisting", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  const pem = generatedPrivateKeyPem();
  const pemLine = pemBodyLine(pem);
  await service.upsertArtifactSnapshot({
    artifactId: "artifact-upsert-order",
    taskId: "task-upsert-order",
    kind: "proposal",
    title: "Proposal with fallback block",
    editable: true,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    approvalStatus: "approved",
    approvedBy: "operator-juanes",
    approvedAt: fixedNow.toISOString(),
    executionId: "sig-test",
    blocks: [{
      blockId: "summary",
      order: 0,
      kind: "paragraph",
      content: pem,
      editable: true,
      status: "complete",
      updatedAt: fixedNow.toISOString()
    }]
  });

  const snapshot = await service.snapshot();
  const artifacts = await readFile(join(stateDir, "artifacts.jsonl"), "utf8");

  assert.equal(snapshot.artifacts[0].blocks[0].order, 1);
  assert.equal(snapshot.artifacts[0].blocks[0].content.includes(pemLine), false);
  assert.match(snapshot.artifacts[0].blocks[0].content, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(artifacts, /"order":1/);
  assert.equal(artifacts.includes(pemLine), false);
});

test("canvas-live upsertArtifactSnapshot persists typed payload with version and redaction", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  const pem = generatedPrivateKeyPem();
  const pemLine = pemBodyLine(pem);
  const later = new Date("2026-05-25T22:05:00.000Z");

  await service.upsertArtifactSnapshot({
    artifactId: "dns-zone-delivrix-test",
    taskId: "task-dns-zone",
    kind: "dns_zone",
    title: "Zona DNS delivrix.test",
    editable: false,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    approvalStatus: "pending",
    blocks: [],
    payload: {
      kind: "dns_zone",
      domain: "delivrix.test",
      records: [
        { name: "smtp.delivrix.test", type: "A", value: "203.0.113.10" },
        { name: "s2026a._domainkey.delivrix.test", type: "TXT", value: pem }
      ]
    }
  });

  await service.upsertArtifactSnapshot({
    artifactId: "dns-zone-delivrix-test",
    taskId: "task-dns-zone",
    kind: "dns_zone",
    title: "Zona DNS delivrix.test",
    editable: false,
    createdAt: later.toISOString(),
    updatedAt: later.toISOString(),
    approvalStatus: "pending",
    blocks: [],
    payload: {
      kind: "dns_zone",
      domain: "delivrix.test",
      records: [
        { name: "smtp.delivrix.test", type: "A", value: "203.0.113.10" }
      ]
    }
  });

  const snapshot = await service.snapshot();
  const artifact = snapshot.artifacts[0];
  assert.equal(artifact.artifactId, "dns-zone-delivrix-test");
  assert.equal(artifact.kind, "dns_zone");
  assert.equal(artifact.version, 2);
  assert.equal(artifact.createdAt, fixedNow.toISOString());
  assert.equal(artifact.updatedAt, later.toISOString());
  assert.equal(artifact.payload?.kind, "dns_zone");
  assert.deepEqual(artifact.payload?.records, [
    { name: "smtp.delivrix.test", type: "A", value: "203.0.113.10" }
  ]);

  const persisted = await readFile(join(stateDir, "artifacts.jsonl"), "utf8");
  assert.match(persisted, /"version":2/);
  assert.match(persisted, /"updatedAt":"2026-05-25T22:05:00.000Z"/);
  assert.equal(persisted.includes(pemLine), false);
  assert.match(persisted, /\[REDACTED_PRIVATE_KEY\]/);

  const reloaded = new CanvasLiveEventService({ stateDir, now: () => later });
  const reloadedArtifact = (await reloaded.snapshot()).artifacts[0];
  assert.equal(reloadedArtifact.version, 2);
  assert.equal(reloadedArtifact.updatedAt, later.toISOString());
  assert.equal(reloadedArtifact.payload?.kind, "dns_zone");
  assert.equal(JSON.stringify(reloadedArtifact).includes(pemLine), false);
});

test("canvas-live persists SMTP credential artifact without credential material", async () => {
  const stateDir = await stateDirForTest();
  const service = new CanvasLiveEventService({ stateDir, now: () => fixedNow });

  await service.upsertArtifactSnapshot({
    artifactId: "smtp-credential-example-mail.com",
    taskId: "task-smtp-credential",
    kind: "smtp_credential",
    title: "Credencial SMTP example-mail.com",
    editable: false,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    approvalStatus: "pending",
    blocks: [],
    payload: {
      kind: "smtp_credential",
      domain: "example-mail.com",
      host: "smtp.example-mail.com",
      username: "mailer@example-mail.com",
      ports: { submission: 587, smtps: 465 },
      hasCredential: true,
      password: "smtp-password-must-not-ship",
      smtpCredentialEncrypted: {
        ciphertext: "ciphertext-must-not-ship",
        authTag: "auth-tag-must-not-ship"
      }
    } as any
  });

  const snapshot = await service.snapshot();
  const artifact = snapshot.artifacts[0];
  assert.equal(artifact.kind, "smtp_credential");
  assert.deepEqual(artifact.payload, {
    kind: "smtp_credential",
    domain: "example-mail.com",
    host: "smtp.example-mail.com",
    username: "mailer@example-mail.com",
    ports: { submission: 587, smtps: 465 },
    hasCredential: true
  });

  const persisted = await readFile(join(stateDir, "artifacts.jsonl"), "utf8");
  const reloaded = new CanvasLiveEventService({ stateDir, now: () => fixedNow });
  const reloadedArtifact = (await reloaded.snapshot()).artifacts[0];
  const combined = `${JSON.stringify(snapshot)}\n${persisted}\n${JSON.stringify(reloadedArtifact)}`;

  assert.doesNotMatch(combined, /smtp-password-must-not-ship/);
  assert.doesNotMatch(combined, /ciphertext-must-not-ship/);
  assert.doesNotMatch(combined, /auth-tag-must-not-ship/);
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

async function testService(options: { heartbeatIntervalMs?: number } = {}): Promise<CanvasLiveEventService> {
  return new CanvasLiveEventService({
    stateDir: await stateDirForTest(),
    now: () => fixedNow,
    streamToken: "canvas-token",
    ...options
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

function connectFakeSocket(service: CanvasLiveEventService, path: string, token: string | null = "canvas-token"): FakeSocket {
  const url = new URL(path, "http://127.0.0.1");
  if (token) {
    url.searchParams.set("token", token);
  }
  const request = {
    method: "GET",
    url: `${url.pathname}${url.search}`,
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

  frames(opcode: number): Buffer[] {
    return this.writes
      .filter((chunk): chunk is Buffer => Buffer.isBuffer(chunk) && (chunk[0] & 0x0f) === opcode);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generatedPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  }).privateKey;
}

function pemBodyLine(pem: string): string {
  const line = pem.split(/\r?\n/).find((candidate) => /^[A-Za-z0-9+/]{48,}={0,2}$/.test(candidate));
  assert.ok(line);
  return line;
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

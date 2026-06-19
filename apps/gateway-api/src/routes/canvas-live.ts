import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEventInput,
  CanvasArtifactApproveInput,
  CanvasArtifactBlockPatchInput,
  CanvasArtifactRejectInput,
  CanvasLiveEvent
} from "../../../../packages/domain/src/index.ts";
import {
  CanvasLiveEventService,
  CanvasLiveStateError
} from "../services/canvas-live-events.ts";
import {
  positiveIntegerOrDefault,
  readRequestBody,
  RequestBodyTooLargeError,
  defaultMaxRequestBodyBytes
} from "../request-body.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

const defaultMaxCanvasLiveEventsPerIngest = 100;

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface CanvasLiveRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  service: CanvasLiveEventService;
  auditLog: AuditSink;
  readBoundaryToken?: string;
}

export async function handleCanvasLiveStateHttp(deps: CanvasLiveRouteDependencies): Promise<void> {
  const url = new URL(deps.request.url ?? "/", "http://127.0.0.1");
  const taskId = normalizeOptionalId(url.searchParams.get("task"));
  const auth = authorizeSensitiveRead(deps.request, { readBoundaryToken: deps.readBoundaryToken }, "canvas_live_state");
  if (!auth.ok) {
    await deps.auditLog.append({
      actorType: "system",
      actorId: "read-boundary",
      action: "oc.canvas_live_state.read_denied",
      targetType: "canvas_live_state",
      targetId: taskId ?? "all",
      riskLevel: "medium",
      decision: "reject",
      rejectReason: auth.error,
      metadata: {
        statusCode: auth.statusCode
      }
    });
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  json(deps.response, 200, await deps.service.snapshot(taskId));
}

export async function handleCanvasLiveEventIngestHttp(deps: CanvasLiveRouteDependencies): Promise<void> {
  if (!isAuthorizedOpenClawEmitter(deps.request)) {
    json(deps.response, 401, {
      error: "canvas_live_unauthorized",
      message: "Missing or invalid OpenClaw gateway token."
    });
    return;
  }

  const body = await readJson<CanvasLiveEvent | { events?: unknown[] }>(deps.request);
  const rawEvents = isRecord(body) && Array.isArray(body.events) ? body.events : [body];
  const maxEvents = maxCanvasLiveEventsPerIngest();
  if (rawEvents.length > maxEvents) {
    throw new CanvasLiveStateError(
      413,
      "canvas_live_events_too_many",
      `Canvas live event ingest accepts at most ${maxEvents} events per request.`
    );
  }
  const events: CanvasLiveEvent[] = [];
  for (const rawEvent of rawEvents) {
    events.push(await deps.service.emit(rawEvent));
  }

  json(deps.response, 202, {
    ok: true,
    eventCount: events.length,
    events
  });
}

export async function handleCanvasArtifactApproveHttp(
  deps: CanvasLiveRouteDependencies,
  artifactId: string
): Promise<void> {
  const body = await readJson<CanvasArtifactApproveInput>(deps.request);
  const result = await deps.service.approveArtifact({
    artifactId,
    actorId: body.actorId,
    blocks: body.blocks
  });

  await deps.auditLog.append({
    actorType: "operator",
    actorId: body.actorId,
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: artifactId,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [body.actorId],
    metadata: {
      executionId: result.executionId,
      blockCount: body.blocks.length
    }
  });

  json(deps.response, 200, {
    ok: true,
    executionId: result.executionId
  });
}

export async function handleCanvasArtifactRejectHttp(
  deps: CanvasLiveRouteDependencies,
  artifactId: string
): Promise<void> {
  const body = await readJson<CanvasArtifactRejectInput>(deps.request);
  const result = await deps.service.rejectArtifact({
    artifactId,
    actorId: body.actorId,
    reason: body.reason
  });

  await deps.auditLog.append({
    actorType: "operator",
    actorId: body.actorId,
    action: "oc.artifact.rejected",
    targetType: "canvas_artifact",
    targetId: artifactId,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [body.actorId],
    metadata: {
      reason: body.reason,
      rejectedAt: result.occurredAt
    }
  });

  json(deps.response, 200, { ok: true });
}

export async function handleCanvasArtifactBlockPatchHttp(
  deps: CanvasLiveRouteDependencies,
  artifactId: string,
  blockId: string
): Promise<void> {
  const body = await readJson<CanvasArtifactBlockPatchInput>(deps.request);
  const result = await deps.service.patchBlock({
    artifactId,
    blockId,
    actorId: body.actorId,
    content: body.content
  });

  await deps.auditLog.append({
    actorType: "operator",
    actorId: body.actorId,
    action: "oc.artifact.block_edited",
    targetType: "canvas_artifact_block",
    targetId: `${artifactId}:${blockId}`,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [body.actorId],
    metadata: {
      artifactId,
      blockId,
      contentLength: body.content.length,
      updatedAt: result.updatedAt
    }
  });

  json(deps.response, 200, {
    ok: true,
    updatedAt: result.updatedAt
  });
}

export function routeCanvasArtifactMutation(
  deps: CanvasLiveRouteDependencies
): Promise<void> | null {
  const url = new URL(deps.request.url ?? "/", "http://127.0.0.1");
  const approveMatch = url.pathname.match(/^\/v1\/canvas\/artifact\/([^/]+)\/approve$/);
  if (deps.request.method === "POST" && approveMatch) {
    return handleCanvasArtifactApproveHttp(deps, decodeURIComponent(approveMatch[1]));
  }

  const rejectMatch = url.pathname.match(/^\/v1\/canvas\/artifact\/([^/]+)\/reject$/);
  if (deps.request.method === "POST" && rejectMatch) {
    return handleCanvasArtifactRejectHttp(deps, decodeURIComponent(rejectMatch[1]));
  }

  const patchMatch = url.pathname.match(/^\/v1\/canvas\/artifact\/([^/]+)\/block\/([^/]+)$/);
  if (deps.request.method === "PATCH" && patchMatch) {
    return handleCanvasArtifactBlockPatchHttp(
      deps,
      decodeURIComponent(patchMatch[1]),
      decodeURIComponent(patchMatch[2])
    );
  }

  return null;
}

export function handleCanvasLiveError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof CanvasLiveStateError) {
    json(response, error.statusCode, {
      error: error.code,
      message: error.message
    });
    return true;
  }

  if (error instanceof RequestBodyTooLargeError) {
    json(response, error.statusCode, {
      error: error.code,
      message: error.message,
      maxBytes: error.maxBytes
    });
    return true;
  }

  if (error instanceof SyntaxError) {
    json(response, 400, {
      error: "invalid_json",
      message: "Request body must be valid JSON."
    });
    return true;
  }

  return false;
}

function isAuthorizedOpenClawEmitter(request: IncomingMessage): boolean {
  const expected = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!expected) {
    return false;
  }
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  const headerToken = typeof request.headers["x-openclaw-gateway-token"] === "string"
    ? request.headers["x-openclaw-gateway-token"]
    : "";
  return safeTokenEqual(bearer, expected) || safeTokenEqual(headerToken, expected);
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeOptionalId(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request, {
    maxBytes: positiveIntegerOrDefault(
      process.env.CANVAS_LIVE_EVENTS_MAX_BODY_BYTES,
      defaultMaxRequestBodyBytes
    )
  });
  if (!raw) {
    throw new CanvasLiveStateError(400, "body_required", "Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function maxCanvasLiveEventsPerIngest(): number {
  return positiveIntegerOrDefault(
    process.env.CANVAS_LIVE_EVENTS_MAX_EVENTS,
    defaultMaxCanvasLiveEventsPerIngest
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

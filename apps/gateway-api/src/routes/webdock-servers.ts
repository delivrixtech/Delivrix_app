import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  WebdockCreateServerInput,
  WebdockCreateServerResult,
  WebdockDeleteServerResult,
  WebdockInventoryResult,
  WebdockProvisionImageSlug,
  WebdockProvisionProfile,
  WebdockServer
} from "../../../../packages/adapters/src/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import type {
  OpenClawWorkspace,
  OpenClawWorkspaceFileRef
} from "../openclaw-workspace.ts";
import {
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken
} from "../approval-guard.ts";
import { readRequestBody } from "../request-body.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

export interface WebdockServerCreateAdapter {
  isLive(): boolean;
  canWrite?(): boolean;
  canCreate?(): boolean;
  createServer(opts: WebdockCreateServerInput): Promise<WebdockCreateServerResult>;
  getServer(slug: string): Promise<WebdockServer>;
  listServers?(): Promise<WebdockInventoryResult>;
  ensureServerSshAccess?(opts: {
    serverSlug: string;
    publicKey: string;
    username?: string;
  }): Promise<{
    publicKeyId: number;
    username: string;
    shellUserId: number | null;
    shellUserEventId: string | null;
    sshSettingsEventId: string | null;
  }>;
}

export interface WebdockServerDeleteAdapter {
  isLive(): boolean;
  canWrite?(): boolean;
  deleteServer(slug: string): Promise<WebdockDeleteServerResult>;
}

export interface WebdockServerCreateDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  adapter: WebdockServerCreateAdapter;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface WebdockServerCreateBody {
  profile?: unknown;
  locationId?: unknown;
  hostname?: unknown;
  imageSlug?: unknown;
  publicKey?: unknown;
  callbackUrl?: unknown;
  runId?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  taskId?: unknown;
  pollIntervalMs?: unknown;
  maxPolls?: unknown;
}

export interface WebdockServerDeleteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  adapter: WebdockServerDeleteAdapter;
  /**
   * Registry write-capable id->adapter (5.12 multicuenta). Si la cuenta pedida (body.accountId o
   * el arg accountId) esta aqui, el delete va a ESA cuenta; si no, cae al `adapter` escalar
   * (cuenta-1 "ops") => byte-identico al delete previo cuando no hay multicuenta.
   */
  accountAdapters?: Map<string, WebdockServerDeleteAdapter>;
  /** Cuenta destino del delete cuando no viene en el body. undefined/"ops" => `adapter`. */
  accountId?: string;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  serverSlug: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface WebdockServerDeleteBody {
  actorId?: unknown;
  approvalToken?: unknown;
  taskId?: unknown;
  reason?: unknown;
  accountId?: unknown;
}

interface WebdockServerInventory {
  servers?: Array<{
    slug: string;
    hostname: string;
    locationId: string;
    profile: WebdockProvisionProfile;
    imageSlug: WebdockProvisionImageSlug;
    publicKeyFingerprint: string;
    status: string;
    eventId: string;
    ipv4: string | null;
    sshUsername?: string;
    publicKeyId?: number;
    createdAt: string;
    updatedAt: string;
    port25UnlockRequired: true;
  }>;
  deletedServers?: Array<{
    slug: string;
    eventId: string;
    status: string;
    reason: string;
    deletedAt: string;
  }>;
  runBindings?: Array<{
    runId: string;
    serverSlug: string;
    domain: string;
    boundAt: string;
    source: "created" | "idempotent_already_exists";
  }>;
}

const skillName = "provision_webdock_vps";
const approvalMaxAgeMs = 15 * 60 * 1000;
const defaultPollIntervalMs = 5_000;
const defaultMaxPolls = 24;

export async function handleWebdockServerCreateHttp(
  deps: WebdockServerCreateDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const body = await readJson<WebdockServerCreateBody>(deps.request);
  const profile = normalizeProfile(body.profile);
  const locationId = normalizeId(requiredString(body.locationId, "locationId"), "locationId");
  const hostname = normalizeHostname(requiredString(body.hostname, "hostname"));
  const imageSlug = normalizeImageSlug(body.imageSlug);
  const publicKey = normalizePublicKey(
    typeof body.publicKey === "string" && body.publicKey.trim()
      ? body.publicKey
      : env.WEBDOCK_OPERATOR_SSH_PUBLIC_KEY
  );
  const callbackUrl = normalizeOptionalUrl(body.callbackUrl);
  const runId = normalizeTaskId(body.runId);
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const taskId = normalizeTaskId(body.taskId) ?? `webdock-create-${randomUUID()}`;
  const pollIntervalMs = normalizePollInterval(body.pollIntervalMs);
  const maxPolls = normalizeMaxPolls(body.maxPolls);

  await emitTaskDeclare(deps.canvasLiveEvents, taskId, `Webdock VPS · ${hostname}`, actorId, now);
  const learnings = await safeReadLearnings(deps.workspace);
  await emitFileAction(deps.canvasLiveEvents, taskId, "read", "learnings/", `learnings:${learnings.length}`, now);

  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  const blockers: string[] = [];
  const canWrite =
    typeof deps.adapter.canCreate === "function"
      ? deps.adapter.canCreate()
      : typeof deps.adapter.canWrite === "function"
      ? deps.adapter.canWrite()
      : deps.adapter.isLive();
  if (!canWrite) blockers.push("webdock_ops_key_missing");
  if (env.WEBDOCK_SERVERS_ENABLE_CREATE !== "true") blockers.push("webdock_create_flag_disabled");
  if (!approval) blockers.push("approval_not_found_or_expired");

  const publicKeyFingerprint = fingerprintPublicKey(publicKey);

  if (blockers.length > 0) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { profile, locationId, hostname, imageSlug, actorId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers,
        publicKeyFingerprint,
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.webdock.server_create_blocked",
      targetType: "webdock_server",
      targetId: hostname,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        blockers,
        provider: "webdock",
        profile,
        locationId,
        imageSlug,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.webdock.server_create_blocked", "webdock_server", hostname, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      blockers,
      hostname,
      workspace
    });
    return;
  }

  try {
    const existing = await resolveExistingServerForCreate(deps.adapter, hostname);
    if (existing.status === "blocked") {
      const workspace = await safeWriteExecution(deps.workspace, {
        skill: skillName,
        params: { profile, locationId, hostname, imageSlug, actorId, runId },
        outcome: "blocked",
        durationMs: Date.now() - startedAt,
        evidence: {
          blockers: existing.blockers,
          publicKeyFingerprint,
          learningCount: learnings.length
        }
      });
      await deps.auditLog.append({
        actorType: "operator",
        actorId,
        action: "oc.webdock.server_create_blocked",
        targetType: "webdock_server",
        targetId: hostname,
        riskLevel: "critical",
        decision: "reject",
        humanApproved: false,
        metadata: {
          blockers: existing.blockers,
          provider: "webdock",
          profile,
          locationId,
          imageSlug,
          idempotenceCheck: true,
          workspacePath: workspace?.path
        }
      });
      await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.webdock.server_create_blocked", "webdock_server", hostname, "critical", now);
      await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
      json(deps.response, 409, {
        ok: false,
        status: "blocked",
        blockers: existing.blockers,
        hostname,
        workspace
      });
      return;
    }

    if (existing.status === "reuse") {
      const server = existing.server;
      const ipv4 = server.ipv4 || null;
      await updateWebdockInventory(deps.workspace, {
        slug: server.slug,
        hostname,
        locationId: server.location ?? locationId,
        profile: normalizeInventoryProfile(server.profileSlug) ?? profile,
        imageSlug: normalizeInventoryImageSlug(server.imageSlug) ?? imageSlug,
        publicKeyFingerprint,
        status: server.status,
        eventId: "idempotent_already_exists",
        ipv4,
        createdAt: server.creationDate ?? now.toISOString(),
        updatedAt: (deps.now?.() ?? new Date()).toISOString(),
        port25UnlockRequired: true
      });
      if (runId) {
        await upsertWebdockRunBinding(deps.workspace, {
          runId,
          serverSlug: server.slug,
          domain: hostname,
          boundAt: (deps.now?.() ?? new Date()).toISOString(),
          source: "idempotent_already_exists"
        });
      }
      const workspace = await safeWriteExecution(deps.workspace, {
        skill: skillName,
        params: { profile, locationId, hostname, imageSlug, actorId, runId },
        outcome: "success",
        durationMs: Date.now() - startedAt,
        evidence: {
          status: "idempotent_already_exists",
          serverSlug: server.slug,
          ipv4,
          costUsd: 0,
          publicKeyFingerprint,
          learningCount: learnings.length
        }
      });
      await deps.auditLog.append({
        actorType: "operator",
        actorId,
        action: "oc.webdock.create_idempotent",
        targetType: "webdock_server",
        targetId: server.slug,
        riskLevel: "critical",
        decision: "allow",
        humanApproved: true,
        approverIds: [actorId],
        metadata: {
          provider: "webdock",
          hostname,
          serverSlug: server.slug,
          ipv4,
          status: "idempotent_already_exists",
          costUsd: 0,
          approvalToken,
          approvalArtifactId: approval?.artifactId,
          workspacePath: workspace?.path,
          runId
        }
      });
      await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.webdock.create_idempotent", "webdock_server", server.slug, "critical", deps.now?.() ?? new Date());
      await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", deps.now?.() ?? new Date());
      json(deps.response, 200, {
        ok: true,
        status: "idempotent_already_exists",
        serverSlug: server.slug,
        slug: server.slug,
        ipv4,
        costUsd: 0,
        pollCount: 0,
        workspace
      });
      return;
    }

    const created = await deps.adapter.createServer({
      profile,
      locationId,
      hostname,
      imageSlug,
      publicKey,
      callbackUrl,
      sshUsername: normalizeOptionalShellUsername(env.SMTP_PROVISION_SSH_USER ?? env.WEBDOCK_OPERATOR_SSH_USERNAME)
    });
    await emitApiAction(deps.canvasLiveEvents, taskId, "POST", "/v1/servers", 201, {
      serverSlug: created.serverSlug,
      eventId: created.eventId,
      status: created.status
    }, now);

    const polls = await pollProvisioning({
      adapter: deps.adapter,
      canvasLiveEvents: deps.canvasLiveEvents,
      taskId,
      serverSlug: created.serverSlug,
      initial: created,
      pollIntervalMs,
      maxPolls,
      sleep: deps.sleep ?? sleep,
      now: deps.now ?? (() => new Date())
    });
    const finalServer = polls.at(-1)?.server ?? null;
    const ipv4 = finalServer?.ipv4 || created.ipv4 || null;
    const status = finalServer?.status ?? created.status;
    const sshAccess = deps.adapter.ensureServerSshAccess
      ? await deps.adapter.ensureServerSshAccess({
          serverSlug: created.serverSlug,
          publicKey,
          username: normalizeOptionalShellUsername(env.SMTP_PROVISION_SSH_USER ?? env.WEBDOCK_OPERATOR_SSH_USERNAME)
        })
      : null;
    if (sshAccess) {
      await emitApiAction(deps.canvasLiveEvents, taskId, "POST", `/v1/servers/${created.serverSlug}/shellUsers`, 202, {
        publicKeyId: sshAccess.publicKeyId,
        username: sshAccess.username,
        shellUserId: sshAccess.shellUserId
      }, deps.now?.() ?? new Date());
      const settleMs = parseNonNegativeInteger(env.WEBDOCK_SSH_ACCESS_SETTLE_MS) ?? 20_000;
      if (settleMs > 0) {
        await (deps.sleep ?? sleep)(settleMs);
      }
    }

    await updateWebdockInventory(deps.workspace, {
      slug: created.serverSlug,
      hostname,
      locationId,
      profile,
      imageSlug,
      publicKeyFingerprint,
      status,
      eventId: created.eventId,
      ipv4,
      sshUsername: sshAccess?.username,
      publicKeyId: created.publicKeyId ?? sshAccess?.publicKeyId,
      createdAt: now.toISOString(),
      updatedAt: (deps.now?.() ?? new Date()).toISOString(),
      port25UnlockRequired: true
    });
    if (runId) {
      await upsertWebdockRunBinding(deps.workspace, {
        runId,
        serverSlug: created.serverSlug,
        domain: hostname,
        boundAt: (deps.now?.() ?? new Date()).toISOString(),
        source: "created"
      });
    }

    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { profile, locationId, hostname, imageSlug, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        serverSlug: created.serverSlug,
        eventId: created.eventId,
        ipv4,
        status,
        pollCount: polls.length,
        publicKeyFingerprint,
        publicKeyId: created.publicKeyId ?? sshAccess?.publicKeyId,
        sshUsername: sshAccess?.username,
        shellUserId: sshAccess?.shellUserId,
        shellUserEventId: sshAccess?.shellUserEventId,
        sshSettingsEventId: sshAccess?.sshSettingsEventId,
        port25UnlockRequired: true,
        learningCount: learnings.length
      }
    });
    await emitFileAction(deps.canvasLiveEvents, taskId, "write", workspace?.path ?? "executions/", "Webdock create execution record", deps.now?.() ?? new Date());

    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.webdock.server_created",
      targetType: "webdock_server",
      targetId: created.serverSlug,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "webdock",
        hostname,
        profile,
        locationId,
        imageSlug,
        eventId: created.eventId,
        status,
        ipv4,
        publicKeyFingerprint,
        publicKeyId: created.publicKeyId ?? sshAccess?.publicKeyId,
        sshUsername: sshAccess?.username,
        shellUserId: sshAccess?.shellUserId,
        shellUserEventId: sshAccess?.shellUserEventId,
        sshSettingsEventId: sshAccess?.sshSettingsEventId,
        port25UnlockRequired: true,
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.webdock.server_created", "webdock_server", created.serverSlug, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", deps.now?.() ?? new Date());

    json(deps.response, 200, {
      ok: true,
      status: status === "running" ? "running" : "provisioning",
      serverSlug: created.serverSlug,
      eventId: created.eventId,
      ipv4,
      publicKeyId: created.publicKeyId ?? sshAccess?.publicKeyId,
      sshUsername: sshAccess?.username,
      shellUserId: sshAccess?.shellUserId,
      pollCount: polls.length,
      port25UnlockRequired: true,
      workspace
    });
  } catch (error) {
    const failure = classifyWebdockServerCreateFailure(error);
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { profile, locationId, hostname, imageSlug, actorId },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: {
        error: failure.message,
        failureCode: failure.code,
        recoverable: failure.recoverable,
        operatorAction: failure.operatorAction,
        publicKeyFingerprint,
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.webdock.server_create_failed",
      targetType: "webdock_server",
      targetId: hostname,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "webdock",
        errorCode: failure.code,
        errorMessage: failure.message,
        recoverable: failure.recoverable,
        operatorAction: failure.operatorAction,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.webdock.server_create_failed", "webdock_server", hostname, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", deps.now?.() ?? new Date());
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      hostname,
      error: failure.code,
      message: failure.message,
      recoverable: failure.recoverable,
      operatorAction: failure.operatorAction,
      workspace
    });
  }
}

export async function handleWebdockServerDeleteHttp(
  deps: WebdockServerDeleteDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const serverSlug = normalizeServerSlug(deps.serverSlug);
  const body = await readJson<WebdockServerDeleteBody>(deps.request, WebdockServerDeleteInputError);
  const actorId = requiredString(body.actorId, "actorId", WebdockServerDeleteInputError);
  const approvalToken = requiredString(body.approvalToken, "approvalToken", WebdockServerDeleteInputError);
  const reason = requiredString(body.reason, "reason", WebdockServerDeleteInputError);
  const taskId = normalizeTaskId(body.taskId) ?? `webdock-delete-${randomUUID()}`;
  // Cuenta destino del delete (5.12): body.accountId tiene prioridad, luego el arg deps.accountId,
  // luego "ops". undefined/"ops"/desconocida => deps.adapter (cuenta-1) = byte-identico al delete previo.
  const requestedAccountId =
    (typeof body.accountId === "string" && body.accountId.trim()) || deps.accountId?.trim() || undefined;
  const adapter = resolveWebdockDeleteAdapter(deps, requestedAccountId);

  await emitTaskDeclare(deps.canvasLiveEvents, taskId, `Cleanup Webdock VPS · ${serverSlug}`, actorId, now);
  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  const blockers: string[] = [];
  const canWrite =
    typeof adapter.canWrite === "function"
      ? adapter.canWrite()
      : adapter.isLive();
  if (!canWrite) blockers.push("webdock_ops_key_missing");
  if (env.WEBDOCK_SERVERS_ENABLE_DELETE !== "true") blockers.push("webdock_delete_flag_disabled");
  if (!approval) blockers.push("approval_not_found_or_expired");

  if (blockers.length > 0) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: "cleanup_webdock_vps",
      params: { serverSlug, actorId, reason },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: { blockers }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.webdock.server_delete_blocked",
      targetType: "webdock_server",
      targetId: serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        blockers,
        provider: "webdock",
        reason,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.webdock.server_delete_blocked", "webdock_server", serverSlug, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      blockers,
      serverSlug,
      workspace
    });
    return;
  }

  try {
    const deleted = await adapter.deleteServer(serverSlug);
    await emitApiAction(deps.canvasLiveEvents, taskId, "DELETE", `/v1/servers/${serverSlug}`, 202, {
      serverSlug: deleted.serverSlug,
      eventId: deleted.eventId,
      status: deleted.status
    }, now);
    await markWebdockServerDeleted(deps.workspace, {
      slug: deleted.serverSlug,
      eventId: deleted.eventId,
      status: deleted.status,
      reason,
      deletedAt: now.toISOString()
    });

    const workspace = await safeWriteExecution(deps.workspace, {
      skill: "cleanup_webdock_vps",
      params: { serverSlug, actorId, reason },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        serverSlug: deleted.serverSlug,
        eventId: deleted.eventId,
        status: deleted.status
      }
    });
    await emitFileAction(deps.canvasLiveEvents, taskId, "write", workspace?.path ?? "executions/", "Webdock delete execution record", deps.now?.() ?? new Date());

    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.webdock.server_deleted",
      targetType: "webdock_server",
      targetId: deleted.serverSlug,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "webdock",
        eventId: deleted.eventId,
        status: deleted.status,
        reason,
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.webdock.server_deleted", "webdock_server", deleted.serverSlug, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", deps.now?.() ?? new Date());

    json(deps.response, 200, {
      ok: true,
      status: deleted.status,
      serverSlug: deleted.serverSlug,
      eventId: deleted.eventId,
      workspace
    });
  } catch (error) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: "cleanup_webdock_vps",
      params: { serverSlug, actorId, reason },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: { error: errorMessage(error) }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.webdock.server_delete_failed",
      targetType: "webdock_server",
      targetId: serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "webdock",
        reason,
        errorMessage: errorMessage(error),
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.webdock.server_delete_failed", "webdock_server", serverSlug, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", deps.now?.() ?? new Date());
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      serverSlug,
      error: "webdock_server_delete_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export class WebdockServerCreateInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "WebdockServerCreateInputError";
  }
}

export class WebdockServerDeleteInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "WebdockServerDeleteInputError";
  }
}

/**
 * Resuelve el adapter Webdock de delete para la cuenta pedida (5.12 multicuenta). undefined/"ops"/
 * cuenta-desconocida => el `adapter` escalar (cuenta-1 "ops"), byte-identico al delete previo.
 */
function resolveWebdockDeleteAdapter(
  deps: Pick<WebdockServerDeleteDependencies, "adapter" | "accountAdapters">,
  accountId: string | undefined
): WebdockServerDeleteAdapter {
  if (!accountId || accountId === "ops" || !deps.accountAdapters) {
    return deps.adapter;
  }
  return deps.accountAdapters.get(accountId) ?? deps.adapter;
}

export function handleWebdockServerCreateError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof WebdockServerCreateInputError) {
    json(response, error.statusCode, {
      error: "invalid_webdock_server_create_request",
      message: error.message
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

export function handleWebdockServerDeleteError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof WebdockServerDeleteInputError) {
    json(response, error.statusCode, {
      error: "invalid_webdock_server_delete_request",
      message: error.message
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

function classifyWebdockServerCreateFailure(error: unknown): {
  code: "webdock_payment_failed" | "webdock_server_create_failed";
  message: string;
  recoverable: boolean;
  operatorAction: string;
} {
  const message = errorMessage(error);
  if (/payment failed|payment method|service credit|enough credit/i.test(message)) {
    return {
      code: "webdock_payment_failed",
      message,
      recoverable: true,
      operatorAction: "add_or_fix_webdock_service_credit_then_rerun_configure_complete_smtp"
    };
  }
  return {
    code: "webdock_server_create_failed",
    message,
    recoverable: false,
    operatorAction: "inspect_webdock_create_workspace_evidence_and_provider_response"
  };
}

async function pollProvisioning(input: {
  adapter: WebdockServerCreateAdapter;
  canvasLiveEvents?: CanvasEmitter;
  taskId: string;
  serverSlug: string;
  initial: WebdockCreateServerResult;
  pollIntervalMs: number;
  maxPolls: number;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}): Promise<Array<{ attempt: number; server: WebdockServer }>> {
  const out: Array<{ attempt: number; server: WebdockServer }> = [];
  if (input.initial.status === "running" && input.initial.ipv4) {
    return out;
  }

  for (let attempt = 1; attempt <= input.maxPolls; attempt += 1) {
    if (attempt > 1 || input.pollIntervalMs > 0) {
      await input.sleep(input.pollIntervalMs);
    }
    const server = await input.adapter.getServer(input.serverSlug);
    out.push({ attempt, server });
    await emitApiAction(input.canvasLiveEvents, input.taskId, "GET", `/v1/servers/${input.serverSlug}`, 200, {
      attempt,
      status: server.status,
      ipv4: server.ipv4 || null
    }, input.now());
    if (server.status === "running" && server.ipv4) {
      break;
    }
  }
  return out;
}

async function resolveExistingServerForCreate(
  adapter: WebdockServerCreateAdapter,
  hostname: string
): Promise<
  | { status: "create" }
  | { status: "reuse"; server: WebdockServer }
  | { status: "blocked"; blockers: string[] }
> {
  if (!adapter.listServers) {
    return { status: "blocked", blockers: ["webdock_inventory_read_unavailable"] };
  }
  let inventory: WebdockInventoryResult;
  try {
    inventory = await adapter.listServers();
  } catch {
    return { status: "blocked", blockers: ["webdock_inventory_read_failed"] };
  }
  if (inventory.source.kind !== "live" || inventory.source.responseOk !== true) {
    return { status: "blocked", blockers: ["webdock_inventory_degraded"] };
  }
  const matches = dedupeServers(inventory.servers.filter((server) =>
    webdockServerMatchesHostname(server, hostname)
  ));
  if (matches.length === 0) return { status: "create" };
  if (matches.length > 1) {
    return { status: "blocked", blockers: ["webdock_existing_server_ambiguous"] };
  }
  const server = matches[0];
  if (!server.ipv4) {
    return { status: "blocked", blockers: ["webdock_existing_server_ipv4_missing"] };
  }
  return { status: "reuse", server };
}

function webdockServerMatchesHostname(server: WebdockServer, hostname: string): boolean {
  const target = normalizeDomainLoose(hostname);
  return [server.hostname, server.mainDomain]
    .map((value) => typeof value === "string" ? normalizeDomainLoose(value) : null)
    .some((value) => value === target);
}

function dedupeServers(servers: WebdockServer[]): WebdockServer[] {
  const seen = new Set<string>();
  const out: WebdockServer[] = [];
  for (const server of servers) {
    if (seen.has(server.slug)) continue;
    seen.add(server.slug);
    out.push(server);
  }
  return out;
}

function normalizeDomainLoose(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function normalizeInventoryProfile(value: string | undefined): WebdockProvisionProfile | null {
  return value === "bit" || value === "nibble" || value === "byte" || value === "kilobyte" ? value : null;
}

function normalizeInventoryImageSlug(value: string | undefined): WebdockProvisionImageSlug | null {
  return value === "ubuntu-2404" || value === "debian-12" ? value : null;
}

async function updateWebdockInventory(
  workspace: OpenClawWorkspace,
  input: NonNullable<WebdockServerInventory["servers"]>[number]
): Promise<void> {
  await workspace.updateInventoryJson<WebdockServerInventory>("webdock-servers.json", (current) => {
    const servers = (current?.servers ?? []).filter((server) => server.slug !== input.slug);
    servers.push(input);
    return { servers };
  });
}

async function upsertWebdockRunBinding(
  workspace: OpenClawWorkspace,
  input: NonNullable<WebdockServerInventory["runBindings"]>[number]
): Promise<void> {
  await workspace.updateInventoryJson<WebdockServerInventory>("webdock-servers.json", (current) => {
    const runBindings = (current?.runBindings ?? []).filter((binding) => binding.runId !== input.runId);
    runBindings.push(input);
    return {
      ...(current ?? {}),
      runBindings
    };
  });
}

async function markWebdockServerDeleted(
  workspace: OpenClawWorkspace,
  input: NonNullable<WebdockServerInventory["deletedServers"]>[number]
): Promise<void> {
  await workspace.updateInventoryJson<WebdockServerInventory>("webdock-servers.json", (current) => {
    const servers = (current?.servers ?? []).filter((server) => server.slug !== input.slug);
    const deletedServers = [
      ...(current?.deletedServers ?? []).filter((server) => server.slug !== input.slug),
      input
    ];
    return { servers, deletedServers };
  });
}

async function findRecentApproval(input: {
  auditLog: AuditSink;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  approvalToken: string;
  now: Date;
  maxAgeMs: number;
}) {
  if (!input.auditLog.list) return null;
  const events = await input.auditLog.list();
  const auditEvent = events.toReversed().find((event) => {
    if (!auditApprovalMatchesToken(event, input.approvalToken)) {
      return false;
    }
    const approvedAt = Date.parse(event.occurredAt);
    return Number.isFinite(approvedAt) && input.now.getTime() - approvedAt >= 0 && input.now.getTime() - approvedAt <= input.maxAgeMs;
  });
  if (!auditEvent) return null;

  const state = await input.readCanvasState();
  return state.artifacts.find((artifact) => {
    return artifactMatchesAuditApproval({
      artifact,
      approvalEvent: auditEvent,
      approvalToken: input.approvalToken,
      now: input.now,
      maxAgeMs: input.maxAgeMs
    });
  }) ?? null;
}

async function safeReadLearnings(workspace: OpenClawWorkspace) {
  try {
    return await workspace.readLearnings(skillName);
  } catch {
    return [];
  }
}

async function safeWriteExecution(
  workspace: OpenClawWorkspace,
  input: Parameters<OpenClawWorkspace["writeExecutionRecord"]>[0]
): Promise<OpenClawWorkspaceFileRef | null> {
  try {
    return await workspace.writeExecutionRecord(input);
  } catch {
    return null;
  }
}

async function emitTaskDeclare(service: CanvasEmitter | undefined, taskId: string, title: string, actorId: string, now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.task.declare", taskId, title, status: "running", createdAt: now.toISOString(), actorId });
}

async function emitTaskUpdate(service: CanvasEmitter | undefined, taskId: string, status: "completed" | "failed", now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.task.update", taskId, status, updatedAt: now.toISOString() });
}

async function emitApiAction(service: CanvasEmitter | undefined, taskId: string, method: string, url: string, status: number, responseBody: unknown, now: Date): Promise<void> {
  await safeEmit(service, {
    type: "oc.action.now",
    taskId,
    kind: "api",
    method,
    url,
    status,
    durationMs: 1,
    responseBytes: JSON.stringify(responseBody).length,
    responseBody,
    occurredAt: now.toISOString()
  });
}

async function emitFileAction(service: CanvasEmitter | undefined, taskId: string, operation: "read" | "write", path: string, preview: string, now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.action.now", taskId, kind: "file", operation, path, preview, occurredAt: now.toISOString() });
}

async function emitAuditAction(service: CanvasEmitter | undefined, taskId: string, action: string, targetType: string, targetId: string, riskLevel: "critical", now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.action.now", taskId, kind: "audit", action, targetType, targetId, riskLevel, occurredAt: now.toISOString() });
}

async function safeEmit(service: CanvasEmitter | undefined, event: CanvasLiveEvent): Promise<void> {
  if (!service) return;
  try {
    await service.emit(event);
  } catch {
    return;
  }
}

function normalizeProfile(value: unknown): WebdockProvisionProfile {
  if (value === "bit" || value === "nibble" || value === "byte" || value === "kilobyte") {
    return value;
  }
  throw new WebdockServerCreateInputError("profile must be bit, nibble, byte, or kilobyte.");
}

function normalizeImageSlug(value: unknown): WebdockProvisionImageSlug {
  if (value === "ubuntu-2404" || value === "debian-12") {
    return value;
  }
  throw new WebdockServerCreateInputError("imageSlug must be ubuntu-2404 or debian-12.");
}

function normalizeId(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new WebdockServerCreateInputError(`${field} must be provider id-safe.`);
  }
  return normalized;
}

function normalizeHostname(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new WebdockServerCreateInputError(`Invalid hostname: ${value}`);
  }
  return normalized;
}

function normalizeServerSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(normalized)) {
    throw new WebdockServerDeleteInputError(`Invalid serverSlug: ${value}`);
  }
  return normalized;
}

function normalizePublicKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new WebdockServerCreateInputError("publicKey is required.");
  }
  const trimmed = value.trim();
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: .*)?$/.test(trimmed)) {
    throw new WebdockServerCreateInputError("publicKey must be an OpenSSH public key.");
  }
  return trimmed;
}

function normalizeOptionalShellUsername(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[a-z0-9_]{1,32}$/.test(normalized) || normalized === "root") {
    throw new WebdockServerCreateInputError("SSH shell username must be a non-root Webdock-safe username.");
  }
  return normalized;
}

function normalizeOptionalUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new WebdockServerCreateInputError("callbackUrl must be a URL.");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new WebdockServerCreateInputError("callbackUrl must be https.");
    return url.toString();
  } catch (error) {
    if (error instanceof WebdockServerCreateInputError) throw error;
    throw new WebdockServerCreateInputError("callbackUrl must be a valid URL.");
  }
}

function normalizeTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(trimmed) ? trimmed : undefined;
}

function normalizePollInterval(value: unknown): number {
  if (value === undefined || value === null || value === "") return defaultPollIntervalMs;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 60_000) {
    throw new WebdockServerCreateInputError("pollIntervalMs must be an integer between 0 and 60000.");
  }
  return value;
}

function normalizeMaxPolls(value: unknown): number {
  if (value === undefined || value === null || value === "") return defaultMaxPolls;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 60) {
    throw new WebdockServerCreateInputError("maxPolls must be an integer between 0 and 60.");
  }
  return value;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function requiredString(
  value: unknown,
  field: string,
  ErrorCtor: new (message: string) => Error = WebdockServerCreateInputError
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ErrorCtor(`${field} is required.`);
  }
  return value.trim();
}

function fingerprintPublicKey(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson<T>(
  request: IncomingMessage,
  ErrorCtor: new (message: string) => Error = WebdockServerCreateInputError
): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new ErrorCtor("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Webdock create error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  VpsProvider,
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
import { getProviderFromServerIdentity } from "../server-provider.ts";
import type {
  SmtpInventoryLiveServer,
  SmtpInventoryMutationResult
} from "../smtp-inventory-management.ts";

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

/** Ledger de recursos (Provider Fabric fase C). Opcional y no-fatal: un fallo del ledger jamas rompe el flujo. */
export interface ProviderResourceLedgerSink {
  append(input: {
    provider: string;
    accountId: string;
    resourceType: string;
    externalId: string;
    action: "created" | "deleted";
    displayName?: string;
    flowId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
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
  /** Proveedor destino cuando el dispatcher enruta por canal paralelo. undefined/"webdock" conserva Webdock. */
  providerId?: string;
  /** Cuenta destino del create cuando el dispatcher enruta Webdock multicuenta. */
  serverAccountId?: string;
  resourceLedger?: ProviderResourceLedgerSink;
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
  resourceLedger?: ProviderResourceLedgerSink;
  adapter: WebdockServerDeleteAdapter;
  /**
   * Registry write-capable id->adapter (5.12 multicuenta). Si la cuenta pedida (body.accountId o
   * el arg accountId) esta aqui, el delete va a ESA cuenta; si no, cae al `adapter` escalar
   * (cuenta-1 "ops") => byte-identico al delete previo cuando no hay multicuenta.
   */
  accountAdapters?: Map<string, WebdockServerDeleteAdapter>;
  /**
   * Registry providerId->adapter para borrar en proveedores NO-Webdock (Contabo, etc.). Canal
   * PARALELO HERMANO de accountAdapters: si el providerId pedido (body.providerId o el arg providerId)
   * esta aqui y != "webdock", el delete va a ESE proveedor (rollback del VPS Contabo); si no, cae a la
   * logica Webdock por accountId SIN CAMBIOS. VpsProvider es asignable estructuralmente al delete adapter.
   */
  vpsProviderAdapters?: Map<string, VpsProvider>;
  /** Cuenta destino del delete cuando no viene en el body. undefined/"ops" => `adapter`. */
  accountId?: string;
  /** Proveedor destino del delete cuando no viene en el body. undefined/"webdock" => logica Webdock. */
  providerId?: string;
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
  providerId?: unknown;
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
    providerId?: string;
    serverAccountId?: string;
    boundAt: string;
    source: "created" | "idempotent_already_exists";
  }>;
}

const skillName = "provision_webdock_vps";
const approvalMaxAgeMs = 15 * 60 * 1000;
const defaultPollIntervalMs = 5_000;
const defaultMaxPolls = 24;
const defaultContaboPollIntervalMs = 10_000;
const defaultContaboMaxPolls = 60;

export async function handleWebdockServerCreateHttp(
  deps: WebdockServerCreateDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const body = await readJson<WebdockServerCreateBody>(deps.request);
  const providerId = normalizeRouteProviderId(deps.providerId);
  const providerLabel = providerId ?? "webdock";
  const bindingScope = {
    providerId: providerLabel,
    serverAccountId: normalizeRunBindingServerAccountId(deps.serverAccountId, providerLabel)
  };
  const polling = resolveProvisioningPolling({
    env,
    providerId,
    pollIntervalMs: body.pollIntervalMs,
    maxPolls: body.maxPolls
  });
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
  const pollIntervalMs = polling.pollIntervalMs;
  const maxPolls = polling.maxPolls;

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
        provider: providerLabel,
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
    const existing = await resolveExistingServerForCreate({
      adapter: deps.adapter,
      workspace: deps.workspace,
      hostname,
      runId,
      providerId: bindingScope.providerId,
      serverAccountId: bindingScope.serverAccountId,
      allowPendingIpReuse: providerId === "contabo"
    });
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
          provider: providerLabel,
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
          providerId: bindingScope.providerId,
          serverAccountId: bindingScope.serverAccountId,
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
          provider: providerLabel,
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

    if (deps.resourceLedger) {
      await deps.resourceLedger.append({
        provider: providerLabel,
        accountId: bindingScope.serverAccountId ?? providerLabel,
        resourceType: "vps_server",
        externalId: created.serverSlug,
        action: "created",
        displayName: hostname,
        ...(runId ? { flowId: runId } : {})
      }).catch(() => undefined);
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
        providerId: bindingScope.providerId,
        serverAccountId: bindingScope.serverAccountId,
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
        provider: providerLabel,
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
        provider: providerLabel,
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
  // Proveedor destino del delete (canal HERMANO): body.providerId tiene prioridad, luego deps.providerId.
  // undefined/"webdock"/desconocido => logica Webdock por accountId, SIN CAMBIOS.
  const requestedProviderId =
    (typeof body.providerId === "string" && body.providerId.trim()) || deps.providerId?.trim() || undefined;
  const adapter = resolveWebdockDeleteAdapter(deps, requestedAccountId, requestedProviderId);

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
    if (deps.resourceLedger) {
      await deps.resourceLedger.append({
        provider: requestedProviderId ?? "webdock",
        accountId: requestedAccountId ?? "ops",
        resourceType: "vps_server",
        externalId: deleted.serverSlug,
        action: "deleted",
        metadata: { reason }
      }).catch(() => undefined);
    }

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
 * Resuelve el adapter de delete para el provider/account pedido.
 *
 * PRECEDENCIA (canal HERMANO providerId primero): si providerId esta presente y != "webdock" y el
 * vpsProviderAdapters tiene esa key con un deleteServer() disponible, enruta a ESE proveedor (rollback
 * del VPS Contabo). En CUALQUIER otro caso cae a la logica Webdock por accountId EXISTENTE, SIN CAMBIOS:
 * undefined/"ops"/cuenta-desconocida => el `adapter` escalar (cuenta-1 "ops"), byte-identico al delete previo.
 */
function resolveWebdockDeleteAdapter(
  deps: Pick<WebdockServerDeleteDependencies, "adapter" | "accountAdapters" | "vpsProviderAdapters">,
  accountId: string | undefined,
  providerId?: string
): WebdockServerDeleteAdapter {
  // Normalizar a lowercase: la KEY del registry es lowercase ("contabo"); un providerId capitalizado
  // ("Contabo") debe seguir enrutando el rollback/delete al proveedor correcto.
  const provider = providerId?.trim().toLowerCase();
  if (provider && provider !== "webdock" && deps.vpsProviderAdapters?.has(provider)) {
    const candidate = deps.vpsProviderAdapters.get(provider)!;
    if (typeof candidate.deleteServer === "function") {
      // VpsProvider con deleteServer presente satisface estructuralmente WebdockServerDeleteAdapter.
      return candidate as WebdockServerDeleteAdapter;
    }
  }
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

async function resolveExistingServerForCreate(input: {
  adapter: WebdockServerCreateAdapter;
  workspace: OpenClawWorkspace;
  hostname: string;
  runId?: string;
  providerId: string;
  serverAccountId: string;
  allowPendingIpReuse: boolean;
}): Promise<
  | { status: "create" }
  | { status: "reuse"; server: WebdockServer }
  | { status: "blocked"; blockers: string[] }
> {
  if (input.runId) {
    const bound = await resolveExistingServerByRunBinding(input);
    if (bound) return bound;
  }
  const domainBound = await resolveExistingServerByDomainBinding(input);
  if (domainBound) return domainBound;

  if (!input.adapter.listServers) {
    return { status: "blocked", blockers: ["webdock_inventory_read_unavailable"] };
  }
  let inventory: WebdockInventoryResult;
  try {
    inventory = await input.adapter.listServers();
  } catch {
    return { status: "blocked", blockers: ["webdock_inventory_read_failed"] };
  }
  if (inventory.source.kind !== "live" || inventory.source.responseOk !== true) {
    return { status: "blocked", blockers: ["webdock_inventory_degraded"] };
  }
  const matches = dedupeServers(inventory.servers.filter((server) =>
    webdockServerMatchesHostname(server, input.hostname)
  ));
  if (matches.length === 0) return { status: "create" };
  if (matches.length > 1) {
    return { status: "blocked", blockers: ["webdock_existing_server_ambiguous"] };
  }
  const server = matches[0];
  if (!server.ipv4 && !input.allowPendingIpReuse) {
    return { status: "blocked", blockers: ["webdock_existing_server_ipv4_missing"] };
  }
  return { status: "reuse", server };
}

async function resolveExistingServerByRunBinding(input: {
  adapter: WebdockServerCreateAdapter;
  workspace: OpenClawWorkspace;
  hostname: string;
  runId: string;
  providerId: string;
  serverAccountId: string;
  allowPendingIpReuse: boolean;
}): Promise<
  | { status: "reuse"; server: WebdockServer }
  | { status: "blocked"; blockers: string[] }
  | null
> {
  const inventory = await input.workspace.readInventoryJson<WebdockServerInventory>("webdock-servers.json");
  const binding = inventory?.runBindings?.find((entry) => entry.runId === input.runId);
  if (!binding) return null;
  if (!runBindingMatchesScope(binding, input)) {
    return { status: "blocked", blockers: ["webdock_run_binding_scope_mismatch"] };
  }
  if (!hostnamesEquivalent(binding.domain, input.hostname)) {
    return { status: "blocked", blockers: ["webdock_run_binding_hostname_mismatch"] };
  }
  try {
    const server = await input.adapter.getServer(binding.serverSlug);
    if (!server.ipv4 && !input.allowPendingIpReuse) {
      return { status: "blocked", blockers: ["webdock_existing_server_ipv4_missing"] };
    }
    return { status: "reuse", server };
  } catch {
    return { status: "blocked", blockers: ["webdock_run_binding_server_read_failed"] };
  }
}

async function resolveExistingServerByDomainBinding(input: {
  adapter: WebdockServerCreateAdapter;
  workspace: OpenClawWorkspace;
  hostname: string;
  providerId: string;
  serverAccountId: string;
  allowPendingIpReuse: boolean;
}): Promise<
  | { status: "reuse"; server: WebdockServer }
  | { status: "blocked"; blockers: string[] }
  | null
> {
  const inventory = await input.workspace.readInventoryJson<WebdockServerInventory>("webdock-servers.json");
  const bindings = dedupeRunBindingsBySlug(
    (inventory?.runBindings ?? []).filter((entry) =>
      hostnamesEquivalent(entry.domain, input.hostname) && runBindingMatchesScope(entry, input)
    )
  );
  if (bindings.length === 0) return null;
  if (bindings.length > 1) {
    return { status: "blocked", blockers: ["webdock_domain_binding_ambiguous"] };
  }
  try {
    const server = await input.adapter.getServer(bindings[0].serverSlug);
    if (!server.ipv4 && !input.allowPendingIpReuse) {
      return { status: "blocked", blockers: ["webdock_existing_server_ipv4_missing"] };
    }
    return { status: "reuse", server };
  } catch {
    return { status: "blocked", blockers: ["webdock_domain_binding_server_read_failed"] };
  }
}

function dedupeRunBindingsBySlug(
  bindings: NonNullable<WebdockServerInventory["runBindings"]>
): NonNullable<WebdockServerInventory["runBindings"]> {
  const seen = new Set<string>();
  const out: NonNullable<WebdockServerInventory["runBindings"]> = [];
  for (const binding of bindings) {
    if (seen.has(binding.serverSlug)) continue;
    seen.add(binding.serverSlug);
    out.push(binding);
  }
  return out;
}

function runBindingMatchesScope(
  binding: NonNullable<WebdockServerInventory["runBindings"]>[number],
  scope: { providerId: string; serverAccountId: string }
): boolean {
  const providerId = normalizeRunBindingProviderId(binding);
  return (
    providerId === scope.providerId &&
    normalizeRunBindingServerAccountId(binding.serverAccountId, providerId) === scope.serverAccountId
  );
}

function normalizeRunBindingProviderId(
  binding: NonNullable<WebdockServerInventory["runBindings"]>[number]
): string {
  const explicit = normalizeProviderScopeId(binding.providerId);
  if (explicit) return explicit;
  return binding.serverSlug.startsWith("contabo-") ? "contabo" : "webdock";
}

function normalizeRunBindingServerAccountId(value: string | undefined, providerId: string): string {
  return normalizeProviderScopeId(value) ?? (providerId === "webdock" ? "ops" : providerId);
}

function normalizeProviderScopeId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : undefined;
}

function webdockServerMatchesHostname(server: WebdockServer, hostname: string): boolean {
  const candidates = [server.hostname, server.mainDomain];
  const target = normalizeDomainLoose(hostname);
  const exactMatch = candidates.some((value) =>
    typeof value === "string" && normalizeDomainLoose(value) === target
  );
  if (exactMatch) return true;
  if (isContaboLikeServer(server)) {
    candidates.push(server.name);
    return candidates.some((value) => typeof value === "string" && hostnamesEquivalent(value, hostname));
  }
  return false;
}

function hostnamesEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizeDomainLoose(left);
  const normalizedRight = normalizeDomainLoose(right);
  if (normalizedLeft === normalizedRight) return true;
  // Fallback para displayName de proveedores que reemplazan puntos por guiones.
  // Ejemplo: smtp.example.com equivale a smtp-example-com solo en servidores Contabo.
  return normalizeProviderHostnameLoose(normalizedLeft) === normalizeProviderHostnameLoose(normalizedRight);
}

function isContaboLikeServer(server: WebdockServer): boolean {
  return getProviderFromServerIdentity(server) === "contabo";
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

function normalizeProviderHostnameLoose(value: string): string {
  return value.replace(/[^a-z0-9 -]/g, "-");
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
    return { ...(current ?? {}), servers };
  });
}

export async function adoptWebdockServerInventoryEntry(input: {
  workspace: OpenClawWorkspace;
  serverSlug: string;
  serverIp: string;
  serverAccountId: string;
  liveServers: SmtpInventoryLiveServer[];
  actorId: string;
  reason: string;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<SmtpInventoryMutationResult> {
  const serverSlug = input.serverSlug.trim().toLowerCase();
  const requestedAccountId = input.serverAccountId.trim().toLowerCase();
  const dryRun = input.dryRun !== false;
  const liveServer = input.liveServers.find((server) => server.serverSlug.trim().toLowerCase() === serverSlug);
  if (!liveServer) {
    return {
      ok: false,
      status: "server_not_live",
      dryRun,
      changed: false,
      serverSlug,
      error: "server_not_live",
      plan: {
        action: "adopt_webdock_server",
        serverSlug,
        nextStep: "read_infrastructure_inventory",
        hint: "El serverSlug no aparece en la flota viva multi-cuenta. Lee read_infrastructure_inventory (autoritativa) para ver los slugs reales; NO uses read_webdock_servers legacy ni inventes el slug."
      }
    };
  }
  const basePlan = {
    action: "adopt_webdock_server",
    serverSlug,
    serverIp: input.serverIp,
    serverAccountId: requestedAccountId,
    liveStatus: liveServer.status,
    providerId: liveServer.providerId,
    accountId: liveServer.accountId,
    accountHealthStatus: liveServer.accountHealthStatus,
    sideEffects: "local-state-only"
  };
  const providerId = liveServer.providerId?.trim().toLowerCase();
  if (providerId && providerId !== "webdock") {
    // webdock-servers.json alimenta reuse/SSH/send solo para servers Webdock; adoptar
    // un server de otro proveedor corrompería esos flujos.
    return {
      ok: false,
      status: "provider_not_webdock",
      dryRun,
      changed: false,
      serverSlug,
      error: "provider_not_webdock",
      plan: basePlan
    };
  }
  if (liveServer.ipv4 !== input.serverIp) {
    return {
      ok: false,
      status: "server_ip_mismatch",
      dryRun,
      changed: false,
      serverSlug,
      error: "server_ip_mismatch",
      plan: { ...basePlan, requestedServerIp: input.serverIp, liveServerIp: liveServer.ipv4 }
    };
  }
  const liveAccountId = liveServer.accountId?.trim().toLowerCase();
  if (!liveAccountId || liveAccountId !== requestedAccountId) {
    return {
      ok: false,
      status: "server_account_mismatch",
      dryRun,
      changed: false,
      serverSlug,
      error: "server_account_mismatch",
      plan: { ...basePlan, requestedAccountId, liveAccountId: liveAccountId ?? null }
    };
  }
  const liveStatus = liveServer.status?.trim().toLowerCase();
  const lifecycleStatus = liveServer.lifecycleStatus?.trim().toLowerCase();
  if (liveStatus !== "running" || lifecycleStatus === "retired" || lifecycleStatus === "disabled") {
    return {
      ok: false,
      status: "server_status_not_running",
      dryRun,
      changed: false,
      serverSlug,
      error: "server_status_not_running",
      plan: { ...basePlan, lifecycleStatus: liveServer.lifecycleStatus }
    };
  }
  const health = liveServer.accountHealthStatus?.trim().toLowerCase();
  if (health !== undefined && health !== "healthy") {
    return {
      ok: false,
      status: "account_not_healthy",
      dryRun,
      changed: false,
      serverSlug,
      error: "account_not_healthy",
      plan: basePlan
    };
  }

  const inventory = await input.workspace.readInventoryJson<WebdockServerInventory>("webdock-servers.json").catch(() => null);
  const existing = inventory?.servers?.find((server) => server.slug.trim().toLowerCase() === serverSlug);
  if (existing) {
    // Adopción create-only: nunca sobrescribe una entrada existente (creada o ya adoptada).
    return {
      ok: false,
      status: "server_already_adopted",
      dryRun,
      changed: false,
      serverSlug,
      error: "server_already_adopted",
      plan: {
        ...basePlan,
        previousValues: {
          status: existing.status,
          ipv4: existing.ipv4,
          hostname: existing.hostname
        },
        conflictHint: "entry_exists_use_configure_complete_smtp_reuse_or_manual_review"
      }
    };
  }

  const timestamp = (input.now?.() ?? new Date()).toISOString();
  const plan = {
    ...basePlan,
    inventoryMutationKind: "created_new",
    rollbackHint: "rollback_remove_adopted_entry_from_webdock_servers_json",
    adoptedAt: timestamp
  };
  if (dryRun) {
    return {
      ok: true,
      status: "dry_run",
      dryRun: true,
      changed: false,
      serverSlug,
      reason: input.reason,
      plan
    };
  }

  // Entrada adoptada: solo los campos verificados contra la flota viva. hostname queda vacío
  // a propósito (el guard de reuse del orquestador solo compara hostnames no vacíos) y los
  // campos de aprovisionamiento (profile/imageSlug/eventId...) no existen porque este server
  // no nació por create_webdock_server. Los consumidores (entity-guard, send, reuse) solo
  // exigen slug+ipv4+status.
  const adoptedEntry = {
    slug: serverSlug,
    hostname: "",
    status: liveServer.status ?? "running",
    ipv4: input.serverIp,
    accountId: requestedAccountId,
    adopted: true,
    adoptedBy: input.actorId,
    createdAt: timestamp,
    updatedAt: timestamp
  } as unknown as NonNullable<WebdockServerInventory["servers"]>[number];
  let raced = false;
  await input.workspace.updateInventoryJson<WebdockServerInventory>("webdock-servers.json", (current) => {
    const servers = [...(current?.servers ?? [])];
    if (servers.some((server) => server.slug.trim().toLowerCase() === serverSlug)) {
      raced = true;
      return current ?? { servers };
    }
    servers.push(adoptedEntry);
    return { ...(current ?? {}), servers };
  });
  if (raced) {
    return {
      ok: false,
      status: "server_already_adopted",
      dryRun: false,
      changed: false,
      serverSlug,
      error: "server_already_adopted",
      plan
    };
  }
  return {
    ok: true,
    status: "adopted",
    dryRun: false,
    changed: true,
    serverSlug,
    reason: input.reason,
    plan
  };
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
    const runBindings = (current?.runBindings ?? []).filter((binding) => binding.serverSlug !== input.slug);
    return { ...(current ?? {}), servers, deletedServers, runBindings };
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

function normalizePollInterval(value: unknown, defaultValue = defaultPollIntervalMs): number {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 60_000) {
    throw new WebdockServerCreateInputError("pollIntervalMs must be an integer between 0 and 60000.");
  }
  return value;
}

function normalizeMaxPolls(value: unknown, defaultValue = defaultMaxPolls, maxValue = 60): number {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maxValue) {
    throw new WebdockServerCreateInputError(`maxPolls must be an integer between 0 and ${maxValue}.`);
  }
  return value;
}

function resolveProvisioningPolling(input: {
  env: Record<string, string | undefined>;
  providerId?: string;
  pollIntervalMs: unknown;
  maxPolls: unknown;
}): { pollIntervalMs: number; maxPolls: number } {
  if (input.providerId !== "contabo") {
    return {
      pollIntervalMs: normalizePollInterval(input.pollIntervalMs),
      maxPolls: normalizeMaxPolls(input.maxPolls)
    };
  }
  const defaultInterval =
    parseNonNegativeInteger(input.env.CONTABO_PROVISION_POLL_INTERVAL_MS) ?? defaultContaboPollIntervalMs;
  const defaultPolls =
    parseNonNegativeInteger(input.env.CONTABO_PROVISION_MAX_POLLS) ?? defaultContaboMaxPolls;
  // Rango operativo documentado: intervalos env de Contabo se clampean a 60s y 240 polls.
  // Los overrides explícitos del request siguen validados por normalizePollInterval/normalizeMaxPolls.
  return {
    pollIntervalMs: normalizePollInterval(input.pollIntervalMs, Math.min(defaultInterval, 60_000)),
    maxPolls: normalizeMaxPolls(input.maxPolls, Math.min(defaultPolls, 240), 240)
  };
}

function normalizeRouteProviderId(value: string | undefined): "contabo" | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized !== "webdock" ? normalized === "contabo" ? "contabo" : undefined : undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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

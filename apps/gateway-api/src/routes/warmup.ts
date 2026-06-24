import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
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
import type { SmtpSshRunner } from "./smtp-provisioning.ts";
import { warmupFromAddress } from "./warmup-sender.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

export interface WarmupStartDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  sshRunner: SmtpSshRunner;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface WarmupStartBody {
  domain?: unknown;
  serverSlug?: unknown;
  serverIp?: unknown;
  seedInboxes?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  taskId?: unknown;
}

interface DomainsInventory {
  bindings?: Array<{
    domain: string;
    serverSlug: string | null;
    serverIp: string;
  }>;
}

interface WebdockServersInventory {
  servers?: Array<{
    slug: string;
    ipv4: string | null;
  }>;
}

interface WarmupInventory {
  runs?: Array<{
    runId: string;
    domain: string;
    serverSlug: string | null;
    serverIp: string;
    seedCount: number;
    sent: Array<{
      seedHash: string;
      seedDomain: string;
      msgId: string;
      sentAt: string;
    }>;
    status: "started";
    startedAt: string;
  }>;
}

const skillName = "start_warmup_seed";
const approvalMaxAgeMs = 15 * 60 * 1000;

export async function handleWarmupStartHttp(deps: WarmupStartDependencies): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const body = await readJson<WarmupStartBody>(deps.request);
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const taskId = normalizeTaskId(body.taskId) ?? `warmup-${randomUUID()}`;
  const serverSlug = typeof body.serverSlug === "string" && body.serverSlug.trim()
    ? normalizeSlug(body.serverSlug)
    : await findBoundServerSlug(deps.workspace, domain);
  const serverIp = typeof body.serverIp === "string" && body.serverIp.trim()
    ? normalizeIpv4(body.serverIp)
    : await findServerIp(deps.workspace, domain, serverSlug);
  const seedInboxes = resolveSeedInboxes(body, env);

  await emitTaskDeclare(deps.canvasLiveEvents, taskId, `Warmup seed · ${domain}`, actorId, now);
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
  if (env.WARMUP_ENABLE_SEND !== "true") blockers.push("warmup_send_flag_disabled");
  if (!deps.sshRunner.isConfigured()) blockers.push("warmup_ssh_runner_missing");
  if (!approval) blockers.push("approval_not_found_or_expired");
  if (!serverSlug) blockers.push("server_slug_missing");
  if (!serverIp) blockers.push("server_ip_missing");
  if (seedInboxes.length !== 3) blockers.push("seed_inboxes_must_be_exactly_3");

  if (blockers.length > 0) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, actorId, seedCount: seedInboxes.length },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers,
        serverIpKnown: Boolean(serverIp),
        seedCount: seedInboxes.length,
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.warmup.start_blocked",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        blockers,
        serverSlug,
        seedCount: seedInboxes.length,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.warmup.start_blocked", "domain", domain, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      domain,
      blockers,
      workspace
    });
    return;
  }

  const existingWarmup = await findExistingWarmupRun(deps.workspace, domain);
  if (existingWarmup) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, serverIp, actorId, seedCount: seedInboxes.length },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        status: "idempotent_already_started",
        runId: existingWarmup.runId,
        seedCount: existingWarmup.seedCount,
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.warmup.seed_idempotent",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        runId: existingWarmup.runId,
        serverSlug: existingWarmup.serverSlug,
        serverIp: existingWarmup.serverIp,
        seedCount: existingWarmup.seedCount,
        status: "idempotent_already_started",
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.warmup.seed_idempotent", "domain", domain, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", deps.now?.() ?? new Date());
    json(deps.response, 200, {
      ok: true,
      status: "idempotent_already_started",
      runId: existingWarmup.runId,
      domain,
      serverSlug: existingWarmup.serverSlug,
      serverIp: existingWarmup.serverIp,
      sent: [],
      workspace
    });
    return;
  }

  const sent: NonNullable<WarmupInventory["runs"]>[number]["sent"] = [];

  try {
    for (const inbox of seedInboxes) {
      const msgId = `<warmup-${randomUUID()}@${domain}>`;
      const message = renderWarmupMessage({
        domain,
        to: inbox,
        msgId,
        now: deps.now?.() ?? new Date()
      });
      const result = await deps.sshRunner.run({
        serverSlug,
        serverIp: serverIp!,
        command: `/usr/sbin/sendmail -t -f ${shellQuote(warmupFromAddress(domain))}`,
        stdin: message,
        timeoutMs: 60_000
      });
      await emitCommandAction(
        deps.canvasLiveEvents,
        taskId,
        `sendmail warmup seed -> ${maskEmail(inbox)}`,
        result.exitCode ?? 0,
        truncate(result.stdout),
        truncate(result.stderr),
        deps.now?.() ?? new Date()
      );
      sent.push({
        seedHash: hashSeed(inbox),
        seedDomain: inbox.split("@")[1].toLowerCase(),
        msgId,
        sentAt: (deps.now?.() ?? new Date()).toISOString()
      });
    }

    const runId = `warmup-${randomUUID()}`;
    await updateWarmupInventory(deps.workspace, {
      runId,
      domain,
      serverSlug,
      serverIp: serverIp!,
      seedCount: seedInboxes.length,
      sent,
      status: "started",
      startedAt: now.toISOString()
    });
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, serverIp, actorId, seedCount: seedInboxes.length },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        runId,
        seedCount: seedInboxes.length,
        seedDomains: sent.map((entry) => entry.seedDomain),
        messageIds: sent.map((entry) => entry.msgId),
        learningCount: learnings.length
      }
    });
    await emitFileAction(deps.canvasLiveEvents, taskId, "write", workspace?.path ?? "executions/", "warmup seed execution record", deps.now?.() ?? new Date());

    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.warmup.seed_sent",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        runId,
        serverSlug,
        serverIp,
        seedCount: seedInboxes.length,
        seedDomains: sent.map((entry) => entry.seedDomain),
        messageIds: sent.map((entry) => entry.msgId),
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.warmup.seed_sent", "domain", domain, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", deps.now?.() ?? new Date());

    json(deps.response, 200, {
      ok: true,
      status: "started",
      runId,
      domain,
      serverSlug,
      serverIp,
      sent: seedInboxes.map((inbox, index) => ({
        to: maskEmail(inbox),
        msgId: sent[index].msgId
      })),
      workspace
    });
  } catch (error) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, serverIp, actorId, seedCount: seedInboxes.length },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: {
        error: errorMessage(error),
        sentCount: sent.length,
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.warmup.start_failed",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        serverSlug,
        serverIp,
        seedCount: seedInboxes.length,
        sentCount: sent.length,
        errorMessage: errorMessage(error),
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.warmup.start_failed", "domain", domain, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", deps.now?.() ?? new Date());
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      domain,
      error: "warmup_start_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export class WarmupStartInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "WarmupStartInputError";
  }
}

export function handleWarmupStartError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof WarmupStartInputError) {
    json(response, error.statusCode, {
      error: "invalid_warmup_start_request",
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

function renderWarmupMessage(input: {
  domain: string;
  to: string;
  msgId: string;
  now: Date;
}): string {
  return [
    `From: Delivrix Warmup <${warmupFromAddress(input.domain)}>`,
    `To: ${input.to}`,
    `Subject: Delivrix warmup seed · ${input.domain}`,
    `Message-ID: ${input.msgId}`,
    `Date: ${input.now.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "This is a seed email from Delivrix warmup. Reply with 'ok' to confirm receipt.",
    ""
  ].join("\n");
}

async function findBoundServerSlug(workspace: OpenClawWorkspace, domain: string): Promise<string | null> {
  const inventory = await workspace.readInventoryJson<DomainsInventory>("domains.json").catch(() => null);
  return inventory?.bindings?.find((entry) => entry.domain === domain)?.serverSlug ?? null;
}

async function findServerIp(workspace: OpenClawWorkspace, domain: string, serverSlug: string | null): Promise<string | null> {
  const domainInventory = await workspace.readInventoryJson<DomainsInventory>("domains.json").catch(() => null);
  const binding = domainInventory?.bindings?.find((entry) => entry.domain === domain);
  if (binding?.serverIp) return normalizeIpv4(binding.serverIp);

  if (!serverSlug) return null;
  const serverInventory = await workspace.readInventoryJson<WebdockServersInventory>("webdock-servers.json").catch(() => null);
  const server = serverInventory?.servers?.find((entry) => entry.slug === serverSlug);
  return server?.ipv4 ? normalizeIpv4(server.ipv4) : null;
}

async function updateWarmupInventory(
  workspace: OpenClawWorkspace,
  input: NonNullable<WarmupInventory["runs"]>[number]
): Promise<void> {
  await workspace.updateInventoryJson<WarmupInventory>("warmup-progress.json", (current) => ({
    runs: [
      ...(current?.runs ?? []).filter((run) => run.domain !== input.domain),
      input
    ]
  }));
}

async function findExistingWarmupRun(
  workspace: OpenClawWorkspace,
  domain: string
): Promise<NonNullable<WarmupInventory["runs"]>[number] | null> {
  const inventory = await workspace.readInventoryJson<WarmupInventory>("warmup-progress.json").catch(() => null);
  return inventory?.runs?.find((run) => run.domain === domain && run.status === "started") ?? null;
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

async function emitFileAction(service: CanvasEmitter | undefined, taskId: string, operation: "read" | "write", path: string, preview: string, now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.action.now", taskId, kind: "file", operation, path, preview, occurredAt: now.toISOString() });
}

async function emitCommandAction(service: CanvasEmitter | undefined, taskId: string, cmd: string, exitCode: number, stdout: string, stderr: string, now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.action.now", taskId, kind: "command", cmd, exitCode, stdout, stderr, durationMs: 1, occurredAt: now.toISOString() });
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

function resolveSeedInboxes(body: WarmupStartBody, env: Record<string, string | undefined>): string[] {
  const fromBody = parseSeedInboxes(body.seedInboxes);
  if (fromBody.length === 3) return fromBody;

  const fromEnv = parseSeedInboxCsv(env.WARMUP_DEFAULT_SEED_INBOXES);
  if (fromEnv.length === 3) return fromEnv;

  return fromBody;
}

function parseSeedInboxes(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new WarmupStartInputError("seedInboxes must be an array.");
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new WarmupStartInputError("seedInboxes must contain only strings.");
    }
    return normalizeEmail(item);
  });
}

function parseSeedInboxCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeEmail);
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new WarmupStartInputError(`Invalid seed inbox: ${value}`);
  }
  return normalized;
}

function normalizeSlug(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) {
    throw new WarmupStartInputError("serverSlug is invalid.");
  }
  return normalized;
}

function normalizeIpv4(value: string): string {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)) {
    throw new WarmupStartInputError(`Invalid IPv4 address: ${value}`);
  }
  return parts.map((part) => String(Number(part))).join(".");
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new WarmupStartInputError(`Invalid domain name: ${value}`);
  }
  return normalized;
}

function normalizeTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(trimmed) ? trimmed : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WarmupStartInputError(`${field} is required.`);
  }
  return value.trim();
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

function hashSeed(email: string): string {
  return createHash("sha256").update(email).digest("hex").slice(0, 16);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncate(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}...<truncated>`;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new WarmupStartInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown warmup error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

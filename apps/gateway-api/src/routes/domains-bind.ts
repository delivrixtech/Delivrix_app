import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AwsRoute53DnsChangeResult,
  AwsRoute53DnsRecordInput,
  AwsRoute53DnsSource,
  AwsRoute53HostedZoneResult,
  AwsRoute53HostedZoneSummary,
  AwsRoute53ResourceRecordSet
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
import {
  entityFailureMetadata,
  entityNotResolvedBlocker,
  resolveWorkspaceServer,
  resolveWorkspaceServerIp,
  tryNormalizeStrictDomainName,
  type EntityResolutionFailure
} from "../entity-guard.ts";
import { readRequestBody } from "../request-body.ts";
import {
  resolveRoute53HostedZone,
  Route53ZonePolicyError,
  type Route53ZoneResolution
} from "./route53-zone-policy.ts";
import { smtpHostForDomain } from "../smtp-naming.ts";

export interface DomainBindDnsAdapter {
  isLive(): boolean;
  isWriteEnabled(): boolean;
  currentSource(responseOk?: boolean, errorMessage?: string): AwsRoute53DnsSource;
  createHostedZone(domain: string): Promise<AwsRoute53HostedZoneResult>;
  listHostedZones(): Promise<AwsRoute53HostedZoneSummary[]>;
  listResourceRecordSets(zoneId: string): Promise<AwsRoute53ResourceRecordSet[]>;
  upsertRecord(zoneId: string, opts: AwsRoute53DnsRecordInput): Promise<AwsRoute53DnsChangeResult>;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

export interface DomainBindDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  dnsAdapter: DomainBindDnsAdapter;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface DomainBindBody {
  domain?: unknown;
  serverSlug?: unknown;
  serverIp?: unknown;
  zoneId?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  taskId?: unknown;
}

interface DomainsInventory {
  dnsZones?: Array<{
    domain: string;
    zoneId: string;
  }>;
  bindings?: Array<{
    domain: string;
    serverSlug: string | null;
    serverIp: string;
    mxHost: string;
    zoneId: string;
    status: "pending_propagation";
    updatedAt: string;
    changes: Array<{ name: string; type: string; changeId: string }>;
  }>;
}

const skillName = "bind_domain_to_server";
const approvalMaxAgeMs = 15 * 60 * 1000;

export async function handleDomainBindHttp(deps: DomainBindDependencies): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const body = await readJson<DomainBindBody>(deps.request);
  const rawDomain = requiredString(body.domain, "domain");
  const domainResolution = tryNormalizeStrictDomainName(rawDomain);
  const domain = domainResolution.ok ? domainResolution.value : rawDomain.trim().toLowerCase().replace(/\.$/, "");
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const taskId = normalizeTaskId(body.taskId) ?? `domain-bind-${randomUUID()}`;
  const serverSlug = typeof body.serverSlug === "string" && body.serverSlug.trim()
    ? normalizeSlug(body.serverSlug)
    : null;
  const entityFailures: EntityResolutionFailure[] = [];
  if (!domainResolution.ok) {
    entityFailures.push(domainResolution.failure);
  }
  const serverResolution = serverSlug ? await resolveWorkspaceServer(deps.workspace, serverSlug) : null;
  if (serverResolution && !serverResolution.ok) {
    entityFailures.push(serverResolution.failure);
  }
  const explicitServerIp = typeof body.serverIp === "string" && body.serverIp.trim()
    ? await resolveWorkspaceServerIp(deps.workspace, body.serverIp, serverSlug)
    : null;
  if (explicitServerIp && !explicitServerIp.ok) {
    entityFailures.push(explicitServerIp.failure);
  }
  const serverIp = explicitServerIp
    ? explicitServerIp.ok ? explicitServerIp.value : null
    : serverResolution?.ok ? serverResolution.value.serverIp : null;
  const preferredZoneId = typeof body.zoneId === "string" && body.zoneId.trim() ? body.zoneId.trim() : null;
  const inventoryZoneId = domainResolution.ok ? await findZoneId(deps.workspace, domain) : null;
  let zoneId = preferredZoneId ?? inventoryZoneId;
  const source = deps.dnsAdapter.currentSource(true);

  await emitTaskDeclare(deps.canvasLiveEvents, taskId, `Bind dominio · ${domain}`, actorId, now);
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
  if (env.DOMAIN_BIND_ENABLE !== "true") blockers.push("domain_bind_flag_disabled");
  if (!deps.dnsAdapter.isLive()) blockers.push("aws_route53_dns_credentials_missing");
  if (!deps.dnsAdapter.isWriteEnabled()) blockers.push("dns_write_flag_disabled");
  if (!approval) blockers.push("approval_not_found_or_expired");
  if (entityFailures.length > 0) blockers.push(entityNotResolvedBlocker);
  if (!serverIp) blockers.push("server_ip_missing");
  let zoneResolution: Route53ZoneResolution | null = null;
  let zonePolicyDetails: Record<string, unknown> | null = null;
  const canResolveZone =
    deps.dnsAdapter.isLive() &&
    deps.dnsAdapter.isWriteEnabled() &&
    Boolean(approval) &&
    entityFailures.length === 0;
  if (canResolveZone) {
    try {
      zoneResolution = await resolveRoute53HostedZone({
        workspace: deps.workspace,
        adapter: deps.dnsAdapter,
        domain,
        mode: "reuse-or-create",
        preferredZoneId,
        now: deps.now
      });
      zoneId = zoneResolution.zone.zoneId;
    } catch (error) {
      if (error instanceof Route53ZonePolicyError) {
        blockers.push(error.code);
        zonePolicyDetails = error.details;
      } else {
        throw error;
      }
    }
  } else if (!zoneId) {
    blockers.push("route53_zone_missing");
  }

  if (blockers.length > 0) {
    if (entityFailures.length > 0) {
      await appendEntityGuardAudits({
        auditLog: deps.auditLog,
        canvasLiveEvents: deps.canvasLiveEvents,
        taskId,
        actorId,
        failures: entityFailures,
        now
      });
    }
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, actorId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers,
        sourceKind: source.kind,
        writeEnabled: source.writeEnabled,
        learningCount: learnings.length,
        ...(zonePolicyDetails ? { zonePolicyDetails } : {}),
        ...(entityFailures.length > 0 ? { entityResolution: entityFailureMetadata(entityFailures) } : {})
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.domain.bind_blocked",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        blockers,
        serverSlug,
        ...(zonePolicyDetails ? { zonePolicyDetails } : {}),
        ...(entityFailures.length > 0 ? { entityResolution: entityFailureMetadata(entityFailures) } : {}),
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.domain.bind_blocked", "domain", domain, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      domain,
      blockers,
      ...(entityFailures.length > 0 ? { entityResolution: entityFailureMetadata(entityFailures) } : {}),
      workspace
    });
    return;
  }

  const records = buildDomainBindRecords(domain, serverIp!);

  try {
    const changes: Array<AwsRoute53DnsRecordInput & AwsRoute53DnsChangeResult> = [];
    for (const record of records) {
      const change = await deps.dnsAdapter.upsertRecord(zoneId!, record);
      changes.push({ ...record, ...change });
      await emitApiAction(deps.canvasLiveEvents, taskId, "POST", `/2013-04-01/hostedzone/${zoneId}/rrset`, 200, {
        changeId: change.changeId,
        record: { name: record.name, type: record.type }
      }, deps.now?.() ?? new Date());
    }

    await updateBindInventory(deps.workspace, {
      domain,
      serverSlug,
      serverIp: serverIp!,
      mxHost: smtpHostForDomain(domain),
      zoneId: zoneId!,
      status: "pending_propagation",
      updatedAt: (deps.now?.() ?? new Date()).toISOString(),
      changes: changes.map((change) => ({
        name: change.name,
        type: change.type,
        changeId: change.changeId
      }))
    });
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, serverIp, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        zoneId,
        ...(zoneResolution ? {
          zoneResolution: {
            status: zoneResolution.status,
            source: zoneResolution.source,
            smtpSetup: zoneResolution.smtpSetup ?? null,
            cleanupSuggested: zoneResolution.cleanupSuggested ?? []
          }
        } : {}),
        changes: changes.map((change) => ({
          name: change.name,
          type: change.type,
          changeId: change.changeId
        })),
        propagationStatus: "pending_propagation",
        learningCount: learnings.length
      }
    });
    await emitFileAction(deps.canvasLiveEvents, taskId, "write", workspace?.path ?? "executions/", "domain bind execution record", deps.now?.() ?? new Date());

    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.domain.bound_to_server",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        serverSlug,
        serverIp,
        zoneId,
        ...(zoneResolution ? {
          zoneResolution: {
            status: zoneResolution.status,
            source: zoneResolution.source,
            smtpSetup: zoneResolution.smtpSetup ?? null,
            cleanupSuggested: zoneResolution.cleanupSuggested ?? []
          }
        } : {}),
        changeIds: changes.map((change) => change.changeId),
        propagationStatus: "pending_propagation",
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.domain.bound_to_server", "domain", domain, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", deps.now?.() ?? new Date());

    json(deps.response, 200, {
      ok: true,
      status: "pending_propagation",
      domain,
      serverSlug,
      serverIp,
      mxHost: smtpHostForDomain(domain),
      changes: changes.map((change) => ({
        name: change.name,
        type: change.type,
        changeId: change.changeId
      })),
      workspace
    });
  } catch (error) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, serverIp, actorId },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: {
        error: errorMessage(error),
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.domain.bind_failed",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        serverSlug,
        serverIp,
        errorMessage: errorMessage(error),
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.domain.bind_failed", "domain", domain, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", deps.now?.() ?? new Date());
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      domain,
      error: "domain_bind_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export class DomainBindInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "DomainBindInputError";
  }
}

export function handleDomainBindError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof DomainBindInputError) {
    json(response, error.statusCode, {
      error: "invalid_domain_bind_request",
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

export function buildDomainBindRecords(domain: string, serverIp: string): AwsRoute53DnsRecordInput[] {
  const smtpHost = smtpHostForDomain(domain);
  return [
    {
      name: `${smtpHost}.`,
      type: "A",
      ttl: 300,
      values: [serverIp]
    },
    {
      name: `${domain}.`,
      type: "MX",
      ttl: 300,
      values: [`10 ${smtpHost}.`]
    }
  ];
}

async function findZoneId(workspace: OpenClawWorkspace, domain: string): Promise<string | null> {
  const inventory = await workspace.readInventoryJson<DomainsInventory>("domains.json").catch(() => null);
  return inventory?.dnsZones?.find((zone) => zone.domain === domain)?.zoneId ?? null;
}

async function updateBindInventory(
  workspace: OpenClawWorkspace,
  input: NonNullable<DomainsInventory["bindings"]>[number]
): Promise<void> {
  await workspace.updateInventoryJson<DomainsInventory>("domains.json", (current) => {
    const bindings = (current?.bindings ?? []).filter((entry) => entry.domain !== input.domain);
    bindings.push(input);
    return {
      ...(current ?? {}),
      bindings
    };
  });
}

async function appendEntityGuardAudits(input: {
  auditLog: AuditSink;
  canvasLiveEvents?: CanvasEmitter;
  taskId: string;
  actorId: string;
  failures: EntityResolutionFailure[];
  now: Date;
}): Promise<void> {
  for (const failure of input.failures) {
    await input.auditLog.append({
      actorType: "operator",
      actorId: input.actorId,
      action: "oc.guard.entity_not_resolved",
      targetType: failure.valueClass,
      targetId: failure.normalized ?? failure.value,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        taskId: input.taskId,
        entityResolution: entityFailureMetadata([failure])
      }
    });
  }
  const first = input.failures[0];
  if (first) {
    await emitAuditAction(
      input.canvasLiveEvents,
      input.taskId,
      "oc.guard.entity_not_resolved",
      first.valueClass,
      first.normalized ?? first.value,
      "critical",
      input.now
    );
  }
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

function normalizeSlug(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) {
    throw new DomainBindInputError("serverSlug is invalid.");
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
    throw new DomainBindInputError(`${field} is required.`);
  }
  return value.trim();
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new DomainBindInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown domain bind error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

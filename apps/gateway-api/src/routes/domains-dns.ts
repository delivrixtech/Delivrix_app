import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AwsRoute53DnsChangeResult,
  AwsRoute53DnsRecordInput,
  AwsRoute53DnsRecordType,
  AwsRoute53DeleteHostedZoneResult,
  AwsRoute53DnsSource,
  AwsRoute53HostedZoneResult
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

export interface Route53DnsAdapter {
  isLive(): boolean;
  isWriteEnabled(): boolean;
  currentSource(responseOk?: boolean, errorMessage?: string): AwsRoute53DnsSource;
  createHostedZone(domain: string): Promise<AwsRoute53HostedZoneResult>;
  upsertRecord(zoneId: string, opts: AwsRoute53DnsRecordInput): Promise<AwsRoute53DnsChangeResult>;
}

export interface Route53HostedZoneDeleteAdapter {
  isLive(): boolean;
  isWriteEnabled(): boolean;
  currentSource(responseOk?: boolean, errorMessage?: string): AwsRoute53DnsSource;
  deleteHostedZone(
    zoneId: string,
    opts?: { deleteRecords?: boolean }
  ): Promise<AwsRoute53DeleteHostedZoneResult>;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

export interface Route53DnsUpsertDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  adapter: Route53DnsAdapter;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  now?: () => Date;
}

export interface Route53HostedZoneDeleteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  adapter: Route53HostedZoneDeleteAdapter;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  now?: () => Date;
}

interface Route53DnsUpsertBody {
  domain?: unknown;
  zoneId?: unknown;
  records?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  taskId?: unknown;
}

interface Route53HostedZoneDeleteBody {
  domain?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  reason?: unknown;
  taskId?: unknown;
  deleteRecords?: unknown;
}

interface Route53DnsInventory {
  dnsZones?: Array<{
    domain: string;
    zoneId: string;
    nameServers: string[];
    updatedAt: string;
    records: Array<{
      name: string;
      type: AwsRoute53DnsRecordType;
      ttl: number;
      values: string[];
      changeId?: string;
      updatedAt: string;
    }>;
  }>;
  deletedDnsZones?: Array<{
    domain?: string;
    zoneId: string;
    deletedAt: string;
    deletedRecords: Array<{
      name: string;
      type: AwsRoute53DnsRecordType;
      ttl: number;
      values: string[];
      changeId?: string;
    }>;
    deleteChangeId?: string;
    reason: string;
  }>;
}

const skillName = "route53_dns_upsert";
const deleteSkillName = "route53_hosted_zone_delete";
const approvalMaxAgeMs = 15 * 60 * 1000;

export async function handleRoute53DnsUpsertHttp(
  deps: Route53DnsUpsertDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const body = await readJson<Route53DnsUpsertBody>(deps.request);
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const taskId = normalizeTaskId(body.taskId) ?? `route53-dns-${randomUUID()}`;
  const records = parseRecords(body.records, domain);
  const source = deps.adapter.currentSource(true);

  await emitTaskDeclare(deps.canvasLiveEvents, taskId, `Route53 DNS upsert · ${domain}`, actorId, now);
  const learnings = await safeReadLearnings(deps.workspace);
  await emitFileAction(deps.canvasLiveEvents, taskId, "read", "learnings/", `learnings:${learnings.length}`, now);

  const blockers: string[] = [];
  if (!deps.adapter.isLive()) blockers.push("aws_route53_dns_credentials_missing");
  if (!deps.adapter.isWriteEnabled()) blockers.push("dns_write_flag_disabled");
  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) blockers.push("approval_not_found_or_expired");

  let workspace: OpenClawWorkspaceFileRef | null = null;
  if (blockers.length > 0) {
    workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, recordCount: records.length, actorId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers,
        sourceKind: source.kind,
        writeEnabled: source.writeEnabled,
        approvalMatched: Boolean(approval),
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.records_update_blocked",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        provider: "aws-route53",
        blockers,
        recordCount: records.length,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.dns.records_update_blocked", "domain", domain, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      domain,
      blockers,
      source,
      workspace
    });
    return;
  }

  try {
    const existingZone = await findWorkspaceZone(deps.workspace, domain);
    const zone = existingZone ?? await deps.adapter.createHostedZone(domain);
    if (!existingZone) {
      await emitApiAction(deps.canvasLiveEvents, taskId, "POST", "/2013-04-01/hostedzone", 200, {
        zoneId: zone.zoneId,
        nameServers: zone.nameServers
      }, now);
    }

    const changes: Array<AwsRoute53DnsChangeResult & AwsRoute53DnsRecordInput> = [];
    for (const record of records) {
      const change = await deps.adapter.upsertRecord(zone.zoneId, record);
      changes.push({ ...record, ...change });
      await emitApiAction(
        deps.canvasLiveEvents,
        taskId,
        "POST",
        `/2013-04-01/hostedzone/${zone.zoneId}/rrset`,
        200,
        { changeId: change.changeId, record: { name: record.name, type: record.type } },
        now
      );
    }

    workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, zoneId: zone.zoneId, recordCount: records.length, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        zoneId: zone.zoneId,
        nameServers: zone.nameServers,
        changes: changes.map((change) => ({
          name: change.name,
          type: change.type,
          changeId: change.changeId
        })),
        learningCount: learnings.length
      }
    });
    await updateDnsInventory(deps.workspace, {
      domain,
      zone,
      records: changes,
      updatedAt: now.toISOString()
    });
    await emitFileAction(deps.canvasLiveEvents, taskId, "write", workspace?.path ?? "executions/", "DNS execution record", now);

    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.records_updated",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "aws-route53",
        zoneId: zone.zoneId,
        recordCount: records.length,
        changeIds: changes.map((change) => change.changeId),
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.dns.records_updated", "domain", domain, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", now);

    json(deps.response, 200, {
      ok: true,
      status: "pending",
      domain,
      zoneId: zone.zoneId,
      nameServers: zone.nameServers,
      changes: changes.map((change) => ({
        name: change.name,
        type: change.type,
        changeId: change.changeId
      })),
      workspace
    });
  } catch (error) {
    workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, recordCount: records.length, actorId },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: {
        error: errorMessage(error),
        sourceKind: source.kind
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.records_update_failed",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "aws-route53",
        errorMessage: errorMessage(error),
        recordCount: records.length,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.dns.records_update_failed", "domain", domain, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      domain,
      error: "route53_dns_upsert_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export async function handleRoute53HostedZoneDeleteHttp(
  deps: Route53HostedZoneDeleteDependencies,
  zoneIdParam: string
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const zoneId = normalizeHostedZoneId(zoneIdParam);
  const body = await readJson<Route53HostedZoneDeleteBody>(deps.request);
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const reason = requiredString(body.reason, "reason");
  const taskId = normalizeTaskId(body.taskId) ?? `route53-zone-delete-${randomUUID()}`;
  const deleteRecords = body.deleteRecords !== false;
  const source = deps.adapter.currentSource(true);
  const inventoryZone = await findWorkspaceZoneById(deps.workspace, zoneId);
  const domain = typeof body.domain === "string" && body.domain.trim()
    ? normalizeDomainName(body.domain)
    : inventoryZone?.domain;

  await emitTaskDeclare(deps.canvasLiveEvents, taskId, `Route53 hosted zone cleanup · ${zoneId}`, actorId, now);
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
  if (!deps.adapter.isLive()) blockers.push("aws_route53_dns_credentials_missing");
  if (!deps.adapter.isWriteEnabled()) blockers.push("dns_write_flag_disabled");
  if (!approval) blockers.push("approval_not_found_or_expired");

  if (blockers.length > 0) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: deleteSkillName,
      params: { zoneId, domain, actorId, deleteRecords, reason },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers,
        sourceKind: source.kind,
        writeEnabled: source.writeEnabled,
        approvalMatched: Boolean(approval),
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.hosted_zone_delete_blocked",
      targetType: "route53_hosted_zone",
      targetId: zoneId,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        provider: "aws-route53",
        blockers,
        domain,
        reason,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.dns.hosted_zone_delete_blocked", "route53_hosted_zone", zoneId, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      zoneId,
      domain,
      blockers,
      source,
      workspace
    });
    return;
  }

  try {
    const deleted = await deps.adapter.deleteHostedZone(zoneId, { deleteRecords });
    await emitApiAction(deps.canvasLiveEvents, taskId, "DELETE", `/2013-04-01/hostedzone/${zoneId}`, 200, {
      zoneId,
      deleteChangeId: deleted.deleteChangeId,
      deletedRecordCount: deleted.deletedRecords.length
    }, now);
    await markHostedZoneDeleted(deps.workspace, {
      domain,
      zoneId,
      deletedAt: now.toISOString(),
      deletedRecords: deleted.deletedRecords,
      deleteChangeId: deleted.deleteChangeId,
      reason
    });
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: deleteSkillName,
      params: { zoneId, domain, actorId, deleteRecords, reason },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        zoneId,
        domain,
        deletedRecordCount: deleted.deletedRecords.length,
        deleteChangeId: deleted.deleteChangeId,
        learningCount: learnings.length
      }
    });
    await emitFileAction(deps.canvasLiveEvents, taskId, "write", workspace?.path ?? "executions/", "Route53 hosted zone delete execution record", now);
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.hosted_zone_deleted",
      targetType: "route53_hosted_zone",
      targetId: zoneId,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "aws-route53",
        domain,
        reason,
        deletedRecordCount: deleted.deletedRecords.length,
        deleteChangeId: deleted.deleteChangeId,
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.dns.hosted_zone_deleted", "route53_hosted_zone", zoneId, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", now);
    json(deps.response, 200, {
      ok: true,
      status: "deleted",
      zoneId,
      domain,
      deletedRecordCount: deleted.deletedRecords.length,
      deleteChangeId: deleted.deleteChangeId,
      workspace
    });
  } catch (error) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: deleteSkillName,
      params: { zoneId, domain, actorId, deleteRecords, reason },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: {
        error: errorMessage(error),
        sourceKind: source.kind
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.hosted_zone_delete_failed",
      targetType: "route53_hosted_zone",
      targetId: zoneId,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "aws-route53",
        domain,
        reason,
        errorMessage: errorMessage(error),
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.dns.hosted_zone_delete_failed", "route53_hosted_zone", zoneId, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      zoneId,
      domain,
      error: "route53_hosted_zone_delete_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export class Route53DnsInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "Route53DnsInputError";
  }
}

export function handleRoute53DnsError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof Route53DnsInputError) {
    json(response, error.statusCode, {
      error: "invalid_route53_dns_request",
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
    if (event.action !== "oc.artifact.approved" || event.metadata.executionId !== input.approvalToken) {
      return false;
    }
    const approvedAt = Date.parse(event.occurredAt);
    return Number.isFinite(approvedAt) && input.now.getTime() - approvedAt >= 0 && input.now.getTime() - approvedAt <= input.maxAgeMs;
  });
  if (!auditEvent) return null;

  const state = await input.readCanvasState();
  return state.artifacts.find((artifact) => {
    if (artifact.approvalStatus !== "approved" || artifact.executionId !== input.approvalToken || !artifact.approvedAt) {
      return false;
    }
    const approvedAt = Date.parse(artifact.approvedAt);
    return Number.isFinite(approvedAt) && input.now.getTime() - approvedAt >= 0 && input.now.getTime() - approvedAt <= input.maxAgeMs;
  }) ?? null;
}

async function findWorkspaceZone(
  workspace: OpenClawWorkspace,
  domain: string
): Promise<AwsRoute53HostedZoneResult | null> {
  const inventory = await workspace.readInventoryJson<Route53DnsInventory>("domains.json").catch(() => null);
  const zone = inventory?.dnsZones?.find((entry) => entry.domain === domain);
  return zone ? { zoneId: zone.zoneId, nameServers: zone.nameServers } : null;
}

async function findWorkspaceZoneById(
  workspace: OpenClawWorkspace,
  zoneId: string
): Promise<(NonNullable<Route53DnsInventory["dnsZones"]>[number]) | null> {
  const inventory = await workspace.readInventoryJson<Route53DnsInventory>("domains.json").catch(() => null);
  return inventory?.dnsZones?.find((entry) => entry.zoneId === zoneId) ?? null;
}

async function updateDnsInventory(
  workspace: OpenClawWorkspace,
  input: {
    domain: string;
    zone: AwsRoute53HostedZoneResult;
    records: Array<AwsRoute53DnsRecordInput & AwsRoute53DnsChangeResult>;
    updatedAt: string;
  }
): Promise<void> {
  await workspace.updateInventoryJson<Route53DnsInventory>("domains.json", (current) => {
    const dnsZones = (current?.dnsZones ?? []).filter((zone) => zone.domain !== input.domain);
    dnsZones.push({
      domain: input.domain,
      zoneId: input.zone.zoneId,
      nameServers: input.zone.nameServers,
      updatedAt: input.updatedAt,
      records: input.records.map((record) => ({
        name: record.name,
        type: record.type,
        ttl: record.ttl,
        values: record.values,
        changeId: record.changeId,
        updatedAt: input.updatedAt
      }))
    });
    return {
      ...(current ?? {}),
      dnsZones
    };
  });
}

async function markHostedZoneDeleted(
  workspace: OpenClawWorkspace,
  input: NonNullable<Route53DnsInventory["deletedDnsZones"]>[number]
): Promise<void> {
  await workspace.updateInventoryJson<Route53DnsInventory>("domains.json", (current) => {
    const dnsZones = (current?.dnsZones ?? []).filter((zone) => zone.zoneId !== input.zoneId);
    const deletedDnsZones = [
      ...(current?.deletedDnsZones ?? []).filter((zone) => zone.zoneId !== input.zoneId),
      input
    ];
    return {
      ...(current ?? {}),
      dnsZones,
      deletedDnsZones
    };
  });
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

async function emitTaskDeclare(
  service: CanvasEmitter | undefined,
  taskId: string,
  title: string,
  actorId: string,
  now: Date
): Promise<void> {
  await safeEmit(service, {
    type: "oc.task.declare",
    taskId,
    title,
    status: "running",
    createdAt: now.toISOString(),
    actorId
  });
}

async function emitTaskUpdate(
  service: CanvasEmitter | undefined,
  taskId: string,
  status: "completed" | "failed",
  now: Date
): Promise<void> {
  await safeEmit(service, {
    type: "oc.task.update",
    taskId,
    status,
    updatedAt: now.toISOString()
  });
}

async function emitApiAction(
  service: CanvasEmitter | undefined,
  taskId: string,
  method: string,
  url: string,
  status: number,
  responseBody: unknown,
  now: Date
): Promise<void> {
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

async function emitFileAction(
  service: CanvasEmitter | undefined,
  taskId: string,
  operation: "read" | "write",
  path: string,
  preview: string,
  now: Date
): Promise<void> {
  await safeEmit(service, {
    type: "oc.action.now",
    taskId,
    kind: "file",
    operation,
    path,
    preview,
    occurredAt: now.toISOString()
  });
}

async function emitAuditAction(
  service: CanvasEmitter | undefined,
  taskId: string,
  action: string,
  targetType: string,
  targetId: string,
  riskLevel: "critical",
  now: Date
): Promise<void> {
  await safeEmit(service, {
    type: "oc.action.now",
    taskId,
    kind: "audit",
    action,
    targetType,
    targetId,
    riskLevel,
    occurredAt: now.toISOString()
  });
}

async function safeEmit(service: CanvasEmitter | undefined, event: CanvasLiveEvent): Promise<void> {
  if (!service) return;
  try {
    await service.emit(event);
  } catch {
    return;
  }
}

function parseRecords(value: unknown, domain: string): AwsRoute53DnsRecordInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Route53DnsInputError("records must be a non-empty array.");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Route53DnsInputError(`records[${index}] must be an object.`);
    }
    const type = requiredString(item.type, `records[${index}].type`).toUpperCase();
    if (type !== "A" && type !== "MX" && type !== "TXT" && type !== "CNAME") {
      throw new Route53DnsInputError(`records[${index}].type is not supported.`);
    }
    const ttl = Number(item.ttl);
    if (!Number.isInteger(ttl) || ttl < 30 || ttl > 172800) {
      throw new Route53DnsInputError(`records[${index}].ttl must be between 30 and 172800.`);
    }
    if (!Array.isArray(item.values) || item.values.length === 0) {
      throw new Route53DnsInputError(`records[${index}].values must be a non-empty array.`);
    }
    return {
      name: recordName(requiredString(item.name, `records[${index}].name`), domain),
      type,
      ttl,
      values: item.values.map((entry, valueIndex) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw new Route53DnsInputError(`records[${index}].values[${valueIndex}] must be a string.`);
        }
        return entry.trim();
      })
    };
  });
}

function recordName(name: string, domain: string): string {
  const trimmed = name.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed === "@") return `${domain}.`;
  if (trimmed === domain || trimmed.endsWith(`.${domain}`)) return `${trimmed}.`;
  return `${trimmed}.${domain}.`;
}

function normalizeHostedZoneId(value: string): string {
  const normalized = decodeURIComponent(value).replace(/^\/hostedzone\//, "").trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(normalized)) {
    throw new Route53DnsInputError(`Invalid Route53 hosted zone id: ${value}`);
  }
  return normalized;
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new Route53DnsInputError(`Invalid domain name: ${value}`);
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
    throw new Route53DnsInputError(`${field} is required.`);
  }
  return value.trim();
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Route53DnsInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Route53 DNS error";
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

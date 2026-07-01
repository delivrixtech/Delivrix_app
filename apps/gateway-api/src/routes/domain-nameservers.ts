import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AwsRoute53DomainsInventorySource,
  AwsRoute53HostedZoneSummary,
  AwsRoute53ResourceRecordSet,
  AwsRoute53UpdateDomainNameserversResult
} from "../../../../packages/adapters/src/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import { stableStringify } from "../../../../packages/storage/src/stable-stringify.ts";
import { artifactMatchesAuditApproval, auditApprovalMatchesToken, approvalTokenHash } from "../approval-guard.ts";
import type { OpenClawWorkspace, OpenClawWorkspaceFileRef } from "../openclaw-workspace.ts";
import { readRequestBody } from "../request-body.ts";
import {
  normalizeRoute53Nameservers,
  requireRoute53ZoneWithApexMailRecords,
  resolveRoute53HostedZone,
  Route53ZonePolicyError,
  route53NameserversFromRecords,
  type Route53ZonePolicyAdapter
} from "./route53-zone-policy.ts";

export interface DomainNameserverRegistrarAdapter {
  isLive(): boolean;
  isNameserverUpdateEnabled(): boolean;
  currentSource(responseOk?: boolean, errorMessage?: string): AwsRoute53DomainsInventorySource;
  getDomainNameservers(domain: string): Promise<string[]>;
  updateDomainNameservers(domain: string, nameservers: string[]): Promise<AwsRoute53UpdateDomainNameserversResult>;
}

export interface DomainNameserverDnsAdapter extends Route53ZonePolicyAdapter {
  isLive(): boolean;
  isWriteEnabled(): boolean;
  currentSource(responseOk?: boolean, errorMessage?: string): { kind: "live" | "mock"; writeEnabled: boolean; [key: string]: unknown };
  listHostedZones(): Promise<AwsRoute53HostedZoneSummary[]>;
  listResourceRecordSets(zoneId: string): Promise<AwsRoute53ResourceRecordSet[]>;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

interface KillSwitchState {
  enabled: boolean;
}

export interface DomainNameserverUpdateDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  registrarAdapter: DomainNameserverRegistrarAdapter;
  dnsAdapter: DomainNameserverDnsAdapter;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  readKillSwitch: () => Promise<KillSwitchState> | KillSwitchState;
  now?: () => Date;
}

interface DomainNameserverUpdateBody {
  domain?: unknown;
  zoneId?: unknown;
  nameservers?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  taskId?: unknown;
}

interface DomainNameserverInventory {
  nameserverUpdates?: Array<{
    requestHash: string;
    domain: string;
    zoneId: string;
    from: string[];
    to: string[];
    operationId?: string;
    status: "already_aligned" | "updated";
    actorId: string;
    updatedAt: string;
  }>;
}

const skillName = "update_domain_nameservers";
const approvalMaxAgeMs = 15 * 60 * 1000;

export async function handleDomainNameserverUpdateHttp(
  deps: DomainNameserverUpdateDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const body = await readJson<DomainNameserverUpdateBody>(deps.request);
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const taskId = normalizeTaskId(body.taskId) ?? `domain-ns-${randomUUID()}`;
  const preferredZoneId = typeof body.zoneId === "string" && body.zoneId.trim() ? body.zoneId.trim() : null;
  const requestedNameservers = Array.isArray(body.nameservers)
    ? parseNameservers(body.nameservers)
    : null;
  const registrarSource = deps.registrarAdapter.currentSource(true);
  const dnsSource = deps.dnsAdapter.currentSource(true);

  await emitTaskDeclare(deps.canvasLiveEvents, taskId, `Route53 nameservers · ${domain}`, actorId, now);

  const blockers: string[] = [];
  if (!deps.registrarAdapter.isLive()) blockers.push("aws_route53_domains_credentials_missing");
  if (!deps.registrarAdapter.isNameserverUpdateEnabled()) blockers.push("nameserver_update_flag_disabled");
  if (!deps.dnsAdapter.isLive()) blockers.push("aws_route53_dns_credentials_missing");
  const killSwitch = await readKillSwitchFailClosed(deps.readKillSwitch);
  if (!killSwitch.ok) blockers.push("kill_switch_read_failed");
  else if (killSwitch.enabled) blockers.push("kill_switch_armed");
  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) blockers.push("approval_not_found_or_expired");

  if (blockers.length > 0) {
    await block(deps, {
      startedAt,
      now,
      taskId,
      actorId,
      domain,
      blockers,
      evidence: {
        registrarSourceKind: registrarSource.kind,
        dnsSourceKind: dnsSource.kind,
        dnsWriteEnabled: dnsSource.writeEnabled,
        approvalMatched: Boolean(approval)
      }
    });
    return;
  }

  try {
    const zoneResolution = await resolveRoute53HostedZone({
      workspace: deps.workspace,
      adapter: deps.dnsAdapter,
      domain,
      mode: "reuse-only",
      preferredZoneId,
      getDomainNameservers: deps.registrarAdapter.getDomainNameservers,
      now: deps.now
    });
    const records = await requireRoute53ZoneWithApexMailRecords({
      adapter: deps.dnsAdapter,
      domain,
      zone: zoneResolution.zone
    });
    const destinationNameservers = normalizeRoute53Nameservers(
      zoneResolution.zone.nameServers.length > 0
        ? zoneResolution.zone.nameServers
        : route53NameserversFromRecords(records, domain)
    );
    if (destinationNameservers.length < 2) {
      throw new Route53ZonePolicyError("route53_zone_nameservers_missing", "Route53 destination zone did not expose enough nameservers for registrar realignment.", {
        domain,
        zoneId: zoneResolution.zone.zoneId
      });
    }
    if (requestedNameservers && !sameNameservers(requestedNameservers, destinationNameservers)) {
      throw new Route53ZonePolicyError("nameservers_do_not_match_route53_zone", "Requested nameservers do not match the verified Route53 hosted zone nameservers.", {
        domain,
        zoneId: zoneResolution.zone.zoneId,
        requestedNameservers,
        route53Nameservers: destinationNameservers
      });
    }
    const currentNameservers = normalizeRoute53Nameservers(await deps.registrarAdapter.getDomainNameservers(domain));
    const requestHash = hashNameserverRequest({
      domain,
      zoneId: zoneResolution.zone.zoneId,
      nameservers: destinationNameservers,
      approvalToken
    });
    const duplicate = await findNameserverUpdate(deps.workspace, requestHash);
    if (duplicate) {
      await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", now);
      json(deps.response, 200, {
        ok: true,
        status: duplicate.status,
        duplicate: true,
        domain,
        zoneId: duplicate.zoneId,
        from: duplicate.from,
        to: duplicate.to,
        operationId: duplicate.operationId
      });
      return;
    }

    const alreadyAligned = sameNameservers(currentNameservers, destinationNameservers);
    const update = alreadyAligned
      ? null
      : await deps.registrarAdapter.updateDomainNameservers(domain, destinationNameservers);
    await emitApiAction(deps.canvasLiveEvents, taskId, "POST", "Route53Domains.UpdateDomainNameservers", 200, {
      domain,
      zoneId: zoneResolution.zone.zoneId,
      operationId: update?.operationId ?? null,
      alreadyAligned
    }, now);

    const status = alreadyAligned ? "already_aligned" as const : "updated" as const;
    await rememberNameserverUpdate(deps.workspace, {
      requestHash,
      domain,
      zoneId: zoneResolution.zone.zoneId,
      from: currentNameservers,
      to: destinationNameservers,
      operationId: update?.operationId,
      status,
      actorId,
      updatedAt: now.toISOString()
    });
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, zoneId: zoneResolution.zone.zoneId, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        status,
        from: currentNameservers,
        to: destinationNameservers,
        operationId: update?.operationId,
        zoneResolution: {
          source: zoneResolution.source,
          smtpSetup: zoneResolution.smtpSetup ?? null,
          cleanupSuggested: zoneResolution.cleanupSuggested ?? []
        }
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: alreadyAligned ? "oc.domain.nameservers_already_aligned" : "oc.domain.nameservers_updated",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        category: "supervised_live_wallet",
        provider: "aws-route53-domains",
        domain,
        zoneId: zoneResolution.zone.zoneId,
        from: currentNameservers,
        to: destinationNameservers,
        operationId: update?.operationId,
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path,
        zoneResolution: {
          source: zoneResolution.source,
          smtpSetup: zoneResolution.smtpSetup ?? null,
          cleanupSuggested: zoneResolution.cleanupSuggested ?? []
        }
      }
    });
    await emitAuditAction(
      deps.canvasLiveEvents,
      taskId,
      alreadyAligned ? "oc.domain.nameservers_already_aligned" : "oc.domain.nameservers_updated",
      "domain",
      domain,
      "critical",
      now
    );
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", now);
    json(deps.response, 200, {
      ok: true,
      status,
      domain,
      zoneId: zoneResolution.zone.zoneId,
      from: currentNameservers,
      to: destinationNameservers,
      operationId: update?.operationId,
      zoneResolution: {
        source: zoneResolution.source,
        smtpSetup: zoneResolution.smtpSetup ?? null,
        cleanupSuggested: zoneResolution.cleanupSuggested ?? []
      },
      workspace
    });
  } catch (error) {
    if (error instanceof Route53ZonePolicyError) {
      await block(deps, {
        startedAt,
        now,
        taskId,
        actorId,
        domain,
        blockers: [error.code],
        evidence: error.details,
        statusCode: error.statusCode
      });
      return;
    }
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, actorId },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: {
        error: errorMessage(error),
        registrarSourceKind: registrarSource.kind,
        dnsSourceKind: dnsSource.kind
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.domain.nameservers_update_failed",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        category: "supervised_live_wallet",
        provider: "aws-route53-domains",
        errorMessage: errorMessage(error),
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.domain.nameservers_update_failed", "domain", domain, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      domain,
      error: "nameserver_update_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export function handleDomainNameserverUpdateError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof DomainNameserverInputError) {
    json(response, error.statusCode, {
      error: "invalid_nameserver_update_request",
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

class DomainNameserverInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "DomainNameserverInputError";
  }
}

async function block(
  deps: DomainNameserverUpdateDependencies,
  input: {
    startedAt: number;
    now: Date;
    taskId: string;
    actorId: string;
    domain: string;
    blockers: string[];
    evidence: Record<string, unknown>;
    statusCode?: number;
  }
): Promise<void> {
  const workspace = await safeWriteExecution(deps.workspace, {
    skill: skillName,
    params: { domain: input.domain, actorId: input.actorId },
    outcome: "blocked",
    durationMs: Date.now() - input.startedAt,
    evidence: {
      blockers: input.blockers,
      ...input.evidence
    }
  });
  await deps.auditLog.append({
    actorType: "operator",
    actorId: input.actorId,
    action: "oc.domain.nameservers_update_blocked",
    targetType: "domain",
    targetId: input.domain,
    riskLevel: "critical",
    decision: "reject",
    humanApproved: false,
    metadata: {
      category: "supervised_live_wallet",
      provider: "aws-route53-domains",
      blockers: input.blockers,
      ...input.evidence,
      workspacePath: workspace?.path
    }
  });
  await emitAuditAction(deps.canvasLiveEvents, input.taskId, "oc.domain.nameservers_update_blocked", "domain", input.domain, "critical", input.now);
  await emitTaskUpdate(deps.canvasLiveEvents, input.taskId, "failed", input.now);
  json(deps.response, input.statusCode ?? 409, {
    ok: false,
    status: "blocked",
    domain: input.domain,
    blockers: input.blockers,
    ...input.evidence,
    workspace
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

async function readKillSwitchFailClosed(
  readKillSwitch: () => Promise<KillSwitchState> | KillSwitchState
): Promise<{ ok: true; enabled: boolean } | { ok: false }> {
  try {
    const state = await readKillSwitch();
    return typeof state.enabled === "boolean" ? { ok: true, enabled: state.enabled } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function findNameserverUpdate(workspace: OpenClawWorkspace, requestHash: string) {
  const inventory = await workspace.readInventoryJson<DomainNameserverInventory>("domains.json").catch(() => null);
  return inventory?.nameserverUpdates?.find((entry) => entry.requestHash === requestHash) ?? null;
}

async function rememberNameserverUpdate(
  workspace: OpenClawWorkspace,
  input: NonNullable<DomainNameserverInventory["nameserverUpdates"]>[number]
): Promise<void> {
  await workspace.updateInventoryJson<DomainNameserverInventory>("domains.json", (current) => {
    const nameserverUpdates = [
      ...(current?.nameserverUpdates ?? []).filter((entry) => entry.requestHash !== input.requestHash),
      input
    ];
    return {
      ...(current ?? {}),
      nameserverUpdates
    };
  });
}

function hashNameserverRequest(input: {
  domain: string;
  zoneId: string;
  nameservers: string[];
  approvalToken: string;
}): string {
  return createHash("sha256")
    .update(stableStringify({
      domain: input.domain,
      zoneId: input.zoneId,
      nameservers: input.nameservers,
      approvalTokenHash: approvalTokenHash(input.approvalToken)
    }))
    .digest("hex");
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

function parseNameservers(values: unknown[]): string[] {
  const nameservers = values.map((value, index) => requiredString(value, `nameservers[${index}]`));
  const normalized = normalizeRoute53Nameservers(nameservers);
  if (normalized.length < 2 || normalized.length > 13) {
    throw new DomainNameserverInputError("nameservers must contain 2 to 13 entries.");
  }
  for (const value of normalized) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z0-9-]{2,63}$/.test(value)) {
      throw new DomainNameserverInputError(`Invalid nameserver: ${value}`);
    }
  }
  return normalized;
}

function sameNameservers(left: string[], right: string[]): boolean {
  return stableStringify(normalizeRoute53Nameservers(left)) === stableStringify(normalizeRoute53Nameservers(right));
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new DomainNameserverInputError(`Invalid domain name: ${value}`);
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
    throw new DomainNameserverInputError(`${field} is required.`);
  }
  return value.trim();
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new DomainNameserverInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown nameserver update error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

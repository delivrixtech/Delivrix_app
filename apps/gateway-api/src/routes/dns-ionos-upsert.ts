/**
 * POST /v1/dns/ionos/upsert — Hito 5.12 Cloud DNS write actuator.
 *
 * Sigue el mismo patrón de gates duros que `domains-purchase.ts` y
 * `domains-dns.ts`:
 *   - WRITES_DISABLED (kill switch IONOS_DNS_ENABLE_WRITES).
 *   - APPROVAL_NOT_FOUND_OR_EXPIRED (artifact aprobado en Canvas Live + audit).
 *   - ZONE_INVALID / RECORDS_EMPTY (validación de input).
 *
 * Idempotency-Key opcional via header — se persiste en audit metadata para
 * que replays del cliente sean trazables.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  IonosDnsActuator,
  IonosDnsRecordWriteInput,
  IonosDnsUpsertResult
} from "../../../../packages/adapters/src/index.ts";
import { IonosDnsActuatorError } from "../../../../packages/adapters/src/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import type {
  OpenClawWorkspace,
  OpenClawWorkspaceFileRef
} from "../openclaw-workspace.ts";
import {
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken,
  approvalTokenHash
} from "../approval-guard.ts";
import { readRequestBody } from "../request-body.ts";
import {
  createSafeDigFn,
  type AutoRollbackManager,
  type DnsDigFn,
  type RollbackSnapshot
} from "../auto-rollback.ts";

export interface IonosDnsUpsertAdapter {
  isLive(): boolean;
  isWriteEnabled(): boolean;
  writeApiKindLabel(): "cloud-dns" | "hosting-dns";
  createZone: IonosDnsActuator["createZone"];
  upsertRecords: IonosDnsActuator["upsertRecords"];
  deleteRecord?: IonosDnsActuator["deleteRecord"];
  listRecords?: IonosDnsActuator["listRecords"];
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface WebhookBroadcaster {
  broadcast(event: AuditEventInput): Promise<unknown>;
}

export interface IonosDnsUpsertDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  adapter: IonosDnsUpsertAdapter;
  workspace: OpenClawWorkspace;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  autoRollbackManager?: AutoRollbackManager;
  webhookBroadcaster?: WebhookBroadcaster;
  dnsDigFn?: DnsDigFn;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface IonosDnsUpsertBody {
  zone?: unknown;
  records?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
}

interface IonosDnsInventory {
  ionosDnsZones?: Array<{
    zone: string;
    zoneId: string;
    nameservers: string[];
    apiKind: "cloud-dns" | "hosting-dns";
    updatedAt: string;
    records: Array<{
      name: string;
      type: string;
      content: string;
      ttl?: number;
      prio?: number;
      rrsetId: string;
      updatedAt: string;
    }>;
  }>;
}

const skillName = "ionos_dns_upsert";
const approvalMaxAgeMs = 15 * 60 * 1000;

export async function handleIonosDnsUpsertHttp(
  deps: IonosDnsUpsertDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const body = await readJson<IonosDnsUpsertBody>(deps.request);
  const zone = normalizeZoneName(requiredString(body.zone, "zone"));
  const records = parseRecords(body.records);
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const idempotencyKey = headerString(deps.request, "idempotency-key");
  const apiKind = deps.adapter.writeApiKindLabel();

  const blockers: string[] = [];
  if (!deps.adapter.isLive()) blockers.push("ionos_dns_credentials_missing");
  if (!deps.adapter.isWriteEnabled()) blockers.push("writes_disabled");

  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) blockers.push("approval_not_found_or_expired");

  if (blockers.length > 0) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { zone, recordCount: records.length, actorId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers,
        apiKind,
        approvalMatched: Boolean(approval),
        idempotencyKey
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.ionos.upsert_blocked",
      targetType: "ionos_dns_zone",
      targetId: zone,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        provider: "ionos-cloud-dns",
        apiKind,
        blockers,
        recordCount: records.length,
        idempotencyKey: idempotencyKey ?? null,
        workspacePath: workspace?.path
      }
    });
    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      zone,
      blockers,
      apiKind,
      workspace
    });
    return;
  }

  try {
    const createdZone = await deps.adapter.createZone(zone);
    const rollbackAuditId = `ionos-dns-${randomUUID()}`;
    const beforeRecords = deps.adapter.listRecords
      ? await deps.adapter.listRecords(createdZone.zoneId).catch(() => null)
      : null;
    if (deps.autoRollbackManager && beforeRecords) {
      await deps.autoRollbackManager.captureSnapshot({
        auditId: rollbackAuditId,
        kind: "dns",
        beforeState: {
          provider: "ionos-cloud-dns",
          zone,
          zoneId: createdZone.zoneId,
          records: beforeRecords,
          requestedRecords: records
        },
        metadata: {
          provider: "ionos-cloud-dns",
          apiKind,
          zone,
          zoneId: createdZone.zoneId,
          actorId
        }
      });
    }
    const upsert: IonosDnsUpsertResult = await deps.adapter.upsertRecords(createdZone.zoneId, records);

    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { zone, zoneId: createdZone.zoneId, recordCount: records.length, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        apiKind,
        zoneId: createdZone.zoneId,
        nameservers: createdZone.nameservers,
        rrsetIds: upsert.rrsetIds,
        idempotent: upsert.idempotent,
        idempotencyKey
      }
    });
    await safeUpdateInventory(deps.workspace, {
      zone,
      zoneId: createdZone.zoneId,
      nameservers: createdZone.nameservers,
      apiKind,
      records,
      rrsetIds: upsert.rrsetIds,
      updatedAt: now.toISOString()
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.ionos.upserted",
      targetType: "ionos_dns_zone",
      targetId: zone,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "ionos-cloud-dns",
        apiKind,
        zone,
        zoneId: createdZone.zoneId,
        nameservers: createdZone.nameservers,
        recordCount: records.length,
        rrsetIds: upsert.rrsetIds,
        idempotent: upsert.idempotent,
        approvalTokenHash: approvalTokenHash(approvalToken),
        approvalArtifactId: approval?.artifactId ?? null,
        idempotencyKey: idempotencyKey ?? null,
        workspacePath: workspace?.path
      }
    });
    scheduleIonosDnsRollbackCheck({
      manager: deps.autoRollbackManager,
      webhookBroadcaster: deps.webhookBroadcaster,
      auditLog: deps.auditLog,
      adapter: deps.adapter,
      auditId: rollbackAuditId,
      zone,
      zoneId: createdZone.zoneId,
      records,
      rrsetIds: upsert.rrsetIds,
      digFn: deps.dnsDigFn ?? createSafeDigFn()
    });

    json(deps.response, 200, {
      ok: true,
      status: upsert.idempotent ? "idempotent" : "applied",
      zone,
      zoneId: createdZone.zoneId,
      nameservers: createdZone.nameservers,
      rrsetIds: upsert.rrsetIds,
      apiKind,
      workspace
    });
  } catch (error) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { zone, recordCount: records.length, actorId },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: {
        apiKind,
        error: errorMessage(error),
        errorCode: error instanceof IonosDnsActuatorError ? error.code : undefined,
        upstreamStatus: error instanceof IonosDnsActuatorError ? error.statusCode : undefined,
        requestId: error instanceof IonosDnsActuatorError ? error.requestId : undefined,
        idempotencyKey
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.ionos.upsert_failed",
      targetType: "ionos_dns_zone",
      targetId: zone,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "ionos-cloud-dns",
        apiKind,
        recordCount: records.length,
        errorMessage: errorMessage(error),
        errorCode: error instanceof IonosDnsActuatorError ? error.code ?? null : null,
        upstreamStatus: error instanceof IonosDnsActuatorError ? error.statusCode : null,
        requestId: error instanceof IonosDnsActuatorError ? error.requestId ?? null : null,
        idempotencyKey: idempotencyKey ?? null,
        workspacePath: workspace?.path
      }
    });
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      zone,
      apiKind,
      error: "ionos_dns_upsert_failed",
      message: errorMessage(error),
      ...(error instanceof IonosDnsActuatorError
        ? { upstreamStatus: error.statusCode, code: error.code, requestId: error.requestId }
        : {}),
      workspace
    });
  }
}

export class IonosDnsUpsertInputError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "IonosDnsUpsertInputError";
  }
}

function scheduleIonosDnsRollbackCheck(input: {
  manager?: AutoRollbackManager;
  webhookBroadcaster?: WebhookBroadcaster;
  auditLog: AuditSink;
  adapter: IonosDnsUpsertAdapter;
  auditId: string;
  zone: string;
  zoneId: string;
  records: IonosDnsRecordWriteInput[];
  rrsetIds: string[];
  digFn: DnsDigFn;
}): void {
  if (!input.manager) {
    return;
  }

  queueMicrotask(async () => {
    const propagation = await input.manager!.waitForDnsPropagation({
      auditId: input.auditId,
      domain: input.zone,
      expectedRecords: ionosExpectedRecords(input.zone, input.records),
      digFn: input.digFn
    });
    if (propagation.propagated) {
      return;
    }

    const rollback = await input.manager!.applyRollback({
      auditId: input.auditId,
      kind: "dns",
      reason: `propagation_timeout_after_${propagation.elapsedMs}ms`,
      restoreFn: async (snapshot) => restoreIonosDnsSnapshot(snapshot, input.adapter, input.rrsetIds)
    });
    const event: AuditEventInput = {
      actorType: "system",
      actorId: "auto-rollback",
      action: rollback.applied ? "oc.dns.auto_rolled_back" : "oc.dns.auto_rollback_failed",
      targetType: "ionos_dns_zone",
      targetId: input.zone,
      riskLevel: "critical",
      decision: rollback.applied ? "allow" : "reject",
      humanApproved: false,
      metadata: {
        category: "supervised_local_state",
        provider: "ionos-cloud-dns",
        auditId: input.auditId,
        zone: input.zone,
        zoneId: input.zoneId,
        reason: rollback.reason,
        elapsedMs: propagation.elapsedMs,
        rollbackApplied: rollback.applied
      }
    };
    await input.auditLog.append(event);
    void input.webhookBroadcaster?.broadcast(event).catch(() => undefined);
  });
}

async function restoreIonosDnsSnapshot(
  snapshot: RollbackSnapshot,
  adapter: IonosDnsUpsertAdapter,
  rrsetIds: string[]
): Promise<void> {
  const state = snapshot.beforeState;
  if (!isRecord(state)) {
    throw new Error("rollback snapshot beforeState is invalid");
  }
  const zoneId = requiredSnapshotString(state.zoneId, "zoneId");
  const beforeRecords = Array.isArray(state.records)
    ? state.records.filter(isIonosSnapshotRecord)
    : [];
  const requestedRecords = Array.isArray(state.requestedRecords)
    ? state.requestedRecords.filter(isIonosRecordInput)
    : [];
  const beforeIdentities = new Set(beforeRecords.map(ionosRecordIdentity));

  if (adapter.deleteRecord) {
    for (let index = 0; index < requestedRecords.length; index += 1) {
      const requested = requestedRecords[index]!;
      const rrsetId = rrsetIds[index];
      if (rrsetId && !beforeIdentities.has(ionosRecordIdentity(requested))) {
        await adapter.deleteRecord(zoneId, rrsetId).catch(() => undefined);
      }
    }
  }

  if (beforeRecords.length > 0) {
    await adapter.upsertRecords(zoneId, beforeRecords.map(snapshotRecordToWriteInput));
  }
}

export function handleIonosDnsUpsertError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof IonosDnsUpsertInputError) {
    json(response, error.statusCode, {
      error: "invalid_ionos_dns_upsert_request",
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
    if (!auditApprovalMatchesToken(event, input.approvalToken)) {
      return false;
    }
    const approvedAt = Date.parse(event.occurredAt);
    return (
      Number.isFinite(approvedAt) &&
      input.now.getTime() - approvedAt >= 0 &&
      input.now.getTime() - approvedAt <= input.maxAgeMs
    );
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

async function safeUpdateInventory(
  workspace: OpenClawWorkspace,
  input: {
    zone: string;
    zoneId: string;
    nameservers: string[];
    apiKind: "cloud-dns" | "hosting-dns";
    records: IonosDnsRecordWriteInput[];
    rrsetIds: string[];
    updatedAt: string;
  }
): Promise<void> {
  try {
    await workspace.updateInventoryJson<IonosDnsInventory>("dns-ionos.json", (current) => {
      const ionosDnsZones = (current?.ionosDnsZones ?? []).filter(
        (existing) => existing.zone !== input.zone
      );
      ionosDnsZones.push({
        zone: input.zone,
        zoneId: input.zoneId,
        nameservers: input.nameservers,
        apiKind: input.apiKind,
        updatedAt: input.updatedAt,
        records: input.records.map((record, index) => ({
          name: record.name,
          type: record.type.toUpperCase(),
          content: record.content,
          ttl: record.ttl,
          prio: record.prio,
          rrsetId: input.rrsetIds[index] ?? "",
          updatedAt: input.updatedAt
        }))
      });
      return {
        ...(current ?? {}),
        ionosDnsZones
      };
    });
  } catch {
    return;
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

function parseRecords(value: unknown): IonosDnsRecordWriteInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new IonosDnsUpsertInputError("records must be a non-empty array.");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new IonosDnsUpsertInputError(`records[${index}] must be an object.`);
    }
    const name = requiredString(item.name, `records[${index}].name`);
    const type = requiredString(item.type, `records[${index}].type`).toUpperCase();
    if (!/^(A|AAAA|MX|TXT|CNAME|NS|CAA|SRV)$/.test(type)) {
      throw new IonosDnsUpsertInputError(`records[${index}].type is not supported.`);
    }
    const content = requiredString(item.content, `records[${index}].content`);
    let ttl: number | undefined;
    if (item.ttl !== undefined && item.ttl !== null) {
      const parsed = Number(item.ttl);
      if (!Number.isInteger(parsed) || parsed < 30 || parsed > 604800) {
        throw new IonosDnsUpsertInputError(
          `records[${index}].ttl must be an integer between 30 and 604800.`
        );
      }
      ttl = parsed;
    }
    let prio: number | undefined;
    if (item.prio !== undefined && item.prio !== null) {
      const parsed = Number(item.prio);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new IonosDnsUpsertInputError(
          `records[${index}].prio must be an integer between 0 and 65535.`
        );
      }
      prio = parsed;
    }
    return { name, type, content, ttl, prio };
  });
}

function headerString(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0].trim() || undefined;
  }
  return undefined;
}

function normalizeZoneName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)
  ) {
    throw new IonosDnsUpsertInputError(`Invalid IONOS DNS zone: ${value}`);
  }
  return normalized;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IonosDnsUpsertInputError(`${field} is required.`);
  }
  return value.trim();
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new IonosDnsUpsertInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown IONOS DNS upsert error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ionosExpectedRecords(zone: string, records: IonosDnsRecordWriteInput[]): Array<{
  domain: string;
  type: string;
  value: string;
}> {
  return records.map((record) => ({
    domain: ionosRecordDomain(zone, record.name),
    type: record.type,
    value: record.content
  }));
}

function ionosRecordDomain(zone: string, name: string): string {
  const normalizedName = name.trim().replace(/\.$/, "");
  if (normalizedName === "@" || normalizedName === "") {
    return zone;
  }
  return normalizedName.includes(".") ? normalizedName : `${normalizedName}.${zone}`;
}

function isIonosRecordInput(value: unknown): value is IonosDnsRecordWriteInput {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.type === "string" &&
    typeof value.content === "string"
  );
}

function isIonosSnapshotRecord(value: unknown): value is IonosDnsRecordWriteInput & { id?: string } {
  return isIonosRecordInput(value);
}

function snapshotRecordToWriteInput(
  record: IonosDnsRecordWriteInput & { id?: string }
): IonosDnsRecordWriteInput {
  return {
    name: record.name,
    type: record.type,
    content: record.content,
    ...(typeof record.ttl === "number" ? { ttl: record.ttl } : {}),
    ...(typeof record.prio === "number" ? { prio: record.prio } : {})
  };
}

function ionosRecordIdentity(record: IonosDnsRecordWriteInput): string {
  return `${record.name.toLowerCase()}|${record.type.toUpperCase()}|${record.content}`;
}

function requiredSnapshotString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`rollback snapshot ${field} is required`);
  }
  return value.trim();
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

// Re-export for the gateway main wire-up to suppress unused randomUUID warnings
// (kept for future correlation-id generation when handler grows).
void randomUUID;

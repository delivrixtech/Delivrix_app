/**
 * POST /v1/dns/namecheap/upsert — actuador de escritura DNS de Namecheap (proveedor
 * INDEPENDIENTE: Namecheap es autoritativo de su propia zona BasicDNS, sin depender de
 * Route53 ni de ningún otro proveedor). Espejo de dns-ionos-upsert.ts con el mismo patrón
 * de gates duros:
 *   - NAMECHEAP_DNS_ENABLE_WRITES (kill switch de escrituras).
 *   - APPROVAL_NOT_FOUND_OR_EXPIRED (artifact aprobado en Canvas Live + audit, TTL 15 min).
 *   - DOMAIN_INVALID / RECORDS_EMPTY (validación de input).
 *
 * Diferencias de modelo vs IONOS: Namecheap NO tiene zoneId (la zona es el dominio) y
 * setHosts es full-set; el merge (preservar records ajenos) vive en NamecheapDnsProvider.
 * Multicuenta: la cuenta se direcciona por id/label (accountId opcional), NUNCA "default".
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DnsProvider, DnsRecordSpec } from "../../../../packages/adapters/src/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import type { OpenClawWorkspace, OpenClawWorkspaceFileRef } from "../openclaw-workspace.ts";
import {
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken,
  approvalTokenHash
} from "../approval-guard.ts";
import { readRequestBody } from "../request-body.ts";

/** Resuelve el proveedor DNS Namecheap de una cuenta (por id/label), o null si no existe/ambiguo. */
export type NamecheapDnsProviderResolver = (accountId?: string) => DnsProvider | null;

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

export interface NamecheapDnsUpsertDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  resolveProvider: NamecheapDnsProviderResolver;
  workspace: OpenClawWorkspace;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface NamecheapDnsUpsertBody {
  domain?: unknown;
  records?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  accountId?: unknown;
}

interface NamecheapDnsInventory {
  namecheapDnsZones?: Array<{
    domain: string;
    accountId: string;
    nameservers: string[];
    updatedAt: string;
    records: Array<{ name: string; type: string; content: string; ttl?: number; prio?: number; updatedAt: string }>;
  }>;
}

const skillName = "namecheap_dns_upsert";
const approvalMaxAgeMs = 15 * 60 * 1000;

export async function handleNamecheapDnsUpsertHttp(
  deps: NamecheapDnsUpsertDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const body = await readJson<NamecheapDnsUpsertBody>(deps.request);
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const records = parseRecords(body.records);
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const accountId = typeof body.accountId === "string" && body.accountId.trim() ? body.accountId.trim() : undefined;

  const provider = deps.resolveProvider(accountId);

  const blockers: string[] = [];
  if (!provider) blockers.push("namecheap_account_not_found");
  if (provider && !provider.isLive()) blockers.push("namecheap_dns_credentials_missing");
  if (provider && !provider.isWriteEnabled()) blockers.push("writes_disabled");

  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) blockers.push("approval_not_found_or_expired");

  if (blockers.length > 0 || !provider) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, recordCount: records.length, actorId, accountId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: { blockers, approvalMatched: Boolean(approval), accountId: accountId ?? null }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.namecheap.upsert_blocked",
      targetType: "namecheap_dns_zone",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        provider: "namecheap-dns",
        blockers,
        recordCount: records.length,
        accountId: accountId ?? null,
        workspacePath: workspace?.path
      }
    });
    json(deps.response, 409, { ok: false, status: "blocked", domain, blockers, workspace });
    return;
  }

  try {
    const zone = await provider.ensureZone(domain);
    const specs: DnsRecordSpec[] = records.map((record) => ({
      name: record.name,
      type: record.type,
      ...(record.ttl !== undefined ? { ttl: record.ttl } : {}),
      values: [record.content],
      ...(record.prio !== undefined ? { prio: record.prio } : {})
    }));
    const upsert = await provider.upsertRecords(zone.zoneId, specs);

    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, recordCount: records.length, actorId, accountId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        accountId: provider.providerId,
        nameservers: zone.nameServers,
        idempotent: upsert.idempotent,
        changeIds: upsert.changeIds
      }
    });
    await safeUpdateInventory(deps.workspace, {
      domain,
      accountId: accountId ?? provider.providerId,
      nameservers: zone.nameServers,
      records,
      updatedAt: now.toISOString()
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.namecheap.upserted",
      targetType: "namecheap_dns_zone",
      targetId: domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "namecheap-dns",
        domain,
        nameservers: zone.nameServers,
        recordCount: records.length,
        idempotent: upsert.idempotent,
        accountId: accountId ?? null,
        approvalTokenHash: approvalTokenHash(approvalToken),
        approvalArtifactId: approval?.artifactId ?? null,
        workspacePath: workspace?.path
      }
    });

    json(deps.response, 200, {
      ok: true,
      status: upsert.idempotent ? "idempotent" : "applied",
      domain,
      nameservers: zone.nameServers,
      workspace
    });
  } catch (error) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, recordCount: records.length, actorId, accountId },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: { error: errorMessage(error) }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.dns.namecheap.upsert_failed",
      targetType: "namecheap_dns_zone",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "namecheap-dns",
        recordCount: records.length,
        errorMessage: errorMessage(error),
        workspacePath: workspace?.path
      }
    });
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      domain,
      error: "namecheap_dns_upsert_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export function handleNamecheapDnsUpsertError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof NamecheapDnsUpsertInputError) {
    json(response, error.statusCode, { error: "invalid_namecheap_dns_upsert_request", message: error.message });
    return true;
  }
  if (error instanceof SyntaxError) {
    json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return true;
  }
  return false;
}

export class NamecheapDnsUpsertInputError extends Error {
  readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = "NamecheapDnsUpsertInputError";
  }
}

interface ParsedRecord {
  name: string;
  type: DnsRecordSpec["type"];
  content: string;
  ttl?: number;
  prio?: number;
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
    if (!auditApprovalMatchesToken(event, input.approvalToken)) return false;
    const approvedAt = Date.parse(event.occurredAt);
    return (
      Number.isFinite(approvedAt) &&
      input.now.getTime() - approvedAt >= 0 &&
      input.now.getTime() - approvedAt <= input.maxAgeMs
    );
  });
  if (!auditEvent) return null;
  const state = await input.readCanvasState();
  return state.artifacts.find((artifact) =>
    artifactMatchesAuditApproval({
      artifact,
      approvalEvent: auditEvent,
      approvalToken: input.approvalToken,
      now: input.now,
      maxAgeMs: input.maxAgeMs
    })
  ) ?? null;
}

async function safeUpdateInventory(
  workspace: OpenClawWorkspace,
  input: {
    domain: string;
    accountId: string;
    nameservers: string[];
    records: ParsedRecord[];
    updatedAt: string;
  }
): Promise<void> {
  try {
    await workspace.updateInventoryJson<NamecheapDnsInventory>("dns-namecheap.json", (current) => {
      const namecheapDnsZones = (current?.namecheapDnsZones ?? []).filter((existing) => existing.domain !== input.domain);
      namecheapDnsZones.push({
        domain: input.domain,
        accountId: input.accountId,
        nameservers: input.nameservers,
        updatedAt: input.updatedAt,
        records: input.records.map((record) => ({
          name: record.name,
          type: record.type,
          content: record.content,
          ttl: record.ttl,
          prio: record.prio,
          updatedAt: input.updatedAt
        }))
      });
      return { ...(current ?? {}), namecheapDnsZones };
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

function parseRecords(value: unknown): ParsedRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new NamecheapDnsUpsertInputError("records must be a non-empty array.");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new NamecheapDnsUpsertInputError(`records[${index}] must be an object.`);
    }
    const name = requiredString(item.name, `records[${index}].name`);
    const type = requiredString(item.type, `records[${index}].type`).toUpperCase();
    if (!/^(A|MX|TXT|CNAME)$/.test(type)) {
      throw new NamecheapDnsUpsertInputError(`records[${index}].type is not supported (A|MX|TXT|CNAME).`);
    }
    const content = requiredString(item.content, `records[${index}].content`);
    let ttl: number | undefined;
    if (item.ttl !== undefined && item.ttl !== null) {
      const parsed = Number(item.ttl);
      if (!Number.isInteger(parsed) || parsed < 60 || parsed > 604800) {
        throw new NamecheapDnsUpsertInputError(`records[${index}].ttl must be an integer between 60 and 604800.`);
      }
      ttl = parsed;
    }
    let prio: number | undefined;
    if (item.prio !== undefined && item.prio !== null) {
      const parsed = Number(item.prio);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new NamecheapDnsUpsertInputError(`records[${index}].prio must be an integer between 0 and 65535.`);
      }
      prio = parsed;
    }
    return { name, type: type as DnsRecordSpec["type"], content, ttl, prio };
  });
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new NamecheapDnsUpsertInputError(`Invalid domain: ${value}`);
  }
  return normalized;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NamecheapDnsUpsertInputError(`${field} is required.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new NamecheapDnsUpsertInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Namecheap DNS upsert error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

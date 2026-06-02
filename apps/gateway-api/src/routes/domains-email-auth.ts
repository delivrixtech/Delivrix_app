import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AwsRoute53DnsChangeResult,
  AwsRoute53DnsRecordInput,
  AwsRoute53DnsSource
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

export interface EmailAuthDnsAdapter {
  isLive(): boolean;
  isWriteEnabled(): boolean;
  currentSource(responseOk?: boolean, errorMessage?: string): AwsRoute53DnsSource;
  upsertRecord(zoneId: string, opts: AwsRoute53DnsRecordInput): Promise<AwsRoute53DnsChangeResult>;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

export interface EmailAuthConfigureDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  dnsAdapter: EmailAuthDnsAdapter;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface EmailAuthConfigureBody {
  domain?: unknown;
  mxServerIp?: unknown;
  zoneId?: unknown;
  selector?: unknown;
  dmarcPolicy?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  taskId?: unknown;
}

interface EmailAuthInventory {
  dnsZones?: Array<{
    domain: string;
    zoneId: string;
  }>;
  emailAuth?: Array<{
    domain: string;
    zoneId: string;
    selector: string;
    dkimPrivateKeyPath: string;
    configuredAt: string;
    records: Array<{
      name: string;
      type: string;
      ttl: number;
      changeId: string;
    }>;
  }>;
}

const skillName = "configure_email_auth";
const approvalMaxAgeMs = 15 * 60 * 1000;

export async function handleEmailAuthConfigureHttp(
  deps: EmailAuthConfigureDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const body = await readJson<EmailAuthConfigureBody>(deps.request);
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const mxServerIp = normalizeIpv4(requiredString(body.mxServerIp, "mxServerIp"));
  const selector = normalizeSelector(body.selector);
  const dmarcPolicy = normalizeDmarcPolicy(body.dmarcPolicy);
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const taskId = normalizeTaskId(body.taskId) ?? `email-auth-${randomUUID()}`;
  const source = deps.dnsAdapter.currentSource(true);

  await emitTaskDeclare(deps.canvasLiveEvents, taskId, `Email auth · ${domain}`, actorId, now);
  const learnings = await safeReadLearnings(deps.workspace);
  await emitFileAction(deps.canvasLiveEvents, taskId, "read", "learnings/", `learnings:${learnings.length}`, now);

  const blockers: string[] = [];
  if (env.EMAIL_AUTH_ENABLE_WRITES !== "true") blockers.push("email_auth_write_flag_disabled");
  if (!deps.dnsAdapter.isLive()) blockers.push("aws_route53_dns_credentials_missing");
  if (!deps.dnsAdapter.isWriteEnabled()) blockers.push("dns_write_flag_disabled");
  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) blockers.push("approval_not_found_or_expired");

  const zoneId = typeof body.zoneId === "string" && body.zoneId.trim()
    ? body.zoneId.trim()
    : await findWorkspaceZoneId(deps.workspace, domain);
  if (!zoneId) blockers.push("route53_zone_missing");

  if (blockers.length > 0) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, mxServerIp, selector, dmarcPolicy, actorId },
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
      action: "oc.email_auth.configure_blocked",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        blockers,
        provider: "aws-route53",
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.email_auth.configure_blocked", "domain", domain, "critical", now);
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

  const keyPair = generateDkimKeyPair();
  await emitCommandAction(deps.canvasLiveEvents, taskId, "node:crypto generateKeyPairSync rsa:2048", 0, "", "", now);
  const records = buildEmailAuthRecords({
    domain,
    mxServerIp,
    selector,
    dmarcPolicy,
    dkimPublicKey: keyPair.publicKeyB64
  });

  try {
    const dkimPrivateKeyFile = await deps.workspace.writeWorkspaceFile(
      `inventory/dkim-keys/${domain}/${selector}.private`,
      keyPair.privateKeyPem
    );
    await emitFileAction(deps.canvasLiveEvents, taskId, "write", dkimPrivateKeyFile.path, "DKIM private key saved for SSH provisioning", now);

    const changes: Array<AwsRoute53DnsRecordInput & AwsRoute53DnsChangeResult> = [];
    for (const record of records) {
      const change = await deps.dnsAdapter.upsertRecord(zoneId, record);
      changes.push({ ...record, ...change });
      await emitApiAction(
        deps.canvasLiveEvents,
        taskId,
        "POST",
        `/2013-04-01/hostedzone/${zoneId}/rrset`,
        200,
        { changeId: change.changeId, record: { name: record.name, type: record.type } },
        now
      );
    }

    await updateEmailAuthInventory(deps.workspace, {
      domain,
      zoneId,
      selector,
      dkimPrivateKeyPath: dkimPrivateKeyFile.path,
      configuredAt: now.toISOString(),
      records: changes
    });
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, mxServerIp, selector, dmarcPolicy, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        zoneId,
        dkimPrivateKeyPath: dkimPrivateKeyFile.path,
        records: changes.map((record) => ({
          name: record.name,
          type: record.type,
          changeId: record.changeId
        })),
        learningCount: learnings.length
      }
    });
    await emitFileAction(deps.canvasLiveEvents, taskId, "write", workspace?.path ?? "executions/", "email auth execution record", now);

    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.email_auth.configured",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "aws-route53",
        zoneId,
        selector,
        dmarcPolicy,
        recordCount: records.length,
        changeIds: changes.map((change) => change.changeId),
        dkimPrivateKeyPath: dkimPrivateKeyFile.path,
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.email_auth.configured", "domain", domain, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", now);

    json(deps.response, 200, {
      ok: true,
      status: "pending",
      domain,
      zoneId,
      selector,
      dkimPrivateKeyPath: dkimPrivateKeyFile.path,
      records: changes.map((record) => ({
        name: record.name,
        type: record.type,
        changeId: record.changeId
      })),
      workspace
    });
  } catch (error) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, mxServerIp, selector, dmarcPolicy, actorId },
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
      action: "oc.email_auth.configure_failed",
      targetType: "domain",
      targetId: domain,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        provider: "aws-route53",
        errorMessage: errorMessage(error),
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.email_auth.configure_failed", "domain", domain, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      domain,
      error: "email_auth_configure_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export class EmailAuthInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "EmailAuthInputError";
  }
}

export function handleEmailAuthError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof EmailAuthInputError) {
    json(response, error.statusCode, {
      error: "invalid_email_auth_request",
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

export function buildEmailAuthRecords(input: {
  domain: string;
  mxServerIp: string;
  selector: string;
  dmarcPolicy: "none" | "quarantine" | "reject";
  dkimPublicKey: string;
}): AwsRoute53DnsRecordInput[] {
  return [
    {
      name: `${input.domain}.`,
      type: "TXT",
      ttl: 300,
      values: [`v=spf1 ip4:${input.mxServerIp} -all`]
    },
    {
      name: `${input.selector}._domainkey.${input.domain}.`,
      type: "TXT",
      ttl: 300,
      values: [`v=DKIM1; k=rsa; p=${input.dkimPublicKey}`]
    },
    {
      name: `_dmarc.${input.domain}.`,
      type: "TXT",
      ttl: 300,
      values: [
        `v=DMARC1; p=${input.dmarcPolicy}; rua=mailto:dmarc-reports@delivrix.com; ruf=mailto:dmarc-forensics@delivrix.com; fo=1`
      ]
    }
  ];
}

function generateDkimKeyPair(): { privateKeyPem: string; publicKeyB64: string } {
  const keyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return {
    privateKeyPem: keyPair.privateKey,
    publicKeyB64: keyPair.publicKey
      .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s+/g, "")
  };
}

async function findWorkspaceZoneId(workspace: OpenClawWorkspace, domain: string): Promise<string | null> {
  const inventory = await workspace.readInventoryJson<EmailAuthInventory>("domains.json").catch(() => null);
  return inventory?.dnsZones?.find((zone) => zone.domain === domain)?.zoneId ?? null;
}

async function updateEmailAuthInventory(
  workspace: OpenClawWorkspace,
  input: {
    domain: string;
    zoneId: string;
    selector: string;
    dkimPrivateKeyPath: string;
    configuredAt: string;
    records: Array<AwsRoute53DnsRecordInput & AwsRoute53DnsChangeResult>;
  }
): Promise<void> {
  await workspace.updateInventoryJson<EmailAuthInventory>("domains.json", (current) => {
    const emailAuth = (current?.emailAuth ?? []).filter((entry) => entry.domain !== input.domain);
    emailAuth.push({
      domain: input.domain,
      zoneId: input.zoneId,
      selector: input.selector,
      dkimPrivateKeyPath: input.dkimPrivateKeyPath,
      configuredAt: input.configuredAt,
      records: input.records.map((record) => ({
        name: record.name,
        type: record.type,
        ttl: record.ttl,
        changeId: record.changeId
      }))
    });
    return {
      ...(current ?? {}),
      emailAuth
    };
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

function normalizeSelector(value: unknown): string {
  const selector = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "default";
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(selector)) {
    throw new EmailAuthInputError("selector must be a DNS-safe DKIM selector.");
  }
  return selector;
}

function normalizeDmarcPolicy(value: unknown): "none" | "quarantine" | "reject" {
  if (value === undefined || value === null || value === "") return "none";
  if (value === "none" || value === "quarantine" || value === "reject") return value;
  throw new EmailAuthInputError("dmarcPolicy must be none, quarantine, or reject.");
}

function normalizeIpv4(value: string): string {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)) {
    throw new EmailAuthInputError(`Invalid IPv4 address: ${value}`);
  }
  return parts.map((part) => String(Number(part))).join(".");
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new EmailAuthInputError(`Invalid domain name: ${value}`);
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
    throw new EmailAuthInputError(`${field} is required.`);
  }
  return value.trim();
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new EmailAuthInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown email auth error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

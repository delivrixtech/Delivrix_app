import { promises as dns } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  WebdockServer,
  WebdockSetServerIdentityResult,
  WebdockSetServerMainDomainResult,
  WebdockSetServerPtrResult,
  WebdockSshRunner
} from "../../../../packages/adapters/src/index.ts";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import {
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken
} from "../approval-guard.ts";
import { readRequestBody } from "../request-body.ts";
import type { SkillParamSchema } from "../skill-schemas.ts";
import { smtpHostForDomain } from "../smtp-naming.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";

export interface BindWebdockMainDomainParams extends Record<string, unknown> {
  serverSlug: string;
  domain: string;
  setPtr: boolean;
  actorId: string;
  approvalToken: string;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface BindWebdockMainDomainSkillParams extends Record<string, unknown> {
  serverSlug: string;
  domain: string;
  setPtr: boolean;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface BindWebdockMainDomainResult {
  ok: boolean;
  serverSlug: string;
  mainDomain: string;
  previousMainDomain: string | null;
  identitySet: boolean;
  identityCallbackId?: string;
  ptrSet: boolean;
  ptrSkipReason?: "ipv4_missing" | "operator_opt_out" | "fcrdns_pending" | "set_failed";
  fcrdnsVerified: boolean;
  fcrdnsStatus: "verified" | "pending";
  fcrdns?: {
    expectedA: string;
    expectedPtr: string;
    forwardA: string[];
    reversePtr: string[];
  };
  alreadyBound: boolean;
  eventId: string;
  durationMs: number;
  error?: string;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

export interface BindWebdockMainDomainApprovalGuard {
  verify(input: {
    approvalToken: string;
    actorId: string;
  }): Promise<{ ok: boolean; eventId?: string; artifactId?: string }>;
}

export interface BindWebdockMainDomainAdapter {
  getServer(serverSlug: string): Promise<WebdockServer>;
  setServerIdentity(opts: {
    serverSlug: string;
    mainDomain: string;
    aliasDomains?: string[];
    removeDefaultAlias?: boolean;
    waitForCompletion?: boolean;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<WebdockSetServerIdentityResult>;
  setServerMainDomain(opts: {
    serverSlug: string;
    domain: string;
    serverIp?: string | null;
    sshRunner?: WebdockSshRunner;
  }): Promise<WebdockSetServerMainDomainResult>;
  setServerPtr(opts: {
    serverSlug: string;
    ipv4: string;
    ptrValue: string;
  }): Promise<WebdockSetServerPtrResult>;
}

export interface FcrdnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  reverse(ip: string): Promise<string[]>;
}

export interface BindWebdockMainDomainDeps {
  auditLog: AuditSink;
  approvalGuard: BindWebdockMainDomainApprovalGuard;
  webdockAdapter: BindWebdockMainDomainAdapter;
  sshRunner?: WebdockSshRunner;
  workspace?: OpenClawWorkspace;
  now: () => number;
  fcrdnsResolver?: FcrdnsResolver;
  fcrdnsMaxWaitMs?: number;
  fcrdnsPollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const approvalMaxAgeMs = 15 * 60 * 1000;
const defaultFcrdnsResolver: FcrdnsResolver = {
  resolve4: (hostname) => dns.resolve4(hostname),
  reverse: (ip) => dns.reverse(ip)
};

interface FcrdnsCheckResult {
  verified: boolean;
  expectedA: string;
  expectedPtr: string;
  forwardA: string[];
  reversePtr: string[];
  forwardMatched: boolean;
  reverseMatched: boolean;
}

export const bindWebdockMainDomainParamSchema: SkillParamSchema<BindWebdockMainDomainParams> = {
  safeParse(value: unknown) {
    try {
      return { success: true, data: parseParams(value, true) };
    } catch (error) {
      const message = error instanceof BindWebdockMainDomainInputError ? error.message : "invalid_params";
      return {
        success: false,
        error: {
          issues: [message],
          format: () => ({ _errors: [message] })
        }
      };
    }
  }
};

export const bindWebdockMainDomainSkillParamSchema: SkillParamSchema<BindWebdockMainDomainSkillParams> = {
  safeParse(value: unknown) {
    try {
      const params = parseParams(value, false);
      return {
        success: true,
        data: {
          serverSlug: params.serverSlug,
          domain: params.domain,
          setPtr: params.setPtr,
          ...(params.repairReason ? { repairReason: params.repairReason } : {}),
          ...(params.explicitRepairScope ? { explicitRepairScope: params.explicitRepairScope } : {})
        }
      };
    } catch (error) {
      const message = error instanceof BindWebdockMainDomainInputError ? error.message : "invalid_params";
      return {
        success: false,
        error: {
          issues: [message],
          format: () => ({ _errors: [message] })
        }
      };
    }
  }
};

export async function handleBindWebdockMainDomain(input: {
  request: IncomingMessage;
  response: ServerResponse;
  deps: BindWebdockMainDomainDeps;
}): Promise<void> {
  const startedAt = input.deps.now();
  const body = await readJson(input.request);
  const parsed = bindWebdockMainDomainParamSchema.safeParse(body);
  if (!parsed.success) {
    json(input.response, 400, { error: "invalid_params", details: parsed.error.format() });
    return;
  }
  const params = parsed.data;
  const approval = await input.deps.approvalGuard.verify({
    approvalToken: params.approvalToken,
    actorId: params.actorId
  });
  if (!approval.ok) {
    json(input.response, 403, { error: "approval_invalid" });
    return;
  }

  let server: WebdockServer;
  try {
    server = await input.deps.webdockAdapter.getServer(params.serverSlug);
  } catch {
    json(input.response, 404, { error: "server_not_found", slug: params.serverSlug });
    return;
  }

  const identityDomain = smtpHostForDomain(params.domain);
  const currentMainDomain = currentIdentityDomainFromServer(server);
  if (!params.setPtr) {
    json(input.response, 422, {
      error: "fcrdns_required",
      message: "Webdock SMTP identity requires FCrDNS verification; setPtr=false is not allowed for SMTP provisioning."
    });
    return;
  }
  if (!server.ipv4) {
    const event = await input.deps.auditLog.append({
      actorType: "operator",
      actorId: params.actorId,
      action: "oc.webdock.identity_pending_fcrdns",
      targetType: "webdock_server",
      targetId: params.serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [params.actorId],
      metadata: {
        serverSlug: params.serverSlug,
        domain: params.domain,
        identityDomain,
        ptrSet: false,
        ptrSkipReason: "ipv4_missing",
        approvalEventId: approval.eventId ?? null,
        approvalArtifactId: approval.artifactId ?? null
      }
    });
    await upsertDomainBinding(input.deps.workspace, {
      domain: params.domain,
      serverSlug: params.serverSlug,
      serverIp: "",
      status: "identity_pending_fcrdns"
    });
    json(input.response, 424, {
      ok: false,
      serverSlug: params.serverSlug,
      mainDomain: identityDomain,
      previousMainDomain: currentMainDomain,
      identitySet: false,
      ptrSet: false,
      ptrSkipReason: "ipv4_missing",
      fcrdnsVerified: false,
      fcrdnsStatus: "pending",
      alreadyBound: currentMainDomain === identityDomain,
      eventId: eventId(event),
      durationMs: input.deps.now() - startedAt,
      error: "ipv4_missing"
    } satisfies BindWebdockMainDomainResult);
    return;
  }

  let previousMainDomain: string | null = currentMainDomain;
  const alreadyBound = currentMainDomain === identityDomain;
  let identity: WebdockSetServerIdentityResult | null = null;
  if (!alreadyBound) {
    try {
      identity = await input.deps.webdockAdapter.setServerIdentity({
        serverSlug: params.serverSlug,
        mainDomain: identityDomain,
        aliasDomains: [],
        removeDefaultAlias: true,
        waitForCompletion: true
      });
      previousMainDomain = currentMainDomain;
    } catch (error) {
      await input.deps.auditLog.append({
        actorType: "operator",
        actorId: params.actorId,
        action: "oc.webdock.identity_set_failed",
        targetType: "webdock_server",
        targetId: params.serverSlug,
        riskLevel: "critical",
        decision: "reject",
        humanApproved: true,
        approverIds: [params.actorId],
        metadata: {
          serverSlug: params.serverSlug,
          domain: params.domain,
          identityDomain,
          previousMainDomain,
          error: errorMessage(error)
        }
      });
      json(input.response, 502, { error: "identity_set_failed", details: errorMessage(error) });
      return;
    }
  }

  const fcrdns = await verifyFcrdnsWithRetry({
    resolver: input.deps.fcrdnsResolver ?? defaultFcrdnsResolver,
    smtpHost: identityDomain,
    ipv4: server.ipv4,
    // 120s era insuficiente para un dominio fresco: el A recien escrito y el PTR de Webdock
    // tardan en ser visibles al resolver, y el run abortaba intermitente con fcrdns_pending
    // (lo que ademas gatillaba el loop de recuperacion de OpenClaw -> bedrock_invoke_error).
    // verifyFcrdnsWithRetry hace polling y retorna apenas verifica, asi que este valor es solo
    // el TECHO del caso de fallo; el caso normal cierra en pocos minutos. 15 min alinea con los
    // wait_for_dns_propagation del orquestador.
    maxWaitMs: input.deps.fcrdnsMaxWaitMs ?? 900_000,
    pollIntervalMs: input.deps.fcrdnsPollIntervalMs ?? 10_000,
    sleep: input.deps.sleep ?? sleep
  });

  if (!fcrdns.verified) {
    const event = await input.deps.auditLog.append({
      actorType: "operator",
      actorId: params.actorId,
      action: "oc.webdock.identity_pending_fcrdns",
      targetType: "webdock_server",
      targetId: params.serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [params.actorId],
      metadata: {
        serverSlug: params.serverSlug,
        domain: params.domain,
        identityDomain,
        previousMainDomain,
        identitySet: !alreadyBound,
        identityCallbackId: identity?.callbackId ?? null,
        ptrSet: false,
        ptrSkipReason: "fcrdns_pending",
        fcrdns,
        alreadyBound,
        approvalEventId: approval.eventId ?? null,
        approvalArtifactId: approval.artifactId ?? null
      }
    });
    await upsertDomainBinding(input.deps.workspace, {
      domain: params.domain,
      serverSlug: params.serverSlug,
      serverIp: server.ipv4,
      status: "identity_pending_fcrdns"
    });
    json(input.response, 424, {
      ok: false,
      serverSlug: params.serverSlug,
      mainDomain: identityDomain,
      previousMainDomain,
      identitySet: !alreadyBound,
      ...(identity?.callbackId ? { identityCallbackId: identity.callbackId } : {}),
      ptrSet: false,
      ptrSkipReason: "fcrdns_pending",
      fcrdnsVerified: false,
      fcrdnsStatus: "pending",
      fcrdns: fcrdnsSnapshot(fcrdns),
      alreadyBound,
      eventId: eventId(event),
      durationMs: input.deps.now() - startedAt,
      error: "fcrdns_pending"
    } satisfies BindWebdockMainDomainResult);
    return;
  }

  const alignedEvent = await input.deps.auditLog.append({
    actorType: "operator",
    actorId: params.actorId,
    action: "oc.webdock.identity_aligned",
    targetType: "webdock_server",
    targetId: params.serverSlug,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [params.actorId],
    metadata: {
      serverSlug: params.serverSlug,
      domain: params.domain,
      previousMainDomain,
      newMainDomain: identityDomain,
      identitySet: !alreadyBound,
      identityCallbackId: identity?.callbackId ?? null,
      removeDefaultAlias: true,
      ptrSet: true,
      fcrdns,
      alreadyBound,
      approvalEventId: approval.eventId ?? null,
      approvalArtifactId: approval.artifactId ?? null
    }
  });

  await input.deps.auditLog.append({
    actorType: "operator",
    actorId: params.actorId,
    action: "oc.webdock.main_domain_bound",
    targetType: "webdock_server",
    targetId: params.serverSlug,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [params.actorId],
    metadata: {
      serverSlug: params.serverSlug,
      previousMainDomain,
      newMainDomain: identityDomain,
      identitySet: !alreadyBound,
      identityCallbackId: identity?.callbackId ?? null,
      ptrSet: true,
      ptrSkipReason: null,
      fcrdnsVerified: true,
      alreadyBound,
      approvalEventId: approval.eventId ?? null,
      approvalArtifactId: approval.artifactId ?? null
    }
  });
  await upsertDomainBinding(input.deps.workspace, {
    domain: params.domain,
    serverSlug: params.serverSlug,
    serverIp: server.ipv4 || "",
    status: "main_domain_bound"
  });

  json(input.response, 200, {
    ok: true,
    serverSlug: params.serverSlug,
    mainDomain: identityDomain,
    previousMainDomain,
    identitySet: !alreadyBound,
    ...(identity?.callbackId ? { identityCallbackId: identity.callbackId } : {}),
    ptrSet: true,
    fcrdnsVerified: true,
    fcrdnsStatus: "verified",
    fcrdns: fcrdnsSnapshot(fcrdns),
    alreadyBound,
    eventId: eventId(alignedEvent),
    durationMs: input.deps.now() - startedAt
  } satisfies BindWebdockMainDomainResult);
}

export function createBindWebdockMainDomainApprovalGuard(input: {
  auditLog: AuditSink;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  now?: () => Date;
}): BindWebdockMainDomainApprovalGuard {
  return {
    async verify({ approvalToken, actorId }) {
      if (!input.auditLog.list) return { ok: false };
      const now = input.now?.() ?? new Date();
      const events = await input.auditLog.list();
      const auditEvent = events.toReversed().find((event) => {
        if (event.actorId !== actorId) return false;
        if (!auditApprovalMatchesToken(event, approvalToken)) return false;
        const approvedAt = Date.parse(event.occurredAt);
        return Number.isFinite(approvedAt) && now.getTime() - approvedAt >= 0 && now.getTime() - approvedAt <= approvalMaxAgeMs;
      });
      if (!auditEvent) return { ok: false };
      const state = await input.readCanvasState();
      const artifact = state.artifacts.find((candidate) =>
        artifactMatchesAuditApproval({
          artifact: candidate,
          approvalEvent: auditEvent,
          approvalToken,
          now,
          maxAgeMs: approvalMaxAgeMs
        })
      );
      return artifact ? { ok: true, eventId: auditEvent.id, artifactId: artifact.artifactId } : { ok: false };
    }
  };
}

export function handleBindWebdockMainDomainError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof SyntaxError) {
    json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
    return true;
  }
  return false;
}

async function rollbackMainDomain(input: {
  deps: BindWebdockMainDomainDeps;
  params: BindWebdockMainDomainParams;
  previousMainDomain: string | null;
  serverIp: string;
  reason: string;
  error: unknown;
}): Promise<{ ok: boolean }> {
  if (!input.previousMainDomain) {
    await auditInconsistentState(input, "previous_main_domain_missing", null);
    return { ok: false };
  }
  try {
    await input.deps.webdockAdapter.setServerMainDomain({
      serverSlug: input.params.serverSlug,
      domain: input.previousMainDomain,
      serverIp: input.serverIp,
      sshRunner: input.deps.sshRunner
    });
    await input.deps.auditLog.append({
      actorType: "operator",
      actorId: input.params.actorId,
      action: "oc.webdock.main_domain_rollback",
      targetType: "webdock_server",
      targetId: input.params.serverSlug,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [input.params.actorId],
      metadata: {
        serverSlug: input.params.serverSlug,
        restoredMainDomain: input.previousMainDomain,
        attemptedMainDomain: input.params.domain,
        reason: input.reason,
        error: errorMessage(input.error)
      }
    });
    return { ok: true };
  } catch (rollbackError) {
    await auditInconsistentState(input, "rollback_failed", rollbackError);
    return { ok: false };
  }
}

async function auditInconsistentState(input: {
  deps: BindWebdockMainDomainDeps;
  params: BindWebdockMainDomainParams;
  previousMainDomain: string | null;
  reason: string;
  error: unknown;
}, rollbackError: string, rollbackCause: unknown): Promise<void> {
  await input.deps.auditLog.append({
    actorType: "operator",
    actorId: input.params.actorId,
    action: "oc.webdock.bind_inconsistent_state",
    targetType: "webdock_server",
    targetId: input.params.serverSlug,
    riskLevel: "critical",
    decision: "reject",
    humanApproved: true,
    approverIds: [input.params.actorId],
    metadata: {
      serverSlug: input.params.serverSlug,
      attemptedMainDomain: input.params.domain,
      previousMainDomain: input.previousMainDomain,
      reason: input.reason,
      ptrError: errorMessage(input.error),
      rollbackError,
      rollbackCause: rollbackCause ? errorMessage(rollbackCause) : null,
      requiresManualIntervention: true
    }
  });
}

function parseParams(value: unknown, requireApproval: boolean): BindWebdockMainDomainParams {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BindWebdockMainDomainInputError("body_must_be_object");
  }
  const input = value as Record<string, unknown>;
  return {
    serverSlug: normalizeServerSlug(input.serverSlug),
    domain: normalizeDomain(input.domain),
    setPtr: input.setPtr === undefined ? true : requiredBoolean(input.setPtr, "setPtr"),
    actorId: requireApproval ? requiredString(input.actorId, "actorId") : "dispatcher",
    approvalToken: requireApproval ? requiredString(input.approvalToken, "approvalToken") : "dispatcher",
    ...optionalRepairScope(input)
  };
}

function optionalRepairScope(input: Record<string, unknown>): {
  repairReason?: string;
  explicitRepairScope?: string;
} {
  return {
    ...(typeof input.repairReason === "string" && input.repairReason.trim().length >= 10
      ? { repairReason: input.repairReason.trim().slice(0, 500) }
      : {}),
    ...(typeof input.explicitRepairScope === "string" && input.explicitRepairScope.trim().length >= 3
      ? { explicitRepairScope: input.explicitRepairScope.trim().slice(0, 300) }
      : {})
  };
}

function currentIdentityDomainFromServer(server: WebdockServer): string | null {
  const candidates = [server.mainDomain];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      return normalizeIdentityDomain(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

async function verifyFcrdnsWithRetry(input: {
  resolver: FcrdnsResolver;
  smtpHost: string;
  ipv4: string;
  maxWaitMs: number;
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<FcrdnsCheckResult> {
  const pollIntervalMs = Math.max(0, input.pollIntervalMs);
  const attempts = Math.max(1, Math.floor(Math.max(0, input.maxWaitMs) / Math.max(1, pollIntervalMs || 1)) + 1);
  let latest: FcrdnsCheckResult = await checkFcrdns(input);
  for (let attempt = 1; attempt < attempts && !latest.verified; attempt += 1) {
    if (pollIntervalMs > 0) {
      await input.sleep(pollIntervalMs);
    }
    latest = await checkFcrdns(input);
  }
  return latest;
}

async function checkFcrdns(input: {
  resolver: FcrdnsResolver;
  smtpHost: string;
  ipv4: string;
}): Promise<FcrdnsCheckResult> {
  const expectedPtr = normalizeDnsName(input.smtpHost);
  const forwardA = await input.resolver.resolve4(input.smtpHost).catch(() => [] as string[]);
  const reversePtr = (await input.resolver.reverse(input.ipv4).catch(() => [] as string[])).map(normalizeDnsName);
  const forwardMatched = forwardA.includes(input.ipv4);
  const reverseMatched = reversePtr.includes(expectedPtr);
  return {
    verified: forwardMatched && reverseMatched,
    expectedA: input.ipv4,
    expectedPtr: `${expectedPtr}.`,
    forwardA,
    reversePtr: reversePtr.map((value) => `${value}.`),
    forwardMatched,
    reverseMatched
  };
}

function fcrdnsSnapshot(result: FcrdnsCheckResult): BindWebdockMainDomainResult["fcrdns"] {
  return {
    expectedA: result.expectedA,
    expectedPtr: result.expectedPtr,
    forwardA: result.forwardA,
    reversePtr: result.reversePtr
  };
}

function normalizeIdentityDomain(value: unknown): string {
  const normalized = requiredString(value, "domain").toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new BindWebdockMainDomainInputError("domain_invalid_format");
  }
  return normalized;
}

function normalizeDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertDomainBinding(
  workspace: OpenClawWorkspace | undefined,
  input: {
    domain: string;
    serverSlug: string;
    serverIp: string;
    status: string;
  }
): Promise<void> {
  if (!workspace) return;
  await workspace.updateInventoryJson<{
    bindings?: Array<{
      domain: string;
      serverSlug: string | null;
      serverIp: string;
      status: string;
    }>;
  }>("domains.json", (current) => {
    const bindings = (current?.bindings ?? []).filter((entry) => entry.domain !== input.domain);
    bindings.push(input);
    return {
      ...(current ?? {}),
      bindings
    };
  }).catch(() => undefined);
}

function normalizeServerSlug(value: unknown): string {
  const normalized = requiredString(value, "serverSlug").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(normalized)) {
    throw new BindWebdockMainDomainInputError("slug_invalid_format");
  }
  return normalized;
}

function normalizeDomain(value: unknown): string {
  const normalized = requiredString(value, "domain").toLowerCase().replace(/\.$/, "");
  if (/^(mail|email|notify|noreply|alert|smtp|sender|inbox|bulk|blast)\./i.test(normalized)) {
    throw new BindWebdockMainDomainInputError("domain_has_prohibited_prefix");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new BindWebdockMainDomainInputError("domain_invalid_format");
  }
  return normalized;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BindWebdockMainDomainInputError(`${field}_required`);
  }
  return value.trim();
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new BindWebdockMainDomainInputError(`${field}_must_be_boolean`);
  }
  return value;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(request);
  if (!raw) throw new SyntaxError("empty_json_body");
  return JSON.parse(raw) as unknown;
}

function eventId(event: unknown): string {
  return event && typeof event === "object" && typeof (event as { id?: unknown }).id === "string"
    ? (event as { id: string }).id
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown bind_webdock_main_domain error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

class BindWebdockMainDomainInputError extends Error {}

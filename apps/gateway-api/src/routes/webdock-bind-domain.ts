import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  WebdockServer,
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
import type { SkillParamSchema } from "../skill-schemas.ts";

export interface BindWebdockMainDomainParams extends Record<string, unknown> {
  serverSlug: string;
  domain: string;
  setPtr: boolean;
  actorId: string;
  approvalToken: string;
}

export interface BindWebdockMainDomainSkillParams extends Record<string, unknown> {
  serverSlug: string;
  domain: string;
  setPtr: boolean;
}

export interface BindWebdockMainDomainResult {
  ok: boolean;
  serverSlug: string;
  mainDomain: string;
  previousMainDomain: string | null;
  ptrSet: boolean;
  ptrSkipReason?: "not_supported_by_api" | "ipv4_missing" | "operator_opt_out";
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

export interface BindWebdockMainDomainDeps {
  auditLog: AuditSink;
  approvalGuard: BindWebdockMainDomainApprovalGuard;
  webdockAdapter: BindWebdockMainDomainAdapter;
  sshRunner?: WebdockSshRunner;
  now: () => number;
}

const approvalMaxAgeMs = 15 * 60 * 1000;

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
          setPtr: params.setPtr
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

  const currentMainDomain = currentDomainFromServer(server);
  if (currentMainDomain === params.domain) {
    const event = await input.deps.auditLog.append({
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
        previousMainDomain: params.domain,
        newMainDomain: params.domain,
        ptrSet: false,
        alreadyBound: true,
        approvalEventId: approval.eventId ?? null,
        approvalArtifactId: approval.artifactId ?? null
      }
    });
    json(input.response, 200, {
      ok: true,
      serverSlug: params.serverSlug,
      mainDomain: params.domain,
      previousMainDomain: params.domain,
      ptrSet: false,
      alreadyBound: true,
      eventId: eventId(event),
      durationMs: input.deps.now() - startedAt
    } satisfies BindWebdockMainDomainResult);
    return;
  }

  let previousMainDomain: string | null = currentMainDomain;
  try {
    const bind = await input.deps.webdockAdapter.setServerMainDomain({
      serverSlug: params.serverSlug,
      domain: params.domain,
      serverIp: server.ipv4 || null,
      sshRunner: input.deps.sshRunner
    });
    previousMainDomain = bind.previousMainDomain ?? previousMainDomain;
  } catch (error) {
    await input.deps.auditLog.append({
      actorType: "operator",
      actorId: params.actorId,
      action: "oc.webdock.main_domain_bind_failed",
      targetType: "webdock_server",
      targetId: params.serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [params.actorId],
      metadata: {
        serverSlug: params.serverSlug,
        domain: params.domain,
        error: errorMessage(error)
      }
    });
    json(input.response, 502, { error: "bind_failed", details: errorMessage(error) });
    return;
  }

  let ptrSet = false;
  let ptrSkipReason: BindWebdockMainDomainResult["ptrSkipReason"];
  if (!params.setPtr) {
    ptrSkipReason = "operator_opt_out";
  } else if (!server.ipv4) {
    ptrSkipReason = "ipv4_missing";
  } else {
    try {
      const ptr = await input.deps.webdockAdapter.setServerPtr({
        serverSlug: params.serverSlug,
        ipv4: server.ipv4,
        ptrValue: params.domain
      });
      if (ptr.supported && ptr.ok) {
        ptrSet = true;
      } else if (!ptr.supported) {
        ptrSkipReason = "not_supported_by_api";
      }
    } catch (error) {
      const rollback = await rollbackMainDomain({
        deps: input.deps,
        params,
        previousMainDomain,
        serverIp: server.ipv4,
        reason: "ptr_set_failed",
        error
      });
      json(input.response, 502, {
        error: rollback.ok ? "ptr_failed_rolled_back" : "ptr_failed_rollback_failed",
        details: errorMessage(error)
      });
      return;
    }
  }

  const event = await input.deps.auditLog.append({
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
      newMainDomain: params.domain,
      ptrSet,
      ptrSkipReason: ptrSkipReason ?? null,
      alreadyBound: false,
      approvalEventId: approval.eventId ?? null,
      approvalArtifactId: approval.artifactId ?? null
    }
  });

  json(input.response, 200, {
    ok: true,
    serverSlug: params.serverSlug,
    mainDomain: params.domain,
    previousMainDomain,
    ptrSet,
    ...(ptrSkipReason ? { ptrSkipReason } : {}),
    alreadyBound: false,
    eventId: eventId(event),
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
    approvalToken: requireApproval ? requiredString(input.approvalToken, "approvalToken") : "dispatcher"
  };
}

function currentDomainFromServer(server: WebdockServer): string | null {
  const candidates = [server.mainDomain, server.hostname, server.name, server.description];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      return normalizeDomain(candidate);
    } catch {
      continue;
    }
  }
  return null;
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
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
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

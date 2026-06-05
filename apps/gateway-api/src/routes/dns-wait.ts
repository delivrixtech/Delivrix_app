import { promises as nativeDns } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
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

export type DnsRecordType = "A" | "NS" | "MX" | "TXT";

export interface WaitForDnsPropagationParams extends Record<string, unknown> {
  domain: string;
  expectedRecord: {
    type: DnsRecordType;
    value: string;
  };
  maxWaitMs: number;
  pollIntervalMs: number;
  actorId: string;
  approvalToken: string;
}

export type WaitForDnsPropagationSkillParams = Omit<
  WaitForDnsPropagationParams,
  "actorId" | "approvalToken"
>;

export interface WaitForDnsPropagationResult {
  ok: boolean;
  attempts: number;
  lastSeen: string;
  durationMs: number;
  error?: "timeout" | "value_mismatch" | "resolver_error" | "domain_nxdomain";
  errorDetails?: string;
  eventId: string;
}

export interface DnsResolver {
  resolve4(domain: string): Promise<string[]>;
  resolveNs(domain: string): Promise<string[]>;
  resolveMx(domain: string): Promise<Array<{ priority: number; exchange: string }>>;
  resolveTxt?(domain: string): Promise<string[][]>;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<AuditEvent | unknown>;
  list?(): Promise<AuditEvent[]>;
}

export interface ApprovalGuard {
  verify(input: {
    approvalToken: string;
    actorId: string;
  }): Promise<{ ok: boolean; eventId?: string; rejectReason?: string }>;
}

export interface KillSwitchProvider {
  enabled: boolean;
}

export interface WaitForDnsPropagationDeps {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  approvalGuard: ApprovalGuard;
  dns?: DnsResolver;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readKillSwitch?: () => Promise<KillSwitchProvider> | KillSwitchProvider;
}

type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: string[]; format: () => Record<string, unknown> } };

export const waitForDnsPropagationParamSchema = schema((value) =>
  parseWaitForDnsPropagationParams(value, { requireApprovalFields: true })
);

export const waitForDnsPropagationSkillParamSchema = schema((value) =>
  parseWaitForDnsPropagationParams(value, { requireApprovalFields: false })
);

export async function handleWaitForDnsPropagationHttp(
  deps: WaitForDnsPropagationDeps
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(deps.request);
  } catch {
    json(deps.response, 400, {
      error: "invalid_params",
      details: { _errors: ["Request body must be valid JSON."] }
    });
    return;
  }

  const parsed = waitForDnsPropagationParamSchema.safeParse(body);
  if (!parsed.success) {
    json(deps.response, 400, {
      error: "invalid_params",
      details: parsed.error.format()
    });
    return;
  }

  const killSwitch = await deps.readKillSwitch?.();
  if (killSwitch?.enabled) {
    json(deps.response, 423, {
      error: "kill_switch_armed"
    });
    return;
  }

  const params = parsed.data;
  const approval = await deps.approvalGuard.verify({
    approvalToken: params.approvalToken,
    actorId: params.actorId
  });
  if (!approval.ok) {
    json(deps.response, 403, {
      error: "approval_invalid",
      rejectReason: approval.rejectReason ?? "approval_not_found_or_expired"
    });
    return;
  }

  const result = await pollDnsRecord({
    domain: params.domain,
    expectedRecord: params.expectedRecord,
    maxWaitMs: params.maxWaitMs,
    pollIntervalMs: params.pollIntervalMs,
    dns: deps.dns,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? realSleep
  });

  const auditEvent = await deps.auditLog.append({
    actorType: "operator",
    actorId: params.actorId,
    action: "oc.dns.propagation_check",
    targetType: "dns_record",
    targetId: params.domain,
    riskLevel: "low",
    decision: result.ok ? "allow" : "reject",
    humanApproved: true,
    approverIds: [params.actorId],
    metadata: {
      domain: params.domain,
      expectedRecordType: params.expectedRecord.type,
      expectedRecordValue: params.expectedRecord.value,
      attempts: result.attempts,
      lastSeen: result.lastSeen,
      durationMs: result.durationMs,
      ok: result.ok,
      error: result.error ?? null,
      approvalEventId: approval.eventId ?? null
    }
  });

  json(deps.response, result.ok ? 200 : 408, {
    ok: result.ok,
    attempts: result.attempts,
    lastSeen: result.lastSeen,
    durationMs: result.durationMs,
    error: result.error,
    errorDetails: result.errorDetails,
    eventId: eventId(auditEvent)
  } satisfies WaitForDnsPropagationResult);
}

export async function handleWaitForDnsPropagationReadOnlyHttp(
  deps: Omit<WaitForDnsPropagationDeps, "approvalGuard">
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(deps.request);
  } catch {
    json(deps.response, 400, {
      error: "invalid_params",
      details: { _errors: ["Request body must be valid JSON."] }
    });
    return;
  }

  const parsed = waitForDnsPropagationSkillParamSchema.safeParse(body);
  if (!parsed.success) {
    json(deps.response, 400, {
      error: "invalid_params",
      details: parsed.error.format()
    });
    return;
  }

  const killSwitch = await deps.readKillSwitch?.();
  if (killSwitch?.enabled) {
    json(deps.response, 423, {
      error: "kill_switch_armed"
    });
    return;
  }

  const params = parsed.data;
  const actorId = isRecord(body) && typeof body.actorId === "string" && body.actorId.trim()
    ? body.actorId.trim()
    : "openclaw-bedrock-tool-use";
  const result = await pollDnsRecord({
    domain: params.domain,
    expectedRecord: params.expectedRecord,
    maxWaitMs: params.maxWaitMs,
    pollIntervalMs: params.pollIntervalMs,
    dns: deps.dns,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? realSleep
  });

  const auditEvent = await deps.auditLog.append({
    actorType: "operator",
    actorId,
    action: "oc.dns.propagation_check",
    targetType: "dns_record",
    targetId: params.domain,
    riskLevel: "low",
    decision: result.ok ? "allow" : "reject",
    humanApproved: false,
    metadata: {
      domain: params.domain,
      expectedRecordType: params.expectedRecord.type,
      expectedRecordValue: params.expectedRecord.value,
      attempts: result.attempts,
      lastSeen: result.lastSeen,
      durationMs: result.durationMs,
      ok: result.ok,
      error: result.error ?? null,
      readOnly: true
    }
  });

  json(deps.response, 200, {
    ok: result.ok,
    attempts: result.attempts,
    lastSeen: result.lastSeen,
    durationMs: result.durationMs,
    error: result.error,
    errorDetails: result.errorDetails,
    eventId: eventId(auditEvent)
  } satisfies WaitForDnsPropagationResult);
}

export async function pollDnsRecord(input: {
  domain: string;
  expectedRecord: { type: DnsRecordType; value: string };
  maxWaitMs: number;
  pollIntervalMs: number;
  dns?: DnsResolver;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<Omit<WaitForDnsPropagationResult, "eventId">> {
  const resolver = input.dns ?? nativeDns;
  const startedAt = input.now();
  const maxAttempts = Math.max(1, Math.ceil(input.maxWaitMs / input.pollIntervalMs));
  const expectedValue = normalizeDnsValue(input.expectedRecord.value);
  let attempts = 0;
  let lastSeen = "";
  let lastError: string | undefined;
  let observedAnyValue = false;
  let sawResolverError = false;

  while (input.now() - startedAt < input.maxWaitMs && attempts < maxAttempts) {
    attempts += 1;
    try {
      const observed = await resolveExpectedRecord({
        dns: resolver,
        domain: input.domain,
        type: input.expectedRecord.type
      });
      if (observed.length > 0) {
        observedAnyValue = true;
      }
      lastSeen = observed.join(",");
      if (observed.some((value) => recordMatchesExpected(value, expectedValue))) {
        return {
          ok: true,
          attempts,
          lastSeen,
          durationMs: input.now() - startedAt
        };
      }
    } catch (error) {
      const code = errorCode(error);
      lastError = `${code}: ${errorMessage(error)}`;
      if (code === "ENOTFOUND" || code === "ENODATA") {
        lastSeen = "(nxdomain)";
      } else {
        lastSeen = "(resolver_error)";
        sawResolverError = true;
      }
    }

    const remaining = input.maxWaitMs - (input.now() - startedAt);
    if (remaining <= 0) {
      break;
    }
    await input.sleep(Math.min(input.pollIntervalMs, remaining));
    if (attempts >= maxAttempts) {
      break;
    }
  }

  const durationMs = input.now() - startedAt;
  if (observedAnyValue) {
    return {
      ok: false,
      attempts,
      lastSeen,
      durationMs,
      error: "value_mismatch",
      errorDetails: `expected ${input.expectedRecord.value}, observed ${lastSeen}`
    };
  }
  if (sawResolverError) {
    return {
      ok: false,
      attempts,
      lastSeen,
      durationMs,
      error: "resolver_error",
      errorDetails: lastError
    };
  }
  return {
    ok: false,
    attempts,
    lastSeen,
    durationMs,
    error: "domain_nxdomain",
    errorDetails: lastError
  };
}

export function createAuditApprovalGuard(input: {
  auditLog: AuditSink;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  now?: () => Date;
  maxAgeMs?: number;
}): ApprovalGuard {
  return {
    async verify({ approvalToken, actorId }) {
      if (!input.auditLog.list) {
        return { ok: false, rejectReason: "audit_list_unavailable" };
      }
      const now = input.now?.() ?? new Date();
      const maxAgeMs = input.maxAgeMs ?? 15 * 60 * 1000;
      const events = await input.auditLog.list();
      const auditEvent = events.toReversed().find((event) => {
        if (!auditApprovalMatchesToken(event, approvalToken)) {
          return false;
        }
        const approverIds = event.approverIds ?? [];
        if (approverIds.length > 0 && !approverIds.includes(actorId)) {
          return false;
        }
        const approvedAt = Date.parse(event.occurredAt);
        return Number.isFinite(approvedAt) &&
          now.getTime() - approvedAt >= 0 &&
          now.getTime() - approvedAt <= maxAgeMs;
      });
      if (!auditEvent) {
        return { ok: false, rejectReason: "approval_not_found_or_expired" };
      }

      const state = await input.readCanvasState();
      const artifact = state.artifacts.find((candidate) =>
        artifactMatchesAuditApproval({
          artifact: candidate,
          approvalEvent: auditEvent,
          approvalToken,
          now,
          maxAgeMs
        })
      );
      if (!artifact) {
        return { ok: false, rejectReason: "approval_artifact_missing_or_expired" };
      }

      return { ok: true, eventId: auditEvent.id };
    }
  };
}

export function parseWaitForDnsPropagationParams(
  value: unknown,
  options: { requireApprovalFields: true }
): WaitForDnsPropagationParams;
export function parseWaitForDnsPropagationParams(
  value: unknown,
  options: { requireApprovalFields: false }
): WaitForDnsPropagationSkillParams;
export function parseWaitForDnsPropagationParams(
  value: unknown,
  options: { requireApprovalFields: boolean }
): WaitForDnsPropagationParams | WaitForDnsPropagationSkillParams {
  const input = object(value);
  const expected = object(input.expectedRecord, "expectedRecord");
  const output = {
    domain: dnsRecordName(input.domain, "domain"),
    expectedRecord: {
      type: oneOf(expected.type, "expectedRecord.type", ["A", "NS", "MX", "TXT"] as const),
      value: string(expected.value, "expectedRecord.value", 1, 253)
    },
    maxWaitMs: optionalInteger(input.maxWaitMs, "maxWaitMs", 30_000, 1_800_000, 600_000),
    pollIntervalMs: optionalInteger(input.pollIntervalMs, "pollIntervalMs", 30_000, 120_000, 30_000)
  };

  if (!options.requireApprovalFields) {
    return output;
  }

  return {
    ...output,
    actorId: string(input.actorId, "actorId", 1, 120),
    approvalToken: string(input.approvalToken, "approvalToken", 1, 200)
  };
}

async function resolveExpectedRecord(input: {
  dns: DnsResolver;
  domain: string;
  type: DnsRecordType;
}): Promise<string[]> {
  if (input.type === "A") {
    return input.dns.resolve4(input.domain);
  }
  if (input.type === "NS") {
    return (await input.dns.resolveNs(input.domain)).map(normalizeDnsValue);
  }
  if (input.type === "MX") {
    return (await input.dns.resolveMx(input.domain)).map((entry) => normalizeDnsValue(entry.exchange));
  }
  if (!input.dns.resolveTxt) {
    throw new Error("resolveTxt is required for TXT propagation checks");
  }
  return (await input.dns.resolveTxt(input.domain)).map((entry) => normalizeDnsValue(entry.join("")));
}

function recordMatchesExpected(observed: string, expectedValue: string): boolean {
  const normalized = normalizeDnsValue(observed);
  const containsPrefix = "contains:";
  if (expectedValue.startsWith(containsPrefix)) {
    return normalized.includes(normalizeDnsValue(expectedValue.slice(containsPrefix.length)));
  }
  return normalized === expectedValue;
}

function schema<T extends Record<string, unknown>>(
  parse: (value: unknown) => T
): { safeParse(value: unknown): SafeParseResult<T> } {
  return {
    safeParse(value: unknown): SafeParseResult<T> {
      try {
        return { success: true, data: parse(value) };
      } catch (error) {
        const message = error instanceof Error ? error.message : "schema_mismatch";
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
}

function object(value: unknown, field = "params"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${field} must be ${min}-${max} chars`);
  }
  return normalized;
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function oneOf<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw new Error(`${field} must be one of ${allowed.join(", ")}`);
}

function dnsRecordName(value: unknown, field: string): string {
  const normalized = string(value, field, 1, 253).toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?)*$/.test(normalized)) {
    throw new Error(`${field} must be a valid DNS record name`);
  }
  return normalized;
}

function normalizeDnsValue(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(request);
  return raw.trim() ? JSON.parse(raw) : {};
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code ? code : "UNKNOWN";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

function eventId(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : "";
}

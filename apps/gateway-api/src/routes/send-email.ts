import { createHash, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken
} from "../approval-guard.ts";
import { readRequestBody } from "../request-body.ts";
import type { SkillParamSchema, SkillSafeParseResult } from "../skill-schemas.ts";
import type { SmtpSshRunner } from "./smtp-provisioning.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

export interface SendRealEmailDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  sshRunner: SmtpSshRunner;
  workspace: OpenClawWorkspace;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  readKillSwitch?: () => Promise<{ enabled: boolean }> | { enabled: boolean };
  resolveTxt?: (domain: string) => Promise<string[][]>;
  now?: () => Date;
}

export interface SendRealEmailParams extends Record<string, unknown> {
  fromAddress: string;
  toAddress: string;
  subject: string;
  body: string;
  serverSlug: string;
  selector?: string;
  idempotencyKey?: string;
  runId?: string;
  actorId: string;
  approvalToken: string;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface SendRealEmailSkillParams extends Record<string, unknown> {
  fromAddress: string;
  toAddress: string;
  subject: string;
  body: string;
  serverSlug: string;
  selector?: string;
  idempotencyKey?: string;
  runId?: string;
  repairReason?: string;
  explicitRepairScope?: string;
}

export interface SendRealEmailResult {
  ok: boolean;
  messageId: string | null;
  deliveryStatus: "queued" | "sent" | "rejected" | "deferred" | "unknown";
  postfixLogTail: string;
  preValidations: {
    spfPresent: boolean;
    dkimPresent: boolean;
    dmarcPresent: boolean;
    postfixRunning: boolean;
    rateLimitOk: boolean;
  };
  eventId: string;
  durationMs: number;
  error?: string;
}

export const SPAM_FLAG_WORDS = [
  "test",
  "demo",
  "prueba",
  "lorem",
  "smoke",
  "ipsum",
  "notify",
  "noreply",
  "no-reply",
  "bulk",
  "blast",
  "unsubscribe me",
  "click here",
  "act now",
  "limited time",
  "free money",
  "viagra",
  "winner",
  "congratulations you"
] as const;

const SEED_POOL_BURNER_DOMAINS = [
  "mailinator.com",
  "tempmail.com",
  "guerrillamail.com",
  "10minutemail.com",
  "throwaway.email",
  "yopmail.com"
] as const;

const RFC5322_EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const approvalMaxAgeMs = 15 * 60 * 1000;
const rateLimitWindowMs = 3_600_000;
const maxEmailsPerServerPerHour = 5;
const serverRateLimitLocks = new Map<string, Promise<void>>();

interface SchemaIssue {
  field: keyof SendRealEmailParams;
  message: string;
}

export const sendRealEmailParamSchema: SkillParamSchema<SendRealEmailParams> = {
  safeParse(value: unknown): SkillSafeParseResult<SendRealEmailParams> {
    try {
      return { success: true, data: parseSendRealEmailParams(value) };
    } catch (error) {
      const issues = error instanceof SendRealEmailSchemaError
        ? error.issues
        : [{ field: "body" as const, message: "schema_mismatch" }];
      return {
        success: false,
        error: {
          issues: issues.map((issue) => issue.message),
          format: () => formatIssues(issues)
        }
      };
    }
  }
};

export const sendRealEmailSkillParamSchema: SkillParamSchema<SendRealEmailSkillParams> = {
  safeParse(value: unknown): SkillSafeParseResult<SendRealEmailSkillParams> {
    try {
      return { success: true, data: parseSendRealEmailSkillParams(value) };
    } catch (error) {
      const issues = error instanceof SendRealEmailSchemaError
        ? error.issues
        : [{ field: "body" as const, message: "schema_mismatch" }];
      return {
        success: false,
        error: {
          issues: issues.map((issue) => issue.message),
          format: () => formatIssues(issues)
        }
      };
    }
  }
};

export async function handleSendRealEmailHttp(deps: SendRealEmailDependencies): Promise<void> {
  const startedAt = currentTimeMs(deps);
  const now = deps.now?.() ?? new Date();
  let body: unknown;
  try {
    body = await readJson(deps.request);
  } catch (error) {
    json(deps.response, error instanceof SyntaxError ? 400 : 422, {
      error: error instanceof SyntaxError ? "invalid_json" : "request_body_required"
    });
    return;
  }

  const parsed = sendRealEmailParamSchema.safeParse(body);
  if (!parsed.success) {
    json(deps.response, 400, {
      error: parsed.error.issues[0] ?? "invalid_params",
      details: parsed.error.format()
    });
    return;
  }

  const params = parsed.data;
  const killSwitch = await deps.readKillSwitch?.();
  if (killSwitch?.enabled) {
    json(deps.response, 423, { error: "kill_switch_armed" });
    return;
  }

  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken: params.approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) {
    json(deps.response, 403, { error: "approval_invalid" });
    return;
  }

  const duplicate = await findExistingSendByIdempotency({
    auditLog: deps.auditLog,
    serverSlug: params.serverSlug,
    idempotencyKey: params.idempotencyKey,
    runId: params.runId
  });
  if (duplicate) {
    json(deps.response, 200, {
      ok: true,
      messageId: duplicate.messageId,
      deliveryStatus: duplicate.deliveryStatus,
      postfixLogTail: "idempotent_replay_suppressed",
      preValidations: duplicate.preValidations,
      eventId: duplicate.eventId,
      durationMs: currentTimeMs(deps) - startedAt
    } satisfies SendRealEmailResult);
    return;
  }

  const burnerCheck = checkRecipientNotBurner(params.toAddress);
  if (!burnerCheck.ok) {
    json(deps.response, 400, { error: "recipient_burner", details: burnerCheck.reason });
    return;
  }

  const fromDomain = domainFromEmail(params.fromAddress);
  const auth = await validateEmailAuth({
    domain: fromDomain,
    selector: params.selector,
    resolveTxt: deps.resolveTxt ?? dns.resolveTxt
  });
  if (!auth.spfPresent || !auth.dkimPresent || !auth.dmarcPresent) {
    json(deps.response, 400, {
      error: "email_auth_incomplete",
      details: {
        spf: auth.spfPresent,
        dkim: auth.dkimPresent,
        dmarc: auth.dmarcPresent
      }
    });
    return;
  }

  const rate = await checkRateLimit({
    auditLog: deps.auditLog,
    serverSlug: params.serverSlug,
    nowMs: currentTimeMs(deps)
  });
  if (!rate.ok) {
    json(deps.response, 429, {
      error: "rate_limit_exceeded",
      details: { maxPerHour: maxEmailsPerServerPerHour, recentCount: rate.recentCount }
    });
    return;
  }

  if (!deps.sshRunner.isConfigured()) {
    json(deps.response, 503, { error: "ssh_runner_missing" });
    return;
  }

  const serverIp = await findServerIp(deps.workspace, params.serverSlug);
  if (!serverIp) {
    json(deps.response, 400, { error: "server_ip_missing" });
    return;
  }

  const postfix = await checkPostfixRunning({
    sshRunner: deps.sshRunner,
    serverSlug: params.serverSlug,
    serverIp
  });
  if (!postfix.running) {
    json(deps.response, 503, { error: "postfix_not_running", details: postfix.statusLine });
    return;
  }

  const reservation = await reserveRateLimitSlot({
    auditLog: deps.auditLog,
    serverSlug: params.serverSlug,
    actorId: params.actorId,
    nowMs: currentTimeMs(deps)
  });
  if (!reservation.ok) {
    json(deps.response, reservation.error === "rate_limit_exceeded" ? 429 : 503, {
      error: reservation.error,
      details: { maxPerHour: maxEmailsPerServerPerHour, recentCount: reservation.recentCount }
    });
    return;
  }

  const sendResult = await sendEmailViaSsh({
    sshRunner: deps.sshRunner,
    serverSlug: params.serverSlug,
    serverIp,
    from: params.fromAddress,
    to: params.toAddress,
    subject: params.subject,
    body: params.body,
    idempotencyKey: params.idempotencyKey ?? params.runId,
    now: deps.now?.() ?? new Date()
  });
  const logTail = await tailPostfixLog({
    sshRunner: deps.sshRunner,
    serverSlug: params.serverSlug,
    serverIp,
    messageId: sendResult.messageId,
    lines: 20
  });

  const auditEvent = await deps.auditLog.append({
    occurredAt: (deps.now?.() ?? new Date()).toISOString(),
    actorType: "operator",
    actorId: params.actorId,
    action: "oc.smtp.real_email_sent",
    targetType: "webdock_server",
    targetId: params.serverSlug,
    riskLevel: "critical",
    decision: sendResult.ok ? "allow" : "reject",
    humanApproved: true,
    approverIds: [params.actorId],
    metadata: {
      serverSlug: params.serverSlug,
      serverIp,
      fromAddress: params.fromAddress,
      toAddressDomain: domainFromEmail(params.toAddress),
      toAddressHash: shortHash(params.toAddress),
      subject: params.subject,
      bodyHash: createHash("sha256").update(params.body).digest("hex"),
      bodyLength: params.body.length,
      messageId: sendResult.messageId,
      deliveryStatus: sendResult.deliveryStatus,
      selector: params.selector,
      idempotencyKey: params.idempotencyKey ?? null,
      runId: params.runId ?? null,
      preValidations: {
        spfPresent: auth.spfPresent,
        dkimPresent: auth.dkimPresent,
        dmarcPresent: auth.dmarcPresent,
        postfixRunning: postfix.running,
        rateLimitOk: rate.ok
      },
      approvalEventId: approval.eventId,
      approvalArtifactId: approval.artifactId,
      rateLimitReservationEventId: reservation.reservationEventId
    }
  });

  const payload: SendRealEmailResult = {
    ok: sendResult.ok,
    messageId: sendResult.messageId,
    deliveryStatus: sendResult.deliveryStatus,
    postfixLogTail: logTail,
    preValidations: {
      spfPresent: auth.spfPresent,
      dkimPresent: auth.dkimPresent,
      dmarcPresent: auth.dmarcPresent,
      postfixRunning: postfix.running,
      rateLimitOk: rate.ok
    },
    eventId: eventId(auditEvent),
    durationMs: currentTimeMs(deps) - startedAt,
    ...(sendResult.error ? { error: sendResult.error } : {})
  };
  json(deps.response, sendResult.ok ? 200 : 502, payload);
}

export async function validateEmailAuth(input: {
  domain: string;
  selector?: string;
  resolveTxt: (domain: string) => Promise<string[][]>;
}): Promise<{
  spfPresent: boolean;
  dkimPresent: boolean;
  dmarcPresent: boolean;
  details: { spf?: string; dkim?: string; dmarc?: string };
}> {
  const result = {
    spfPresent: false,
    dkimPresent: false,
    dmarcPresent: false,
    details: {} as { spf?: string; dkim?: string; dmarc?: string }
  };

  try {
    const txt = await input.resolveTxt(input.domain);
    const spf = flattenTxt(txt).find((entry) => entry.startsWith("v=spf1"));
    if (spf) {
      result.spfPresent = true;
      result.details.spf = spf;
    }
  } catch {
    // DNS absence is a blocking prevalidation, not a handler failure.
  }

  try {
    const selector = input.selector?.trim().toLowerCase() || "default";
    const txt = await input.resolveTxt(`${selector}._domainkey.${input.domain}`);
    const dkim = flattenTxt(txt).find((entry) => entry.includes("v=DKIM1"));
    if (dkim) {
      result.dkimPresent = true;
      result.details.dkim = dkim.length > 80 ? `${dkim.slice(0, 80)}...` : dkim;
    }
  } catch {
    // DNS absence is a blocking prevalidation, not a handler failure.
  }

  try {
    const txt = await input.resolveTxt(`_dmarc.${input.domain}`);
    const dmarc = flattenTxt(txt).find((entry) => entry.startsWith("v=DMARC1"));
    if (dmarc) {
      result.dmarcPresent = true;
      result.details.dmarc = dmarc;
    }
  } catch {
    // DNS absence is a blocking prevalidation, not a handler failure.
  }

  return result;
}

export function checkRecipientNotBurner(to: string): { ok: true } | { ok: false; reason: "recipient_is_burner_domain" } {
  const domain = domainFromEmail(to);
  const blocked = SEED_POOL_BURNER_DOMAINS.some((burner) => domain === burner || domain.endsWith(`.${burner}`));
  return blocked ? { ok: false, reason: "recipient_is_burner_domain" } : { ok: true };
}

async function findExistingSendByIdempotency(input: {
  auditLog: AuditSink;
  serverSlug: string;
  idempotencyKey?: string;
  runId?: string;
}): Promise<{
  eventId: string;
  messageId: string | null;
  deliveryStatus: SendRealEmailResult["deliveryStatus"];
  preValidations: SendRealEmailResult["preValidations"];
} | null> {
  if (!input.idempotencyKey && !input.runId) return null;
  const events = await input.auditLog.list?.() ?? [];
  const match = events.toReversed().find((event) => {
    if (event.action !== "oc.smtp.real_email_sent") return false;
    if (metadataString(event.metadata, "serverSlug") !== input.serverSlug) return false;
    const idempotencyKey = metadataString(event.metadata, "idempotencyKey");
    const runId = metadataString(event.metadata, "runId");
    return Boolean(
      input.idempotencyKey && idempotencyKey === input.idempotencyKey ||
      input.runId && runId === input.runId
    );
  });
  if (!match) return null;
  const metadata = match.metadata ?? {};
  return {
    eventId: match.id,
    messageId: metadataString(metadata, "messageId"),
    deliveryStatus: deliveryStatusFromMetadata(metadata.deliveryStatus),
    preValidations: preValidationsFromMetadata(metadata.preValidations)
  };
}

function deliveryStatusFromMetadata(value: unknown): SendRealEmailResult["deliveryStatus"] {
  return value === "queued" || value === "sent" || value === "rejected" || value === "deferred" || value === "unknown"
    ? value
    : "unknown";
}

function preValidationsFromMetadata(value: unknown): SendRealEmailResult["preValidations"] {
  if (!isRecord(value)) {
    return {
      spfPresent: true,
      dkimPresent: true,
      dmarcPresent: true,
      postfixRunning: true,
      rateLimitOk: true
    };
  }
  return {
    spfPresent: value.spfPresent === true,
    dkimPresent: value.dkimPresent === true,
    dmarcPresent: value.dmarcPresent === true,
    postfixRunning: value.postfixRunning === true,
    rateLimitOk: value.rateLimitOk === true
  };
}

async function checkPostfixRunning(input: {
  sshRunner: SmtpSshRunner;
  serverSlug: string;
  serverIp: string;
}): Promise<{ running: boolean; statusLine: string }> {
  try {
    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: "systemctl is-active postfix && ss -tlnp | grep ':25'",
      timeoutMs: 30_000
    });
    return {
      running: result.exitCode === 0 && result.stdout.includes("active"),
      statusLine: redactPostfixLog([result.stdout, result.stderr].filter(Boolean).join("\n")).split("\n").slice(0, 3).join(" | ")
    };
  } catch (error) {
    return {
      running: false,
      statusLine: errorMessage(error)
    };
  }
}

async function checkRateLimit(input: {
  auditLog: AuditSink;
  serverSlug: string;
  nowMs: number;
}): Promise<{ ok: boolean; recentCount: number }> {
  const events = await input.auditLog.list?.() ?? [];
  const recentCount = countRecentSendSlots(events, input.serverSlug, input.nowMs);
  return { ok: recentCount < maxEmailsPerServerPerHour, recentCount };
}

type RateLimitSlotReservation =
  | { ok: true; recentCount: number; reservationEventId: string }
  | { ok: false; recentCount: number; error: "rate_limit_exceeded" | "rate_limit_reservation_failed" };

async function reserveRateLimitSlot(input: {
  auditLog: AuditSink;
  serverSlug: string;
  actorId: string;
  nowMs: number;
}): Promise<RateLimitSlotReservation> {
  return withServerRateLimitLock(input.serverSlug, async () => {
    const events = await input.auditLog.list?.() ?? [];
    const recentCount = countRecentSendSlots(events, input.serverSlug, input.nowMs);
    if (recentCount >= maxEmailsPerServerPerHour) {
      return {
        ok: false,
        recentCount,
        error: "rate_limit_exceeded"
      };
    }

    try {
      const reservation = await input.auditLog.append({
        occurredAt: new Date(input.nowMs).toISOString(),
        actorType: "operator",
        actorId: input.actorId,
        action: "oc.smtp.real_email_rate_limit_reserved",
        targetType: "webdock_server",
        targetId: input.serverSlug,
        riskLevel: "critical",
        decision: "allow",
        humanApproved: true,
        approverIds: [input.actorId],
        metadata: {
          serverSlug: input.serverSlug,
          maxPerHour: maxEmailsPerServerPerHour,
          recentCountBefore: recentCount,
          reservationExpiresAt: new Date(input.nowMs + rateLimitWindowMs).toISOString(),
          smtpEnabled: true
        }
      });
      return {
        ok: true,
        recentCount: recentCount + 1,
        reservationEventId: eventId(reservation)
      };
    } catch {
      return {
        ok: false,
        recentCount,
        error: "rate_limit_reservation_failed"
      };
    }
  });
}

async function withServerRateLimitLock<T>(serverSlug: string, callback: () => Promise<T>): Promise<T> {
  const previous = serverRateLimitLocks.get(serverSlug) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  serverRateLimitLocks.set(serverSlug, queued);

  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (serverRateLimitLocks.get(serverSlug) === queued) {
      serverRateLimitLocks.delete(serverSlug);
    }
  }
}

function countRecentSendSlots(events: AuditEvent[], serverSlug: string, nowMs: number): number {
  const cutoff = nowMs - rateLimitWindowMs;
  const reservationIds = new Set<string>();
  let count = 0;

  for (const event of events) {
    if (!eventInRateLimitWindow(event, serverSlug, cutoff)) {
      continue;
    }
    if (event.action === "oc.smtp.real_email_rate_limit_reserved") {
      reservationIds.add(event.id);
      count += 1;
    }
  }

  for (const event of events) {
    if (!eventInRateLimitWindow(event, serverSlug, cutoff)) {
      continue;
    }
    if (event.action !== "oc.smtp.real_email_sent") {
      continue;
    }
    const reservationEventId = metadataString(event.metadata, "rateLimitReservationEventId");
    if (reservationEventId && reservationIds.has(reservationEventId)) {
      continue;
    }
    count += 1;
  }

  return count;
}

function eventInRateLimitWindow(event: AuditEvent, serverSlug: string, cutoff: number): boolean {
  if (event.metadata?.serverSlug !== serverSlug) {
    return false;
  }
  const occurredAt = Date.parse(event.occurredAt);
  return Number.isFinite(occurredAt) && occurredAt > cutoff;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

async function sendEmailViaSsh(input: {
  sshRunner: SmtpSshRunner;
  serverSlug: string;
  serverIp: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  idempotencyKey?: string;
  now: Date;
}): Promise<{
  ok: boolean;
  messageId: string | null;
  deliveryStatus: SendRealEmailResult["deliveryStatus"];
  rawOutput: string;
  error?: string;
}> {
  const messageId = input.idempotencyKey
    ? `<delivrix-${shortHash(input.idempotencyKey)}@${domainFromEmail(input.from)}>`
    : `<delivrix-${randomUUID()}@${domainFromEmail(input.from)}>`;
  const message = renderMessage({
    from: input.from,
    to: input.to,
    subject: input.subject,
    body: input.body,
    messageId,
    now: input.now
  });
  let command = "";

  try {
    const swaksCheck = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: "command -v swaks >/dev/null 2>&1 && echo SWAKS_AVAILABLE || echo SWAKS_MISSING",
      timeoutMs: 30_000
    });
    const useSwaks = swaksCheck.stdout.includes("SWAKS_AVAILABLE");
    command = useSwaks
      ? `swaks --to ${shellQuote(input.to)} --from ${shellQuote(input.from)} --server localhost --port 25 --data - --suppress-data 2>&1`
      : `/usr/sbin/sendmail -f ${shellQuote(input.from)} ${shellQuote(input.to)} 2>&1`;

    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command,
      stdin: message,
      timeoutMs: 60_000
    });
    const deliveryStatus = parseDeliveryStatus(result.stdout, result.exitCode);
    return {
      ok: result.exitCode === 0 && (deliveryStatus === "sent" || deliveryStatus === "queued"),
      messageId,
      deliveryStatus,
      rawOutput: result.stdout.slice(-4_000)
    };
  } catch (error) {
    return {
      ok: false,
      messageId,
      deliveryStatus: "unknown",
      rawOutput: "",
      error: command ? `send_command_failed: ${errorMessage(error)}` : `send_preflight_failed: ${errorMessage(error)}`
    };
  }
}

async function tailPostfixLog(input: {
  sshRunner: SmtpSshRunner;
  serverSlug: string;
  serverIp: string;
  messageId: string | null;
  lines: number;
}): Promise<string> {
  const filter = input.messageId ? `grep -F ${shellQuote(input.messageId)}` : "tail -20";
  try {
    const result = await input.sshRunner.run({
      serverSlug: input.serverSlug,
      serverIp: input.serverIp,
      command: `tail -200 /var/log/mail.log | ${filter} | tail -${input.lines}`,
      timeoutMs: 30_000
    });
    return redactPostfixLog(result.stdout);
  } catch (error) {
    return redactPostfixLog(`postfix_log_unavailable: ${errorMessage(error)}`);
  }
}

function parseSendRealEmailParams(value: unknown): SendRealEmailParams {
  const input = object(value);
  const params = parseSendRealEmailSkillParams(input);
  return {
    ...params,
    actorId: boundedString(input.actorId, "actorId", 1, 120),
    approvalToken: boundedString(input.approvalToken, "approvalToken", 1, 200)
  };
}

function parseSendRealEmailSkillParams(value: unknown): SendRealEmailSkillParams {
  const input = object(value);
  const fromAddress = email(input.fromAddress, "fromAddress");
  const toAddress = email(input.toAddress, "toAddress");
  const subject = boundedString(input.subject, "subject", 3, 200);
  const body = boundedString(input.body, "body", 20, 8_000);
  assertNoSpamFlagWords(subject, "subject");
  assertNoSpamFlagWords(body, "body");
  return {
    fromAddress,
    toAddress,
    subject,
    body,
    serverSlug: slug(input.serverSlug, "serverSlug"),
    selector: optionalSelector(input.selector),
    ...(input.idempotencyKey === undefined || input.idempotencyKey === null || input.idempotencyKey === "" ? {} : { idempotencyKey: idempotencyKey(input.idempotencyKey, "idempotencyKey") }),
    ...(input.runId === undefined || input.runId === null || input.runId === "" ? {} : { runId: idempotencyKey(input.runId, "runId") }),
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

function assertNoSpamFlagWords(value: string, field: "subject" | "body"): void {
  const lower = value.toLowerCase();
  if (SPAM_FLAG_WORDS.some((word) => lower.includes(word))) {
    throw new SendRealEmailSchemaError([{ field, message: `${field}_contains_spam_flag_word` }]);
  }
}

class SendRealEmailSchemaError extends Error {
  readonly issues: SchemaIssue[];

  constructor(issues: SchemaIssue[]) {
    super(issues.map((issue) => issue.message).join(", "));
    this.issues = issues;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SendRealEmailSchemaError([{ field: "body", message: "params_must_be_object" }]);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, field: keyof SendRealEmailParams, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new SendRealEmailSchemaError([{ field, message: `${field}_must_be_string` }]);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new SendRealEmailSchemaError([{ field, message: `${field}_length_invalid` }]);
  }
  return trimmed;
}

function email(value: unknown, field: keyof SendRealEmailParams): string {
  const trimmed = boundedString(value, field, 3, 254);
  if (!RFC5322_EMAIL.test(trimmed)) {
    throw new SendRealEmailSchemaError([{ field, message: `${field}_invalid_format` }]);
  }
  return trimmed;
}

function slug(value: unknown, field: keyof SendRealEmailParams): string {
  const trimmed = boundedString(value, field, 3, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(trimmed)) {
    throw new SendRealEmailSchemaError([{ field, message: `${field}_invalid` }]);
  }
  return trimmed;
}

function optionalSelector(value: unknown): string {
  if (value === undefined || value === null || value === "") return "default";
  const trimmed = boundedString(value, "selector", 1, 63).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(trimmed)) {
    throw new SendRealEmailSchemaError([{ field: "selector", message: "selector_invalid" }]);
  }
  return trimmed;
}

function idempotencyKey(value: unknown, field: keyof SendRealEmailParams): string {
  const trimmed = boundedString(value, field, 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(trimmed)) {
    throw new SendRealEmailSchemaError([{ field, message: `${field}_invalid` }]);
  }
  return trimmed;
}

function formatIssues(issues: SchemaIssue[]): Record<string, unknown> {
  const formatted: Record<string, { _errors: string[] }> = {};
  for (const issue of issues) {
    formatted[issue.field] ??= { _errors: [] };
    formatted[issue.field]._errors.push(issue.message);
  }
  return formatted;
}

function flattenTxt(records: string[][]): string[] {
  return records.map((record) => record.join(""));
}

interface WebdockServersInventory {
  servers?: Array<{
    slug: string;
    ipv4: string | null;
  }>;
}

async function findServerIp(workspace: OpenClawWorkspace, serverSlug: string): Promise<string | null> {
  const inventory = await workspace.readInventoryJson<WebdockServersInventory>("webdock-servers.json").catch(() => null);
  const server = inventory?.servers?.find((entry) => entry.slug === serverSlug);
  return server?.ipv4 ? normalizeIpv4(server.ipv4) : null;
}

function normalizeIpv4(value: string): string {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)) {
    return "";
  }
  return parts.map((part) => String(Number(part))).join(".");
}

function renderMessage(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  now: Date;
}): string {
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${sanitizeHeader(input.subject)}`,
    `Message-ID: ${input.messageId}`,
    `Date: ${input.now.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.body.replace(/\r\n/g, "\n"),
    ""
  ].join("\n");
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function parseDeliveryStatus(stdout: string, exitCode: number | null): SendRealEmailResult["deliveryStatus"] {
  if (/5\d{2}/.test(stdout)) return "rejected";
  if (/4\d{2}/.test(stdout)) return "deferred";
  if (/250.*queued|250.*ok|250.*accepted|queued as|accepted for delivery/i.test(stdout)) return "sent";
  if (exitCode === 0) return "queued";
  return "unknown";
}

function redactPostfixLog(value: string): string {
  return value
    .replace(/from=<[^>]*>/gi, "from=<REDACTED>")
    .replace(/to=<[^>]*>/gi, "to=<REDACTED>")
    .replace(/[A-Z0-9._%+-]{1,128}@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<EMAIL_REDACTED>");
}

function domainFromEmail(emailAddress: string): string {
  return emailAddress.split("@")[1]?.toLowerCase() ?? "";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function findRecentApproval(input: {
  auditLog: AuditSink;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  approvalToken: string;
  now: Date;
  maxAgeMs: number;
}): Promise<{ artifactId: string; eventId: string } | null> {
  if (!input.auditLog.list) return null;
  const events = await input.auditLog.list();
  const auditEvent = events.toReversed().find((event) => {
    if (!auditApprovalMatchesToken(event, input.approvalToken)) return false;
    const approvedAt = Date.parse(event.occurredAt);
    return Number.isFinite(approvedAt) && input.now.getTime() - approvedAt >= 0 && input.now.getTime() - approvedAt <= input.maxAgeMs;
  });
  if (!auditEvent) return null;

  const state = await input.readCanvasState();
  const artifact = state.artifacts.find((candidate) => artifactMatchesAuditApproval({
    artifact: candidate,
    approvalEvent: auditEvent,
    approvalToken: input.approvalToken,
    now: input.now,
    maxAgeMs: input.maxAgeMs
  }));

  return artifact ? { artifactId: artifact.artifactId, eventId: auditEvent.id } : null;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(request);
  if (!raw) throw new Error("Request body is required.");
  return JSON.parse(raw) as unknown;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function currentTimeMs(deps: Pick<SendRealEmailDependencies, "now">): number {
  return deps.now?.().getTime() ?? Date.now();
}

function eventId(value: unknown): string {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" ? value.id : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown send email error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

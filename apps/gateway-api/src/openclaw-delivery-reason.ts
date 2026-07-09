// Turns a Postfix mail.log into a structured, per-message delivery reason that
// OpenClaw can read WITHOUT ever touching SSH itself: the gateway runs the
// read-only log read server-side and the agent only sees the parsed outcome.
//
// Why a dedicated collector instead of the existing message-id tail: grepping
// mail.log by message-id returns the `cleanup` line (message-id -> queue id) but
// NOT the `smtp ... status=` line, which carries the bounce reason and is keyed
// by QUEUE id. So we resolve the queue id first, then read that queue's lines.
// This is the piece that turns "100% bounce, but why?" into a concrete reason
// (e.g. "550 5.7.1 blocked", "connect to ...:25: Connection timed out").

import {
  parsePostfixDeliveryLog,
  summarizeDeliveryResults,
  type PostfixDeliveryResult,
  type PostfixDeliveryStatus
} from "./postfix-log-parser.ts";

export interface DeliveryReason {
  finalStatus: PostfixDeliveryStatus;
  /** Bare SMTP reply code, e.g. "550". */
  smtpCode?: string;
  /** SMTP enhanced status (DSN) code, e.g. "5.7.1". */
  dsnCode?: string;
  reason?: string;
  queueId?: string;
  recipient?: string;
  relay?: string;
  /** One-line, agent-friendly summary, e.g. "bounced · 550 5.7.1 · Service unavailable; client blocked". */
  summary: string;
}

// Higher = more "informative/final" when several queue results are present and
// we have no message-id to disambiguate (prefer a hard bounce over a stale sent).
const STATUS_PICK_RANK: Record<PostfixDeliveryStatus, number> = {
  unknown: 0,
  sent: 1,
  deferred: 2,
  expired: 3,
  bounced: 4
};

function stripAngle(id: string): string {
  return id.replace(/^<|>$/g, "");
}

/** Select the result that best explains `messageId` (or the most informative one). */
export function selectDeliveryResult(
  results: PostfixDeliveryResult[],
  messageId?: string | null
): PostfixDeliveryResult | undefined {
  if (results.length === 0) return undefined;
  if (messageId) {
    const target = stripAngle(messageId);
    const matched = results.find(
      (result) => result.messageId !== undefined && stripAngle(result.messageId) === target
    );
    if (matched) return matched;
  }
  // No message-id match: prefer the most informative status, tie-break to a reason.
  return [...results].sort((a, b) => {
    const byStatus = STATUS_PICK_RANK[b.status] - STATUS_PICK_RANK[a.status];
    if (byStatus !== 0) return byStatus;
    return Number(Boolean(b.reason)) - Number(Boolean(a.reason));
  })[0];
}

function truncate(value: string, max: number): string {
  const clean = value.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function buildSummary(result: PostfixDeliveryResult): string {
  const parts: string[] = [result.status];
  const code = [result.smtpCode, result.dsnCode].filter(Boolean).join(" ");
  if (code) parts.push(code);
  if (result.reason) parts.push(truncate(result.reason, 160));
  return parts.join(" · ");
}

/** Parse a raw mail.log tail into a single delivery reason. Pure + best-effort. */
export function describeDeliveryFromLog(
  log: string,
  messageId?: string | null
): DeliveryReason | undefined {
  if (!log || !log.trim()) return undefined;
  let results: PostfixDeliveryResult[];
  try {
    results = parsePostfixDeliveryLog(log);
  } catch {
    return undefined;
  }
  const picked = selectDeliveryResult(results, messageId);
  if (!picked) return undefined;
  return {
    finalStatus: picked.status,
    smtpCode: picked.smtpCode,
    dsnCode: picked.dsnCode,
    reason: picked.reason,
    queueId: picked.queueId,
    recipient: picked.recipient,
    relay: picked.relay,
    summary: buildSummary(picked)
  };
}

// --- SSH collector (server-side; the agent never runs SSH) ---

/** Minimal structural shape of the gateway's SMTP SSH runner (decoupled for testing). */
export interface DeliveryLogRunner {
  run(input: {
    serverSlug: string;
    serverIp: string;
    command: string;
    timeoutMs?: number;
  }): Promise<{ stdout: string; exitCode: number }>;
}

export interface CollectDeliveryReasonInput {
  sshRunner: DeliveryLogRunner;
  serverSlug: string;
  serverIp: string;
  messageId?: string | null;
  /** mail.log path; defaults to the Postfix default. */
  logPath?: string;
  /** How many recent log lines to scan. */
  scanLines?: number;
}

export interface CollectDeliveryReasonResult {
  ok: boolean;
  reason?: DeliveryReason;
  /** All results found for the resolved queue (usually one). */
  results: PostfixDeliveryResult[];
  summaryCounts: Record<PostfixDeliveryStatus, number>;
  error?: string;
}

function emptyCounts(): Record<PostfixDeliveryStatus, number> {
  return { sent: 0, bounced: 0, deferred: 0, expired: 0, unknown: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Single-quote for the remote shell. Inputs are our own message-ids / postfix
// queue ids (alphanumeric + <>@.-), but we quote defensively anyway.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Only allow a plain absolute path; refuse anything that could smuggle shell.
function isSafeLogPath(path: string): boolean {
  return /^\/[A-Za-z0-9._/-]+$/.test(path);
}

function clampLines(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 400;
  return Math.max(20, Math.min(2000, Math.trunc(value)));
}

function extractQueueId(log: string): string | undefined {
  // Reuse the parser so queue-id extraction stays consistent with parsing.
  return parsePostfixDeliveryLog(log)[0]?.queueId;
}

/**
 * Reads the Postfix log from BOTH sources in one round-trip: the classic file
 * (rsyslog) and journald. VPSs provisioned on modern Debian/Ubuntu are
 * journald-only — /var/log/mail.log is missing/empty there, which used to make
 * this collector blind (`delivery_log_unavailable`, DSN never confirmed).
 * Concatenating also covers a present-but-stale mail.log: the parser groups by
 * queue-id and keeps the most final status, so duplicated lines are harmless.
 *
 * `-u 'postfix*'` is a journalctl unit glob (constant, nothing interpolated)
 * covering both `postfix.service` and Debian's instanced `postfix@-.service`;
 * `-o short` is the syslog-like format the parser already understands. Each
 * source silences its own errors and the pipeline ends in `tail`, so the remote
 * command always exits 0 (the SSH runner rejects non-zero exits).
 */
export function buildMailLogReadCommand(logPath: string, scanLines: number): string {
  return `{ tail -${scanLines} ${shellSingleQuote(logPath)} 2>/dev/null; journalctl -q --no-pager -o short -u 'postfix*' -n ${scanLines} 2>/dev/null; }`;
}

async function runTailGrep(
  input: CollectDeliveryReasonInput,
  logPath: string,
  scanLines: number,
  needle: string
): Promise<string> {
  const result = await input.sshRunner.run({
    serverSlug: input.serverSlug,
    serverIp: input.serverIp,
    command: `${buildMailLogReadCommand(logPath, scanLines)} | grep -F ${shellSingleQuote(needle)} | tail -40`,
    timeoutMs: 30_000
  });
  return result.stdout;
}

/**
 * Reads a message's delivery outcome from a server's mail.log over SSH and
 * returns the parsed reason. Two stages when a message-id is known: resolve the
 * queue id from the message-id line, then read that queue's lines (which carry
 * `status=…`). Best-effort: never throws; returns { ok:false, error } on failure.
 */
export async function collectDeliveryReason(
  input: CollectDeliveryReasonInput
): Promise<CollectDeliveryReasonResult> {
  const logPath = input.logPath ?? "/var/log/mail.log";
  const scanLines = clampLines(input.scanLines);

  if (!isSafeLogPath(logPath)) {
    return { ok: false, results: [], summaryCounts: emptyCounts(), error: "unsafe_log_path" };
  }

  try {
    let queueLog: string;
    if (input.messageId) {
      const idLog = await runTailGrep(input, logPath, scanLines, input.messageId);
      const queueId = extractQueueId(idLog);
      queueLog = queueId ? await runTailGrep(input, logPath, scanLines, queueId) : idLog;
    } else {
      const result = await input.sshRunner.run({
        serverSlug: input.serverSlug,
        serverIp: input.serverIp,
        command: `${buildMailLogReadCommand(logPath, scanLines)} | tail -${scanLines}`,
        timeoutMs: 30_000
      });
      queueLog = result.stdout;
    }

    const results = parsePostfixDeliveryLog(queueLog);
    const reason = describeDeliveryFromLog(queueLog, input.messageId);
    return {
      ok: Boolean(reason),
      reason,
      results,
      summaryCounts: summarizeDeliveryResults(results)
    };
  } catch (error) {
    return {
      ok: false,
      results: [],
      summaryCounts: emptyCounts(),
      error: `delivery_log_unavailable: ${errorMessage(error)}`
    };
  }
}

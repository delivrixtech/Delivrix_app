/**
 * POST /v1/openclaw/skills/placement-check
 *
 * Skill OpenClaw que abre IMAP a Gmail (lectura) y reporta inbox vs spam vs
 * promotions sobre un subject matcher único (regex `^\[delivrix-...\]`).
 * Devuelve placementRate y samples. Emite audit `oc.placement.checked`.
 *
 * Reglas:
 *  - El adapter es singleton (instanciado en startup).
 *  - GMAIL_IMAP_ENABLE debe ser "true" y credenciales presentes — sino 409.
 *  - imap_connect_failed → 502.
 *  - El App Password jamás se loggea ni aparece en response.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEvent,
  AuditEventInput
} from "../../../../packages/domain/src/index.ts";
import { readRequestBody } from "../request-body.ts";
import {
  GmailImapAdapter,
  GmailImapAdapterError,
  type ClassifyResult,
  type PlacementMatchBy
} from "../email-imap/gmail-adapter.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

export interface PlacementCheckDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  auditLog: AuditSink;
  adapter: GmailImapAdapter | null;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface PlacementCheckResponse {
  ok: true;
  rampId?: string;
  matched: number;
  inbox: number;
  spam: number;
  promotions: number;
  other: number;
  placementRate: number;
  samples: Array<{
    uid: number;
    folder: "inbox" | "spam" | "promotions" | "other";
    subject: string;
    from: string;
    receivedAt: string;
  }>;
  meta: {
    matcher: string;
    matchBy: PlacementMatchBy;
    windowMinutes: number;
    queriedAt: string;
    elapsedMs: number;
  };
}

const SUBJECT_MATCHER_RE = /^\[delivrix-[a-z0-9-]{6,}\]/;
const MATCH_BY_VALUES = new Set<PlacementMatchBy>(["subject", "from", "messageId"]);

export class PlacementCheckInputError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, code: string, statusCode = 422) {
    super(message);
    this.name = "PlacementCheckInputError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function handlePlacementCheckHttp(
  deps: PlacementCheckDependencies
): Promise<void> {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  const body = await readJson<Record<string, unknown>>(deps.request);

  const matchBy = parseMatchBy(body.matchBy);
  const matcher = parseMatcher(body.matcher, matchBy);
  const windowMinutes = parseWindowMinutes(body.windowMinutes);
  const actorId = requiredString(body.actorId, "actorId");
  const rampId = optionalString(body.rampId);

  // 1) Validar enable flag + adapter presente
  const enabled = (env.GMAIL_IMAP_ENABLE ?? "").toLowerCase() === "true";
  if (!enabled) {
    return reject(deps.response, 409, "imap_disabled", "GMAIL_IMAP_ENABLE is not 'true'.");
  }
  if (!env.GMAIL_IMAP_USER || !env.GMAIL_IMAP_APP_PASSWORD) {
    return reject(
      deps.response,
      409,
      "credentials_missing",
      "GMAIL_IMAP_USER and GMAIL_IMAP_APP_PASSWORD are required."
    );
  }
  if (!deps.adapter) {
    return reject(deps.response, 409, "imap_disabled", "Gmail IMAP adapter is not initialized.");
  }

  // 2) Llamar al adapter
  let result: ClassifyResult;
  try {
    result = await deps.adapter.classify(matcher, windowMinutes, matchBy);
  } catch (error) {
    if (error instanceof GmailImapAdapterError) {
      const statusCode =
        error.code === "imap_disabled" || error.code === "imap_auth_failed"
          ? 409
          : 502;
      await deps.auditLog.append({
        actorType: "operator",
        actorId,
        action: "oc.placement.check_failed",
        targetType: "placement_check",
        targetId: rampId ?? matcher,
        riskLevel: "medium",
        decision: "reject",
        metadata: {
          matcher,
          matchBy,
          windowMinutes,
          errorCode: error.code,
          errorMessage: error.message,
          rampId
        }
      });
      json(deps.response, statusCode, {
        ok: false,
        error: error.code,
        message: error.message
      });
      return;
    }
    throw error;
  }

  // 3) Audit + 200
  await deps.auditLog.append({
    actorType: "operator",
    actorId,
    action: "oc.placement.checked",
    targetType: "placement_check",
    targetId: rampId ?? matcher,
    riskLevel: "low",
    decision: "allow",
    metadata: {
      matcher,
      matchBy,
      windowMinutes,
      matched: result.matched,
      inbox: result.inbox,
      spam: result.spam,
      promotions: result.promotions,
      other: result.other,
      placementRate: result.placementRate,
      elapsedMs: result.elapsedMs,
      rampId
    }
  });

  const payload: PlacementCheckResponse = {
    ok: true,
    rampId,
    matched: result.matched,
    inbox: result.inbox,
    spam: result.spam,
    promotions: result.promotions,
    other: result.other,
    placementRate: result.placementRate,
    samples: result.samples.map((sample) => ({
      uid: sample.uid,
      folder: sample.folder,
      subject: sample.subject,
      from: sample.from,
      receivedAt: sample.receivedAt
    })),
    meta: {
      matcher,
      matchBy,
      windowMinutes,
      queriedAt: now.toISOString(),
      elapsedMs: result.elapsedMs
    }
  };

  json(deps.response, 200, payload);
}

export function handlePlacementCheckError(
  error: unknown,
  response: ServerResponse
): boolean {
  if (error instanceof PlacementCheckInputError) {
    json(response, error.statusCode, {
      ok: false,
      error: error.code,
      message: error.message
    });
    return true;
  }
  if (error instanceof SyntaxError) {
    json(response, 400, {
      ok: false,
      error: "invalid_json",
      message: "Request body must be valid JSON."
    });
    return true;
  }
  return false;
}

/* ============================================================
 * Singleton helper — usado por main.ts en startup
 * ============================================================ */

export function createGmailImapAdapterFromEnv(
  env: Record<string, string | undefined> = process.env
): GmailImapAdapter | null {
  const enabled = (env.GMAIL_IMAP_ENABLE ?? "").toLowerCase() === "true";
  const host = env.GMAIL_IMAP_HOST?.trim() || "imap.gmail.com";
  const portRaw = env.GMAIL_IMAP_PORT?.trim();
  const port = portRaw ? Number(portRaw) : 993;
  const user = env.GMAIL_IMAP_USER?.trim() ?? "";
  const pass = env.GMAIL_IMAP_APP_PASSWORD ?? "";

  if (!enabled) return null;
  if (!user || !pass) return null;
  if (!Number.isFinite(port) || port <= 0) return null;

  return new GmailImapAdapter({ host, port, user, pass });
}

/* ============================================================
 * Validation helpers
 * ============================================================ */

function parseMatchBy(value: unknown): PlacementMatchBy {
  if (typeof value !== "string") {
    throw new PlacementCheckInputError("matchBy is required.", "invalid_match_by");
  }
  const trimmed = value.trim() as PlacementMatchBy;
  if (!MATCH_BY_VALUES.has(trimmed)) {
    throw new PlacementCheckInputError(
      "matchBy must be one of: subject, from, messageId.",
      "invalid_match_by"
    );
  }
  return trimmed;
}

function parseMatcher(value: unknown, matchBy: PlacementMatchBy): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PlacementCheckInputError("matcher is required.", "invalid_matcher");
  }
  const trimmed = value.trim();
  if (matchBy === "subject" && !SUBJECT_MATCHER_RE.test(trimmed)) {
    throw new PlacementCheckInputError(
      "matcher must match ^[delivrix-<id 6+>] to avoid false positives.",
      "invalid_matcher"
    );
  }
  if (trimmed.length > 256) {
    throw new PlacementCheckInputError("matcher is too long (max 256 chars).", "invalid_matcher");
  }
  return trimmed;
}

function parseWindowMinutes(value: unknown): number {
  if (value === undefined || value === null) return 30;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new PlacementCheckInputError("windowMinutes must be a number.", "invalid_window_minutes");
  }
  if (n < 5 || n > 120) {
    throw new PlacementCheckInputError(
      "windowMinutes must be between 5 and 120.",
      "invalid_window_minutes"
    );
  }
  return Math.floor(n);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PlacementCheckInputError(`${field} is required.`, `invalid_${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/* ============================================================
 * HTTP helpers
 * ============================================================ */

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new PlacementCheckInputError("Request body is required.", "invalid_json", 400);
  }
  return JSON.parse(raw) as T;
}

function reject(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string
): void {
  json(response, statusCode, { ok: false, error: code, message });
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

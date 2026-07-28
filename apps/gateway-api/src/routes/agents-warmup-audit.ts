// POST /v1/openclaw/agents/warmup/audit — dispara el abanico de diagnostico.
//
// Es read-only en efecto (las 5 tools del rol son de lectura), pero NO es gratis: consume
// tokens de Bedrock y abre sesiones SSH contra la flota. Por eso pasa por el mismo gate que la
// descarga de credenciales, tiene su propio rate limit bajo, y chequea el kill switch ANTES de
// crear el primer agente — no solo por tool.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";
import type { AgentSessionManager } from "../agents/agent-session-manager.ts";
import {
  DEFAULT_FAN_OUT_CONCURRENCY,
  MAX_FAN_OUT_CONCURRENCY
} from "../agents/agent-fan-out.ts";
import { runWarmupAudit, type WarmupAuditReport } from "../agents/warmup-audit-run.ts";
import type { AuditEventReader } from "../agents/warmup-fleet-source.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { readRequestBody } from "../request-body.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface WarmupAuditRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  sessionManager: AgentSessionManager;
  workspace: OpenClawWorkspace;
  auditLog: AuditSink & AuditEventReader;
  readBoundaryToken?: string;
  /** Fail-closed: si no se puede leer, la corrida no arranca. */
  readKillSwitch: () => Promise<{ enabled: boolean }> | { enabled: boolean };
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/**
 * Rate limit propio y BAJO. Cada corrida son hasta 59 sesiones de modelo y ~295 sesiones SSH:
 * el default generico de 60/min permitiria 3540 sondeos por minuto sobre la flota.
 */
const AUDIT_RATE_LIMIT_PER_MINUTE = 3;

export async function handleWarmupAuditHttp(deps: WarmupAuditRouteDeps): Promise<void> {
  if (deps.request.method !== "POST") {
    json(deps.response, 405, { error: "method_not_allowed" });
    return;
  }

  const auth = authorizeSensitiveRead(
    deps.request,
    {
      ...(deps.readBoundaryToken === undefined ? {} : { readBoundaryToken: deps.readBoundaryToken }),
      rateLimitPerMinute: AUDIT_RATE_LIMIT_PER_MINUTE,
      ...(deps.now ? { now: deps.now } : {})
    },
    "agents_warmup_audit"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  // Antes de crear el primer agente, no solo por tool: si el operador armo el kill switch, la
  // corrida no arranca. Fail-closed — un kill switch ilegible frena igual.
  let killSwitch: { enabled: boolean };
  try {
    killSwitch = await deps.readKillSwitch();
  } catch {
    json(deps.response, 503, { error: "kill_switch_unreadable" });
    return;
  }
  if (killSwitch.enabled) {
    json(deps.response, 409, { error: "kill_switch_armed" });
    return;
  }

  let body: { domains?: unknown; concurrency?: unknown };
  try {
    const raw = await readRequestBody(deps.request, { trim: false });
    body = raw.trim() ? (JSON.parse(raw) as typeof body) : {};
  } catch {
    json(deps.response, 400, { error: "invalid_json" });
    return;
  }

  let domains: string[] | undefined;
  if (body.domains !== undefined && body.domains !== null) {
    if (!Array.isArray(body.domains) || body.domains.some((entry) => typeof entry !== "string")) {
      json(deps.response, 422, { error: "invalid_domains" });
      return;
    }
    domains = body.domains as string[];
  }

  let concurrency = DEFAULT_FAN_OUT_CONCURRENCY;
  if (body.concurrency !== undefined && body.concurrency !== null) {
    if (
      !Number.isInteger(body.concurrency) ||
      (body.concurrency as number) < 1 ||
      (body.concurrency as number) > MAX_FAN_OUT_CONCURRENCY
    ) {
      json(deps.response, 422, {
        error: "invalid_concurrency",
        message: `concurrency debe ser entero entre 1 y ${MAX_FAN_OUT_CONCURRENCY}.`
      });
      return;
    }
    concurrency = body.concurrency as number;
  }

  let report: WarmupAuditReport;
  try {
    report = await runWarmupAudit({
      sessionManager: deps.sessionManager,
      workspace: deps.workspace,
      auditLog: deps.auditLog,
      ...(domains ? { domains } : {}),
      concurrency,
      ...(deps.now ? { now: deps.now } : {})
    });
  } catch (error) {
    // El detalle al log del gateway; al cliente solo el codigo.
    json(deps.response, 500, {
      error: "warmup_audit_failed",
      message: error instanceof Error ? error.name : "unknown"
    });
    return;
  }

  // UN evento resumen por corrida, no uno por dominio: el audit log se relee entero por append
  // para el prevHash y ya pesa megabytes. El detalle por dominio va en la respuesta.
  await deps.auditLog.append({
    actorType: "operator",
    actorId: "operator/warmup-audit",
    action: "oc.agents.warmup_audit_run",
    targetType: "fleet",
    targetId: domains ? domains.join(",").slice(0, 128) : "all",
    riskLevel: "medium",
    decision: "allow",
    humanApproved: false,
    metadata: {
      fleetSize: report.fleetSize,
      concurrency: report.concurrency,
      ok: report.ok,
      failed: report.failed,
      cancelled: report.cancelled,
      aborted: report.aborted,
      bindingConflicts: report.bindingConflicts,
      withoutMessageId: report.withoutMessageId,
      // Los dominios con inventario contradictorio, para que el operador los reconcilie.
      conflictDomains: report.items.filter((i) => i.bindingConflict).map((i) => i.domain)
    }
  });

  json(deps.response, 200, report);
}

/** GET /v1/openclaw/agents/state — sesiones vivas + historial retenido. */
export function handleAgentsStateHttp(deps: {
  request: IncomingMessage;
  response: ServerResponse;
  sessionManager: AgentSessionManager;
  readBoundaryToken?: string;
  now?: () => Date;
}): void {
  const auth = authorizeSensitiveRead(
    deps.request,
    {
      ...(deps.readBoundaryToken === undefined ? {} : { readBoundaryToken: deps.readBoundaryToken }),
      ...(deps.now ? { now: deps.now } : {})
    },
    "agents_state"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  json(deps.response, 200, {
    live: deps.sessionManager.liveSessionCount,
    paused: deps.sessionManager.isPaused,
    sessions: deps.sessionManager.listSessions()
  });
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store"
  });
  response.end(body);
}

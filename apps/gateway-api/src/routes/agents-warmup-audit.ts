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
  /** Cada cuanto se relee el kill switch mientras la corrida esta en vuelo. Default 5s. */
  killSwitchPollMs?: number;
  now?: () => Date;
}

/**
 * Rate limit propio y BAJO. Cada corrida son hasta 59 sesiones de modelo y ~295 sesiones SSH:
 * el default generico de 60/min permitiria 3540 sondeos por minuto sobre la flota.
 */
const AUDIT_RATE_LIMIT_PER_MINUTE = 3;

/**
 * Cada cuanto se relee el kill switch DURANTE la corrida.
 *
 * Leerlo una sola vez antes de arrancar —como se hacia— significa que una vez lanzada la
 * corrida no habia forma de pararla: ~472 llamadas al modelo y ~295 sesiones SSH sin freno.
 */
const KILL_SWITCH_POLL_MS = 5_000;

/**
 * Una corrida por vez.
 *
 * El rate limit de 3/min permitia tres abanicos concurrentes de 59 dominios, o sea 12 SSH
 * simultaneos contra la flota (3 x concurrencia 4) y el triple de gasto, sin que nadie lo
 * pidiera. Es estado de modulo porque el gateway es un solo proceso.
 */
let auditRunInFlight = false;

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

  if (auditRunInFlight) {
    json(deps.response, 409, {
      error: "warmup_audit_already_running",
      message: "Ya hay un abanico corriendo. Esperá a que termine: dos corridas duplican el gasto y las sesiones SSH."
    });
    return;
  }

  // El kill switch se relee DURANTE la corrida y aborta lo que este en vuelo. Sin esto se leia
  // una sola vez, antes del primer agente: una vez lanzada, la corrida era imparable.
  const abortController = new AbortController();
  const killSwitchPoll = setInterval(() => {
    void (async () => {
      try {
        const current = await deps.readKillSwitch();
        if (current.enabled) abortController.abort();
      } catch {
        // Fail-closed tambien en vuelo: un kill switch ilegible frena la corrida.
        abortController.abort();
      }
    })();
  }, deps.killSwitchPollMs ?? KILL_SWITCH_POLL_MS);
  killSwitchPoll.unref?.();

  auditRunInFlight = true;
  let report: WarmupAuditReport;
  try {
    report = await runWarmupAudit({
      sessionManager: deps.sessionManager,
      workspace: deps.workspace,
      auditLog: deps.auditLog,
      ...(domains ? { domains } : {}),
      concurrency,
      abortSignal: abortController.signal,
      // No alcanza con cortar lo que esta en vuelo: tambien hay que dejar de despachar. El
      // default mira `isPaused` del manager, que en el abanico nadie pone en true.
      shouldAbort: () => abortController.signal.aborted,
      ...(deps.now ? { now: deps.now } : {})
    });
  } catch (error) {
    // El detalle al log del gateway; al cliente solo el codigo.
    json(deps.response, 500, {
      error: "warmup_audit_failed",
      message: error instanceof Error ? error.name : "unknown"
    });
    return;
  } finally {
    clearInterval(killSwitchPoll);
    auditRunInFlight = false;
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
      // Veredictos cortados a mitad: cuentan como ok pero no concluyeron.
      truncated: report.truncated,
      inputTokens: report.totals.inputTokens,
      outputTokens: report.totals.outputTokens,
      estimatedCostUsd: report.totals.estimatedCostUsd,
      pricingKnown: report.totals.pricingKnown,
      // Veredictos escritos sin una sola sonda: el numero a mirar antes que ninguno.
      sinEvidencia: report.sinEvidencia,
      paused: report.paused,
      // Lo que la corrida NO pudo mirar, para que el alcance quede auditado y no supuesto.
      credentialedWithoutBinding: report.credentialedWithoutBinding,
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

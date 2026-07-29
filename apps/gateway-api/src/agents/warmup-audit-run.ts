// Corrida del abanico de diagnostico: junta las piezas de M1 y devuelve el reporte.
//
// Es el unico lugar donde se arma un abanico, a proposito: si el cableado estuviera repetido en
// la ruta y en un script, las dos copias divergirian y una de las dos mentiria.

import type { AgentRole } from "../../../../packages/domain/src/index.ts";
import { AGENT_DEFINITIONS } from "./agent-registry.ts";
import type { AgentSessionManager } from "./agent-session-manager.ts";
import { DEFAULT_FAN_OUT_CONCURRENCY, runFanOut, type FanOutSummary } from "./agent-fan-out.ts";
import { diagnosticDefinitionFor } from "./warmup-tool-executor.ts";
import {
  buildDiagnosticInstructions,
  loadWarmupFleet,
  type AuditEventReader,
  type FleetDomain
} from "./warmup-fleet-source.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";

export interface WarmupAuditRunInput {
  sessionManager: AgentSessionManager;
  workspace: OpenClawWorkspace;
  auditLog?: AuditEventReader;
  /** Subconjunto de la flota. Ausente = todos los dominios enlazados. */
  domains?: readonly string[];
  concurrency?: number;
  /** Corta las llamadas al modelo en vuelo, no solo el despacho del proximo dominio. */
  abortSignal?: AbortSignal;
  /** Frena el despacho del proximo dominio. Default: el `isPaused` del manager. */
  shouldAbort?: () => boolean;
  now?: () => Date;
}

export interface WarmupAuditReport {
  startedAt: string;
  finishedAt: string;
  /** Dominios pedidos que no existen en el inventario. */
  notFound: string[];
  /** Bindings leidos vs usables: delata descartes sin depender de un log. */
  totalInInventory: number;
  fleetSize: number;
  /** Dominios donde el inventario se contradice sobre que nodo los sirve. */
  bindingConflicts: number;
  /** Dominios sin messageId: corren con 4 tools en vez de 5. */
  withoutMessageId: number;
  concurrency: number;
  ok: number;
  failed: number;
  cancelled: number;
  aborted: boolean;
  peakInFlight: number;
  /** Dominios cuyo veredicto se corto en max_tokens: cuentan como ok pero no concluyeron. */
  truncated: number;
  /**
   * Que cerebro corrio.
   *
   * Sin esto una corrida en `mock` —el default— es indistinguible de una real leyendo el
   * reporte: el mock fabrica 250/120 tokens por llamada y declara precio 0, asi que sale un
   * reporte con tokens, con costo 0 y con pricingKnown en true.
   */
  modelId: string;
  /** Tokens y costo de la corrida entera. Es el numero con el que se decide donde corren. */
  totals: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    /** false = alguna sesion corrio con un modelo sin precio conocido; el costo es un piso. */
    pricingKnown: boolean;
  };
  items: Array<{
    domain: string;
    serverSlug: string;
    /**
     * `ok` significa que hubo veredicto.
     *
     * `paused` es el cap de 50.000 tokens y `exhausted` es max_iterations: los dos terminan sin
     * diagnostico y son las sesiones mas caras de la corrida. Meterlos en `ok` —como pasaba—
     * hacia que el reporte dijera "59 ok" con N nodos sin diagnosticar.
     */
    status: "ok" | "failed" | "paused" | "exhausted" | "cancelled";
    sessionId?: string;
    error?: string;
    bindingConflict?: { fromBindings: string; fromCredentials: string };
    hasMessageId: boolean;
    /** El modelo se quedo sin espacio: el veredicto de este dominio puede estar a medias. */
    truncated?: true;
    /** El veredicto. Es lo unico que la corrida produce; sin esto no llega a ningun lado. */
    verdict?: string;
    inputTokens?: number;
    outputTokens?: number;
  }>;
}

/**
 * Corre el abanico de diagnostico sobre la flota.
 *
 * Read-only de punta a punta: las 5 tools del rol son de lectura y el executor rechaza todo lo
 * demas. Ni esta funcion ni nada que llame escribe estado del warmup.
 */
export async function runWarmupAudit(input: WarmupAuditRunInput): Promise<WarmupAuditReport> {
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const fleet = await loadWarmupFleet({
    workspace: input.workspace,
    ...(input.auditLog ? { auditLog: input.auditLog } : {}),
    ...(input.domains && input.domains.length > 0 ? { onlyDomains: input.domains } : {})
  });

  const concurrency = input.concurrency ?? DEFAULT_FAN_OUT_CONCURRENCY;

  const summary: FanOutSummary<FleetDomain> = await runFanOut({
    sessionManager: input.sessionManager,
    role: "warmup",
    items: fleet.domains,
    buildInput: (target) => ({
      taskId: `warmup-audit-${target.domain}`,
      // El actor honesto: esto es un abanico determinista, no una delegacion del modelo.
      delegatedBy: "supervisor",
      instructions: buildDiagnosticInstructions(target)
    }),
    invokedByRole: "supervisor",
    concurrency,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.shouldAbort ? { shouldAbort: input.shouldAbort } : {}),
    ...(input.now ? { now: input.now } : {})
  });

  return {
    startedAt,
    finishedAt: now().toISOString(),
    notFound: fleet.notFound,
    totalInInventory: fleet.totalInInventory,
    fleetSize: fleet.domains.length,
    bindingConflicts: fleet.domains.filter((entry) => entry.bindingConflict).length,
    withoutMessageId: fleet.domains.filter((entry) => !entry.recentMessageId).length,
    concurrency,
    ok: summary.ok,
    failed: summary.failed,
    cancelled: summary.cancelled,
    aborted: summary.aborted,
    peakInFlight: summary.peakInFlight,
    truncated: summary.results.filter((entry) => entry.result?.truncated).length,
    modelId: input.sessionManager.modelIdForRole("warmup"),
    totals: {
      // `spent` cubre las sesiones que TIRARON: sus tokens ya se pagaron aunque no haya result.
      inputTokens: summary.results.reduce(
        (acc, entry) => acc + (entry.result?.inputTokens ?? entry.spent?.inputTokens ?? 0), 0
      ),
      outputTokens: summary.results.reduce(
        (acc, entry) => acc + (entry.result?.outputTokens ?? entry.spent?.outputTokens ?? 0), 0
      ),
      estimatedCostUsd: roundUsd(
        summary.results.reduce(
          (acc, entry) => acc + (entry.result?.estimatedCostUsd ?? entry.spent?.estimatedCostUsd ?? 0), 0
        )
      ),
      // Basta UNA sesion con precio desconocido para que el total deje de ser el costo y pase a
      // ser un piso. Reportarlo como cerrado seria justo el tipo de numero confiado y falso que
      // el resto del modulo se esfuerza en evitar.
      pricingKnown: summary.results.every((entry) => entry.result === undefined || entry.result.pricingKnown)
    },
    items: summary.results.map((entry) => ({
      domain: entry.item.domain,
      serverSlug: entry.item.serverSlug,
      status: statusOf(entry),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.item.bindingConflict ? { bindingConflict: entry.item.bindingConflict } : {}),
      hasMessageId: entry.item.recentMessageId !== undefined,
      ...(entry.result?.truncated ? { truncated: true as const } : {}),
      // El veredicto acotado: es el producto de la corrida. Sin esto el operador recibe un
      // conteo de exitos y ni una linea de por que cada dominio entrega o no entrega.
      ...(entry.result ? { verdict: entry.result.resultSummary.slice(0, VERDICT_MAX_CHARS) } : {}),
      ...(entry.result ?? entry.spent
        ? {
            inputTokens: entry.result?.inputTokens ?? entry.spent?.inputTokens ?? 0,
            outputTokens: entry.result?.outputTokens ?? entry.spent?.outputTokens ?? 0
          }
        : {})
    }))
  };
}

/** Alcanza para un veredicto con su evidencia sin volver la respuesta HTTP inmanejable. */
const VERDICT_MAX_CHARS = 4_000;

function statusOf(entry: {
  cancelled?: true;
  error?: string;
  result?: { status: "completed" | "failed" | "paused" };
}): "ok" | "failed" | "paused" | "exhausted" | "cancelled" {
  if (entry.cancelled) return "cancelled";
  if (entry.error !== undefined) return "failed";
  if (entry.result === undefined) return "failed";
  if (entry.result.status === "completed") return "ok";
  // `paused` es el cap de tokens; `failed` devuelto por la sesion es max_iterations. Se
  // distinguen porque se arreglan distinto: uno pide mas presupuesto, el otro mas vueltas.
  return entry.result.status === "paused" ? "paused" : "exhausted";
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** La definicion efectiva que el manager tiene que usar para que la sesion no filtre las 5 tools. */
export function warmupAuditDefinitionForRole(role: AgentRole) {
  return diagnosticDefinitionFor(role, AGENT_DEFINITIONS[role]);
}

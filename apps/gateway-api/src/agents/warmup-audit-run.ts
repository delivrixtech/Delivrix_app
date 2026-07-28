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
  items: Array<{
    domain: string;
    serverSlug: string;
    status: "ok" | "failed" | "cancelled";
    sessionId?: string;
    error?: string;
    bindingConflict?: { fromBindings: string; fromCredentials: string };
    hasMessageId: boolean;
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
    items: summary.results.map((entry) => ({
      domain: entry.item.domain,
      serverSlug: entry.item.serverSlug,
      status: entry.cancelled ? "cancelled" : entry.error !== undefined ? "failed" : "ok",
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.item.bindingConflict ? { bindingConflict: entry.item.bindingConflict } : {}),
      hasMessageId: entry.item.recentMessageId !== undefined
    }))
  };
}

/** La definicion efectiva que el manager tiene que usar para que la sesion no filtre las 5 tools. */
export function warmupAuditDefinitionForRole(role: AgentRole) {
  return diagnosticDefinitionFor(role, AGENT_DEFINITIONS[role]);
}

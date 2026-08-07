// Read-only HTTP route exposing the warmup-engine status snapshot for the Delivrix panel.
// The panel asks "how is warmup doing?"; the gateway reads the engine state (active nodes, queued
// sends, FSM breakdown) and returns it. Purely additive/observational: it NEVER runs the engine
// tick, never sends mail, never writes — it only reads via getWarmupStatusSnapshot.
//
// Import discipline: we import the pg-store factory and the snapshot reader from their SPECIFIC
// source files (not the warmup-engine barrel index.ts) so we do not drag the live nodemailer/imapflow
// adapters into the gateway process.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";
import { createPgWarmupStores, type PgClient } from "../../../warmup-engine/src/store/pg-stores.ts";
import {
  getWarmupStatusSnapshot,
  type WarmupStatusSnapshot
} from "../../../warmup-engine/src/service/service.ts";

export interface WarmupStatusDeps {
  pgClient: PgClient | null;
  readBoundaryToken?: string;
  now?: () => Date;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
  env?: NodeJS.ProcessEnv;
}

/**
 * Snapshot degradado (Postgres o tablas ausentes): nunca 500, el panel siempre puede pintar algo.
 *
 * LOS CONTADORES VAN EN `null`, NO EN 0, y es el mismo incidente del 2026-07-25 con otra ropa: un
 * cero que nadie midió se lee como una medición ("38 nodos cerrados en Gmail con CERO detecciones
 * de blacklist" ⇒ "está limpio"). Acá el 0 decía "0 nodos activos, 0 envíos en cola" con Postgres
 * caído, que es indistinguible de una fábrica sana y quieta.
 *
 * Van los contadores y no el objeto entero: `Warmup.tsx` declara `totals` como obligatorio aunque
 * no lo lee, y el panel está fuera de esta corrida. `null` en cada número no rompe ningún render y
 * deja de mentir igual.
 */
function degradedSnapshot(
  now: Date,
  note: string
): Omit<WarmupStatusSnapshot, "totals"> & { totals: { activeNodes: null; queuedSends: null }; note: string } {
  return {
    generatedAt: now.toISOString(),
    enabled: false,
    totals: { activeNodes: null, queuedSends: null },
    byState: {},
    nodes: [],
    note
  };
}

export async function handleWarmupStatus(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupStatusDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, { readBoundaryToken: deps.readBoundaryToken }, "warmup_status");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const now = (deps.now ?? (() => new Date()))();

  // Postgres no configurado: snapshot vacío/degradado, no 500.
  if (!deps.pgClient) {
    json(response, 200, degradedSnapshot(now, "postgres_unavailable"));
    return;
  }

  try {
    const stores = createPgWarmupStores(deps.pgClient);
    const snapshot = await getWarmupStatusSnapshot(stores, {
      now,
      ...(deps.env ? { env: deps.env } : {})
    });
    json(response, 200, snapshot);
  } catch (error) {
    // Tablas no migradas / query rota: degradar en vez de romper el panel. Read-only: nada que revertir.
    void deps.logger?.warn(
      "warmup.status_read_failed",
      "Warmup status read failed; returning degraded snapshot.",
      { message: errorMessage(error) }
    );
    json(response, 200, degradedSnapshot(now, "warmup_tables_unavailable"));
  }
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

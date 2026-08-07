// Read-only HTTP route exposing the warmup TREND for the Delivrix dashboard (gaps v1).
// The panel asks "how is warmup trending?"; the gateway reads placement series + per-provider
// breakdown + reference ramp + recent signal counts and returns them. Purely additive/observational:
// it NEVER runs the engine tick, never sends mail, never writes — it only reads via getWarmupTrends.
//
// Import discipline: we import the pg-store factory and the trends assembler from their SPECIFIC
// source files (not the warmup-engine barrel index.ts) so we do not drag the live nodemailer/imapflow
// adapters into the gateway process.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";
import { createPgWarmupStores, type PgClient } from "../../../warmup-engine/src/store/pg-stores.ts";
import type { WarmupTrends } from "../../../warmup-engine/src/domain/trends.ts";
import { getWarmupTrends } from "../../../warmup-engine/src/service/trends-service.ts";

export interface WarmupTrendsDeps {
  pgClient: PgClient | null;
  readBoundaryToken?: string;
  now?: () => Date;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
  env?: NodeJS.ProcessEnv;
}

/**
 * Tendencia degradada (Postgres o tablas ausentes): nunca 500, el panel siempre puede pintar algo.
 *
 * `signals: null` Y NO `{bounces: 0, complaints: 0}`, que es la línea entera de este cambio.
 *
 * Un cero acá es una MENTIRA con forma de medición: el panel pintaba "0 rebotes, 0 quejas" sobre
 * datos que nadie leyó. Es literalmente la confusión más cara de la historia de este sistema — el
 * 2026-07-25 había 38 nodos cerrados en Gmail con CERO detecciones de blacklist, y alguien leyó ese
 * cero como "está limpio". El banner de degradado ya existía y ayuda, pero el número es lo que se
 * lee, y el número decía cero.
 *
 * Las listas vacías se quedan y no es incoherencia: una serie vacía se RENDERIZA como vacía y nadie
 * la lee como "medimos y no hubo nada". Un `0` sí.
 *
 * VERIFICADO que `null` es seguro en el render: `Warmup.tsx:781-786` ya pinta "sin señales medidas"
 * hardcodeado e IGNORA el prop. Queda una mentira de tipos en `Warmup.tsx:125`
 * (`signals: { bounces: number; complaints: number }`) que hay que aflojar a `| null` — va como
 * hallazgo para el operador, porque el panel está fuera de esta corrida.
 */
function degradedTrends(now: Date, note: string): Omit<WarmupTrends, "signals"> & { signals: null; note: string } {
  return {
    generatedAt: now.toISOString(),
    placementSeries: [],
    perProvider: [],
    ramp: [],
    signals: null,
    note
  };
}

export async function handleWarmupTrends(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupTrendsDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, { readBoundaryToken: deps.readBoundaryToken }, "warmup_trends");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }

  const now = (deps.now ?? (() => new Date()))();

  // Postgres no configurado: tendencia vacía/degradada, no 500.
  if (!deps.pgClient) {
    json(response, 200, degradedTrends(now, "postgres_unavailable"));
    return;
  }

  try {
    const stores = createPgWarmupStores(deps.pgClient);
    const trends = await getWarmupTrends(stores, { now });
    json(response, 200, trends);
  } catch (error) {
    // Tablas no migradas / query rota: degradar en vez de romper el panel. Read-only: nada que revertir.
    void deps.logger?.warn(
      "warmup.trends_read_failed",
      "Warmup trends read failed; returning degraded trends.",
      { message: errorMessage(error) }
    );
    json(response, 200, degradedTrends(now, "warmup_tables_unavailable"));
  }
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

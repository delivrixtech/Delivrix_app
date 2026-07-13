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

/** Tendencia degradada (Postgres o tablas ausentes): nunca 500, el panel siempre puede pintar algo. */
function degradedTrends(now: Date, note: string): WarmupTrends & { note: string } {
  return {
    generatedAt: now.toISOString(),
    placementSeries: [],
    perProvider: [],
    ramp: [],
    signals: { bounces: 0, complaints: 0 },
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

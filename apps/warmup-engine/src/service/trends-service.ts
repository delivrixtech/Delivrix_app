// Servicio read-only de TENDENCIA del warmup para el dashboard (gaps v1). Ensambla la respuesta
// /v1/warmup/trends a partir de las stores: la serie global de placement, el desglose por proveedor
// de la ventana reciente, la curva de rampa de referencia y los conteos de señales.
//
// PURO respecto a `now` + las stores inyectadas (en tests se pasan stores fake). NO envía nada, NO
// escribe, NO depende del flag del engine (leer siempre se puede). Nunca lanza por datos vacíos:
// stores sin filas ⇒ arrays vacíos. La degradación por Postgres caído la maneja la ruta del gateway.

import { dailyQuota } from "../domain/ramp.ts";
import type { WarmupTrends, RampPoint } from "../domain/trends.ts";
import type { WarmupStores } from "../store/ports.ts";

const DEFAULT_SERIES_LIMIT = 30;
const DEFAULT_PROVIDER_WINDOW_DAYS = 7;
const DEFAULT_RAMP_DAYS = 30;
const SIGNALS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Nodo perfil de referencia para dibujar la curva de rampa "ideal" (§10). No es un nodo real: sirve
// para que el dashboard muestre la forma esperada (lineal, topada) contra la que comparar.
const RAMP_PROFILE = {
  dailyLimit: 50,
  increaseByDay: 2,
  weekdaysOnly: false
} as const;

export interface WarmupTrendsOptions {
  now: Date;
  /** Cuántas ventanas de la serie de placement traer (más nuevas primero, luego se invierte). */
  seriesLimit?: number;
  /** Ventana del desglose por proveedor, en días hacia atrás desde `now`. */
  providerWindowDays?: number;
  /** Cuántos días de la curva de rampa de referencia computar (día 1..N). */
  rampDays?: number;
}

/** Curva de rampa de referencia: cupo del día vs día, computado con dailyQuota sobre el perfil. */
function referenceRamp(rampDays: number): RampPoint[] {
  const ramp: RampPoint[] = [];
  for (let day = 1; day <= rampDays; day += 1) {
    const quota = dailyQuota(
      {
        dailyLimit: RAMP_PROFILE.dailyLimit,
        increaseByDay: RAMP_PROFILE.increaseByDay,
        dayIndex: day,
        weekdaysOnly: RAMP_PROFILE.weekdaysOnly
      },
      1 // isoWeekday: irrelevante con weekdaysOnly=false; lunes por convención.
    );
    ramp.push({ dayIndex: day, quota });
  }
  return ramp;
}

/**
 * Ensambla la tendencia del warmup para el panel. Read-only; nunca lanza por datos vacíos.
 */
export async function getWarmupTrends(
  stores: Pick<WarmupStores, "placement" | "signals">,
  opts: WarmupTrendsOptions
): Promise<WarmupTrends> {
  const seriesLimit = opts.seriesLimit ?? DEFAULT_SERIES_LIMIT;
  const providerWindowDays = opts.providerWindowDays ?? DEFAULT_PROVIDER_WINDOW_DAYS;
  const rampDays = opts.rampDays ?? DEFAULT_RAMP_DAYS;

  const providerSince = new Date(opts.now.getTime() - providerWindowDays * DAY_MS);
  const signalsSince = new Date(opts.now.getTime() - SIGNALS_WINDOW_DAYS * DAY_MS);

  // La store devuelve la serie más nueva primero (LIMIT); el dashboard la quiere cronológica.
  const recent = await stores.placement.listRecentRollups(seriesLimit);
  const placementSeries = recent.slice().reverse();

  const perProvider = await stores.placement.aggregateByProvider(providerSince);
  const signals = await stores.signals.countRecent(signalsSince);

  return {
    generatedAt: opts.now.toISOString(),
    placementSeries,
    perProvider,
    ramp: referenceRamp(rampDays),
    signals
  };
}

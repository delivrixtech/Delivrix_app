// Rampa de volumen por nodo (§2 "Increase by day" / "Daily warmup limit", §9 "Rampa lenta").
// Función PURA del estado del nodo + el día: sin side-effects, testeable exhaustivamente.

import type { WarmupNode } from "./types.ts";

/** ISO weekday: 1 = lunes … 7 = domingo. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

function isWeekend(isoWeekday: IsoWeekday): boolean {
  return isoWeekday === 6 || isoWeekday === 7;
}

/**
 * Cupo de warmup emails para HOY. Sube de a `increaseByDay` desde el día 1 y se topa en
 * `dailyLimit` (rampa lenta: el día 1 no arranca en el tope). `weekdaysOnly` manda 0 el fin de
 * semana. Robustez: normaliza valores negativos/no finitos a 0 y respeta el tope siempre.
 *
 * @param isoWeekday día de la semana del receptor (1=lun…7=dom). Requerido para `weekdaysOnly`.
 */
export function dailyQuota(
  node: Pick<WarmupNode, "dailyLimit" | "increaseByDay" | "dayIndex" | "weekdaysOnly">,
  isoWeekday: IsoWeekday
): number {
  if (node.weekdaysOnly && isWeekend(isoWeekday)) {
    return 0;
  }
  const limit = clampNonNegativeInt(node.dailyLimit);
  const step = clampNonNegativeInt(node.increaseByDay);
  // day_index 0 = recién onboardeado (aún sin arrancar); día 1 = primer envío = 1×step.
  const day = clampNonNegativeInt(node.dayIndex);
  if (day <= 0) return 0;
  const ramped = day * step;
  return Math.min(ramped, limit);
}

function clampNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

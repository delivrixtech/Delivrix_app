// Rampa de volumen por nodo — warmup v1 (§10). LINEAL + clamps duros. NADA de AIMD (eso es v2).
// Source of truth: Delivrix-Warmup-Diseno-v1.md §10.
//
//   cupo(día) = min( día × increaseByDay , dailyLimit )     ; día 0 = 0 (no arranca en el tope)
//   weekdaysOnly ⇒ 0 el fin de semana (isoWeekday 6/7)
//   clamps duros: (a) nunca >maxRampMultiplier48h× el cupo de hace 2 días
//                 (b) Gmail cuenta nueva < gmailNewAccountCap/día
//                 (c) techo del contrato de auth (sendingLimits.maxPerDay)
//
// Función PURA del estado del nodo + el día: sin side-effects, testeable exhaustivamente.

import type { WarmupNode } from "./types.ts";

/** ISO weekday: 1 = lunes … 7 = domingo. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface QuotaOptions {
  /**
   * Cupo del nodo hace 2 días. Clamp anti-firma §10: el cupo de hoy nunca crece más de
   * `maxRampMultiplier48h`× ese valor. Solo aplica si > 0 (no se puede multiplicar desde 0: al
   * arrancar la rampa lineal ya es suficientemente lenta).
   */
  quotaTwoDaysAgo?: number;
  /** Multiplicador máximo de crecimiento en 48h (§10: 3). Default 3. */
  maxRampMultiplier48h?: number;
  /**
   * Cap duro para cuenta Gmail nueva (§10: <50/día). Su presencia marca al nodo como Gmail nueva;
   * ausente ⇒ no aplica. Pasa `policy.gmailNewAccountDailyCap` aquí.
   */
  gmailNewAccountCap?: number;
  /** Techo del contrato de auth (`sendingLimits.maxPerDay`, §8) — clampa el cupo. */
  contractMaxPerDay?: number;
}

const DEFAULT_MAX_RAMP_MULTIPLIER_48H = 3;

function isWeekend(isoWeekday: IsoWeekday): boolean {
  return isoWeekday === 6 || isoWeekday === 7;
}

/** Normaliza a entero ≥0: negativos/NaN/no-finitos ⇒ 0. */
function clampNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Aplica un techo opcional. `undefined`/Infinity ⇒ sin techo (no clampa). Un techo negativo o NaN
 * clampa a 0 (fail-closed: un límite inválido no debe abrir el cupo). Si no, `min(quota, floor)`.
 */
function applyCeiling(quota: number, ceiling: number | undefined): number {
  if (ceiling === undefined) return quota;
  if (Number.isNaN(ceiling)) return quota;      // no es un límite real: se ignora
  if (!Number.isFinite(ceiling)) return quota;  // +Infinity ⇒ sin techo
  if (ceiling < 0) return 0;                     // límite inválido ⇒ fail-closed
  return Math.min(quota, Math.floor(ceiling));
}

/**
 * Cupo de warmup emails para HOY (§10). Rampa lineal desde el día 1 (`día × increaseByDay`), topada
 * en `dailyLimit`; el día 0 = 0 (recién onboardeado, no arranca en el tope). `weekdaysOnly` manda 0
 * el fin de semana. Sobre eso, los clamps duros de §10 (Gmail nueva, techo de contrato, 3×/48h).
 * Normaliza valores negativos/no-finitos a 0.
 *
 * @param isoWeekday día de la semana del receptor (1=lun…7=dom). Requerido para `weekdaysOnly`.
 */
export function dailyQuota(
  node: Pick<WarmupNode, "dailyLimit" | "increaseByDay" | "dayIndex" | "weekdaysOnly">,
  isoWeekday: IsoWeekday,
  opts: QuotaOptions = {}
): number {
  if (node.weekdaysOnly && isWeekend(isoWeekday)) {
    return 0;
  }

  const limit = clampNonNegativeInt(node.dailyLimit);
  const step = clampNonNegativeInt(node.increaseByDay);
  const day = clampNonNegativeInt(node.dayIndex);
  if (day <= 0) return 0; // día 0 = recién onboardeado, aún sin arrancar

  // Rampa lineal topada en el daily_limit.
  let quota = Math.min(day * step, limit);

  // (b) Gmail cuenta nueva: cap duro.
  quota = applyCeiling(quota, opts.gmailNewAccountCap);
  // (c) Techo del contrato de auth.
  quota = applyCeiling(quota, opts.contractMaxPerDay);
  // (a) Clamp 3×/48h respecto al cupo de hace 2 días (solo si ese cupo fue > 0).
  const twoDaysAgo = clampNonNegativeInt(opts.quotaTwoDaysAgo ?? 0);
  if (twoDaysAgo > 0) {
    const mult = opts.maxRampMultiplier48h ?? DEFAULT_MAX_RAMP_MULTIPLIER_48H;
    const safeMult = Number.isFinite(mult) && mult > 0 ? mult : DEFAULT_MAX_RAMP_MULTIPLIER_48H;
    quota = Math.min(quota, Math.floor(safeMult * twoDaysAgo));
  }

  return Math.max(0, quota);
}

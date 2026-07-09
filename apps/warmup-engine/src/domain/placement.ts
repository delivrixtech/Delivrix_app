// Harness de placement PURO (§9 "Medición de placement — el gate real").
// "El placement real gatea TODO": el score interno de heat miente (lección DFY), solo confío en la
// colocación medida contra seeds reales. Este módulo NO hace I/O: recibe filas ya leídas por el
// lector IMAP y produce el PlacementRollup (contrato con la FSM en node-state.ts).
//
// Reglas duras del §9 que ESTE harness materializa:
//  1. tabs cuenta como inbox        ⇒ inboxCount = primary + tabs.
//  2. MISSING ≠ SPAM                ⇒ missing es su bucket propio; no es inbox ni spam.
//  3. solo cuentan los LEÍDOS       ⇒ landedIn == null (grace window) no diluye ni infla.
//  4. gateo sobre el Wilson LOWER-BOUND (95%), no la proporción cruda (n chico no engaña).
//  5. EWMA para no oscilar          ⇒ el LB de la ventana se suaviza contra el EWMA previo.

import type { LandedIn, PlacementResultRow, PlacementRollup, SeedProvider } from "./types.ts";

/** z para el intervalo de Wilson al 95%. */
export const Z_95 = 1.96;

/** Factor de suavizado por defecto del EWMA (§9: "para no oscilar"). */
export const DEFAULT_EWMA_ALPHA = 0.3;

/**
 * Proveedores "mayores" para el gate "ningún proveedor mayor con LB < 0.60" (§9). GMX/Web.de son
 * seeds EU minoritarios (2 c/u) y NO bloquean la graduación por sí solos.
 */
export const MAJOR_PROVIDERS: ReadonlySet<SeedProvider> = new Set<SeedProvider>([
  "gmail",
  "workspace",
  "outlook",
  "m365",
  "yahoo"
]);

/** tabs cuenta como inbox (§9): Primary y Promotions/tabs ambos son "aterrizó en la bandeja". */
function isInbox(landedIn: LandedIn): boolean {
  return landedIn === "primary" || landedIn === "tabs";
}

/**
 * Lower bound del intervalo de proporción de Wilson (score interval) para `successes` de `n`.
 * Gateamos sobre este LB —no sobre successes/n— porque con n chico el LB penaliza la incertidumbre
 * (§9). Con n=0 no hay señal ⇒ undefined (no se castiga ni se premia a ciegas).
 */
export function wilsonLowerBound(successes: number, n: number, z: number = Z_95): number | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const s = Math.max(0, Math.min(successes, n));
  const phat = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  const lb = (center - margin) / denom;
  // Clamp defensivo a [0,1] por ruido de punto flotante en los extremos.
  return Math.min(1, Math.max(0, lb));
}

/**
 * Media móvil exponencial: suaviza `current` contra `prev` con factor `alpha` (§9, "no oscilar").
 * alpha alto = reacciona rápido; alpha bajo = memoria larga. Si no hay `prev` (primera ventana),
 * el EWMA arranca en `current`.
 */
export function ewma(prev: number | undefined, current: number, alpha: number = DEFAULT_EWMA_ALPHA): number {
  if (prev === undefined || !Number.isFinite(prev)) return current;
  return alpha * current + (1 - alpha) * prev;
}

/**
 * Peor Wilson-LB entre los proveedores MAYORES con muestras leídas (§9: para graduar, ninguno < 0.60).
 * Cada proveedor se evalúa con su propio n/LB. Si ningún proveedor mayor tiene muestras ⇒ undefined.
 */
export function worstMajorProviderLb(
  results: readonly PlacementResultRow[],
  z: number = Z_95
): number | undefined {
  const counts = new Map<SeedProvider, { inbox: number; n: number }>();
  for (const row of results) {
    if (row.landedIn == null) continue; // pendiente: no cuenta
    if (!MAJOR_PROVIDERS.has(row.seedProvider)) continue;
    const c = counts.get(row.seedProvider) ?? { inbox: 0, n: 0 };
    c.n += 1;
    if (isInbox(row.landedIn)) c.inbox += 1;
    counts.set(row.seedProvider, c);
  }
  let worst: number | undefined;
  for (const { inbox, n } of counts.values()) {
    const lb = wilsonLowerBound(inbox, n, z);
    if (lb === undefined) continue;
    worst = worst === undefined ? lb : Math.min(worst, lb);
  }
  return worst;
}

export interface ComputeRollupOptions {
  /** EWMA previo del nodo (ventana anterior); se suaviza contra el LB de esta ventana. */
  prevEwma?: number;
  /** z del intervalo de Wilson (default 95%). */
  z?: number;
  /** Factor de suavizado del EWMA (default 0.3). */
  alpha?: number;
  /**
   * Tasa de complaints observada en la ventana (para el auto-pause por complaints, §9). No se puede
   * derivar de los seeds (viene de la señal FBL/inbound), así que entra como dato externo.
   */
  complaintRate?: number;
}

/**
 * Computa el PlacementRollup de una ventana a partir de filas de seeds ya leídas (§9).
 *
 *  - samples       = filas con landedIn resuelto (los null del grace window NO cuentan, regla 3).
 *  - inboxCount    = primary + tabs (tabs cuenta como inbox, regla 1).
 *  - spamCount     = solo spam (missing NO, regla 2).
 *  - missingCount  = bucket propio (regla 2).
 *  - inboxWilsonLb = Wilson-LB 95% de inboxCount/samples (regla 4); undefined con samples=0.
 *  - inboxEwma     = LB suavizado contra prevEwma (regla 5); si no hay LB, arrastra prevEwma.
 *  - worstMajorProviderLb, complaintRate = campos de gate que consume la FSM.
 */
export function computeRollup(
  results: readonly PlacementResultRow[],
  opts: ComputeRollupOptions = {}
): PlacementRollup {
  const z = opts.z ?? Z_95;
  const alpha = opts.alpha ?? DEFAULT_EWMA_ALPHA;

  let inboxCount = 0;
  let spamCount = 0;
  let missingCount = 0;
  let samples = 0;

  for (const row of results) {
    if (row.landedIn == null) continue; // pendiente de lectura ⇒ no diluye
    samples += 1;
    switch (row.landedIn) {
      case "primary":
      case "tabs":
        inboxCount += 1;
        break;
      case "spam":
        spamCount += 1;
        break;
      case "missing":
        missingCount += 1;
        break;
    }
  }

  const inboxWilsonLb = wilsonLowerBound(inboxCount, samples, z);
  // Con LB definido: suaviza contra el previo. Sin LB (n=0): arrastra el EWMA previo (no inventa).
  const inboxEwma =
    inboxWilsonLb !== undefined ? ewma(opts.prevEwma, inboxWilsonLb, alpha) : opts.prevEwma;
  const worst = worstMajorProviderLb(results, z);

  const rollup: PlacementRollup = {
    samples,
    inboxCount,
    spamCount,
    missingCount
  };
  if (inboxWilsonLb !== undefined) rollup.inboxWilsonLb = inboxWilsonLb;
  if (inboxEwma !== undefined) rollup.inboxEwma = inboxEwma;
  if (worst !== undefined) rollup.worstMajorProviderLb = worst;
  if (opts.complaintRate !== undefined) rollup.complaintRate = opts.complaintRate;
  return rollup;
}

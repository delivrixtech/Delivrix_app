// Placement real desde seed_checks (§6). "El placement real gatea TODO" — el score interno miente
// (lección DFY). Funciones puras: computan el % de inbox real y los gates que dependen de él.

import type { SeedCheck, WarmupPolicy } from "./types.ts";

export interface PlacementResult {
  /** Correos medidos (con landedIn resuelto; los pendientes no cuentan). */
  measured: number;
  /** Cayeron en Primary. */
  inbox: number;
  /** Cayeron en Promotions (no es spam, pero tampoco Primary). */
  promotions: number;
  /** Cayeron en Spam. */
  spam: number;
  /** No llegaron. */
  missing: number;
  /** Fracción [0..1] que cayó en Primary sobre lo medido. undefined si no hay medidas. */
  inboxRate?: number;
}

/**
 * Colocación de un nodo a partir de sus seed_checks. Solo cuenta checks ya LEÍDOS por el lector
 * IMAP (`landedIn != null`); los pendientes no diluyen ni inflan el score. `inboxRate` = Primary /
 * medidos (Promotions NO cuenta como inbox: para warmup, Promotions ya es una señal degradada).
 */
export function computePlacement(seedChecks: readonly SeedCheck[]): PlacementResult {
  let inbox = 0;
  let promotions = 0;
  let spam = 0;
  let missing = 0;
  for (const check of seedChecks) {
    switch (check.landedIn) {
      case "primary": inbox += 1; break;
      case "promotions": promotions += 1; break;
      case "spam": spam += 1; break;
      case "missing": missing += 1; break;
      default: break; // null => pendiente de lectura, no cuenta
    }
  }
  const measured = inbox + promotions + spam + missing;
  return {
    measured,
    inbox,
    promotions,
    spam,
    missing,
    ...(measured > 0 ? { inboxRate: inbox / measured } : {})
  };
}

/** true si el placement medido alcanza el mínimo de inbox de la política (gate FRESH→WARM). */
export function placementMeetsBar(result: PlacementResult, policy: WarmupPolicy): boolean {
  return result.inboxRate !== undefined && result.inboxRate >= policy.minInboxPlacement;
}

/**
 * true si el placement cayó por debajo del umbral y el nodo debe auto-pausarse (§6). Requiere
 * evidencia medida: sin medidas NO se pausa (no hay señal, no se castiga a ciegas).
 */
export function shouldAutoPause(result: PlacementResult, policy: WarmupPolicy): boolean {
  return result.inboxRate !== undefined && result.inboxRate < policy.minInboxPlacement;
}

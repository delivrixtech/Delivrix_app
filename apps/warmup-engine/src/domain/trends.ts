// Contratos de tendencia y destinatarios engaged (gaps v1). Compartidos entre el engine, el
// gateway y el panel: son la forma de la respuesta de /v1/warmup/trends y del provider A+B.
// Source of truth: Delivrix-Warmup-Diseno-v1.md §5 (engaged), §9 (placement), §10 (rampa).

import type { LandedIn, SeedProvider } from "./types.ts";

// --- Destinatarios engaged (estrategia A+B) ---

/** Un destinatario real que abre/responde (seed o lista curada). */
export interface EngagedRecipient {
  address: string;
  /** "seed" | "curated" — de dónde salió (para no confundir medición con volumen). */
  source: "seed" | "curated";
  weight: number;
}

/**
 * Fuente de destinatarios para el scheduler (reemplaza el pickRecipient inyectado a mano). A+B:
 * combina los seed inboxes (para medir) con la lista curada de engaged (para volumen real). Puro:
 * recibe los conjuntos ya leídos de las stores.
 */
export interface RecipientPool {
  /** Elige el destinatario del envío #index del nodo, determinista por (nodeId, index). */
  pick(nodeId: string, index: number): EngagedRecipient | undefined;
  /** Cap de seeds ≤10% del volumen (§9): cuántos de `count` deberían ser seeds. */
  seedQuota(count: number): number;
}

// --- Tendencia / serie temporal (para el dashboard: tendencia + por-proveedor + rampa) ---

/** Un punto de la serie de placement de una ventana (del rollup). */
export interface PlacementTrendPoint {
  windowEnd: string;          // ISO date
  inboxWilsonLb?: number;     // lower bound de Wilson [0..1]
  inboxEwma?: number;
  spamRate?: number;          // spam / samples
  samples: number;
}

/** Agregado de colocación por proveedor sobre la ventana reciente (§9: tabs=inbox, missing≠spam). */
export interface ProviderPlacement {
  provider: SeedProvider;
  inbox: number;              // primary + tabs
  tabs: number;
  spam: number;
  missing: number;
  total: number;
  inboxRate?: number;         // inbox / total
}

/** Punto de la curva de rampa (cupo del día vs día), computado con dailyQuota. */
export interface RampPoint {
  dayIndex: number;
  quota: number;
}

/** Respuesta de /v1/warmup/trends — lo que consume el dashboard. */
export interface WarmupTrends {
  generatedAt: string;
  /** Serie global de placement (últimas N ventanas). */
  placementSeries: PlacementTrendPoint[];
  /** Desglose por proveedor de la ventana reciente. */
  perProvider: ProviderPlacement[];
  /** Curva de rampa de referencia (perfil por defecto). */
  ramp: RampPoint[];
  /** Conteos recientes de señales (bounces/complaints). */
  signals: { bounces: number; complaints: number };
}

/** Mapea un LandedIn al bucket de inbox/tabs/spam/missing (tabs cuenta como inbox aguas arriba). */
export function bucketOfLanded(landed: LandedIn): "inbox" | "tabs" | "spam" | "missing" {
  if (landed === "primary") return "inbox";
  if (landed === "tabs") return "tabs";
  if (landed === "spam") return "spam";
  return "missing";
}

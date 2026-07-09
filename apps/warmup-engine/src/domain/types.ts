// Núcleo determinista del warmup — tipos y constantes de política.
// Source of truth: Delivrix-Warmup-Diseno-v1.md (§2 defaults, §4 mesh, §6 placement, §102 estados).
// Este módulo NO hace I/O: solo modela el estado y las decisiones puras del mesh.

export type NodeState = "fresh" | "warming" | "warm" | "paused";

/** ESP que el nodo emula/reporta; el placement se mide por proveedor destino real. */
export type Esp = "gmail" | "outlook" | "yahoo" | "generic";

/** Dónde cayó un correo medido contra un seed inbox real. `missing` = no llegó. */
export type LandedIn = "primary" | "promotions" | "spam" | "missing";

export interface WarmupNode {
  id: string;
  mailbox: string;
  domain: string;
  esp: Esp;
  state: NodeState;
  /** Tope de warmup emails/día (§2: 10 para cuenta nueva). */
  dailyLimit: number;
  /** Rampa: +N por día hasta dailyLimit (§2: increase_by_day = 1). */
  increaseByDay: number;
  /** Días dentro del ciclo de warmup (0 = recién onboardeado). */
  dayIndex: number;
  /** Solo días hábiles: patrón más natural (§2). */
  weekdaysOnly: boolean;
  /** % interno de warmup que llegó a inbox vs spam (7d). NO es placement real. */
  healthScore?: number;
  /** % inbox REAL medido contra seed inboxes. Gatea FRESH→WARM y auto-pause (§6). */
  placementScore?: number;
}

/** Un par del mesh: from_node escribe a to_node dentro de un hilo. */
export interface WarmupPairing {
  fromNode: string;
  toNode: string;
  /** Momento del envío (o programado). Se usa para "no repetir par el mismo día". */
  sentAt: Date;
}

/** Registro de colocación contra un seed inbox real. */
export interface SeedCheck {
  nodeId: string;
  seedInbox: string;
  sentAt: Date;
  /** null = enviado pero aún no leído por el lector IMAP. */
  landedIn: LandedIn | null;
}

/**
 * Política del mesh. Los defaults salen del doc; se exponen como parámetros para poder
 * afinarlos por cohorte/ESP sin tocar la lógica.
 */
export interface WarmupPolicy {
  /** Tope de frescos como fracción del mesh activo (§4/§9: 30–40 %). Default conservador 0.4. */
  maxFreshFraction: number;
  /** % inbox mínimo para considerar el placement "ok" (§6: auto-pause bajo ~80 %). */
  minInboxPlacement: number;
  /** health_score mínimo para salir de warmup (§2: >90 %). */
  minHealthScore: number;
  /** Días mínimos en WARMING antes de poder pasar a WARM (§2/§102: 3–4 semanas). */
  minWarmingDays: number;
  /** Fracción de tráfico warmup que un nodo WARM mantiene para no enfriarse (§4/§9: 5–10 %). */
  maintenanceFraction: number;
}

export const DEFAULT_WARMUP_POLICY: WarmupPolicy = {
  maxFreshFraction: 0.4,
  minInboxPlacement: 0.8,
  minHealthScore: 0.9,
  minWarmingDays: 21,
  maintenanceFraction: 0.1
};

/** Defaults de rampa para un buzón nuevo (§2). */
export const DEFAULT_DAILY_LIMIT = 10;
export const DEFAULT_INCREASE_BY_DAY = 1;

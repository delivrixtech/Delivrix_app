// Núcleo determinista del warmup v1 — tipos y constantes de política.
// Source of truth: Delivrix-Warmup-Diseno-v1.md.
// v1 = Postfix-only, Track A (transaccional). SIN mesh, SIN AI: se calienta con tráfico real +
// medición de placement, gateado por auth. Este módulo NO hace I/O: solo estado y decisiones puras.

/**
 * Estados de un nodo (§8 auth-gate + §9 FSM de placement):
 *  blocked      — default-deny: sin contrato de auth `ready` no envía ni seeds.
 *  fresh        — auth ok, calentando (rampa lineal), aún no graduado por placement.
 *  warm         — placement sostenido sobre la barra (Wilson-LB ≥ 0.80).
 *  paused       — auto-pausado por placement/spam/complaints (§9).
 *  quarantined  — un check de auth continuo regresó en un nodo vivo (§8) → pausa todo → blocked.
 */
export type NodeState = "blocked" | "fresh" | "warm" | "paused" | "quarantined";

/** Transporte del nodo. v1 solo Postfix; hosted (m365) es v2, el tipo queda pluggable desde ya. */
export type InfraType = "postfix" | "m365";

/** Proveedor destino real donde se mide placement (los seeds cubren estos). */
export type SeedProvider = "gmail" | "workspace" | "outlook" | "m365" | "yahoo" | "gmx" | "webde";

/** Dónde cayó un correo medido contra un seed inbox real (§9). `missing` ≠ `spam` (bucket propio). */
export type LandedIn = "primary" | "tabs" | "spam" | "missing";

export interface WarmupNode {
  id: string;
  mailbox: string;
  domain: string;
  infraType: InfraType;
  state: NodeState;
  /** true si el contrato de auth está `ready` y vigente (gate fail-closed, §8). */
  authReady: boolean;
  /** Expiración del contrato de auth (TTL corto). Vencido ⇒ authReady debe tratarse como false. */
  contractExpiresAt?: Date;
  /** IP saliente del nodo (self-hosted): la reputación es de esta IP + dominio (§4). */
  sendingIp?: string;
  heloFqdn?: string;
  /** Tope de warmup emails/día (§10: 10 para cuenta nueva). */
  dailyLimit: number;
  /** Rampa: +N por día (§10: increase_by_day = 1). */
  increaseByDay: number;
  /** Días dentro del ciclo de warmup (0 = recién onboardeado). */
  dayIndex: number;
  weekdaysOnly: boolean;
  /** % interno de "heat" (diagnóstico). NO gatea nada — el gate es placement (§3). */
  healthScore?: number;
  /** Placement real (Wilson-LB de inbox). Gatea FRESH→WARM y auto-pause (§9). */
  placementScore?: number;
}

/**
 * Contrato de readiness firmado que devuelve el servicio de auth externo (§8). Fuente de verdad
 * del gate fail-closed: si falta, expiró, la firma no valida, o algún check bloqueante no está en
 * `pass`, el nodo queda BLOCKED. `sendingLimits` CLAMPA el techo de la rampa.
 */
export interface AuthReadinessContract {
  nodeId: string;
  /** Resultado por check (p.ej. SPF_PASS, DKIM_ALIGN, PTR_FCRDNS, IP_NOT_BLOCKLISTED…). */
  checks: Record<string, "pass" | "fail" | "unknown">;
  signature: string;
  issuedAt: Date;
  expiresAt: Date;
  /** Techo de envío autorizado (clampa la rampa). */
  sendingLimits?: { maxPerDay?: number };
}

/** Un envío de warmup (unidad de idempotencia + DLQ, §12). */
export interface WarmupSend {
  nodeId: string;
  /** Clave idempotente por slot (exactly-once por slot programado). */
  slotKey: string;
  toAddress: string;
  sentAt?: Date;
  status: "queued" | "sent" | "bounced" | "failed" | "dead_lettered";
}

/** Inyección de un seed (destinatario extra dentro de la rotación normal, §9). */
export interface PlacementTest {
  nodeId: string;
  seedProvider: SeedProvider;
  seedInbox: string;
  /** Header oculto X-Delivrix-Test-Id + token en body como fallback. */
  testId: string;
  sentAt: Date;
}

/** Resultado de un seed ya leído por el lector IMAP (§9). null = pendiente dentro del grace window. */
export interface PlacementResultRow {
  testId: string;
  nodeId: string;
  seedProvider: SeedProvider;
  landedIn: LandedIn | null;
  readAt?: Date;
}

/**
 * Rollup de placement de un nodo sobre una ventana (§9). Es el CONTRATO entre el harness de
 * placement (que lo computa: Wilson-LB + EWMA) y la FSM de estados (que lo consume para promover/
 * pausar). `inboxCount` = primary + tabs (tabs cuenta como inbox, §9); `missing` es su bucket propio.
 */
export interface PlacementRollup {
  samples: number;
  inboxCount: number;
  spamCount: number;
  missingCount: number;
  /** Lower bound del intervalo de Wilson (95%). undefined si no hay muestras. */
  inboxWilsonLb?: number;
  inboxEwma?: number;
  /** Peor lower-bound entre proveedores mayores (gate: ninguno < 0.60 para graduar, §9). */
  worstMajorProviderLb?: number;
  /** Tasa de complaints observada en la ventana (para el auto-pause por complaints). */
  complaintRate?: number;
}

/**
 * Política v1. Los umbrales salen del §9/§10 del doc; se exponen como parámetros para afinarlos por
 * cohorte/ESP sin tocar la lógica pura.
 */
export interface WarmupPolicy {
  // --- Placement gate (§9) ---
  /** Wilson lower-bound de inbox para graduar FRESH→WARM. */
  promoteInboxLowerBound: number;   // 0.80
  /** Días sostenidos sobre la barra para graduar. */
  promoteSustainDays: number;       // 5
  /** n mínimo de medidas para confiar en el LB. */
  promoteMinSamples: number;        // 20
  /** spam máximo tolerado para graduar. */
  promoteMaxSpam: number;           // 0.02
  /** inbox_rate puntual por debajo del cual se auto-pausa. */
  pauseInboxRate: number;           // 0.70
  /** spam por encima del cual se auto-pausa. */
  pauseSpamRate: number;            // 0.05
  /** complaint por encima del cual se auto-pausa. */
  pauseComplaintRate: number;       // 0.003
  // --- Rampa (§10) ---
  /** Factor máximo de crecimiento en 48h (clamp anti-firma). */
  maxRampMultiplier48h: number;     // 3
  /** Techo duro para cuentas nuevas en Gmail. */
  gmailNewAccountDailyCap: number;  // 50
}

export const DEFAULT_WARMUP_POLICY: WarmupPolicy = {
  promoteInboxLowerBound: 0.8,
  promoteSustainDays: 5,
  promoteMinSamples: 20,
  promoteMaxSpam: 0.02,
  pauseInboxRate: 0.7,
  pauseSpamRate: 0.05,
  pauseComplaintRate: 0.003,
  maxRampMultiplier48h: 3,
  gmailNewAccountDailyCap: 50
};

/** Defaults de rampa para un buzón nuevo (§10). */
export const DEFAULT_DAILY_LIMIT = 10;
export const DEFAULT_INCREASE_BY_DAY = 1;

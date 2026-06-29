/**
 * Warmup Ramp Plan — curvas de calentamiento gradual para dominios sender.
 *
 * El sistema de ramp ejecuta lotes (batches) de emails seed espaciados en el
 * tiempo. La curva `demo-fast` está pensada para la demo del viernes:
 * 5 batches separados 2 min, factor 3x, capando a ~270 emails totales.
 *
 * Si la tasa de rebote en cualquier batch supera `BOUNCE_RATE_AUTO_PAUSE`,
 * el scheduler hace auto-pausa y emite `oc.warmup.ramp_paused` con
 * `pauseReason = "auto_bounce_rate"`.
 *
 * Diseñado para ser determinístico: dada una curva + un timestamp inicial,
 * los timestamps `scheduledAt` de cada batch son reproducibles.
 */

/**
 * Umbral de tasa de rebote que dispara auto-pausa del ramp.
 * 5% es el límite que recomiendan ESPs (Gmail/Outlook) antes de quemar IP.
 */
export const BOUNCE_RATE_AUTO_PAUSE = 0.05;

/**
 * Umbral mínimo de delivery rate aceptable. Por debajo de esto se
 * considera un batch "fallido" aunque no haya rebotes (puede ser silent drop).
 */
export const DELIVERY_RATE_FLOOR = 0.85;

/**
 * Identificador de la curva del ramp.
 *
 * - `demo-fast`: 5 batches en 8 min, total ≤270, factor 3x. Solo demo.
 * - `production-14d`: 14 batches diarios con factor variable hacia escala real.
 */
export type WarmupRampSchedule = "demo-fast" | "production-14d";

/**
 * Definición pura de un batch dentro de una curva: cuántos emails y a qué
 * offset desde t=0 debe correr. `scheduledAt` se calcula al instanciar el ramp.
 */
export interface WarmupRampBatchPlan {
  readonly batchIndex: number;
  readonly offsetMs: number;
  readonly emailCount: number;
}

/**
 * Curva completa: lista ordenada de batches + metadatos.
 */
export interface WarmupRampPlan {
  readonly schedule: WarmupRampSchedule;
  readonly description: string;
  readonly batches: readonly WarmupRampBatchPlan[];
  readonly totalEmails: number;
  readonly recipientPoolMin: number;
}

/**
 * Estado runtime de un batch ya planificado (o ya ejecutado).
 */
export interface WarmupRampBatch {
  batchIndex: number;
  scheduledAt: string;
  emailCount: number;
  status: "pending" | "running" | "sent" | "failed";
  startedAt?: string;
  completedAt?: string;
  sentCount?: number;
  bouncedCount?: number;
  deliveryRate?: number;
  bounceRate?: number;
  error?: string;
}

/**
 * Estado top-level del ramp. Vive en `warmup-progress.json` bajo `ramps[]`.
 */
export type WarmupRampState =
  | "running"
  | "paused"
  | "auto_paused"
  | "completed"
  | "failed";

/**
 * Razón por la cual el ramp está pausado. Solo presente si `state` ∈ {`paused`, `auto_paused`}.
 */
export type WarmupRampPauseReason =
  | "manual"
  | "auto_bounce_rate"
  | "auto_spam_rate"
  | "auto_placement"
  | "auto_delivery_floor"
  | "send_failed";

const DEMO_FAST_BATCHES: readonly WarmupRampBatchPlan[] = [
  { batchIndex: 0, offsetMs: 0, emailCount: 3 },
  { batchIndex: 1, offsetMs: 2 * 60_000, emailCount: 9 },
  { batchIndex: 2, offsetMs: 4 * 60_000, emailCount: 27 },
  { batchIndex: 3, offsetMs: 6 * 60_000, emailCount: 81 },
  { batchIndex: 4, offsetMs: 8 * 60_000, emailCount: 150 }
];

const PRODUCTION_14D_BATCHES: readonly WarmupRampBatchPlan[] = [
  { batchIndex: 0, offsetMs: 0, emailCount: 50 },
  { batchIndex: 1, offsetMs: 1 * 86_400_000, emailCount: 100 },
  { batchIndex: 2, offsetMs: 2 * 86_400_000, emailCount: 200 },
  { batchIndex: 3, offsetMs: 3 * 86_400_000, emailCount: 400 },
  { batchIndex: 4, offsetMs: 4 * 86_400_000, emailCount: 800 },
  { batchIndex: 5, offsetMs: 5 * 86_400_000, emailCount: 1_500 },
  { batchIndex: 6, offsetMs: 6 * 86_400_000, emailCount: 3_000 },
  { batchIndex: 7, offsetMs: 7 * 86_400_000, emailCount: 5_000 },
  { batchIndex: 8, offsetMs: 8 * 86_400_000, emailCount: 7_500 },
  { batchIndex: 9, offsetMs: 9 * 86_400_000, emailCount: 10_000 },
  { batchIndex: 10, offsetMs: 10 * 86_400_000, emailCount: 15_000 },
  { batchIndex: 11, offsetMs: 11 * 86_400_000, emailCount: 20_000 },
  { batchIndex: 12, offsetMs: 12 * 86_400_000, emailCount: 30_000 },
  { batchIndex: 13, offsetMs: 13 * 86_400_000, emailCount: 50_000 }
];

const PLANS: Readonly<Record<WarmupRampSchedule, WarmupRampPlan>> = {
  "demo-fast": {
    schedule: "demo-fast",
    description:
      "5 batches @ 2 min apart, factor 3×, cap ~270 emails. Demo solamente.",
    batches: DEMO_FAST_BATCHES,
    totalEmails: DEMO_FAST_BATCHES.reduce((sum, b) => sum + b.emailCount, 0),
    recipientPoolMin: 3
  },
  "production-14d": {
    schedule: "production-14d",
    description: "14 batches diarios, factor variable hacia escala real.",
    batches: PRODUCTION_14D_BATCHES,
    totalEmails: PRODUCTION_14D_BATCHES.reduce(
      (sum, b) => sum + b.emailCount,
      0
    ),
    recipientPoolMin: 50
  }
};

export function getWarmupRampPlan(
  schedule: WarmupRampSchedule
): WarmupRampPlan {
  return PLANS[schedule];
}

export function isWarmupRampSchedule(
  value: unknown
): value is WarmupRampSchedule {
  return value === "demo-fast" || value === "production-14d";
}

/**
 * Genera los batches concretos con timestamps absolutos a partir de un
 * timestamp inicial `startAt`. Útil para persistir el plan completo al
 * iniciar un ramp y luego reanudarlo sin recalcular.
 */
export function materializeRampBatches(input: {
  schedule: WarmupRampSchedule;
  startAt: Date;
}): WarmupRampBatch[] {
  const plan = getWarmupRampPlan(input.schedule);
  return plan.batches.map((batch) => ({
    batchIndex: batch.batchIndex,
    scheduledAt: new Date(input.startAt.getTime() + batch.offsetMs).toISOString(),
    emailCount: batch.emailCount,
    status: "pending"
  }));
}

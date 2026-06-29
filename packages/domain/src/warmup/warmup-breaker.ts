// Warmup circuit-breaker — Track W / W3: "auto-pausa por placement/spam, no solo
// bounce".
//
// Today the ramp scheduler only auto-pauses on bounce rate (bounceRate > 0.05).
// But a domain can have ~0 bounces and still be burning reputation: recipients
// marking spam (complaint rate) or mail landing in the Spam folder (placement).
// This pure decision function weighs all three signals and returns
// continue / throttle / pause, so the scheduler can close the loop with the
// placement-check skill (which already measures inbox vs spam from seed inboxes).
//
// Pure + side-effect free: feed it metrics, get a decision. No I/O, no infra.

export type WarmupBreakerReason =
  | "auto_bounce_rate"
  | "auto_spam_rate"
  | "auto_placement";

export type WarmupBreakerAction = "continue" | "throttle" | "pause";

export interface WarmupBreakerMetrics {
  /** Emails sent in the window under evaluation. */
  sent: number;
  /** Hard/soft bounces in the window. */
  bounced: number;
  /** Spam complaints (FBL) in the window, if known. */
  complaints?: number;
  /** Seed inboxes that landed in the Inbox (from placement-check), if measured. */
  seedInbox?: number;
  /** Seed inboxes that landed in Spam (from placement-check), if measured. */
  seedSpam?: number;
}

export interface WarmupBreakerThresholds {
  /** Pause above this bounce rate. Default 0.05 (matches BOUNCE_RATE_AUTO_PAUSE). */
  bounceRate: number;
  /** Pause above this spam-complaint rate. Default 0.003 (0.30%). */
  spamRate: number;
  /** Pause when inbox placement drops below this floor. Default 0.80. */
  placementFloor: number;
  /** Throttle (don't pause) while placement is within this band above the floor. Default 0.10. */
  placementWarnBand: number;
  /** Ignore placement until at least this many seed inboxes were measured. Default 5. */
  minPlacementSamples: number;
}

export const DEFAULT_WARMUP_BREAKER_THRESHOLDS: WarmupBreakerThresholds = {
  bounceRate: 0.05,
  spamRate: 0.003,
  placementFloor: 0.8,
  placementWarnBand: 0.1,
  minPlacementSamples: 5
};

export interface WarmupBreakerDecision {
  action: WarmupBreakerAction;
  reason?: WarmupBreakerReason;
  metrics: {
    bounceRate: number;
    spamRate: number;
    /** Inbox fraction of seed placement, or null when not enough samples. */
    placementRate: number | null;
    placementSamples: number;
  };
  detail: string;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Decide whether a warmup ramp should continue, throttle, or pause, weighing
 * bounce rate, spam-complaint rate, and seed-inbox placement. Pause reasons are
 * ordered by severity (bounce → spam → placement); placement also has a
 * "throttle" warning band so a slipping domain slows down before it has to stop.
 */
export function evaluateWarmupBreaker(
  metrics: WarmupBreakerMetrics,
  thresholds: Partial<WarmupBreakerThresholds> = {}
): WarmupBreakerDecision {
  const limits = { ...DEFAULT_WARMUP_BREAKER_THRESHOLDS, ...thresholds };
  const sent = Math.max(0, metrics.sent);
  const bounceRate = rate(Math.max(0, metrics.bounced), sent);
  const spamRate = rate(Math.max(0, metrics.complaints ?? 0), sent);

  const seedInbox = Math.max(0, metrics.seedInbox ?? 0);
  const seedSpam = Math.max(0, metrics.seedSpam ?? 0);
  const placementSamples = seedInbox + seedSpam;
  const hasPlacement = placementSamples >= limits.minPlacementSamples;
  const placementRate = hasPlacement ? rate(seedInbox, placementSamples) : null;

  const summaryMetrics = { bounceRate, spamRate, placementRate, placementSamples };

  if (sent > 0 && bounceRate > limits.bounceRate) {
    return {
      action: "pause",
      reason: "auto_bounce_rate",
      metrics: summaryMetrics,
      detail: `bounce ${pct(bounceRate)} > umbral ${pct(limits.bounceRate)} → pausa`
    };
  }

  if (sent > 0 && spamRate > limits.spamRate) {
    return {
      action: "pause",
      reason: "auto_spam_rate",
      metrics: summaryMetrics,
      detail: `quejas spam ${pct(spamRate)} > umbral ${pct(limits.spamRate)} → pausa (no es bounce)`
    };
  }

  if (placementRate !== null && placementRate < limits.placementFloor) {
    return {
      action: "pause",
      reason: "auto_placement",
      metrics: summaryMetrics,
      detail: `placement inbox ${pct(placementRate)} < piso ${pct(limits.placementFloor)} → pausa (cae en Spam)`
    };
  }

  if (placementRate !== null && placementRate < limits.placementFloor + limits.placementWarnBand) {
    return {
      action: "throttle",
      metrics: summaryMetrics,
      detail: `placement inbox ${pct(placementRate)} cerca del piso ${pct(limits.placementFloor)} → throttle (bajar pendiente, no pausar)`
    };
  }

  return {
    action: "continue",
    metrics: summaryMetrics,
    detail: placementRate === null
      ? `bounce ${pct(bounceRate)}, spam ${pct(spamRate)} OK; placement sin muestra suficiente → continuar`
      : `bounce ${pct(bounceRate)}, spam ${pct(spamRate)}, placement ${pct(placementRate)} OK → continuar`
  };
}

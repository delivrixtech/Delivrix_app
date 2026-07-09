// FSM de estados por nodo — warmup v1 (§8 auth-gate + §9 tabla de transiciones).
// Source of truth: Delivrix-Warmup-Diseno-v1.md.
//
//   ┌────────── §8 auth-gate (fail-closed, precede a TODO) ──────────┐
//   │  blocked  ◀── !authReady (default-deny, desde cualquier estado) │
//   │  quarantined ◀── check continuo regresado en nodo vivo ──▶ blocked
//   │  (recuperación: 2 ciclos limpios + contrato fresco ⇒ fresh)     │
//   └────────────────────────────────────────────────────────────────┘
//   §9 placement-gate (solo con auth vigente):
//   fresh ──(LB≥0.80 5d, n≥20, spam≤2%, ningún proveedor mayor LB<0.60)──▶ warm
//   fresh/warm ──(inbox<0.70 2d | spam>5% 2d | proveedor spam>10% | complaint>0.3%)──▶ paused
//   paused ──(cooldown≥48h + LB≥0.80 3d)──▶ fresh (re-warm al 50%, lo aplica la rampa)
//
// Función PURA: consume el PlacementRollup ya computado (Wilson-LB/EWMA los calcula el harness,
// NO este módulo) + señales de auth y decide el próximo estado con un motivo tipado. Cero I/O.

import type { NodeState, PlacementRollup, WarmupNode, WarmupPolicy } from "./types.ts";

/** Motivos tipados de cada transición (o de la no-transición: `unchanged`). */
export type TransitionReason =
  | "unchanged"
  | "blocked_auth_not_ready"        // §8: contrato no `ready`/vigente ⇒ default-deny
  | "quarantined_check_regressed"   // §8: check continuo regresó en nodo vivo ⇒ pausa todo
  | "graduated_to_warm"             // §9: fresh → warm (placement sostenido sobre la barra)
  | "auto_paused_low_placement"     // §9: inbox puntual < pauseInboxRate por 2 días
  | "auto_paused_high_spam"         // §9: spam > pauseSpamRate por 2 días, o proveedor spam >10%
  | "auto_paused_complaints"        // §9: complaint > pauseComplaintRate
  | "resumed_rewarm";               // §9/§8: paused/blocked/quarantined → fresh (re-warm)

export interface TransitionResult {
  nextState: NodeState;
  reason: TransitionReason;
}

export interface TransitionInput {
  node: Pick<WarmupNode, "state">;
  /** Rollup de placement ya computado por el harness (contrato de types.ts, NO de placement.ts). */
  rollup: PlacementRollup;
  /** true si el contrato de auth está `ready` y vigente (firma válida + no expirado, §8). */
  authReady: boolean;
  /**
   * true si un check de auth continuo (bloqueante) que estaba en `pass` regresó a `fail` en un nodo
   * vivo (§8). Dispara QUARANTINED (pausa todo, incl. seeds) antes de caer a BLOCKED.
   */
  authCheckRegressed?: boolean;
  /** Ciclos de auth consecutivos limpios (histéresis §8: ≥2 + contrato fresco recupera a fresh). */
  cleanAuthCycles?: number;
  /** Días consecutivos con Wilson-LB sobre la barra (graduación §9 y re-warm). */
  sustainedDaysOverBar?: number;
  /** Días consecutivos con inbox_rate puntual < pauseInboxRate (auto-pause §9). */
  lowInboxDays?: number;
  /** Días consecutivos con spamRate > pauseSpamRate (auto-pause §9). */
  highSpamDays?: number;
  /** Horas transcurridas en pausa (cooldown de re-warm ≥48h, §9). */
  pausedHours?: number;
  /** Peor tasa de spam observada en un proveedor mayor (auto-pause si > 10%, §9). */
  worstProviderSpamRate?: number;
  policy: WarmupPolicy;
}

// Constantes del doc que NO viven en WarmupPolicy (§9/§8), fijadas aquí como umbrales de v1.
/** Ningún proveedor mayor puede tener Wilson-LB < 0.60 para graduar (§9). */
const MAJOR_PROVIDER_MIN_LB = 0.6;
/** Un proveedor con spam > 10% dispara auto-pause (§9). */
const PROVIDER_SPAM_PAUSE_RATE = 0.1;
/** Días sostenidos con inbox<0.70 o spam>5% que confirman el auto-pause (§9). */
const PAUSE_SUSTAIN_DAYS = 2;
/** Cooldown mínimo de pausa antes de re-warm (§9). */
const REWARM_COOLDOWN_HOURS = 48;
/** Días con LB≥0.80 exigidos para salir de pausa (§9). */
const REWARM_SUSTAIN_DAYS = 3;
/** Ciclos limpios de histéresis para recuperar desde blocked/quarantined (§8). */
const AUTH_RECOVERY_CLEAN_CYCLES = 2;

function isLive(state: NodeState): boolean {
  return state === "fresh" || state === "warm" || state === "paused";
}

function spamRate(rollup: PlacementRollup): number {
  return rollup.samples > 0 ? rollup.spamCount / rollup.samples : 0;
}

/**
 * Decisión pura del próximo estado. Precedencia:
 *  1. §8 auth-gate (fail-closed): regresión → quarantine; contrato caído → blocked; recuperación con
 *     histéresis → fresh. Manda sobre placement siempre.
 *  2. §9 placement-gate (solo con auth vigente): auto-pause (prioridad) → graduación → re-warm.
 * Sin evidencia (samples=0 / rollup vacío) NO promueve ni pausa a ciegas (salvo el gate de auth).
 */
export function nextNodeState(input: TransitionInput): TransitionResult {
  const { node, rollup, policy } = input;
  const state = node.state;

  // ── §8 auth-gate: precede a todo ────────────────────────────────────────────────────────────
  // (1a) Un check continuo bloqueante que regresa en un nodo vivo → cuarentena (pausa todo, seeds
  //      incluidos) ANTES de bloquear.
  if (isLive(state) && (input.authCheckRegressed ?? false)) {
    return { nextState: "quarantined", reason: "quarantined_check_regressed" };
  }
  // (1b) Contrato no `ready`/vigente → default-deny BLOCKED desde cualquier estado. También lleva
  //      quarantined → blocked (un nodo en cuarentena sin contrato vigente cae a blocked).
  if (!input.authReady) {
    if (state === "blocked") return { nextState: "blocked", reason: "unchanged" };
    return { nextState: "blocked", reason: "blocked_auth_not_ready" };
  }
  // (1c) authReady === true. Recuperación desde blocked/quarantined con histéresis (§8).
  if (state === "blocked" || state === "quarantined") {
    if ((input.cleanAuthCycles ?? 0) >= AUTH_RECOVERY_CLEAN_CYCLES) {
      return { nextState: "fresh", reason: "resumed_rewarm" };
    }
    return { nextState: state, reason: "unchanged" };
  }

  // ── §9 placement-gate: solo estados vivos con auth vigente ───────────────────────────────────
  // Auto-pause tiene prioridad sobre graduar (fresh/warm envían de verdad durante el warmup).
  if (state === "fresh" || state === "warm") {
    const paused = evaluateAutoPause(input);
    if (paused) return paused;
  }

  switch (state) {
    case "fresh":
      return meetsGraduation(input)
        ? { nextState: "warm", reason: "graduated_to_warm" }
        : { nextState: "fresh", reason: "unchanged" };

    case "warm":
      return { nextState: "warm", reason: "unchanged" };

    case "paused":
      return meetsRewarm(input)
        ? { nextState: "fresh", reason: "resumed_rewarm" }
        : { nextState: "paused", reason: "unchanged" };

    default:
      return { nextState: state, reason: "unchanged" };
  }

  // ── helpers de placement (definidos como closures para leer input/policy directamente) ────────

  function evaluateAutoPause(inp: TransitionInput): TransitionResult | null {
    const hasSamples = rollup.samples > 0;
    // Orden del doc §9: inbox bajo → spam alto → complaints.
    if ((inp.lowInboxDays ?? 0) >= PAUSE_SUSTAIN_DAYS) {
      return { nextState: "paused", reason: "auto_paused_low_placement" };
    }
    const providerSpam = inp.worstProviderSpamRate;
    const sustainedSpam = (inp.highSpamDays ?? 0) >= PAUSE_SUSTAIN_DAYS;
    const providerSpamHit =
      providerSpam !== undefined && hasSamples && providerSpam > PROVIDER_SPAM_PAUSE_RATE;
    if (sustainedSpam || providerSpamHit) {
      return { nextState: "paused", reason: "auto_paused_high_spam" };
    }
    if (
      rollup.complaintRate !== undefined &&
      hasSamples &&
      rollup.complaintRate > policy.pauseComplaintRate
    ) {
      return { nextState: "paused", reason: "auto_paused_complaints" };
    }
    return null;
  }

  function meetsGraduation(inp: TransitionInput): boolean {
    if (rollup.samples < policy.promoteMinSamples) return false; // n≥20, sin evidencia no promueve
    if (rollup.inboxWilsonLb === undefined || rollup.inboxWilsonLb < policy.promoteInboxLowerBound) {
      return false;
    }
    if ((inp.sustainedDaysOverBar ?? 0) < policy.promoteSustainDays) return false;
    if (spamRate(rollup) > policy.promoteMaxSpam) return false;
    // Ningún proveedor mayor con LB<0.60; si no lo conocemos, fail-closed (no graduar).
    if (rollup.worstMajorProviderLb === undefined || rollup.worstMajorProviderLb < MAJOR_PROVIDER_MIN_LB) {
      return false;
    }
    return true;
  }

  function meetsRewarm(inp: TransitionInput): boolean {
    if ((inp.pausedHours ?? 0) < REWARM_COOLDOWN_HOURS) return false;
    if (rollup.inboxWilsonLb === undefined || rollup.inboxWilsonLb < policy.promoteInboxLowerBound) {
      return false;
    }
    if ((inp.sustainedDaysOverBar ?? 0) < REWARM_SUSTAIN_DAYS) return false;
    return true;
  }
}

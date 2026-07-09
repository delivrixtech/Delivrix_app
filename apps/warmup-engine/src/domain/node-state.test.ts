import assert from "node:assert/strict";
import test from "node:test";
import { nextNodeState, type TransitionInput } from "./node-state.ts";
import { DEFAULT_WARMUP_POLICY, type NodeState, type PlacementRollup } from "./types.ts";

const EMPTY_ROLLUP: PlacementRollup = { samples: 0, inboxCount: 0, spamCount: 0, missingCount: 0 };

/** Rollup "sano" para graduar: LB alto, n≥20, spam bajo, proveedor mayor por encima de 0.60. */
function goodRollup(over: Partial<PlacementRollup> = {}): PlacementRollup {
  return {
    samples: 30,
    inboxCount: 27,
    spamCount: 0,
    missingCount: 3,
    inboxWilsonLb: 0.85,
    inboxEwma: 0.9,
    worstMajorProviderLb: 0.75,
    complaintRate: 0,
    ...over
  };
}

function run(state: NodeState, over: Partial<TransitionInput> = {}) {
  return nextNodeState({
    node: { state },
    rollup: EMPTY_ROLLUP,
    authReady: true,
    policy: DEFAULT_WARMUP_POLICY,
    ...over
  });
}

// ── §8 auth-gate ────────────────────────────────────────────────────────────────────────────────

test("authReady=false ⇒ BLOCKED desde cualquier estado (default-deny)", () => {
  for (const s of ["fresh", "warm", "paused"] as const) {
    const t = run(s, { authReady: false, rollup: goodRollup() });
    assert.equal(t.nextState, "blocked");
    assert.equal(t.reason, "blocked_auth_not_ready");
  }
});

test("blocked con authReady=false permanece blocked (unchanged)", () => {
  const t = run("blocked", { authReady: false });
  assert.equal(t.nextState, "blocked");
  assert.equal(t.reason, "unchanged");
});

test("check continuo regresado en nodo vivo ⇒ QUARANTINED (pausa todo antes de blocked)", () => {
  const t = run("warm", { authReady: false, authCheckRegressed: true, rollup: goodRollup() });
  assert.equal(t.nextState, "quarantined");
  assert.equal(t.reason, "quarantined_check_regressed");
  // También aplica aunque el contrato aún figure ready: la regresión manda.
  assert.equal(run("fresh", { authCheckRegressed: true }).nextState, "quarantined");
});

test("quarantined → blocked cuando el contrato ya no está vigente", () => {
  const t = run("quarantined", { authReady: false });
  assert.equal(t.nextState, "blocked");
  assert.equal(t.reason, "blocked_auth_not_ready");
});

test("recuperación con histéresis: 2 ciclos limpios + contrato fresco ⇒ fresh", () => {
  // Sin suficientes ciclos limpios: sigue en cuarentena/blocked.
  assert.equal(run("quarantined", { authReady: true, cleanAuthCycles: 1 }).nextState, "quarantined");
  assert.equal(run("blocked", { authReady: true, cleanAuthCycles: 1 }).nextState, "blocked");
  // Con 2 ciclos limpios y contrato vigente: recupera a fresh (re-warm).
  const t = run("blocked", { authReady: true, cleanAuthCycles: 2 });
  assert.equal(t.nextState, "fresh");
  assert.equal(t.reason, "resumed_rewarm");
  assert.equal(run("quarantined", { authReady: true, cleanAuthCycles: 3 }).nextState, "fresh");
});

// ── §9 graduación FRESH → WARM ────────────────────────────────────────────────────────────────

test("FRESH → WARM exige TODAS las condiciones (§9)", () => {
  const t = run("fresh", { rollup: goodRollup(), sustainedDaysOverBar: 5 });
  assert.equal(t.nextState, "warm");
  assert.equal(t.reason, "graduated_to_warm");
});

test("FRESH no gradúa si falta una condición del §9", () => {
  const ok = { rollup: goodRollup(), sustainedDaysOverBar: 5 };
  // LB < 0.80
  assert.equal(run("fresh", { ...ok, rollup: goodRollup({ inboxWilsonLb: 0.79 }) }).nextState, "fresh");
  // días sostenidos < 5
  assert.equal(run("fresh", { ...ok, sustainedDaysOverBar: 4 }).nextState, "fresh");
  // n < 20
  assert.equal(run("fresh", { ...ok, rollup: goodRollup({ samples: 19 }) }).nextState, "fresh");
  // spam > 2%
  assert.equal(run("fresh", { ...ok, rollup: goodRollup({ samples: 30, spamCount: 1 }) }).nextState, "fresh");
  // un proveedor mayor con LB < 0.60
  assert.equal(run("fresh", { ...ok, rollup: goodRollup({ worstMajorProviderLb: 0.59 }) }).nextState, "fresh");
  // proveedor mayor desconocido ⇒ fail-closed (no gradúa)
  assert.equal(run("fresh", { ...ok, rollup: goodRollup({ worstMajorProviderLb: undefined }) }).nextState, "fresh");
});

test("sin evidencia (samples=0) no gradúa a ciegas", () => {
  assert.equal(run("fresh", { rollup: EMPTY_ROLLUP, sustainedDaysOverBar: 99 }).nextState, "fresh");
});

// ── §9 auto-pause por cada causa ──────────────────────────────────────────────────────────────

test("auto-pause: inbox puntual < 0.70 por 2 días ⇒ paused (low_placement)", () => {
  const t = run("warm", { rollup: goodRollup(), lowInboxDays: 2 });
  assert.equal(t.nextState, "paused");
  assert.equal(t.reason, "auto_paused_low_placement");
  // 1 solo día no pausa.
  assert.equal(run("warm", { rollup: goodRollup(), lowInboxDays: 1 }).nextState, "warm");
});

test("auto-pause: spam > 5% por 2 días ⇒ paused (high_spam)", () => {
  const t = run("warm", { rollup: goodRollup(), highSpamDays: 2 });
  assert.equal(t.nextState, "paused");
  assert.equal(t.reason, "auto_paused_high_spam");
});

test("auto-pause: un proveedor con spam > 10% ⇒ paused (high_spam)", () => {
  const t = run("warm", { rollup: goodRollup(), worstProviderSpamRate: 0.11 });
  assert.equal(t.nextState, "paused");
  assert.equal(t.reason, "auto_paused_high_spam");
  // 10% exacto no dispara (> estricto).
  assert.equal(run("warm", { rollup: goodRollup(), worstProviderSpamRate: 0.1 }).nextState, "warm");
});

test("auto-pause: complaint > 0.3% ⇒ paused (complaints)", () => {
  const t = run("warm", { rollup: goodRollup({ complaintRate: 0.004 }) });
  assert.equal(t.nextState, "paused");
  assert.equal(t.reason, "auto_paused_complaints");
});

test("auto-pause tiene prioridad sobre graduar desde FRESH", () => {
  const t = run("fresh", { rollup: goodRollup(), sustainedDaysOverBar: 5, lowInboxDays: 2 });
  assert.equal(t.nextState, "paused");
  assert.equal(t.reason, "auto_paused_low_placement");
});

test("sin evidencia no auto-pausa a ciegas", () => {
  assert.equal(run("warm", { rollup: EMPTY_ROLLUP }).nextState, "warm");
  // provider/complaint sin muestras se ignoran.
  assert.equal(run("warm", { rollup: EMPTY_ROLLUP, worstProviderSpamRate: 0.9 }).nextState, "warm");
});

// ── §9 re-warm PAUSED → FRESH ─────────────────────────────────────────────────────────────────

test("PAUSED → FRESH con cooldown ≥48h + LB≥0.80 por ≥3 días (re-warm)", () => {
  const t = run("paused", { rollup: goodRollup(), pausedHours: 48, sustainedDaysOverBar: 3 });
  assert.equal(t.nextState, "fresh");
  assert.equal(t.reason, "resumed_rewarm");
});

test("PAUSED no reanuda sin cooldown ni sin LB sostenido", () => {
  // cooldown insuficiente
  assert.equal(run("paused", { rollup: goodRollup(), pausedHours: 47, sustainedDaysOverBar: 5 }).nextState, "paused");
  // LB bajo
  assert.equal(run("paused", { rollup: goodRollup({ inboxWilsonLb: 0.7 }), pausedHours: 72, sustainedDaysOverBar: 5 }).nextState, "paused");
  // días sostenidos < 3
  assert.equal(run("paused", { rollup: goodRollup(), pausedHours: 72, sustainedDaysOverBar: 2 }).nextState, "paused");
});

test("estados terminales sin señal: warm/fresh permanecen unchanged", () => {
  assert.equal(run("warm").reason, "unchanged");
  assert.equal(run("fresh").reason, "unchanged");
});

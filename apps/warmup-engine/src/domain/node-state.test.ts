import assert from "node:assert/strict";
import test from "node:test";
import { nextNodeState } from "./node-state.ts";
import { DEFAULT_WARMUP_POLICY, type NodeState, type SeedCheck } from "./types.ts";

function seed(landedIn: SeedCheck["landedIn"]): SeedCheck {
  return { nodeId: "n1", seedInbox: "seed@gmail.test", sentAt: new Date("2026-07-09T10:00:00Z"), landedIn };
}
const inbox = (n: number) => Array.from({ length: n }, () => seed("primary"));
const spam = (n: number) => Array.from({ length: n }, () => seed("spam"));

function run(state: NodeState, opts: { dayIndex?: number; healthScore?: number; seedChecks?: SeedCheck[]; hasSeedPairing?: boolean } = {}) {
  return nextNodeState({
    node: { state, dayIndex: opts.dayIndex ?? 0, healthScore: opts.healthScore },
    seedChecks: opts.seedChecks ?? [],
    policy: DEFAULT_WARMUP_POLICY,
    hasSeedPairing: opts.hasSeedPairing ?? false
  });
}

test("FRESH → WARMING solo cuando ya tiene seed pairing", () => {
  assert.equal(run("fresh", { hasSeedPairing: false }).nextState, "fresh");
  const t = run("fresh", { hasSeedPairing: true });
  assert.equal(t.nextState, "warming");
  assert.equal(t.reason, "started_warming");
});

test("WARMING → WARM exige health>90 + placement ok + días mínimos (3-4 sem)", () => {
  // Todo ok menos los días: se queda.
  assert.equal(run("warming", { dayIndex: 10, healthScore: 0.95, seedChecks: inbox(9) }).nextState, "warming");
  // Días ok pero health bajo: se queda.
  assert.equal(run("warming", { dayIndex: 25, healthScore: 0.8, seedChecks: inbox(9) }).nextState, "warming");
  // Todo ok: gradúa.
  const t = run("warming", { dayIndex: 25, healthScore: 0.95, seedChecks: inbox(9) });
  assert.equal(t.nextState, "warm");
  assert.equal(t.reason, "graduated_to_warm");
});

test("placement bajo umbral auto-pausa desde WARMING o WARM (prioridad sobre graduar)", () => {
  const fromWarming = run("warming", { dayIndex: 25, healthScore: 0.99, seedChecks: [...inbox(2), ...spam(8)] });
  assert.equal(fromWarming.nextState, "paused");
  assert.equal(fromWarming.reason, "auto_paused_low_placement");
  assert.equal(run("warm", { seedChecks: [...inbox(2), ...spam(8)] }).nextState, "paused");
});

test("PAUSED se resume a WARMING solo con placement recuperado", () => {
  assert.equal(run("paused", { seedChecks: [...inbox(2), ...spam(8)] }).nextState, "paused");
  const t = run("paused", { seedChecks: inbox(9) });
  assert.equal(t.nextState, "warming");
  assert.equal(t.reason, "resumed_from_pause");
});

test("sin evidencia de placement no se auto-pausa ni gradúa (no castiga/promueve a ciegas)", () => {
  assert.equal(run("warm", { seedChecks: [] }).nextState, "warm");
  assert.equal(run("warming", { dayIndex: 30, healthScore: 0.99, seedChecks: [] }).nextState, "warming");
});

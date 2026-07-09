import assert from "node:assert/strict";
import test from "node:test";
import { matchPairs } from "./pair-matcher.ts";
import { DEFAULT_WARMUP_POLICY, type NodeState } from "./types.ts";

function node(id: string, state: NodeState) {
  return { id, state };
}
function has(pairs: { fromNode: string; toNode: string }[], from: string, to: string): boolean {
  return pairs.some((p) => p.fromNode === from && p.toNode === to);
}

test("los frescos RECIBEN de nodos warm (avales), nunca al revés en el paso de seed", () => {
  const { pairs } = matchPairs({
    activeNodes: [node("w1", "warm"), node("w2", "warm"), node("f1", "fresh")],
    todaysPairings: [],
    policy: DEFAULT_WARMUP_POLICY
  });
  assert.equal(has(pairs, "w1", "f1"), true, "un warm escribe al fresco");
  assert.equal(has(pairs, "f1", "w1"), false, "el fresco no escribe al warm en el seed");
});

test("no repite un par (from→to) ya emitido hoy", () => {
  const { pairs } = matchPairs({
    activeNodes: [node("w1", "warm"), node("w2", "warm")],
    todaysPairings: [{ fromNode: "w1", toNode: "w2" }],
    policy: DEFAULT_WARMUP_POLICY
  });
  assert.equal(has(pairs, "w1", "w2"), false, "ya se emitió hoy");
  assert.equal(has(pairs, "w2", "w1"), true, "el sentido inverso sí es válido");
});

test("ningún nodo se escribe a sí mismo", () => {
  const { pairs } = matchPairs({
    activeNodes: [node("w1", "warm")],
    todaysPairings: [],
    policy: DEFAULT_WARMUP_POLICY
  });
  assert.equal(pairs.some((p) => p.fromNode === p.toNode), false);
});

test("nunca enruta hacia/desde un nodo pausado", () => {
  const { pairs } = matchPairs({
    activeNodes: [node("w1", "warm"), node("w2", "warm"), node("p1", "paused")],
    todaysPairings: [],
    policy: DEFAULT_WARMUP_POLICY
  });
  assert.equal(pairs.some((p) => p.fromNode === "p1" || p.toNode === "p1"), false);
});

test("anti-dilución: si los frescos exceden maxFreshFraction NO se admiten más frescos", () => {
  // 3 frescos + 1 warm => fresh fraction 0.75 > 0.4.
  const result = matchPairs({
    activeNodes: [node("w1", "warm"), node("f1", "fresh"), node("f2", "fresh"), node("f3", "fresh")],
    todaysPairings: [],
    policy: DEFAULT_WARMUP_POLICY
  });
  assert.equal(result.freshCapReached, true);
  assert.equal(result.pairs.some((p) => ["f1", "f2", "f3"].includes(p.toNode)), false, "no se calienta ningún fresco por encima del cap");
});

test("mesh warm en anillo se mantiene vivo (§4 'el mesh nunca se apaga')", () => {
  const { pairs } = matchPairs({
    activeNodes: [node("w1", "warm"), node("w2", "warm"), node("w3", "warm")],
    todaysPairings: [],
    policy: DEFAULT_WARMUP_POLICY
  });
  assert.equal(has(pairs, "w1", "w2"), true);
  assert.equal(has(pairs, "w2", "w3"), true);
  assert.equal(has(pairs, "w3", "w1"), true);
});

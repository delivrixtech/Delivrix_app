import assert from "node:assert/strict";
import test from "node:test";
import { buildGoldenQueries, evaluateGate, recommend, sweep } from "./calibrate-grounded-gate.mjs";

function fact(overrides = {}) {
  const now = new Date();
  return {
    id: `id-${Math.random().toString(16).slice(2)}`,
    intentId: "intent-calib",
    step: 1,
    tool: "install_smtp_stack",
    inputHash: "a".repeat(64),
    outcome: "success",
    outcomeData: { domain: "alpha.example", decisionCode: "smtp_stack_ready" },
    source: "tool_output",
    trustScore: 70,
    plane: "verified_fact",
    provenance: { kind: "tool_evidence", toolCallId: "toolu-calib" },
    reliability: 0.85,
    validAt: now,
    ttlExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
    createdAt: now,
    metadata: { toolCallId: "toolu-calib" },
    ...overrides
  };
}

test("buildGoldenQueries genera positivas desde el corpus mas negativas y cruzadas", () => {
  const entries = [
    fact(),
    fact({ tool: "configure_email_auth", outcomeData: { domain: "beta.example" } })
  ];
  const golden = buildGoldenQueries(entries);

  const positives = golden.filter((item) => item.kind === "positive");
  assert.deepEqual(positives.map((item) => item.query).sort(), [
    "configure_email_auth beta.example",
    "install_smtp_stack alpha.example"
  ]);
  assert.equal(golden.some((item) => item.kind === "negative"), true);
  assert.equal(golden.some((item) => item.kind === "cross"), true);
});

test("evaluateGate cuenta grounded para positivas y abstiene en negativas", () => {
  const entries = [fact()];
  const golden = buildGoldenQueries(entries);
  const result = evaluateGate(entries, golden, { minScore: 0.5, ambiguousScore: 0.35 });

  assert.equal(result.positive.total, 1);
  assert.equal(result.positive.grounded, 1);
  assert.equal(result.negative.grounded, 0);
  assert.equal(result.negative.total > 0, true);
});

test("sweep + recommend eligen el primer umbral sin falsos positivos con mejor recall", () => {
  const entries = [
    fact(),
    fact({ intentId: "intent-2", tool: "configure_email_auth", outcomeData: { domain: "beta.example" } })
  ];
  const golden = buildGoldenQueries(entries);
  const rows = sweep(entries, golden, { min: 0.3, max: 0.9, step: 0.1 });

  assert.equal(rows.length, 7);
  const best = recommend(rows);
  assert.equal(best !== undefined, true);
  assert.equal(best.negativeGrounded, 0);
  assert.equal(best.crossWrongDomain, 0);
});

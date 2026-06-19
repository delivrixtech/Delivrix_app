import test from "node:test";
import assert from "node:assert/strict";
import {
  checkConclusion,
  computeVerdict,
  countBySeverity,
  dedupeFindings,
  highestSeverity,
  sortFindings
} from "./verdict.ts";
import type { Finding, Severity, Dimension } from "../subagents/schema.ts";

function finding(severity: Severity, dimension: Dimension, path: string, title = "t"): Finding {
  return {
    dimension,
    severity,
    category: "c",
    title,
    detail: "d",
    evidence: { path },
    recommendation: "r",
    confidence: "high"
  };
}

test("countBySeverity y highestSeverity", () => {
  const findings = [
    finding("high", "security", "a.ts"),
    finding("blocker", "security", "b.ts"),
    finding("low", "code_quality", "c.ts")
  ];
  const counts = countBySeverity(findings);
  assert.equal(counts.blocker, 1);
  assert.equal(counts.high, 1);
  assert.equal(counts.low, 1);
  assert.equal(highestSeverity(findings), "blocker");
  assert.equal(highestSeverity([]), null);
});

test("computeVerdict mapea severidad a veredicto", () => {
  assert.equal(computeVerdict([finding("blocker", "security", "a.ts")]), "blocked");
  assert.equal(computeVerdict([finding("high", "code_quality", "a.ts")]), "attention");
  assert.equal(computeVerdict([finding("medium", "qa_deploy", "a.ts")]), "attention");
  assert.equal(computeVerdict([finding("low", "code_quality", "a.ts")]), "clean");
  assert.equal(computeVerdict([]), "clean");
});

test("checkConclusion respeta el umbral failOn", () => {
  const blocker = [finding("blocker", "security", "a.ts")];
  const high = [finding("high", "security", "a.ts")];
  const medium = [finding("medium", "qa_deploy", "a.ts")];

  assert.equal(checkConclusion(blocker, "blocker"), "failure");
  assert.equal(checkConclusion(high, "blocker"), "neutral");
  assert.equal(checkConclusion(high, "high"), "failure");
  assert.equal(checkConclusion(medium, "high"), "neutral");
  assert.equal(checkConclusion([], "blocker"), "success");
});

test("dedupeFindings elimina identicos pero conserva cruces de dimension", () => {
  const findings = [
    finding("high", "security", "a.ts", "Secreto"),
    finding("high", "security", "a.ts", "Secreto"),
    finding("high", "code_quality", "a.ts", "Secreto")
  ];
  const deduped = dedupeFindings(findings);
  assert.equal(deduped.length, 2);
});

test("sortFindings ordena por severidad y luego por dimension", () => {
  const findings = [
    finding("low", "code_quality", "z.ts"),
    finding("blocker", "qa_deploy", "y.ts"),
    finding("blocker", "security", "x.ts")
  ];
  const sorted = sortFindings(findings);
  assert.equal(sorted[0].dimension, "security");
  assert.equal(sorted[0].severity, "blocker");
  assert.equal(sorted[2].severity, "low");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  checkConclusion,
  collapseByLocation,
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

function findingAt(
  severity: Severity,
  dimension: Dimension,
  path: string,
  lines: string,
  category = "c"
): Finding {
  return {
    dimension,
    severity,
    category,
    title: `${dimension}-${lines}`,
    detail: "d",
    evidence: { path, lines },
    recommendation: "r",
    confidence: "high"
  };
}

test("collapseByLocation fusiona hallazgos con lineas solapadas en el mismo archivo", () => {
  const out = collapseByLocation([
    findingAt("medium", "code_quality", "a.ts", "1449-1451", "incomplete-validation"),
    findingAt("low", "qa_deploy", "a.ts", "1449-1451", "missing-test")
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "medium");
  assert.equal(out[0].dimension, "code_quality");
  assert.match(out[0].detail, /tambien observado en qa_deploy/);
});

test("collapseByLocation desempata por dimension (security gana) con igual severidad", () => {
  const out = collapseByLocation([
    findingAt("high", "code_quality", "a.ts", "10-20"),
    findingAt("high", "security", "a.ts", "15-25")
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].dimension, "security");
});

test("collapseByLocation no fusiona archivos distintos, lineas no solapadas, ni hallazgos sin lineas", () => {
  const out = collapseByLocation([
    findingAt("medium", "code_quality", "a.ts", "1-5"),
    findingAt("medium", "code_quality", "b.ts", "1-5"),
    findingAt("medium", "code_quality", "a.ts", "100-110"),
    finding("medium", "code_quality", "a.ts", "sin-lineas")
  ]);
  assert.equal(out.length, 4);
});

test("collapseByLocation NO fusiona rangos que solo se tocan en un extremo", () => {
  const out = collapseByLocation([
    findingAt("medium", "code_quality", "a.ts", "10-15"),
    findingAt("low", "qa_deploy", "a.ts", "15-20")
  ]);
  assert.equal(out.length, 2);
});

test("collapseByLocation fusiona una sola linea identica y parsea multi-token", () => {
  assert.equal(
    collapseByLocation([
      findingAt("medium", "code_quality", "a.ts", "7"),
      findingAt("low", "qa_deploy", "a.ts", "7")
    ]).length,
    1
  );
  // "10, 20" (multi-token) cubre 10..20 y solapa con 12-18.
  assert.equal(
    collapseByLocation([
      findingAt("medium", "code_quality", "a.ts", "10, 20"),
      findingAt("low", "qa_deploy", "a.ts", "12-18")
    ]).length,
    1
  );
});

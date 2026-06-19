import test from "node:test";
import assert from "node:assert/strict";
import { renderReport, COMMENT_MARKER, type ReportInput, type DimensionSummary } from "./render.ts";
import type { Finding } from "../subagents/schema.ts";

function baseInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const perDimension: DimensionSummary[] = [
    { dimension: "security", ok: true, summary: "sin secretos", findingCount: 1 },
    { dimension: "qa_deploy", ok: true, summary: "faltan tests", findingCount: 0 },
    { dimension: "code_quality", ok: true, summary: "ok", findingCount: 0 }
  ];
  return {
    identifier: "PR #42",
    kind: "pull_request",
    model: "claude-sonnet-4-6",
    verdict: "blocked",
    counts: { blocker: 1, high: 0, medium: 0, low: 0, info: 0 },
    findings: [],
    perDimension,
    changedFileCount: 3,
    includedFileCount: 3,
    skippedCount: 0,
    truncated: false,
    headSha: "abcdef1234567",
    dryRun: false,
    generatedAt: "2026-06-18T00:00:00.000Z",
    ...overrides
  };
}

const sampleFinding: Finding = {
  dimension: "security",
  severity: "blocker",
  category: "secret-exposure",
  title: "API key hardcodeada",
  detail: "Se commitea una credencial en texto plano.",
  evidence: { path: "src/secrets.ts", lines: "3-3", snippet: "const KEY = 'sk-...'" },
  recommendation: "Mover a variable de entorno y rotar la clave.",
  confidence: "high"
};

test("renderReport incluye marcador, veredicto y nota advisory", () => {
  const out = renderReport(baseInput({ findings: [sampleFinding] }));
  assert.ok(out.startsWith(COMMENT_MARKER));
  assert.ok(out.includes("BLOCKED"));
  assert.ok(out.includes("API key hardcodeada"));
  assert.ok(out.includes("src/secrets.ts"));
  assert.ok(out.toLowerCase().includes("advisory"));
});

test("renderReport maneja el caso sin hallazgos", () => {
  const out = renderReport(baseInput({ verdict: "clean", counts: { blocker: 0, high: 0, medium: 0, low: 0, info: 0 } }));
  assert.ok(out.includes("No se reportaron hallazgos"));
});

test("renderReport marca modo degradado cuando un subagente falla", () => {
  const perDimension: DimensionSummary[] = [
    { dimension: "security", ok: false, summary: "", findingCount: 0, error: "anthropic_http_500" },
    { dimension: "qa_deploy", ok: true, summary: "ok", findingCount: 0 },
    { dimension: "code_quality", ok: true, summary: "ok", findingCount: 0 }
  ];
  const out = renderReport(baseInput({ perDimension }));
  assert.ok(out.includes("degradado"));
  assert.ok(out.includes("DEGRADADO"));
});

test("renderReport no contiene emojis", () => {
  const out = renderReport(baseInput({ findings: [sampleFinding] }));
  // Rango basico de emojis/simbolos. El reporte estructural debe ser limpio.
  assert.equal(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(out), false);
});

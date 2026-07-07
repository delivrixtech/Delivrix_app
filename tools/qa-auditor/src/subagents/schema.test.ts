import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFinding, normalizeSubagentResult } from "./schema.ts";

const validRaw = {
  severity: "high",
  category: "n+1",
  title: "Consulta dentro de loop",
  detail: "Se ejecuta una query por iteracion.",
  evidence: { path: "src/a.ts", lines: "10-20", snippet: "for (...) query()" },
  recommendation: "Agrupar en una sola consulta.",
  confidence: "medium"
};

test("normalizeFinding acepta un finding valido y fija la dimension", () => {
  const finding = normalizeFinding(validRaw, "code_quality");
  assert.ok(finding);
  assert.equal(finding?.dimension, "code_quality");
  assert.equal(finding?.severity, "high");
  assert.equal(finding?.evidence.path, "src/a.ts");
  assert.equal(finding?.evidence.lines, "10-20");
});

test("normalizeFinding descarta findings sin titulo o sin ruta", () => {
  assert.equal(normalizeFinding({ ...validRaw, title: "" }, "code_quality"), null);
  assert.equal(normalizeFinding({ ...validRaw, evidence: { path: "" } }, "security"), null);
  assert.equal(normalizeFinding(null, "security"), null);
});

test("normalizeFinding coacciona severidad y confianza invalidas a valores seguros", () => {
  const finding = normalizeFinding({ ...validRaw, severity: "catastrophic", confidence: "absurd" }, "security");
  assert.equal(finding?.severity, "info");
  assert.equal(finding?.confidence, "low");
});

test("normalizeFinding recorta titulos demasiado largos", () => {
  const finding = normalizeFinding({ ...validRaw, title: "x".repeat(500) }, "qa_deploy");
  assert.ok(finding);
  assert.ok((finding?.title.length ?? 0) <= 160);
});

test("normalizeSubagentResult filtra ruido y preserva el summary", () => {
  const result = normalizeSubagentResult(
    { summary: "Todo bien salvo un punto", findings: [validRaw, { bad: true }, 42] },
    "qa_deploy"
  );
  assert.equal(result.findings.length, 1);
  assert.equal(result.summary, "Todo bien salvo un punto");
});

test("normalizeSubagentResult tolera entrada no-objeto", () => {
  const result = normalizeSubagentResult("nope", "security");
  assert.equal(result.findings.length, 0);
  assert.equal(result.summary, "");
});

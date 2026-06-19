import test from "node:test";
import assert from "node:assert/strict";
import { buildUserContent } from "./prompts.ts";
import type { AuditContext } from "../context/collect.ts";

const context: AuditContext = {
  kind: "pull_request",
  identifier: "PR #1",
  title: "t",
  body: "b",
  author: "u",
  changedFileCount: 1,
  includedFiles: ["a.ts"],
  skipped: [],
  truncated: false,
  diffText: "@@ -1 +1 @@",
  fileIndex: [{ path: "a.ts", category: "source", status: "modified" }]
};

test("buildUserContent inyecta el bloque de politica (CONFIABLE) cuando hay qaContext", () => {
  const out = buildUserContent(context, "POLITICA: no marcar HIGH sin input externo");
  assert.match(out, /PROJECT_CONTEXT_AND_POLICY/);
  assert.match(out, /no marcar HIGH/);
  // la politica va ANTES del diff no confiable
  assert.ok(out.indexOf("PROJECT_CONTEXT_AND_POLICY") < out.indexOf("UNTRUSTED_DIFF"));
});

test("buildUserContent omite el bloque de politica si no hay qaContext", () => {
  const out = buildUserContent(context);
  assert.doesNotMatch(out, /PROJECT_CONTEXT_AND_POLICY/);
  assert.match(out, /UNTRUSTED_DIFF/);
});

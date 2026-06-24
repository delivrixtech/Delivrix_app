import assert from "node:assert/strict";
import test from "node:test";
import {
  detectArtifactKind,
  extractOpenClawArtifact,
  shouldOpenArtifact,
  summarizeOpenClawTaskTitle
} from "./openclaw-artifact-extractor.ts";

test("extractOpenClawArtifact classifies actionable purchase proposal", () => {
  const artifact = extractOpenClawArtifact([
    "# Propuesta: channexai.net",
    "",
    "Disponibilidad confirmada. Compra real queda bajo doble aprobación.",
    "",
    "| Campo | Valor |",
    "| --- | --- |",
    "| Registro | USD 17 |"
  ].join("\n"), "proponer compra de channexai.net");

  assert.equal(artifact.kind, "proposal");
  assert.equal(artifact.title, "channexai.net");
  assert.equal(artifact.blocks.some((block) => block.kind === "table_row"), true);
});

test("extractOpenClawArtifact classifies numbered execution plan", () => {
  const artifact = extractOpenClawArtifact([
    "Plan de remediación",
    "",
    "1. Validar DNS",
    "2. Revisar MX",
    "3. Emitir reporte"
  ].join("\n"), "preparar plan para DNS");

  assert.equal(artifact.kind, "plan");
  assert.equal(artifact.blocks.length >= 1, true);
});

test("extractOpenClawArtifact classifies inventory report with table", () => {
  const artifact = extractOpenClawArtifact([
    "Inventario de dominios",
    "",
    "| Dominio | Estado |",
    "| --- | --- |",
    "| nfcorpreport.com | activo |"
  ].join("\n"), "lista todos los dominios bajo gestión");

  assert.equal(artifact.kind, "report");
  assert.equal(artifact.blocks.at(-1)?.kind, "table_row");
});

test("extractOpenClawArtifact classifies template with code fence", () => {
  const artifact = extractOpenClawArtifact([
    "Template DKIM",
    "",
    "```dns",
    "selector._domainkey.example.com TXT v=DKIM1; p=...",
    "```"
  ].join("\n"), "genera template DKIM para example.com");

  assert.equal(artifact.kind, "template");
  assert.equal(artifact.blocks.some((block) => block.kind === "code"), true);
});

test("extractOpenClawArtifact defaults short conversational response to report", () => {
  const artifact = extractOpenClawArtifact("Hola, estoy listo para ayudarte.", "hola");

  assert.equal(artifact.kind, "report");
  assert.equal(artifact.blocks.length, 1);
  assert.equal(artifact.blocks[0].kind, "paragraph");
});

test("extractOpenClawArtifact never returns empty blocks for empty response", () => {
  const artifact = extractOpenClawArtifact("", "qué hora es en utc");

  assert.equal(artifact.kind, "report");
  assert.equal(artifact.blocks.length, 1);
  assert.match(artifact.blocks[0].content, /respondió sin contenido/);
});

test("extractOpenClawArtifact keeps prose-only analysis as one paragraph block", () => {
  const artifact = extractOpenClawArtifact(
    "El kill switch está armado y no hay acciones pendientes.",
    "verifica si el kill switch está armado"
  );

  assert.equal(artifact.kind, "report");
  assert.equal(artifact.blocks.length, 1);
});

test("detectArtifactKind uses prompt proposal hint when response is plain", () => {
  assert.equal(detectArtifactKind("Disponible y recomendado.", "propon compra de example.net"), "proposal");
});

test("detectArtifactKind uses prompt template hint when response is plain", () => {
  assert.equal(detectArtifactKind("Usa selector default.", "muestra el código DKIM"), "template");
});

test("detectArtifactKind keeps explicit DKIM template ahead of proposal guardrails", () => {
  assert.equal(
    detectArtifactKind(
      [
        "# Propuesta controlada",
        "",
        "Compra real bloqueada por doble aprobación.",
        "",
        "```dns",
        "default._domainkey.nfcfilings.com TXT v=DKIM1; p=...",
        "```"
      ].join("\n"),
      "genera template DKIM para nfcfilings.com"
    ),
    "template"
  );
});

test("detectArtifactKind does not treat verification command output as template", () => {
  assert.equal(
    detectArtifactKind(
      [
        "Estado del kill switch",
        "",
        "```bash",
        "kill-switch status: armed",
        "```"
      ].join("\n"),
      "verifica si el kill switch está armado"
    ),
    "report"
  );
});

test("detectArtifactKind keeps audit reports read-only even with recommendations", () => {
  assert.equal(
    detectArtifactKind(
      [
        "## Auditoría de reputación",
        "",
        "Todas las IPs limpias.",
        "",
        "Propuesta: mantener monitoreo diario."
      ].join("\n"),
      "auditar reputación de los 16 dominios IONOS"
    ),
    "report"
  );
});

test("summarizeOpenClawTaskTitle extracts purchase target", () => {
  assert.equal(summarizeOpenClawTaskTitle("proponer compra de delivrix-mail.com"), "Propuesta - delivrix-mail.com");
});

test("summarizeOpenClawTaskTitle extracts list intent", () => {
  assert.equal(summarizeOpenClawTaskTitle("lista todos los dominios bajo gestión"), "Listado - todos los dominios bajo gestión");
});

test("shouldOpenArtifact keeps short conceptual chat in the chat", () => {
  assert.equal(shouldOpenArtifact("FCrDNS es la coincidencia entre PTR y A/AAAA para una IP."), false);
});

test("shouldOpenArtifact opens markdown tables, code, numbered plans, and sectioned reports", () => {
  assert.equal(shouldOpenArtifact([
    "Inventario",
    "",
    "| Server | Estado |",
    "| --- | --- |",
    "| server10 | running |"
  ].join("\n")), true);

  assert.equal(shouldOpenArtifact([
    "```dns",
    "example.com TXT v=spf1 -all",
    "```"
  ].join("\n")), true);

  assert.equal(shouldOpenArtifact([
    "Plan",
    "",
    "1. Validar inventario",
    "2. Emitir reporte"
  ].join("\n")), true);

  assert.equal(shouldOpenArtifact([
    "## Diagnostico",
    "- Inventario Webdock leido",
    "- Blacklist consultada",
    "- Sin acciones live",
    "",
    "Resultado listo."
  ].join("\n")), true);
});

test("shouldOpenArtifact opens long multi-section prose but not long single-section prose", () => {
  const paragraph = "Delivrix mantiene continuidad con Webdock y prioriza auditoria, dry-run, rollback y kill switch antes de cualquier accion de impacto operacional.";
  assert.equal(shouldOpenArtifact([paragraph, paragraph, paragraph, paragraph, paragraph].join(" ")), false);
  assert.equal(shouldOpenArtifact([
    paragraph,
    "",
    paragraph,
    "",
    paragraph,
    "",
    paragraph,
    "",
    paragraph
  ].join("\n")), true);
});

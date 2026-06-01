#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { buildToolsForOpenClaw } from "../../apps/gateway-api/src/openclaw-tools-builder.ts";

const gatewayBase = normalizeBase(process.env.GATEWAY_BASE ?? "http://127.0.0.1:3000");
const mode = process.argv.includes("--send") ? "send" : "preflight";
const now = new Date();
const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const requiredTools = ["send_real_email", "configure_complete_smtp"];
const bannedEmailTerms = [
  "test",
  "demo",
  "prueba",
  "lorem",
  "smoke",
  "ipsum",
  "notify",
  "noreply",
  "no-reply",
  "bulk",
  "blast",
  "spam",
  "campaign",
  "broadcast"
];

const preflight = await runPreflight();
if (mode === "preflight") {
  await persistEvidence("preflight", preflight);
  printJson(preflight);
  process.exit(preflight.ok ? 0 : 1);
}

const input = readSmokeInput();
const validation = validateSmokeInput(input);
if (!validation.ok) {
  const result = { ok: false, phase: "phase1-c-master-smoke", mode, preflight, validation };
  await persistEvidence("blocked", result);
  printJson(result);
  process.exit(1);
}

const message = buildMasterPrompt(input);
const msgId = `phase1-c-master-${stamp}`;
const response = await postJson(`${gatewayBase}/v1/openclaw/chat/send`, {
  msgId,
  message
});
const result = {
  ok: response.ok,
  phase: "phase1-c-master-smoke",
  mode,
  msgId,
  gatewayBase,
  submittedAt: now.toISOString(),
  preflight,
  validation,
  response: response.body,
  next: response.ok
    ? [
        "Abrir Canvas Live y firmar la propuesta master configure_complete_smtp cuando aparezca.",
        `Ver estado: curl -s ${gatewayBase}/v1/audit-events?limit=20`,
        `Ver anchor: curl -s ${gatewayBase}/v1/audit-chain/anchor`
      ]
    : ["Revisar response/status antes de reintentar."]
};
await persistEvidence("submit", result);
printJson(result);
process.exit(response.ok ? 0 : 1);

async function runPreflight() {
  const tools = buildToolsForOpenClaw(process.env).map((tool) => tool.name);
  const missingTools = requiredTools.filter((tool) => !tools.includes(tool));
  const launchInput = readSmokeInput();
  const launchValidation = validateSmokeInput(launchInput);
  const [health, canvas, verify, anchor] = await Promise.all([
    getJson(`${gatewayBase}/health`),
    getJson(`${gatewayBase}/v1/canvas/live/state`),
    getJson(`${gatewayBase}/v1/audit-chain/verify`),
    getJson(`${gatewayBase}/v1/audit-chain/anchor`)
  ]);

  const ok = (
    health.ok &&
    health.body?.status === "ok" &&
    canvas.ok &&
    verify.ok &&
    verify.body?.ok === true &&
    anchor.ok &&
    missingTools.length === 0
  );

  return {
    ok,
    phase: "phase1-c-master-smoke",
    mode,
    gatewayBase,
    checkedAt: now.toISOString(),
    tools: {
      count: tools.length,
      required: requiredTools,
      missing: missingTools,
      names: tools
    },
    health: summarizeHealth(health),
    canvas: {
      ok: canvas.ok,
      status: canvas.status,
      tasks: Array.isArray(canvas.body?.tasks) ? canvas.body.tasks.length : null,
      artifacts: Array.isArray(canvas.body?.artifacts) ? canvas.body.artifacts.length : null
    },
    audit: {
      verify: verify.body,
      anchor: anchor.body
    },
    launchReadiness: {
      readyForSend: launchValidation.ok,
      blockers: launchValidation.blockers,
      sanitizedInput: launchValidation.sanitizedInput
    },
    blockers: [
      ...missingTools.map((tool) => `missing_tool:${tool}`),
      ...(health.ok && health.body?.status === "ok" ? [] : ["gateway_health_not_ok"]),
      ...(canvas.ok ? [] : ["canvas_state_unavailable"]),
      ...(verify.ok && verify.body?.ok === true ? [] : ["audit_chain_verify_not_ok"]),
      ...(anchor.ok ? [] : ["audit_anchor_unavailable"])
    ]
  };
}

function readSmokeInput() {
  return {
    brand: process.env.PHASE1_SMOKE_BRAND ?? "delivrix",
    intent: process.env.PHASE1_SMOKE_INTENT ?? "ops",
    budgetUsdMax: Number(process.env.PHASE1_SMOKE_BUDGET_USD_MAX ?? "25"),
    testEmailRecipient: process.env.PHASE1_TEST_EMAIL_RECIPIENT ?? "",
    testEmailSubject: process.env.PHASE1_TEST_EMAIL_SUBJECT ?? "",
    testEmailBody: process.env.PHASE1_TEST_EMAIL_BODY ?? "",
    seedInboxes: parseCsv(process.env.PHASE1_SEED_INBOXES ?? process.env.WARMUP_DEFAULT_SEED_INBOXES ?? "")
  };
}

function validateSmokeInput(input) {
  const blockers = [];
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(input.brand)) blockers.push("invalid_brand");
  if (!input.intent.trim()) blockers.push("missing_intent");
  if (!Number.isInteger(input.budgetUsdMax) || input.budgetUsdMax < 20 || input.budgetUsdMax > 100) blockers.push("budget_out_of_range");
  if (!isEmail(input.testEmailRecipient)) blockers.push("invalid_or_missing_testEmailRecipient");
  if (input.testEmailSubject.trim().length < 8) blockers.push("subject_too_short");
  if (input.testEmailBody.trim().length < 20) blockers.push("body_too_short");

  const bannedHits = bannedEmailTerms.filter((term) => {
    const re = new RegExp(`(^|[^a-z])${escapeRegExp(term)}([^a-z]|$)`, "i");
    return re.test(input.testEmailSubject) || re.test(input.testEmailBody);
  });
  for (const hit of bannedHits) blockers.push(`banned_email_term:${hit}`);

  return {
    ok: blockers.length === 0,
    blockers,
    sanitizedInput: {
      brand: input.brand,
      intent: input.intent,
      budgetUsdMax: input.budgetUsdMax,
      testEmailRecipient: input.testEmailRecipient,
      testEmailSubject: input.testEmailSubject,
      testEmailBodyChars: input.testEmailBody.length,
      seedInboxCount: input.seedInboxes.length
    }
  };
}

function buildMasterPrompt(input) {
  const seedLine = input.seedInboxes.length > 0
    ? `\nseedInboxes: ${JSON.stringify(input.seedInboxes)}`
    : "";
  return [
    "OpenClaw, ejecuta Fase C real coordinada del flow SMTP completo.",
    "Usa exactamente la tool configure_complete_smtp; no ejecutes skills sueltas para este pedido.",
    "La tool debe crear la propuesta master y luego esperar ApprovalGate para cada acción real.",
    "No compres dominio, no crees VPS, no cambies DNS y no envíes correo sin firma humana válida.",
    "Parámetros exactos:",
    `brand: ${input.brand}`,
    `intent: ${input.intent}`,
    `budgetUsdMax: ${input.budgetUsdMax}`,
    `testEmailRecipient: ${input.testEmailRecipient}`,
    `testEmailSubject: ${JSON.stringify(input.testEmailSubject)}`,
    `testEmailBody: ${JSON.stringify(input.testEmailBody)}`,
    seedLine,
    "Al responder, resume proposalId/runId y deja claro qué firma espera el operador."
  ].filter(Boolean).join("\n");
}

async function getJson(url) {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error instanceof Error ? error.message : "unknown_fetch_error" };
  }
}

async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error instanceof Error ? error.message : "unknown_fetch_error" };
  }
}

async function persistEvidence(kind, payload) {
  await mkdir("runtime", { recursive: true });
  await writeFile(`runtime/phase1-c-${kind}-${stamp}.json`, `${JSON.stringify(payload, null, 2)}\n`);
}

function summarizeHealth(response) {
  return {
    ok: response.ok,
    status: response.status,
    serviceStatus: response.body?.status,
    killSwitchEnabled: response.body?.killSwitch?.enabled,
    queue: response.body?.queue,
    auditLog: response.body?.auditLog
  };
}

function normalizeBase(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

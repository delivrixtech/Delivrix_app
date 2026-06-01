#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildToolsForOpenClaw } from "../../apps/gateway-api/src/openclaw-tools-builder.ts";

const cliArgs = parseArgs(process.argv.slice(2));
const gatewayBase = normalizeBase(process.env.GATEWAY_BASE ?? "http://127.0.0.1:3000");
const runtimeEnvFile = stringArg("runtimeEnvFile") ?? process.env.PHASE1_ENV_FILE ?? ".env.local";
const mode = cliArgs.send ? "send" : cliArgs.dryRun ? "dry-run" : "preflight";
const watchReady = cliArgs.watchReady === true;
const requireLaunchReady = cliArgs.requireLaunchReady === true || watchReady;
const watchIntervalMs = positiveIntegerArg("intervalMs", 5000);
const watchMaxIterations = positiveIntegerArg("maxIterations", 12);
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

const preflight = await runPreflightMaybeWatching();
if (mode === "preflight") {
  const result = watchReady ? preflight : requireLaunchReady ? requireLaunchReadiness(preflight) : preflight;
  await persistEvidence("preflight", result);
  printJson(result);
  process.exit(result.ok ? 0 : 1);
}

const input = readSmokeInput(await loadRuntimeEnv());
const validation = validateSmokeInput(input);
if (!validation.ok) {
  const result = { ok: false, phase: "phase1-c-master-smoke", mode, preflight, validation };
  await persistEvidence("blocked", result);
  printJson(result);
  process.exit(1);
}

const message = buildMasterPrompt(input);
const msgId = `phase1-c-master-${stamp}`;
if (mode === "dry-run") {
  const result = {
    ok: preflight.ok && validation.ok,
    phase: "phase1-c-master-smoke",
    mode,
    msgId,
    gatewayBase,
    wouldSubmitTo: `${gatewayBase}/v1/openclaw/chat/send`,
    submitted: false,
    generatedAt: now.toISOString(),
    preflight,
    validation: sanitizeValidationForOutput(validation, input),
    messagePreview: buildMasterPrompt({ ...input, testEmailBody: `[redacted body chars=${input.testEmailBody.length} sha256=${sha256(input.testEmailBody)}]` }),
    next: [
      "Si PM/Juanes aprueban recipient/subject/body, repetir el mismo comando con --send.",
      "Después abrir Canvas Live y firmar la propuesta master configure_complete_smtp cuando aparezca.",
      `Watcher: PHASE1_MSG_ID=${msgId} node --env-file=.env.local scripts/openclaw/phase1-c-watch.mjs --watch`
    ]
  };
  await persistEvidence("dry-run", result);
  printJson(result);
  process.exit(result.ok ? 0 : 1);
}

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
  const runtimeEnv = await loadRuntimeEnv();
  const tools = buildToolsForOpenClaw(runtimeEnv).map((tool) => tool.name);
  const missingTools = requiredTools.filter((tool) => !tools.includes(tool));
  const launchInput = readSmokeInput(runtimeEnv);
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
    runtimeEnvFile,
    checkedAt: new Date().toISOString(),
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

async function runPreflightMaybeWatching() {
  if (mode !== "preflight" || !watchReady) {
    return runPreflight();
  }

  const snapshots = [];
  for (let index = 0; index < watchMaxIterations; index += 1) {
    const snapshot = requireLaunchReadiness(await runPreflight());
    snapshots.push(snapshot);
    if (snapshot.ok) {
      break;
    }
    if (index < watchMaxIterations - 1) {
      await sleep(watchIntervalMs);
    }
  }

  const latest = snapshots.at(-1) ?? requireLaunchReadiness(await runPreflight());
  return {
    ...latest,
    watchReady: {
      enabled: true,
      ready: latest.ok,
      intervalMs: watchIntervalMs,
      maxIterations: watchMaxIterations,
      iterations: snapshots.length
    },
    snapshots: snapshots.map(summarizePreflightSnapshot)
  };
}

function requireLaunchReadiness(preflight) {
  const readyForSend = preflight.launchReadiness?.readyForSend === true;
  const launchBlockers = Array.isArray(preflight.launchReadiness?.blockers)
    ? preflight.launchReadiness.blockers
    : ["launch_readiness_unknown"];
  return {
    ...preflight,
    ok: preflight.ok && readyForSend,
    launchReadiness: {
      ...preflight.launchReadiness,
      required: true
    },
    blockers: [
      ...preflight.blockers,
      ...(readyForSend ? [] : launchBlockers.map((blocker) => `launch_not_ready:${blocker}`))
    ]
  };
}

function summarizePreflightSnapshot(snapshot) {
  return {
    checkedAt: snapshot.checkedAt,
    ok: snapshot.ok,
    tools: {
      count: snapshot.tools?.count ?? 0,
      missing: snapshot.tools?.missing ?? []
    },
    health: snapshot.health,
    canvas: snapshot.canvas,
    audit: {
      verifyOk: snapshot.audit?.verify?.ok === true,
      totalEvents: snapshot.audit?.verify?.totalEvents ?? null,
      headSeq: snapshot.audit?.anchor?.headSeq ?? null
    },
    launchReadiness: snapshot.launchReadiness,
    blockers: snapshot.blockers
  };
}

async function loadRuntimeEnv() {
  return {
    ...process.env,
    ...await readEnvFile(runtimeEnvFile)
  };
}

async function readEnvFile(path) {
  try {
    const raw = await readFile(path, "utf-8");
    const env = {};
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const normalizedLine = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
      const equalsAt = normalizedLine.indexOf("=");
      if (equalsAt <= 0) continue;
      const key = normalizedLine.slice(0, equalsAt).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      env[key] = decodeEnvValue(normalizedLine.slice(equalsAt + 1).trim());
    }
    return env;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function decodeEnvValue(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function readSmokeInput(env) {
  return {
    brand: stringArg("brand") ?? env.PHASE1_SMOKE_BRAND ?? "delivrix",
    intent: stringArg("intent") ?? env.PHASE1_SMOKE_INTENT ?? "ops",
    budgetUsdMax: Number(stringArg("budgetUsdMax") ?? env.PHASE1_SMOKE_BUDGET_USD_MAX ?? "25"),
    testEmailRecipient: stringArg("recipient") ?? stringArg("testEmailRecipient") ?? env.PHASE1_TEST_EMAIL_RECIPIENT ?? "",
    testEmailSubject: stringArg("subject") ?? stringArg("testEmailSubject") ?? env.PHASE1_TEST_EMAIL_SUBJECT ?? "",
    testEmailBody: stringArg("body") ?? stringArg("testEmailBody") ?? env.PHASE1_TEST_EMAIL_BODY ?? "",
    seedInboxes: parseCsv(
      stringArg("seedInboxes") ??
      env.PHASE1_SEED_INBOXES ??
      env.WARMUP_DEFAULT_SEED_INBOXES ??
      ""
    )
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

function sanitizeValidationForOutput(validation, input) {
  return {
    ...validation,
    sanitizedInput: {
      ...validation.sanitizedInput,
      testEmailBodySha256: sha256(input.testEmailBody)
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

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function stringArg(key) {
  const value = cliArgs[key];
  return typeof value === "string" ? value : undefined;
}

function positiveIntegerArg(key, fallback) {
  const raw = stringArg(key);
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

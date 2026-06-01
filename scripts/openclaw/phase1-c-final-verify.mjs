#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const gatewayBase = normalizeBase(process.env.GATEWAY_BASE ?? "http://127.0.0.1:3000");
const args = parseArgs(process.argv.slice(2));
const now = new Date();
const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const phase = "phase1-c-final-verify";

if (args.help) {
  printHelp();
  process.exit(0);
}

const filters = {
  runId: stringArg("runId") ?? process.env.PHASE1_RUN_ID ?? "",
  domain: stringArg("domain") ?? process.env.PHASE1_DOMAIN ?? "",
  recipient: stringArg("recipient") ?? process.env.PHASE1_TEST_EMAIL_RECIPIENT ?? "",
  proposalId: stringArg("proposalId") ?? process.env.PHASE1_PROPOSAL_ID ?? ""
};
const limit = parsePositiveInteger(stringArg("limit") ?? process.env.PHASE1_FINAL_VERIFY_LIMIT, 600);

const [health, verify, anchor, auditEvents, canvas] = await Promise.all([
  getJson(`${gatewayBase}/health`),
  getJson(`${gatewayBase}/v1/audit-chain/verify`),
  getJson(`${gatewayBase}/v1/audit-chain/anchor`),
  getJson(`${gatewayBase}/v1/audit-events?limit=${encodeURIComponent(String(limit))}`),
  getJson(`${gatewayBase}/v1/canvas/live/state`)
]);
const proposalStatus = filters.proposalId
  ? await getJson(`${gatewayBase}/v1/openclaw/proposals/${encodeURIComponent(filters.proposalId)}/status`)
  : null;

const events = Array.isArray(auditEvents.body?.events) ? auditEvents.body.events : [];
const scopedEvents = events.filter((event) => matchesScope(event, filters));
const runCompleted = findEvent(scopedEvents, "oc.orchestrator.run_completed");
const emailSent = findEvent(scopedEvents, "oc.smtp.real_email_sent");
const runFailed = findEvent(scopedEvents, "oc.orchestrator.run_failed") ?? findEvent(scopedEvents, "oc.orchestrator.step_failed");
const proposalExecuted = !proposalStatus || proposalStatus.body?.status === "executed";

const blockers = [
  ...(health.ok && health.body?.status === "ok" ? [] : ["gateway_health_not_ok"]),
  ...(verify.ok && verify.body?.ok === true ? [] : ["audit_chain_verify_not_ok"]),
  ...(anchor.ok ? [] : ["audit_anchor_unavailable"]),
  ...(auditEvents.ok ? [] : ["audit_events_unavailable"]),
  ...(canvas.ok ? [] : ["canvas_state_unavailable"]),
  ...(proposalStatus && !proposalStatus.ok ? [`proposal_status_unavailable:${filters.proposalId}`] : []),
  ...(proposalExecuted ? [] : [`proposal_not_executed:${proposalStatus?.body?.status ?? "unknown"}`]),
  ...(runCompleted ? [] : ["missing_audit_event:oc.orchestrator.run_completed"]),
  ...(emailSent ? [] : ["missing_audit_event:oc.smtp.real_email_sent"]),
  ...(runFailed ? [`orchestrator_failure_present:${runFailed.action}`] : [])
];

const result = {
  ok: blockers.length === 0,
  phase,
  gatewayBase,
  checkedAt: now.toISOString(),
  filters,
  limit,
  health: summarizeHealth(health),
  audit: {
    verify: sanitize(verify.body),
    anchor: sanitize(anchor.body),
    scannedEvents: events.length,
    scopedEvents: scopedEvents.length,
    runCompleted: summarizeEvent(runCompleted),
    emailSent: summarizeEvent(emailSent),
    runFailure: summarizeEvent(runFailed)
  },
  canvas: {
    ok: canvas.ok,
    status: canvas.status,
    tasks: Array.isArray(canvas.body?.tasks) ? canvas.body.tasks.length : null,
    artifacts: Array.isArray(canvas.body?.artifacts) ? canvas.body.artifacts.length : null
  },
  proposalStatus: proposalStatus ? sanitize(proposalStatus.body) : null,
  blockers,
  next: buildNext(blockers)
};

const evidencePath = await persistEvidence();
result.evidencePath = evidencePath;
await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
printJson(result);
process.exit(result.ok ? 0 : 1);

function matchesScope(event, eventFilters) {
  const haystack = JSON.stringify({
    id: event?.id,
    action: event?.action,
    targetId: event?.targetId,
    metadata: event?.metadata
  });
  if (eventFilters.runId && haystack.includes(eventFilters.runId)) return true;
  if (eventFilters.domain && haystack.includes(eventFilters.domain)) return true;
  if (eventFilters.proposalId && haystack.includes(eventFilters.proposalId)) return true;
  if (eventFilters.recipient && haystack.includes(hashableRecipientDomain(eventFilters.recipient))) return true;

  const hasScope = Boolean(eventFilters.runId || eventFilters.domain || eventFilters.proposalId || eventFilters.recipient);
  if (hasScope) return false;

  return event?.action === "oc.orchestrator.run_completed" || event?.action === "oc.smtp.real_email_sent";
}

function findEvent(events, action) {
  return events.slice().reverse().find((event) => event?.action === action) ?? null;
}

function summarizeEvent(event) {
  if (!event) return null;
  return sanitize({
    id: event.id,
    occurredAt: event.occurredAt,
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    riskLevel: event.riskLevel,
    decision: event.decision,
    humanApproved: event.humanApproved,
    hash: event.hash,
    metadata: event.metadata
  });
}

function summarizeHealth(response) {
  return {
    ok: response.ok,
    status: response.status,
    serviceStatus: response.body?.status,
    queue: response.body?.queue,
    auditLog: response.body?.auditLog,
    killSwitchEnabled: response.body?.killSwitch?.enabled,
    postgres: response.body?.postgres,
    redis: response.body?.redis
  };
}

function buildNext(blockers) {
  if (blockers.length === 0) {
    return [
      "Fase C verificable: guardar evidencePath y anchor como cierre operativo.",
      "Compartir SHA + evidencePath + audit.headHash con PM/Juanes."
    ];
  }
  return [
    "No marcar Fase C completa todavía.",
    "Si el smoke aún no se disparó: correr dry-run, luego --send con input autorizado y firmar ApprovalGate.",
    "Si ya se firmó: correr watcher con PHASE1_RUN_ID/PHASE1_PROPOSAL_ID y revisar propuesta/steps faltantes."
  ];
}

async function getJson(url) {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: error instanceof Error ? error.message : "unknown_fetch_error" };
  }
}

async function persistEvidence() {
  await mkdir("runtime", { recursive: true });
  return `runtime/phase1-c-final-verify-${stamp}.json`;
}

function sanitize(value) {
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}... [truncated]` : value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!value || typeof value !== "object") return value;

  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    clean[key] = shouldRedactKey(key) ? "[redacted]" : sanitize(child);
  }
  return clean;
}

function shouldRedactKey(key) {
  if (/^(inputTokens|outputTokens|tokensUsed|bodyLength|bodyHash|toAddressHash)$/i.test(key)) return false;
  return /(authorization|secret|token|api[_-]?key|password|signature|hmac|private[_-]?key|access[_-]?key|body)$/i.test(key);
}

function hashableRecipientDomain(recipient) {
  return recipient.includes("@") ? recipient.split("@").at(-1).toLowerCase() : recipient;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--help" || current === "-h") {
      parsed.help = true;
      continue;
    }
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
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeBase(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`Usage:
  node --env-file=.env.local scripts/openclaw/phase1-c-final-verify.mjs [options]

Options:
  --run-id <id>              Scope audit verification to an orchestrator runId.
  --domain <domain>          Scope audit verification to the chosen domain.
  --recipient <email>        Scope by recipient domain for final email event.
  --proposal-id <uuid>       Also verify proposal status is executed.
  --limit <n>                Recent audit event window. Default: 600.
`);
}

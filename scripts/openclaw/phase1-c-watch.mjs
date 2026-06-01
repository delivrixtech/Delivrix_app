#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";

const gatewayBase = normalizeBase(process.env.GATEWAY_BASE ?? "http://127.0.0.1:3000");
const args = parseArgs(process.argv.slice(2));
const now = new Date();
const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const phase = "phase1-c-watch";

if (args.help) {
  printHelp();
  process.exit(0);
}

const filters = {
  msgId: args.msgId ?? process.env.PHASE1_MSG_ID ?? "",
  runId: args.runId ?? process.env.PHASE1_RUN_ID ?? "",
  proposalId: args.proposalId ?? process.env.PHASE1_PROPOSAL_ID ?? ""
};
const limit = parsePositiveInteger(args.limit ?? process.env.PHASE1_WATCH_LIMIT, 80);
const watch = Boolean(args.watch);
const intervalMs = parsePositiveInteger(args.intervalMs ?? process.env.PHASE1_WATCH_INTERVAL_MS, 5000);
const maxIterations = watch ? parsePositiveInteger(args.maxIterations ?? process.env.PHASE1_WATCH_MAX_ITERATIONS, 12) : 1;

const snapshots = [];
for (let index = 0; index < maxIterations; index += 1) {
  const snapshot = await collectSnapshot(index + 1);
  snapshots.push(snapshot);

  if (!watch || isTerminal(snapshot)) break;
  await sleep(intervalMs);
}

const latest = snapshots.at(-1);
const result = {
  ok: Boolean(latest?.ok),
  phase,
  mode: watch ? "watch" : "snapshot",
  gatewayBase,
  startedAt: now.toISOString(),
  finishedAt: new Date().toISOString(),
  filters,
  config: {
    limit,
    intervalMs,
    maxIterations
  },
  snapshots,
  latest,
  next: buildNext(latest)
};

const evidencePath = await persistEvidence(result);
result.evidencePath = evidencePath;
await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
printJson(result);
process.exit(result.ok ? 0 : 1);

async function collectSnapshot(iteration) {
  const collectedAt = new Date().toISOString();
  const [health, canvas, verify, anchor, auditEvents, proposals] = await Promise.all([
    getJson(`${gatewayBase}/health`),
    getJson(`${gatewayBase}/v1/canvas/live/state`),
    getJson(`${gatewayBase}/v1/audit-chain/verify`),
    getJson(`${gatewayBase}/v1/audit-chain/anchor`),
    getJson(`${gatewayBase}/v1/audit-events?limit=${encodeURIComponent(String(limit))}`),
    getJson(`${gatewayBase}/v1/openclaw/proposals`)
  ]);
  const proposalStatus = filters.proposalId
    ? await getJson(`${gatewayBase}/v1/openclaw/proposals/${encodeURIComponent(filters.proposalId)}/status`)
    : null;

  const auditEventItems = Array.isArray(auditEvents.body?.events) ? auditEvents.body.events : [];
  const relevantEvents = summarizeEvents(auditEventItems, filters);
  const canvasSummary = summarizeCanvas(canvas.body);
  const proposalsSummary = summarizeProposals(proposals.body);
  const ok = (
    health.ok &&
    health.body?.status === "ok" &&
    canvas.ok &&
    verify.ok &&
    verify.body?.ok === true &&
    anchor.ok &&
    auditEvents.ok &&
    proposals.ok &&
    (!proposalStatus || proposalStatus.ok)
  );

  return {
    ok,
    iteration,
    collectedAt,
    health: summarizeHealth(health),
    canvas: canvasSummary,
    audit: {
      verify: sanitize(verify.body),
      anchor: sanitize(anchor.body),
      recentCount: auditEventItems.length,
      relevantCount: relevantEvents.length,
      relevantEvents
    },
    proposals: proposalsSummary,
    proposalStatus: proposalStatus ? sanitize(proposalStatus.body) : null,
    blockers: [
      ...(health.ok && health.body?.status === "ok" ? [] : ["gateway_health_not_ok"]),
      ...(canvas.ok ? [] : ["canvas_state_unavailable"]),
      ...(verify.ok && verify.body?.ok === true ? [] : ["audit_chain_verify_not_ok"]),
      ...(anchor.ok ? [] : ["audit_anchor_unavailable"]),
      ...(auditEvents.ok ? [] : ["audit_events_unavailable"]),
      ...(proposals.ok ? [] : ["proposals_unavailable"]),
      ...(proposalStatus && !proposalStatus.ok ? [`proposal_status_unavailable:${filters.proposalId}`] : [])
    ]
  };
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

function summarizeCanvas(body) {
  const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
  const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
  return {
    schemaVersion: body?.schemaVersion ?? null,
    generatedAt: body?.generatedAt ?? null,
    taskCount: tasks.length,
    artifactCount: artifacts.length,
    latestTasks: tasks
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? ""))
      .slice(0, 8)
      .map((task) => sanitize({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        updatedAt: task.updatedAt,
        actorId: task.actorId
      })),
    pendingApprovalArtifacts: artifacts
      .filter((artifact) => artifact?.kind === "proposal" && artifact?.approvalStatus === "pending")
      .slice(-5)
      .map((artifact) => sanitize({
        artifactId: artifact.artifactId,
        taskId: artifact.taskId,
        title: artifact.title,
        approvalStatus: artifact.approvalStatus,
        updatedAt: artifact.updatedAt,
        blockCount: Array.isArray(artifact.blocks) ? artifact.blocks.length : null
      }))
  };
}

function summarizeProposals(body) {
  const proposals = Array.isArray(body?.proposals) ? body.proposals : [];
  return {
    schemaVersion: body?.schemaVersion ?? null,
    generatedAt: body?.generatedAt ?? null,
    pendingCount: proposals.length,
    pending: proposals.map((proposal) => sanitize({
      id: proposal.id,
      skillSlug: proposal.skillSlug,
      category: proposal.category,
      severity: proposal.severity,
      headline: proposal.headline,
      targetRef: proposal.targetRef,
      receivedAt: proposal.receivedAt,
      expiresAt: proposal.expiresAt,
      requiredApprovals: proposal.requiredApprovals,
      currentApprovals: proposal.currentApprovals
    }))
  };
}

function summarizeEvents(events, eventFilters) {
  return events
    .filter((event) => isRelevantEvent(event, eventFilters))
    .slice(-12)
    .map((event) => sanitize({
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
    }));
}

function isRelevantEvent(event, eventFilters) {
  const hasExplicitFilter = Boolean(eventFilters.msgId || eventFilters.runId || eventFilters.proposalId);
  const haystack = JSON.stringify({
    action: event?.action,
    targetId: event?.targetId,
    metadata: event?.metadata
  });

  if (eventFilters.msgId && haystack.includes(eventFilters.msgId)) return true;
  if (eventFilters.runId && haystack.includes(eventFilters.runId)) return true;
  if (eventFilters.proposalId && haystack.includes(eventFilters.proposalId)) return true;
  if (hasExplicitFilter) return false;

  return [
    "oc.chat.",
    "oc.naming.",
    "oc.proposal.",
    "oc.approval.",
    "oc.orchestrator.",
    "oc.domain.",
    "oc.dns.",
    "oc.route53.",
    "oc.webdock.",
    "oc.smtp.",
    "oc.email_auth.",
    "oc.warmup.",
    "oc.real_email.",
    "oc.send_email."
  ].some((prefix) => typeof event?.action === "string" && event.action.startsWith(prefix));
}

function buildNext(snapshot) {
  if (!snapshot) return ["No snapshot collected."];
  if (!snapshot.ok) return ["Resolver blockers antes de firmar o reintentar Fase C.", ...snapshot.blockers];
  if (snapshot.proposalStatus?.status === "executed") {
    return [
      "Guardar anchor post-smoke y verificar evidencia funcional de dominio/DNS/VPS/Postfix/email.",
      `curl -s ${gatewayBase}/v1/audit-chain/anchor`
    ];
  }
  if (snapshot.proposalStatus?.status === "execution_failed") {
    return ["Revisar proposalStatus.outcome y logs del gateway antes de reintentar."];
  }
  if (snapshot.proposals.pendingCount > 0) {
    return ["Abrir Canvas Live y firmar la propuesta correcta en ApprovalGate si PM/Juanes autorizan el gasto/accion real."];
  }
  return ["Esperar a que OpenClaw emita propuesta master o reintentar master prompt si no aparece actividad nueva."];
}

function isTerminal(snapshot) {
  const status = snapshot?.proposalStatus?.status;
  return status === "executed" || status === "execution_failed" || status === "rejected";
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
  return `runtime/phase1-c-watch-${stamp}.json`;
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
  if (/^(inputTokens|outputTokens|tokensUsed)$/i.test(key)) return false;
  return /(authorization|secret|token|api[_-]?key|password|signature|hmac|private[_-]?key|access[_-]?key)/i.test(key);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--watch") {
      parsed.watch = true;
      continue;
    }
    if (current === "--help" || current === "-h") {
      parsed.help = true;
      continue;
    }
    if (current.startsWith("--")) {
      const key = current.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        parsed[key] = next;
        index += 1;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeBase(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`Usage:
  node --env-file=.env.local scripts/openclaw/phase1-c-watch.mjs [options]

Options:
  --msg-id <id>              Filter audit events by OpenClaw chat msgId.
  --run-id <id>              Filter audit events by orchestrator runId.
  --proposal-id <uuid>       Fetch proposal status and filter audit events.
  --limit <n>                Recent audit event window. Default: 80.
  --watch                    Poll until proposal terminal state or max iterations.
  --interval-ms <n>          Poll interval in ms. Default: 5000.
  --max-iterations <n>       Poll iterations in watch mode. Default: 12.
`);
}

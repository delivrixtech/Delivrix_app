/**
 * Health Auto-Flag runner — extiende el health agent existente (evaluación de
 * sender nodes + ip reputation del gateway) para crear entradas automáticas
 * en la base Notion "🐛 Bugs & Blockers" cuando se rompe un umbral:
 *
 *   spam >10% · bounce >5% · reply rate <5% por 3 días · blacklist hit
 *
 * Endpoint: POST /v1/health-autoflag/run  (token = read boundary token)
 * Body opcional:
 *   {
 *     dryRun?: boolean,               // default: true salvo HEALTH_AUTOFLAG_ENABLE=true
 *     blacklistSignals?: IpReputationExternalSignal[],
 *     blacklistScanPerformed?: boolean,
 *     replySamples?: Record<senderNodeId, Array<{date,sent,replies}>>
 *   }
 *
 * En dry-run: evalúa y reporta qué flaggearía SIN escribir a Notion y sin
 * registrar open flags (solo acumula el historial de reply rate, que es
 * medición, no side-effect). En run real: crea la entrada vía el cliente
 * Notion (services/notion-bugs-blockers.ts) y registra el open flag para
 * dedupe hasta que la métrica se recupere.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  evaluateHealthAutoFlags,
  registerHealthAutoFlagOpenFlag,
  type HealthAutoFlagCandidate,
  type HealthAutoFlagReplySample,
  type HealthAutoFlagState,
  type IpReputationExternalSignal,
  type SendResult,
  type SenderNode
} from "../../../../packages/domain/src/index.ts";
import {
  createBugsBlockersEntry,
  type NotionBugsBlockersDeps
} from "../services/notion-bugs-blockers.ts";
import { authorizeSensitiveRead, type SensitiveReadAuthDeps } from "./sensitive-read-auth.ts";

export interface HealthAutoFlagAuditEvent {
  action: string;
  targetType: string;
  targetId: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  metadata?: Record<string, unknown>;
}

export interface HealthAutoFlagStateStore {
  get(): Promise<HealthAutoFlagState>;
  set(state: HealthAutoFlagState): Promise<void>;
}

export interface HealthAutoFlagDeps extends SensitiveReadAuthDeps {
  getSenderNodes: () => Promise<SenderNode[]>;
  getSendResults: () => Promise<SendResult[]>;
  stateStore: HealthAutoFlagStateStore;
  notion: NotionBugsBlockersDeps;
  emitAudit?: (event: HealthAutoFlagAuditEvent) => Promise<void>;
  /** HEALTH_AUTOFLAG_ENABLE=true → los runs sin dryRun explícito escriben a Notion. */
  autoFlagEnabled?: boolean;
  createEntry?: typeof createBugsBlockersEntry;
}

export interface HealthAutoFlagRunOptions {
  dryRun?: boolean;
  blacklistSignals?: IpReputationExternalSignal[];
  blacklistScanPerformed?: boolean;
  replySamples?: Record<string, HealthAutoFlagReplySample[]>;
  trigger: string;
}

export interface HealthAutoFlagRunResult {
  dryRun: boolean;
  evaluatedNodes: number;
  wouldFlag: HealthAutoFlagCandidate[];
  created: Array<{ dedupeKey: string; notionPageId: string; url?: string }>;
  skipped: Array<{ dedupeKey: string; reason: string }>;
  failed: Array<{ dedupeKey: string; status: number; error: string }>;
  resolved: string[];
}

export async function runHealthAutoFlag(
  deps: HealthAutoFlagDeps,
  options: HealthAutoFlagRunOptions
): Promise<HealthAutoFlagRunResult> {
  const now = (deps.now ?? (() => new Date()))();
  const dryRun = options.dryRun ?? !(deps.autoFlagEnabled ?? false);
  const senderNodes = await deps.getSenderNodes();
  const sendResults = await deps.getSendResults();
  const previousState = await deps.stateStore.get();

  const evaluation = evaluateHealthAutoFlags({
    senderNodes,
    sendResults,
    blacklistSignals: options.blacklistSignals,
    blacklistScanPerformed: options.blacklistScanPerformed,
    replySamples: options.replySamples,
    state: previousState,
    now
  });

  const result: HealthAutoFlagRunResult = {
    dryRun,
    evaluatedNodes: senderNodes.length,
    wouldFlag: evaluation.candidates,
    created: [],
    skipped: [],
    failed: [],
    resolved: evaluation.resolved
  };

  let nextState = evaluation.state;

  if (dryRun) {
    // Solo persistimos historial/resoluciones; los candidates NO se registran
    // como open flags porque no se creó ninguna entrada.
    await deps.stateStore.set(nextState);
    await deps.emitAudit?.({
      action: "health_autoflag.dry_run",
      targetType: "sender_node",
      targetId: "all",
      riskLevel: "low",
      metadata: {
        trigger: options.trigger,
        wouldFlagCount: evaluation.candidates.length,
        wouldFlag: evaluation.candidates.map(candidateSummary),
        resolved: evaluation.resolved
      }
    });
    return result;
  }

  const createEntry = deps.createEntry ?? createBugsBlockersEntry;

  for (const candidate of evaluation.candidates) {
    const outcome = await createEntry(
      {
        issueTitle: candidate.issueTitle,
        category: candidate.category,
        severity: candidate.severity,
        affectedServer: candidate.server,
        description: buildDescription(candidate),
        reportedDate: candidate.observedAt.slice(0, 10)
      },
      deps.notion
    );

    if (outcome.ok) {
      nextState = registerHealthAutoFlagOpenFlag(nextState, candidate, outcome.pageId || null);
      result.created.push({ dedupeKey: candidate.dedupeKey, notionPageId: outcome.pageId, url: outcome.url });
      await deps.emitAudit?.({
        action: "health_autoflag.flag_created",
        targetType: "sender_node",
        targetId: candidate.senderNodeId,
        riskLevel: candidate.severity === "Critical" ? "critical" : "high",
        metadata: {
          trigger: options.trigger,
          ...candidateSummary(candidate),
          notionPageId: outcome.pageId,
          notionUrl: outcome.url
        }
      });
    } else if (outcome.skipped) {
      result.skipped.push({ dedupeKey: candidate.dedupeKey, reason: outcome.reason });
      await deps.emitAudit?.({
        action: "health_autoflag.notion_skipped",
        targetType: "sender_node",
        targetId: candidate.senderNodeId,
        riskLevel: "medium",
        metadata: {
          trigger: options.trigger,
          ...candidateSummary(candidate),
          reason: outcome.reason
        }
      });
    } else {
      result.failed.push({ dedupeKey: candidate.dedupeKey, status: outcome.status, error: outcome.error });
      await deps.emitAudit?.({
        action: "health_autoflag.notion_failed",
        targetType: "sender_node",
        targetId: candidate.senderNodeId,
        riskLevel: "high",
        metadata: {
          trigger: options.trigger,
          ...candidateSummary(candidate),
          status: outcome.status,
          error: outcome.error
        }
      });
    }
  }

  await deps.stateStore.set(nextState);
  return result;
}

export async function handleHealthAutoFlagRun(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HealthAutoFlagDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, deps, "health_autoflag_run");
  if (!auth.ok) {
    return json(response, auth.statusCode, { error: auth.error });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    return json(response, 400, { error: "invalid_json_body" });
  }

  const parsed = parseRunBody(body);
  if (!parsed.ok) {
    return json(response, 400, { error: parsed.error });
  }

  try {
    const result = await runHealthAutoFlag(deps, {
      ...parsed.options,
      trigger: "http_route"
    });
    return json(response, 200, result);
  } catch (error) {
    return json(response, 500, {
      error: "health_autoflag_run_failed",
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

function candidateSummary(candidate: HealthAutoFlagCandidate): Record<string, unknown> {
  return {
    dedupeKey: candidate.dedupeKey,
    server: candidate.server,
    senderNodeId: candidate.senderNodeId,
    ipAddress: candidate.ipAddress,
    metric: candidate.metric,
    value: candidate.value,
    threshold: candidate.threshold,
    severity: candidate.severity,
    category: candidate.category,
    observedAt: candidate.observedAt
  };
}

function buildDescription(candidate: HealthAutoFlagCandidate): string {
  const parts = [
    candidate.description,
    `Métrica: ${candidate.metric} | Valor: ${candidate.value} | Umbral: ${candidate.threshold}`,
    `Servidor: ${candidate.server}${candidate.ipAddress ? ` (${candidate.ipAddress})` : ""} | senderNodeId: ${candidate.senderNodeId}`,
    `Detectado: ${candidate.observedAt} | dedupeKey: ${candidate.dedupeKey} | source: delivrix-health-autoflag`
  ];
  return parts.join("\n");
}

type ParsedRunBody =
  | { ok: true; options: Omit<HealthAutoFlagRunOptions, "trigger"> }
  | { ok: false; error: string };

function parseRunBody(body: unknown): ParsedRunBody {
  if (body === undefined || body === null) {
    return { ok: true, options: {} };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body_must_be_object" };
  }
  const record = body as Record<string, unknown>;

  const options: Omit<HealthAutoFlagRunOptions, "trigger"> = {};

  if (record.dryRun !== undefined) {
    if (typeof record.dryRun !== "boolean") {
      return { ok: false, error: "dry_run_must_be_boolean" };
    }
    options.dryRun = record.dryRun;
  }

  if (record.blacklistScanPerformed !== undefined) {
    if (typeof record.blacklistScanPerformed !== "boolean") {
      return { ok: false, error: "blacklist_scan_performed_must_be_boolean" };
    }
    options.blacklistScanPerformed = record.blacklistScanPerformed;
  }

  if (record.blacklistSignals !== undefined) {
    if (!Array.isArray(record.blacklistSignals)) {
      return { ok: false, error: "blacklist_signals_must_be_array" };
    }
    const signals: IpReputationExternalSignal[] = [];
    for (const raw of record.blacklistSignals) {
      if (
        typeof raw !== "object" || raw === null
        || typeof (raw as Record<string, unknown>).senderNodeId !== "string"
        || typeof (raw as Record<string, unknown>).source !== "string"
      ) {
        return { ok: false, error: "invalid_blacklist_signal" };
      }
      const signal = raw as Record<string, unknown>;
      signals.push({
        senderNodeId: signal.senderNodeId as string,
        type: "blacklist",
        source: signal.source as string,
        severity: signal.severity === "warning" ? "warning" : "critical",
        message: typeof signal.message === "string" ? signal.message : undefined,
        observedAt: typeof signal.observedAt === "string" ? signal.observedAt : undefined
      });
    }
    options.blacklistSignals = signals;
  }

  if (record.replySamples !== undefined) {
    if (typeof record.replySamples !== "object" || record.replySamples === null || Array.isArray(record.replySamples)) {
      return { ok: false, error: "reply_samples_must_be_object" };
    }
    const replySamples: Record<string, HealthAutoFlagReplySample[]> = {};
    for (const [nodeId, rawSamples] of Object.entries(record.replySamples as Record<string, unknown>)) {
      if (!Array.isArray(rawSamples)) {
        return { ok: false, error: "invalid_reply_samples" };
      }
      const samples: HealthAutoFlagReplySample[] = [];
      for (const raw of rawSamples) {
        const sample = raw as Record<string, unknown>;
        if (
          typeof sample !== "object" || sample === null
          || typeof sample.date !== "string"
          || typeof sample.sent !== "number" || sample.sent < 0
          || typeof sample.replies !== "number" || sample.replies < 0
        ) {
          return { ok: false, error: "invalid_reply_samples" };
        }
        samples.push({ date: sample.date, sent: sample.sent, replies: sample.replies });
      }
      replySamples[nodeId] = samples;
    }
    options.replySamples = replySamples;
  }

  return { ok: true, options };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw);
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

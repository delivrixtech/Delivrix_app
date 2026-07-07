/**
 * Health Auto-Flag — evalúa los umbrales del Health Monitor Agent y decide
 * qué issues deben crearse en la base Notion "🐛 Bugs & Blockers".
 *
 * Umbrales (tarea "Auto-flag issues to Bugs and Blockers" del tracker):
 *   - spam  (complaint rate) > 10%
 *   - bounce rate            > 5%
 *   - reply rate             < 5% sostenido 3 días consecutivos
 *   - blacklist hit          (señal externa, p.ej. MXToolbox)
 *
 * Este módulo es lógica pura: no habla con Notion ni con disco. El runner
 * (apps/gateway-api/src/routes/health-autoflag.ts) inyecta los datos y
 * persiste el estado vía LocalFileHealthAutoFlagStore.
 *
 * Dedupe: un candidato se omite mientras exista un open flag con el mismo
 * dedupeKey (`senderNodeId::metric`). Los flags de métricas de tasa se
 * auto-resuelven localmente cuando la métrica vuelve bajo el umbral (permite
 * re-flaggear un incidente nuevo). Los flags de blacklist solo se resuelven
 * cuando un run con `blacklistScanPerformed: true` no trae señal para ese
 * nodo (evita flip-flop en runs sin scan).
 */

import type { IpReputationExternalSignal } from "./ip-reputation.ts";
import type { SendResult, SenderNode } from "./types.ts";

export type HealthAutoFlagMetric = "spam_rate" | "bounce_rate" | "reply_rate" | "blacklist";

export interface HealthAutoFlagThresholds {
  /** complaint rate crítico (spam). 0.10 = 10% */
  spamRateCritical: number;
  /** bounce rate crítico. 0.05 = 5% */
  bounceRateCritical: number;
  /** piso de reply rate. 0.05 = 5% */
  replyRateFloor: number;
  /** días consecutivos bajo el piso para flaggear reply rate */
  replyRateConsecutiveDays: number;
  /** volumen mínimo de resultados para evaluar tasas (evita ruido con 1-2 envíos) */
  minimumVolumeForRateChecks: number;
}

export const defaultHealthAutoFlagThresholds: HealthAutoFlagThresholds = {
  spamRateCritical: 0.1,
  bounceRateCritical: 0.05,
  replyRateFloor: 0.05,
  replyRateConsecutiveDays: 3,
  minimumVolumeForRateChecks: 10
};

/** Muestra diaria de reply rate por servidor (la aporta el warmup agent). */
export interface HealthAutoFlagReplySample {
  /** YYYY-MM-DD */
  date: string;
  sent: number;
  replies: number;
}

export interface HealthAutoFlagOpenFlag {
  dedupeKey: string;
  senderNodeId: string;
  server: string;
  metric: HealthAutoFlagMetric;
  value: string;
  threshold: string;
  flaggedAt: string;
  /** page id devuelto por Notion al crear la entrada (null si aún no se creó). */
  notionPageId: string | null;
}

export interface HealthAutoFlagState {
  version: 1;
  openFlags: HealthAutoFlagOpenFlag[];
  /** key = senderNodeId */
  replyRateHistory: Record<string, HealthAutoFlagReplySample[]>;
}

export function emptyHealthAutoFlagState(): HealthAutoFlagState {
  return { version: 1, openFlags: [], replyRateHistory: {} };
}

export type HealthAutoFlagCategory = "Flagged Server" | "Warmup Stalled";
export type HealthAutoFlagSeverity = "Critical" | "High";

export interface HealthAutoFlagCandidate {
  dedupeKey: string;
  senderNodeId: string;
  server: string;
  ipAddress?: string;
  metric: HealthAutoFlagMetric;
  value: string;
  threshold: string;
  observedAt: string;
  category: HealthAutoFlagCategory;
  severity: HealthAutoFlagSeverity;
  issueTitle: string;
  description: string;
}

export interface HealthAutoFlagInput {
  senderNodes: SenderNode[];
  sendResults: SendResult[];
  /** Señales externas de blacklist (mismo shape que ip-reputation). */
  blacklistSignals?: IpReputationExternalSignal[];
  /** true cuando este run incluye un scan fresco de blacklist (permite resolver flags). */
  blacklistScanPerformed?: boolean;
  /** Muestras diarias nuevas de reply rate, key = senderNodeId. */
  replySamples?: Record<string, HealthAutoFlagReplySample[]>;
  state: HealthAutoFlagState;
  thresholds?: HealthAutoFlagThresholds;
  now?: Date;
}

export interface HealthAutoFlagEvaluation {
  /** Issues nuevos que deberían crearse en Bugs & Blockers (ya deduplicados). */
  candidates: HealthAutoFlagCandidate[];
  /** dedupeKeys de open flags auto-resueltos en este run (métrica recuperada). */
  resolved: string[];
  /**
   * Estado con historial de reply rate mergeado y resoluciones aplicadas.
   * NO incluye los candidates como open flags: eso lo registra el runner
   * DESPUÉS de crear la entrada en Notion (ver registerHealthAutoFlagOpenFlag).
   */
  state: HealthAutoFlagState;
}

const REPLY_HISTORY_MAX_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export function evaluateHealthAutoFlags(input: HealthAutoFlagInput): HealthAutoFlagEvaluation {
  const thresholds = input.thresholds ?? defaultHealthAutoFlagThresholds;
  const now = input.now ?? new Date();
  const observedAt = now.toISOString();
  const state = mergeReplyHistory(input.state, input.replySamples ?? {}, now);
  const blacklistSignals = input.blacklistSignals ?? [];

  const candidates: HealthAutoFlagCandidate[] = [];
  const healthyKeys = new Set<string>();

  for (const node of input.senderNodes) {
    const server = serverLabel(node);
    const metrics = rateMetricsForNode(node.id, input.sendResults);

    // --- spam (complaint rate) > umbral ---
    evaluateRateMetric({
      candidates,
      healthyKeys,
      node,
      server,
      observedAt,
      metric: "spam_rate",
      eligible: metrics.total >= thresholds.minimumVolumeForRateChecks,
      breached: metrics.complaintRate > thresholds.spamRateCritical,
      value: formatRate(metrics.complaintRate),
      threshold: `>${formatRate(thresholds.spamRateCritical)}`,
      category: "Flagged Server",
      severity: "Critical",
      issueTitle: `[auto] ${server} — spam rate ${formatRate(metrics.complaintRate)} supera ${formatRate(thresholds.spamRateCritical)}`,
      description:
        `Health agent: complaint/spam rate ${formatRate(metrics.complaintRate)} ` +
        `(${metrics.complaint}/${metrics.total} resultados) supera el umbral ${formatRate(thresholds.spamRateCritical)}.`
    });

    // --- bounce rate > umbral ---
    evaluateRateMetric({
      candidates,
      healthyKeys,
      node,
      server,
      observedAt,
      metric: "bounce_rate",
      eligible: metrics.total >= thresholds.minimumVolumeForRateChecks,
      breached: metrics.bounceRate > thresholds.bounceRateCritical,
      value: formatRate(metrics.bounceRate),
      threshold: `>${formatRate(thresholds.bounceRateCritical)}`,
      category: "Flagged Server",
      severity: "High",
      issueTitle: `[auto] ${server} — bounce rate ${formatRate(metrics.bounceRate)} supera ${formatRate(thresholds.bounceRateCritical)}`,
      description:
        `Health agent: bounce rate ${formatRate(metrics.bounceRate)} ` +
        `(${metrics.bounce}/${metrics.total} resultados) supera el umbral ${formatRate(thresholds.bounceRateCritical)}.`
    });

    // --- reply rate < piso sostenido N días consecutivos ---
    const replyBreach = evaluateReplyRateBreach(
      state.replyRateHistory[node.id] ?? [],
      thresholds
    );
    if (replyBreach.evaluated) {
      const key = dedupeKeyFor(node.id, "reply_rate");
      if (replyBreach.breached) {
        candidates.push({
          dedupeKey: key,
          senderNodeId: node.id,
          server,
          ipAddress: node.ipAddress,
          metric: "reply_rate",
          value: replyBreach.rates.map(formatRate).join(", "),
          threshold: `<${formatRate(thresholds.replyRateFloor)} x ${thresholds.replyRateConsecutiveDays} días`,
          observedAt,
          category: "Warmup Stalled",
          severity: "High",
          issueTitle: `[auto] ${server} — reply rate bajo ${formatRate(thresholds.replyRateFloor)} por ${thresholds.replyRateConsecutiveDays} días`,
          description:
            `Health agent: reply rate ${replyBreach.rates.map(formatRate).join(", ")} ` +
            `en los días ${replyBreach.dates.join(", ")} — bajo el piso ${formatRate(thresholds.replyRateFloor)} ` +
            `durante ${thresholds.replyRateConsecutiveDays} días consecutivos.`
        });
      } else {
        healthyKeys.add(key);
      }
    }

    // --- blacklist hit (señal externa) ---
    const nodeBlacklist = blacklistSignals.filter(
      (signal) => signal.senderNodeId === node.id && signal.type === "blacklist"
    );
    const blacklistKey = dedupeKeyFor(node.id, "blacklist");
    if (nodeBlacklist.length > 0) {
      const sources = [...new Set(nodeBlacklist.map((signal) => signal.source))];
      candidates.push({
        dedupeKey: blacklistKey,
        senderNodeId: node.id,
        server,
        ipAddress: node.ipAddress,
        metric: "blacklist",
        value: sources.join(", "),
        threshold: "listado en 1+ blacklist",
        observedAt,
        category: "Flagged Server",
        severity: "Critical",
        issueTitle: `[auto] ${server} — blacklist hit (${sources.join(", ")})`,
        description:
          `Health agent: el servidor aparece listado en blacklist. Fuentes: ${sources.join(", ")}. ` +
          nodeBlacklist.map((signal) => signal.message ?? "").filter(Boolean).join(" | ")
      });
    } else if (input.blacklistScanPerformed) {
      healthyKeys.add(blacklistKey);
    }
  }

  // Dedupe contra open flags + auto-resolución de flags recuperados.
  const openKeys = new Set(state.openFlags.map((flag) => flag.dedupeKey));
  const dedupedCandidates = candidates.filter((candidate) => !openKeys.has(candidate.dedupeKey));
  const resolved = state.openFlags
    .filter((flag) => healthyKeys.has(flag.dedupeKey))
    .map((flag) => flag.dedupeKey);
  const nextOpenFlags = state.openFlags.filter((flag) => !healthyKeys.has(flag.dedupeKey));

  return {
    candidates: dedupedCandidates,
    resolved,
    state: { ...state, openFlags: nextOpenFlags }
  };
}

/** Registra un open flag después de que el runner creó la entrada en Notion. */
export function registerHealthAutoFlagOpenFlag(
  state: HealthAutoFlagState,
  candidate: HealthAutoFlagCandidate,
  notionPageId: string | null
): HealthAutoFlagState {
  const withoutKey = state.openFlags.filter((flag) => flag.dedupeKey !== candidate.dedupeKey);
  return {
    ...state,
    openFlags: [
      ...withoutKey,
      {
        dedupeKey: candidate.dedupeKey,
        senderNodeId: candidate.senderNodeId,
        server: candidate.server,
        metric: candidate.metric,
        value: candidate.value,
        threshold: candidate.threshold,
        flaggedAt: candidate.observedAt,
        notionPageId
      }
    ]
  };
}

export function dedupeKeyFor(senderNodeId: string, metric: HealthAutoFlagMetric): string {
  return `${senderNodeId}::${metric}`;
}

function serverLabel(node: SenderNode): string {
  return node.label?.trim() || node.ipAddress || node.id;
}

interface RateMetricInput {
  candidates: HealthAutoFlagCandidate[];
  healthyKeys: Set<string>;
  node: SenderNode;
  server: string;
  observedAt: string;
  metric: HealthAutoFlagMetric;
  eligible: boolean;
  breached: boolean;
  value: string;
  threshold: string;
  category: HealthAutoFlagCategory;
  severity: HealthAutoFlagSeverity;
  issueTitle: string;
  description: string;
}

function evaluateRateMetric(input: RateMetricInput): void {
  const key = dedupeKeyFor(input.node.id, input.metric);
  if (!input.eligible) {
    // Sin volumen mínimo no afirmamos ni salud ni breach (no resuelve flags).
    return;
  }
  if (input.breached) {
    input.candidates.push({
      dedupeKey: key,
      senderNodeId: input.node.id,
      server: input.server,
      ipAddress: input.node.ipAddress,
      metric: input.metric,
      value: input.value,
      threshold: input.threshold,
      observedAt: input.observedAt,
      category: input.category,
      severity: input.severity,
      issueTitle: input.issueTitle,
      description: input.description
    });
  } else {
    input.healthyKeys.add(key);
  }
}

interface ReplyBreachResult {
  /** false cuando no hay historial suficiente para afirmar nada. */
  evaluated: boolean;
  breached: boolean;
  dates: string[];
  rates: number[];
}

function evaluateReplyRateBreach(
  history: HealthAutoFlagReplySample[],
  thresholds: HealthAutoFlagThresholds
): ReplyBreachResult {
  const usable = history
    .filter((sample) => sample.sent > 0 && isIsoDate(sample.date))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  if (usable.length < thresholds.replyRateConsecutiveDays) {
    return { evaluated: usable.length > 0, breached: false, dates: [], rates: [] };
  }

  const window = usable.slice(0, thresholds.replyRateConsecutiveDays);

  // Exigimos días calendario consecutivos (el warmup agent loguea a diario).
  for (let i = 0; i < window.length - 1; i += 1) {
    const newer = Date.parse(window[i].date);
    const older = Date.parse(window[i + 1].date);
    if (newer - older !== DAY_MS) {
      return { evaluated: true, breached: false, dates: [], rates: [] };
    }
  }

  const rates = window.map((sample) => sample.replies / sample.sent);
  const breached = rates.every((rate) => rate < thresholds.replyRateFloor);
  return {
    evaluated: true,
    breached,
    dates: window.map((sample) => sample.date).reverse(),
    rates: rates.reverse()
  };
}

function mergeReplyHistory(
  state: HealthAutoFlagState,
  samples: Record<string, HealthAutoFlagReplySample[]>,
  now: Date
): HealthAutoFlagState {
  const cutoff = new Date(now.getTime() - REPLY_HISTORY_MAX_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const history: Record<string, HealthAutoFlagReplySample[]> = {};

  const keys = new Set([...Object.keys(state.replyRateHistory), ...Object.keys(samples)]);
  for (const key of keys) {
    const merged = new Map<string, HealthAutoFlagReplySample>();
    for (const sample of state.replyRateHistory[key] ?? []) {
      merged.set(sample.date, sample);
    }
    // La muestra nueva del mismo día pisa la vieja (última lectura del día gana).
    for (const sample of samples[key] ?? []) {
      if (isIsoDate(sample.date)) {
        merged.set(sample.date, sample);
      }
    }
    const pruned = [...merged.values()]
      .filter((sample) => sample.date >= cutoff)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (pruned.length > 0) {
      history[key] = pruned;
    }
  }

  return { ...state, replyRateHistory: history };
}

function rateMetricsForNode(senderNodeId: string, sendResults: SendResult[]) {
  let bounce = 0;
  let complaint = 0;
  let total = 0;
  for (const result of sendResults) {
    if (result.senderNodeId !== senderNodeId) {
      continue;
    }
    total += 1;
    if (result.status === "bounce") {
      bounce += 1;
    } else if (result.status === "complaint") {
      complaint += 1;
    }
  }
  return {
    bounce,
    complaint,
    total,
    bounceRate: total > 0 ? bounce / total : 0,
    complaintRate: total > 0 ? complaint / total : 0
  };
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  MxtoolboxAdapter,
  MxtoolboxHealthSummary,
  MxtoolboxLookupResult,
  MxtoolboxUsage
} from "../../../../packages/adapters/src/index.ts";
import {
  isMxtoolboxCommand,
  normalizeMxtoolboxCommand
} from "../../../../packages/adapters/src/index.ts";
import type { SenderNode } from "../../../../packages/domain/src/index.ts";
import { authorizeSensitiveRead, type SensitiveReadAuthDeps } from "./sensitive-read-auth.ts";

interface CanvasLiveEvents {
  emit(event: { type: string; [k: string]: unknown }): Promise<unknown> | unknown;
}

export interface MxtoolboxAuditEvent {
  action: string;
  targetType: "ip" | "domain" | "mxtoolbox_report";
  targetId: string;
  riskLevel: "low" | "high";
  metadata?: Record<string, unknown>;
}

export interface ReadMxtoolboxDeps extends SensitiveReadAuthDeps {
  adapter: MxtoolboxAdapter | null;
  emitAudit?: (event: MxtoolboxAuditEvent) => Promise<void>;
  now?: () => Date;
}

export interface ReadMxtoolboxDailyReportDeps extends ReadMxtoolboxDeps {
  canvasLiveEvents?: CanvasLiveEvents;
  getSenderNodes?: () => Promise<SenderNode[]>;
  recordScratch?: (report: MxtoolboxDailyReportResponse) => Promise<void>;
}

export interface MxtoolboxHealthResponse {
  source: "live" | "cached";
  cachedAt?: string;
  result: MxtoolboxHealthSummary;
}

export interface MxtoolboxDailyReportResponse {
  generatedAt: string;
  totalTargets: number;
  summary: {
    clean: number;
    warning: number;
    listed: number;
    error: number;
  };
  results: MxtoolboxHealthSummary[];
  criticalAlerts: MxtoolboxHealthSummary[];
  usage?: MxtoolboxUsage;
}

const defaultCommands = ["blacklist"] as const;
const maxDailyTargets = 50;
const maxDailyCommands = 8;

export async function handleReadMxtoolbox(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ReadMxtoolboxDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, deps, "mxtoolbox_health");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }
  if (!deps.adapter) {
    json(response, 503, {
      error: "mxtoolbox_not_configured",
      message: "MXTOOLBOX_API_KEY is required for live MXToolbox health reads."
    });
    return;
  }

  const url = requestUrl(request);
  const target = normalizeTargetParam(url.searchParams.get("target"));
  if (!target.ok) {
    json(response, 400, { error: target.error });
    return;
  }
  const command = normalizeCommandParam(url.searchParams.get("type") ?? url.searchParams.get("command") ?? "blacklist");
  if (!command.ok) {
    json(response, 400, { error: command.error });
    return;
  }

  const lookup = await deps.adapter.lookup({
    target: target.value,
    command: command.value,
    selector: optionalParam(url, "selector")
  });
  await deps.emitAudit?.({
    action: "oc.mxtoolbox.lookup",
    targetType: targetType(target.value),
    targetId: target.value,
    riskLevel: "low",
    metadata: auditMetadata(lookup)
  });

  json(response, 200, healthResponse(lookup));
}

export async function handleReadMxtoolboxDailyReport(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ReadMxtoolboxDailyReportDeps
): Promise<void> {
  const auth = authorizeSensitiveRead(request, deps, "mxtoolbox_daily_report");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }
  if (!deps.adapter) {
    json(response, 503, {
      error: "mxtoolbox_not_configured",
      message: "MXTOOLBOX_API_KEY is required for live MXToolbox health reads."
    });
    return;
  }

  const report = await buildMxtoolboxDailyReport(request, deps);
  await appendDailyReportAudit(report, deps);
  await emitDailyReportCanvasSignal(report, deps);
  await recordDailyReportScratch(report, deps);
  json(response, 200, report);
}

export async function buildMxtoolboxDailyReport(
  request: IncomingMessage,
  deps: ReadMxtoolboxDailyReportDeps
): Promise<MxtoolboxDailyReportResponse> {
  if (!deps.adapter) {
    throw new Error("mxtoolbox_not_configured");
  }
  const url = requestUrl(request);
  const targets = await resolveTargets(url, deps);
  const commands = resolveCommands(url);
  const results: MxtoolboxHealthSummary[] = [];

  for (const target of targets) {
    for (const command of commands) {
      const lookup = await deps.adapter.lookup({ target, command });
      results.push(lookup.summary);
    }
  }

  const summary = summarizeResults(results);
  const criticalAlerts = results.filter((result) => result.status === "listed");
  const usage = await deps.adapter.usage();
  return {
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    totalTargets: targets.length,
    summary,
    results,
    criticalAlerts,
    ...(usage ? { usage } : {})
  };
}

async function resolveTargets(
  url: URL,
  deps: ReadMxtoolboxDailyReportDeps
): Promise<string[]> {
  const explicit = csv(url.searchParams.get("targets"))
    .map((target) => normalizeTargetParam(target))
    .filter((result): result is { ok: true; value: string } => result.ok)
    .map((result) => result.value);
  if (explicit.length > 0) {
    return dedupe(explicit).slice(0, maxDailyTargets);
  }

  const senderNodes = await deps.getSenderNodes?.().catch(() => []) ?? [];
  const targets = senderNodes
    .filter((node) => node.status === "active" || node.status === "warming")
    .flatMap((node) => [node.ipAddress, node.hostname])
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeTargetParam(value))
    .filter((result): result is { ok: true; value: string } => result.ok)
    .map((result) => result.value);
  return dedupe(targets).slice(0, maxDailyTargets);
}

function resolveCommands(url: URL): string[] {
  const raw = csv(url.searchParams.get("types") ?? url.searchParams.get("commands"));
  const selected = raw.length > 0 ? raw : [...defaultCommands];
  return dedupe(
    selected
      .map((item) => normalizeCommandParam(item))
      .filter((result): result is { ok: true; value: string } => result.ok)
      .map((result) => result.value)
  ).slice(0, maxDailyCommands);
}

function normalizeTargetParam(value: string | null | undefined):
  | { ok: true; value: string }
  | { ok: false; error: string } {
  const normalized = value?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!normalized) return { ok: false, error: "missing_mxtoolbox_target" };
  if (normalized.length > 253) return { ok: false, error: "invalid_mxtoolbox_target" };
  if (isIpv4(normalized) || isDomain(normalized)) return { ok: true, value: normalized };
  return { ok: false, error: "invalid_mxtoolbox_target" };
}

function normalizeCommandParam(value: string):
  | { ok: true; value: string }
  | { ok: false; error: string } {
  const normalized = value.trim().toLowerCase();
  if (isMxtoolboxCommand(normalized)) {
    return { ok: true, value: normalizeMxtoolboxCommand(normalized) };
  }
  return { ok: false, error: "invalid_mxtoolbox_command" };
}

function healthResponse(lookup: MxtoolboxLookupResult): MxtoolboxHealthResponse {
  return {
    source: lookup.cacheHit ? "cached" : "live",
    ...(lookup.cacheHit ? { cachedAt: lookup.source.fetchedAt } : {}),
    result: lookup.summary
  };
}

async function appendDailyReportAudit(
  report: MxtoolboxDailyReportResponse,
  deps: ReadMxtoolboxDailyReportDeps
): Promise<void> {
  if (report.criticalAlerts.length === 0) {
    await deps.emitAudit?.({
      action: "oc.mxtoolbox.daily_scan_clean",
      targetType: "mxtoolbox_report",
      targetId: report.generatedAt,
      riskLevel: "low",
      metadata: {
        provider: "mxtoolbox",
        totalTargets: report.totalTargets,
        summary: report.summary
      }
    });
    return;
  }

  for (const alert of report.criticalAlerts) {
    await deps.emitAudit?.({
      action: "oc.mxtoolbox.blacklist_detected",
      targetType: targetType(alert.target),
      targetId: alert.target,
      riskLevel: "high",
      metadata: {
        provider: "mxtoolbox",
        command: alert.command,
        status: alert.status,
        failedChecks: alert.failedChecks,
        rawRef: alert.rawRef
      }
    });
  }
}

async function emitDailyReportCanvasSignal(
  report: MxtoolboxDailyReportResponse,
  deps: ReadMxtoolboxDailyReportDeps
): Promise<void> {
  if (!deps.canvasLiveEvents || report.criticalAlerts.length === 0) return;
  const riskLevel = report.criticalAlerts.length > 5 ? "critical" : "high";
  await deps.canvasLiveEvents.emit({
    type: "oc.action.now",
    taskId: `mxtoolbox-${report.generatedAt.slice(0, 10)}`,
    kind: "audit",
    action: "oc.mxtoolbox.blacklist_detected",
    targetType: "mxtoolbox_report",
    targetId: report.generatedAt,
    riskLevel,
    occurredAt: report.generatedAt
  });
}

async function recordDailyReportScratch(
  report: MxtoolboxDailyReportResponse,
  deps: ReadMxtoolboxDailyReportDeps
): Promise<void> {
  if (!deps.recordScratch) return;
  try {
    await deps.recordScratch(report);
  } catch {
    // Postgres-backed memory is optional in local MVP mode; report delivery must continue.
  }
}

function auditMetadata(lookup: MxtoolboxLookupResult): Record<string, unknown> {
  return {
    provider: "mxtoolbox",
    command: lookup.summary.command,
    status: lookup.summary.status,
    source: lookup.cacheHit ? "cached" : "live",
    checkedAt: lookup.summary.checkedAt,
    failedChecks: lookup.summary.failedChecks,
    warningChecks: lookup.summary.warningChecks,
    passedCount: lookup.summary.passedCount,
    timeoutCount: lookup.summary.timeoutCount,
    rawRef: lookup.summary.rawRef,
    responseOk: lookup.source.responseOk,
    ...(lookup.source.errorMessage ? { errorMessage: lookup.source.errorMessage } : {})
  };
}

function summarizeResults(results: MxtoolboxHealthSummary[]): MxtoolboxDailyReportResponse["summary"] {
  return results.reduce(
    (summary, result) => {
      summary[result.status] += 1;
      return summary;
    },
    { clean: 0, warning: 0, listed: 0, error: 0 }
  );
}

function targetType(target: string): "ip" | "domain" {
  return isIpv4(target) ? "ip" : "domain";
}

function csv(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function optionalParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isDomain(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value);
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://127.0.0.1");
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

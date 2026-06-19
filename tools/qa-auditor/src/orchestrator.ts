// Orquestador: el "agente QA Senior". Coordina los 3 subagentes en paralelo,
// agrega y normaliza los hallazgos, computa el veredicto y arma el reporte.
// No hace IO de publicacion (eso es de main.ts): asi es 100% testeable offline.

import type { AnthropicClient } from "./anthropic/client.ts";
import type { AuditContext } from "./context/collect.ts";
import { runAllSubagents } from "./subagents/run.ts";
import type { Finding, Severity } from "./subagents/schema.ts";
import {
  checkConclusion,
  computeVerdict,
  countBySeverity,
  dedupeFindings,
  sortFindings,
  type SeverityCounts,
  type Verdict
} from "./report/verdict.ts";
import {
  renderCheckSummary,
  renderReport,
  type DimensionSummary,
  type ReportInput
} from "./report/render.ts";

export type AuditOutcome = {
  report: string;
  checkSummary: string;
  conclusion: "success" | "failure" | "neutral";
  verdict: Verdict;
  counts: SeverityCounts;
  findings: Finding[];
  perDimension: DimensionSummary[];
  subagentsOk: number;
  subagentsTotal: number;
};

export type RunAuditParams = {
  context: AuditContext;
  anthropic: AnthropicClient;
  model: string;
  maxTokensPerSubagent: number;
  failOn: Severity;
  headSha: string;
  dryRun: boolean;
  // Hallazgos deterministas (no-LLM) a fusionar, p.ej. conflicto de merge.
  extraFindings?: Finding[];
  now?: () => Date;
};

export async function runAudit(params: RunAuditParams): Promise<AuditOutcome> {
  const now = params.now ?? (() => new Date());
  const runs = await runAllSubagents(params.anthropic, params.context, params.maxTokensPerSubagent);

  const collected = [...(params.extraFindings ?? []), ...runs.flatMap((run) => run.result.findings)];
  const allFindings = sortFindings(dedupeFindings(collected));
  const counts = countBySeverity(allFindings);
  const verdict = computeVerdict(allFindings);
  const conclusion = checkConclusion(allFindings, params.failOn);

  const perDimension: DimensionSummary[] = runs.map((run) => ({
    dimension: run.dimension,
    ok: run.ok,
    summary: run.result.summary,
    findingCount: run.result.findings.length,
    error: run.error
  }));

  const subagentsOk = runs.filter((run) => run.ok).length;

  const reportInput: ReportInput = {
    identifier: params.context.identifier,
    kind: params.context.kind,
    model: params.model,
    verdict,
    counts,
    findings: allFindings,
    perDimension,
    changedFileCount: params.context.changedFileCount,
    includedFileCount: params.context.includedFiles.length,
    skippedCount: params.context.skipped.length,
    truncated: params.context.truncated,
    headSha: params.headSha,
    dryRun: params.dryRun,
    generatedAt: now().toISOString()
  };

  return {
    report: renderReport(reportInput),
    checkSummary: renderCheckSummary(reportInput),
    conclusion,
    verdict,
    counts,
    findings: allFindings,
    perDimension,
    subagentsOk,
    subagentsTotal: runs.length
  };
}

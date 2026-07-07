// Render del reporte de auditoria a Markdown (comentario de PR) y a un resumen
// corto para el check run. Texto estructural en ASCII; el texto de cada hallazgo
// viene del modelo en espanol. Sin emojis.

import type { Finding } from "../subagents/schema.ts";
import type { Verdict, SeverityCounts } from "./verdict.ts";

export const COMMENT_MARKER = "<!-- delivrix-qa-auditor -->";

export type DimensionSummary = {
  dimension: string;
  ok: boolean;
  summary: string;
  findingCount: number;
  error?: string;
};

export type ReportInput = {
  identifier: string;
  kind: string;
  model: string;
  verdict: Verdict;
  counts: SeverityCounts;
  findings: Finding[];
  perDimension: DimensionSummary[];
  changedFileCount: number;
  includedFileCount: number;
  skippedCount: number;
  truncated: boolean;
  headSha: string;
  dryRun: boolean;
  generatedAt: string;
};

const VERDICT_LABEL: Record<Verdict, string> = {
  blocked: "BLOCKED (hay bloqueantes)",
  attention: "ATTENTION (revisar antes de mergear)",
  clean: "CLEAN (sin bloqueantes)"
};

const DIMENSION_LABEL: Record<string, string> = {
  security: "Seguridad y Compliance",
  qa_deploy: "QA Funcional y Deploy",
  code_quality: "Calidad de Codigo"
};

function severityTag(severity: string): string {
  return severity.toUpperCase();
}

function countsLine(counts: SeverityCounts): string {
  return `blocker ${counts.blocker} - high ${counts.high} - medium ${counts.medium} - low ${counts.low} - info ${counts.info}`;
}

function renderFinding(finding: Finding, index: number): string {
  const lines = finding.evidence.lines ? ` (lineas ${finding.evidence.lines})` : "";
  const parts = [
    `#### ${index}. [${severityTag(finding.severity)}] ${finding.title}`,
    `Dimension: ${DIMENSION_LABEL[finding.dimension] ?? finding.dimension} - Categoria: ${finding.category} - Confianza: ${finding.confidence}`,
    "",
    `Evidencia: \`${finding.evidence.path}\`${lines}`,
    "",
    finding.detail,
    "",
    `Recomendacion: ${finding.recommendation}`
  ];
  if (finding.evidence.snippet) {
    parts.push("", "```diff", finding.evidence.snippet, "```");
  }
  return parts.join("\n");
}

function renderDimensionTable(perDimension: DimensionSummary[]): string {
  const header = "| Dimension | Estado | Hallazgos | Resumen |\n| --- | --- | --- | --- |";
  const rows = perDimension.map((dim) => {
    const label = DIMENSION_LABEL[dim.dimension] ?? dim.dimension;
    const status = dim.ok ? "OK" : "DEGRADADO";
    const summary = dim.ok ? dim.summary.replace(/\n/g, " ") : `fallo: ${dim.error ?? "desconocido"}`;
    return `| ${label} | ${status} | ${dim.findingCount} | ${summary} |`;
  });
  return [header, ...rows].join("\n");
}

export function renderReport(input: ReportInput): string {
  const okCount = input.perDimension.filter((dim) => dim.ok).length;
  const degraded = okCount < input.perDimension.length;

  const sections: string[] = [
    COMMENT_MARKER,
    "## Delivrix QA Senior - Auditoria automatica",
    "",
    `Objetivo: ${input.identifier} (${input.kind})`,
    `Veredicto: ${VERDICT_LABEL[input.verdict]}`,
    `Severidad: ${countsLine(input.counts)}`,
    `Cobertura: ${input.includedFileCount}/${input.changedFileCount} archivos en el diff` +
      (input.skippedCount > 0 ? `, ${input.skippedCount} omitidos` : "") +
      (input.truncated ? ", diff truncado por presupuesto" : ""),
    `Motor: ${input.model} - subagentes ${okCount}/${input.perDimension.length} OK` +
      (input.dryRun ? " - DRY-RUN (no se publican efectos)" : ""),
    ""
  ];

  if (degraded) {
    sections.push(
      "> Aviso: la auditoria corrio en modo degradado (uno o mas subagentes",
      "> fallaron). Revisa la tabla por dimension y considera re-ejecutar.",
      ""
    );
  }

  sections.push("### Resumen por dimension", "", renderDimensionTable(input.perDimension), "");

  if (input.findings.length === 0) {
    sections.push("### Hallazgos", "", "No se reportaron hallazgos accionables en este cambio.", "");
  } else {
    sections.push("### Hallazgos", "");
    input.findings.forEach((finding, idx) => {
      sections.push(renderFinding(finding, idx + 1), "");
    });
  }

  sections.push(
    "---",
    `Este reporte es advisory. La decision de mergear o desplegar es humana. Commit auditado: \`${input.headSha.slice(0, 7)}\`. Generado: ${input.generatedAt}.`
  );

  return sections.join("\n");
}

export function renderCheckSummary(input: ReportInput): string {
  return [
    `Veredicto: ${VERDICT_LABEL[input.verdict]}`,
    `Severidad: ${countsLine(input.counts)}`,
    `Hallazgos: ${input.findings.length}`
  ].join("\n");
}

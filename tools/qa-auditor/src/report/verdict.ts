// Computo de veredicto y conclusion del check run a partir de los hallazgos.
// El auditor NO aprueba ni mergea: el veredicto es advisory y, opcionalmente,
// marca un check failure para que branch protection exija intervencion humana.

import { SEVERITIES, severityRank, type Finding, type Severity } from "../subagents/schema.ts";

export const VERDICTS = ["blocked", "attention", "clean"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type SeverityCounts = Record<Severity, number>;

export function countBySeverity(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { blocker: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}

export function highestSeverity(findings: Finding[]): Severity | null {
  let top: Severity | null = null;
  for (const finding of findings) {
    if (top === null || severityRank(finding.severity) < severityRank(top)) {
      top = finding.severity;
    }
  }
  return top;
}

export function computeVerdict(findings: Finding[]): Verdict {
  const top = highestSeverity(findings);
  if (top === "blocker") {
    return "blocked";
  }
  if (top === "high" || top === "medium") {
    return "attention";
  }
  return "clean";
}

// Conclusion del check run segun el umbral failOn. failure cuando el hallazgo
// mas grave es al menos tan severo como failOn.
export function checkConclusion(
  findings: Finding[],
  failOn: Severity
): "success" | "failure" | "neutral" {
  const top = highestSeverity(findings);
  if (top === null) {
    return "success";
  }
  return severityRank(top) <= severityRank(failOn) ? "failure" : "neutral";
}

// Dedupe defensivo: elimina hallazgos identicos (misma dimension, archivo y
// titulo). No fusiona entre dimensiones a proposito: un mismo punto puede ser
// valido como riesgo de seguridad y de calidad a la vez.
export function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.dimension}::${finding.evidence.path}::${finding.title.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(finding);
    }
  }
  return out;
}

// Orden estable para presentacion: por severidad (mas grave primero), luego por
// dimension en orden fijo, luego por ruta.
export function sortFindings(findings: Finding[]): Finding[] {
  const dimensionOrder: Record<string, number> = { security: 0, qa_deploy: 1, code_quality: 2 };
  return [...findings].sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) {
      return sev;
    }
    const dim = (dimensionOrder[a.dimension] ?? 9) - (dimensionOrder[b.dimension] ?? 9);
    if (dim !== 0) {
      return dim;
    }
    return a.evidence.path.localeCompare(b.evidence.path);
  });
}

export { SEVERITIES };

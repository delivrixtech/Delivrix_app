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

// Colapsa hallazgos que apuntan al MISMO archivo con rangos de lineas que se
// solapan (tipicamente la misma observacion vista por dos dimensiones). Conserva
// el de mayor severidad (desempate: security > qa_deploy > code_quality) y deja
// una nota corta si el otro era de otra dimension. Reduce ruido sin perder el
// hallazgo mas importante. Solo colapsa cuando ambas evidencias tienen lineas
// parseables y solapadas: hallazgos sin lineas no se tocan.
const DIMENSION_RANK: Record<string, number> = { security: 0, qa_deploy: 1, code_quality: 2 };

function parseLineRange(lines: string | undefined): [number, number] | null {
  if (!lines) {
    return null;
  }
  // Toma TODOS los enteros del string (cubre "12", "1449-1451", "1449, 1502")
  // y usa min/max como region cubierta. Robusto a formatos libres del modelo.
  const nums = (lines.match(/\d+/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) {
    return null;
  }
  return [Math.min(...nums), Math.max(...nums)];
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  if (lo > hi) {
    return false; // disjuntos
  }
  if (lo === hi) {
    // Se tocan en una sola linea: solo fusiona si es EXACTAMENTE el mismo punto
    // (ambos rangos son esa unica linea). Rangos distintos que solo se rozan en
    // un extremo (p.ej. 10-15 y 15-20) NO se fusionan.
    return a[0] === a[1] && b[0] === b[1] && a[0] === b[0];
  }
  return true; // solapan en mas de una linea
}

function mergeFindings(a: Finding, b: Finding): Finding {
  const aWins =
    severityRank(a.severity) < severityRank(b.severity) ||
    (a.severity === b.severity &&
      (DIMENSION_RANK[a.dimension] ?? 9) <= (DIMENSION_RANK[b.dimension] ?? 9));
  const winner = aWins ? a : b;
  const other = aWins ? b : a;
  if (other.dimension !== winner.dimension) {
    return {
      ...winner,
      detail: `${winner.detail} [Mismo punto tambien observado en ${other.dimension} (${other.category}).]`
    };
  }
  return winner;
}

export function collapseByLocation(findings: Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const finding of findings) {
    const range = parseLineRange(finding.evidence.lines);
    let mergedIndex = -1;
    if (range !== null) {
      for (let i = 0; i < kept.length; i += 1) {
        if (kept[i].evidence.path !== finding.evidence.path) {
          continue;
        }
        const keptRange = parseLineRange(kept[i].evidence.lines);
        if (keptRange !== null && rangesOverlap(range, keptRange)) {
          mergedIndex = i;
          break;
        }
      }
    }
    if (mergedIndex >= 0) {
      kept[mergedIndex] = mergeFindings(kept[mergedIndex], finding);
    } else {
      kept.push(finding);
    }
  }
  return kept;
}

export { SEVERITIES };

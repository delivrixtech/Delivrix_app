// Contrato compartido de hallazgos (findings) entre los 3 subagentes,
// el orquestador y el render del reporte. Mantener este modulo libre de IO:
// solo tipos, validacion y normalizacion puras (faciles de testear).

export const SEVERITIES = ["blocker", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DIMENSIONS = ["code_quality", "security", "qa_deploy"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export type Evidence = {
  path: string;
  lines?: string;
  snippet?: string;
};

export type Finding = {
  dimension: Dimension;
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  evidence: Evidence;
  recommendation: string;
  confidence: Confidence;
};

export type SubagentResult = {
  summary: string;
  findings: Finding[];
};

// Orden de severidad de mayor a menor riesgo. Indice mas bajo = mas grave.
const SEVERITY_RANK: Record<Severity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
};

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

// JSON Schema del tool que cada subagente esta forzado a invocar. Forzar
// tool_use elimina el parsing fragil de texto/markdown y nos da salida
// estructurada y validable.
export const REPORT_TOOL_NAME = "report_findings";

export const REPORT_TOOL_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Resumen de 1-3 frases del estado de esta dimension en el cambio."
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: [...SEVERITIES] },
          category: {
            type: "string",
            description: "Etiqueta corta de la clase de problema, p.ej. secret-exposure, n+1, missing-test."
          },
          title: { type: "string", description: "Titulo corto en espanol." },
          detail: {
            type: "string",
            description: "Que es el problema y por que importa antes de produccion."
          },
          evidence: {
            type: "object",
            properties: {
              path: { type: "string", description: "Ruta del archivo afectado." },
              lines: { type: "string", description: "Rango de lineas, p.ej. 12-20." },
              snippet: { type: "string", description: "Fragmento relevante del diff." }
            },
            required: ["path"]
          },
          recommendation: {
            type: "string",
            description: "Accion concreta y verificable para remediar."
          },
          confidence: { type: "string", enum: [...CONFIDENCES] }
        },
        required: ["severity", "category", "title", "detail", "evidence", "recommendation", "confidence"]
      }
    }
  },
  required: ["summary", "findings"]
} as const;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clampText(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 3))}...` : trimmed;
}

function coerceSeverity(value: unknown): Severity {
  return (SEVERITIES as readonly string[]).includes(value as string)
    ? (value as Severity)
    : "info";
}

function coerceConfidence(value: unknown): Confidence {
  return (CONFIDENCES as readonly string[]).includes(value as string)
    ? (value as Confidence)
    : "low";
}

// Normaliza un finding crudo del modelo a la forma canonica. Devuelve null si
// el finding no tiene la informacion minima para ser accionable (sin titulo o
// sin ruta de evidencia), de modo que ruido o alucinaciones no contaminen el
// reporte.
export function normalizeFinding(raw: unknown, dimension: Dimension): Finding | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const evidenceRecord =
    record.evidence !== null && typeof record.evidence === "object"
      ? (record.evidence as Record<string, unknown>)
      : {};

  const title = clampText(asString(record.title), 160);
  const path = clampText(asString(evidenceRecord.path), 240);

  if (title.length === 0 || path.length === 0) {
    return null;
  }

  const evidence: Evidence = { path };
  const lines = clampText(asString(evidenceRecord.lines), 40);
  const snippet = clampText(asString(evidenceRecord.snippet), 600);
  if (lines.length > 0) {
    evidence.lines = lines;
  }
  if (snippet.length > 0) {
    evidence.snippet = snippet;
  }

  return {
    dimension,
    severity: coerceSeverity(record.severity),
    category: clampText(asString(record.category) || "general", 60),
    title,
    detail: clampText(asString(record.detail), 1200),
    evidence,
    recommendation: clampText(asString(record.recommendation), 800),
    confidence: coerceConfidence(record.confidence)
  };
}

// Convierte la salida cruda del tool_use de un subagente en un SubagentResult
// canonico. Tolerante a campos faltantes; nunca lanza.
export function normalizeSubagentResult(raw: unknown, dimension: Dimension): SubagentResult {
  if (raw === null || typeof raw !== "object") {
    return { summary: "", findings: [] };
  }

  const record = raw as Record<string, unknown>;
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];
  const findings: Finding[] = [];

  for (const item of rawFindings) {
    const normalized = normalizeFinding(item, dimension);
    if (normalized !== null) {
      findings.push(normalized);
    }
  }

  return {
    summary: clampText(asString(record.summary), 600),
    findings
  };
}

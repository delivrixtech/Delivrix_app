import type {
  CanvasLiveArtifactBlockKind,
  CanvasLiveArtifactKind
} from "../../../packages/domain/src/index.ts";

export interface ExtractedArtifactBlock {
  order: number;
  kind: CanvasLiveArtifactBlockKind;
  content: string;
}

export interface ExtractedArtifact {
  kind: CanvasLiveArtifactKind;
  title: string;
  blocks: ExtractedArtifactBlock[];
}

const emptyResponse = "OpenClaw respondió sin contenido visible.";

export function extractOpenClawArtifact(responseMd: string, operatorMessage: string): ExtractedArtifact {
  const content = responseMd.trim();
  const fallbackContent = content || emptyResponse;
  const kind = detectArtifactKind(fallbackContent, operatorMessage);
  const title = extractArtifactTitle(fallbackContent, operatorMessage);
  const blocks = partitionIntoBlocks(fallbackContent);

  return {
    kind,
    title,
    blocks: blocks.length > 0 ? blocks : [{
      order: 1,
      kind: "paragraph",
      content: fallbackContent
    }]
  };
}

export function detectArtifactKind(responseMd: string, operatorMessage: string): CanvasLiveArtifactKind {
  const response = responseMd.toLowerCase();
  const prompt = operatorMessage.toLowerCase();
  const promptRequestsTemplate = /\b(template|ejemplo|snippet|genera|muestra el c[oó]digo)\b/.test(prompt);
  const promptRequestsReport = /\b(auditar|audita|analizar|investigar|listar|lista|muestra|consulta|estado|verifica|verificar)\b/.test(prompt);
  const responseHasCodeFence = /(^|\n)```/.test(responseMd);
  const responseMentionsTemplate =
    /\btemplate\b/.test(response) ||
    /\bdkim\b/.test(response) ||
    /\bdmarc\b/.test(response) ||
    /begin pgp/.test(response);
  const responseStartsAsReport = /^#{0,3}\s*(reporte|an[aá]lisis|auditor[ií]a|inventario|estado)\b/im.test(responseMd);

  if (promptRequestsTemplate && (responseHasCodeFence || responseMentionsTemplate)) {
    return "template";
  }

  if (promptRequestsReport && responseStartsAsReport) {
    return "report";
  }

  if (
    /\bpropuesta\b/.test(response) ||
    /\bregisterdomain\b/.test(response) ||
    /doble aprobaci[oó]n/.test(response) ||
    /aprobaci[oó]n humana/.test(response) ||
    /gates? para fase 2/.test(response) ||
    /\bdry-run\b/.test(response)
  ) {
    return "proposal";
  }

  if (
    /^#{0,3}\s*plan\b/im.test(responseMd) ||
    /^#{0,3}\s*pasos?:/im.test(responseMd) ||
    /^#{0,3}\s*roadmap\b/im.test(responseMd) ||
    /^#{0,3}\s*implementaci[oó]n:/im.test(responseMd) ||
    hasNumberedStepList(responseMd)
  ) {
    return "plan";
  }

  if (responseMentionsTemplate) {
    return "template";
  }

  if (
    responseStartsAsReport ||
    /\bresumen\b/.test(response)
  ) {
    return "report";
  }

  if (/\b(proponer|propon|compra|comprar|registrar|configurar)\b/.test(prompt)) {
    return "proposal";
  }
  if (/\b(plan|planificar|preparar|roadmap|implementar|remediar)\b/.test(prompt)) {
    return "plan";
  }
  if (promptRequestsTemplate) {
    return "template";
  }
  return "report";
}

export function summarizeOpenClawTaskTitle(operatorMessage: string): string {
  const message = operatorMessage.trim();
  const lower = message.toLowerCase();

  const purchase = lower.match(/compra\s+de\s+["']?([^"'\s]+)["']?/);
  if (purchase?.[1]) {
    return `Propuesta - ${purchase[1]}`;
  }

  const audit = lower.match(/audit[aoí]r?\s+(?:el|los|las)?\s*([a-z0-9\s.-]{3,40})/);
  if (audit?.[1]) {
    return `Auditoria - ${audit[1].trim()}`;
  }

  const verify = lower.match(/(?:verifica|comprueba|consulta)\s+(.{3,50})/);
  if (verify?.[1]) {
    return `Verificacion - ${cleanTitle(verify[1])}`;
  }

  const list = lower.match(/(?:lista|enlista|muestra|ensena|enseña)\s+(.{3,50})/);
  if (list?.[1]) {
    return `Listado - ${cleanTitle(list[1])}`;
  }

  if (!message) {
    return "Respuesta OpenClaw";
  }
  return message.length > 60 ? `${message.slice(0, 60)}...` : message;
}

function extractArtifactTitle(responseMd: string, operatorMessage: string): string {
  const firstLine = responseMd.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) {
    return summarizeOpenClawTaskTitle(operatorMessage);
  }
  const withoutMarkdown = firstLine
    .replace(/^#{1,3}\s+/, "")
    .replace(/^(propuesta|plan|reporte|template|an[aá]lisis|auditor[ií]a):\s*/i, "")
    .replace(/^[^\p{Letter}\p{Number}]+/u, "")
    .trim();
  const title = withoutMarkdown || summarizeOpenClawTaskTitle(operatorMessage);
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function partitionIntoBlocks(responseMd: string): ExtractedArtifactBlock[] {
  const blocks: ExtractedArtifactBlock[] = [];
  const lines = responseMd.split("\n");
  let order = 0;
  let buffer: string[] = [];
  let bufferKind: CanvasLiveArtifactBlockKind = "paragraph";

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) {
      order += 1;
      blocks.push({ order, kind: bufferKind, content });
    }
    buffer = [];
    bufferKind = "paragraph";
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const stripped = line.trim();

    if (isHeading(stripped) || isEmojiSection(stripped)) {
      flush();
      buffer = [line];
      bufferKind = order === 0 ? "title" : "paragraph";
      index += 1;
      continue;
    }

    if (stripped.startsWith("```")) {
      flush();
      const codeLines = [line];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        codeLines.push(lines[index]);
        index += 1;
      }
      order += 1;
      blocks.push({ order, kind: "code", content: codeLines.join("\n").trim() });
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      flush();
      const tableLines = [line];
      index += 1;
      while (index < lines.length && lines[index].includes("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      order += 1;
      blocks.push({ order, kind: "table_row", content: tableLines.join("\n").trim() });
      continue;
    }

    buffer.push(line);
    index += 1;
  }

  flush();
  return blocks;
}

function isHeading(value: string): boolean {
  return /^#{1,3}\s+/.test(value);
}

function isEmojiSection(value: string): boolean {
  return !value.startsWith("|") && /^[^\p{Letter}\p{Number}\s]\s+\S/u.test(value);
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const current = lines[index]?.trim() ?? "";
  const next = lines[index + 1]?.trim() ?? "";
  return current.includes("|") && /^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?$/.test(next);
}

function hasNumberedStepList(value: string): boolean {
  const matches = value.match(/^\s*\d+\.\s+\S+/gm) ?? [];
  return matches.length >= 2;
}

function cleanTitle(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > 50 ? `${cleaned.slice(0, 47)}...` : cleaned;
}

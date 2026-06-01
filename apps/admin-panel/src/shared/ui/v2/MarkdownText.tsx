/**
 * MarkdownText — renderer minimalista de markdown que devuelve JSX directo
 * (no HTML strings → no riesgo XSS, React escapa el texto automáticamente).
 *
 * Cubre lo que OpenClaw devuelve via Bedrock:
 * - Headers (## ### ####)
 * - Hrules (---)
 * - Bold (**text**) e italic (*text*)
 * - Inline code (`text`)
 * - Code blocks (```lang ... ```)
 * - Listas con "- " "* " "1. " (consecutivas se agrupan).
 * - Tablas (| col | col |) con header row opcional.
 * - Links [text](url) — solo target externos seguros (https/http).
 *
 * NO cubre: HTML raw embebido, blockquotes anidados, footnotes, task lists.
 * Si OpenClaw empieza a devolver algo más sofisticado, considerar react-markdown.
 */

import type { ReactNode } from "react";
import { Fragment } from "react";

interface MarkdownTextProps {
  /** Texto markdown crudo. */
  children: string;
  /** Tamaño de fuente base en px. Default 12. */
  fontSize?: number;
  /** Si true, el texto base tiene color text-secondary (default text-primary). */
  muted?: boolean;
}

export function MarkdownText({ children, fontSize = 12, muted = false }: MarkdownTextProps) {
  const blocks = parseBlocks(children);
  const baseColor = muted ? "var(--color-text-secondary)" : "var(--color-text-primary)";
  return (
    <div
      className="font-[family-name:var(--font-body)]"
      style={{ fontSize, lineHeight: 1.55, color: baseColor }}
    >
      {blocks.map((block, i) => (
        <Fragment key={i}>{renderBlock(block, fontSize)}</Fragment>
      ))}
    </div>
  );
}

/* ============================================================
 * Block-level parser
 * ============================================================ */

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "hr" }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang: string | null; content: string }
  | { kind: "table"; header: string[]; rows: string[][] };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code fence
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim() || null;
      const content: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        content.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push({ kind: "code", lang, content: content.join("\n") });
      continue;
    }

    // Hrule
    if (/^---+\s*$/.test(trimmed) || /^\*\*\*+\s*$/.test(trimmed)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    // Header
    const headerMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headerMatch) {
      const level = Math.min(headerMatch[1].length, 4) as 1 | 2 | 3 | 4;
      blocks.push({ kind: "h", level, text: headerMatch[2].trim() });
      i++;
      continue;
    }

    // Table (al menos 2 líneas: header + separator |---|---|)
    if (
      trimmed.startsWith("|") &&
      trimmed.endsWith("|") &&
      i + 1 < lines.length &&
      /^\|[-:|\s]+\|$/.test(lines[i + 1].trim())
    ) {
      const header = splitTableRow(trimmed);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length) {
        const row = lines[i].trim();
        if (!row.startsWith("|") || !row.endsWith("|")) break;
        rows.push(splitTableRow(row));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // List (- item / * item / N. item)
    const listMatch = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(lines[i]);
        if (!m) break;
        const itemOrdered = /\d+\./.test(m[2]);
        if (itemOrdered !== ordered) break; // distinto tipo de lista → corta bloque
        items.push(m[3].trim());
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Blank line → ignora pero termina párrafo
    if (trimmed === "") {
      i++;
      continue;
    }

    // Párrafo (acumula líneas consecutivas no especiales).
    const paraLines: string[] = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (t === "") break;
      if (t.startsWith("```")) break;
      if (/^---+\s*$/.test(t)) break;
      if (/^(#{1,4})\s+/.test(t)) break;
      if (/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])) break;
      if (t.startsWith("|") && t.endsWith("|")) break;
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ kind: "p", lines: paraLines });
    }
  }
  return blocks;
}

function splitTableRow(row: string): string[] {
  // "|  col1  |  col2  |" → ["col1", "col2"]
  return row
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

/* ============================================================
 * Block renderer
 * ============================================================ */

function renderBlock(block: Block, baseFontSize: number): ReactNode {
  if (block.kind === "hr") {
    return (
      <hr
        style={{
          border: "none",
          borderTop: "1px solid var(--color-border)",
          margin: "10px 0"
        }}
      />
    );
  }
  if (block.kind === "h") {
    const sizeBoost = { 1: 6, 2: 4, 3: 2, 4: 1 }[block.level];
    return (
      <div
        className="font-[family-name:var(--font-sans)] font-semibold"
        style={{
          fontSize: baseFontSize + sizeBoost,
          color: "var(--color-text-primary)",
          marginTop: 12,
          marginBottom: 4,
          letterSpacing: "var(--tracking-tight)"
        }}
      >
        {renderInline(block.text)}
      </div>
    );
  }
  if (block.kind === "p") {
    // Pseudo-heading: líneas cortas que terminan en ":" y vienen solas
    // (ej. "Resumen operativo:") se rendean con peso 500 + margen extra
    // para que actúen como subtítulo suave, sin esperar que el agente
    // use ## explícito.
    const isPseudoHeading =
      block.lines.length === 1 &&
      block.lines[0].trim().endsWith(":") &&
      block.lines[0].trim().length <= 60 &&
      !block.lines[0].trim().includes(". ");
    if (isPseudoHeading) {
      return (
        <p
          className="font-[family-name:var(--font-sans)]"
          style={{
            margin: "14px 0 6px",
            fontWeight: 500,
            color: "var(--color-text-primary)"
          }}
        >
          {renderInline(block.lines[0])}
        </p>
      );
    }
    return (
      <p style={{ margin: "10px 0", whiteSpace: "pre-wrap" }}>
        {block.lines.map((line, i) => (
          <Fragment key={i}>
            {i > 0 ? <br /> : null}
            {renderInline(line)}
          </Fragment>
        ))}
      </p>
    );
  }
  if (block.kind === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag
        style={{
          margin: "10px 0",
          paddingLeft: block.ordered ? 28 : 22,
          listStyleType: block.ordered ? "decimal" : "disc",
          display: "flex",
          flexDirection: "column",
          gap: 6
        }}
      >
        {block.items.map((item, i) => (
          <li key={i} style={{ paddingLeft: 4 }}>
            {renderInline(item)}
          </li>
        ))}
      </Tag>
    );
  }
  if (block.kind === "code") {
    return (
      <pre
        style={{
          margin: "8px 0",
          padding: "10px 12px",
          borderRadius: 6,
          background: "var(--color-always-dark-surface)",
          border: "1px solid var(--color-always-dark-border)",
          color: "var(--color-on-dark-strong)",
          fontFamily: "var(--font-mono)",
          fontSize: baseFontSize - 1,
          lineHeight: 1.5,
          overflowX: "auto",
          whiteSpace: "pre"
        }}
      >
        {block.lang ? (
          <div
            style={{
              fontSize: 10,
              color: "var(--color-on-dark-soft)",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "var(--tracking-wider)"
            }}
          >
            {block.lang}
          </div>
        ) : null}
        <code>{block.content}</code>
      </pre>
    );
  }
  if (block.kind === "table") {
    return (
      <div style={{ margin: "8px 0", overflowX: "auto" }}>
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: baseFontSize - 1,
            width: "100%"
          }}
        >
          <thead>
            <tr>
              {block.header.map((h, i) => (
                <th
                  key={i}
                  style={{
                    textAlign: "left",
                    padding: "6px 10px",
                    borderBottom: "1px solid var(--color-border-strong)",
                    background: "var(--color-surface-sunken)",
                    fontWeight: 600,
                    color: "var(--color-text-primary)"
                  }}
                >
                  {renderInline(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    style={{
                      padding: "6px 10px",
                      borderBottom: "1px solid var(--color-border)",
                      verticalAlign: "top"
                    }}
                  >
                    {renderInline(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

/* ============================================================
 * Inline parser (bold, italic, code, links)
 * ============================================================ */

/**
 * Parser inline simple — tokeniza con una pasada usando regex global.
 * Reconoce: `code`, **bold**, *italic*, [text](url).
 *
 * NO usa innerHTML; cada segmento se vuelve un ReactNode. Si entra HTML
 * en el texto, React lo escapará como texto (XSS-safe).
 */
const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    parts.push(renderInlineToken(token, parts.length));
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.map((p, i) => <Fragment key={i}>{p}</Fragment>);
}

function renderInlineToken(token: string, idx: number): ReactNode {
  // `code`
  if (token.startsWith("`") && token.endsWith("`")) {
    return (
      <code
        key={idx}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.92em",
          padding: "1px 5px",
          borderRadius: 3,
          background: "var(--color-surface-sunken)",
          color: "var(--color-accent-tertiary)"
        }}
      >
        {token.slice(1, -1)}
      </code>
    );
  }
  // **bold**
  if (token.startsWith("**") && token.endsWith("**")) {
    return (
      <strong key={idx} style={{ fontWeight: 600 }}>
        {token.slice(2, -2)}
      </strong>
    );
  }
  // *italic*
  if (token.startsWith("*") && token.endsWith("*")) {
    return <em key={idx}>{token.slice(1, -1)}</em>;
  }
  // [text](url)
  const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
  if (linkMatch) {
    const [, textPart, urlPart] = linkMatch;
    // Solo permitir http/https/mailto para evitar javascript: schemes.
    const safe = /^(https?:|mailto:)/i.test(urlPart);
    if (!safe) {
      return <span key={idx}>{textPart}</span>;
    }
    return (
      <a
        key={idx}
        href={urlPart}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "var(--color-accent-tertiary)",
          textDecoration: "underline"
        }}
      >
        {textPart}
      </a>
    );
  }
  return token;
}

/**
 * DarkCliSnippet: panel oscuro estilo terminal con header (titulo + boton copy)
 * y body con multiples lineas. Cada linea puede tener tono distinto:
 * - "input" cream para comandos del usuario.
 * - "info" yellow para progreso.
 * - "success" green para confirmaciones.
 * - "error" red para fallos.
 *
 * Los colores del terminal son INTENCIONALES (paleta GitHub-style terminal)
 * y NO deben invertir con el tema porque el block es siempre dark surface.
 * Definidos como tokens fijos en lugar de --color-* que se invierten.
 *
 * Pencil component `WIXCb` (Component / CLI Snippet).
 */

import { Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn.ts";

export type CliLineTone = "input" | "info" | "success" | "error";

export interface CliLine {
  tone: CliLineTone;
  text: string;
}

export interface DarkCliSnippetProps {
  /** Titulo del header del CLI panel. */
  title: string;
  /** Lineas a mostrar. */
  lines: CliLine[];
  /** Si true, agrega los 3 dots tipo macOS al header. Default true. */
  showWindowDots?: boolean;
  className?: string;
}

const toneToColor: Record<CliLineTone, string> = {
  input: "var(--color-on-dark-strong)",
  info: "var(--color-accent-secondary)",
  success: "var(--color-success-border)",
  error: "var(--color-critical-border)"
};

export function DarkCliSnippet({ title, lines, showWindowDots = true, className }: DarkCliSnippetProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = lines.map((line) => line.text).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* user agent without clipboard permission — ignore */
    }
  };

  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface-inverse)] overflow-hidden",
        className
      )}
      role="region"
      aria-label={title}
    >
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-on-dark-hint)] px-4 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          {showWindowDots ? (
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--color-on-dark-faint)]" />
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--color-on-dark-faint)]" />
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--color-on-dark-faint)]" />
            </div>
          ) : null}
          <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-on-dark-medium)] truncate">
            {title}
          </span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-on-dark-hint)] px-2 py-1 text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-on-dark-medium)] transition-colors hover:bg-[var(--color-on-dark-faint)] hover:text-[var(--color-on-dark-strong)]"
          aria-label="Copiar snippet"
        >
          <Copy size={11} strokeWidth={1.75} aria-hidden="true" />
          <span>{copied ? "copiado" : "copy"}</span>
        </button>
      </header>
      <pre className="m-0 px-5 py-4 overflow-x-auto">
        <code className="block text-[12px] font-[family-name:var(--font-mono)] leading-relaxed">
          {lines.map((line, i) => (
            <span key={i} className="block whitespace-pre" style={{ color: toneToColor[line.tone] }}>
              {line.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

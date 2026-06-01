/**
 * OpenClawPromptPanel: side panel/card que muestra el contexto del agente
 * OpenClaw + un input fake "Reply to OpenClaw…" + CTA "Suggested next step".
 *
 * El input es READ-ONLY visual; el panel NO postea nada. La interaccion real
 * con OpenClaw vive fuera del admin panel (CLI / Kiro / Claude Code).
 *
 * Pencil component `onENN` (Tarjeta de prompt OpenClaw).
 */

import { ArrowUp, Sparkles, WandSparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export interface OpenClawPromptPanelProps {
  /** Mensaje principal del agente. */
  message: ReactNode;
  /** Placeholder del input (decorativo). */
  placeholder?: string;
  /** Texto del boton CTA. */
  ctaLabel?: string;
  /** onClick para el CTA — read-only por defecto, no postea. */
  onCta?: () => void;
  /** Subtitulo bajo "OpenClaw". */
  subtitle?: string;
  className?: string;
}

export function OpenClawPromptPanel({
  message,
  placeholder = "Reply to OpenClaw…",
  ctaLabel = "Suggested next step",
  onCta,
  subtitle = "Supervised AI operator",
  className
}: OpenClawPromptPanelProps) {
  return (
    <aside
      className={cn(
        "flex flex-col gap-3.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-[18px] shadow-[var(--shadow-md)]",
        className
      )}
      aria-label="OpenClaw prompt"
    >
      <header className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[var(--color-accent-fg)]"
          style={{
            background: "var(--color-accent)"
          }}
        >
          <Sparkles size={14} strokeWidth={1.75} />
        </span>
        <div className="flex flex-col gap-0 min-w-0">
          <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)] leading-tight">
            OpenClaw
          </span>
          <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)] leading-tight">
            {subtitle}
          </span>
        </div>
      </header>

      <p className="m-0 text-[13px] leading-relaxed text-[var(--color-text-primary)]">{message}</p>

      <div
        aria-hidden="true"
        className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-sunken)] px-2.5 py-3 cursor-default"
        title="El admin panel no postea — esta interaccion es de referencia visual."
      >
        <span className="flex-1 min-w-0 text-[12px] text-[var(--color-text-tertiary)] truncate">
          {placeholder}
        </span>
        <ArrowUp size={14} strokeWidth={1.75} className="text-[var(--color-text-tertiary)] shrink-0" />
      </div>

      <button
        type="button"
        onClick={onCta}
        disabled={!onCta}
        className="inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-surface-inverse)] px-3 py-2.5 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-100 focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
      >
        <WandSparkles size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>{ctaLabel}</span>
      </button>
    </aside>
  );
}

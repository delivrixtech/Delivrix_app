/**
 * MiniBar: progress bar horizontal con caption opcional.
 *
 * Se usa para porcentajes en KPIs (CPU, RAM, etc.) y readiness signals.
 * Pencil component `wa9QQ`.
 */

import type { Tone } from "../lib/formatters.ts";
import { cn } from "../lib/cn.ts";

export interface MiniBarProps {
  /** Valor entre 0 y 1 (o 0-100 si percent=true). */
  value: number;
  /** Si true, el valor llega en escala 0-100. Default true. */
  percent?: boolean;
  /** Tono del fill. Default "accent". */
  tone?: Tone | "accent";
  /** Caption opcional debajo (ej "62%"). */
  caption?: string;
  className?: string;
}

const toneToColor: Record<Tone | "accent", string> = {
  accent: "var(--color-accent)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  critical: "var(--color-critical)",
  neutral: "var(--color-text-tertiary)"
};

export function MiniBar({ value, percent = true, tone = "accent", caption, className }: MiniBarProps) {
  const ratio = Math.max(0, Math.min(1, percent ? value / 100 : value));
  const color = toneToColor[tone];

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div
        role="progressbar"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]"
      >
        <span
          aria-hidden="true"
          className="block h-full rounded-full"
          style={{ width: `${ratio * 100}%`, background: color }}
        />
      </div>
      {caption ? (
        <span className="text-[10px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] tabular-nums">
          {caption}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Sparkline: serie de barras verticales chicas que se usa dentro de KPIs.
 *
 * Cada barra tiene altura proporcional al value de la serie. Color por tono
 * (accent, success, warning, critical, neutral). Estilo Pencil: barras de 8px
 * de ancho con gap de 2px, cornerRadius 2.
 *
 * Mas info: Pencil component `b2wJZ` (Barra de gráfico) + composicion N barras.
 */

import type { Tone } from "../lib/formatters.ts";
import { cn } from "../lib/cn.ts";

export interface SparklineProps {
  /** Valores de la serie. Las barras se normalizan al max de la serie. */
  values: number[];
  /** Altura total del sparkline en pixels. Default 32. */
  height?: number;
  /** Color por tono. Default "accent" (amber). */
  tone?: Tone | "accent";
  className?: string;
}

const toneToColor: Record<Tone | "accent", string> = {
  accent: "var(--color-accent)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  critical: "var(--color-critical)",
  neutral: "var(--color-text-tertiary)"
};

export function Sparkline({ values, height = 32, tone = "accent", className }: SparklineProps) {
  if (values.length === 0) {
    return (
      <div
        className={cn("flex items-end gap-[2px]", className)}
        style={{ height }}
        aria-hidden="true"
      />
    );
  }
  const max = Math.max(...values, 1);
  const color = toneToColor[tone];

  return (
    <div
      className={cn("flex items-end gap-[2px]", className)}
      style={{ height }}
      role="img"
      aria-label={`Sparkline con ${values.length} valores`}
    >
      {values.map((v, i) => {
        const ratio = Math.max(0.06, v / max);
        return (
          <span
            key={i}
            aria-hidden="true"
            className="rounded-[2px]"
            style={{
              height: `${Math.round(ratio * height)}px`,
              width: 6,
              background: color,
              opacity: 0.6 + 0.4 * ratio
            }}
          />
        );
      })}
    </div>
  );
}

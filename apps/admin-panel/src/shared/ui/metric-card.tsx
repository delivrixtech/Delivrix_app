import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Card } from "./card.tsx";
import type { Tone as FormatterTone } from "../lib/formatters.ts";

/**
 * KPI card. label + value + microcopy with semantic tone in the microcopy line.
 * The card itself stays neutral (Stripe/Notion: cards don't carry the alarm,
 * the microcopy text color does).
 */

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  microcopy?: ReactNode;
  microcopyTone?: FormatterTone;
  className?: string;
}

const microcopyToneClass: Record<FormatterTone, string> = {
  neutral: "text-[var(--color-text-tertiary)]",
  success: "text-[var(--color-success-fg)]",
  warning: "text-[var(--color-warning-fg)]",
  critical: "text-[var(--color-critical-fg)]"
};

export function MetricCard({ label, value, microcopy, microcopyTone = "neutral", className }: MetricCardProps) {
  return (
    <Card className={cn("bg-[var(--color-surface-sunken)] border-transparent", className)}>
      <div className="flex flex-col gap-1.5 px-4 py-3.5">
        <p className="m-0 text-[12px] text-[var(--color-text-secondary)]">{label}</p>
        <p className="m-0 text-[20px] font-medium leading-tight text-[var(--color-text-primary)] tabular-nums">
          {value}
        </p>
        {microcopy ? (
          <p className={cn("m-0 text-[11px] leading-snug", microcopyToneClass[microcopyTone])}>
            {microcopy}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

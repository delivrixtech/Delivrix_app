import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export interface SectionDividerProps {
  title: string;
  count?: number | string;
  countTone?: "warning" | "critical" | "success" | "neutral";
  caption?: ReactNode;
  className?: string;
}

const countToneMap = {
  success: { bg: "var(--color-success-soft)", fg: "var(--color-success)" },
  warning: { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" },
  critical: { bg: "var(--color-critical-soft)", fg: "var(--color-critical)" },
  neutral: { bg: "var(--color-surface-sunken)", fg: "var(--color-text-tertiary)" }
} as const;

export function SectionDivider({ title, count, countTone = "warning", caption, className }: SectionDividerProps) {
  const tone = countToneMap[countTone];
  return (
    <header
      className={cn("flex items-center", className)}
      style={{ gap: 12, height: 28 }}
    >
      <h3
        className="m-0 font-[family-name:var(--font-heading)] font-semibold leading-none"
        style={{ fontSize: 14, color: "var(--color-text-primary)" }}
      >
        {title}
      </h3>
      {count != null ? (
        <span
          className="inline-flex items-center font-[family-name:var(--font-mono)] font-semibold leading-none"
          style={{
            padding: "2px 8px",
            borderRadius: "var(--radius-sm)",
            background: tone.bg,
            color: tone.fg,
            fontSize: 10
          }}
        >
          {count}
        </span>
      ) : null}
      <span aria-hidden="true" className="flex-1" style={{ height: 1, background: "var(--color-border)" }} />
      {caption ? (
        <span
          className="font-[family-name:var(--font-caption)] leading-none"
          style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
        >
          {caption}
        </span>
      ) : null}
    </header>
  );
}

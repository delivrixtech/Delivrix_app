import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn.ts";

export interface KpiCardV2Props {
  label: string;
  icon: LucideIcon;
  value: string | number;
  delta?: string;
  deltaTone?: "success" | "warning" | "critical" | "neutral";
  className?: string;
}

const deltaToneMap = {
  success: { bg: "var(--color-success-soft)", fg: "var(--color-success)" },
  warning: { bg: "var(--color-warning-soft)", fg: "var(--color-warning)" },
  critical: { bg: "var(--color-critical-soft)", fg: "var(--color-critical)" },
  neutral: { bg: "var(--color-surface-sunken)", fg: "var(--color-text-tertiary)" }
} as const;

export function KpiCardV2({ label, icon: Icon, value, delta, deltaTone = "neutral", className }: KpiCardV2Props) {
  const tone = deltaToneMap[deltaTone];
  return (
    <article
      className={cn("flex flex-col", className)}
      style={{
        gap: 8,
        padding: 20,
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        minWidth: 0
      }}
    >
      <div className="flex items-center" style={{ gap: 8, height: 20 }}>
        <Icon size={16} strokeWidth={1.75} style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }} aria-hidden="true" />
        <span
          className="font-[family-name:var(--font-caption)] font-semibold leading-none truncate"
          style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
        >
          {label}
        </span>
      </div>
      <span
        className="font-[family-name:var(--font-heading)] font-semibold leading-none tabular-nums"
        style={{ fontSize: 32, color: "var(--color-text-primary)" }}
      >
        {value}
      </span>
      {delta ? (
        <span
          className="inline-flex w-fit items-center font-[family-name:var(--font-mono)] font-semibold leading-none"
          style={{
            padding: "2px 8px",
            borderRadius: "var(--radius-sm)",
            background: tone.bg,
            color: tone.fg,
            fontSize: 10
          }}
        >
          {delta}
        </span>
      ) : null}
    </article>
  );
}

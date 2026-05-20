import { Clock3 } from "lucide-react";
import { cn } from "../../lib/cn.ts";

export interface StaleBadgeProps {
  minutesAgo: number;
  className?: string;
}

export function formatStaleBadgeLabel(minutesAgo: number): string {
  const value = Number.isFinite(minutesAgo) ? Math.max(0, Math.floor(minutesAgo)) : 0;
  return `Hace ${value} min`;
}

export function StaleBadge({ minutesAgo, className }: StaleBadgeProps) {
  const label = formatStaleBadgeLabel(minutesAgo);

  return (
    <span
      aria-label={`Datos cacheados: ${label}`}
      className={cn("inline-flex shrink-0 items-center", className)}
      style={{
        gap: 6,
        padding: "4px 10px",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-warning-soft)",
        color: "var(--color-warning)"
      }}
    >
      <Clock3 size={12} strokeWidth={1.75} aria-hidden="true" />
      <span
        className="font-[family-name:var(--font-mono)] font-normal leading-none"
        style={{ fontSize: 11 }}
      >
        {label}
      </span>
    </span>
  );
}

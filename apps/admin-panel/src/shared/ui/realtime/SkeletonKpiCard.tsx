import { cn } from "../../lib/cn.ts";

export interface SkeletonKpiCardProps {
  className?: string;
}

export function SkeletonKpiCard({ className }: SkeletonKpiCardProps) {
  return (
    <article
      aria-label="Cargando KPI"
      className={cn("flex flex-col", className)}
      style={{
        gap: 12,
        padding: "16px 20px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        width: 220,
        maxWidth: "100%"
      }}
    >
      <span
        className="realtime-skeleton-shimmer block"
        style={{ width: 80, height: 10, borderRadius: "var(--radius-sm)", background: "var(--color-neutral-soft)" }}
      />
      <span
        className="realtime-skeleton-shimmer block"
        style={{ width: 60, height: 24, borderRadius: "var(--radius-sm)", background: "var(--color-neutral-soft)" }}
      />
      <span
        className="realtime-skeleton-shimmer block"
        style={{ width: 120, height: 8, borderRadius: "var(--radius-sm)", background: "var(--color-neutral-soft)" }}
      />
    </article>
  );
}

import { cn } from "../../lib/cn.ts";

export interface SkeletonRowProps {
  className?: string;
}

export function SkeletonRow({ className }: SkeletonRowProps) {
  return (
    <div
      aria-label="Cargando fila"
      className={cn("flex w-full items-center", className)}
      style={{
        gap: 12,
        padding: "12px 16px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)"
      }}
    >
      <span
        className="realtime-skeleton-shimmer block shrink-0"
        style={{ width: 80, height: 10, borderRadius: "var(--radius-sm)", background: "var(--color-neutral-soft)" }}
      />
      <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 6 }}>
        <span
          className="realtime-skeleton-shimmer block w-full"
          style={{ height: 12, borderRadius: "var(--radius-sm)", background: "var(--color-neutral-soft)" }}
        />
        <span
          className="realtime-skeleton-shimmer block"
          style={{ width: 160, maxWidth: "70%", height: 8, borderRadius: "var(--radius-sm)", background: "var(--color-neutral-soft)" }}
        />
      </span>
      <span
        className="realtime-skeleton-shimmer block shrink-0"
        style={{ width: 60, height: 20, borderRadius: "var(--radius-sm)", background: "var(--color-neutral-soft)" }}
      />
    </div>
  );
}

/**
 * Skeleton primitives v2.
 *
 * Reemplazo de los spinners genéricos por bloques placeholder con shimmer
 * animation. Patrón: misma estructura que el contenido real, solo que con
 * fondo gradient animado. Reduce el CLS (Cumulative Layout Shift) cuando
 * llega data porque el espacio ya está reservado.
 *
 * Estilo inspirado en Linear / Stripe / Vercel — sutil, sin spinners.
 */

import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

interface SkeletonBaseProps {
  className?: string;
  style?: CSSProperties;
  /** Si true, el bloque pierde el shimmer (útil para placeholders estáticos). */
  noShimmer?: boolean;
  /** Override del color base del bloque. */
  tone?: "default" | "sunken";
}

/** Bloque rectangular base. Acepta width/height via style. */
export function SkeletonBlock({ className, style, noShimmer, tone = "default" }: SkeletonBaseProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "delivrix-skeleton inline-block rounded-[var(--radius-sm)]",
        noShimmer ? "delivrix-skeleton--static" : "delivrix-skeleton--shimmer",
        tone === "sunken" ? "delivrix-skeleton--sunken" : "delivrix-skeleton--default",
        className
      )}
      style={style}
    />
  );
}

/** Línea de texto. Width controlable como prop (% string o num px). */
export function SkeletonText({
  width = "100%",
  height = 12,
  className,
  ...rest
}: SkeletonBaseProps & {
  width?: string | number;
  height?: number;
}) {
  return (
    <SkeletonBlock
      {...rest}
      className={cn("rounded-[3px]", className)}
      style={{ width, height, ...(rest.style ?? {}) }}
    />
  );
}

/** Pill / chip oval. */
export function SkeletonPill({
  width = 64,
  height = 18,
  className,
  ...rest
}: SkeletonBaseProps & {
  width?: string | number;
  height?: number;
}) {
  return (
    <SkeletonBlock
      {...rest}
      className={cn("rounded-full", className)}
      style={{ width, height, ...(rest.style ?? {}) }}
    />
  );
}

/** Card placeholder: shell con padding y children. Mantiene el chrome real. */
export function SkeletonCard({
  children,
  className,
  style
}: {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4",
        className
      )}
      style={style}
    >
      {children ?? (
        <>
          <SkeletonText width="60%" height={12} />
          <SkeletonText width="40%" height={24} />
          <SkeletonText width="80%" height={10} tone="sunken" />
        </>
      )}
    </div>
  );
}

/** Row de tabla con N columnas. Útil para tablas listadas. */
export function SkeletonRow({
  columns = 4,
  gap = 12,
  className
}: {
  columns?: number;
  gap?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("grid items-center", className)}
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))`,
        gap,
        padding: "10px 12px"
      }}
    >
      {Array.from({ length: columns }, (_, i) => (
        <SkeletonText
          key={i}
          width={i === columns - 1 ? "40%" : "70%"}
          height={11}
        />
      ))}
    </div>
  );
}

/** KPI card placeholder. Replica el layout de KpiShell de Overview. */
export function SkeletonKpiCard() {
  return (
    <SkeletonCard>
      <div className="flex items-center gap-2">
        <SkeletonText width="40%" height={10} />
        <span className="flex-1" aria-hidden="true" />
        <SkeletonPill width={48} height={14} />
      </div>
      <SkeletonText width="50%" height={28} />
      <SkeletonText width="60%" height={10} tone="sunken" />
    </SkeletonCard>
  );
}

/** Grid de KPI cards (N cards). */
export function SkeletonKpiGrid({ count = 4 }: { count?: number }) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: 14
      }}
    >
      {Array.from({ length: count }, (_, i) => (
        <SkeletonKpiCard key={i} />
      ))}
    </div>
  );
}

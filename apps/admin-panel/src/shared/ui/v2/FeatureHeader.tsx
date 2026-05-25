import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

/**
 * FeatureHeader v2 — kicker eyebrow + h1 + lead + slot opcional para LiveIndicator
 * (o cualquier nodo a la derecha como pill de estado, badge mock/live, etc).
 *
 * Reemplaza el patrón duplicado en los 9 features (Overview, Onboarding, Hardware,
 * Collector, Clusters, Canvas, Learning, Safety, ChatWidget). Antes cada feature
 * repetía ~30-40 LOC con kicker UPPERCASE + dot separator + título 28px + lead 14px.
 *
 * Audit FE senior P1 cross-cutting #4: "9 PageHeaders duplicados con la misma
 * estructura → falta FeatureHeader v2".
 */
export interface FeatureHeaderProps {
  /** Eyebrow ALL CAPS color accent-tertiary. Ej: "INICIO OPERATIVO", "SEGURIDAD Y GOBIERNO". */
  eyebrow: string;
  /** Título principal h1 28px. */
  title: string;
  /** Lead paragraph 14px text-secondary. */
  lead?: ReactNode;
  /** Pill/badge inline al lado del eyebrow (ej. timestamp, mock/live, source). */
  eyebrowSuffix?: ReactNode;
  /** Slot a la derecha del header — típicamente <LiveIndicator>. Usar `shrink-0`. */
  rightSlot?: ReactNode;
  className?: string;
}

export function FeatureHeader({
  eyebrow,
  title,
  lead,
  eyebrowSuffix,
  rightSlot,
  className
}: FeatureHeaderProps) {
  return (
    <header
      className={cn("flex items-start", className)}
      style={{ gap: 16 }}
    >
      <div className="flex flex-col min-w-0 flex-1" style={{ gap: 6 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span
            className="font-[family-name:var(--font-caption)] font-bold uppercase"
            style={{ fontSize: 11, letterSpacing: "1.2px", color: "var(--color-accent-tertiary)" }}
          >
            {eyebrow}
          </span>
          {eyebrowSuffix ? (
            <>
              <span
                aria-hidden="true"
                style={{
                  width: 4,
                  height: 4,
                  borderRadius: 2,
                  background: "var(--color-text-tertiary)"
                }}
              />
              {eyebrowSuffix}
            </>
          ) : null}
        </div>
        <h1
          className="m-0 font-[family-name:var(--font-heading)] font-bold leading-tight"
          style={{
            fontSize: 28,
            letterSpacing: "-0.4px",
            color: "var(--color-text-primary)",
            lineHeight: 1.1
          }}
        >
          {title}
        </h1>
        {lead ? (
          <p
            className="m-0 font-[family-name:var(--font-body)]"
            style={{ fontSize: 14, lineHeight: 1.5, color: "var(--color-text-secondary)" }}
          >
            {lead}
          </p>
        ) : null}
      </div>
      {rightSlot ? <div className="shrink-0">{rightSlot}</div> : null}
    </header>
  );
}

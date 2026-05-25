import { ArrowRight, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export interface BannerOpenClawV2Props {
  title: string;
  body: ReactNode;
  primaryCta: string;
  secondaryCta?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
  className?: string;
}

/**
 * BannerOpenClawV2 — banner agente con icon + texto + CTAs.
 *
 * Layout responsive: en containers anchos (>= ~520px) renderiza horizontal con
 * texto al centro y CTAs a la derecha. En containers angostos (sidebars, KPI
 * columns) colapsa a layout vertical para evitar el bug en el que el texto se
 * comprimía a "una palabra por línea" y los CTAs se solapaban con el título.
 *
 * Truco: usamos flex-wrap + min-width:200px en la columna de texto. Si el
 * contenedor no puede acomodar 40px icon + 200px texto + ~280px CTAs, los CTAs
 * envuelven a la línea siguiente automáticamente.
 *
 * Tipografía: title 14px Geist semibold (Funnel pierde carácter sub-20px).
 */
export function BannerOpenClawV2({
  title,
  body,
  primaryCta,
  secondaryCta,
  onPrimary,
  onSecondary,
  className
}: BannerOpenClawV2Props) {
  return (
    <section
      className={cn("flex flex-wrap items-start", className)}
      style={{
        gap: 14,
        padding: "14px 16px",
        borderRadius: "var(--radius-md)",
        background: "var(--color-warning-soft)",
        borderLeft: "3px solid var(--color-warning)"
      }}
    >
      <div
        aria-hidden="true"
        className="flex items-center justify-center shrink-0"
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          background: "var(--color-accent-tertiary)",
          color: "var(--color-on-dark-strong)"
        }}
      >
        <Sparkles size={16} strokeWidth={2} />
      </div>
      <div
        className="flex flex-col"
        style={{ gap: 4, flex: "1 1 200px", minWidth: 180 }}
      >
        <h3
          className="m-0 font-[family-name:var(--font-sans)] font-semibold leading-snug"
          style={{
            fontSize: 13,
            color: "var(--color-warning)",
            letterSpacing: "var(--tracking-tight)"
          }}
        >
          {title}
        </h3>
        <p
          className="m-0 font-[family-name:var(--font-body)]"
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--color-text-secondary)"
          }}
        >
          {body}
        </p>
      </div>
      <div
        className="flex flex-wrap items-center shrink-0"
        style={{ gap: 6 }}
      >
        <button
          type="button"
          onClick={onPrimary}
          className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none transition-colors hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 6,
            padding: "7px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-warning)",
            color: "var(--color-on-dark-strong)",
            fontSize: 12,
            border: "1px solid var(--color-warning)",
            cursor: "pointer"
          }}
        >
          {primaryCta}
          <ArrowRight size={12} strokeWidth={2.25} aria-hidden="true" />
        </button>
        {secondaryCta ? (
          <button
            type="button"
            onClick={onSecondary}
            className="inline-flex items-center font-[family-name:var(--font-caption)] font-medium leading-none transition-colors hover:bg-[var(--color-warning-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              padding: "7px 12px",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: "var(--color-warning)",
              border: "1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)",
              fontSize: 12,
              cursor: "pointer"
            }}
          >
            {secondaryCta}
          </button>
        ) : null}
      </div>
    </section>
  );
}

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
      className={cn("flex items-center", className)}
      style={{
        gap: 16,
        padding: "16px 20px",
        borderRadius: "var(--radius-md)",
        background: "var(--color-warning-soft)",
        borderLeft: "4px solid var(--color-warning)"
      }}
    >
      <div
        aria-hidden="true"
        className="flex items-center justify-center shrink-0"
        style={{
          width: 40,
          height: 40,
          borderRadius: "50%",
          background: "var(--color-accent-tertiary)",
          color: "var(--color-text-inverse)"
        }}
      >
        <Sparkles size={20} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 4 }}>
        <h3
          className="m-0 font-[family-name:var(--font-heading)] font-semibold leading-snug"
          style={{ fontSize: 14, color: "var(--color-warning)" }}
        >
          {title}
        </h3>
        <p
          className="m-0 font-[family-name:var(--font-body)] leading-snug"
          style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
        >
          {body}
        </p>
      </div>
      <div className="flex items-center shrink-0" style={{ gap: 8 }}>
        <button
          type="button"
          onClick={onPrimary}
          className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none transition-colors hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 6,
            padding: "8px 14px",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-warning)",
            color: "var(--color-text-inverse)",
            fontSize: 13,
            border: "none",
            cursor: "pointer"
          }}
        >
          {primaryCta}
          <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
        </button>
        {secondaryCta ? (
          <button
            type="button"
            onClick={onSecondary}
            className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none transition-colors hover:bg-[var(--color-warning-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            style={{
              padding: "8px 14px",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: "var(--color-warning)",
              border: "1px solid var(--color-warning)",
              fontSize: 13,
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

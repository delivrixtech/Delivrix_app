import { AlertOctagon, ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export type ApprovalSeverity = "low" | "medium" | "high" | "critical";

export interface ApprovalRowProps {
  title: string;
  body: ReactNode;
  severity: ApprovalSeverity;
  severityLabel?: string;
  onReview?: () => void;
  className?: string;
}

const severityMap: Record<ApprovalSeverity, { bg: string; fg: string; label: string }> = {
  low: { bg: "var(--color-success-soft)", fg: "var(--color-success)", label: "Severidad baja" },
  medium: { bg: "var(--color-warning-soft)", fg: "var(--color-warning)", label: "Severidad media" },
  high: { bg: "var(--color-critical-soft)", fg: "var(--color-critical)", label: "Severidad alta" },
  critical: { bg: "var(--color-critical-soft)", fg: "var(--color-critical)", label: "Severidad crítica" }
};

export function ApprovalRow({ title, body, severity, severityLabel, onReview, className }: ApprovalRowProps) {
  const s = severityMap[severity];
  const label = severityLabel ?? s.label;

  return (
    <article
      className={cn("flex items-center", className)}
      style={{
        gap: 16,
        padding: "16px 20px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        minWidth: 0
      }}
    >
      <div
        aria-hidden="true"
        className="flex items-center justify-center shrink-0"
        style={{
          width: 40,
          height: 40,
          borderRadius: "50%",
          background: s.bg,
          color: s.fg
        }}
      >
        <AlertOctagon size={20} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 4 }}>
        <h4
          className="m-0 font-[family-name:var(--font-heading)] font-semibold leading-snug truncate"
          style={{ fontSize: 13, color: "var(--color-text-primary)" }}
        >
          {title}
        </h4>
        <p
          className="m-0 font-[family-name:var(--font-body)] leading-snug"
          style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
        >
          {body}
        </p>
      </div>
      <span
        className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none shrink-0"
        style={{
          padding: "2px 8px",
          borderRadius: "var(--radius-sm)",
          background: s.bg,
          color: s.fg,
          fontSize: 10
        }}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={onReview}
        className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none shrink-0 transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
        style={{
          gap: 4,
          padding: "6px 12px",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface-sunken)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-primary)",
          fontSize: 12,
          cursor: "pointer"
        }}
      >
        Revisar
        <ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
      </button>
    </article>
  );
}

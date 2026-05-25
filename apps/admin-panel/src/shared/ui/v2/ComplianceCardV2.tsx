import type { LucideIcon } from "lucide-react";
import { Clock3, FileText } from "lucide-react";
import { cn } from "../../lib/cn.ts";

export type ComplianceCardState = "ok" | "warning" | "info" | "critical";

export interface ComplianceCardV2Props {
  title: string;
  state: ComplianceCardState;
  icon: LucideIcon;
  body: string;
  lines?: string[];
  runbookRef?: string;
  evaluatedAtMs?: number | null;
  className?: string;
}

const stateMap: Record<
  ComplianceCardState,
  { bg: string; fg: string; border: string; label: string }
> = {
  ok: {
    bg: "var(--color-success-soft)",
    fg: "var(--color-success)",
    border: "var(--color-success)",
    label: "VERDE"
  },
  warning: {
    bg: "var(--color-warning-soft)",
    fg: "var(--color-warning)",
    border: "var(--color-warning)",
    label: "ATENCIÓN"
  },
  info: {
    bg: "var(--color-info-soft)",
    fg: "var(--color-info)",
    border: "var(--color-info)",
    label: "INFORMACIÓN"
  },
  critical: {
    bg: "var(--color-critical-soft)",
    fg: "var(--color-critical)",
    border: "var(--color-critical)",
    label: "CRÍTICO"
  }
};

export function ComplianceCardV2({
  title,
  state,
  icon: Icon,
  body,
  lines,
  runbookRef,
  evaluatedAtMs,
  className
}: ComplianceCardV2Props) {
  const s = stateMap[state];
  const evaluatedLabel = evaluatedAtMs ? `evaluado ${formatRelative(evaluatedAtMs)}` : "evaluado —";

  return (
    <article
      className={cn("flex flex-col", className)}
      style={{
        gap: 12,
        padding: 20,
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderTop: `3px solid ${s.border}`,
        minWidth: 0
      }}
    >
      <header className="flex items-center" style={{ gap: 10, minHeight: 28 }}>
        <div
          aria-hidden="true"
          className="flex items-center justify-center shrink-0"
          style={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius-sm)",
            background: s.bg,
            color: s.fg
          }}
        >
          <Icon size={16} strokeWidth={1.75} />
        </div>
        <h3
          className="m-0 flex-1 font-[family-name:var(--font-heading)] font-semibold leading-tight truncate"
          style={{ fontSize: 14, color: "var(--color-text-primary)" }}
        >
          {title}
        </h3>
        <span
          className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none shrink-0"
          style={{
            padding: "2px 8px",
            borderRadius: "var(--radius-sm)",
            background: s.bg,
            color: s.fg,
            fontSize: 10,
            letterSpacing: 1
          }}
        >
          {s.label}
        </span>
      </header>
      <p
        className="m-0 font-[family-name:var(--font-body)] leading-snug"
        style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
      >
        {body}
      </p>
      {lines && lines.length > 0 ? (
        <ul className="m-0 list-none p-0 flex flex-col" style={{ gap: 4 }}>
          {lines.map((line) => (
            <li
              key={line}
              className="font-[family-name:var(--font-body)] leading-snug"
              style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}
            >
              · {line}
            </li>
          ))}
        </ul>
      ) : null}
      <footer className="flex items-center" style={{ gap: 6, marginTop: "auto" }}>
        <Clock3 size={10} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-text-tertiary)" }} />
        <span
          className="font-[family-name:var(--font-mono)] leading-none"
          style={{ fontSize: 10, color: "var(--color-text-tertiary)" }}
        >
          {evaluatedLabel}
        </span>
        <span className="flex-1" />
        {runbookRef ? (
          <>
            <FileText size={10} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-text-tertiary)" }} />
            <span
              className="font-[family-name:var(--font-mono)] leading-none truncate"
              style={{ fontSize: 10, color: "var(--color-text-secondary)", maxWidth: 160 }}
              title={runbookRef}
            >
              {runbookRef}
            </span>
          </>
        ) : null}
      </footer>
    </article>
  );
}

function formatRelative(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `hace ${hours}h`;
}

/**
 * AuditLogTable: tabla densa de eventos de auditoria.
 *
 * Cada row tiene 5 columnas: tiempo (timestamp + relativeTime), fuente (dot+pill),
 * body (event + hash/details), flag (success/warning/critical pill), chevron.
 *
 * Variante "compact" para listas con muchas filas (Onboarding, Overview):
 * 4 columnas mono: timestamp / actor / verb / target.
 *
 * Pencil components `qPKvl` (rich) y `JBQr1` (compact).
 *
 * El frontend NO infiere severity ni source — todo viene del payload del audit log.
 */

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { Tone } from "../lib/formatters.ts";
import { cn } from "../lib/cn.ts";

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  relativeTime?: string;
  source: string;
  sourceTone?: Tone;
  event: string;
  details?: string;
  flagLabel?: string;
  flagTone?: Tone;
}

export interface AuditLogTableProps {
  entries: AuditLogEntry[];
  /** Variante compact (4-column mono) vs rich (5-column). Default "rich". */
  density?: "compact" | "rich";
  /** Texto mostrado cuando entries esta vacio. */
  empty?: ReactNode;
}

const toneToFlagStyle: Record<Tone, { bg: string; fg: string }> = {
  success: { bg: "var(--color-success-soft)", fg: "var(--color-success-fg)" },
  warning: { bg: "var(--color-warning-soft)", fg: "var(--color-warning-fg)" },
  critical: { bg: "var(--color-critical-soft)", fg: "var(--color-critical-fg)" },
  neutral: { bg: "var(--color-neutral-soft)", fg: "var(--color-neutral-fg)" }
};

const toneToSourceColor: Record<Tone, string> = {
  success: "var(--color-success)",
  warning: "var(--color-accent-tertiary)",
  critical: "var(--color-critical)",
  neutral: "var(--color-text-tertiary)"
};

export function AuditLogTable({ entries, density = "rich", empty }: AuditLogTableProps) {
  if (entries.length === 0) {
    return (
      <p className="m-0 text-[13px] text-[var(--color-text-tertiary)]">
        {empty ?? "Sin eventos de auditoria."}
      </p>
    );
  }

  if (density === "compact") {
    return (
      <ul className="m-0 p-0 list-none flex flex-col">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="grid grid-cols-[140px_140px_160px_minmax(0,1fr)] gap-3 px-3 py-2 text-[10px] font-[family-name:var(--font-mono)] tabular-nums border-b border-[var(--color-border)] last:border-b-0"
          >
            <span className="text-[var(--color-text-tertiary)] truncate">{entry.timestamp}</span>
            <span style={{ color: toneToSourceColor[entry.sourceTone ?? "neutral"] }} className="truncate">
              {entry.source}
            </span>
            <span className="font-semibold text-[var(--color-text-primary)] truncate">{entry.event}</span>
            <span className="text-[var(--color-text-secondary)] truncate">{entry.details}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="m-0 p-0 list-none flex flex-col bg-[var(--color-surface)]">
      {entries.map((entry, index) => {
        const sourceColor = toneToSourceColor[entry.sourceTone ?? "neutral"];
        const flagStyle = entry.flagTone ? toneToFlagStyle[entry.flagTone] : null;
        return (
          <li
            key={entry.id}
            className={cn(
              "grid grid-cols-[120px_minmax(0,140px)_minmax(0,1fr)_auto_auto] items-start gap-4 px-3 py-3 text-[12px]",
              index !== 0 && "border-t border-[var(--color-border)]"
            )}
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[12px] font-[family-name:var(--font-mono)] font-medium text-[var(--color-text-primary)] tabular-nums truncate">
                {entry.timestamp}
              </span>
              {entry.relativeTime ? (
                <span className="text-[10px] font-[family-name:var(--font-caption)] text-[var(--color-text-tertiary)] truncate">
                  {entry.relativeTime}
                </span>
              ) : null}
            </div>
            <span className="inline-flex items-center gap-1.5 self-center rounded-[var(--radius-sm)] bg-[var(--color-surface-sunken)] px-2 py-0.5 text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-secondary)] min-w-0">
              <span aria-hidden="true" className="block h-1.5 w-1.5 rounded-full shrink-0" style={{ background: sourceColor }} />
              <span className="truncate">{entry.source}</span>
            </span>
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-[13px] font-[family-name:var(--font-mono)] font-medium text-[var(--color-text-primary)] truncate">
                {entry.event}
              </span>
              {entry.details ? (
                <span className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-tertiary)] truncate">
                  {entry.details}
                </span>
              ) : null}
            </div>
            {flagStyle && entry.flagLabel ? (
              <span
                className="inline-flex items-center gap-1 self-center rounded-[var(--radius-sm)] px-2 py-0.5 text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase tracking-[0.04em]"
                style={{ background: flagStyle.bg, color: flagStyle.fg }}
              >
                {entry.flagLabel}
              </span>
            ) : (
              <span aria-hidden="true" />
            )}
            <span aria-hidden="true" className="self-center text-[var(--color-text-tertiary)]">
              <ChevronDown size={16} strokeWidth={1.5} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

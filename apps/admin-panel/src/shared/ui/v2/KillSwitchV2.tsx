import { History, Power } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export type KillSwitchState = "armed" | "disarmed" | "tripped";

export interface KillSwitchV2Props {
  state: KillSwitchState;
  title: string;
  body: ReactNode;
  onHistory?: () => void;
  className?: string;
}

const stateMap: Record<KillSwitchState, { bg: string; fg: string; border: string }> = {
  armed: {
    bg: "var(--color-success-soft)",
    fg: "var(--color-success)",
    border: "var(--color-success)"
  },
  disarmed: {
    bg: "var(--color-warning-soft)",
    fg: "var(--color-warning)",
    border: "var(--color-warning)"
  },
  tripped: {
    bg: "var(--color-critical-soft)",
    fg: "var(--color-critical)",
    border: "var(--color-critical)"
  }
};

export function KillSwitchV2({ state, title, body, onHistory, className }: KillSwitchV2Props) {
  const s = stateMap[state];
  return (
    <section
      className={cn("flex items-center", className)}
      style={{
        gap: 16,
        padding: "20px 24px",
        borderRadius: "var(--radius-md)",
        background: "var(--color-surface)",
        border: `1px solid ${s.border}`,
        minWidth: 0
      }}
    >
      <div
        aria-hidden="true"
        className="flex items-center justify-center shrink-0"
        style={{
          width: 64,
          height: 64,
          borderRadius: "50%",
          background: s.bg,
          color: s.fg
        }}
      >
        <Power size={32} strokeWidth={1.75} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 6 }}>
        <h3
          className="m-0 font-[family-name:var(--font-heading)] font-semibold leading-snug"
          style={{ fontSize: 15, color: "var(--color-text-primary)" }}
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
      {onHistory ? (
        <button
          type="button"
          onClick={onHistory}
          className="inline-flex items-center font-[family-name:var(--font-caption)] font-semibold leading-none shrink-0 transition-colors hover:bg-[var(--color-surface-sunken)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          style={{
            gap: 6,
            padding: "10px 18px",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface-sunken)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-primary)",
            fontSize: 13,
            cursor: "pointer"
          }}
        >
          <History size={14} strokeWidth={2} aria-hidden="true" />
          Ver historial
        </button>
      ) : null}
    </section>
  );
}

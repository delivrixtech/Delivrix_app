import { useEffect, useState } from "react";
import { cn } from "../../lib/cn.ts";

export interface LiveIndicatorProps {
  /** Polling interval shown in label (e.g. 5, 30). */
  pollIntervalSec: number;
  /** Timestamp (ms) of last successful update. Component recalculates "hace Ns" live. */
  lastUpdateAt: number | null;
  /** Visual tone — defaults to success (green). Use "warning" when reconnecting, "critical" when offline. */
  tone?: "success" | "warning" | "critical";
  className?: string;
}

const toneMap = {
  success: { bg: "var(--color-success-soft)", fg: "var(--color-success)", label: "Live" },
  warning: { bg: "var(--color-warning-soft)", fg: "var(--color-warning)", label: "Reconectando" },
  critical: { bg: "var(--color-critical-soft)", fg: "var(--color-critical)", label: "Offline" }
} as const;

export function LiveIndicator({ pollIntervalSec, lastUpdateAt, tone = "success", className }: LiveIndicatorProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const t = toneMap[tone];
  const relative = lastUpdateAt ? formatRelative(lastUpdateAt) : "—";

  return (
    <span
      aria-label={`${t.label}: actualizado ${relative}`}
      className={cn("inline-flex items-center", className)}
      style={{
        gap: 8,
        padding: "6px 12px",
        borderRadius: 9999,
        background: t.bg,
        color: t.fg
      }}
    >
      <span style={{ position: "relative", width: 8, height: 8, display: "inline-block" }}>
        <span
          aria-hidden="true"
          className="live-indicator-ring"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: t.fg,
            opacity: 0.3
          }}
        />
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 2,
            left: 2,
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: t.fg
          }}
        />
      </span>
      <span
        className="font-[family-name:var(--font-mono)] leading-none"
        style={{ fontSize: 11, fontWeight: 600 }}
      >
        {t.label} · poll {pollIntervalSec}s · {relative}
      </span>
    </span>
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

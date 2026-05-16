import { AlertTriangle, Info, OctagonAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Banner that draws attention to a primary message at the top of a section.
 * Used for root cause hints, mock-mode reminders, "ingest snapshot to unblock", etc.
 */

type Tone = "info" | "warning" | "critical";

export interface NoticeBannerProps {
  tone?: Tone;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

const toneConfig: Record<Tone, { bg: string; border: string; fg: string; icon: typeof Info }> = {
  info: {
    bg: "bg-[var(--color-info-soft)]",
    border: "border-[var(--color-info-border)]",
    fg: "text-[var(--color-info-fg)]",
    icon: Info
  },
  warning: {
    bg: "bg-[var(--color-warning-soft)]",
    border: "border-[var(--color-warning-border)]",
    fg: "text-[var(--color-warning-fg)]",
    icon: AlertTriangle
  },
  critical: {
    bg: "bg-[var(--color-critical-soft)]",
    border: "border-[var(--color-critical-border)]",
    fg: "text-[var(--color-critical-fg)]",
    icon: OctagonAlert
  }
};

export function NoticeBanner({
  tone = "info",
  title,
  description,
  action,
  className
}: NoticeBannerProps) {
  const config = toneConfig[tone];
  const Icon = config.icon;

  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-[var(--radius-lg)] border px-4 py-3",
        config.bg,
        config.border,
        className
      )}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={cn("mt-0.5 shrink-0", config.fg)} />
      <div className="flex-1 min-w-0">
        <p className={cn("m-0 text-[13px] font-medium leading-tight", config.fg)}>{title}</p>
        {description ? (
          <p className={cn("m-0 mt-1 text-[12px] leading-relaxed", config.fg, "opacity-90")}>
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

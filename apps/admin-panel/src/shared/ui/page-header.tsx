import type { ReactNode } from "react";
import { Badge } from "./badge.tsx";
import { Eyebrow } from "./eyebrow.tsx";

/**
 * Page header pattern used by every section.
 * Eyebrow + title + optional description on the left, optional badge on the right.
 */

export interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  badge?: { label: string; tone?: "neutral" | "success" | "warning" | "critical" | "info" | "accent" };
  endpoint?: string;
}

export function PageHeader({ eyebrow, title, description, badge, endpoint }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex flex-col gap-1.5 min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="m-0 text-[22px] font-medium leading-tight text-[var(--color-text-primary)]">{title}</h1>
        {description ? (
          <p className="m-0 mt-1 text-[13px] leading-relaxed text-[var(--color-text-secondary)] max-w-[640px]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {badge ? <Badge tone={badge.tone ?? "neutral"}>{badge.label}</Badge> : null}
        {endpoint ? (
          <code className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-2 py-1 text-[11px] font-mono text-[var(--color-text-secondary)]">
            {endpoint}
          </code>
        ) : null}
      </div>
    </div>
  );
}

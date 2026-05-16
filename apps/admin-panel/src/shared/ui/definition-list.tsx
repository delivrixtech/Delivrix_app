import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Definition list pattern: label on the left, value on the right.
 * Replaces the legacy `.definition-grid` chip style with a clean rows layout.
 */

export interface DefinitionRow {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}

export interface DefinitionListProps {
  rows: DefinitionRow[];
  className?: string;
  density?: "compact" | "comfortable";
}

export function DefinitionList({ rows, className, density = "comfortable" }: DefinitionListProps) {
  return (
    <dl
      className={cn(
        "grid gap-y-2",
        density === "compact" ? "[&_dt]:py-0.5 [&_dd]:py-0.5" : "[&_dt]:py-1 [&_dd]:py-1",
        className
      )}
    >
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[minmax(120px,30%)_1fr] gap-3 items-baseline">
          <dt className="m-0 text-[12px] text-[var(--color-text-secondary)]">{row.label}</dt>
          <dd
            className={cn(
              "m-0 text-[13px] text-[var(--color-text-primary)] tabular-nums",
              row.mono && "font-mono text-[12px]"
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

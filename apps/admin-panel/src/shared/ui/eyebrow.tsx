import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Small uppercase label that anchors a section heading.
 * Used as the context line above page titles and panel titles.
 */

export function Eyebrow({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "m-0 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]",
        className
      )}
      {...props}
    />
  );
}

import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Badge for status, vocab tokens, counts, mode indicators.
 * Six semantic tones plus accent.
 * Lowercase by convention since the contract vocab is lowercase.
 */

export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-2 py-0.5 text-[11px] font-medium leading-[18px] whitespace-nowrap border",
  {
    variants: {
      tone: {
        neutral:
          "bg-[var(--color-neutral-soft)] text-[var(--color-neutral-fg)] border-[var(--color-neutral-border)]",
        success:
          "bg-[var(--color-success-soft)] text-[var(--color-success-fg)] border-[var(--color-success-border)]",
        info: "bg-[var(--color-info-soft)] text-[var(--color-info-fg)] border-[var(--color-info-border)]",
        warning:
          "bg-[var(--color-warning-soft)] text-[var(--color-warning-fg)] border-[var(--color-warning-border)]",
        critical:
          "bg-[var(--color-critical-soft)] text-[var(--color-critical-fg)] border-[var(--color-critical-border)]",
        unknown:
          "bg-[var(--color-unknown-soft)] text-[var(--color-unknown-fg)] border-[var(--color-unknown-border)]",
        stale:
          "bg-[var(--color-stale-soft)] text-[var(--color-stale-fg)] border-[var(--color-stale-border)]",
        accent:
          "bg-[var(--color-accent-soft)] text-[var(--color-accent-fg)] border-[var(--color-accent-soft)]",
        outline:
          "bg-transparent text-[var(--color-text-secondary)] border-[var(--color-border)]"
      },
      size: {
        sm: "text-[10px] px-1.5 py-0",
        md: "text-[11px] px-2 py-0.5",
        lg: "text-[12px] px-2.5 py-1"
      }
    },
    defaultVariants: {
      tone: "neutral",
      size: "md"
    }
  }
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone, size, ...props },
  ref
) {
  return <span ref={ref} className={cn(badgeVariants({ tone, size }), className)} {...props} />;
});

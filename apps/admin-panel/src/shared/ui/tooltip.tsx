import * as RadixTooltip from "@radix-ui/react-tooltip";
import { forwardRef, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Accessible tooltip wrapped around Radix Tooltip.
 * Use TooltipProvider once high in the tree (App shell).
 */

export const TooltipProvider = RadixTooltip.Provider;
export const TooltipRoot = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export const TooltipContent = forwardRef<
  React.ElementRef<typeof RadixTooltip.Content>,
  React.ComponentPropsWithoutRef<typeof RadixTooltip.Content>
>(function TooltipContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-2.5 py-1.5 text-[12px] leading-tight text-[var(--color-text-primary)] shadow-[var(--shadow-lg)]",
          className
        )}
        {...props}
      />
    </RadixTooltip.Portal>
  );
});

/**
 * Convenience wrapper for the common case: trigger + hint text.
 */
export interface TooltipProps {
  hint: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayMs?: number;
}

export function Tooltip({ hint, children, side = "top", delayMs = 200 }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={delayMs}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <TooltipContent side={side}>{hint}</TooltipContent>
    </RadixTooltip.Root>
  );
}

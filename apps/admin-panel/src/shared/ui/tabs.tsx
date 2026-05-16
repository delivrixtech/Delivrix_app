import * as RadixTabs from "@radix-ui/react-tabs";
import { forwardRef } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Tabs wrapper around Radix. Stripe/Notion style with a subtle bottom border
 * indicating the active tab.
 */

export const Tabs = RadixTabs.Root;

export const TabsList = forwardRef<
  React.ElementRef<typeof RadixTabs.List>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <RadixTabs.List
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1 border-b border-[var(--color-border)] -mb-px",
        className
      )}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef<
  React.ElementRef<typeof RadixTabs.Trigger>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <RadixTabs.Trigger
      ref={ref}
      className={cn(
        "relative px-3 pb-2 pt-1 text-[13px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] data-[state=active]:text-[var(--color-text-primary)] data-[state=active]:after:absolute data-[state=active]:after:left-0 data-[state=active]:after:right-0 data-[state=active]:after:bottom-[-1px] data-[state=active]:after:h-px data-[state=active]:after:bg-[var(--color-accent)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] rounded-sm transition-colors",
        className
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef<
  React.ElementRef<typeof RadixTabs.Content>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <RadixTabs.Content
      ref={ref}
      className={cn("mt-5 focus-visible:outline-none", className)}
      {...props}
    />
  );
});

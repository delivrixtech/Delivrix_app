import * as RadixAccordion from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Accordion for grouping content (e.g. blockers by category, expandable lists).
 * Stripe/Notion style: minimal, clean, sentence case content.
 */

export const Accordion = RadixAccordion.Root;

export const AccordionItem = forwardRef<
  React.ElementRef<typeof RadixAccordion.Item>,
  React.ComponentPropsWithoutRef<typeof RadixAccordion.Item>
>(function AccordionItem({ className, ...props }, ref) {
  return (
    <RadixAccordion.Item
      ref={ref}
      className={cn(
        "rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] data-[state=open]:bg-[var(--color-surface-sunken)]",
        className
      )}
      {...props}
    />
  );
});

export const AccordionTrigger = forwardRef<
  React.ElementRef<typeof RadixAccordion.Trigger>,
  React.ComponentPropsWithoutRef<typeof RadixAccordion.Trigger>
>(function AccordionTrigger({ className, children, ...props }, ref) {
  return (
    <RadixAccordion.Header className="flex">
      <RadixAccordion.Trigger
        ref={ref}
        className={cn(
          "flex flex-1 items-center justify-between px-3 py-2 text-[12px] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-sunken)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] rounded-[var(--radius-md)] [&[data-state=open]>svg]:rotate-180",
          className
        )}
        {...props}
      >
        {children}
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          aria-hidden="true"
          className="shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-200"
        />
      </RadixAccordion.Trigger>
    </RadixAccordion.Header>
  );
});

export const AccordionContent = forwardRef<
  React.ElementRef<typeof RadixAccordion.Content>,
  React.ComponentPropsWithoutRef<typeof RadixAccordion.Content>
>(function AccordionContent({ className, children, ...props }, ref) {
  return (
    <RadixAccordion.Content
      ref={ref}
      className={cn(
        "overflow-hidden text-[12px] text-[var(--color-text-secondary)] data-[state=open]:animate-none data-[state=closed]:animate-none",
        className
      )}
      {...props}
    >
      <div className="px-3 pb-3 pt-1">{children}</div>
    </RadixAccordion.Content>
  );
});

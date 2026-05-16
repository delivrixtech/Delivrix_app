import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Card primitives in Stripe/Notion style.
 * Flat surface, 0.5px border, generous padding, no shadow by default.
 * Use the `tone` prop to add a left accent for state.
 */

type Tone = "default" | "success" | "warning" | "critical" | "info" | "neutral";

const toneBorder: Record<Tone, string> = {
  default: "",
  success: "border-l-4 border-l-[var(--color-success)]",
  warning: "border-l-4 border-l-[var(--color-warning)]",
  critical: "border-l-4 border-l-[var(--color-critical)]",
  info: "border-l-4 border-l-[var(--color-info)]",
  neutral: "border-l-4 border-l-[var(--color-neutral)]"
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: Tone;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, tone = "default", ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)]",
        toneBorder[tone],
        className
      )}
      {...props}
    />
  );
});

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardHeader(
  { className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn("flex flex-col gap-1 px-5 pt-5 pb-4", className)}
      {...props}
    />
  );
});

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(function CardTitle(
  { className, ...props },
  ref
) {
  return (
    <h3
      ref={ref}
      className={cn(
        "m-0 text-[15px] font-medium leading-snug text-[var(--color-text-primary)]",
        className
      )}
      {...props}
    />
  );
});

export const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(function CardDescription(
  { className, ...props },
  ref
) {
  return (
    <p
      ref={ref}
      className={cn("m-0 text-[13px] leading-relaxed text-[var(--color-text-secondary)]", className)}
      {...props}
    />
  );
});

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardContent(
  { className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn("px-5 pb-5", className)}
      {...props}
    />
  );
});

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function CardFooter(
  { className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center gap-2 px-5 py-4 border-t border-[var(--color-border)] text-[12px] text-[var(--color-text-secondary)]",
        className
      )}
      {...props}
    />
  );
});

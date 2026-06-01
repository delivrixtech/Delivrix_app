import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn.ts";

/**
 * Card primitives in Stripe/Notion style.
 * Flat surface, 1px border, generous padding, no shadow by default.
 *
 * Impeccable fix (2026-05-28): el `tone` prop usaba thick side accent
 * uno de los 3 anti-patterns prohibidos absolutamente por Impeccable
 * (`reference/colorize.md`) porque es la marca más reconocible de UIs
 * generadas por IA. Reemplazado por hairline 1px en perímetro completo
 * + surface tint 4-8% del color del tone.
 */

type Tone = "default" | "success" | "warning" | "critical" | "info" | "neutral";

const toneBorder: Record<Tone, string> = {
  default: "",
  success: "border-[var(--color-success)] bg-[var(--color-success-soft)]",
  warning: "border-[var(--color-warning)] bg-[var(--color-warning-soft)]",
  critical: "border-[var(--color-critical)] bg-[var(--color-critical-soft)]",
  info: "border-[var(--color-info)] bg-[var(--color-info-soft)]",
  neutral: "border-[var(--color-border-strong,var(--color-border))]"
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

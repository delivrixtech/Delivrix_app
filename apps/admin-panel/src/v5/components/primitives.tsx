/**
 * Primitivos v5 — Sistema visual desde cero.
 *
 * Brief inference (TasteSkill §0):
 *   Operational control plane / cockpit técnico sobre agente IA con
 *   autonomía gated. Audiencia CTOs y jefes técnicos no-developers.
 *   B/W oficial, semantic solo para estado, dark-first.
 *
 * Three Dials (TasteSkill §1):
 *   VARIANCE 2/5 (low) · MOTION 1/5 (minimal) · DENSITY 4/5 (high).
 *
 * Design System Map (TasteSkill §2):
 *   Lead Linear · Secondary Vercel Observability · Tertiary Datadog.
 *   Canvas Live → Cursor agent panel.
 *
 * Anti-patterns prohibidos (Impeccable + TasteSkill):
 *   - Side-tabs verticales > 1px
 *   - Em-dashes en UI text
 *   - Gradients en CTAs / heros / banners
 *   - Pills saturadas
 *   - Shadows en cards estáticas
 *   - Hover-lift transforms
 *   - Card-in-card nesting
 *   - "Inter + slate-900" default LLM
 *   - Sparkles 26px centrados en empty states
 */

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../lib/cn";

/* ============================================================
 * Eyebrow + Heading + Body trio
 * ============================================================ */

export function Eyebrow({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] font-semibold uppercase leading-none text-fg-subtle",
        className
      )}
      style={{ letterSpacing: "0.14em" }}
      {...props}
    >
      {children}
    </span>
  );
}

export function Display({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={cn(
        "m-0 font-heading text-[34px] font-bold leading-[1.04] tracking-tight text-fg",
        className
      )}
      style={{ letterSpacing: "-0.02em", textWrap: "balance" }}
      {...props}
    >
      {children}
    </h1>
  );
}

export function H1({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={cn("m-0 font-heading text-[22px] font-bold leading-[1.15] text-fg", className)}
      style={{ letterSpacing: "-0.015em", textWrap: "balance" }}
      {...props}
    >
      {children}
    </h1>
  );
}

export function H2({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn("m-0 font-heading text-[16px] font-semibold leading-[1.25] text-fg", className)}
      style={{ letterSpacing: "-0.01em" }}
      {...props}
    >
      {children}
    </h2>
  );
}

export function H3({ className, children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("m-0 font-heading text-[13px] font-semibold leading-[1.3] text-fg", className)}
      {...props}
    >
      {children}
    </h3>
  );
}

export function Body({ className, children, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "m-0 font-sans text-[14px] font-normal leading-[1.55] text-fg-muted",
        className
      )}
      style={{ textWrap: "pretty" }}
      {...props}
    >
      {children}
    </p>
  );
}

export function BodySm({ className, children, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        "m-0 font-sans text-[13px] font-normal leading-[1.5] text-fg-muted",
        className
      )}
      {...props}
    >
      {children}
    </p>
  );
}

export function Caption({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("font-sans text-[12px] font-medium leading-[1.4] text-fg-subtle", className)}
      {...props}
    >
      {children}
    </span>
  );
}

export function MonoData({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "font-mono text-[12px] font-medium leading-[1.4] tabular-nums text-fg",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export function MonoCode({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] font-normal leading-[1.5] text-fg-muted",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/** HumanNote — voz suave de OpenClaw (rationale, recomendación). Máximo 1
 * por vista. Antes usaba Caveat manuscrita; el CTO la sintió fuera de tono
 * profesional (2026-05-28). Ahora: sans italic 13px, color fg-muted —
 * mantiene la diferencia tonal sin sacar al lector del registro corporativo.
 */
export function HumanNote({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn("font-sans text-[13px] italic leading-[1.5] text-fg-muted", className)}
      {...props}
    >
      {children}
    </span>
  );
}

/* ============================================================
 * Card — hairline 1px, sin shadow, hover border-strong
 * ============================================================ */

const cardVariants = cva(
  "rounded-[10px] border border-border bg-surface transition-colors duration-150",
  {
    variants: {
      tone: {
        default: "hover:border-border-strong",
        quiet: "bg-surface-sunken border-border/60",
        inverse: "border-[var(--color-always-dark-border)] bg-[var(--color-always-dark-surface)] text-[var(--color-on-dark-strong)]"
      },
      padding: {
        none: "",
        compact: "p-3",
        default: "p-4",
        relaxed: "p-5",
        hero: "p-6"
      },
      interactive: {
        true: "cursor-pointer hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        false: ""
      }
    },
    defaultVariants: {
      tone: "default",
      padding: "default",
      interactive: false
    }
  }
);

export interface CardProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  asChild?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, tone, padding, interactive, asChild, ...props },
  ref
) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      ref={ref}
      className={cn(cardVariants({ tone, padding, interactive }), className)}
      {...props}
    />
  );
});

/* ============================================================
 * Pill, Badge, Chip
 * ============================================================ */

const pillVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border font-sans text-[11px] font-medium leading-[1.3] whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-border bg-surface-sunken text-fg-muted",
        success: "border-[color:var(--color-success-border)] bg-success-soft text-success-fg",
        warning: "border-[color:var(--color-warning-border)] bg-warning-soft text-warning-fg",
        critical: "border-[color:var(--color-critical-border)] bg-critical-soft text-critical-fg",
        info: "border-[color:var(--color-info-border)] bg-info-soft text-info-fg",
        accent: "border-[color:var(--color-accent)] bg-accent text-accent-fg"
      },
      size: {
        sm: "px-2 py-[2px] text-[10px]",
        md: "px-2.5 py-[3px]",
        lg: "px-3 py-1 text-[12px]"
      }
    },
    defaultVariants: {
      tone: "neutral",
      size: "md"
    }
  }
);

export interface PillProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof pillVariants> {
  dot?: boolean;
}

function pillDotClassName(tone: PillProps["tone"]): string {
  switch (tone) {
    case "success":
      return "bg-success";
    case "warning":
      return "bg-warning";
    case "critical":
      return "bg-critical";
    case "info":
      return "bg-info";
    case "accent":
      return "bg-accent-fg";
    case "neutral":
    default:
      return "bg-fg-subtle";
  }
}

export function Pill({ className, tone, size, dot = true, children, ...props }: PillProps) {
  return (
    <span className={cn(pillVariants({ tone, size }), className)} {...props}>
      {dot ? (
        <span
          aria-hidden="true"
          className={cn("inline-block size-1.5 rounded-full", pillDotClassName(tone))}
        />
      ) : null}
      {children}
    </span>
  );
}

/** Badge — count discreto sin color. Borde hairline + bg surface + mono. */
export function Badge({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border border-border bg-surface px-1.5 py-[1px] font-mono text-[11px] font-medium tabular-nums text-fg-muted",
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/** Chip — filtro/tag interactivo. Click → border-strong. */
export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export function Chip({ className, active, children, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded border bg-surface-sunken px-2 py-1 font-sans text-[12px] font-medium text-fg-muted transition-colors duration-150 hover:border-border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
        active ? "border-border-strong text-fg" : "border-transparent",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ============================================================
 * Stat — label uppercase + value mono-stat-xl. 96px alto fijo.
 * ============================================================ */

export interface StatProps {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  trend?: ReactNode;
  tone?: "default" | "success" | "warning" | "critical";
  className?: string;
}

export function Stat({ label, value, unit, hint, trend, tone = "default", className }: StatProps) {
  const valueClassName =
    tone === "success"
      ? "text-success"
      : tone === "warning"
      ? "text-warning"
      : tone === "critical"
      ? "text-critical"
      : "text-fg";
  return (
    <div className={cn("flex min-h-[96px] flex-col justify-between gap-2", className)}>
      <Eyebrow>{label}</Eyebrow>
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "font-mono text-[30px] font-semibold leading-none tabular-nums",
              valueClassName
            )}
            style={{ letterSpacing: "0" }}
          >
            {value}
          </span>
          {unit ? (
            <span className="font-mono text-[12px] leading-none text-fg-subtle">{unit}</span>
          ) : null}
          {trend ? <span className="ml-1 leading-none">{trend}</span> : null}
        </div>
        {hint ? (
          <span className="font-sans text-[11px] leading-[1.4] text-fg-subtle">{hint}</span>
        ) : null}
      </div>
    </div>
  );
}

/* ============================================================
 * Button — primary / secondary / ghost / destructive
 * ============================================================ */

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md font-sans font-medium leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50 whitespace-nowrap",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent-hover",
        secondary: "bg-surface text-fg border border-border hover:border-border-strong",
        ghost: "text-fg-muted hover:bg-surface-sunken hover:text-fg",
        outline: "bg-transparent text-fg border border-border-strong hover:bg-surface-sunken",
        destructive: "bg-critical text-fg-inverse hover:bg-critical/90",
        link: "text-fg underline-offset-4 hover:underline"
      },
      size: {
        sm: "h-7 px-2.5 text-[12px]",
        md: "h-8 px-3.5 text-[13px]",
        lg: "h-10 px-5 text-[14px]",
        icon: "h-8 w-8"
      }
    },
    defaultVariants: {
      variant: "primary",
      size: "md"
    }
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild, ...props },
  ref
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
});

/* ============================================================
 * Section divider — hairline + eyebrow + caption + chip count
 * ============================================================ */

export interface SectionHeadProps {
  eyebrow?: string;
  title: string;
  caption?: ReactNode;
  count?: number;
  countTone?: "neutral" | "success" | "warning" | "critical";
  trailing?: ReactNode;
  className?: string;
}

export function SectionHead({
  eyebrow,
  title,
  caption,
  count,
  countTone = "neutral",
  trailing,
  className
}: SectionHeadProps) {
  return (
    <div className={cn("flex items-end justify-between gap-4 pb-2 border-b border-border", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <div className="flex items-center gap-3">
          <H2>{title}</H2>
          {typeof count === "number" ? <Pill tone={countTone}>{count}</Pill> : null}
        </div>
        {caption ? <Caption>{caption}</Caption> : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}

/* ============================================================
 * Empty state — alineado IZQUIERDA, no centered. Sin Sparkles 26px.
 * ============================================================ */

export interface EmptyStateProps {
  eyebrow?: string;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ eyebrow, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-start gap-2 px-4 py-6", className)}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <H3>{title}</H3>
      {body ? (
        <BodySm style={{ maxWidth: 520 }}>{body}</BodySm>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* ============================================================
 * AgentPulse — la "shape viva" del agente IA.
 *
 * Estados: idle (dot quieto), thinking (dot + barra 60×2px loop),
 * executing (barra accent-tertiary llena loop).
 * ============================================================ */

export function AgentPulse({
  state,
  className
}: {
  state: "idle" | "thinking" | "executing";
  className?: string;
}) {
  if (state === "idle") {
    return (
      <span className={cn("inline-flex items-center gap-2", className)}>
        <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-fg-subtle" />
        <Caption>en espera</Caption>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-fg agent-pulse-dot" />
      <Caption className="text-fg">
        {state === "thinking" ? "pensando" : "ejecutando"}
      </Caption>
      <span
        aria-hidden="true"
        className="relative inline-block h-[2px] w-[60px] overflow-hidden rounded-full bg-border"
      >
        <span className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-fg agent-pulse-bar" />
      </span>
    </span>
  );
}

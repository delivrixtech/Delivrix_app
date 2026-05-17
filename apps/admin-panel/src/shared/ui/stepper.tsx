/**
 * Stepper horizontal para flujos guiados (Onboarding wizard).
 *
 * Cada paso: circulo numerado + labels verticales (Kicker UPPERCASE + Title).
 * Tone'd por estado: ready (success), in_progress (warning),
 * blocked (critical), pending (neutral).
 *
 * Pencil component `cMAIm` (Componente / Paso del stepper).
 */

import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export type StepStatus = "ready" | "in_progress" | "blocked" | "pending";

export interface StepperStep {
  id: string;
  order: number;
  kicker?: string;
  title: string;
  status: StepStatus;
  description?: ReactNode;
}

export interface StepperProps {
  steps: StepperStep[];
  className?: string;
}

const statusToCircle: Record<StepStatus, { bg: string; fg: string; border: string }> = {
  ready: {
    bg: "var(--color-success-soft)",
    fg: "var(--color-success-fg)",
    border: "var(--color-success-border)"
  },
  in_progress: {
    bg: "var(--color-accent-soft)",
    fg: "var(--color-accent-fg)",
    border: "var(--color-accent)"
  },
  blocked: {
    bg: "var(--color-critical-soft)",
    fg: "var(--color-critical-fg)",
    border: "var(--color-critical-border)"
  },
  pending: {
    bg: "var(--color-surface)",
    fg: "var(--color-text-tertiary)",
    border: "var(--color-border)"
  }
};

const statusToConnector: Record<StepStatus, string> = {
  ready: "bg-[var(--color-success-border)]",
  in_progress: "bg-[var(--color-accent)]",
  blocked: "bg-[var(--color-critical-border)]",
  pending: "bg-[var(--color-border)]"
};

export function Stepper({ steps, className }: StepperProps) {
  return (
    <ol className={cn("flex items-start gap-0 list-none p-0 m-0 w-full", className)}>
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        const circle = statusToCircle[step.status];
        return (
          <li
            key={step.id}
            className={cn("flex items-start gap-3 min-w-0", isLast ? "flex-none" : "flex-1")}
          >
            <div className="flex flex-col items-start gap-2 min-w-0">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-[family-name:var(--font-mono)] font-semibold tabular-nums"
                  style={{
                    background: circle.bg,
                    color: circle.fg,
                    boxShadow: `inset 0 0 0 1px ${circle.border}`
                  }}
                >
                  {step.order}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 min-w-0">
                {step.kicker ? (
                  <span className="text-[10px] font-[family-name:var(--font-caption)] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                    {step.kicker}
                  </span>
                ) : null}
                <span className="text-[13px] font-[family-name:var(--font-sans)] font-semibold text-[var(--color-text-primary)]">
                  {step.title}
                </span>
                {step.description ? (
                  <span className="text-[11px] text-[var(--color-text-secondary)]">{step.description}</span>
                ) : null}
              </div>
            </div>
            {!isLast ? (
              <span
                aria-hidden="true"
                className={cn(
                  "mt-4 h-px flex-1 self-start",
                  statusToConnector[step.status]
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

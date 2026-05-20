import { Inbox } from "lucide-react";
import { cn } from "../../lib/cn.ts";

export interface EmptyEventsCardProps {
  pollIntervalSeconds?: number;
  className?: string;
}

export function EmptyEventsCard({ pollIntervalSeconds = 30, className }: EmptyEventsCardProps) {
  return (
    <section
      className={cn("flex flex-col items-center", className)}
      style={{
        gap: 12,
        padding: "24px 20px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        width: 360,
        maxWidth: "100%"
      }}
    >
      <Inbox size={32} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-text-tertiary)" }} />
      <h3
        className="m-0 font-[family-name:var(--font-heading)] font-semibold leading-tight"
        style={{ color: "var(--color-text-primary)", fontSize: 16 }}
      >
        Sin eventos del agente
      </h3>
      <p
        className="m-0 text-center font-[family-name:var(--font-caption)] font-normal leading-snug"
        style={{ color: "var(--color-text-secondary)", fontSize: 12 }}
      >
        OpenClaw no registró actividad nueva en los últimos 30 minutos
      </p>
      <span
        className="font-[family-name:var(--font-mono)] leading-none"
        style={{ color: "var(--color-text-tertiary)", fontSize: 10 }}
      >
        Refresca cada {pollIntervalSeconds} s
      </span>
    </section>
  );
}

import { FolderX } from "lucide-react";
import { cn } from "../../lib/cn.ts";

export interface EmptyEvidenceCardProps {
  pollIntervalSeconds?: number;
  className?: string;
}

export function EmptyEvidenceCard({ pollIntervalSeconds = 30, className }: EmptyEvidenceCardProps) {
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
      <FolderX size={32} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--color-text-tertiary)" }} />
      <h3
        className="m-0 font-[family-name:var(--font-heading)] font-semibold leading-tight"
        style={{ color: "var(--color-text-primary)", fontSize: 16 }}
      >
        Sin evidencia curada
      </h3>
      <p
        className="m-0 text-center font-[family-name:var(--font-caption)] font-normal leading-snug"
        style={{ color: "var(--color-text-secondary)", fontSize: 12 }}
      >
        OpenClaw no ha promovido lecciones nuevas. Espera la próxima sesión supervisada.
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

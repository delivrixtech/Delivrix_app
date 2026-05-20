import { cn } from "../../lib/cn.ts";

export interface RealtimeTickProps {
  active: boolean;
  className?: string;
}

export function RealtimeTick({ active, className }: RealtimeTickProps) {
  if (!active) {
    return (
      <span
        aria-label="Sin cambios entre polls"
        className={cn("inline-block shrink-0 rounded-full", className)}
        style={{ width: 6, height: 6, background: "var(--color-success)" }}
      />
    );
  }

  return (
    <span
      aria-label="Valor actualizado en vivo"
      className={cn("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: 14, height: 14 }}
    >
      <span
        aria-hidden="true"
        className="realtime-tick-halo absolute rounded-full"
        style={{ width: 14, height: 14, background: "var(--color-success)", opacity: 0.25 }}
      />
      <span
        aria-hidden="true"
        className="relative rounded-full"
        style={{ width: 8, height: 8, background: "var(--color-success)" }}
      />
    </span>
  );
}

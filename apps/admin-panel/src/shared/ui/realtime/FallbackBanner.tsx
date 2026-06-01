import { TriangleAlert } from "lucide-react";
import { cn } from "../../lib/cn.ts";

export interface FallbackBannerProps {
  message?: string;
  className?: string;
}

export function FallbackBanner({ message = "Mostrando valores de respaldo", className }: FallbackBannerProps) {
  return (
    <aside
      role="status"
      className={cn("flex w-full items-center", className)}
      style={{
        gap: 12,
        padding: "12px 16px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-warning-border)",
        background: "var(--color-warning-soft)"
      }}
    >
      <TriangleAlert
        size={20}
        strokeWidth={1.75}
        aria-hidden="true"
        style={{ color: "var(--color-warning)" }}
      />
      <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        <span
          className="font-[family-name:var(--font-caption)] font-semibold leading-tight"
          style={{ color: "var(--color-warning)", fontSize: 12 }}
        >
          {message}
        </span>
        <span
          className="font-[family-name:var(--font-caption)] font-normal leading-tight"
          style={{ color: "var(--color-text-secondary)", fontSize: 11 }}
        >
          Agente no disponible · datos pueden estar desactualizados
        </span>
      </span>
    </aside>
  );
}

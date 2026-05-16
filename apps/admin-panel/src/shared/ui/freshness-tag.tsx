import { useEffect, useState } from "react";
import { Tooltip } from "./tooltip.tsx";
import { formatDateTime } from "../lib/formatters.ts";

/**
 * Shows when the last successful fetch happened, ticking every 10s.
 * Tooltip reveals the absolute timestamp.
 */

export interface FreshnessTagProps {
  lastFetchedAt: number | null;
  isFetching: boolean;
}

export function FreshnessTag({ lastFetchedAt, isFetching }: FreshnessTagProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((tick) => tick + 1), 10_000);
    return () => clearInterval(interval);
  }, []);

  if (isFetching) {
    return <span className="text-[12px] text-[var(--color-text-secondary)]">Actualizando…</span>;
  }

  if (!lastFetchedAt) {
    return <span className="text-[12px] text-[var(--color-text-secondary)]">Sin datos</span>;
  }

  const relative = formatRelative(lastFetchedAt);
  const absolute = formatDateTime(new Date(lastFetchedAt).toISOString());

  return (
    <Tooltip hint={`Ultima actualizacion: ${absolute}`}>
      <span className="text-[12px] text-[var(--color-text-secondary)] cursor-default">
        Actualizado {relative}
      </span>
    </Tooltip>
  );
}

function formatRelative(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

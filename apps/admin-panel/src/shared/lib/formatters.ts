import type { AuditEvent, ContractStatus } from "../api/client.ts";

export type Tone = "success" | "warning" | "critical" | "neutral";

export function compactLabel(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "unknown";
  }

  return String(value)
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim();
}

/**
 * Display-friendly version of a backend identifier. Splits camelCase, replaces
 * dots between letters with spaces, and normalizes whitespace. Preserves
 * existing capitalization for already-spaced words and keeps version numbers
 * intact (digit-flanked dots are not split).
 *
 * Examples:
 *   humanize("senderNodes")          // "sender nodes"
 *   humanize("identity.cpuCores")    // "identity cpu cores"
 *   humanize("Delivrix Demo 5.1")    // "Delivrix Demo 5.1"
 *   humanize("needs_review")         // "needs review"
 */
export function humanize(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") {
    return "unknown";
  }

  return String(value)
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/([a-zA-Z])\.([a-zA-Z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, (_match, a, b: string) => `${a} ${b.toLowerCase()}`)
    .replace(/\s+/g, " ")
    .trim();
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "unknown";
  }

  return new Intl.NumberFormat("es-CO").format(value);
}

export function formatMetricValue(value: number | string | null, unit: string | null): string {
  if (value === null) {
    return "unknown";
  }

  return `${typeof value === "number" ? formatNumber(value) : compactLabel(value)}${unit ? ` ${unit}` : ""}`;
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "unknown";
  }

  return `${Math.round(value)}%`;
}

/**
 * Filtra audit events por sección de la UI matcheando keywords contra
 * targetType / action / actorType. Ordenados de más reciente a más viejo.
 */
export function filterAuditEvents(
  events: AuditEvent[],
  keywords: string[],
  limit = 6
): AuditEvent[] {
  if (events.length === 0) return [];
  const lower = keywords.map((k) => k.toLowerCase());
  const matches = events.filter((e) => {
    const blob = `${e.actorType} ${e.action} ${e.targetType} ${e.targetId}`.toLowerCase();
    return lower.some((k) => blob.includes(k));
  });
  // Si no hay matches específicos, caemos a los últimos N globales para no quedar vacíos.
  const pool = matches.length > 0 ? matches : events;
  return [...pool]
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, limit);
}

/** Formatea un timestamp ISO como "HH:MM:SS" en local. */
export function formatTimeOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Formatea un timestamp ISO como "YYYY-MM-DD HH:MM:SS" para tablas largas. */
export function formatDateTimeIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("es-CO");
  const time = d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${date} ${time}`;
}

/** Pseudo-hash visual (sha:abcd…123) desde un ID del audit event. */
export function shortAuditHash(id: string): string {
  const clean = id.replace(/[^a-z0-9]/gi, "");
  if (clean.length <= 7) return `sha:${clean}`;
  return `sha:${clean.slice(0, 4)}…${clean.slice(-3)}`;
}

export function stateTone(value: ContractStatus | boolean | null | undefined): Tone {
  if (value === true) {
    return "success";
  }

  if (value === false || value === null || value === undefined) {
    return "neutral";
  }

  const normalized = String(value).toLowerCase();

  if (["critical", "blocked", "active_true", "error", "offline"].includes(normalized)) {
    return "critical";
  }

  if (["warning", "needs_review", "requires_approval", "loading", "stale"].includes(normalized)) {
    return "warning";
  }

  if (["ok", "healthy", "ready", "success", "fresh", "inactive"].includes(normalized)) {
    return "success";
  }

  return "neutral";
}

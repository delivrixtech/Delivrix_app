import type { ContractStatus } from "../api/client.ts";

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

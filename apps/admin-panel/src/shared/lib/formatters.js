export function formatDateTime(value) {
  if (!value) {
    return "N/A";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "N/A";
  }

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

export function formatNumber(value) {
  return new Intl.NumberFormat("es-CO").format(Number(value ?? 0));
}

export function compactLabel(value) {
  return String(value ?? "unknown")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim();
}

export function stateTone(value) {
  const normalized = String(value ?? "").toLowerCase();

  if (["critical", "quarantined", "blocked", "failed", "complaint", "active_true"].includes(normalized)) {
    return "critical";
  }

  if (["warning", "degraded", "processing", "deferred", "bounce", "paused", "needs_review"].includes(normalized)) {
    return "warning";
  }

  if (["healthy", "ok", "active", "warming", "completed", "sent", "ready"].includes(normalized)) {
    return "success";
  }

  return "neutral";
}

export function percent(part, total) {
  const safeTotal = Number(total ?? 0);

  if (safeTotal <= 0) {
    return 0;
  }

  return Math.round((Number(part ?? 0) / safeTotal) * 100);
}

import { createHash } from "node:crypto";

export const GENESIS_PREV_HASH = "GENESIS";

export function canonicalize(event: Record<string, unknown>): string {
  return JSON.stringify(sortRec(event));
}

export function computeAuditHash(event: Record<string, unknown>, prevHash: string): string {
  return createHash("sha256")
    .update(prevHash + canonicalize(event))
    .digest("hex");
}

function sortRec(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortRec);
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key === "hash") {
      continue;
    }
    sorted[key] = sortRec((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

import { createHash } from "node:crypto";

export const GENESIS_PREV_HASH = "GENESIS";

export function canonicalize(event: Record<string, unknown>): string {
  return JSON.stringify(sortRec(event, true));
}

export function computeAuditHash(event: Record<string, unknown>, prevHash: string): string {
  return createHash("sha256")
    .update(prevHash + canonicalize(event))
    .digest("hex");
}

function sortRec(value: unknown, isRoot = false): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortRec(item, false));
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (isRoot && key === "hash") {
      continue;
    }
    sorted[key] = sortRec((value as Record<string, unknown>)[key], false);
  }
  return sorted;
}

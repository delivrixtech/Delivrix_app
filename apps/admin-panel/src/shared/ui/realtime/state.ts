import type { RealTimeMeta } from "../../api/client.ts";

export function isFallbackMeta(meta: RealTimeMeta | null | undefined): boolean {
  return meta?.dataSource === "fallback";
}

export function isCachedMeta(meta: RealTimeMeta | null | undefined): boolean {
  return meta?.dataSource === "cached";
}

export function staleMinutesFromMeta(meta: RealTimeMeta | null | undefined): number {
  const staleSinceMs = meta?.staleSinceMs ?? 0;
  if (!Number.isFinite(staleSinceMs) || staleSinceMs <= 0) return 0;
  return Math.floor(staleSinceMs / 60_000);
}

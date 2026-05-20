import type { RealTimeMeta } from "../../../packages/domain/src/index.ts";

export interface SafetyRealtimePayload {
  meta: RealTimeMeta;
}

export interface SafetyRealtimeCacheEntry<T extends SafetyRealtimePayload> {
  payload: T;
  fetchedAt: number;
}

export class SafetyRealtimeCache {
  private readonly cache = new Map<string, SafetyRealtimeCacheEntry<SafetyRealtimePayload>>();
  private readonly ttlMs: number;
  private readonly nowMs: () => number;

  constructor(
    ttlMs = 30_000,
    nowMs: () => number = () => Date.now()
  ) {
    this.ttlMs = ttlMs;
    this.nowMs = nowMs;
  }

  async resolve<T extends SafetyRealtimePayload>(
    endpoint: string,
    liveQuery: (now: Date) => Promise<T>,
    fallback: (now: Date) => T
  ): Promise<T> {
    const nowMs = this.nowMs();
    const cached = this.cache.get(endpoint) as SafetyRealtimeCacheEntry<T> | undefined;

    if (cached && nowMs - cached.fetchedAt < this.ttlMs) {
      return withMeta(cached.payload, "cached", nowMs - cached.fetchedAt, nowMs);
    }

    try {
      const payload = await liveQuery(new Date(nowMs));
      if (payload.meta.dataSource === "live") {
        this.cache.set(endpoint, { payload, fetchedAt: nowMs });
      }
      return payload;
    } catch {
      if (cached) {
        return withMeta(cached.payload, "cached", nowMs - cached.fetchedAt, nowMs);
      }
      return fallback(new Date(nowMs));
    }
  }
}

function withMeta<T extends SafetyRealtimePayload>(
  payload: T,
  dataSource: "cached",
  staleSinceMs: number,
  nowMs: number
): T {
  return {
    ...payload,
    meta: {
      ...payload.meta,
      dataSource,
      staleSinceMs,
      evaluatedAt: new Date(nowMs).toISOString()
    }
  };
}

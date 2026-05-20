export type RealTimeDataSource = "live" | "cached" | "fallback";

export interface RealTimeMeta {
  dataSource: RealTimeDataSource;
  staleSinceMs: number | null;
  evaluatedAt: string;
}

export function buildRealTimeMeta(input: {
  dataSource: RealTimeDataSource;
  staleSinceMs?: number | null;
  now?: Date;
}): RealTimeMeta {
  return {
    dataSource: input.dataSource,
    staleSinceMs: input.staleSinceMs ?? null,
    evaluatedAt: (input.now ?? new Date()).toISOString()
  };
}

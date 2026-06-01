import type { Pool } from "pg";
import type {
  AuditEventInput,
  CanvasLiveEvent
} from "../../../packages/domain/src/index.ts";
import { expireOldEntries } from "../../../packages/storage/src/index.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

export interface EpisodicScratchTtlJobDeps {
  pool: Pick<Pool, "query">;
  auditLog?: AuditSink;
  canvasLiveEvents?: CanvasEmitter;
  now?: () => Date;
}

export async function runEpisodicScratchTtlJob(
  deps: EpisodicScratchTtlJobDeps
): Promise<{ expired: number }> {
  const now = deps.now?.() ?? new Date();
  const expired = await expireOldEntries(deps.pool, now);
  if (expired <= 0) return { expired };

  await deps.auditLog?.append({
    actorType: "system",
    actorId: "episodic_scratch_ttl_job",
    action: "oc.episodic.scratch_expired",
    targetType: "openclaw_memory",
    targetId: "openclaw_episodic_scratch",
    riskLevel: "low",
    decision: "allow",
    metadata: {
      expired,
      expiredBefore: now.toISOString()
    }
  });

  await deps.canvasLiveEvents?.emit({
    type: "oc.action.now",
    kind: "audit",
    action: "oc.episodic.scratch_expired",
    targetType: "openclaw_memory",
    targetId: "openclaw_episodic_scratch",
    riskLevel: "low",
    occurredAt: now.toISOString()
  } as CanvasLiveEvent).catch(() => undefined);

  return { expired };
}

export function startEpisodicScratchTtlJob(
  deps: EpisodicScratchTtlJobDeps & {
    intervalMs?: number;
    logger?: { info(event: string, message: string, metadata?: Record<string, unknown>): unknown; warn(event: string, message: string, metadata?: Record<string, unknown>): unknown };
  }
): NodeJS.Timeout {
  const interval = setInterval(() => {
    runEpisodicScratchTtlJob(deps)
      .then((result) => {
        if (result.expired > 0) {
          void deps.logger?.info("openclaw.episodic.ttl_expired", "Expired old episodic scratch rows.", result);
        }
      })
      .catch((error) => {
        void deps.logger?.warn("openclaw.episodic.ttl_failed", "Episodic scratch TTL job failed.", {
          error: error instanceof Error ? error.message : "Unknown TTL job error"
        });
      });
  }, deps.intervalMs ?? 6 * 60 * 60 * 1000);
  interval.unref();
  return interval;
}

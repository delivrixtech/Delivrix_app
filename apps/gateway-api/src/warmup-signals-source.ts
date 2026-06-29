// Production feed for the warmup breaker (W4): turns stored reputation evidence
// into the {seedInbox, seedSpam, complaints} signals the ramp scheduler's breaker
// consumes — WITHOUT running IMAP on the hot path.
//
// Placement: the placement-check skill already audits its result as
// `oc.placement.checked` with metadata { rampId, inbox, spam, ... }. We read the
// most recent one for this ramp from the audit log (a cheap list scan; batches
// are minutes/days apart). No placement evidence yet → returns {} and the breaker
// falls back to bounce-only (no behaviour change).

import type { AuditEvent } from "../../../packages/domain/src/index.ts";

export interface WarmupSignalsAuditSource {
  list?(): Promise<AuditEvent[]>;
}

export interface WarmupSignalsQuery {
  domain: string;
  serverSlug: string | null;
  serverIp: string;
  rampId: string;
}

export interface WarmupSignals {
  complaints?: number;
  seedInbox?: number;
  seedSpam?: number;
}

const PLACEMENT_ACTION = "oc.placement.checked";

/**
 * Build a `getWarmupSignals` reader bound to the gateway audit log. The returned
 * function is what the RampScheduler calls after each batch.
 */
export function createWarmupSignalsReader(deps: {
  auditLog: WarmupSignalsAuditSource;
}): (query: WarmupSignalsQuery) => Promise<WarmupSignals> {
  return async (query: WarmupSignalsQuery): Promise<WarmupSignals> => {
    let events: AuditEvent[];
    try {
      events = (await deps.auditLog.list?.()) ?? [];
    } catch {
      return {};
    }

    const latest = latestPlacementForRamp(events, query.rampId);
    if (!latest) return {};

    const seedInbox = metaNumber(latest, "inbox");
    const seedSpam = metaNumber(latest, "spam");
    if (seedInbox === undefined && seedSpam === undefined) return {};

    return {
      ...(seedInbox === undefined ? {} : { seedInbox }),
      ...(seedSpam === undefined ? {} : { seedSpam })
    };
  };
}

function latestPlacementForRamp(events: AuditEvent[], rampId: string): AuditEvent | undefined {
  let latest: AuditEvent | undefined;
  for (const event of events) {
    if (event.action !== PLACEMENT_ACTION) continue;
    if (metaString(event, "rampId") !== rampId) continue;
    if (!latest || event.occurredAt > latest.occurredAt) {
      latest = event;
    }
  }
  return latest;
}

function metaString(event: AuditEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function metaNumber(event: AuditEvent, key: string): number | undefined {
  const value = event.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

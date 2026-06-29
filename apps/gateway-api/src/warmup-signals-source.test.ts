import assert from "node:assert/strict";
import test from "node:test";
import { createWarmupSignalsReader } from "./warmup-signals-source.ts";
import type { AuditEvent } from "../../../packages/domain/src/index.ts";

function ev(partial: Partial<AuditEvent>): AuditEvent {
  return {
    id: partial.id ?? "e1",
    occurredAt: partial.occurredAt ?? "2026-06-28T00:00:00.000Z",
    actorType: "operator",
    actorId: "x",
    action: partial.action ?? "oc.placement.checked",
    targetType: "placement_check",
    targetId: "t",
    riskLevel: "low",
    metadata: partial.metadata ?? {}
  } as AuditEvent;
}

const query = { domain: "biz.com", serverSlug: "smtp-1", serverIp: "1.1.1.1", rampId: "ramp-abc" };

test("reads the latest placement result for the ramp", async () => {
  const reader = createWarmupSignalsReader({
    auditLog: {
      list: async () => [
        ev({ occurredAt: "2026-06-28T10:00:00.000Z", metadata: { rampId: "ramp-abc", inbox: 8, spam: 2 } }),
        ev({ occurredAt: "2026-06-28T12:00:00.000Z", metadata: { rampId: "ramp-abc", inbox: 4, spam: 6 } }), // newer
        ev({ occurredAt: "2026-06-28T11:00:00.000Z", metadata: { rampId: "other", inbox: 10, spam: 0 } })
      ]
    }
  });
  const signals = await reader(query);
  assert.equal(signals.seedInbox, 4);
  assert.equal(signals.seedSpam, 6);
});

test("returns {} when there is no placement evidence for the ramp", async () => {
  const reader = createWarmupSignalsReader({
    auditLog: { list: async () => [ev({ metadata: { rampId: "other", inbox: 9, spam: 1 } })] }
  });
  assert.deepEqual(await reader(query), {});
});

test("ignores non-placement events", async () => {
  const reader = createWarmupSignalsReader({
    auditLog: {
      list: async () => [ev({ action: "oc.warmup.ramp_batch_sent", metadata: { rampId: "ramp-abc", inbox: 0, spam: 9 } })]
    }
  });
  assert.deepEqual(await reader(query), {});
});

test("never throws when the audit log read fails", async () => {
  const reader = createWarmupSignalsReader({
    auditLog: {
      list: async () => {
        throw new Error("audit down");
      }
    }
  });
  assert.deepEqual(await reader(query), {});
});

test("tolerates a missing list() method", async () => {
  const reader = createWarmupSignalsReader({ auditLog: {} });
  assert.deepEqual(await reader(query), {});
});

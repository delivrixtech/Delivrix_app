import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "../../../packages/domain/src/index.ts";
import { buildOpenClawSkillsAudit } from "../../../packages/domain/src/index.ts";
import { SafetyRealtimeCache } from "./safety-realtime-cache.ts";

test("Learning real-time cache returns cached skills audit payload inside 30s", async () => {
  let nowMs = Date.parse("2026-05-20T17:20:00.000Z");
  let liveCalls = 0;
  const cache = new SafetyRealtimeCache(30_000, () => nowMs);
  const auditEvents = [
    event({
      occurredAt: "2026-05-20T17:19:00.000Z",
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: "oc.skill.fleet_ops.invoke",
      targetType: "skill",
      targetId: "delivrix-fleet-ops",
      metadata: {
        endpointsOk: 4,
        endpointsTotal: 4,
        driftCount: 0
      }
    })
  ];

  const first = await cache.resolve(
    "/v1/openclaw/skills/audit",
    async (now) => {
      liveCalls += 1;
      return buildOpenClawSkillsAudit({ auditEvents, now });
    },
    (now) => buildOpenClawSkillsAudit({ now })
  );

  nowMs += 1_500;
  const second = await cache.resolve(
    "/v1/openclaw/skills/audit",
    async (now) => {
      liveCalls += 1;
      return buildOpenClawSkillsAudit({ auditEvents, now });
    },
    (now) => buildOpenClawSkillsAudit({ now })
  );

  assert.equal(first.meta.dataSource, "live");
  assert.equal(second.meta.dataSource, "cached");
  assert.equal(second.meta.staleSinceMs, 1_500);
  assert.equal(second.events[0]?.body, "Skill fleet_ops invocada · 4/4 endpoints OK · 0 drift");
  assert.equal(liveCalls, 1);
});

function event(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    occurredAt: "2026-05-20T17:00:00.000Z",
    actorType: "system",
    actorId: "gateway-api",
    action: "oc.audit.test",
    targetType: "audit",
    targetId: "test",
    riskLevel: "low",
    metadata: {},
    evidenceRefs: [],
    ...overrides
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "./audit-log.ts";
import {
  buildOpenClawEvidence,
  buildOpenClawSkillsAudit
} from "./openclaw-skills-audit.ts";

const now = new Date("2026-05-20T17:20:00.000Z");

test("Learning real-time builders return MVP fallback for empty audit logs", () => {
  const skillsAudit = buildOpenClawSkillsAudit({ auditEvents: [], now });
  const evidence = buildOpenClawEvidence({ auditEvents: [], now });

  assert.equal(skillsAudit.meta.dataSource, "fallback");
  assert.equal(skillsAudit.events.length, 5);
  assert.equal(skillsAudit.events[0]?.id, "sha256:fa07b3c2");

  assert.equal(evidence.meta.dataSource, "fallback");
  assert.equal(evidence.curated.length, 6);
  assert.equal(evidence.curated[0]?.snapshotId, "snap-7f2a91c4");
});

test("Learning skills audit maps OpenClaw skill and proposal events from audit log", () => {
  const skillsAudit = buildOpenClawSkillsAudit({
    auditEvents: [
      event({
        id: "00000000-0000-4000-8000-000000000001",
        occurredAt: "2026-05-20T17:01:00.000Z",
        action: "oc.skill.fleet_ops.invoke",
        actorType: "openclaw",
        actorId: "openclaw",
        metadata: {
          endpointsOk: 3,
          endpointsTotal: 4,
          driftCount: 1
        }
      }),
      event({
        id: "00000000-0000-4000-8000-000000000002",
        occurredAt: "2026-05-20T17:03:00.000Z",
        action: "oc.skill.publish_proposal.completed",
        actorType: "openclaw",
        actorId: "openclaw-hostinger-prod",
        metadata: {
          proposalId: "oc.proposal.1779201046.pause-ip.svc-mvp-test-03",
          skillSlug: "delivrix-publish-proposal",
          lessonId: "lesson-2026-05-20-01"
        }
      }),
      event({
        id: "00000000-0000-4000-8000-000000000003",
        occurredAt: "2026-05-20T17:02:00.000Z",
        action: "oc.proposal.approved",
        actorType: "operator",
        actorId: "op-juanes-a",
        riskLevel: "medium",
        metadata: {
          targetRef: "svc-mvp-test-03"
        }
      }),
      event({
        id: "00000000-0000-4000-8000-000000000004",
        occurredAt: "2026-05-20T17:04:00.000Z",
        action: "read:health",
        actorType: "system",
        actorId: "gateway-api"
      })
    ],
    now
  });

  assert.equal(skillsAudit.meta.dataSource, "live");
  assert.deepEqual(skillsAudit.events.map((item) => item.id), [
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000001"
  ]);
  assert.equal(skillsAudit.events[0]?.body, "Propuesta inyectada en Canvas · proposalId=.svc-mvp-test-03");
  assert.equal(skillsAudit.events[0]?.skillId, "delivrix-publish-proposal");
  assert.equal(skillsAudit.events[0]?.lessonId, "lesson-2026-05-20-01");
  assert.equal(skillsAudit.events[1]?.body, "op-juanes-a aprobó propuesta · target svc-mvp-test-03");
  assert.equal(skillsAudit.events[2]?.body, "Skill fleet_ops invocada · 3/4 endpoints OK · 1 drift");
  assert.equal(skillsAudit.events[2]?.skillId, "skill.fleet_ops");
});

test("Learning evidence maps evidenceRefs, dedupes by proposal hash and derives type and impact", () => {
  const evidence = buildOpenClawEvidence({
    auditEvents: [
      event({
        id: "00000000-0000-4000-8000-000000000011",
        occurredAt: "2026-05-20T17:01:00.000Z",
        action: "oc.skill.fleet_ops.invoke",
        actorType: "openclaw",
        actorId: "openclaw",
        evidenceRefs: ["gateway:/v1/webdock/inventory#sha256:webdock"],
        metadata: {
          endpointsOk: 3,
          endpointsTotal: 4,
          driftCount: 2
        }
      }),
      event({
        id: "00000000-0000-4000-8000-000000000012",
        occurredAt: "2026-05-20T17:02:00.000Z",
        action: "oc.proposal.submitted",
        actorType: "openclaw",
        actorId: "openclaw-hostinger-prod",
        riskLevel: "medium",
        evidenceRefs: ["gateway:/v1/sender-nodes#sha256:pause"],
        metadata: {
          category: "node_pause_proposed",
          severity: "high",
          targetRef: "svc-mvp-test-03",
          proposalHash: "same-proposal"
        }
      }),
      event({
        id: "00000000-0000-4000-8000-000000000013",
        occurredAt: "2026-05-20T17:03:00.000Z",
        action: "oc.proposal.approved",
        actorType: "operator",
        actorId: "op-juanes-a",
        riskLevel: "medium",
        evidenceRefs: ["gateway:/v1/sender-nodes#sha256:approval"],
        metadata: {
          targetRef: "svc-mvp-test-03",
          proposalHash: "same-proposal"
        }
      }),
      event({
        id: "00000000-0000-4000-8000-000000000014",
        occurredAt: "2026-05-20T17:04:00.000Z",
        action: "oc.runbook.pause_ip.executed",
        actorType: "system",
        actorId: "gateway-api",
        riskLevel: "high",
        evidenceRefs: ["gateway:/v1/sender-nodes#sha256:runbook"],
        metadata: {
          targetRef: "svc-mvp-test-03"
        }
      })
    ],
    now
  });

  assert.equal(evidence.meta.dataSource, "live");
  assert.equal(evidence.curated.length, 3);
  assert.equal(evidence.curated[0]?.type, "Promoción");
  assert.equal(evidence.curated[0]?.impact, "alto");
  assert.equal(evidence.curated[1]?.type, "Evidencia humana");
  assert.equal(evidence.curated[1]?.impact, "bajo");
  assert.equal(evidence.curated[2]?.type, "Webdock drift");
  assert.match(evidence.curated[2]?.snapshotId ?? "", /^snap-[a-f0-9]{8}$/);
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

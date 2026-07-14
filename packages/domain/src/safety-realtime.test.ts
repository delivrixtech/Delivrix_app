import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "./audit-log.ts";
import { buildComplianceStatus } from "./compliance-status.ts";
import { buildIamRoles, buildIamSessions } from "./iam-supervised.ts";

const now = new Date("2026-05-20T16:35:00.000Z");

test("safety real-time builders return MVP fallback for empty audit logs", () => {
  const compliance = buildComplianceStatus({ auditEvents: [], now });
  const roles = buildIamRoles({ auditEvents: [], now });
  const sessions = buildIamSessions({ auditEvents: [], now });

  assert.equal(compliance.meta.dataSource, "fallback");
  assert.equal(compliance.controls.find((control) => control.id === "operational")?.state, "warning");
  assert.equal(compliance.controls.find((control) => control.id === "gdpr")?.lines.length, 3);

  assert.equal(roles.meta.dataSource, "fallback");
  assert.equal(roles.roles.find((role) => role.id === "operator")?.userCount, 4);
  assert.equal(roles.roles.find((role) => role.id === "operator")?.displayName, "Operador supervisado (sólo lectura)");
  assert.equal(roles.roles.find((role) => role.id === "read-only")?.displayName, "Sólo lectura");

  assert.equal(sessions.meta.dataSource, "fallback");
  // Estado vacío honesto: sin eventos de auditoría no se fabrican sesiones.
  assert.deepEqual(sessions.sessions, []);
});

test("safety real-time builders derive compliance, role counts and sessions from audit events", () => {
  const auditEvents = [
    event({
      occurredAt: "2026-05-20T16:00:00.000Z",
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: "oc.proposal.submitted",
      targetType: "proposal",
      targetId: "proposal-1",
      riskLevel: "high"
    }),
    event({
      occurredAt: "2026-05-20T16:01:00.000Z",
      actorType: "system",
      actorId: "gateway-api",
      action: "oc.approval.quorum_reached",
      targetType: "proposal",
      targetId: "proposal-1",
      riskLevel: "medium",
      humanApproved: true
    }),
    event({
      occurredAt: "2026-05-20T16:02:00.000Z",
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: "oc.proposal.submitted",
      targetType: "proposal",
      targetId: "proposal-2",
      riskLevel: "medium"
    }),
    event({
      occurredAt: "2026-05-20T15:50:00.000Z",
      action: "oc.permission.rejected",
      targetType: "proposal",
      targetId: "proposal-3",
      rejectReason: "prohibited_action"
    }),
    event({
      occurredAt: "2026-05-20T15:59:00.000Z",
      actorType: "operator",
      actorId: "op-juanes-a",
      action: "oc.proposal.approved",
      targetType: "proposal",
      targetId: "proposal-1",
      riskLevel: "medium"
    }),
    event({
      occurredAt: "2026-05-20T15:58:00.000Z",
      actorType: "system",
      actorId: "gateway-api",
      action: "oc.skill.fleet_ops.invoke",
      targetType: "skill",
      targetId: "fleet-ops",
      evidenceRefs: ["gateway:/v1/hardware/telemetry/latest#sha256:test"]
    }),
    event({
      occurredAt: "2026-05-20T15:57:00.000Z",
      actorType: "operator",
      actorId: "auditor-ext-1",
      action: "read:audit-events",
      targetType: "audit_log",
      targetId: "audit-events.jsonl"
    }),
    event({
      occurredAt: "2026-05-20T16:30:00.000Z",
      actorType: "operator",
      actorId: "op-active",
      action: "oc.eval.c2.operator_override",
      targetType: "evaluation",
      targetId: "c2",
      riskLevel: "high",
      metadata: { location: "Popayán · CO" }
    }),
    event({
      occurredAt: "2026-05-20T16:25:00.000Z",
      actorType: "system",
      actorId: "gateway-api",
      action: "oc.approval_token.issued",
      targetType: "approval_token",
      targetId: "token-1",
      riskLevel: "medium",
      metadata: {
        approverId: "token-operator",
        expiresAt: "2026-05-20T16:40:00.000Z"
      }
    }),
    event({
      occurredAt: "2026-05-20T16:31:00.000Z",
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: "oc.eval.c2.completed",
      targetType: "evaluation",
      targetId: "c2",
      metadata: { sessionKey: "agent:main:c2" }
    })
  ];

  const compliance = buildComplianceStatus({
    auditEvents,
    chainOk: true,
    killSwitchArmed: true,
    now
  });
  const roles = buildIamRoles({ auditEvents, now });
  const sessions = buildIamSessions({ auditEvents, now });

  assert.equal(compliance.meta.dataSource, "live");
  assert.equal(compliance.controls.find((control) => control.id === "gdpr")?.state, "ok");
  assert.equal(compliance.controls.find((control) => control.id === "operational")?.state, "warning");
  assert.equal(compliance.controls.find((control) => control.id === "anti-abuse")?.state, "warning");
  assert.equal(compliance.controls.find((control) => control.id === "operational")?.metrics?.pendingProposals, 1);

  assert.equal(roles.meta.dataSource, "live");
  assert.equal(roles.roles.find((role) => role.id === "operator")?.userCount, 1);
  assert.equal(roles.roles.find((role) => role.id === "sre")?.userCount, 1);
  assert.equal(roles.roles.find((role) => role.id === "external-auditor")?.userCount, 1);
  assert.equal(roles.roles.find((role) => role.id === "read-only")?.userCount, 5);

  assert.equal(sessions.meta.dataSource, "live");
  assert.equal(sessions.sessions.length, 3);
  assert.equal(sessions.sessions.find((session) => session.actor === "token-operator")?.transport, "mfa");
  assert.equal(sessions.sessions.find((session) => session.actor === "op-active")?.location, "Popayán · CO");
  assert.equal(sessions.sessions.find((session) => session.actor === "openclaw-hostinger-prod")?.transport, "internal");
});

test("IAM sessions return live empty state when audit exists but no session is active", () => {
  const sessions = buildIamSessions({
    auditEvents: [
      event({
        occurredAt: "2026-05-20T15:00:00.000Z",
        actorType: "operator",
        actorId: "op-old",
        action: "oc.proposal.approved",
        targetType: "proposal",
        targetId: "proposal-old"
      })
    ],
    now
  });

  assert.equal(sessions.meta.dataSource, "live");
  assert.deepEqual(sessions.sessions, []);
});

function event(overrides: Partial<AuditEvent>): AuditEvent {
  return {
    id: "018f7b54-7d4d-7cc2-9c90-df7486c5a111",
    occurredAt: "2026-05-20T16:00:00.000Z",
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

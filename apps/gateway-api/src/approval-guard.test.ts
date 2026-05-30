import test from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent, CanvasLiveArtifactSnapshot } from "../../../packages/domain/src/index.ts";
import {
  approvalTokenHash,
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken
} from "./approval-guard.ts";

test("hashed approval guard accepts private token and rejects public signature id", () => {
  const privateToken = "approval-token-private";
  const publicSignatureId = "sig-public";
  const event = approvalEvent({
    executionId: publicSignatureId,
    approvalTokenHash: approvalTokenHash(privateToken)
  });

  assert.equal(auditApprovalMatchesToken(event, privateToken), true);
  assert.equal(auditApprovalMatchesToken(event, publicSignatureId), false);
  assert.equal(
    artifactMatchesAuditApproval({
      artifact: artifact(publicSignatureId),
      approvalEvent: event,
      approvalToken: privateToken,
      now: new Date("2026-05-29T21:00:30.000Z"),
      maxAgeMs: 60_000
    }),
    true
  );
});

test("approval guard rejects legacy executionId-only approvals", () => {
  const legacyToken = "exec-legacy";
  const event = approvalEvent({ executionId: legacyToken });
  assert.equal(auditApprovalMatchesToken(event, legacyToken), false);
  assert.equal(
    artifactMatchesAuditApproval({
      artifact: artifact(legacyToken),
      approvalEvent: event,
      approvalToken: legacyToken,
      now: new Date("2026-05-29T21:00:30.000Z"),
      maxAgeMs: 60_000
    }),
    true
  );
});

function approvalEvent(metadata: Record<string, unknown>): AuditEvent {
  return {
    id: "audit-1",
    actorType: "operator",
    actorId: "operator-juanes",
    action: "oc.artifact.approved",
    targetType: "domain",
    targetId: "delivrix.test",
    occurredAt: "2026-05-29T21:00:00.000Z",
    riskLevel: "high",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator-juanes"],
    killSwitchState: "unknown",
    rollbackToken: null,
    schemaVersion: "2026-05-18.v1",
    promptVersion: null,
    modelVersion: null,
    evidenceRefs: [],
    metadata,
    prevHash: "GENESIS",
    hash: "hash-1"
  };
}

function artifact(executionId: string): CanvasLiveArtifactSnapshot {
  return {
    artifactId: "artifact-1",
    taskId: "task-1",
    kind: "proposal",
    title: "Approval",
    editable: true,
    createdAt: "2026-05-29T21:00:00.000Z",
    updatedAt: "2026-05-29T21:00:00.000Z",
    approvalStatus: "approved",
    approvedBy: "operator-juanes",
    approvedAt: "2026-05-29T21:00:00.000Z",
    executionId,
    blocks: []
  };
}

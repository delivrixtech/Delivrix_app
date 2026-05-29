import assert from "node:assert/strict";
import test from "node:test";
import { hardenIncomingAuditBatchEvent } from "./audit-batch-origin.ts";

test("hardenIncomingAuditBatchEvent overwrites impersonated actor fields", () => {
  const result = hardenIncomingAuditBatchEvent({
    actorType: "operator",
    actorId: "juanes",
    action: "oc.test.event",
    targetType: "audit",
    targetId: "1",
    riskLevel: "low",
    metadata: {}
  });

  assert.equal(result.event.actorType, "openclaw");
  assert.equal(result.event.actorId, "openclaw-hostinger-prod");
  assert.equal(result.impersonationAttempt, true);
  assert.equal(result.event.metadata._impersonation_attempt, true);
  assert.equal(result.event.metadata.claimedActorType, "operator");
});

test("hardenIncomingAuditBatchEvent strips humanApproved without signatureId", () => {
  const result = hardenIncomingAuditBatchEvent({
    actorType: "openclaw",
    actorId: "openclaw-hostinger-prod",
    action: "oc.test.event",
    targetType: "audit",
    targetId: "1",
    riskLevel: "low",
    humanApproved: true,
    approverIds: ["juanes"],
    metadata: {}
  });

  assert.equal(result.event.humanApproved, false);
  assert.deepEqual(result.event.approverIds, []);
  assert.equal(result.humanApprovalStripped, true);
  assert.equal(result.event.metadata._human_approval_stripped, true);
});

test("hardenIncomingAuditBatchEvent preserves humanApproved only with a trusted signatureId", () => {
  const result = hardenIncomingAuditBatchEvent({
    actorType: "openclaw",
    actorId: "openclaw-hostinger-prod",
    action: "oc.test.event",
    targetType: "audit",
    targetId: "1",
    riskLevel: "low",
    humanApproved: true,
    approverIds: ["juanes"],
    metadata: { signatureId: "sig-1" }
  }, {
    validSignatureIds: ["sig-1"]
  });

  assert.equal(result.event.humanApproved, true);
  assert.deepEqual(result.event.approverIds, ["juanes"]);
  assert.equal(result.humanApprovalStripped, false);
});

test("hardenIncomingAuditBatchEvent strips unknown signatureId", () => {
  const result = hardenIncomingAuditBatchEvent({
    actorType: "openclaw",
    actorId: "openclaw-hostinger-prod",
    action: "oc.test.event",
    targetType: "audit",
    targetId: "1",
    riskLevel: "low",
    humanApproved: true,
    approverIds: ["juanes"],
    metadata: { signatureId: "sig-untrusted" }
  });

  assert.equal(result.event.humanApproved, false);
  assert.deepEqual(result.event.approverIds, []);
  assert.equal(result.humanApprovalStripped, true);
});

test("hardenIncomingAuditBatchEvent drops caller supplied chain fields", () => {
  const result = hardenIncomingAuditBatchEvent({
    actorType: "openclaw",
    actorId: "openclaw-hostinger-prod",
    action: "oc.test.event",
    targetType: "audit",
    targetId: "1",
    riskLevel: "low",
    metadata: {},
    prevHash: "spoofed-prev",
    hash: "spoofed-hash"
  });

  assert.equal("prevHash" in result.event, false);
  assert.equal("hash" in result.event, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNfcBridgeCapacityPlan,
  evaluateNfcBridgeReadiness
} from "./nfc-bridge.ts";
import type { SenderNode } from "./types.ts";

test("builds inactive NFC provider and SMTP server payloads in mock mode", () => {
  const plan = buildNfcBridgeCapacityPlan({
    senderNodes: [node()],
    actorId: "operator_1",
    emailsPerMinute: 3
  }, new Date("2026-05-02T00:00:00.000Z"));

  assert.equal(plan.mode, "mock");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.sideEffects, "none");
  assert.equal(plan.summary.payloadReady, 1);
  assert.equal(plan.summary.providersToCreate, 1);
  assert.equal(plan.items[0].providerPayload?.isActive, false);
  assert.equal(plan.items[0].providerPayload?.emailFromAddress, "mailops@delivrix.local");
  assert.equal(plan.items[0].smtpServerPayload?.sshUser, "pending-secret-managed-user");
  assert.ok(plan.blockedOperations.includes("nfc-provider-create-live"));
});

test("blocks nodes missing IP or hostname from NFC payload generation", () => {
  const plan = buildNfcBridgeCapacityPlan({
    senderNodes: [{ ...node(), ipAddress: undefined }]
  });

  assert.equal(plan.summary.blocked, 1);
  assert.equal(plan.summary.providersToCreate, 0);
  assert.deepEqual(plan.items[0].readiness.reasons, ["missing_ip_address"]);
});

test("requires review for degraded nodes but still builds inactive payload", () => {
  const readiness = evaluateNfcBridgeReadiness({
    ...node(),
    status: "degraded"
  });

  assert.equal(readiness.status, "needs_review");
  assert.deepEqual(readiness.reasons, ["sender_node_status_degraded"]);
});

function node(): SenderNode {
  return {
    id: "sender_proxmox_001",
    label: "Proxmox Sender 001",
    provider: "proxmox",
    status: "warming",
    ipAddress: "203.0.113.10",
    hostname: "mx001.delivrix.local",
    dailyLimit: 25,
    warmupDay: 1
  };
}

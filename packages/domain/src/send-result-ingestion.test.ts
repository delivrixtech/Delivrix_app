import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSendResultIngestion } from "./send-result-ingestion.ts";
import type { SendJob, SenderNode } from "./types.ts";

test("allows complaint ingestion and recommends suppression", () => {
  const decision = evaluateSendResultIngestion({
    sendJobId: "sendjob_001",
    status: "complaint",
    complaintSource: "mock-fbl"
  }, {
    job: jobFixture({ senderNodeId: "sender_001" }),
    senderNode: senderNodeFixture("sender_001")
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "critical");
  assert.deepEqual(decision.suppression, {
    email: "recipient@example.com",
    reason: "complaint",
    source: "mock-fbl"
  });
});

test("allows hard bounce ingestion and recommends hard bounce suppression", () => {
  const decision = evaluateSendResultIngestion({
    sendJobId: "sendjob_001",
    status: "bounce",
    bounceCode: "5.1.1"
  }, {
    job: jobFixture({ senderNodeId: "sender_001" }),
    senderNode: senderNodeFixture("sender_001")
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "high");
  assert.equal(decision.suppression?.reason, "hard_bounce");
});

test("does not suppress soft bounces", () => {
  const decision = evaluateSendResultIngestion({
    sendJobId: "sendjob_001",
    status: "bounce",
    bounceCode: "4.2.0"
  }, {
    job: jobFixture({ senderNodeId: "sender_001" }),
    senderNode: senderNodeFixture("sender_001")
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.suppression, undefined);
});

test("blocks sent status because external mock ingestion is for reputation events", () => {
  const decision = evaluateSendResultIngestion({
    sendJobId: "sendjob_001",
    status: "sent"
  }, {
    job: jobFixture({ senderNodeId: "sender_001" }),
    senderNode: senderNodeFixture("sender_001")
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "send_result_ingestion_invalid_status");
});

test("blocks sender node mismatch", () => {
  const decision = evaluateSendResultIngestion({
    sendJobId: "sendjob_001",
    senderNodeId: "sender_other",
    status: "complaint"
  }, {
    job: jobFixture({ senderNodeId: "sender_001" }),
    senderNode: senderNodeFixture("sender_other")
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "send_result_ingestion_sender_node_mismatch");
});

test("requires sender node when job is unassigned", () => {
  const decision = evaluateSendResultIngestion({
    sendJobId: "sendjob_001",
    status: "failed"
  }, {
    job: jobFixture({})
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "send_result_ingestion_sender_node_required");
});

function jobFixture(overrides: Partial<SendJob>): SendJob {
  return {
    id: "sendjob_001",
    status: "completed",
    createdAt: "2026-05-02T00:00:00.000Z",
    request: {
      campaignId: "campaign_001",
      recipient: {
        email: "recipient@example.com",
        consentProofId: "proof_001"
      },
      sender: {
        address: "hello@delivrix.com",
        domain: "delivrix.com"
      },
      subject: "Hello",
      bodyText: "Body",
      classification: "commercial",
      unsubscribeUrl: "https://delivrix.com/unsubscribe",
      physicalAddress: "Delivrix LLC physical mailing address"
    },
    ...overrides
  };
}

function senderNodeFixture(id: string): SenderNode {
  return {
    id,
    label: "Sender",
    provider: "webdock",
    status: "active",
    dailyLimit: 100,
    warmupDay: 1
  };
}

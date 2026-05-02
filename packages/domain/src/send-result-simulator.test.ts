import test from "node:test";
import assert from "node:assert/strict";
import { simulateSendResult } from "./send-result-simulator.ts";
import type { SendJob } from "./types.ts";

test("simulates sent by default", () => {
  assert.equal(simulateSendResult(job("hello@example.com")).status, "sent");
});

test("simulates bounce from recipient pattern", () => {
  const result = simulateSendResult(job("bounce@example.com"));

  assert.equal(result.status, "bounce");
  assert.equal(result.bounceCode, "5.1.1");
});

test("simulates complaint from metadata override", () => {
  const result = simulateSendResult(job("hello@example.com", "complaint"));

  assert.equal(result.status, "complaint");
  assert.equal(result.complaintSource, "simulated-feedback-loop");
});

function job(email: string, simulatedResult?: string): SendJob {
  return {
    id: "sendjob_test",
    status: "processing",
    createdAt: "2026-05-02T00:00:00.000Z",
    request: {
      campaignId: "campaign_test",
      recipient: {
        email,
        consentProofId: "proof"
      },
      sender: {
        address: "hello@delivrix.com",
        domain: "delivrix.com"
      },
      subject: "Subject",
      bodyText: "Body",
      classification: "commercial",
      unsubscribeUrl: "https://delivrix.com/unsubscribe",
      physicalAddress: "Delivrix LLC physical mailing address",
      metadata: simulatedResult ? { simulatedResult } : undefined
    }
  };
}

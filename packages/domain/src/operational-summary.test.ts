import test from "node:test";
import assert from "node:assert/strict";
import { buildOperationalSummary } from "./operational-summary.ts";
import type { AuditEvent } from "./audit-log.ts";
import type { RateLimitCounter } from "./rate-limit.ts";
import type { SendJob, SendResult, SenderNode } from "./types.ts";

test("builds operational summary from jobs, nodes, audit events and counters", () => {
  const jobs: SendJob[] = [
    job("job_1", "queued", "campaign_a", "a@example.com", "sender_1"),
    job("job_2", "completed", "campaign_a", "b@example.com", "sender_1"),
    job("job_3", "blocked", "campaign_b", "c@another.com")
  ];
  const senderNodes: SenderNode[] = [
    {
      id: "sender_1",
      label: "Sender 1",
      provider: "webdock",
      status: "warming",
      dailyLimit: 50,
      warmupDay: 1
    },
    {
      id: "sender_2",
      label: "Sender 2",
      provider: "webdock",
      status: "paused",
      dailyLimit: 0,
      warmupDay: 1
    }
  ];
  const auditEvents: AuditEvent[] = [
    audit("send_request.accepted"),
    audit("send_request.accepted"),
    audit("send_job.rate_limited")
  ];
  const rateLimitCounters: RateLimitCounter[] = [
    {
      scope: "sender_node",
      id: "sender_1",
      window: "daily",
      windowKey: "2026-05-02",
      count: 2
    }
  ];
  const sendResults: SendResult[] = [
    result("result_1", "job_2", "sent", "sender_1"),
    result("result_2", "job_3", "bounce")
  ];

  const summary = buildOperationalSummary({
    jobs,
    sendResults,
    senderNodes,
    auditEvents,
    rateLimitCounters,
    now: new Date("2026-05-02T12:00:00.000Z")
  });

  assert.equal(summary.generatedAt, "2026-05-02T12:00:00.000Z");
  assert.equal(summary.totals.jobs, 3);
  assert.equal(summary.totals.sendResults, 2);
  assert.equal(summary.jobsByStatus.queued, 1);
  assert.equal(summary.jobsByStatus.completed, 1);
  assert.equal(summary.jobsByStatus.blocked, 1);
  assert.equal(summary.senderNodesByStatus.warming, 1);
  assert.equal(summary.senderNodesByStatus.paused, 1);
  assert.equal(summary.sendResultsByStatus.sent, 1);
  assert.equal(summary.sendResultsByStatus.bounce, 1);
  assert.deepEqual(summary.jobsByCampaign[0], { key: "campaign_a", count: 2 });
  assert.deepEqual(summary.sendResultsByCampaign[0], { key: "campaign_a", count: 1 });
  assert.deepEqual(summary.jobsBySenderNode[0], { key: "sender_1", count: 2 });
  assert.deepEqual(summary.sendResultsBySenderNode[0], { key: "sender_1", count: 1 });
  assert.deepEqual(summary.jobsByRecipientDomain[0], { key: "example.com", count: 2 });
  assert.deepEqual(summary.auditActions[0], { key: "send_request.accepted", count: 2 });
  assert.equal(summary.rateLimitCounters[0]?.count, 2);
});

function job(
  id: string,
  status: SendJob["status"],
  campaignId: string,
  recipientEmail: string,
  senderNodeId?: string
): SendJob {
  return {
    id,
    status,
    senderNodeId,
    createdAt: "2026-05-02T00:00:00.000Z",
    request: {
      campaignId,
      recipient: {
        email: recipientEmail,
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
      physicalAddress: "Delivrix LLC physical mailing address"
    }
  };
}

function result(id: string, sendJobId: string, status: SendResult["status"], senderNodeId?: string): SendResult {
  return {
    id,
    sendJobId,
    senderNodeId,
    status,
    metadata: {
      simulated: true
    },
    occurredAt: "2026-05-02T00:00:00.000Z"
  };
}

function audit(action: string): AuditEvent {
  return {
    id: `audit_${action}`,
    occurredAt: "2026-05-02T00:00:00.000Z",
    actorType: "system",
    actorId: "test",
    action,
    targetType: "send_job",
    targetId: "job",
    riskLevel: "low",
    metadata: {}
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { findStuckProcessingJobs } from "./stuck-job-recovery.ts";
import type { SendJob } from "./types.ts";

test("detects processing jobs older than the stale threshold", () => {
  const stuckJobs = findStuckProcessingJobs({
    jobs: [
      jobFixture("stuck", "processing", {
        createdAt: "2026-05-02T09:00:00.000Z"
      }),
      jobFixture("fresh", "processing", {
        createdAt: "2026-05-02T09:59:00.000Z"
      })
    ],
    staleAfterMs: 5 * 60 * 1000,
    now: new Date("2026-05-02T10:00:00.000Z")
  });

  assert.equal(stuckJobs.length, 1);
  assert.equal(stuckJobs[0]?.jobId, "stuck");
  assert.equal(stuckJobs[0]?.ageMs, 60 * 60 * 1000);
});

test("uses processingStartedAt when available", () => {
  const stuckJobs = findStuckProcessingJobs({
    jobs: [
      jobFixture("not_stuck", "processing", {
        createdAt: "2026-05-02T08:00:00.000Z",
        processingStartedAt: "2026-05-02T09:59:00.000Z"
      })
    ],
    staleAfterMs: 5 * 60 * 1000,
    now: new Date("2026-05-02T10:00:00.000Z")
  });

  assert.equal(stuckJobs.length, 0);
});

test("ignores jobs that are not processing", () => {
  const stuckJobs = findStuckProcessingJobs({
    jobs: [
      jobFixture("queued", "queued", {
        createdAt: "2026-05-02T08:00:00.000Z"
      }),
      jobFixture("completed", "completed", {
        createdAt: "2026-05-02T08:00:00.000Z"
      })
    ],
    staleAfterMs: 5 * 60 * 1000,
    now: new Date("2026-05-02T10:00:00.000Z")
  });

  assert.equal(stuckJobs.length, 0);
});

test("rejects invalid stale thresholds", () => {
  assert.throws(() => {
    findStuckProcessingJobs({
      jobs: [],
      staleAfterMs: 0
    });
  }, /positive number/);
});

function jobFixture(
  id: string,
  status: SendJob["status"],
  overrides: Partial<SendJob>
): SendJob {
  return {
    id,
    status,
    createdAt: "2026-05-02T09:00:00.000Z",
    request: {
      campaignId: "campaign_001",
      recipient: {
        email: "person@example.com"
      },
      sender: {
        address: "hello@delivrix.com",
        domain: "delivrix.com"
      },
      subject: "Test",
      bodyText: "Body",
      classification: "operational"
    },
    ...overrides
  };
}

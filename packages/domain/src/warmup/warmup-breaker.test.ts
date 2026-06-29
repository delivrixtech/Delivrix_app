import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WARMUP_BREAKER_THRESHOLDS,
  evaluateWarmupBreaker
} from "./warmup-breaker.ts";

test("pauses on high bounce rate (existing behavior preserved)", () => {
  const d = evaluateWarmupBreaker({ sent: 100, bounced: 6 });
  assert.equal(d.action, "pause");
  assert.equal(d.reason, "auto_bounce_rate");
});

test("pauses on spam-complaint rate above 0.30% even with zero bounces", () => {
  const d = evaluateWarmupBreaker({ sent: 1000, bounced: 0, complaints: 4 }); // 0.40%
  assert.equal(d.action, "pause");
  assert.equal(d.reason, "auto_spam_rate");
});

test("does NOT pause on spam when complaint rate is under the threshold", () => {
  const d = evaluateWarmupBreaker({ sent: 1000, bounced: 0, complaints: 2 }); // 0.20%
  assert.notEqual(d.reason, "auto_spam_rate");
});

test("pauses on poor placement (seed mail landing in Spam)", () => {
  const d = evaluateWarmupBreaker({ sent: 100, bounced: 0, seedInbox: 7, seedSpam: 3 }); // 70% inbox
  assert.equal(d.action, "pause");
  assert.equal(d.reason, "auto_placement");
  assert.equal(d.metrics.placementRate, 0.7);
});

test("throttles (does not pause) when placement is slipping but above the floor", () => {
  const d = evaluateWarmupBreaker({ sent: 100, bounced: 0, seedInbox: 17, seedSpam: 3 }); // 85%
  assert.equal(d.action, "throttle");
  assert.equal(d.reason, undefined);
});

test("continues when all signals are healthy", () => {
  const d = evaluateWarmupBreaker({ sent: 100, bounced: 1, complaints: 0, seedInbox: 19, seedSpam: 1 }); // 95%
  assert.equal(d.action, "continue");
});

test("ignores placement until there are enough seed samples", () => {
  const d = evaluateWarmupBreaker({ sent: 100, bounced: 0, seedInbox: 2, seedSpam: 1 }); // 3 < 5
  assert.equal(d.metrics.placementRate, null);
  assert.equal(d.action, "continue");
});

test("bounce takes precedence over spam and placement", () => {
  const d = evaluateWarmupBreaker({ sent: 100, bounced: 10, complaints: 5, seedInbox: 0, seedSpam: 10 });
  assert.equal(d.reason, "auto_bounce_rate");
});

test("thresholds are configurable", () => {
  const strict = evaluateWarmupBreaker({ sent: 1000, bounced: 0, complaints: 2 }, { spamRate: 0.001 });
  assert.equal(strict.reason, "auto_spam_rate");
  assert.equal(DEFAULT_WARMUP_BREAKER_THRESHOLDS.spamRate, 0.003);
});

test("empty window is safe (no division by zero) and continues", () => {
  const d = evaluateWarmupBreaker({ sent: 0, bounced: 0 });
  assert.equal(d.action, "continue");
  assert.equal(d.metrics.bounceRate, 0);
});

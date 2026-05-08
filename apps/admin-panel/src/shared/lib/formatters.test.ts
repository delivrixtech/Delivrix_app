import assert from "node:assert/strict";
import test from "node:test";
import {
  compactLabel,
  formatMetricValue,
  percent,
  stateTone
} from "./formatters.ts";

test("compactLabel converts backend vocabulary for display", () => {
  assert.equal(compactLabel("liveInfrastructureWritesEnabled"), "liveInfrastructureWritesEnabled");
  assert.equal(compactLabel("needs_review"), "needs review");
  assert.equal(compactLabel("5.6-canvas-hardware-ml-devops-contracts"), "5.6 canvas hardware ml devops contracts");
});

test("stateTone maps operational states", () => {
  assert.equal(stateTone("ready"), "success");
  assert.equal(stateTone("needs_review"), "warning");
  assert.equal(stateTone("blocked"), "critical");
  assert.equal(stateTone("unknown"), "neutral");
});

test("percent and metric formatting handle unknown values", () => {
  assert.equal(percent(null), "unknown");
  assert.equal(percent(42.4), "42%");
  assert.equal(formatMetricValue(null, "GB"), "unknown");
  assert.equal(formatMetricValue(24, "cores"), "24 cores");
});

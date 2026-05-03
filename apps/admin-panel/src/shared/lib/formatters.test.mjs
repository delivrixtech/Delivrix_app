import assert from "node:assert/strict";
import test from "node:test";
import {
  compactLabel,
  percent,
  stateTone
} from "./formatters.js";

test("compactLabel converts backend vocabulary for display", () => {
  assert.equal(compactLabel("retired_pending_approval"), "retired pending approval");
  assert.equal(compactLabel("5.4-admin-panel"), "5.4 admin panel");
});

test("stateTone maps operational states", () => {
  assert.equal(stateTone("critical"), "critical");
  assert.equal(stateTone("degraded"), "warning");
  assert.equal(stateTone("needs_evidence"), "warning");
  assert.equal(stateTone("healthy"), "success");
  assert.equal(stateTone("dry_run_ready"), "success");
  assert.equal(stateTone("unknown"), "neutral");
});

test("percent handles empty totals", () => {
  assert.equal(percent(2, 4), 50);
  assert.equal(percent(2, 0), 0);
});

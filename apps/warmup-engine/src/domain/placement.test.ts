import assert from "node:assert/strict";
import test from "node:test";
import { computePlacement, placementMeetsBar, shouldAutoPause } from "./placement.ts";
import { DEFAULT_WARMUP_POLICY, type SeedCheck } from "./types.ts";

function check(landedIn: SeedCheck["landedIn"]): SeedCheck {
  return { nodeId: "n1", seedInbox: "seed@gmail.test", sentAt: new Date("2026-07-09T10:00:00Z"), landedIn };
}

test("computePlacement cuenta solo checks leídos; los pendientes (null) no diluyen", () => {
  const result = computePlacement([check("primary"), check("primary"), check("spam"), check(null)]);
  assert.equal(result.measured, 3);
  assert.equal(result.inbox, 2);
  assert.equal(result.spam, 1);
  assert.equal(result.inboxRate, 2 / 3);
});

test("Promotions NO cuenta como inbox (señal degradada para warmup)", () => {
  const result = computePlacement([check("primary"), check("promotions")]);
  assert.equal(result.inboxRate, 0.5);
});

test("sin medidas => inboxRate undefined (no hay señal)", () => {
  const result = computePlacement([check(null), check(null)]);
  assert.equal(result.measured, 0);
  assert.equal(result.inboxRate, undefined);
});

test("placementMeetsBar respeta minInboxPlacement (default 0.8)", () => {
  assert.equal(placementMeetsBar(computePlacement([check("primary"), check("primary"), check("primary"), check("primary"), check("spam")]), DEFAULT_WARMUP_POLICY), true, "80% pasa");
  assert.equal(placementMeetsBar(computePlacement([check("primary"), check("primary"), check("primary"), check("spam")]), DEFAULT_WARMUP_POLICY), false, "75% no pasa");
});

test("shouldAutoPause solo con evidencia: sin medidas no pausa a ciegas", () => {
  assert.equal(shouldAutoPause(computePlacement([check(null)]), DEFAULT_WARMUP_POLICY), false);
  assert.equal(shouldAutoPause(computePlacement([check("spam"), check("spam"), check("primary")]), DEFAULT_WARMUP_POLICY), true, "33% inbox pausa");
  assert.equal(shouldAutoPause(computePlacement([check("primary"), check("primary"), check("primary"), check("primary"), check("spam")]), DEFAULT_WARMUP_POLICY), false, "80% no pausa");
});

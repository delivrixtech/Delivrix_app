import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKillSwitchState,
  defaultKillSwitchState,
  evaluateKillSwitch
} from "./kill-switch.ts";

test("allows operations when kill switch is inactive", () => {
  const state = defaultKillSwitchState(new Date("2026-05-02T10:00:00.000Z"));
  const decision = evaluateKillSwitch(state, "claim_send_job");

  assert.equal(decision.allowed, true);
  assert.equal(decision.code, "kill_switch_inactive");
});

test("blocks operations when kill switch is active", () => {
  const state = buildKillSwitchState({
    enabled: true,
    reason: "Incident response",
    updatedBy: "operator_001",
    now: new Date("2026-05-02T10:00:00.000Z")
  });
  const decision = evaluateKillSwitch(state, "accept_send_request");

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "kill_switch_active");
  assert.match(decision.message, /Incident response/);
  assert.equal(decision.state.updatedBy, "operator_001");
});

test("requires a reason when enabling kill switch", () => {
  assert.throws(() => {
    buildKillSwitchState({
      enabled: true,
      reason: "   "
    });
  }, /reason is required/);
});

test("builds disabled state with default operator fallback", () => {
  const state = buildKillSwitchState({
    enabled: false,
    now: new Date("2026-05-02T11:00:00.000Z")
  });

  assert.equal(state.enabled, false);
  assert.equal(state.reason, "Kill switch disabled.");
  assert.equal(state.updatedBy, "local-operator");
  assert.equal(state.updatedAt, "2026-05-02T11:00:00.000Z");
});

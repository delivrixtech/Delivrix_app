import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDelivrixMvpDemoBlueprint,
  type OpenClawOnboardingInput
} from "./index.ts";

test("builds a ready end-to-end MVP demo blueprint", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({
    actorId: "operator_1"
  }, new Date("2026-05-03T00:00:00.000Z"));

  assert.equal(blueprint.phase, "5.0-mvp-demo-blueprint-pattern-review");
  assert.equal(blueprint.dryRun, true);
  assert.equal(blueprint.sideEffects, "none");
  assert.equal(blueprint.decision.status, "ready_for_demo");
  assert.equal(blueprint.decision.canRunDemo, true);
  assert.equal(blueprint.decision.canSendRealEmail, false);
  assert.equal(blueprint.decision.canMutateLiveInfrastructure, false);
  assert.equal(blueprint.openClaw.runbook.decision.status, "ready_for_phase_5_demo");
  assert.equal(blueprint.pipeline.steps.length, 7);
  assert.equal(blueprint.pipeline.expectedResult.smtpEnabled, false);
  assert.equal(blueprint.safety.localStateOnlyForPipelineDemo, true);
  assert.ok(blueprint.patternReview.every((item) => item.status === "strong"));
});

test("blocks demo blueprint when onboarding data is incomplete", () => {
  const onboarding: OpenClawOnboardingInput = {
    actorId: "operator_1",
    server: {
      model: "IBM System x3630 M4"
    }
  };
  const blueprint = buildDelivrixMvpDemoBlueprint({
    onboarding
  }, new Date("2026-05-03T00:00:00.000Z"));

  assert.equal(blueprint.decision.status, "blocked");
  assert.equal(blueprint.decision.canRunDemo, false);
  assert.ok(blueprint.decision.blockers.includes("onboarding_no_go"));
  assert.ok(blueprint.patternReview.some((item) => item.pattern === "input completeness over guessing" && item.status === "blocked"));
});

test("allows demo blueprint to model simulated incidents without enabling SMTP", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint({
    simulatedResultStatus: "complaint"
  });

  assert.equal(blueprint.pipeline.expectedResult.status, "complaint");
  assert.equal(blueprint.pipeline.expectedResult.smtpEnabled, false);
  assert.equal(blueprint.pipeline.sendRequest.metadata?.simulatedResult, "complaint");
  assert.equal(blueprint.safety.liveEmailSendingEnabled, false);
});

test("documents the intelligent observe-decide-propose-approve loop", () => {
  const blueprint = buildDelivrixMvpDemoBlueprint();

  assert.ok(blueprint.intelligenceLoop.observe.length > 0);
  assert.ok(blueprint.intelligenceLoop.decide.length > 0);
  assert.ok(blueprint.intelligenceLoop.propose.length > 0);
  assert.ok(blueprint.intelligenceLoop.approve.length > 0);
  assert.ok(blueprint.intelligenceLoop.verify.length > 0);
  assert.ok(blueprint.intelligenceLoop.stop.some((item) => item.includes("Kill switch")));
});

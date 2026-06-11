import assert from "node:assert/strict";
import test from "node:test";
import {
  compactIntentParamSchema,
  configureCompleteSmtpSkillParamSchema
} from "./skill-schemas.ts";
import {
  EpisodicScratchValidationError,
  validateEpisodicEntryInput,
  type InsertEntryInput
} from "../../../packages/storage/src/index.ts";

test("compactIntentParamSchema truncates long decisions for compact_intent only", () => {
  const longDecision = `stored-${"x".repeat(320)}`;
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "completed",
    decision: longDecision,
    steps: [{
      step: 1,
      tool: "suggest_safe_domain",
      inputHash: "a".repeat(64),
      outcome: "success"
    }]
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));
  assert.equal(parsed.data.decision, longDecision.slice(0, 280));
  assert.equal(parsed.data.decision.length, 280);
});

test("compactIntentParamSchema machine-codes free-text errorMessage at the agent producer", () => {
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "failed",
    decision: "stored",
    steps: [{
      step: 1,
      tool: "register_domain",
      inputHash: "a".repeat(64),
      outcome: "failed",
      errorMessage: "Step failed: domain not registered."
    }]
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));
  const errorMessage = parsed.data.steps[0].errorMessage;
  assert.equal(typeof errorMessage, "string");
  assert.match(errorMessage as string, /^[a-z0-9_.:-]+$/);
});

test("compactIntentParamSchema conforms free-text outcomeData at the agent producer", () => {
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "failed",
    decision: "stored",
    steps: [{
      step: 1,
      tool: "register_domain",
      inputHash: "a".repeat(64),
      outcome: "failed",
      outcomeData: { note: "domain not registered" }
    }]
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));
  const outcomeData = parsed.data.steps[0].outcomeData;
  assert.ok(outcomeData && typeof outcomeData === "object");
  // The non-allowlisted free-text key is dropped, leaving a gate-safe object.
  assert.equal(Object.prototype.hasOwnProperty.call(outcomeData, "note"), false);
  assert.deepEqual(outcomeData, {});
});

test("agent producer output passes the storage write-gate where raw free-text would 400", () => {
  const rawErrorMessage = "Step failed: domain not registered.";
  const rawOutcomeData = { note: "domain not registered" };

  // The raw, un-conformed payload is rejected by the storage write-gate (would 400).
  const rawEntry: InsertEntryInput = {
    intentId: "intent-1",
    step: 1,
    tool: "register_domain",
    inputHash: "a".repeat(64),
    outcome: "failed",
    outcomeData: { ...rawOutcomeData },
    errorMessage: rawErrorMessage,
    source: "openclaw"
  };
  assert.throws(
    () => validateEpisodicEntryInput(rawEntry),
    (error: unknown) => error instanceof EpisodicScratchValidationError && error.code === "memory_payload_free_text_forbidden"
  );

  // The agent producer conforms both fields, so the same forwarded payload is gate-safe (would 200).
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "failed",
    decision: "stored",
    steps: [{
      step: 1,
      tool: "register_domain",
      inputHash: "a".repeat(64),
      outcome: "failed",
      outcomeData: { ...rawOutcomeData },
      errorMessage: rawErrorMessage
    }]
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));

  const step = parsed.data.steps[0];
  const conformedEntry: InsertEntryInput = {
    intentId: parsed.data.intentId,
    step: step.step,
    tool: step.tool,
    inputHash: step.inputHash,
    outcome: step.outcome,
    ...(step.outcomeData === undefined ? {} : { outcomeData: step.outcomeData }),
    ...(step.errorClass === undefined ? {} : { errorClass: step.errorClass }),
    ...(step.errorMessage === undefined ? {} : { errorMessage: step.errorMessage }),
    source: "openclaw"
  };
  assert.doesNotThrow(() => validateEpisodicEntryInput(conformedEntry));
});

test("configureCompleteSmtpSkillParamSchema rejects unknown VPS providers fail-closed", () => {
  const parsed = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    vpsProviderId: "contaboo",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });

  assert.equal(parsed.success, false);
  if (parsed.success) assert.fail("unknown provider should be rejected");
  assert.match(parsed.error.issues.join("\n"), /vpsProviderId/);
});

test("configureCompleteSmtpSkillParamSchema normalizes known VPS providers", () => {
  const parsed = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    vpsProviderId: "Contabo",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join("\n"));
  assert.equal(parsed.data.vpsProviderId, "contabo");
});

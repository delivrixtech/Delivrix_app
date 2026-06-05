import assert from "node:assert/strict";
import test from "node:test";
import { compactIntentParamSchema } from "./skill-schemas.ts";

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

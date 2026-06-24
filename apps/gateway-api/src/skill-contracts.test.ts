import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSkillSlug,
  validateSkillActionBinding
} from "./skill-contracts.ts";

test("enable_smtp_auth is a known ApprovalGate action binding", () => {
  assert.equal(canonicalSkillSlug("enable_smtp_auth"), "enable_smtp_auth");
  assert.deepEqual(validateSkillActionBinding({
    skill: "enable_smtp_auth",
    actionIds: ["enable_smtp_auth"],
    requireKnownSkill: true
  }), {
    ok: true,
    canonicalSkill: "enable_smtp_auth",
    binding: {
      canonicalSkill: "enable_smtp_auth",
      aliases: ["enable_smtp_auth"],
      actionIds: ["enable_smtp_auth"]
    }
  });
});

test("enable_smtp_auth rejects mismatched proposal actions", () => {
  const result = validateSkillActionBinding({
    skill: "enable_smtp_auth",
    actionIds: ["configure_complete_smtp"],
    requireKnownSkill: true
  });

  assert.deepEqual(result, {
    ok: false,
    rejectReason: "skill_action_mismatch",
    canonicalSkill: "enable_smtp_auth",
    expectedActionIds: ["enable_smtp_auth"]
  });
});

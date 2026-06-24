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

test("read-only inventory and conversation tools are known action bindings", () => {
  assert.equal(canonicalSkillSlug("read_fleet_servers"), "read_infrastructure_inventory");
  assert.deepEqual(validateSkillActionBinding({
    skill: "read_infrastructure_inventory",
    actionIds: ["read_infrastructure_inventory"],
    requireKnownSkill: true
  }), {
    ok: true,
    canonicalSkill: "read_infrastructure_inventory",
    binding: {
      canonicalSkill: "read_infrastructure_inventory",
      aliases: ["read_infrastructure_inventory", "read_fleet_servers"],
      actionIds: ["read_infrastructure_inventory"]
    }
  });

  assert.equal(canonicalSkillSlug("list_openclaw_conversations"), "list_conversations");
  assert.equal(canonicalSkillSlug("read_openclaw_conversation"), "read_conversation");
  assert.equal(validateSkillActionBinding({
    skill: "list_conversations",
    actionIds: ["list_conversations"],
    requireKnownSkill: true
  }).ok, true);
  assert.equal(validateSkillActionBinding({
    skill: "read_conversation",
    actionIds: ["read_conversation"],
    requireKnownSkill: true
  }).ok, true);
});

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

test("infrastructure account health and retire actions are known ApprovalGate bindings", () => {
  assert.equal(canonicalSkillSlug("read_provider_account_health"), "read_infrastructure_account_health");
  assert.equal(validateSkillActionBinding({
    skill: "read_infrastructure_account_health",
    actionIds: ["read_infrastructure_account_health"],
    requireKnownSkill: true
  }).ok, true);

  assert.equal(canonicalSkillSlug("retire_provider_account_local"), "retire_infrastructure_account");
  assert.deepEqual(validateSkillActionBinding({
    skill: "retire_infrastructure_account",
    actionIds: ["retire_infrastructure_account"],
    requireKnownSkill: true
  }), {
    ok: true,
    canonicalSkill: "retire_infrastructure_account",
    binding: {
      canonicalSkill: "retire_infrastructure_account",
      aliases: ["retire_infrastructure_account", "retire_provider_account_local"],
      actionIds: ["retire_infrastructure_account", "retire_provider_account_local"]
    }
  });
});

test("SMTP inventory management tools are known ApprovalGate bindings", () => {
  for (const skill of [
    "inspect_smtp_inventory",
    "reconcile_dns_to_live_smtp",
    "resolve_ambiguous_domain",
    "retire_smtp_entry",
    "reassign_domain_server",
    "update_smtp_entry"
  ]) {
    assert.equal(canonicalSkillSlug(skill), skill);
    assert.equal(validateSkillActionBinding({
      skill,
      actionIds: [skill],
      requireKnownSkill: true
    }).ok, true);
  }

  assert.deepEqual(validateSkillActionBinding({
    skill: "resolve_ambiguous_domain",
    actionIds: ["retire_smtp_entry"],
    requireKnownSkill: true
  }), {
    ok: false,
    rejectReason: "skill_action_mismatch",
    canonicalSkill: "resolve_ambiguous_domain",
    expectedActionIds: ["resolve_ambiguous_domain"]
  });
});

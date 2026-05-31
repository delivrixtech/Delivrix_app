import { createHash } from "node:crypto";

export interface SkillActionBinding {
  canonicalSkill: string;
  aliases: string[];
  actionIds: string[];
}

const skillActionBindings: SkillActionBinding[] = [
  {
    canonicalSkill: "register_domain_route53",
    aliases: ["register_domain_route53"],
    actionIds: ["register_domain_route53"]
  },
  {
    canonicalSkill: "suggest_safe_domain",
    aliases: ["suggest_safe_domain", "naming_suggest"],
    actionIds: ["suggest_safe_domain", "naming_suggest"]
  },
  {
    canonicalSkill: "upsert_dns_route53",
    aliases: ["upsert_dns_route53", "route53_dns_upsert"],
    actionIds: ["upsert_dns_route53", "route53_dns_upsert"]
  },
  {
    canonicalSkill: "upsert_dns_ionos",
    aliases: ["upsert_dns_ionos", "ionos_dns_upsert"],
    actionIds: ["upsert_dns_ionos", "ionos_dns_upsert"]
  },
  {
    canonicalSkill: "create_webdock_server",
    aliases: ["create_webdock_server", "provision_webdock_vps"],
    actionIds: ["create_webdock_server", "provision_webdock_vps"]
  },
  {
    canonicalSkill: "provision_smtp_postfix",
    aliases: ["provision_smtp_postfix", "install_smtp_stack"],
    actionIds: ["provision_smtp_postfix", "install_smtp_stack"]
  },
  {
    canonicalSkill: "configure_email_auth",
    aliases: ["configure_email_auth"],
    actionIds: ["configure_email_auth"]
  },
  {
    canonicalSkill: "bind_domain_to_server",
    aliases: ["bind_domain_to_server"],
    actionIds: ["bind_domain_to_server"]
  },
  {
    canonicalSkill: "seed_warmup_pool",
    aliases: ["seed_warmup_pool", "start_warmup_seed"],
    actionIds: ["seed_warmup_pool", "start_warmup_seed"]
  },
  {
    canonicalSkill: "start_warmup_ramp",
    aliases: ["start_warmup_ramp", "warmup_ramp_scheduler"],
    actionIds: ["start_warmup_ramp", "warmup_ramp_scheduler"]
  }
];

const bindingBySkill = new Map<string, SkillActionBinding>();

for (const binding of skillActionBindings) {
  bindingBySkill.set(binding.canonicalSkill, binding);
  for (const alias of binding.aliases) {
    bindingBySkill.set(alias, binding);
  }
}

export function getSkillActionBinding(skill: string | undefined): SkillActionBinding | null {
  if (!skill) return null;
  return bindingBySkill.get(skill.trim()) ?? null;
}

export function canonicalSkillSlug(skill: string): string {
  return getSkillActionBinding(skill)?.canonicalSkill ?? skill.trim();
}

export function validateSkillActionBinding(input: {
  skill: string;
  actionIds: string[];
  requireKnownSkill?: boolean;
}): { ok: true; canonicalSkill: string; binding: SkillActionBinding | null } | {
  ok: false;
  rejectReason: "unknown_skill" | "skill_action_mismatch";
  canonicalSkill: string;
  expectedActionIds?: string[];
} {
  const canonicalSkill = canonicalSkillSlug(input.skill);
  const binding = getSkillActionBinding(canonicalSkill);
  if (!binding) {
    return input.requireKnownSkill
      ? { ok: false, rejectReason: "unknown_skill", canonicalSkill }
      : { ok: true, canonicalSkill, binding: null };
  }

  const proposalActions = input.actionIds.map((actionId) => actionId.trim()).filter(Boolean);
  const approvedActions = new Set(proposalActions);
  const authorized = binding.actionIds.some((actionId) => approvedActions.has(actionId));
  const unsupportedActions = proposalActions.filter((actionId) => !binding.actionIds.includes(actionId));
  if (!authorized || unsupportedActions.length > 0) {
    return {
      ok: false,
      rejectReason: "skill_action_mismatch",
      canonicalSkill,
      expectedActionIds: binding.actionIds
    };
  }

  return { ok: true, canonicalSkill, binding };
}

export function hashSkillExecutionContext(input: {
  proposalId: string;
  skill: string;
  actionIds: string[];
  targetType: string;
  targetId: string;
  params: unknown;
}): string {
  return createHash("sha256")
    .update(stableStringify({
      proposalId: input.proposalId,
      skill: canonicalSkillSlug(input.skill),
      actionIds: input.actionIds.map((actionId) => actionId.trim()).sort(),
      targetType: input.targetType,
      targetId: input.targetId,
      params: input.params ?? {}
    }))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

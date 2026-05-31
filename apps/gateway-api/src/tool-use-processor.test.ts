import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProposalPayloadFromToolUse,
  processToolUse,
  type ToolUseProcessorDeps,
  type ToolUseProposalDecision,
  type ToolUseProposalSubmission
} from "./tool-use-processor.ts";

test("processToolUse submits a validated proposal and returns executed tool_result", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-1",
    toolName: "register_domain_route53",
    toolInput: { domain: "Delivrix.TEST.", years: 1 },
    chatSession: { id: "agent:main:operator", msgId: "msg-1" },
    env: enabledEnv(),
    deps: memoryDeps({
      calls,
      decision: {
        status: "executed",
        proposalId: "proposal-1",
        ok: true,
        signatureId: "sig-1",
        outcome: { ok: true, domain: "delivrix.test" },
        durationMs: 25,
        statusCode: 200
      }
    })
  });

  assert.deepEqual(result, {
    ok: true,
    status: "executed",
    result: { ok: true, domain: "delivrix.test" },
    durationMs: 25,
    proposalId: "proposal-1",
    signatureId: "sig-1",
    statusCode: 200
  });
  assert.equal(calls.length, 1);
});

test("processToolUse rejects unknown tool names before submission", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-unknown",
    toolName: "delete_everything",
    toolInput: {},
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: memoryDeps({ calls })
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected unknown_tool failure");
  assert.equal(result.error, "unknown_tool");
  assert.equal(calls.length, 0);
});

test("processToolUse invokes read-only suggest_safe_domain without proposal wait", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-suggest",
    toolName: "suggest_safe_domain",
    toolInput: { brand: "delivrix", intent: "ops", count: 5 },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: {
      ...memoryDeps({ calls }),
      async invokeReadOnlyTool(input) {
        calls.push({ readOnly: input.toolName, params: input.params });
        return { candidates: [{ domain: "delivrixops.com", namingScore: 92 }] };
      }
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected read-only success");
  assert.equal(result.proposalId, "read_only:toolu-suggest");
  assert.deepEqual(result.result, { candidates: [{ domain: "delivrixops.com", namingScore: 92 }] });
  assert.equal(calls.length, 1);
});

test("processToolUse fails read-only suggest_safe_domain when invoker is missing", async () => {
  const result = await processToolUse({
    toolUseId: "toolu-suggest-missing",
    toolName: "suggest_safe_domain",
    toolInput: { brand: "delivrix" },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: memoryDeps()
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected missing invoker failure");
  assert.equal(result.error, "read_only_tool_invoker_missing");
});

test("processToolUse validates params with custom skill schema", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-invalid",
    toolName: "upsert_dns_route53",
    toolInput: { domain: "delivrix.test", records: [{ name: "@", type: "SRV", ttl: 300, values: ["bad"] }] },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: memoryDeps({ calls })
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected invalid_params failure");
  assert.equal(result.error, "invalid_params");
  assert.equal(calls.length, 0);
});

test("processToolUse fail-closes disabled tools", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-disabled",
    toolName: "seed_warmup_pool",
    toolInput: { domain: "delivrix.test", seedInboxes: ["a@example.com"] },
    chatSession: { id: "agent:main:operator" },
    env: { ...enabledEnv(), WARMUP_RAMP_ENABLE: "0" },
    deps: memoryDeps({ calls })
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected tool_disabled failure");
  assert.equal(result.error, "tool_disabled");
  assert.equal(calls.length, 0);
});

test("processToolUse aborts before proposal submit when kill switch is armed", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-kill",
    toolName: "register_domain_route53",
    toolInput: { domain: "delivrix.test", years: 1 },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: memoryDeps({ calls, killSwitchEnabled: true })
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected kill_switch_armed failure");
  assert.equal(result.error, "kill_switch_armed");
  assert.equal(calls.length, 0);
});

test("processToolUse maps operator rejection and approval timeout", async () => {
  const rejected = await processToolUse({
    toolUseId: "toolu-rejected",
    toolName: "register_domain_route53",
    toolInput: { domain: "delivrix.test", years: 1 },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: memoryDeps({
      decision: { status: "rejected", proposalId: "proposal-1", reason: "Operador rechazó el costo" }
    })
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) assert.fail("expected rejected_by_operator failure");
  assert.equal(rejected.error, "rejected_by_operator");
  assert.equal(rejected.proposalId, "proposal-1");

  const timeout = await processToolUse({
    toolUseId: "toolu-timeout",
    toolName: "register_domain_route53",
    toolInput: { domain: "delivrix.test", years: 1 },
    chatSession: { id: "agent:main:operator" },
    env: { ...enabledEnv(), OPENCLAW_TOOL_APPROVAL_TIMEOUT_MS: "10" },
    deps: memoryDeps({
      decision: { status: "approval_timeout", proposalId: "proposal-2", timeoutMs: 10 }
    })
  });
  assert.equal(timeout.ok, false);
  if (timeout.ok) assert.fail("expected approval_timeout failure");
  assert.equal(timeout.error, "approval_timeout");
  assert.equal(timeout.timeoutMs, 10);
});

test("buildProposalPayloadFromToolUse produces HMAC-submittable proposal envelope", () => {
  const payload = buildProposalPayloadFromToolUse({
    toolUseId: "toolu-payload",
    toolName: "bind_domain_to_server",
    params: { domain: "delivrix.test", serverIp: "203.0.113.10" },
    chatSession: { id: "agent:main:operator", msgId: "msg-42" },
    env: enabledEnv(),
    now: new Date("2026-05-31T21:00:00.000Z")
  });

  assert.equal(payload.schemaVersion, "2026-05-18.v1");
  assert.equal(payload.proposal.skillSlug, "bind_domain_to_server");
  assert.deepEqual(payload.proposal.delivrix_actions_required, ["bind_domain_to_server"]);
  assert.equal(payload.proposal.targetRef, "delivrix.test");
  assert.equal(payload.proposal.targetType, "domain");
  assert.match(payload.proposal.body, /ApprovalGate/);
});

function memoryDeps(options: {
  calls?: unknown[];
  killSwitchEnabled?: boolean;
  submit?: ToolUseProposalSubmission;
  decision?: ToolUseProposalDecision;
} = {}): ToolUseProcessorDeps {
  return {
    async submitProposalFromToolUse(input) {
      options.calls?.push(input);
      return options.submit ?? { proposalId: "proposal-1", requiresApproval: true };
    },
    async waitForProposalDecision() {
      return options.decision ?? {
        status: "executed",
        proposalId: "proposal-1",
        ok: true,
        outcome: { ok: true }
      };
    },
    async readKillSwitch() {
      return { enabled: options.killSwitchEnabled ?? false };
    }
  };
}

function enabledEnv(): Record<string, string | undefined> {
  return {
    OPENCLAW_HMAC_SECRET: "test-hmac",
    AWS_ACCESS_KEY_ID: "test-access",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE: "true",
    AWS_ROUTE53_DNS_ENABLE_WRITES: "true",
    IONOS_DNS_ENABLE_WRITES: "true",
    IONOS_API_TOKEN: "ionos-token",
    WEBDOCK_SERVERS_ENABLE_CREATE: "true",
    WEBDOCK_API_KEY_OPS: "webdock-ops",
    SMTP_PROVISIONING_ENABLE_SSH: "true",
    SMTP_PROVISION_SSH_KEY_PATH: "/tmp/delivrix-smoke-key",
    EMAIL_AUTH_ENABLE_WRITES: "true",
    DOMAIN_BIND_ENABLE: "true",
    WARMUP_ENABLE_SEND: "true",
    WARMUP_RAMP_ENABLE: "true",
    WEBDOCK_BIND_MAIN_DOMAIN_ENABLE: "true",
    SEND_REAL_EMAIL_ENABLE: "true",
    OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE: "true"
  };
}

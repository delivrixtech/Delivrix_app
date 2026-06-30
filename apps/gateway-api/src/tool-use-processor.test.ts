import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  buildProposalPayloadFromToolUse,
  createHttpToolUseProcessor,
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

test("processToolUse submits update_domain_nameservers through ApprovalGate", async () => {
  const calls: any[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-ns-update",
    toolName: "update_domain_nameservers",
    toolInput: {
      domain: "controldelivrix.app",
      zoneId: "Z03595092JW2AXJBZGN4E",
      nameservers: ["ns-1.awsdns.com", "ns-2.awsdns.net"]
    },
    chatSession: { id: "agent:main:operator", msgId: "msg-ns" },
    env: enabledEnv(),
    deps: memoryDeps({
      calls,
      decision: {
        status: "executed",
        proposalId: "proposal-ns",
        ok: true,
        signatureId: "sig-ns",
        outcome: { ok: true, operationId: "op-ns-123" },
        durationMs: 30,
        statusCode: 200
      }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "update_domain_nameservers");
  assert.deepEqual(calls[0].params.nameservers, ["ns-1.awsdns.com", "ns-2.awsdns.net"]);
  assert.deepEqual(
    buildProposalPayloadFromToolUse(calls[0]).proposal.delivrix_actions_required,
    ["update_domain_nameservers"]
  );
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

test("processToolUse rejects timestamp fragments as domains before proposal submission", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-bad-domain",
    toolName: "register_domain_route53",
    toolInput: { domain: "37.842Z", years: 1 },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: memoryDeps({ calls })
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected invalid_params failure");
  assert.equal(result.error, "invalid_params");
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

test("processToolUse redacts PEM data from tool results before returning model content", async () => {
  const calls: unknown[] = [];
  const pem = generatedPrivateKeyPem();
  const pemLine = pemBodyLine(pem);
  const result = await processToolUse({
    toolUseId: "toolu-suggest-pem",
    toolName: "suggest_safe_domain",
    toolInput: { brand: "delivrix", intent: "ops", count: 5 },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: {
      ...memoryDeps({ calls }),
      async invokeReadOnlyTool(input) {
        calls.push({ readOnly: input.toolName, params: input.params });
        return {
          ok: false,
          error: pem,
          stderr: pem.slice(0, 500),
          nested: { privateKey: pem }
        };
      }
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected read-only success");
  const surface = JSON.stringify(result.result);
  assert.doesNotMatch(surface, /-----BEGIN PRIVATE KEY-----/);
  assert.doesNotMatch(surface, /-----END PRIVATE KEY-----/);
  assert.equal(surface.includes(pemLine), false);
  assert.match(surface, /\[REDACTED_PRIVATE_KEY\]/);
  assert.match(surface, /\[REDACTED_PARTIAL_KEY\]/);
  assert.match(surface, /\[REDACTED\]/);
});

test("processToolUse invokes read-only episodic scratch without ApprovalGate", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-scratch-read",
    toolName: "read_episodic_scratch",
    toolInput: { intentId: "intent-1" },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: {
      ...memoryDeps({ calls }),
      async submitProposalFromToolUse() {
        assert.fail("read_episodic_scratch must not submit an ApprovalGate proposal");
      },
      async waitForProposalDecision() {
        assert.fail("read_episodic_scratch must not wait for ApprovalGate");
      },
      async invokeReadOnlyTool(input) {
        calls.push({ readOnly: input.toolName, params: input.params });
        return { entries: [{ intentId: "intent-1", outcome: "success" }] };
      }
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected scratch read success");
  assert.equal(result.proposalId, "read_only:toolu-scratch-read");
  assert.deepEqual(result.result, { entries: [{ intentId: "intent-1", outcome: "success" }] });
  assert.deepEqual(calls, [{ readOnly: "read_episodic_scratch", params: { intentId: "intent-1" } }]);
});

test("processToolUse invokes new inventory and conversation tools as read-only without ApprovalGate", async () => {
  for (const [toolName, toolInput] of [
    ["read_infrastructure_inventory", {}],
    ["inspect_smtp_inventory", { domain: "legacy-one.com" }],
    ["list_conversations", { offset: 0, limit: 20 }],
    ["read_conversation", { conversationId: "conv-a", offset: 0, limit: 6 }]
  ] as const) {
    const calls: unknown[] = [];
    const result = await processToolUse({
      toolUseId: `toolu-${toolName}`,
      toolName,
      toolInput,
      chatSession: { id: "agent:main:operator" },
      env: enabledEnv(),
      deps: {
        ...memoryDeps({ calls }),
        async submitProposalFromToolUse() {
          assert.fail(`${toolName} must not submit an ApprovalGate proposal`);
        },
        async waitForProposalDecision() {
          assert.fail(`${toolName} must not wait for ApprovalGate`);
        },
        async invokeReadOnlyTool(input) {
          calls.push({ readOnly: input.toolName, params: input.params });
          return { ok: true, toolName: input.toolName };
        }
      }
    });

    assert.equal(result.ok, true);
    if (!result.ok) assert.fail(`expected ${toolName} read-only success`);
    assert.equal(result.proposalId, `read_only:toolu-${toolName}`);
    assert.deepEqual(result.result, { ok: true, toolName });
    assert.deepEqual(calls, [{ readOnly: toolName, params: toolInput }]);
  }
});

test("processToolUse invokes compact_intent as internal memory write without ApprovalGate", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-compact",
    toolName: "compact_intent",
    toolInput: {
      intentId: "intent-1",
      finalStatus: "completed",
      decision: "stored",
      steps: [{ step: 1, tool: "suggest_safe_domain", inputHash: "a".repeat(64), outcome: "success" }]
    },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: {
      ...memoryDeps({ calls }),
      async submitProposalFromToolUse() {
        assert.fail("compact_intent must not submit an ApprovalGate proposal");
      },
      async waitForProposalDecision() {
        assert.fail("compact_intent must not wait for ApprovalGate");
      },
      async invokeMemoryTool(input) {
        calls.push({ memory: input.toolName, params: input.params });
        return { entriesWritten: 1, scratchIds: ["scratch-1"] };
      }
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected compact success");
  assert.equal(result.proposalId, "memory:toolu-compact");
  assert.deepEqual(result.result, { entriesWritten: 1, scratchIds: ["scratch-1"] });
});

test("processToolUse truncates compact_intent decision before internal memory write", async () => {
  const calls: Array<{ memory: string; params: Record<string, unknown> }> = [];
  const logs: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
  const longDecision = `stored-${"x".repeat(320)}`;
  const result = await processToolUse({
    toolUseId: "toolu-compact-long",
    toolName: "compact_intent",
    toolInput: {
      intentId: "intent-1",
      finalStatus: "completed",
      decision: longDecision,
      steps: [{ step: 1, tool: "suggest_safe_domain", inputHash: "a".repeat(64), outcome: "success" }]
    },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    logger: {
      logPath: "",
      async info() {},
      async warn(event, _message, metadata) {
        logs.push({ event, metadata });
      },
      async error() {}
    },
    deps: {
      ...memoryDeps(),
      async submitProposalFromToolUse() {
        assert.fail("compact_intent must not submit an ApprovalGate proposal");
      },
      async waitForProposalDecision() {
        assert.fail("compact_intent must not wait for ApprovalGate");
      },
      async invokeMemoryTool(input) {
        calls.push({ memory: input.toolName, params: input.params });
        return { entriesWritten: 1, scratchIds: ["scratch-1"] };
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.decision, longDecision.trim().slice(0, 280));
  assert.equal(String(calls[0].params.decision).length, 280);
  const warning = logs.find((entry) => entry.event === "openclaw.tool_use.compact_intent_decision_truncated");
  assert.equal(warning?.metadata?.originalLength, longDecision.length);
  assert.equal(warning?.metadata?.storedLength, 280);
  assert.equal(typeof warning?.metadata?.originalHash, "string");
  assert.equal(typeof warning?.metadata?.storedHash, "string");
  assert.equal(JSON.stringify(warning).includes(longDecision), false);
});

test("createHttpToolUseProcessor accepts nested gateway kill-switch payload", async () => {
  const urls: string[] = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).endsWith("/v1/skills/suggest-safe-domain")) {
        assert.equal(init?.method, "POST");
        return jsonResponse({ candidates: [{ domain: "delivrixops.com", namingScore: 92 }] });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-http-suggest",
    toolName: "suggest_safe_domain",
    toolInput: { brand: "delivrix", intent: "ops", count: 5 },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected HTTP read-only success");
  assert.deepEqual(result.result, { candidates: [{ domain: "delivrixops.com", namingScore: 92 }] });
  assert.deepEqual(urls, [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/skills/suggest-safe-domain"
  ]);
});

test("createHttpToolUseProcessor invokes episodic scratch read endpoint directly with read-boundary token", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string> ?? {}
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).includes("/v1/openclaw/scratch?intentId=intent-1")) {
        return jsonResponse({ entries: [{ intentId: "intent-1" }] });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-http-scratch",
    toolName: "read_episodic_scratch",
    toolInput: { intentId: "intent-1" },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected HTTP scratch read success");
  assert.deepEqual(result.result, { entries: [{ intentId: "intent-1" }] });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/openclaw/scratch?intentId=intent-1"
  ]);
  assert.equal(calls[1].headers["x-delivrix-token"], "read-token");
});

test("createHttpToolUseProcessor fails closed when scratch requires token and none is configured", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    fetchImpl: async (url, init) => {
      const headers = init?.headers as Record<string, string> ?? {};
      calls.push({ url: String(url), headers });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).includes("/v1/openclaw/scratch?intentId=intent-1")) {
        return headers["x-delivrix-token"]
          ? jsonResponse({ entries: [{ intentId: "intent-1" }] })
          : jsonResponse({ error: "unauthorized" }, 401);
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-http-scratch-no-token",
    toolName: "read_episodic_scratch",
    toolInput: { intentId: "intent-1" },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected HTTP scratch read to fail closed");
  assert.equal(result.error, "read_only_tool_failed");
  assert.match(String(result.details), /HTTP 401/);
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/openclaw/scratch?intentId=intent-1"
  ]);
  assert.equal(calls[1].headers["x-delivrix-token"], undefined);
});

test("createHttpToolUseProcessor routes episodic query through grounded retrieval", async () => {
  const urls: string[] = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (
        String(url).includes("/v1/openclaw/scratch?tool=suggest_safe_domain") &&
        String(url).includes("query=warmup+domain+reputation") &&
        String(url).includes("grounded=true")
      ) {
        return jsonResponse({
          status: "abstain",
          reason: "no_verified_relevant_memory",
          memories: [],
          discarded: []
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-http-scratch-grounded",
    toolName: "read_episodic_scratch",
    toolInput: { tool: "suggest_safe_domain", query: "warmup domain reputation", limit: 5 },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected HTTP grounded scratch read success");
  assert.deepEqual(result.result, {
    status: "abstain",
    reason: "no_verified_relevant_memory",
    memories: [],
    discarded: []
  });
  assert.deepEqual(urls, [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/openclaw/scratch?tool=suggest_safe_domain&limit=5&query=warmup+domain+reputation&grounded=true"
  ]);
});

test("createHttpToolUseProcessor signs compact_intent HTTP payload", async () => {
  const calls: Array<{ url: string; headers?: HeadersInit; body?: unknown }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    now: () => new Date("2026-06-01T12:00:00.000Z"),
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).endsWith("/v1/openclaw/compact-intent")) {
        assert.equal(init?.method, "POST");
        assert.equal((init.headers as Record<string, string>)["x-openclaw-timestamp"], "1780315200");
        assert.match((init.headers as Record<string, string>)["x-openclaw-signature"], /^[a-f0-9]{64}$/);
        return jsonResponse({ entriesWritten: 1, scratchIds: ["scratch-1"] });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-http-compact",
    toolName: "compact_intent",
    toolInput: {
      intentId: "intent-1",
      finalStatus: "completed",
      decision: "stored",
      steps: [{ step: 1, tool: "suggest_safe_domain", inputHash: "a".repeat(64), outcome: "success" }]
    },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected HTTP compact success");
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/openclaw/compact-intent"
  ]);
  assert.equal((calls[1]?.body as Record<string, unknown>).actorId, "agent:main:operator");
});

test("createHttpToolUseProcessor invokes read-only DNS wait endpoint directly", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).endsWith("/v1/skills/wait-for-dns-propagation/read-only")) {
        assert.equal(init?.method, "POST");
        return jsonResponse({
          ok: false,
          attempts: 1,
          lastSeen: "(nxdomain)",
          durationMs: 10,
          error: "domain_nxdomain",
          eventId: "audit-dns-1"
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-http-dns",
    toolName: "wait_for_dns_propagation",
    toolInput: {
      domain: "delivrix.test",
      expectedRecord: { type: "A", value: "203.0.113.10" },
      maxWaitMs: 30_000,
      pollIntervalMs: 30_000
    },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected HTTP read-only DNS success");
  assert.deepEqual(result.result, {
    ok: false,
    attempts: 1,
    lastSeen: "(nxdomain)",
    durationMs: 10,
    error: "domain_nxdomain",
    eventId: "audit-dns-1"
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/skills/wait-for-dns-propagation/read-only"
  ]);
  assert.deepEqual(calls[1]?.body, {
    domain: "delivrix.test",
    expectedRecord: { type: "A", value: "203.0.113.10" },
    maxWaitMs: 30_000,
    pollIntervalMs: 30_000,
    actorId: "agent:main:operator"
  });
});

test("createHttpToolUseProcessor invokes read-only Route53 domain detail endpoint directly", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string> ?? {}
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).startsWith("http://127.0.0.1:3000/v1/route53/domain-detail")) {
        assert.equal(init?.method, "GET");
        assert.equal(new URL(String(url)).searchParams.get("domain"), "controldelivrix.app");
        return jsonResponse({ domain: "controldelivrix.app", registrar: "Amazon Registrar, Inc.", nameservers: [] });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-route53-domain",
    toolName: "read_route53_domain_detail",
    toolInput: { domain: "controldelivrix.app" },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected Route53 domain read success");
  assert.deepEqual(result.result, {
    domain: "controldelivrix.app",
    registrar: "Amazon Registrar, Inc.",
    nameservers: []
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/route53/domain-detail?domain=controldelivrix.app"
  ]);
  assert.equal(calls[1].headers["x-delivrix-token"], "read-token");
});

test("createHttpToolUseProcessor surfaces Route53 domain detail error body to OpenClaw", async () => {
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).startsWith("http://127.0.0.1:3000/v1/route53/domain-detail")) {
        return jsonResponse({
          error: "route53_domain_detail_throttled",
          awsError: "ThrottlingException",
          httpStatus: 429,
          transient: true,
          retryable: true
        }, 429);
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-route53-domain-throttle",
    toolName: "read_route53_domain_detail",
    toolInput: { domain: "controldelivrix.app" },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected Route53 read failure");
  assert.equal(result.error, "read_only_tool_failed");
  assert.equal(typeof result.details, "string");
  assert.match(result.details, /HTTP 429/);
  assert.match(result.details, /route53_domain_detail_throttled/);
  assert.match(result.details, /ThrottlingException/);
  assert.match(result.details, /transient/);
});

test("createHttpToolUseProcessor invokes read-only Route53 zone records endpoint directly", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string> ?? {}
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).startsWith("http://127.0.0.1:3000/v1/route53/zone-records")) {
        const parsed = new URL(String(url));
        assert.equal(init?.method, "GET");
        assert.equal(parsed.searchParams.get("zoneId"), "Z03595092JW2AXJBZGN4E");
        assert.equal(parsed.searchParams.get("recordType"), "A");
        assert.equal(parsed.searchParams.get("recordName"), "smtp.controldelivrix.app");
        return jsonResponse({
          zoneId: "Z03595092JW2AXJBZGN4E",
          records: [{ name: "smtp.controldelivrix.app.", type: "A", ttl: 300, values: ["45.136.70.47"] }],
          isTruncated: false,
          totalRecords: 1
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-route53-zone",
    toolName: "read_route53_zone_records",
    toolInput: {
      zoneId: "Z03595092JW2AXJBZGN4E",
      recordType: "A",
      recordName: "smtp.controldelivrix.app"
    },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected Route53 zone read success");
  assert.deepEqual(result.result, {
    zoneId: "Z03595092JW2AXJBZGN4E",
    records: [{ name: "smtp.controldelivrix.app.", type: "A", ttl: 300, values: ["45.136.70.47"] }],
    isTruncated: false,
    totalRecords: 1
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/route53/zone-records?zoneId=Z03595092JW2AXJBZGN4E&recordType=A&recordName=smtp.controldelivrix.app"
  ]);
  assert.equal(calls[1].headers["x-delivrix-token"], "read-token");
});

test("createHttpToolUseProcessor invokes read-only IONOS DNS endpoint directly", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string> ?? {}
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).startsWith("http://127.0.0.1:3000/v1/dns/ionos/records")) {
        const parsed = new URL(String(url));
        assert.equal(init?.method, "GET");
        assert.equal(parsed.searchParams.get("domain"), "nationalcorphub.app");
        assert.equal(parsed.searchParams.get("recordType"), "TXT");
        return jsonResponse({
          zoneId: "ionos-zone-1",
          zoneName: "nationalcorphub.app",
          records: [{ id: "record-1", name: "_dmarc.nationalcorphub.app", type: "TXT", content: "v=DMARC1; p=quarantine" }],
          totalRecords: 1
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-ionos-read",
    toolName: "read_dns_ionos",
    toolInput: {
      domain: "nationalcorphub.app",
      recordType: "TXT"
    },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected IONOS DNS read success");
  assert.deepEqual(result.result, {
    zoneId: "ionos-zone-1",
    zoneName: "nationalcorphub.app",
    records: [{ id: "record-1", name: "_dmarc.nationalcorphub.app", type: "TXT", content: "v=DMARC1; p=quarantine" }],
    totalRecords: 1
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/dns/ionos/records?domain=nationalcorphub.app&recordType=TXT"
  ]);
  assert.equal(calls[1].headers["x-delivrix-token"], "read-token");
});

test("createHttpToolUseProcessor invokes read-only MXToolbox health endpoint directly", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string> ?? {}
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).startsWith("http://127.0.0.1:3000/v1/mxtoolbox/health")) {
        const parsed = new URL(String(url));
        assert.equal(init?.method, "GET");
        assert.equal(parsed.searchParams.get("target"), "8.8.8.8");
        assert.equal(parsed.searchParams.get("type"), "blacklist");
        return jsonResponse({
          source: "live",
          result: {
            target: "8.8.8.8",
            command: "blacklist",
            checkedAt: "2026-06-18T10:00:00.000Z",
            status: "clean",
            failedChecks: [],
            warningChecks: [],
            passedCount: 59,
            timeoutCount: 0,
            rawRef: "a".repeat(64)
          }
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-mxtoolbox-read",
    toolName: "read_mxtoolbox_health",
    toolInput: {
      target: "8.8.8.8",
      type: "blacklist"
    },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected MXToolbox read success");
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/mxtoolbox/health?target=8.8.8.8&type=blacklist"
  ]);
  assert.equal(calls[1].headers["x-delivrix-token"], "read-token");
});

test("processToolUse blocks direct SMTP subtools when plan autonomy is enabled", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-direct-smtp",
    toolName: "provision_smtp_postfix",
    toolInput: { serverSlug: "server69", domain: "delivrix.test", serverIp: "203.0.113.10" },
    chatSession: { id: "agent:main:operator" },
    env: {
      ...enabledEnv(),
      OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE: "true",
      OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true"
    },
    deps: memoryDeps({ calls })
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected direct subtool rejection");
  assert.equal(result.error, "use_configure_complete_smtp");
  assert.equal(calls.length, 0);
});

test("processToolUse allows direct SMTP subtool only with explicit repair scope", async () => {
  const calls: any[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-direct-smtp-repair",
    toolName: "provision_smtp_postfix",
    toolInput: {
      serverSlug: "server69",
      domain: "delivrix.test",
      serverIp: "203.0.113.10",
      repairReason: "retry postfix after audited DKIM key generation",
      explicitRepairScope: "delivrix.test/server69"
    },
    chatSession: { id: "agent:main:operator" },
    env: {
      ...enabledEnv(),
      OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE: "true",
      OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true"
    },
    deps: memoryDeps({ calls })
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.repairReason, "retry postfix after audited DKIM key generation");
  assert.equal(calls[0].params.explicitRepairScope, "delivrix.test/server69");
});

test("processToolUse blocks bind_domain_to_server alias when plan autonomy is enabled", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-direct-bind-alias",
    toolName: "bind_domain_to_server",
    toolInput: { domain: "delivrix.test", serverIp: "203.0.113.10" },
    chatSession: { id: "agent:main:operator" },
    env: {
      ...enabledEnv(),
      OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE: "true",
      OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true"
    },
    deps: memoryDeps({ calls })
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected direct alias rejection");
  assert.equal(result.error, "use_configure_complete_smtp");
  assert.equal(calls.length, 0);
});

test("createHttpToolUseProcessor invokes read-only Webdock inventory endpoint directly", async () => {
  const urls: string[] = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).endsWith("/v1/webdock/inventory")) {
        assert.equal(init?.method, "GET");
        assert.equal((init?.headers as Record<string, string>)["x-openclaw-skill-invocation"], "delivrix-fleet-ops");
        return jsonResponse({
          inventory: {
            servers: [
              { slug: "server9", status: "running", ipv4: "192.0.2.9" },
              { slug: "server10", status: "running", ipv4: "45.136.70.47", mainDomain: "controldelivrix.app" }
            ]
          },
          drift: { proposals: [] }
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-webdock-read",
    toolName: "read_webdock_servers",
    toolInput: { serverSlug: "server10", ipv4: "45.136.70.47" },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected Webdock inventory read success");
  assert.deepEqual((result.result as { matchedServers: unknown[] }).matchedServers, [
    { slug: "server10", status: "running", ipv4: "45.136.70.47", mainDomain: "controldelivrix.app" }
  ]);
  assert.deepEqual(urls, [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/webdock/inventory"
  ]);
});

test("createHttpToolUseProcessor invokes infrastructure inventory endpoint with read-boundary token", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string> ?? {}
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).endsWith("/v1/infrastructure/inventory")) {
        assert.equal(init?.method, "GET");
        return jsonResponse({
          providers: [{
            id: "contabo",
            kind: "compute",
            items: [{
              id: "contabo-1",
              kind: "contabo_server",
              detail: { ipv4: "66.94.96.10" }
            }]
          }]
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-infra-read",
    toolName: "read_infrastructure_inventory",
    toolInput: {},
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected infrastructure inventory read success");
  assert.deepEqual(result.result, {
    providers: [{
      id: "contabo",
      kind: "compute",
      items: [{
        id: "contabo-1",
        kind: "contabo_server",
        detail: { ipv4: "66.94.96.10" }
      }]
    }]
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/infrastructure/inventory"
  ]);
  assert.equal(calls[1].headers["x-openclaw-skill-invocation"], "delivrix-infra-inventory");
  assert.equal(calls[1].headers["x-delivrix-token"], "read-token");
});

test("createHttpToolUseProcessor invokes infrastructure account health endpoint with read-boundary token", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string> ?? {}
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).endsWith("/v1/infrastructure/account-health")) {
        assert.equal(init?.method, "GET");
        return jsonResponse({
          accountHealth: { accounts: [], unhealthyCount: 0, retiredCount: 0 },
          orphanReport: { confirmedSenderNodeOrphans: [], uncertainBecauseAccountDown: [], providerServersWithoutSenderNode: [] },
          scratchHealth: { status: "ok" }
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-infra-health",
    toolName: "read_infrastructure_account_health",
    toolInput: {},
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected infrastructure account health read success");
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/infrastructure/account-health"
  ]);
  assert.equal(calls[1].headers["x-delivrix-token"], "read-token");
});

test("createHttpToolUseProcessor invokes SMTP inventory inspect endpoint with read-boundary token", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string> ?? {}
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).startsWith("http://127.0.0.1:3000/v1/openclaw/smtp-inventory")) {
        assert.equal(init?.method, "GET");
        return jsonResponse({
          ok: false,
          totals: { ambiguousDomains: 1 },
          ambiguousDomains: [{ domain: "legacy-one.com", configuredCount: 2 }]
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const result = await processor({
    toolUseId: "toolu-smtp-inventory",
    toolName: "inspect_smtp_inventory",
    toolInput: { domain: "legacy-one.com", status: "configured" },
    chatSession: { id: "agent:main:operator" }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected SMTP inventory read success");
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/openclaw/smtp-inventory?domain=legacy-one.com&status=configured"
  ]);
  assert.equal(calls[1].headers["x-delivrix-token"], "read-token");
});

test("createHttpToolUseProcessor fails closed for sensitive read tools without read-boundary token", async () => {
  const urls: string[] = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  for (const toolName of ["read_infrastructure_inventory", "inspect_smtp_inventory", "read_infrastructure_account_health", "list_conversations", "read_conversation"]) {
    const result = await processor({
      toolUseId: `toolu-${toolName}`,
      toolName,
      toolInput: toolName === "read_conversation" ? { conversationId: "conv-a" } : {},
      chatSession: { id: "agent:main:operator" }
    });
    assert.equal(result.ok, false);
    if (result.ok) assert.fail(`expected ${toolName} to fail closed`);
    assert.equal(result.error, "read_only_tool_failed");
    assert.match(String(result.details), /read_boundary_token_unconfigured/);
  }

  assert.deepEqual(urls, [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/kill-switch"
  ]);
});

test("createHttpToolUseProcessor reads chat conversations with pagination and truncation", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    readBoundaryToken: "read-token",
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        headers: init?.headers as Record<string, string> ?? {}
      });
      if (String(url).endsWith("/v1/kill-switch")) {
        return jsonResponse({ killSwitch: { enabled: false } });
      }
      if (String(url).endsWith("/v1/openclaw/chat/conversations")) {
        return jsonResponse({
          conversations: [
            { id: "conv-a", title: "A", preview: "uno", updatedAt: "2026-06-01T00:00:00.000Z" },
            { id: "conv-b", title: "B", preview: "dos", updatedAt: "2026-06-01T00:01:00.000Z" },
            { id: "conv-c", title: "C", preview: "tres", updatedAt: "2026-06-01T00:02:00.000Z" }
          ]
        });
      }
      if (String(url).startsWith("http://127.0.0.1:3000/v1/openclaw/chat/history")) {
        assert.equal(new URL(String(url)).searchParams.get("conversationId"), "conv-b");
        return jsonResponse({
          id: "conv-b",
          turns: [
            { role: "user", content: "0123456789", createdAt: "2026-06-01T00:00:00.000Z" },
            { role: "assistant", content: "abcdefghij", createdAt: "2026-06-01T00:01:00.000Z" }
          ]
        });
      }
      return jsonResponse({ error: "unexpected_url" }, 404);
    }
  });

  const listed = await processor({
    toolUseId: "toolu-list-conversations",
    toolName: "list_conversations",
    toolInput: { offset: 1, limit: 1 },
    chatSession: { id: "agent:main:operator" }
  });
  assert.equal(listed.ok, true);
  if (!listed.ok) assert.fail("expected list_conversations success");
  assert.deepEqual(listed.result, {
    conversations: [{ id: "conv-b", title: "B", preview: "dos", updatedAt: "2026-06-01T00:01:00.000Z" }],
    total: 3,
    offset: 1,
    limit: 1,
    hasMore: true
  });

  const history = await processor({
    toolUseId: "toolu-read-conversation",
    toolName: "read_conversation",
    toolInput: { conversationId: "conv-b", offset: 0, limit: 2, maxCharsPerTurn: 4 },
    chatSession: { id: "agent:main:operator" }
  });
  assert.equal(history.ok, true);
  if (!history.ok) assert.fail("expected read_conversation success");
  assert.deepEqual(history.result, {
    id: "conv-b",
    turns: [
      {
        role: "user",
        content: "0123",
        createdAt: "2026-06-01T00:00:00.000Z",
        contentTruncated: true,
        originalContentChars: 10
      },
      {
        role: "assistant",
        content: "abcd",
        createdAt: "2026-06-01T00:01:00.000Z",
        contentTruncated: true,
        originalContentChars: 10
      }
    ],
    total: 2,
    offset: 0,
    limit: 2,
    hasMore: false,
    truncated: true,
    truncatedTurns: 2
  });

  assert.equal(calls[1].headers["x-delivrix-token"], "read-token");
  assert.equal(calls[3].headers["x-delivrix-token"], "read-token");
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

test("processToolUse routes SMTP inventory mutators through ApprovalGate", async () => {
  for (const mutator of smtpInventoryMutatorCases()) {
    const calls: any[] = [];
    const result = await processToolUse({
      toolUseId: `toolu-${mutator.toolName}`,
      toolName: mutator.toolName,
      toolInput: mutator.input,
      chatSession: { id: "agent:main:operator", msgId: "msg-smtp-inventory" },
      env: enabledEnv(),
      deps: memoryDeps({
        calls,
        decision: {
          status: "executed",
          proposalId: "proposal-smtp-inventory",
          ok: true,
          signatureId: "sig-smtp-inventory",
          outcome: { ok: true, status: "dry_run" },
          statusCode: 200
        }
      })
    });

    assert.equal(result.ok, true, mutator.toolName);
    assert.equal(calls.length, 1, mutator.toolName);
    assert.equal(calls[0].toolName, mutator.toolName);
    assert.deepEqual(buildProposalPayloadFromToolUse(calls[0]).proposal.delivrix_actions_required, [mutator.toolName]);
  }
});

test("processToolUse disables SMTP inventory mutators without HMAC signing config", async () => {
  const env = { ...enabledEnv(), OPENCLAW_HMAC_SECRET: undefined };
  for (const mutator of smtpInventoryMutatorCases()) {
    const calls: unknown[] = [];
    const result = await processToolUse({
      toolUseId: `toolu-no-hmac-${mutator.toolName}`,
      toolName: mutator.toolName,
      toolInput: mutator.input,
      chatSession: { id: "agent:main:operator" },
      env,
      deps: memoryDeps({ calls })
    });

    assert.equal(result.ok, false, mutator.toolName);
    if (result.ok) assert.fail("expected tool_disabled failure");
    assert.equal(result.error, "tool_disabled", mutator.toolName);
    assert.equal(calls.length, 0, mutator.toolName);
  }
});

test("processToolUse aborts SMTP inventory mutators before proposal submit when kill switch is armed", async () => {
  for (const mutator of smtpInventoryMutatorCases()) {
    const calls: unknown[] = [];
    const result = await processToolUse({
      toolUseId: `toolu-kill-${mutator.toolName}`,
      toolName: mutator.toolName,
      toolInput: mutator.input,
      chatSession: { id: "agent:main:operator" },
      env: enabledEnv(),
      deps: memoryDeps({ calls, killSwitchEnabled: true })
    });

    assert.equal(result.ok, false, mutator.toolName);
    if (result.ok) assert.fail("expected kill_switch_armed failure");
    assert.equal(result.error, "kill_switch_armed", mutator.toolName);
    assert.equal(calls.length, 0, mutator.toolName);
  }
});

test("processToolUse invokes read-only wait_for_dns_propagation without proposal wait", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-dns-wait",
    toolName: "wait_for_dns_propagation",
    toolInput: {
      domain: "s2026a._domainkey.delivrix.test",
      expectedRecord: { type: "TXT", value: "contains:v=DKIM1" },
      maxWaitMs: 600_000,
      pollIntervalMs: 30_000
    },
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: {
      async submitProposalFromToolUse() {
        assert.fail("wait_for_dns_propagation must not submit an ApprovalGate proposal");
      },
      async waitForProposalDecision() {
        assert.fail("wait_for_dns_propagation must not wait for ApprovalGate");
      },
      async invokeReadOnlyTool(input) {
        calls.push({ toolName: input.toolName, params: input.params });
        return { ok: true, attempts: 1, lastSeen: "v=dkim1; p=abc", durationMs: 25 };
      },
      async readKillSwitch() {
        return { enabled: false };
      }
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected read-only DNS success");
  assert.equal(result.proposalId, "read_only:toolu-dns-wait");
  assert.deepEqual(result.result, { ok: true, attempts: 1, lastSeen: "v=dkim1; p=abc", durationMs: 25 });
  assert.deepEqual(calls, [{
    toolName: "wait_for_dns_propagation",
    params: {
      domain: "s2026a._domainkey.delivrix.test",
      expectedRecord: { type: "TXT", value: "contains:v=DKIM1" },
      maxWaitMs: 600_000,
      pollIntervalMs: 30_000
    }
  }]);
});

test("processToolUse returns negative DNS propagation evidence without ApprovalGate timeout", async () => {
  const result = await processToolUse({
    toolUseId: "toolu-dns-wait-override",
    toolName: "wait_for_dns_propagation",
    toolInput: {
      domain: "delivrix.test",
      expectedRecord: { type: "A", value: "203.0.113.10" },
      maxWaitMs: 600_000,
      pollIntervalMs: 30_000
    },
    timeoutMs: 900_000,
    chatSession: { id: "agent:main:operator" },
    env: enabledEnv(),
    deps: {
      async submitProposalFromToolUse() {
        assert.fail("wait_for_dns_propagation must not submit an ApprovalGate proposal");
      },
      async waitForProposalDecision() {
        assert.fail("wait_for_dns_propagation must not wait for ApprovalGate");
      },
      async invokeReadOnlyTool() {
        return {
          ok: false,
          attempts: 2,
          lastSeen: "(nxdomain)",
          durationMs: 30_000,
          error: "domain_nxdomain"
        };
      },
      async readKillSwitch() {
        return { enabled: false };
      }
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected read-only DNS transport success");
  assert.deepEqual(result.result, {
    ok: false,
    attempts: 2,
    lastSeen: "(nxdomain)",
    durationMs: 30_000,
    error: "domain_nxdomain"
  });
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

test("buildProposalPayloadFromToolUse targets infrastructure account retire locally", () => {
  const payload = buildProposalPayloadFromToolUse({
    toolUseId: "toolu-retire-account",
    toolName: "retire_infrastructure_account",
    params: {
      providerId: "webdock",
      accountId: "secondary",
      reason: "Cuenta Webdock perdida permanentemente, retirar del selector."
    },
    chatSession: { id: "agent:main:operator", msgId: "msg-99" },
    env: enabledEnv(),
    now: new Date("2026-06-24T12:00:00.000Z")
  });

  assert.equal(payload.proposal.skillSlug, "retire_infrastructure_account");
  assert.deepEqual(payload.proposal.delivrix_actions_required, ["retire_infrastructure_account"]);
  assert.equal(payload.proposal.targetRef, "secondary");
  assert.equal(payload.proposal.targetType, "infrastructure_account");
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

function smtpInventoryMutatorCases(): Array<{ toolName: string; input: Record<string, unknown> }> {
  return [
    {
      toolName: "resolve_ambiguous_domain",
      input: {
        domain: "legacy-one.com",
        keepServerSlug: "server88",
        reason: "Resolver duplicado confirmado por inventario vivo.",
        dryRun: true
      }
    },
    {
      toolName: "retire_smtp_entry",
      input: {
        domain: "legacy-one.com",
        serverSlug: "server92",
        reason: "Retirar entrada espuria confirmada por auditoria.",
        dryRun: true
      }
    },
    {
      toolName: "reassign_domain_server",
      input: {
        domain: "legacy-one.com",
        fromServerSlug: "server92",
        toServerSlug: "server88",
        reason: "Reasignar canonico tras drift confirmado.",
        dryRun: true
      }
    },
    {
      toolName: "update_smtp_entry",
      input: {
        domain: "legacy-one.com",
        serverSlug: "server88",
        status: "configured",
        reason: "Actualizar estado local confirmado por operador.",
        dryRun: true
      }
    }
  ];
}

function enabledEnv(): Record<string, string | undefined> {
  return {
    OPENCLAW_HMAC_SECRET: "test-hmac",
    POSTGRES_URL: "postgres://delivrix:delivrix_dev_password@localhost:5432/delivrix_mailops",
    AWS_ACCESS_KEY_ID: "test-access",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE: "true",
    AWS_ROUTE53_DOMAINS_ENABLE_NAMESERVER_UPDATES: "true",
    AWS_ROUTE53_DNS_ENABLE_WRITES: "true",
    IONOS_DNS_ENABLE_WRITES: "true",
    IONOS_API_TOKEN: "ionos-token",
    MXTOOLBOX_API_KEY: "mxtoolbox-key",
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

function generatedPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  }).privateKey;
}

function pemBodyLine(pem: string): string {
  const line = pem.split(/\r?\n/).find((candidate) => /^[A-Za-z0-9+/]{48,}={0,2}$/.test(candidate));
  assert.ok(line);
  return line;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

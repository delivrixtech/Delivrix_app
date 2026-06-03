import assert from "node:assert/strict";
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

test("createHttpToolUseProcessor invokes episodic scratch read endpoint directly", async () => {
  const urls: string[] = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    fetchImpl: async (url) => {
      urls.push(String(url));
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
  assert.deepEqual(urls, [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/openclaw/scratch?intentId=intent-1"
  ]);
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
  const urls: string[] = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
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
  assert.deepEqual(urls, [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/route53/domain-detail?domain=controldelivrix.app"
  ]);
});

test("createHttpToolUseProcessor invokes read-only Route53 zone records endpoint directly", async () => {
  const urls: string[] = [];
  const processor = createHttpToolUseProcessor({
    delivrixBaseUrl: "http://127.0.0.1:3000",
    env: enabledEnv(),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
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
  assert.deepEqual(urls, [
    "http://127.0.0.1:3000/v1/kill-switch",
    "http://127.0.0.1:3000/v1/route53/zone-records?zoneId=Z03595092JW2AXJBZGN4E&recordType=A&recordName=smtp.controldelivrix.app"
  ]);
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

test("processToolUse invokes read-only wait_for_dns_propagation without proposal wait", async () => {
  const calls: unknown[] = [];
  const result = await processToolUse({
    toolUseId: "toolu-dns-wait",
    toolName: "wait_for_dns_propagation",
    toolInput: {
      domain: "delivrix.test",
      expectedRecord: { type: "NS", value: "contains:awsdns" },
      maxWaitMs: 1_800_000,
      pollIntervalMs: 60_000
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
        return { ok: true, attempts: 1, lastSeen: "ns-1.awsdns-01.com", durationMs: 25 };
      },
      async readKillSwitch() {
        return { enabled: false };
      }
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail("expected read-only DNS success");
  assert.equal(result.proposalId, "read_only:toolu-dns-wait");
  assert.deepEqual(result.result, { ok: true, attempts: 1, lastSeen: "ns-1.awsdns-01.com", durationMs: 25 });
  assert.deepEqual(calls, [{
    toolName: "wait_for_dns_propagation",
    params: {
      domain: "delivrix.test",
      expectedRecord: { type: "NS", value: "contains:awsdns" },
      maxWaitMs: 1_800_000,
      pollIntervalMs: 60_000
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
    POSTGRES_URL: "postgres://delivrix:delivrix_dev_password@localhost:5432/delivrix_mailops",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

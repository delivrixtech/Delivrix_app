import assert from "node:assert/strict";
import test from "node:test";
import {
  buildToolsForOpenClaw,
  getOpenClawToolDefinition
} from "./openclaw-tools-builder.ts";

test("buildToolsForOpenClaw returns the canonical Fase A+B1 tools when gates are enabled", () => {
  const tools = buildToolsForOpenClaw(allEnabledEnv());
  assert.deepEqual(tools.map((tool) => tool.name), [
    "register_domain_route53",
    "suggest_safe_domain",
    "read_episodic_scratch",
    "wait_for_dns_propagation",
    "read_route53_domain_detail",
    "read_route53_zone_records",
    "read_webdock_servers",
    "upsert_dns_route53",
    "upsert_dns_ionos",
    "create_webdock_server",
    "bind_webdock_main_domain",
    "provision_smtp_postfix",
    "configure_email_auth",
    "bind_domain_to_server",
    "seed_warmup_pool",
    "send_real_email",
    "compact_intent",
    "configure_complete_smtp"
  ]);
  assert.equal(
    tools
      .filter((tool) => ![
        "suggest_safe_domain",
        "wait_for_dns_propagation",
        "read_episodic_scratch",
        "read_route53_domain_detail",
        "read_route53_zone_records",
        "read_webdock_servers",
        "compact_intent"
      ].includes(tool.name))
      .every((tool) => tool.description.includes("ApprovalGate")),
    true
  );
  assert.match(
    tools.find((tool) => tool.name === "wait_for_dns_propagation")?.description ?? "",
    /no requiere ApprovalGate/
  );
  assert.match(
    tools.find((tool) => tool.name === "read_route53_domain_detail")?.description ?? "",
    /no requiere ApprovalGate/
  );
  assert.match(
    tools.find((tool) => tool.name === "read_route53_zone_records")?.description ?? "",
    /no requiere ApprovalGate/
  );
  assert.match(
    tools.find((tool) => tool.name === "read_webdock_servers")?.description ?? "",
    /no requiere ApprovalGate/
  );
});

test("buildToolsForOpenClaw omits warmup seed when WARMUP_RAMP_ENABLE is off", () => {
  const tools = buildToolsForOpenClaw({
    ...allEnabledEnv(),
    WARMUP_RAMP_ENABLE: "0"
  });
  assert.equal(tools.length, 16);
  assert.equal(tools.some((tool) => tool.name === "seed_warmup_pool"), false);
  assert.equal(tools.some((tool) => tool.name === "configure_complete_smtp"), false);
});

test("buildToolsForOpenClaw omits Route53 tools when AWS credentials are missing", () => {
  const env = {
    ...allEnabledEnv(),
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: ""
  };
  const names = buildToolsForOpenClaw(env).map((tool) => tool.name);
  assert.equal(names.includes("register_domain_route53"), false);
  assert.equal(names.includes("read_route53_domain_detail"), false);
  assert.equal(names.includes("read_route53_zone_records"), false);
  assert.equal(names.includes("upsert_dns_route53"), false);
  assert.equal(names.includes("configure_email_auth"), false);
  assert.equal(names.includes("bind_domain_to_server"), false);
  assert.equal(names.includes("configure_complete_smtp"), false);
  assert.equal(names.includes("upsert_dns_ionos"), true);
});

test("buildToolsForOpenClaw fail-closes when HMAC secret is missing", () => {
  const tools = buildToolsForOpenClaw({
    ...allEnabledEnv(),
    OPENCLAW_HMAC_SECRET: ""
  });
  assert.deepEqual(tools, []);
});

test("Bedrock tool input schemas align with gateway skill schemas for valid samples", () => {
  for (const tool of buildToolsForOpenClaw(allEnabledEnv())) {
    const definition = getOpenClawToolDefinition(tool.name);
    assert.ok(definition, `missing tool definition for ${tool.name}`);
    const validation = definition.paramSchema.safeParse(validSample(tool.name));
    assert.equal(validation.success, true, `${tool.name} should accept its Bedrock sample`);
    assert.equal(tool.input_schema.type, "object");
    assert.ok(Array.isArray(tool.input_schema.required));
  }
});

test("Bedrock catalog contains Route53 read tools with validated schemas", () => {
  const tools = buildToolsForOpenClaw(allEnabledEnv());
  const domainDetail = tools.find((tool) => tool.name === "read_route53_domain_detail");
  const zoneRecords = tools.find((tool) => tool.name === "read_route53_zone_records");

  assert.ok(domainDetail);
  assert.deepEqual(domainDetail.input_schema.required, ["domain"]);
  assert.equal(getOpenClawToolDefinition("read_route53_domain_detail")?.paramSchema.safeParse({
    domain: "controldelivrix.app"
  }).success, true);

  assert.ok(zoneRecords);
  assert.deepEqual(zoneRecords.input_schema.required, ["zoneId"]);
  assert.deepEqual(zoneRecords.input_schema.properties.recordType, {
    type: "string",
    enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"],
    description: "Filtrar por tipo de record. Opcional."
  });
  assert.equal(getOpenClawToolDefinition("read_route53_zone_records")?.paramSchema.safeParse({
    zoneId: "Z03595092JW2AXJBZGN4E",
    recordType: "A",
    recordName: "smtp.controldelivrix.app"
  }).success, true);
});

test("buildToolsForOpenClaw exposes Fase A tools directly to Bedrock", () => {
  const names = buildToolsForOpenClaw(allEnabledEnv()).map((tool) => tool.name);
  for (const name of [
    "suggest_safe_domain",
    "read_episodic_scratch",
    "wait_for_dns_propagation",
    "read_route53_domain_detail",
    "read_route53_zone_records",
    "read_webdock_servers",
    "bind_webdock_main_domain",
    "send_real_email",
    "compact_intent",
    "configure_complete_smtp"
  ]) {
    assert.equal(names.includes(name), true, `${name} should be exposed`);
  }
});

test("configure_complete_smtp fail-closes when a required subtool is disabled", () => {
  const names = buildToolsForOpenClaw({
    ...allEnabledEnv(),
    SEND_REAL_EMAIL_ENABLE: "0",
    SMTP_SEND_REAL_EMAIL_ENABLE: "0"
  }).map((tool) => tool.name);

  assert.equal(names.includes("send_real_email"), false);
  assert.equal(names.includes("configure_complete_smtp"), false);
});

function allEnabledEnv(): Record<string, string | undefined> {
  return {
    OPENCLAW_HMAC_SECRET: "test-hmac",
    POSTGRES_URL: "postgres://delivrix:delivrix_dev_password@localhost:5432/delivrix_mailops",
    AWS_ACCESS_KEY_ID: "test-access",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    AWS_ROUTE53_DOMAINS_ENABLE_PURCHASE: "true",
    AWS_ROUTE53_DNS_ENABLE_WRITES: "true",
    IONOS_DNS_ENABLE_WRITES: "true",
    IONOS_API_TOKEN: "ionos-token",
    PORKBUN_API_KEY: "porkbun-key",
    PORKBUN_SECRET_API_KEY: "porkbun-secret",
    WEBDOCK_SERVERS_ENABLE_CREATE: "true",
    WEBDOCK_MAIN_DOMAIN_BIND_ENABLE: "true",
    WEBDOCK_API_KEY_OPS: "webdock-ops",
    SMTP_PROVISIONING_ENABLE_SSH: "true",
    SMTP_PROVISION_SSH_KEY_PATH: "/tmp/delivrix-smoke-key",
    EMAIL_AUTH_ENABLE_WRITES: "true",
    DOMAIN_BIND_ENABLE: "true",
    WARMUP_ENABLE_SEND: "true",
    WARMUP_RAMP_ENABLE: "true",
    SMTP_SEND_REAL_EMAIL_ENABLE: "true",
    OPENCLAW_CONFIGURE_COMPLETE_SMTP_ENABLE: "true"
  };
}

function validSample(toolName: string): Record<string, unknown> {
  if (toolName === "register_domain_route53") {
    return { domain: "delivrix.test", years: 1, autoRenew: false };
  }
  if (toolName === "suggest_safe_domain") {
    return { brand: "delivrix", intent: "ops", count: 5 };
  }
  if (toolName === "wait_for_dns_propagation") {
    return {
      domain: "delivrix.test",
      expectedRecord: { type: "TXT", value: "v=DKIM1" },
      maxWaitMs: 60000,
      pollIntervalMs: 30000
    };
  }
  if (toolName === "read_episodic_scratch") {
    return { intentId: "intent-1" };
  }
  if (toolName === "read_route53_domain_detail") {
    return { domain: "controldelivrix.app" };
  }
  if (toolName === "read_route53_zone_records") {
    return {
      zoneId: "Z03595092JW2AXJBZGN4E",
      recordType: "A",
      recordName: "smtp.controldelivrix.app"
    };
  }
  if (toolName === "read_webdock_servers") {
    return { serverSlug: "server10", ipv4: "45.136.70.47" };
  }
  if (toolName === "upsert_dns_route53") {
    return {
      domain: "delivrix.test",
      records: [{ name: "@", type: "A", ttl: 300, values: ["203.0.113.10"] }]
    };
  }
  if (toolName === "upsert_dns_ionos") {
    return {
      zone: "delivrix.test",
      records: [{ name: "@", type: "TXT", content: "v=spf1 -all", ttl: 300 }]
    };
  }
  if (toolName === "create_webdock_server") {
    return {
      profile: "bit",
      locationId: "dk",
      hostname: "smtp-1.delivrix.test",
      imageSlug: "ubuntu-2404"
    };
  }
  if (toolName === "bind_webdock_main_domain") {
    return { serverSlug: "server-69", domain: "delivrix.test", setPtr: true };
  }
  if (toolName === "provision_smtp_postfix") {
    return { serverSlug: "server69", domain: "delivrix.test", serverIp: "203.0.113.10" };
  }
  if (toolName === "configure_email_auth") {
    return { domain: "delivrix.test", mxServerIp: "203.0.113.10", dmarcPolicy: "none" };
  }
  if (toolName === "bind_domain_to_server") {
    return { domain: "delivrix.test", serverIp: "203.0.113.10" };
  }
  if (toolName === "seed_warmup_pool") {
    return {
      domain: "delivrix.test",
      serverIp: "203.0.113.10",
      seedInboxes: ["seed-1@example.com", "seed-2@example.com", "seed-3@example.com"]
    };
  }
  if (toolName === "send_real_email") {
    return {
      fromAddress: "hello@delivrix.test",
      toAddress: "operator@example.com",
      subject: "Operational readiness report",
      body: "Authorized operational readiness message for Delivrix infrastructure.",
      serverSlug: "server-69"
    };
  }
  if (toolName === "compact_intent") {
    return {
      intentId: "intent-1",
      finalStatus: "completed",
      decision: "stored completed flow summary",
      steps: [
        {
          step: 1,
          tool: "suggest_safe_domain",
          inputHash: "a".repeat(64),
          outcome: "success"
        }
      ]
    };
  }
  return {
    brand: "delivrix",
    intent: "ops",
    budgetUsdMax: 25,
    testEmailRecipient: "operator@example.com",
    testEmailSubject: "Operational readiness report",
    testEmailBody: "Authorized operational readiness message for Delivrix infrastructure.",
    seedInboxes: ["seed-1@example.com", "seed-2@example.com", "seed-3@example.com"]
  };
}

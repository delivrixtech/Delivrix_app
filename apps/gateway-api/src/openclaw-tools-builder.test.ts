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
    "read_delivery_reason",
    "read_smtp_reachability",
    "read_dkim_status",
    "read_run_state_integrity",
    "update_domain_nameservers",
    "read_dns_ionos",
    "read_mxtoolbox_health",
    "read_infrastructure_inventory",
    "inspect_smtp_inventory",
    "read_infrastructure_account_health",
    "read_webdock_servers",
    "list_conversations",
    "read_conversation",
    "upsert_dns_route53",
    "upsert_dns_ionos",
    "create_webdock_server",
    "bind_webdock_main_domain",
    "provision_smtp_postfix",
    "configure_email_auth",
    "enable_smtp_auth",
    "resolve_ambiguous_domain",
    "retire_smtp_entry",
    "reassign_domain_server",
    "update_smtp_entry",
    "bind_domain_to_server",
    "seed_warmup_pool",
    "send_real_email",
    "compact_intent",
    "configure_complete_smtp",
    "retire_infrastructure_account"
  ]);
  assert.equal(
    tools
      .filter((tool) => ![
        "suggest_safe_domain",
        "wait_for_dns_propagation",
        "read_episodic_scratch",
        "read_route53_domain_detail",
        "read_route53_zone_records",
        "read_delivery_reason",
        "read_smtp_reachability",
        "read_dkim_status",
        "read_run_state_integrity",
        "read_dns_ionos",
        "read_mxtoolbox_health",
        "read_infrastructure_inventory",
        "inspect_smtp_inventory",
        "read_infrastructure_account_health",
        "read_webdock_servers",
        "list_conversations",
        "read_conversation",
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
    tools.find((tool) => tool.name === "read_dns_ionos")?.description ?? "",
    /no requiere ApprovalGate/
  );
  assert.match(
    tools.find((tool) => tool.name === "read_mxtoolbox_health")?.description ?? "",
    /read-only/
  );
  const infrastructureInventory = tools.find((tool) => tool.name === "read_infrastructure_inventory");
  assert.ok(infrastructureInventory);
  assert.deepEqual(infrastructureInventory.input_schema.required, []);
  assert.match(infrastructureInventory.description, /read-only/);
  const smtpInventory = tools.find((tool) => tool.name === "inspect_smtp_inventory");
  assert.ok(smtpInventory);
  assert.deepEqual(smtpInventory.input_schema.required, []);
  assert.match(smtpInventory.description, /read-only/);
  const infrastructureAccountHealth = tools.find((tool) => tool.name === "read_infrastructure_account_health");
  assert.ok(infrastructureAccountHealth);
  assert.deepEqual(infrastructureAccountHealth.input_schema.required, []);
  assert.match(infrastructureAccountHealth.description, /read-only/);
  assert.match(
    tools.find((tool) => tool.name === "read_webdock_servers")?.description ?? "",
    /no requiere ApprovalGate/
  );
  const listConversations = tools.find((tool) => tool.name === "list_conversations");
  assert.ok(listConversations);
  assert.deepEqual(listConversations.input_schema.required, []);
  assert.match(listConversations.description, /paginados/);
  const readConversation = tools.find((tool) => tool.name === "read_conversation");
  assert.ok(readConversation);
  assert.deepEqual(readConversation.input_schema.required, ["conversationId"]);
  assert.match(readConversation.description, /read-only/);
  const enableSmtpAuth = tools.find((tool) => tool.name === "enable_smtp_auth");
  assert.ok(enableSmtpAuth);
  assert.match(enableSmtpAuth.description, /ApprovalGate/);
  assert.match(enableSmtpAuth.description, /un solo dominio/);
  assert.match(enableSmtpAuth.description, /No imprime password ni markdown/);
  assert.deepEqual(enableSmtpAuth.input_schema.required, ["domain"]);
  assert.ok("serverSlug" in enableSmtpAuth.input_schema.properties);
  for (const toolName of ["resolve_ambiguous_domain", "retire_smtp_entry", "reassign_domain_server", "update_smtp_entry"]) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    assert.ok(tool, `${toolName} should be exposed`);
    assert.match(tool.description, /ApprovalGate/);
    assert.match(tool.description, /local-state-only/);
  }
  const retireAccount = tools.find((tool) => tool.name === "retire_infrastructure_account");
  assert.ok(retireAccount);
  assert.match(retireAccount.description, /ApprovalGate/);
  assert.match(retireAccount.description, /NO borra VPS/);
  assert.deepEqual(retireAccount.input_schema.required, ["providerId", "accountId", "reason"]);
});

test("buildToolsForOpenClaw omits warmup seed when WARMUP_RAMP_ENABLE is off", () => {
  const tools = buildToolsForOpenClaw({
    ...allEnabledEnv(),
    WARMUP_RAMP_ENABLE: "0"
  });
  assert.equal(tools.length, 34);
  assert.equal(tools.some((tool) => tool.name === "seed_warmup_pool"), false);
  assert.equal(tools.some((tool) => tool.name === "configure_complete_smtp"), false);
});

test("buildToolsForOpenClaw omits MXToolbox tool when API key is missing", () => {
  const names = buildToolsForOpenClaw({
    ...allEnabledEnv(),
    MXTOOLBOX_API_KEY: ""
  }).map((tool) => tool.name);

  assert.equal(names.includes("read_mxtoolbox_health"), false);
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
  assert.equal(names.includes("update_domain_nameservers"), false);
  assert.equal(names.includes("upsert_dns_route53"), false);
  assert.equal(names.includes("configure_email_auth"), false);
  assert.equal(names.includes("bind_domain_to_server"), false);
  assert.equal(names.includes("configure_complete_smtp"), false);
  assert.equal(names.includes("upsert_dns_ionos"), true);
  assert.equal(names.includes("read_dns_ionos"), true);
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
  const ionosRecords = tools.find((tool) => tool.name === "read_dns_ionos");
  const nameservers = tools.find((tool) => tool.name === "update_domain_nameservers");

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

  assert.ok(ionosRecords);
  assert.deepEqual(ionosRecords.input_schema.required, []);
  assert.equal(getOpenClawToolDefinition("read_dns_ionos")?.paramSchema.safeParse({
    domain: "nationalcorphub.app",
    recordType: "TXT",
    recordName: "_dmarc.nationalcorphub.app"
  }).success, true);

  assert.ok(nameservers);
  assert.deepEqual(nameservers.input_schema.required, ["domain"]);
  assert.equal(getOpenClawToolDefinition("update_domain_nameservers")?.paramSchema.safeParse({
    domain: "controldelivrix.app",
    zoneId: "Z03595092JW2AXJBZGN4E",
    nameservers: ["ns-1.awsdns.com", "ns-2.awsdns.net"]
  }).success, true);
});

test("Bedrock wait_for_dns_propagation schema accepts DKIM and DMARC record names", () => {
  const waitTool = buildToolsForOpenClaw(allEnabledEnv()).find((tool) => tool.name === "wait_for_dns_propagation");
  assert.ok(waitTool);
  const domainProperty = waitTool.input_schema.properties.domain as { pattern?: string; description?: string };
  assert.ok(domainProperty.pattern);
  assert.match("s2026a._domainkey.delivrix.test", new RegExp(domainProperty.pattern));
  assert.match("_dmarc.delivrix.test", new RegExp(domainProperty.pattern));
  assert.match(domainProperty.description ?? "", /underscore/);
  assert.equal(getOpenClawToolDefinition("wait_for_dns_propagation")?.paramSchema.safeParse({
    domain: "s2026a._domainkey.delivrix.test",
    expectedRecord: { type: "TXT", value: "contains:v=DKIM1" },
    maxWaitMs: 60000,
    pollIntervalMs: 30000
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
    "update_domain_nameservers",
    "read_dns_ionos",
    "read_infrastructure_inventory",
    "inspect_smtp_inventory",
    "read_infrastructure_account_health",
    "read_webdock_servers",
    "list_conversations",
    "read_conversation",
    "bind_webdock_main_domain",
    "enable_smtp_auth",
    "resolve_ambiguous_domain",
    "retire_smtp_entry",
    "reassign_domain_server",
    "update_smtp_entry",
    "send_real_email",
    "compact_intent",
    "configure_complete_smtp",
    "retire_infrastructure_account"
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
    AWS_ROUTE53_DOMAINS_ENABLE_NAMESERVER_UPDATES: "true",
    AWS_ROUTE53_DNS_ENABLE_WRITES: "true",
    IONOS_DNS_ENABLE_WRITES: "true",
    IONOS_API_TOKEN: "ionos-token",
    MXTOOLBOX_API_KEY: "mxtoolbox-key",
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
      domain: "s2026a._domainkey.delivrix.test",
      expectedRecord: { type: "TXT", value: "contains:v=DKIM1" },
      maxWaitMs: 60000,
      pollIntervalMs: 30000
    };
  }
  if (toolName === "read_episodic_scratch") {
    return { tool: "suggest_safe_domain", query: "warmup domain reputation", limit: 5 };
  }
  if (toolName === "read_route53_domain_detail") {
    return { domain: "controldelivrix.app" };
  }
  if (toolName === "read_delivery_reason") {
    return { serverSlug: "smtp-1", serverIp: "1.1.1.1", messageId: "<delivrix-abc@controldelivrix.app>" };
  }
  if (toolName === "read_smtp_reachability") {
    return { serverSlug: "smtp-1", serverIp: "1.1.1.1" };
  }
  if (toolName === "read_dkim_status") {
    return { domain: "controldelivrix.app", expectedSelector: "s2026a" };
  }
  if (toolName === "read_run_state_integrity") {
    return {};
  }
  if (toolName === "read_route53_zone_records") {
    return {
      zoneId: "Z03595092JW2AXJBZGN4E",
      recordType: "A",
      recordName: "smtp.controldelivrix.app"
    };
  }
  if (toolName === "update_domain_nameservers") {
    return {
      domain: "controldelivrix.app",
      zoneId: "Z03595092JW2AXJBZGN4E",
      nameservers: ["ns-1.awsdns.com", "ns-2.awsdns.net"]
    };
  }
  if (toolName === "read_dns_ionos") {
    return {
      domain: "nationalcorphub.app",
      recordType: "TXT",
      recordName: "_dmarc.nationalcorphub.app"
    };
  }
  if (toolName === "read_mxtoolbox_health") {
    return { target: "8.8.8.8", type: "blacklist" };
  }
  if (toolName === "read_infrastructure_inventory") {
    return {};
  }
  if (toolName === "inspect_smtp_inventory") {
    return { domain: "delivrix.test", status: "configured" };
  }
  if (toolName === "read_infrastructure_account_health") {
    return {};
  }
  if (toolName === "read_webdock_servers") {
    return { serverSlug: "server10", ipv4: "45.136.70.47" };
  }
  if (toolName === "list_conversations") {
    return { offset: 0, limit: 20 };
  }
  if (toolName === "read_conversation") {
    return { conversationId: "conv-a", offset: 0, limit: 6, maxCharsPerTurn: 500 };
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
  if (toolName === "enable_smtp_auth") {
    return { domain: "delivrix.test", serverSlug: "server69" };
  }
  if (toolName === "resolve_ambiguous_domain") {
    return {
      domain: "delivrix.test",
      keepServerSlug: "server69",
      reason: "Resolver duplicado tras retry de provisioning."
    };
  }
  if (toolName === "retire_smtp_entry") {
    return {
      domain: "delivrix.test",
      serverSlug: "server68",
      reason: "Servidor reemplazado por retry exitoso."
    };
  }
  if (toolName === "reassign_domain_server") {
    return {
      domain: "delivrix.test",
      fromServerSlug: "server68",
      toServerSlug: "server69",
      reason: "Servidor nuevo verificado como canonico."
    };
  }
  if (toolName === "update_smtp_entry") {
    return {
      domain: "delivrix.test",
      serverSlug: "server69",
      status: "configured",
      reason: "Correccion auditada de metadata local."
    };
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
  if (toolName === "retire_infrastructure_account") {
    return {
      providerId: "webdock",
      accountId: "secondary",
      reason: "Cuenta Webdock perdida permanentemente, retirar del selector."
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

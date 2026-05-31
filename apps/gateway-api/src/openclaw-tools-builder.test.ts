import assert from "node:assert/strict";
import test from "node:test";
import {
  buildToolsForOpenClaw,
  getOpenClawToolDefinition
} from "./openclaw-tools-builder.ts";

test("buildToolsForOpenClaw returns the 8 canonical tools when gates are enabled", () => {
  const tools = buildToolsForOpenClaw(allEnabledEnv());
  assert.deepEqual(tools.map((tool) => tool.name), [
    "register_domain_route53",
    "upsert_dns_route53",
    "upsert_dns_ionos",
    "create_webdock_server",
    "provision_smtp_postfix",
    "configure_email_auth",
    "bind_domain_to_server",
    "seed_warmup_pool"
  ]);
  assert.equal(tools.every((tool) => tool.description.includes("ApprovalGate")), true);
});

test("buildToolsForOpenClaw omits warmup seed when WARMUP_RAMP_ENABLE is off", () => {
  const tools = buildToolsForOpenClaw({
    ...allEnabledEnv(),
    WARMUP_RAMP_ENABLE: "0"
  });
  assert.equal(tools.length, 7);
  assert.equal(tools.some((tool) => tool.name === "seed_warmup_pool"), false);
});

test("buildToolsForOpenClaw omits Route53 tools when AWS credentials are missing", () => {
  const env = {
    ...allEnabledEnv(),
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: ""
  };
  const names = buildToolsForOpenClaw(env).map((tool) => tool.name);
  assert.equal(names.includes("register_domain_route53"), false);
  assert.equal(names.includes("upsert_dns_route53"), false);
  assert.equal(names.includes("configure_email_auth"), false);
  assert.equal(names.includes("bind_domain_to_server"), false);
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

function allEnabledEnv(): Record<string, string | undefined> {
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
    WARMUP_RAMP_ENABLE: "true"
  };
}

function validSample(toolName: string): Record<string, unknown> {
  if (toolName === "register_domain_route53") {
    return { domain: "delivrix.test", years: 1, autoRenew: false };
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
  if (toolName === "provision_smtp_postfix") {
    return { serverSlug: "server69", domain: "delivrix.test", serverIp: "203.0.113.10" };
  }
  if (toolName === "configure_email_auth") {
    return { domain: "delivrix.test", mxServerIp: "203.0.113.10", dmarcPolicy: "none" };
  }
  if (toolName === "bind_domain_to_server") {
    return { domain: "delivrix.test", serverIp: "203.0.113.10" };
  }
  return {
    domain: "delivrix.test",
    serverIp: "203.0.113.10",
    seedInboxes: ["seed-1@example.com", "seed-2@example.com", "seed-3@example.com"]
  };
}

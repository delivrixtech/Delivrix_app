import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptWebdockServerParamSchema,
  compactIntentParamSchema,
  configureCompleteSmtpSkillParamSchema,
  createSmtpEntryParamSchema,
  enableSmtpAuthParamSchema,
  retireInfrastructureAccountParamSchema
} from "./skill-schemas.ts";
import {
  EpisodicScratchValidationError,
  validateEpisodicEntryInput,
  type InsertEntryInput
} from "../../../packages/storage/src/index.ts";

test("compactIntentParamSchema truncates long decisions for compact_intent only", () => {
  const longDecision = `stored-${"x".repeat(320)}`;
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "completed",
    decision: longDecision,
    steps: [{
      step: 1,
      tool: "suggest_safe_domain",
      inputHash: "a".repeat(64),
      outcome: "success"
    }]
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));
  assert.equal(parsed.data.decision, longDecision.slice(0, 280));
  assert.equal(parsed.data.decision.length, 280);
});

test("compactIntentParamSchema machine-codes free-text errorMessage at the agent producer", () => {
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "failed",
    decision: "stored",
    steps: [{
      step: 1,
      tool: "register_domain",
      inputHash: "a".repeat(64),
      outcome: "failed",
      errorMessage: "Step failed: domain not registered."
    }]
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));
  const errorMessage = parsed.data.steps[0].errorMessage;
  assert.equal(typeof errorMessage, "string");
  assert.match(errorMessage as string, /^[a-z0-9_.:-]+$/);
});

test("compactIntentParamSchema conforms free-text outcomeData at the agent producer", () => {
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "failed",
    decision: "stored",
    steps: [{
      step: 1,
      tool: "register_domain",
      inputHash: "a".repeat(64),
      outcome: "failed",
      outcomeData: { note: "domain not registered" }
    }]
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));
  const outcomeData = parsed.data.steps[0].outcomeData;
  assert.ok(outcomeData && typeof outcomeData === "object");
  // The non-allowlisted free-text key is dropped, leaving a gate-safe object.
  assert.equal(Object.prototype.hasOwnProperty.call(outcomeData, "note"), false);
  assert.deepEqual(outcomeData, {});
});

test("agent producer output passes the storage write-gate where raw free-text would 400", () => {
  const rawErrorMessage = "Step failed: domain not registered.";
  const rawOutcomeData = { note: "domain not registered" };

  // The raw, un-conformed payload is rejected by the storage write-gate (would 400).
  const rawEntry: InsertEntryInput = {
    intentId: "intent-1",
    step: 1,
    tool: "register_domain",
    inputHash: "a".repeat(64),
    outcome: "failed",
    outcomeData: { ...rawOutcomeData },
    errorMessage: rawErrorMessage,
    source: "openclaw"
  };
  assert.throws(
    () => validateEpisodicEntryInput(rawEntry),
    (error: unknown) => error instanceof EpisodicScratchValidationError && error.code === "memory_payload_free_text_forbidden"
  );

  // The agent producer conforms both fields, so the same forwarded payload is gate-safe (would 200).
  const parsed = compactIntentParamSchema.safeParse({
    intentId: "intent-1",
    finalStatus: "failed",
    decision: "stored",
    steps: [{
      step: 1,
      tool: "register_domain",
      inputHash: "a".repeat(64),
      outcome: "failed",
      outcomeData: { ...rawOutcomeData },
      errorMessage: rawErrorMessage
    }]
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join(", "));

  const step = parsed.data.steps[0];
  const conformedEntry: InsertEntryInput = {
    intentId: parsed.data.intentId,
    step: step.step,
    tool: step.tool,
    inputHash: step.inputHash,
    outcome: step.outcome,
    ...(step.outcomeData === undefined ? {} : { outcomeData: step.outcomeData }),
    ...(step.errorClass === undefined ? {} : { errorClass: step.errorClass }),
    ...(step.errorMessage === undefined ? {} : { errorMessage: step.errorMessage }),
    source: "openclaw"
  };
  assert.doesNotThrow(() => validateEpisodicEntryInput(conformedEntry));
});

test("configureCompleteSmtpSkillParamSchema rejects unknown VPS providers fail-closed", () => {
  const parsed = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    vpsProviderId: "contaboo",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });

  assert.equal(parsed.success, false);
  if (parsed.success) assert.fail("unknown provider should be rejected");
  assert.match(parsed.error.issues.join("\n"), /vpsProviderId/);
});

test("configureCompleteSmtpSkillParamSchema normalizes known VPS providers", () => {
  const parsed = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    vpsProviderId: "Contabo",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join("\n"));
  assert.equal(parsed.data.vpsProviderId, "contabo");
});

test("configureCompleteSmtpSkillParamSchema preserves dynamic provider account ids", () => {
  const parsed = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    serverAccountId: "Quaternary",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join("\n"));
  assert.equal(parsed.data.serverAccountId, "quaternary");

  const unsafe = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    serverAccountId: "webdock:ops",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });
  assert.equal(unsafe.success, false);
});

test("configureCompleteSmtpSkillParamSchema preserves reuseServerSlug for existing VPS adoption", () => {
  const parsed = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    reuseServerSlug: "Server-60",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join("\n"));
  assert.equal(parsed.data.reuseServerSlug, "server-60");

  const unsafe = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    reuseServerSlug: "server/60",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });
  assert.equal(unsafe.success, false);
});

test("configureCompleteSmtpSkillParamSchema rejects unknown DNS providers fail-closed", () => {
  const parsed = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    dnsProviderId: "cloudflare",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });

  assert.equal(parsed.success, false);
  if (parsed.success) assert.fail("unknown DNS provider should be rejected");
  assert.match(parsed.error.issues.join("\n"), /dnsProviderId/);
});

test("createSmtpEntryParamSchema is dry-run by default, requires reason and rejects invalid states", () => {
  const validReason = "Crear entrada tras verificacion multi-proveedor.";
  const parsed = createSmtpEntryParamSchema.safeParse({
    domain: "Example.COM",
    serverSlug: "Server-88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    reason: validReason
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join("\n"));
  assert.deepEqual(parsed.data, {
    domain: "example.com",
    serverSlug: "Server-88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    status: "configured",
    reason: validReason,
    dryRun: true
  });

  const writable = createSmtpEntryParamSchema.safeParse({
    domain: "example.com",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    status: "configured",
    dryRun: false,
    reason: "Entrada verificada contra inventario vivo."
  });
  assert.equal(writable.success, true);
  if (!writable.success) assert.fail(writable.error.issues.join("\n"));
  assert.equal(writable.data.dryRun, false);

  const missingReason = createSmtpEntryParamSchema.safeParse({
    domain: "example.com",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a"
  });
  assert.equal(missingReason.success, false);

  const shortReason = createSmtpEntryParamSchema.safeParse({
    domain: "example.com",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    reason: "corto"
  });
  assert.equal(shortReason.success, false);

  const wrongStatus = createSmtpEntryParamSchema.safeParse({
    domain: "example.com",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    status: "retired",
    reason: validReason
  });
  assert.equal(wrongStatus.success, false);

  const invalidIp = createSmtpEntryParamSchema.safeParse({
    domain: "example.com",
    serverSlug: "server88",
    serverIp: "999.0.2.88",
    selector: "s2026a",
    reason: validReason
  });
  assert.equal(invalidIp.success, false);

  for (const selector of ["", "inv@lid!", "selector with space"]) {
    const invalidSelector = createSmtpEntryParamSchema.safeParse({
      domain: "example.com",
      serverSlug: "server88",
      serverIp: "192.0.2.88",
      selector,
      reason: validReason
    });
    assert.equal(invalidSelector.success, false, `selector ${JSON.stringify(selector)} should be rejected`);
  }

  const invalidDomain = createSmtpEntryParamSchema.safeParse({
    domain: "example.com;rm -rf /",
    serverSlug: "server88",
    serverIp: "192.0.2.88",
    selector: "s2026a",
    reason: validReason
  });
  assert.equal(invalidDomain.success, false);
});

test("adoptWebdockServerParamSchema is dry-run by default, requires reason and rejects invalid inputs", () => {
  const validReason = "Adoptar server huerfano verificado en la flota viva.";
  const parsed = adoptWebdockServerParamSchema.safeParse({
    serverSlug: "server57",
    serverIp: "193.180.211.146",
    serverAccountId: "quinary",
    reason: validReason
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail("adopt_webdock_server sample should parse");
  assert.deepEqual(parsed.data, {
    serverSlug: "server57",
    serverIp: "193.180.211.146",
    serverAccountId: "quinary",
    reason: validReason,
    dryRun: true
  });

  const writable = adoptWebdockServerParamSchema.safeParse({
    serverSlug: "server57",
    serverIp: "193.180.211.146",
    serverAccountId: "quinary",
    reason: validReason,
    dryRun: false
  });
  assert.equal(writable.success, true);
  if (!writable.success) assert.fail("adopt_webdock_server writable sample should parse");
  assert.equal(writable.data.dryRun, false);

  const missingReason = adoptWebdockServerParamSchema.safeParse({
    serverSlug: "server57",
    serverIp: "193.180.211.146",
    serverAccountId: "quinary"
  });
  assert.equal(missingReason.success, false);

  const missingAccount = adoptWebdockServerParamSchema.safeParse({
    serverSlug: "server57",
    serverIp: "193.180.211.146",
    reason: validReason
  });
  assert.equal(missingAccount.success, false);

  const invalidIp = adoptWebdockServerParamSchema.safeParse({
    serverSlug: "server57",
    serverIp: "999.180.211.146",
    serverAccountId: "quinary",
    reason: validReason
  });
  assert.equal(invalidIp.success, false);

  const invalidSlug = adoptWebdockServerParamSchema.safeParse({
    serverSlug: "server 57;rm",
    serverIp: "193.180.211.146",
    serverAccountId: "quinary",
    reason: validReason
  });
  assert.equal(invalidSlug.success, false);
});

test("configureCompleteSmtpSkillParamSchema normalizes known DNS providers", () => {
  const parsed = configureCompleteSmtpSkillParamSchema.safeParse({
    brand: "delivrix",
    domain: "example.com",
    provider: "route53",
    dnsProviderId: "IONOS",
    budgetUsdMax: 25,
    testEmailRecipient: "ops@example.com",
    testEmailSubject: "Smoke",
    testEmailBody: "Smoke body"
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join("\n"));
  assert.equal(parsed.data.dnsProviderId, "ionos");
});

test("enableSmtpAuthParamSchema accepts exactly one normalized domain", () => {
  const parsed = enableSmtpAuthParamSchema.safeParse({
    domain: "Example-Sender.COM."
  });

  assert.equal(parsed.success, true);
  if (!parsed.success) assert.fail(parsed.error.issues.join("\n"));
  assert.deepEqual(parsed.data, { domain: "example-sender.com" });
});

test("enableSmtpAuthParamSchema rejects missing or invalid domains", () => {
  for (const payload of [{}, { domain: "../example.com" }, { domain: ["example.com"] }]) {
    const parsed = enableSmtpAuthParamSchema.safeParse(payload);
    assert.equal(parsed.success, false, JSON.stringify(payload));
  }
});

test("retireInfrastructureAccountParamSchema rejects control characters in operator metadata", () => {
  const valid = retireInfrastructureAccountParamSchema.safeParse({
    providerId: "webdock",
    accountId: "primary",
    reason: "Cuenta perdida confirmada por operador.",
    accountLabel: "Cuenta madre"
  });
  assert.equal(valid.success, true);
  if (!valid.success) assert.fail(valid.error.issues.join("\n"));
  assert.equal(valid.data.accountId, "primary");

  for (const payload of [
    {
      providerId: "webdock",
      accountId: "primary",
      reason: "Cuenta perdida\ninyectada",
      accountLabel: "Cuenta madre"
    },
    {
      providerId: "webdock",
      accountId: "primary",
      reason: "Cuenta perdida confirmada por operador.",
      accountLabel: "Cuenta madre\r"
    },
    {
      providerId: "contabo",
      accountId: "primary",
      reason: "Cuenta perdida confirmada por operador."
    },
    {
      providerId: "webdock",
      accountId: "primary.evil",
      reason: "Cuenta perdida confirmada por operador."
    },
    {
      providerId: "webdock",
      accountId: "webdock:primary",
      reason: "Cuenta perdida confirmada por operador."
    }
  ]) {
    const parsed = retireInfrastructureAccountParamSchema.safeParse(payload);
    assert.equal(parsed.success, false, JSON.stringify(payload));
  }
});

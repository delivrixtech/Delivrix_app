import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableStringify } from "../../../../packages/storage/src/stable-stringify.ts";
import { createInternalHttpAdapter } from "../internal-http-adapter.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  coerceSafeSmokeBody,
  coerceSafeSmokeSubject,
  configureCompleteSmtp,
  handleConfigureCompleteSmtp,
  readSmtpRunProgress,
  type ApprovalStepDecision,
  type ApprovalStepInput,
  type ConfigureCompleteSmtpDeps,
  type CreationRateOverrideInput,
  type CreationRateOverrideDecision,
  type OwnedDomainVerification,
  type PlanApprovedStepInput,
  type PlanApprovedStepDecision,
  type Route53DomainRegistrationWaitInput,
  type Route53DomainRegistrationWaitResult,
  type SkillInvocationInput
} from "./orchestrator-smtp.ts";
import type { PlanApprovalRecord } from "./proposals-sign.ts";
import { compactIntent } from "./openclaw-compact-intent.ts";
import { SPAM_FLAG_WORDS } from "./send-email.ts";

test("coerceSafeSmoke respeta contenido valido y coerciona el que dispararia anti-spam/longitud (regresion 400 step 14)", () => {
  // Contenido valido se respeta tal cual (los smokes reales en espanol pasan).
  const okSubject = "Infraestructura Delivrix - verificacion de entrega";
  const okBody = "Este correo confirma que la infraestructura de correo del dominio esta operativa con SPF, DKIM y DMARC.";
  assert.equal(coerceSafeSmokeSubject(okSubject, "controlledgerdesk.com"), okSubject);
  assert.equal(coerceSafeSmokeBody(okBody, "controlledgerdesk.com"), okBody);

  // Spam flag words -> reemplazado por default seguro que NO contiene NINGUNA flag word.
  const subjFlag = coerceSafeSmokeSubject("Test SMTP smoke prueba", "controlledgerdesk.com");
  const bodyFlag = coerceSafeSmokeBody("prueba de envio test", "controlledgerdesk.com");
  for (const word of SPAM_FLAG_WORDS) {
    assert.equal(subjFlag.toLowerCase().includes(word), false, `subject default no debe contener "${word}"`);
    assert.equal(bodyFlag.toLowerCase().includes(word), false, `body default no debe contener "${word}"`);
  }
  assert.match(subjFlag, /controlledgerdesk\.com/);
  assert.ok(bodyFlag.length >= 20);

  // Longitud fuera de rango -> default seguro.
  assert.ok(coerceSafeSmokeSubject("ab", "x.com").length >= 3); // subject < 3
  assert.ok(coerceSafeSmokeBody("corto", "x.com").length >= 20); // body < 20
  assert.ok(coerceSafeSmokeBody("a".repeat(9000), "x.com").length <= 8000); // body > 8000 (default)
});

test("configureCompleteSmtp completes the 14-step happy path", async () => {
  const ctx = createDeps();
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(result.stepResults.length, 14);
  assert.deepEqual(result.stepResults.map((step) => step.step), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(result.finalEmailMessageId, "<delivrix-0123456789abcdef@delivrixops.com>");
  assert.equal(result.finalDeliveryStatus, "delivered");
});

test("configureCompleteSmtp chooses the first suggested domain", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(ctx.approvals[0].params.domain, "delivrixops.com");
});

test("readSmtpRunProgress returns the safe 14-step snapshot shape", async () => {
  const ctx = createDeps();
  await ctx.workspace.writeWorkspaceFileAtomic("inventory/smtp-runs/run-progress.json", `${JSON.stringify({
    schemaVersion: "smtp-run-state/v1",
    runId: "run-progress",
    status: "running",
    createdAt: "2026-05-31T12:00:00.000Z",
    updatedAt: "2026-05-31T12:01:00.000Z",
    params: {
      brand: "Delivrix",
      requireExistingDomain: false,
      budgetUsdMax: 25,
      testEmailRecipient: "operator@example.test",
      testEmailSubject: "secret subject should not leak",
      testEmailBody: "secret body should not leak",
      seedInboxes: ["seed-a@example.test", "seed-b@example.test", "seed-c@example.test"]
    },
    chosenDomain: "annualrenewalnational.com",
    smtpHost: "smtp.annualrenewalnational.com",
    serverSlug: "server42",
    serverIpv4: "203.0.113.42",
    serverAccountId: "webdock-cuenta-2",
    providerId: "webdock",
    selector: "s2026a",
    budgetSpentUsd: 12.34,
    lastCompletedStep: 0,
    finalEmailMessageId: "<delivrix-final-123@annualrenewalnational.com>",
    finalDeliveryStatus: "queued",
    steps: {
      "1": {
        step: 1,
        skill: "suggest_safe_domain",
        status: "done",
        startedAt: "2026-05-31T12:00:01.000Z",
        completedAt: "2026-05-31T12:00:10.000Z",
        result: {
          step: 1,
          skill: "suggest_safe_domain",
          inputHash: "hash-1",
          outcome: { token: "super-secret-token" },
          durationMs: 10,
          estimatedCostUsd: 12.34
        },
        updatedAt: "2026-05-31T12:00:10.000Z"
      },
      "2": {
        step: 2,
        skill: "register_domain_route53",
        status: "in_flight",
        inputHash: "hash-2",
        leaseUntil: "2026-05-31T12:10:00.000Z",
        lastError: "waiting_for_route53_operation",
        updatedAt: "2026-05-31T12:00:20.000Z"
      },
      "9": {
        step: 9,
        skill: "provision_smtp_postfix",
        status: "done",
        result: {
          step: 9,
          skill: "provision_smtp_postfix",
          inputHash: "hash-9",
          outcome: {
            dkimPublicKey: "PUBLICKEY",
            dkimPrivateKey: "-----BEGIN PRIVATE KEY----- should not leak"
          },
          durationMs: 99
        },
        updatedAt: "2026-05-31T12:01:30.000Z"
      }
    }
  }, null, 2)}\n`);

  const progress = await readSmtpRunProgress({ workspace: ctx.workspace }, "run-progress");

  assert.equal(progress?.runId, "run-progress");
  assert.equal(progress?.status, "running");
  assert.equal(progress?.lastCompletedStep, 1);
  assert.equal(progress?.steps.length, 14);
  assert.deepEqual(progress?.steps[0], {
    step: 1,
    skill: "suggest_safe_domain",
    status: "done",
    label: "Suggest Safe Domain",
    startedAt: "2026-05-31T12:00:01.000Z",
    completedAt: "2026-05-31T12:00:10.000Z",
    durationMs: 10
  });
  assert.deepEqual(progress?.steps[1], {
    step: 2,
    skill: "register_domain_route53",
    status: "in_flight",
    label: "Register Domain Route53",
    error: "waiting_for_route53_operation"
  });
  assert.equal(progress?.steps[8]?.durationMs, 99);
  assert.deepEqual(progress?.identity, {
    brand: "Delivrix",
    domain: "annualrenewalnational.com",
    smtpHost: "smtp.annualrenewalnational.com",
    serverSlug: "server42",
    serverIpv4: "203.0.113.42",
    serverAccountId: "webdock-cuenta-2",
    providerId: "webdock",
    dkimSelector: "s2026a",
    dkimPublicKey: "PUBLICKEY",
    dnsRecords: [
      { name: "smtp.annualrenewalnational.com", type: "A", value: "203.0.113.42" },
      { name: "annualrenewalnational.com", type: "MX", value: "10 smtp.annualrenewalnational.com." },
      { name: "annualrenewalnational.com", type: "TXT", value: "v=spf1 ip4:203.0.113.42 -all" },
      { name: "s2026a._domainkey.annualrenewalnational.com", type: "TXT", value: "v=DKIM1; k=rsa; p=PUBLICKEY" },
      {
        name: "_dmarc.annualrenewalnational.com",
        type: "TXT",
        value: "v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@delivrix.com; ruf=mailto:dmarc-forensics@delivrix.com; fo=1"
      }
    ],
    finalDeliveryStatus: "queued",
    finalEmailMessageId: "delivrix-final-123@annualrenewalnational.com",
    budgetSpentUsd: 12.34
  });
  assert.doesNotMatch(JSON.stringify(progress), /super-secret-token|secret subject|secret body|operator@example\.test|PRIVATE KEY|dkimPrivateKey/);
});

test("readSmtpRunProgress rejects malformed DKIM and unsafe timing metadata", async () => {
  const ctx = createDeps();
  await ctx.workspace.writeWorkspaceFileAtomic("inventory/smtp-runs/run-unsafe-dkim.json", `${JSON.stringify({
    schemaVersion: "smtp-run-state/v1",
    runId: "run-unsafe-dkim",
    status: "running",
    createdAt: "2026-05-31T12:00:00.000Z",
    updatedAt: "2026-05-31T12:01:00.000Z",
    params: {
      brand: "Delivrix",
      requireExistingDomain: false,
      budgetUsdMax: 25,
      testEmailRecipient: "operator@example.test",
      testEmailSubject: "secret subject should not leak",
      testEmailBody: "secret body should not leak",
      seedInboxes: ["seed-a@example.test", "seed-b@example.test", "seed-c@example.test"]
    },
    chosenDomain: "annualrenewalnational.com",
    smtpHost: "smtp.annualrenewalnational.com",
    serverIpv4: "203.0.113.42",
    selector: "s2026a",
    budgetSpentUsd: 0,
    lastCompletedStep: 0,
    finalDeliveryStatus: "queued token=secret",
    finalEmailMessageId: "msg-secret-token",
    steps: {
      "1": {
        step: 1,
        skill: "suggest_safe_domain",
        status: "done",
        startedAt: "not-a-date",
        completedAt: "2026-05-31T12:00:10.000Z\nbad",
        result: {
          step: 1,
          skill: "suggest_safe_domain",
          inputHash: "hash-1",
          outcome: { token: "super-secret-token" },
          durationMs: -1
        },
        updatedAt: "2026-05-31T12:00:10.000Z"
      },
      "2": {
        step: 2,
        skill: "register_domain_route53",
        status: "in_flight",
        inputHash: "hash-2",
        lastError: "Authorization: Bearer secret-token",
        updatedAt: "2026-05-31T12:00:20.000Z"
      },
      "9": {
        step: 9,
        skill: "provision_smtp_postfix",
        status: "done",
        result: {
          step: 9,
          skill: "provision_smtp_postfix",
          inputHash: "hash-9",
          outcome: {
            dkimPublicKey: "v=DKIM1; k=rsa; p=abc\nmalicious"
          },
          durationMs: 7
        },
        updatedAt: "2026-05-31T12:01:30.000Z"
      }
    }
  }, null, 2)}\n`);

  const progress = await readSmtpRunProgress({ workspace: ctx.workspace }, "run-unsafe-dkim");

  assert.deepEqual(progress?.steps[0], {
    step: 1,
    skill: "suggest_safe_domain",
    status: "done",
    label: "Suggest Safe Domain"
  });
  assert.equal(progress?.steps[1]?.error, "step_error");
  assert.equal(progress?.identity?.dkimPublicKey, undefined);
  assert.equal(progress?.identity?.finalDeliveryStatus, undefined);
  assert.equal(progress?.identity?.finalEmailMessageId, undefined);
  assert.equal(progress?.identity?.dnsRecords?.some((record) => record.name === "s2026a._domainkey.annualrenewalnational.com"), false);
  assert.doesNotMatch(JSON.stringify(progress), /malicious|super-secret-token|secret-token|Authorization|Bearer/);
});

test("configureCompleteSmtp does not proceed after step 2 execution failure", async () => {
  const ctx = createDeps({
    decisions: {
      2: { status: "execution_failed", proposalId: "p-2", outcome: { error: "purchase_failed" }, durationMs: 7 }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 2);
  assert.equal(ctx.approvals.length, 1);
});

test("configureCompleteSmtp emits rollback proposal when identity bind fails after DNS forward", async () => {
  const ctx = createDeps({
    decisions: {
      8: { status: "execution_failed", proposalId: "p-8", outcome: { error: "bind_failed" }, durationMs: 9 }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 8);
  assert.equal(ctx.rollbacks.length, 1);
  assert.equal(ctx.rollbacks[0].skill, "delete_webdock_server");
  assert.equal(ctx.rollbacks[0].params.serverSlug, "srv-delivrix");
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.serverCreatedByRun, true);
});

test("configureCompleteSmtp maps operator rejection during A propagation wait to cancelled_by_operator", async () => {
  const ctx = createDeps({
    decisions: {
      7: { status: "rejected", proposalId: "p-7", reason: "operator stopped DNS wait" }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "cancelled_by_operator");
  assert.equal(result.failedStep, 7);
  assert.equal(result.error, "operator stopped DNS wait");
});

test("configureCompleteSmtp maps step 3 propagation timeout to failed", async () => {
  const ctx = createDeps({
    decisions: {
      3: { status: "approval_timeout", proposalId: "p-3", timeoutMs: 10 }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 3);
  assert.equal(result.error, "approval_timeout");
});

test("handleConfigureCompleteSmtp blocks when kill switch is armed", async () => {
  const ctx = createDeps({ killSwitchEnabled: true });
  const { request, response, getResponse } = createInternalHttpAdapter({ body: validInput() });
  await handleConfigureCompleteSmtp({ request, response, ...ctx.deps });

  const captured = getResponse();
  assert.equal(captured.statusCode, 423);
  assert.deepEqual(captured.body, { error: "kill_switch_armed" });
  assert.equal(ctx.approvals.length, 0);
});

test("configureCompleteSmtp verifies audit chain before proceeding", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(ctx.verifyCount >= 14, true);
});

test("configureCompleteSmtp fails closed on broken audit chain before side effects", async () => {
  const ctx = createDeps({ auditOk: false });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.error, "audit_chain_broken");
  assert.equal(ctx.approvals.length, 0);
});

test("handleConfigureCompleteSmtp rejects budget below minimum estimate", async () => {
  const ctx = createDeps();
  const { request, response, getResponse } = createInternalHttpAdapter({
    body: { ...validInput(), budgetUsdMax: 10 }
  });
  await handleConfigureCompleteSmtp({ request, response, ...ctx.deps });

  const captured = getResponse();
  assert.equal(captured.statusCode, 422);
  assert.equal((captured.body as { error: string }).error, "budget_too_low");
});

test("handleConfigureCompleteSmtp rejects invalid payload", async () => {
  const ctx = createDeps();
  const { request, response, getResponse } = createInternalHttpAdapter({
    body: { ...validInput(), testEmailRecipient: "not-email" }
  });
  await handleConfigureCompleteSmtp({ request, response, ...ctx.deps });

  const captured = getResponse();
  assert.equal(captured.statusCode, 400);
  assert.equal((captured.body as { error: string }).error, "invalid_params");
});

test("configureCompleteSmtp fails when no domain candidates are returned", async () => {
  const ctx = createDeps({ suggestions: { candidates: [] } });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 1);
  assert.equal(result.error, "no_domain_candidate");
});

test("create_webdock_server uses canonical smtp host as hostname", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step4 = ctx.approvals.find((entry) => entry.step === 4);
  assert.equal(step4?.params.hostname, "smtp.delivrixops.com");
});

test("route53 DNS step writes canonical smtp A and MX records", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step6 = ctx.approvals.find((entry) => entry.step === 6);
  assert.deepEqual(step6?.params.records, [
    { name: "smtp.delivrixops.com", type: "A", ttl: 300, values: ["203.0.113.10"] },
    { name: "delivrixops.com", type: "MX", ttl: 300, values: ["10 smtp.delivrixops.com."] }
  ]);
});

test("DNS A propagation waits on canonical smtp host", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step7 = ctx.approvals.find((entry) => entry.step === 7);
  assert.equal(step7?.params.domain, "smtp.delivrixops.com");
  assert.deepEqual(step7?.params.expectedRecord, { type: "A", value: "203.0.113.10" });
});

test("Webdock identity bind runs after DNS A propagation", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step8 = ctx.approvals.find((entry) => entry.step === 8);
  assert.equal(step8?.skill, "bind_webdock_main_domain");
  assert.deepEqual(step8?.params, { serverSlug: "srv-delivrix", domain: "delivrixops.com" });
  assert.equal(step8?.serverAccountId, undefined);
});

test("SMTP provisioning includes server, domain, IP and DKIM selector", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step9 = ctx.approvals.find((entry) => entry.step === 9);
  assert.deepEqual(step9?.params, {
    serverSlug: "srv-delivrix",
    domain: "delivrixops.com",
    serverIp: "203.0.113.10",
    selector: "s2026a"
  });
});

test("email auth step uses quarantine DMARC and selector", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step10 = ctx.approvals.find((entry) => entry.step === 10);
  assert.equal(step10?.params.dmarcPolicy, "quarantine");
  assert.equal(step10?.params.selector, "s2026a");
  assert.equal(step10?.params.mxServerIp, "203.0.113.10");
});

test("DKIM propagation waits on selector._domainkey as TXT", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step11 = ctx.approvals.find((entry) => entry.step === 11);
  assert.equal(step11?.skill, "wait_for_dns_propagation");
  assert.equal(step11?.params.domain, "s2026a._domainkey.delivrixops.com");
  assert.deepEqual(step11?.params.expectedRecord, { type: "TXT", value: "contains:v=DKIM1" });
});

test("final send step preserves operator subject and body", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step14 = ctx.approvals.find((entry) => entry.step === 14);
  assert.equal(step14?.params.fromAddress, "hello@delivrixops.com");
  assert.equal(step14?.params.toAddress, validInput().testEmailRecipient);
  assert.equal(step14?.params.subject, validInput().testEmailSubject);
  assert.equal(step14?.params.body, validInput().testEmailBody);
});

test("configureCompleteSmtp reports estimated domain and prorated VPS cost", async () => {
  const ctx = createDeps();
  const result = await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(result.totalCostUsd, 15.14);
});

test("configureCompleteSmtp aborts a costly step before it exceeds budget", async () => {
  const ctx = createDeps();
  const result = await configureCompleteSmtp({ ...validInput(), budgetUsdMax: 15 }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 4);
  assert.equal(result.error?.startsWith("budget_exceeded"), true);
  assert.deepEqual(ctx.approvals.map((entry) => entry.step), [2, 3]);
  assert.equal(result.totalCostUsd, 15);
});

test("configureCompleteSmtp keeps create_webdock_server params byte-identical when creation governor is below cap", async () => {
  const ctx = createDeps({
    creationServers: [
      { creationDate: "2026-05-31T11:00:00.000Z" },
      { creationDate: "2026-05-31T10:00:00.000Z" }
    ]
  });
  await configureCompleteSmtp(validInput(), ctx.deps);

  const step4 = ctx.approvals.find((entry) => entry.step === 4);
  assert.deepEqual(step4?.params, {
    runId: "run-1",
    profile: "bit",
    locationId: "dk",
    hostname: "smtp.delivrixops.com",
    imageSlug: "ubuntu-2404"
  });
  assert.deepEqual(ctx.creationReads, ["ops"]);
});

test("configureCompleteSmtp can disable creation governor without changing create params", async () => {
  const ctx = createDeps({
    env: { CREATION_RATE_GOVERNOR_ENABLE: "false" },
    creationReadError: new Error("reader should not run when governor is disabled"),
    creationServers: [
      { creationDate: "2026-05-31T11:00:00.000Z" },
      { creationDate: "2026-05-31T10:00:00.000Z" },
      { creationDate: "2026-05-31T09:00:00.000Z" },
      { creationDate: "2026-05-31T08:00:00.000Z" }
    ]
  });
  await configureCompleteSmtp(validInput(), ctx.deps);

  const step4 = ctx.approvals.find((entry) => entry.step === 4);
  assert.equal(step4?.skill, "create_webdock_server");
  assert.deepEqual(step4?.params, {
    runId: "run-1",
    profile: "bit",
    locationId: "dk",
    hostname: "smtp.delivrixops.com",
    imageSlug: "ubuntu-2404"
  });
  assert.deepEqual(ctx.creationReads, []);
});

test("configureCompleteSmtp blocks create when Webdock account reaches creation cap", async () => {
  const ctx = createDeps({
    creationServers: [
      { creationDate: "2026-05-31T11:00:00.000Z" },
      { creationDate: "2026-05-31T10:00:00.000Z" },
      { creationDate: "2026-05-31T09:00:00.000Z" },
      { creationDate: "2026-05-31T08:00:00.000Z" }
    ]
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 4);
  assert.equal(result.error, "creation_rate_exceeded: created_24h=4 cap=4 account=ops");
  assert.deepEqual(ctx.approvals.map((entry) => entry.step), [2, 3]);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.creation_rate_exceeded"), true);
  const canvasBlock = ctx.canvasEvents.find((event) => event.action === "oc.orchestrator.creation_rate_exceeded");
  assert.deepEqual(canvasBlock?.metadata, {
    runId: "run-1",
    step: 4,
    skill: "create_webdock_server",
    accountId: "ops",
    createdInWindow: 4,
    cap: 4,
    window: "rolling_24h",
    reason: "creation_rate_exceeded"
  });
  assert.equal(ctx.canvasEvents.some((event) => event.action === "oc.orchestrator.step_failed"), true);
});

test("configureCompleteSmtp fails open with noisy audit when creation inventory read fails", async () => {
  const ctx = createDeps({ creationReadError: new Error("webdock timeout") });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.approvals.some((entry) => entry.step === 4), true);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.creation_rate_read_failed"), true);
  assert.equal(ctx.logs.some((entry) => entry.event === "openclaw.orchestrator.creation_rate_read_failed"), true);
});

test("configureCompleteSmtp treats mock Webdock inventory as a read failure instead of source of truth", async () => {
  const ctx = createDeps({
    creationSourceKind: "mock",
    creationResponseOk: false,
    creationServers: [
      { creationDate: "2026-05-31T11:00:00.000Z" },
      { creationDate: "2026-05-31T10:00:00.000Z" },
      { creationDate: "2026-05-31T09:00:00.000Z" },
      { creationDate: "2026-05-31T08:00:00.000Z" }
    ]
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.approvals.some((entry) => entry.step === 4), true);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.creation_rate_read_failed"), true);
});

test("configureCompleteSmtp can fail closed when creation inventory read fails", async () => {
  const ctx = createDeps({
    env: { CREATION_RATE_GOVERNOR_FAIL_MODE: "fail_closed" },
    creationReadError: new Error("webdock timeout")
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 4);
  assert.match(result.error ?? "", /^creation_rate_read_failed: mode=fail_closed/);
  assert.deepEqual(ctx.approvals.map((entry) => entry.step), [2, 3]);
});

test("configureCompleteSmtp accepts explicit creation-rate override with audit", async () => {
  const ctx = createDeps({
    creationServers: [
      { creationDate: "2026-05-31T11:00:00.000Z" },
      { creationDate: "2026-05-31T10:00:00.000Z" },
      { creationDate: "2026-05-31T09:00:00.000Z" },
      { creationDate: "2026-05-31T08:00:00.000Z" }
    ],
    creationOverride: { approved: true, signatureId: "sig-override-1", actorId: "op-1", reason: "human-approved-cap-override" }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.approvals.some((entry) => entry.step === 4), true);
  assert.equal(ctx.creationOverrides.length, 1);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.creation_rate_override"), true);
});

test("DoD#1 regresion single-account byte-identico: serverAccountId=ops, step4 params/hash sin accountId, creationReads=[ops], rollback contra ops", async () => {
  // Run firmado (camino autonomo = el write-path multicuenta real) con SOLO la cuenta-1 configurada.
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    decisions: {} // forzamos fallo del bind (step 8) para ejercitar el rollback
  });
  ctx.deps.executePlanApprovedStep = (() => {
    const original = ctx.deps.executePlanApprovedStep!;
    return async (input: PlanApprovedStepInput) => {
      if (input.step === 8) {
        ctx.planExecutions.push(input);
        return { status: "execution_failed", planStepTokenId: "plan-step-8", outcome: { error: "bind_failed" }, durationMs: 8, error: "bind_failed" };
      }
      return original(input);
    };
  })();

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 8);
  // Sin multicuenta: el selector consulta SOLO "ops" (1 lectura), y NO se pidio la lista de cuentas.
  assert.deepEqual(ctx.creationReads, ["ops"]);
  assert.equal(ctx.creationAccountReads, 0);
  // El step 4 viaja con serverAccountId="ops" por canal paralelo, y SUS params NO contienen accountId.
  const step4 = ctx.planExecutions.find((entry) => entry.step === 4)!;
  assert.equal(step4.serverAccountId, "ops");
  assert.deepEqual(step4.params, {
    runId: "run-1",
    profile: "bit",
    locationId: "dk",
    hostname: "smtp.delivrixops.com",
    imageSlug: "ubuntu-2404"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(step4.params, "accountId"), false);
  // El inputHash del step 4 es el de un params SIN accountId (idempotencia/resume intactos).
  const expectedStep4Hash = createHash("sha256").update(stableStringify({
    runId: "run-1", profile: "bit", locationId: "dk", hostname: "smtp.delivrixops.com", imageSlug: "ubuntu-2404"
  })).digest("hex");
  assert.equal(step4.inputHash, expectedStep4Hash);
  // El bind default sigue sin canal accountId: el dispatcher cae a deps.webdockAdapter (ops).
  const step8 = ctx.planExecutions.find((entry) => entry.step === 8)!;
  assert.equal(step8.serverAccountId, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(step8.params, "accountId"), false);
  // runState persiste serverAccountId="ops"; el rollback/delete enruta a "ops".
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.serverAccountId, "ops");
  assert.equal(state.serverCreatedByRun, true);
  assert.equal(ctx.rollbacks.length, 1);
  assert.equal(ctx.rollbacks[0].serverAccountId, "ops");
});

test("DoD#2 multicuenta selecciona la cuenta con budget y propaga su accountId al create + rollback", async () => {
  // ops en cap (4/4), secondary con budget (1/4) => el selector elige "secondary".
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { servers: fourServers(), sourceKind: "live", responseOk: true },
      secondary: { servers: [{ creationDate: "2026-05-31T11:00:00.000Z" }], sourceKind: "live", responseOk: true }
    }
  });
  // Forzamos fallo del bind para ejercitar tambien el rollback hacia la cuenta ganadora.
  ctx.deps.executePlanApprovedStep = (() => {
    const original = ctx.deps.executePlanApprovedStep!;
    return async (input: PlanApprovedStepInput) => {
      if (input.step === 8) {
        ctx.planExecutions.push(input);
        return { status: "execution_failed", planStepTokenId: "plan-step-8", outcome: { error: "bind_failed" }, durationMs: 8, error: "bind_failed" };
      }
      return original(input);
    };
  })();

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 8);
  // Consulto la lista de cuentas y leyo el inventario de AMBAS.
  assert.equal(ctx.creationAccountReads, 1);
  assert.deepEqual([...ctx.creationReads].sort(), ["ops", "secondary"]);
  // El create (step 4) va dirigido a "secondary"; el params sigue SIN accountId.
  const step4 = ctx.planExecutions.find((entry) => entry.step === 4)!;
  assert.equal(step4.serverAccountId, "secondary");
  assert.equal(Object.prototype.hasOwnProperty.call(step4.params, "accountId"), false);
  // runState persiste la cuenta ganadora; el rollback/delete enruta a "secondary" (no a ops).
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.serverAccountId, "secondary");
  assert.equal(state.serverCreatedByRun, true);
  assert.equal(ctx.rollbacks[0].serverAccountId, "secondary");
});

test("cuenta explicita elegible aterriza exactamente ahi y no entra a params/hashInput", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ serverAccountId: "secondary" }),
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { servers: fourServers(), sourceKind: "live", responseOk: true },
      secondary: { servers: [], sourceKind: "live", responseOk: true }
    }
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    serverAccountId: "Secondary"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.creationAccountReads, 2);
  assert.deepEqual(ctx.creationReads, ["secondary", "secondary"]);
  const step4 = ctx.planExecutions.find((entry) => entry.step === 4)!;
  assert.equal(step4.serverAccountId, "secondary");
  assert.equal(Object.prototype.hasOwnProperty.call(step4.params, "accountId"), false);
  const step8 = ctx.planExecutions.find((entry) => entry.step === 8)!;
  assert.equal(step8.serverAccountId, "secondary");
  assert.deepEqual(step8.params, { serverSlug: "srv-delivrix", domain: "delivrixops.com" });
  assert.equal(Object.prototype.hasOwnProperty.call(step8.params, "accountId"), false);
  const expectedStep4Hash = createHash("sha256").update(stableStringify({
    runId: "run-1", profile: "bit", locationId: "dk", hostname: "smtp.delivrixops.com", imageSlug: "ubuntu-2404"
  })).digest("hex");
  assert.equal(step4.inputHash, expectedStep4Hash);
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.serverAccountId, "secondary");
  assert.equal(ctx.auditEvents.some((event) =>
    event.action === "oc.orchestrator.creation_account_chosen"
    && (event.metadata as { selectedAccountId?: string; requestedAccountId?: string } | undefined)?.selectedAccountId === "secondary"
    && (event.metadata as { selectedAccountId?: string; requestedAccountId?: string } | undefined)?.requestedAccountId === "secondary"
  ), true);
});

test("cuenta explicita sana pero en cap falla en step 0 antes de gastar dominio", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ serverAccountId: "secondary" }),
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { servers: [], sourceKind: "live", responseOk: true },
      secondary: { servers: fourServers(), sourceKind: "live", responseOk: true }
    }
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    serverAccountId: "secondary"
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 0);
  assert.match(result.error ?? "", /requested_account_ineligible: account=secondary reason=rate_exceeded/);
  assert.equal(ctx.creationAccountReads, 1);
  assert.deepEqual(ctx.creationReads, ["secondary"]);
  assert.equal(ctx.planExecutions.some((entry) => entry.step === 2 || entry.skill === "register_domain_route53"), false);
  assert.deepEqual(ctx.approvals, []);
  assert.deepEqual(ctx.route53RegistrationWaits, []);
  assert.equal(ctx.rollbacks.length, 0);
  assert.equal(ctx.auditEvents.some((event) =>
    event.action === "oc.orchestrator.creation_account_rejected"
    && (event.metadata as { requestedAccountId?: string; reason?: string; createdInWindow?: number } | undefined)?.requestedAccountId === "secondary"
    && (event.metadata as { requestedAccountId?: string; reason?: string; createdInWindow?: number } | undefined)?.reason === "rate_exceeded"
    && (event.metadata as { requestedAccountId?: string; reason?: string; createdInWindow?: number } | undefined)?.createdInWindow === 4
  ), true);
});

test("cuenta explicita con budget live unverificable reintenta y falla sin gastar dominio", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ serverAccountId: "secondary" }),
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      secondary: {
        servers: [],
        sourceKind: "live",
        responseOk: true,
        readErrors: [new Error("429"), new Error("timeout")]
      }
    }
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    serverAccountId: "secondary"
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 0);
  assert.match(result.error ?? "", /requested_account_budget_unverifiable: account=secondary/);
  assert.equal(ctx.creationAccountReads, 1);
  assert.deepEqual(ctx.creationReads, ["secondary", "secondary"]);
  assert.equal(ctx.planExecutions.some((entry) => entry.step === 2 || entry.skill === "register_domain_route53"), false);
  assert.deepEqual(ctx.approvals, []);
  assert.deepEqual(ctx.route53RegistrationWaits, []);
  assert.equal(ctx.rollbacks.length, 0);
  assert.equal(ctx.auditEvents.some((event) =>
    event.action === "oc.orchestrator.creation_account_rejected"
    && (event.metadata as { requestedAccountId?: string; reason?: string; readErrorMessage?: string } | undefined)?.requestedAccountId === "secondary"
    && (event.metadata as { requestedAccountId?: string; reason?: string; readErrorMessage?: string } | undefined)?.reason === "budget_unverifiable"
    && (event.metadata as { requestedAccountId?: string; reason?: string; readErrorMessage?: string } | undefined)?.readErrorMessage === "timeout"
  ), true);
});

test("cuenta explicita desconocida falla claro antes de gastar y sin fallback a ops", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ serverAccountId: "quaternary" }),
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { servers: [], sourceKind: "live", responseOk: true },
      secondary: { servers: [], sourceKind: "live", responseOk: true }
    }
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    serverAccountId: "quaternary"
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 0);
  assert.match(result.error ?? "", /requested_account_ineligible: account=quaternary reason=unknown/);
  assert.equal(ctx.creationAccountReads, 1);
  assert.deepEqual(ctx.creationReads, []);
  assert.deepEqual(ctx.planExecutions, []);
  assert.deepEqual(ctx.approvals, []);
  assert.equal(ctx.rollbacks.length, 0);
  assert.equal(ctx.auditEvents.some((event) =>
    event.action === "oc.orchestrator.creation_account_rejected"
    && (event.metadata as { requestedAccountId?: string; reason?: string } | undefined)?.requestedAccountId === "quaternary"
    && (event.metadata as { requestedAccountId?: string; reason?: string } | undefined)?.reason === "unknown"
  ), true);
});

test("failover de pago: si una cuenta rechaza el pago en step 4, el orquestador crea en la siguiente solo", async () => {
  // ops y secondary con budget; el governor elige "ops" por tie-break. ops rechaza el PAGO -> el
  // orquestador excluye ops y reintenta en secondary, sin intervencion humana.
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { servers: [], sourceKind: "live", responseOk: true },
      secondary: { servers: [], sourceKind: "live", responseOk: true }
    }
  });
  // El create en "ops" rechaza el pago (webdock_payment_failed); en "secondary" procede normal.
  ctx.deps.executePlanApprovedStep = (() => {
    const original = ctx.deps.executePlanApprovedStep!;
    return async (input: PlanApprovedStepInput) => {
      if (input.step === 4 && input.serverAccountId === "ops") {
        ctx.planExecutions.push(input);
        return {
          status: "execution_failed",
          planStepTokenId: "plan-step-4-ops",
          outcome: { error: "Payment failed during server creation", failureCode: "webdock_payment_failed" },
          durationMs: 4,
          error: "webdock_payment_failed"
        };
      }
      return original(input);
    };
  })();

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);

  // El run COMPLETA: el failover creo el VPS en secondary tras el rechazo de pago de ops.
  assert.equal(result.status, "completed");
  // Hubo 2 intentos del step 4: primero ops (rechazo de pago), luego secondary (exito).
  const step4Attempts = ctx.planExecutions.filter((entry) => entry.step === 4);
  assert.equal(step4Attempts.length, 2);
  assert.equal(step4Attempts[0].serverAccountId, "ops");
  assert.equal(step4Attempts[1].serverAccountId, "secondary");
  // runState persiste la cuenta GANADORA (secondary), no la que rechazo el pago.
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.serverAccountId, "secondary");
});

test("failover de pago: si TODAS las cuentas rechazan el pago, el run falla limpio sin loop infinito", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { servers: [], sourceKind: "live", responseOk: true },
      secondary: { servers: [], sourceKind: "live", responseOk: true }
    }
  });
  // Ambas cuentas rechazan el pago en el step 4.
  ctx.deps.executePlanApprovedStep = (() => {
    const original = ctx.deps.executePlanApprovedStep!;
    return async (input: PlanApprovedStepInput) => {
      if (input.step === 4) {
        ctx.planExecutions.push(input);
        return {
          status: "execution_failed",
          planStepTokenId: `plan-step-4-${input.serverAccountId}`,
          outcome: { error: "Payment failed during server creation", failureCode: "webdock_payment_failed" },
          durationMs: 4,
          error: "webdock_payment_failed"
        };
      }
      return original(input);
    };
  })();

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);

  // Run falla (ninguna cuenta pudo crear), SIN loop infinito: probo AMBAS cuentas una vez y paro.
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 4);
  const step4Attempts = ctx.planExecutions.filter((entry) => entry.step === 4);
  assert.equal(step4Attempts.length, 2);
  assert.deepEqual([...new Set(step4Attempts.map((entry) => entry.serverAccountId))].sort(), ["ops", "secondary"]);
});

test("rollback guard: un runState viejo sin serverCreatedByRun NO propone borrar el VPS", async () => {
  // Sembramos un runState legacy (sin serverAccountId) con el step 4 ya hecho, server creado, y
  // forzamos que el bind (step 8) falle al reanudar -> no sabemos si el run creo el VPS, asi que
  // se evita proponer un delete destructivo por defecto.
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval()
  });
  ctx.deps.executePlanApprovedStep = (() => {
    const original = ctx.deps.executePlanApprovedStep!;
    return async (input: PlanApprovedStepInput) => {
      if (input.step === 8) {
        ctx.planExecutions.push(input);
        return { status: "execution_failed", planStepTokenId: "plan-step-8", outcome: { error: "bind_failed" }, durationMs: 8, error: "bind_failed" };
      }
      return original(input);
    };
  })();
  await seedLegacyRunStateThroughStep4(ctx.workspace, "run-1");

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 8);
  assert.equal(ctx.rollbacks.length, 0);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.rollback_delete_skipped_reused_server"), true);
  const skipEvent = ctx.auditEvents.find((event) => event.action === "oc.orchestrator.rollback_delete_skipped_reused_server");
  assert.ok(skipEvent);
  assert.equal((skipEvent.metadata as Record<string, unknown>).reason, "server_created_by_run_unknown");
  assert.equal(ctx.creationAccountReads, 0, "no re-selecciona cuenta en un resume con step 4 ya hecho");
});

test("rollback guard: runState legacy con serverCreatedByRun=true conserva propuesta de delete", async () => {
  // Resume de un run anterior a serverAccountId pero posterior al flag de ownership: si el run sabe
  // que creo el VPS, el rollback delete sigue permitido y cae al accountId legacy "ops".
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval()
  });
  ctx.deps.executePlanApprovedStep = (() => {
    const original = ctx.deps.executePlanApprovedStep!;
    return async (input: PlanApprovedStepInput) => {
      if (input.step === 8) {
        ctx.planExecutions.push(input);
        return { status: "execution_failed", planStepTokenId: "plan-step-8", outcome: { error: "bind_failed" }, durationMs: 8, error: "bind_failed" };
      }
      return original(input);
    };
  })();
  await seedLegacyRunStateThroughStep4(ctx.workspace, "run-1", { serverCreatedByRun: true });

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 8);
  assert.equal(ctx.rollbacks.length, 1);
  assert.equal(ctx.rollbacks[0].skill, "delete_webdock_server");
  assert.equal(ctx.rollbacks[0].serverAccountId, "ops");
  assert.deepEqual(ctx.rollbacks[0].params, { serverSlug: "srv-delivrix", domain: "delivrixops.com" });
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.rollback_delete_skipped_reused_server"), false);
});

test("rollback guard: adopted idempotent server does not get a delete proposal after later failure", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    outcomes: {
      4: { status: "idempotent_already_exists", serverSlug: "srv-delivrix", slug: "srv-delivrix", ipv4: "203.0.113.10", costUsd: 0 }
    }
  });
  ctx.deps.executePlanApprovedStep = (() => {
    const original = ctx.deps.executePlanApprovedStep!;
    return async (input: PlanApprovedStepInput) => {
      if (input.step === 8) {
        ctx.planExecutions.push(input);
        return { status: "execution_failed", planStepTokenId: "plan-step-8", outcome: { error: "bind_failed" }, durationMs: 8, error: "bind_failed" };
      }
      return original(input);
    };
  })();

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);
  const state = await readRunStateFull(ctx.workspace, "run-1");

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 8);
  assert.equal(state.serverCreatedByRun, false);
  assert.equal(ctx.rollbacks.length, 0);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.rollback_delete_skipped_reused_server"), true);
});

for (const reusedStatus of ["adopted", "reused"]) {
  test(`rollback guard: ${reusedStatus} server status does not get a delete proposal after later failure`, async () => {
    const ctx = createDeps({
      env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
      planApproval: signedPlanApproval(),
      outcomes: {
        4: { status: reusedStatus, serverSlug: "srv-delivrix", slug: "srv-delivrix", ipv4: "203.0.113.10", costUsd: 0 }
      }
    });
    ctx.deps.executePlanApprovedStep = (() => {
      const original = ctx.deps.executePlanApprovedStep!;
      return async (input: PlanApprovedStepInput) => {
        if (input.step === 8) {
          ctx.planExecutions.push(input);
          return { status: "execution_failed", planStepTokenId: "plan-step-8", outcome: { error: "bind_failed" }, durationMs: 8, error: "bind_failed" };
        }
        return original(input);
      };
    })();

    const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);
    const state = await readRunStateFull(ctx.workspace, "run-1");

    assert.equal(result.status, "failed");
    assert.equal(result.failedStep, 8);
    assert.equal(state.serverCreatedByRun, false);
    assert.equal(ctx.rollbacks.length, 0);
    assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.rollback_delete_skipped_reused_server"), true);
  });
}

test("DoD#6 todas las cuentas no-live => preserva fail-open (no no_eligible_accounts silencioso)", async () => {
  const ctx = createDeps({
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { readError: new Error("ops webdock timeout") },
      secondary: { sourceKind: "mock", responseOk: false, servers: fourServers() }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  // fail-open por defecto: el run completa y emite el audit ruidoso de read_failed (no se traga el error).
  assert.equal(result.status, "completed");
  assert.equal(ctx.approvals.some((entry) => entry.step === 4), true);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.creation_rate_read_failed"), true);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.creation_rate_exceeded"), false);
});

test("DoD#6 todas las cuentas no-live + fail_closed => bloquea el create (no no_eligible_accounts silencioso)", async () => {
  const ctx = createDeps({
    env: { CREATION_RATE_GOVERNOR_FAIL_MODE: "fail_closed" },
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { readError: new Error("ops webdock timeout") },
      secondary: { readError: new Error("secondary webdock timeout") }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 4);
  assert.match(result.error ?? "", /^creation_rate_read_failed: mode=fail_closed/);
  assert.deepEqual(ctx.approvals.map((entry) => entry.step), [2, 3]);
});

test("FIX1 gated + cuenta != ops => falla LIMPIO gated_multiaccount_unsupported ANTES de crear (no VPS huerfano)", async () => {
  // Camino GATED (sin OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE): ops en cap (4/4), secondary con
  // budget (1/4) => el selector (que corre incondicionalmente) elige "secondary". Pero el create
  // gated es single-account (su processor no recibe el accountId): crearia el VPS en "ops" y
  // enrutaria rollback a "secondary" => huerfano. El guard debe abortar limpio ANTES del create.
  const ctx = createDeps({
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { servers: fourServers(), sourceKind: "live", responseOk: true },
      secondary: { servers: [{ creationDate: "2026-05-31T11:00:00.000Z" }], sourceKind: "live", responseOk: true }
    }
  });

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 4);
  assert.equal(result.error, "gated_multiaccount_unsupported");
  // El selector eligio secondary y lo persistio, PERO el create gated nunca se ejecuto (no llego a
  // submitAndAwaitApproval para el step 4) => no se creo VPS.
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.serverAccountId, "secondary");
  assert.equal(ctx.approvals.some((entry) => entry.step === 4), false);
  assert.deepEqual(ctx.approvals.map((entry) => entry.step), [2, 3]);
  // step 4 < 6 => no hay rollback (no hay nada que borrar): no VPS huerfano.
  assert.equal(ctx.rollbacks.length, 0);
});

test("FIX1 gated + ops (single-account) NO dispara el guard: el create gated procede normal", async () => {
  // Mismo camino gated pero con SOLO "ops" elegible (con budget). ops===ops no dispara el guard:
  // el step 4 llega a submitAndAwaitApproval y el run completa (comportamiento single-account de hoy).
  const ctx = createDeps({
    creationServers: [
      { creationDate: "2026-05-31T11:00:00.000Z" },
      { creationDate: "2026-05-31T10:00:00.000Z" }
    ]
  });

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);

  assert.equal(result.status, "completed");
  // El create gated (step 4) SI se ejecuto via approval, contra "ops" por el canal paralelo.
  const step4 = ctx.approvals.find((entry) => entry.step === 4);
  assert.equal(step4?.skill, "create_webdock_server");
  assert.equal(step4?.serverAccountId, "ops");
  assert.deepEqual(ctx.creationReads, ["ops"]);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.run_completed"), true);
});

test("PROVIDER#a Webdock-unchanged: vpsProviderId ausente => step4 params SIN providerId NI provider, inputHash byte-identico", async () => {
  // Run firmado (camino autonomo) sin vpsProviderId: el providerId NO debe tocar params/hashInput.
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval()
  });
  await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53" }, ctx.deps);

  const step4 = ctx.planExecutions.find((entry) => entry.step === 4)!;
  // El canal paralelo NO viaja: providerId ausente => no se spreadea al executePlanApprovedStep.
  assert.equal(step4.providerId, undefined);
  assert.deepEqual(step4.params, {
    runId: "run-1",
    profile: "bit",
    locationId: "dk",
    hostname: "smtp.delivrixops.com",
    imageSlug: "ubuntu-2404"
  });
  // Los params del step 4 NO contienen NI providerId NI provider (el `provider` es el registrar DNS).
  assert.equal(Object.prototype.hasOwnProperty.call(step4.params, "providerId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(step4.params, "provider"), false);
  // inputHash byte-identico al de un params SIN providerId (idempotencia/resume/plan-signature intactos).
  const expectedStep4Hash = createHash("sha256").update(stableStringify({
    runId: "run-1", profile: "bit", locationId: "dk", hostname: "smtp.delivrixops.com", imageSlug: "ubuntu-2404"
  })).digest("hex");
  assert.equal(step4.inputHash, expectedStep4Hash);
  // runState NO persiste providerId (canal apagado => Webdock).
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.providerId, undefined);
});

test("PROVIDER#a2 Webdock-unchanged: vpsProviderId='webdock' se trata como ausente (params/hash sin cambios)", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval()
  });
  await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53", vpsProviderId: "webdock" }, ctx.deps);

  const step4 = ctx.planExecutions.find((entry) => entry.step === 4)!;
  // "webdock" normaliza a undefined: el canal paralelo NO viaja, params byte-identicos.
  assert.equal(step4.providerId, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(step4.params, "providerId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(step4.params, "provider"), false);
  const expectedStep4Hash = createHash("sha256").update(stableStringify({
    runId: "run-1", profile: "bit", locationId: "dk", hostname: "smtp.delivrixops.com", imageSlug: "ubuntu-2404"
  })).digest("hex");
  assert.equal(step4.inputHash, expectedStep4Hash);
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.providerId, undefined);
});

test("PROVIDER#guard unknown vpsProviderId falla antes de pasos mutantes", async () => {
  const ctx = createDeps();

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    vpsProviderId: "contaboo"
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 0);
  assert.equal(result.error, "unknown_vps_provider:contaboo");
  assert.deepEqual(result.stepResults, []);
  assert.deepEqual(ctx.approvals, []);
  assert.deepEqual(ctx.planExecutions, []);
  assert.equal(ctx.rollbacks.length, 0);
});

test("PROVIDER#d plan-signed con vpsProviderId='contabo' sella el provider y el create viaja por canal paralelo", async () => {
  const plan = signedPlanApproval({ vpsProviderId: "contabo" });
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: plan
  });
  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53", vpsProviderId: "contabo" }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(plan.scope.vpsProviderId, "contabo");
  const step4 = ctx.planExecutions.find((entry) => entry.step === 4)!;
  // El create (step 4) viaja con providerId="contabo" por canal paralelo; SUS params siguen byte-identicos.
  assert.equal(step4.providerId, "contabo");
  assert.deepEqual(step4.params, {
    runId: "run-1",
    profile: "bit",
    locationId: "dk",
    hostname: "smtp.delivrixops.com",
    imageSlug: "ubuntu-2404"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(step4.params, "providerId"), false);
  // El inputHash del step 4 es el de un params SIN providerId (idempotencia intacta).
  const expectedStep4Hash = createHash("sha256").update(stableStringify({
    runId: "run-1", profile: "bit", locationId: "dk", hostname: "smtp.delivrixops.com", imageSlug: "ubuntu-2404"
  })).digest("hex");
  assert.equal(step4.inputHash, expectedStep4Hash);
  // runState persiste providerId="contabo" (para que un resume firmado retome el proveedor en rollback).
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.providerId, "contabo");
});

test("PROVIDER#d2 Contabo: step 4 puede devolver slug sin IP y step 5 resuelve la IP para DNS", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ vpsProviderId: "contabo" }),
    outcomes: {
      4: { serverSlug: "contabo-203386827", ipv4: null, status: "provisioning" },
      5: { serverSlug: "contabo-203386827", ipv4: "203.0.113.77", status: "running" }
    }
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    vpsProviderId: "contabo"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  const step4 = ctx.planExecutions.find((entry) => entry.step === 4)!;
  assert.equal(step4.providerId, "contabo");
  assert.equal(Object.prototype.hasOwnProperty.call(step4.params, "providerId"), false);
  const expectedStep4Hash = createHash("sha256").update(stableStringify({
    runId: "run-1", profile: "bit", locationId: "dk", hostname: "smtp.delivrixops.com", imageSlug: "ubuntu-2404"
  })).digest("hex");
  assert.equal(step4.inputHash, expectedStep4Hash);

  const step5 = ctx.invocations.find((entry) => entry.step === 5)!;
  assert.equal(step5.providerId, "contabo");
  assert.deepEqual(step5.params, { serverSlug: "contabo-203386827", maxWaitMs: 600_000 });

  const step6 = ctx.planExecutions.find((entry) => entry.step === 6)!;
  const records = (step6.params.records as Array<{ name: string; type: string; values?: string[] }>);
  assert.deepEqual(records[0], {
    name: "smtp.delivrixops.com",
    type: "A",
    ttl: 300,
    values: ["203.0.113.77"]
  });
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.serverIpv4, "203.0.113.77");
});

test("PROVIDER#d3 resume Contabo con step 4 done sin IP ejecuta step 5 sin recrear VPS", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ vpsProviderId: "contabo" }),
    outcomes: {
      5: { serverSlug: "contabo-203386827", ipv4: "203.0.113.88", status: "running" }
    }
  });
  await seedContaboRunStateThroughStep4WithoutIp(ctx.workspace, "run-1");

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    vpsProviderId: "contabo"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.planExecutions.some((entry) => entry.step === 4), false);
  const step5 = ctx.invocations.find((entry) => entry.step === 5)!;
  assert.equal(step5.providerId, "contabo");
  assert.deepEqual(step5.params, { serverSlug: "contabo-203386827", maxWaitMs: 600_000 });
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.providerId, "contabo");
  assert.equal(state.serverSlug, "contabo-203386827");
  assert.equal(state.serverIpv4, "203.0.113.88");
});

test("configureCompleteSmtp backfills serverIpv4 from completed step outcomes on resume", async () => {
  const ctx = createDeps();
  await seedLegacyRunStateThroughStep4(ctx.workspace, "run-1");
  const raw = JSON.parse(await ctx.workspace.readWorkspaceFile("inventory/smtp-runs/run-1.json")) as Record<string, unknown>;
  delete raw.serverIpv4;
  await ctx.workspace.writeWorkspaceFileAtomic("inventory/smtp-runs/run-1.json", `${JSON.stringify(raw, null, 2)}\n`);

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.approvals.some((entry) => entry.step === 4), false);
  assert.equal(ctx.invocations.some((entry) => entry.step === 5), false);
  const step6 = ctx.approvals.find((entry) => entry.step === 6)!;
  const records = step6.params.records as Array<{ type: string; values?: string[] }>;
  assert.deepEqual(records[0].values, ["203.0.113.10"]);
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.serverIpv4, "203.0.113.10");
});

test("PROVIDER#e gated + vpsProviderId='contabo' => falla LIMPIO gated_provider_unsupported ANTES de crear (no VPS huerfano)", async () => {
  // Camino GATED (sin OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE): el processor gated single-account NO
  // recibe el providerId, asi que crearia el VPS en Webdock mientras el rollback enrutaria a Contabo
  // => huerfano. El guard debe abortar limpio ANTES del create. Solo "ops" elegible (sin multicuenta).
  const ctx = createDeps({
    creationServers: [
      { creationDate: "2026-05-31T11:00:00.000Z" },
      { creationDate: "2026-05-31T10:00:00.000Z" }
    ]
  });

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53", vpsProviderId: "contabo" }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 4);
  assert.equal(result.error, "gated_provider_unsupported");
  // El create gated nunca se ejecuto (no llego a submitAndAwaitApproval para el step 4) => no se creo VPS.
  assert.equal(ctx.approvals.some((entry) => entry.step === 4), false);
  assert.deepEqual(ctx.approvals.map((entry) => entry.step), [2, 3]);
  // step 4 < 6 => no hay rollback (no hay nada que borrar): no VPS huerfano.
  assert.equal(ctx.rollbacks.length, 0);
  // runState persiste providerId="contabo" (la eleccion del run), aunque el create se aborto.
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.providerId, "contabo");
});

test("PROVIDER#f governor short-circuit: un step-4 Contabo NO llama resolveCreationAccount/governor y deja serverAccountId sin setear", async () => {
  // P2 #5: el governor y la seleccion de cuenta son construcciones Webdock. Un run Contabo NO debe
  // leer inventario de cuentas (creationReads) ni fijar runState.serverAccountId a una cuenta Webdock
  // enganosa (eso contaminaria el cap 24h y enrutaria mal el rollback). Sembramos 2 cuentas Webdock
  // write-capable: si el governor corriera, creationReads tendria entradas. Para Contabo debe quedar vacio.
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ vpsProviderId: "contabo" }),
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { servers: [], sourceKind: "live", responseOk: true },
      secondary: { servers: [], sourceKind: "live", responseOk: true }
    }
  });

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53", vpsProviderId: "contabo" }, ctx.deps);

  assert.equal(result.status, "completed");
  // El governor NUNCA leyo inventario de cuentas: short-circuit total para el proveedor no-Webdock.
  assert.deepEqual(ctx.creationReads, []);
  // El step 4 viajo SIN serverAccountId (canal de cuenta apagado) y CON providerId="contabo".
  const step4 = ctx.planExecutions.find((entry) => entry.step === 4)!;
  assert.equal(step4.serverAccountId, undefined);
  assert.equal(step4.providerId, "contabo");
  // runState NO fija serverAccountId (no se contamina el cap del governor ni el routing de rollback).
  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.serverAccountId, undefined);
  assert.equal(state.providerId, "contabo");
});

test("PROVIDER#g failover guard: un error recuperable en step-4 Contabo PROPAGA sin reintentos de cuenta Webdock", async () => {
  // P2 #4: el failover multicuenta de pago es Webdock-only. Un error recuperable (payment_failed) en un
  // run Contabo NO debe excluir cuentas ni reintentar en otra cuenta Webdock: debe PROPAGAR de inmediato
  // (un solo intento de create). Sembramos 2 cuentas Webdock para probar que NO se usan en el failover.
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ vpsProviderId: "contabo" }),
    creationAccounts: [
      { accountId: "ops", enabled: true },
      { accountId: "secondary", enabled: true }
    ],
    creationByAccount: {
      ops: { servers: [], sourceKind: "live", responseOk: true },
      secondary: { servers: [], sourceKind: "live", responseOk: true }
    }
  });
  // El create Contabo (step 4) devuelve un fallo recuperable de pago.
  ctx.deps.executePlanApprovedStep = (() => {
    const original = ctx.deps.executePlanApprovedStep!;
    return async (input: PlanApprovedStepInput) => {
      if (input.step === 4) {
        ctx.planExecutions.push(input);
        return {
          status: "execution_failed",
          planStepTokenId: "plan-step-4-contabo",
          outcome: { error: "Payment failed during server creation", failureCode: "webdock_payment_failed" },
          durationMs: 4,
          error: "webdock_payment_failed"
        };
      }
      return original(input);
    };
  })();

  const result = await configureCompleteSmtp({ ...validInput(), runId: "run-1", domain: "delivrixops.com", provider: "route53", vpsProviderId: "contabo" }, ctx.deps);

  // El run FALLA en el step 4 (el error propago); NO hubo failover a otra cuenta.
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 4);
  // UN SOLO intento del step 4 (no se reintento en ninguna cuenta Webdock).
  const step4Attempts = ctx.planExecutions.filter((entry) => entry.step === 4);
  assert.equal(step4Attempts.length, 1);
  assert.equal(step4Attempts[0].providerId, "contabo");
  assert.equal(step4Attempts[0].serverAccountId, undefined);
  // El governor nunca corrio (no hubo seleccion de cuenta para excluir/reintentar).
  assert.deepEqual(ctx.creationReads, []);
});

test("configureCompleteSmtp emits canvas start and completion events", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const types = ctx.canvasEvents.map((event) => event.type);
  const actions = ctx.canvasEvents.map((event) => event.action);
  assert.deepEqual(types.slice(0, 2), ["oc.task.declare", "oc.action.now"]);
  assert.equal(actions.includes("oc.orchestrator.run_started"), true);
  assert.equal(actions.includes("oc.orchestrator.step_started"), true);
  assert.equal(actions.includes("oc.orchestrator.step_completed"), true);
  assert.equal(actions.includes("oc.orchestrator.run_completed"), true);
  assert.equal(types.at(-1), "oc.task.update");
  assert.equal(ctx.canvasEvents.at(-1)?.status, "completed");
});

test("configureCompleteSmtp audits failed steps", async () => {
  const ctx = createDeps({
    decisions: {
      3: { status: "execution_timeout", proposalId: "p-3", timeoutMs: 10 }
    }
  });
  await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.skill.invoked"), true);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.orchestrator.step_failed"), true);
});

test("configureCompleteSmtp marks canvas task failed when a step fails", async () => {
  const ctx = createDeps({
    decisions: {
      3: { status: "execution_timeout", proposalId: "p-3", timeoutMs: 10 }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(result.status, "failed");
  assert.equal(ctx.canvasEvents.at(-1)?.type, "oc.task.update");
  assert.equal(ctx.canvasEvents.at(-1)?.status, "failed");
  assert.equal(ctx.canvasEvents.some((event) => event.action === "oc.orchestrator.run_failed"), true);
});

test("configureCompleteSmtp does not fail operational work when canvas emit fails", async () => {
  const ctx = createDeps({ canvasEmitFails: true });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(result.status, "completed");
  assert.equal(result.stepResults.length, 14);
});

test("configureCompleteSmtp does not submit rollback before VPS exists", async () => {
  const ctx = createDeps({
    decisions: {
      3: { status: "execution_failed", proposalId: "p-3", outcome: {}, durationMs: 1 }
    }
  });
  await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(ctx.rollbacks.length, 0);
});

test("seed warmup blocks when seedInboxes are absent and env has no three defaults", async () => {
  const ctx = createDeps();
  const result = await configureCompleteSmtp({ ...validInput(), seedInboxes: undefined }, ctx.deps);
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 12);
  assert.equal(result.error, "seed_inboxes_must_be_exactly_3");
  assert.equal(ctx.approvals.some((entry) => entry.step === 12), false);
});

test("seed warmup honors explicit seed inboxes", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp({
    ...validInput(),
    seedInboxes: ["seed-a@example.com", "seed-b@example.com", "seed-c@example.com"]
  }, ctx.deps);
  const step12 = ctx.approvals.find((entry) => entry.step === 12);
  assert.deepEqual(step12?.params.seedInboxes, ["seed-a@example.com", "seed-b@example.com", "seed-c@example.com"]);
});

test("configureCompleteSmtp maps queued final delivery without rewriting it", async () => {
  const ctx = createDeps({
    outcomes: {
      14: { messageId: "<delivrix-queued-123@delivrixops.com>", deliveryStatus: "queued" }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(result.finalDeliveryStatus, "queued");
});

test("approval timeout env is passed to every gated step", async () => {
  const ctx = createDeps({ env: { OPENCLAW_CONFIGURE_SMTP_APPROVAL_TIMEOUT_MS: "12345" } });
  await configureCompleteSmtp(validInput(), ctx.deps);
  assert.equal(ctx.approvals.find((entry) => entry.step === 2)?.approvalTimeoutMs, 12345);
  assert.equal(ctx.approvals.find((entry) => entry.step === 3)?.approvalTimeoutMs, 1_980_000);
  assert.equal(ctx.approvals.find((entry) => entry.step === 7)?.approvalTimeoutMs, 1_950_000);
  assert.equal(ctx.approvals.find((entry) => entry.step === 8)?.approvalTimeoutMs, 12345);
  assert.equal(ctx.approvals.find((entry) => entry.step === 11)?.approvalTimeoutMs, 1_950_000);
});

test("handleConfigureCompleteSmtp returns HTTP 200 for completed run", async () => {
  const ctx = createDeps();
  const { request, response, getResponse } = createInternalHttpAdapter({ body: validInput() });
  await handleConfigureCompleteSmtp({ request, response, ...ctx.deps });
  const captured = getResponse();
  assert.equal(captured.statusCode, 200);
  assert.equal((captured.body as { status: string }).status, "completed");
});

test("configureCompleteSmtp keeps all real actions behind approval submissions", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  assert.deepEqual(ctx.approvals.map((entry) => entry.step), [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14]);
});

test("configureCompleteSmtp uses one signed plan to execute mutating steps without more ApprovalGates", async () => {
  const planApproval = signedPlanApproval();
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.approvals.length, 0);
  assert.deepEqual(ctx.planExecutions.map((entry) => entry.step), [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14]);
  assert.equal(result.stepResults.filter((step) => step.planStepTokenId).length, 11);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.plan.run_authorized"), true);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.plan.step_executed"), true);
});

test("configureCompleteSmtp waits for fresh Route53 registration before DNS propagation", async () => {
  let ctx!: ReturnType<typeof createDeps>;
  const planApproval = signedPlanApproval();
  const executionsAtWait: number[][] = [];
  ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval,
    outcomes: {
      2: {
        ok: true,
        domain: "delivrixops.com",
        status: "pending",
        operationId: "op-real-register",
        expectedExpiry: "2027-05-31T12:00:00.000Z",
        costUsd: 15
      }
    },
    route53RegistrationWait: async (input) => {
      executionsAtWait.push(ctx.planExecutions.map((entry) => entry.step));
      return {
        status: "owned",
        operationId: input.operationId,
        operationStatus: "SUCCESSFUL",
        attempts: 3,
        durationMs: 60_000
      };
    }
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.deepEqual(executionsAtWait, [[2]]);
  assert.equal(ctx.route53RegistrationWaits.length, 1);
  assert.equal(ctx.route53RegistrationWaits[0].operationId, "op-real-register");
  assert.equal(ctx.route53RegistrationWaits[0].maxWaitMs, 1_800_000);
  assert.equal(ctx.route53RegistrationWaits[0].pollIntervalMs, 30_000);
  assert.deepEqual(ctx.planExecutions.map((entry) => entry.step), [2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14]);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.domain.registration_wait_completed"), true);
});

test("configureCompleteSmtp blocks before DNS when Route53 registration fails", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    outcomes: {
      2: {
        ok: true,
        domain: "delivrixops.com",
        status: "pending",
        operationId: "op-real-register",
        costUsd: 15
      }
    },
    route53RegistrationWaitResults: [{
      status: "blocked",
      blockers: ["domain_registration_failed"],
      operationId: "op-real-register",
      operationStatus: "FAILED",
      message: "Route53 operation FAILED",
      attempts: 2,
      durationMs: 30_000
    }]
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 2);
  assert.equal(result.error, "domain_registration_failed");
  assert.deepEqual(ctx.planExecutions.map((entry) => entry.step), [2]);
  assert.equal(ctx.route53RegistrationWaits.length, 1);
  assert.equal(ctx.rollbacks.length, 0);
});

test("configureCompleteSmtp skips Route53 registration wait for idempotent owned outcomes", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ domain: "controldelivrix.app" }),
    suggestions: { candidates: [{ domain: "fresh-delivrix.com", priceUsd: 15, available: true }] },
    ownedDomains: ["controldelivrix.app"],
    outcomes: {
      2: { status: "idempotent_already_owned", operationId: "idempotent_already_owned", costUsd: 0 },
      4: { status: "idempotent_already_exists", serverSlug: "server10", ipv4: "45.136.70.47", costUsd: 0 }
    }
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "controldelivrix.app",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.route53RegistrationWaits.length, 0);
  assert.equal(result.totalCostUsd, 0);
});

test("configureCompleteSmtp fails closed for pending Route53 registration with synthetic operationId", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    outcomes: {
      2: {
        ok: true,
        domain: "delivrixops.com",
        status: "pending",
        operationId: "route53-reservation-existing",
        costUsd: 15
      }
    }
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 2);
  assert.equal(result.error, "domain_registration_failed");
  assert.equal(ctx.route53RegistrationWaits.length, 0);
  assert.deepEqual(ctx.planExecutions.map((entry) => entry.step), [2]);
});

test("configureCompleteSmtp treats signed non-owned explicit domain outside suggestions as fresh purchase", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ domain: "approved.example.com" }),
    suggestions: { candidates: [{ domain: "different.example.com", priceUsd: 15, available: true }] }
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "approved.example.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.ownershipChecks[0], "approved.example.com");
  assert.equal(ctx.approvals.length, 0);
  assert.equal(ctx.planExecutions.find((entry) => entry.step === 2)?.params.domain, "approved.example.com");
  assert.equal(ctx.planExecutions.find((entry) => entry.step === 2)?.estimatedCostUsd, 15);
  assert.equal(ctx.planExecutions.find((entry) => entry.step === 4)?.params.hostname, "smtp.approved.example.com");
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.domain.ownership_not_owned_fresh_purchase"), true);
});

test("configureCompleteSmtp keeps strict adoption fail-closed for non-owned explicit domain", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ domain: "approved.example.com", requireExistingDomain: true }),
    suggestions: { candidates: [{ domain: "different.example.com", priceUsd: 15, available: true }] }
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "approved.example.com",
    provider: "route53",
    requireExistingDomain: true
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 1);
  assert.equal(result.error, "domain_ownership_not_verified: domain=approved.example.com");
  assert.deepEqual(ctx.ownershipChecks, ["approved.example.com"]);
  assert.equal(ctx.approvals.length, 0);
  assert.equal(ctx.planExecutions.length, 0);
});

test("configureCompleteSmtp blocks post-signature downgrade from strict adoption to fresh purchase", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ domain: "approved.example.com", requireExistingDomain: true })
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "approved.example.com",
    provider: "route53",
    requireExistingDomain: false
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 0);
  assert.equal(result.error, "plan_scope_mismatch: requireExistingDomain");
  assert.equal(ctx.invocations.length, 0);
  assert.equal(ctx.approvals.length, 0);
  assert.equal(ctx.planExecutions.length, 0);
});

test("configureCompleteSmtp verifies strict adoption even when domain is suggested", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ domain: "approved.example.com", requireExistingDomain: true }),
    suggestions: { candidates: [{ domain: "approved.example.com", priceUsd: 15, available: true }] }
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "approved.example.com",
    provider: "route53",
    requireExistingDomain: true
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 1);
  assert.equal(result.error, "domain_ownership_not_verified: domain=approved.example.com");
  assert.deepEqual(ctx.ownershipChecks, ["approved.example.com"]);
  assert.equal(ctx.planExecutions.length, 0);
});

test("configureCompleteSmtp sends unsigned explicit fresh domain to register step", async () => {
  const ctx = createDeps({
    suggestions: { candidates: [{ domain: "different.example.com", priceUsd: 15, available: true }] }
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    domain: "freshdelivrix.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.deepEqual(ctx.ownershipChecks, ["freshdelivrix.com"]);
  assert.equal(ctx.approvals.find((entry) => entry.step === 2)?.params.domain, "freshdelivrix.com");
  assert.equal(ctx.approvals.find((entry) => entry.step === 2)?.estimatedCostUsd, 15);
});

test("configureCompleteSmtp surfaces domain_unavailable from register step instead of ownership 424", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ domain: "taken.example.com" }),
    suggestions: { candidates: [{ domain: "different.example.com", priceUsd: 15, available: true }] },
    planDecisions: {
      2: {
        status: "execution_failed",
        planStepTokenId: "plan-step-2",
        outcome: { error: "domain_unavailable" },
        durationMs: 2,
        statusCode: 502,
        error: "domain_unavailable"
      }
    }
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "taken.example.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 2);
  assert.equal(result.error, "domain_unavailable");
  assert.deepEqual(ctx.ownershipChecks, ["taken.example.com"]);
});

test("configureCompleteSmtp adopts a signed existing Route53-owned domain not in suggestions", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ domain: "controldelivrix.app" }),
    suggestions: { candidates: [{ domain: "fresh-delivrix.com", priceUsd: 15, available: true }] },
    ownedDomains: ["controldelivrix.app"],
    outcomes: {
      2: { status: "idempotent_already_owned", costUsd: 0 },
      4: { status: "idempotent_already_exists", serverSlug: "server10", ipv4: "45.136.70.47", costUsd: 0 }
    }
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "controldelivrix.app",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.ownershipChecks[0], "controldelivrix.app");
  assert.equal(ctx.planExecutions.find((entry) => entry.step === 2)?.estimatedCostUsd, 0);
  assert.equal(ctx.planExecutions.find((entry) => entry.step === 4)?.params.hostname, "smtp.controldelivrix.app");
  assert.equal(result.totalCostUsd, 0);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.domain.ownership_verified"), true);
});

test("configureCompleteSmtp adopts a signed strict existing IONOS-owned domain not in suggestions", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({ domain: "annualcorpfilings.com", requireExistingDomain: true }),
    suggestions: { candidates: [{ domain: "fresh-delivrix.com", priceUsd: 15, available: true }] },
    ownedDomains: ["annualcorpfilings.com"],
    ownedDomainProvider: "ionos",
    outcomes: {
      2: { status: "idempotent_already_owned", costUsd: 0 },
      4: { status: "idempotent_already_exists", serverSlug: "server10", ipv4: "45.136.70.47", costUsd: 0 }
    }
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "annualcorpfilings.com",
    provider: "route53",
    requireExistingDomain: true
  }, ctx.deps);
  const ownershipAudit = ctx.auditEvents.find((event) => event.action === "oc.domain.ownership_verified");
  const ownershipAuditMetadata = ownershipAudit?.metadata as Record<string, unknown> | undefined;

  assert.equal(result.status, "completed");
  assert.deepEqual(ctx.ownershipChecks, ["annualcorpfilings.com"]);
  assert.equal(ctx.planExecutions.find((entry) => entry.step === 2)?.estimatedCostUsd, 0);
  assert.equal(ctx.planExecutions.find((entry) => entry.step === 4)?.params.hostname, "smtp.annualcorpfilings.com");
  assert.equal(ctx.route53RegistrationWaits.length, 0);
  assert.equal(ownershipAuditMetadata?.provider, "ionos");
  assert.equal(result.totalCostUsd, 0);
});

test("DNS#IONOS configureCompleteSmtp adopted domain stays in IONOS for DNS writes", async () => {
  const planApproval = signedPlanApproval({ domain: "annualcorpfilings.com", requireExistingDomain: true });
  assert.equal(planApproval.scope.plannedSteps.includes("upsert_dns_route53"), true);
  assert.equal(planApproval.scope.plannedSteps.includes("configure_email_auth"), true);
  assert.equal(planApproval.scope.plannedSteps.includes("upsert_dns_ionos"), false);

  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval,
    suggestions: { candidates: [{ domain: "fresh-delivrix.com", priceUsd: 15, available: true }] },
    ownedDomains: ["annualcorpfilings.com"],
    ownedDomainProvider: "ionos",
    outcomes: {
      4: { status: "idempotent_already_exists", serverSlug: "server10", ipv4: "45.136.70.47", costUsd: 0 },
      9: { dkimPublicKey: "v=DKIM1; k=rsa; p=abc" }
    }
  });

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "annualcorpfilings.com",
    provider: "route53",
    dnsProviderId: "ionos",
    requireExistingDomain: true
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.deepEqual(ctx.ownershipChecks, ["annualcorpfilings.com"]);
  assert.deepEqual(ctx.route53RegistrationWaits, []);
  assert.equal(ctx.planExecutions.some((entry) => entry.step === 2 || entry.skill === "register_domain_route53"), false);
  assert.equal(ctx.planExecutions.some((entry) =>
    entry.skill === "wait_for_dns_propagation" &&
    JSON.stringify(entry.params).includes("contains:awsdns")
  ), false);

  const step6 = ctx.planExecutions.find((entry) => entry.step === 6)!;
  assert.equal(step6.skill, "upsert_dns_ionos");
  assert.equal(step6.dnsProviderId, "ionos");
  assert.equal(Object.prototype.hasOwnProperty.call(step6.params, "dnsProviderId"), false);
  assert.deepEqual(step6.params, {
    zone: "annualcorpfilings.com",
    records: [
      { name: "smtp.annualcorpfilings.com", type: "A", ttl: 300, content: "45.136.70.47" },
      { name: "annualcorpfilings.com", type: "MX", ttl: 300, content: "smtp.annualcorpfilings.com.", prio: 10 }
    ]
  });

  const step10 = ctx.planExecutions.find((entry) => entry.step === 10)!;
  assert.equal(step10.skill, "upsert_dns_ionos");
  assert.equal(step10.dnsProviderId, "ionos");
  assert.equal(Object.prototype.hasOwnProperty.call(step10.params, "dnsProviderId"), false);
  assert.deepEqual(step10.params, {
    zone: "annualcorpfilings.com",
    records: [
      { name: "annualcorpfilings.com", type: "TXT", ttl: 300, content: "v=spf1 ip4:45.136.70.47 -all" },
      { name: "s2026a._domainkey.annualcorpfilings.com", type: "TXT", ttl: 300, content: "v=DKIM1; k=rsa; p=abc" },
      {
        name: "_dmarc.annualcorpfilings.com",
        type: "TXT",
        ttl: 300,
        content: "v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@delivrix.com; ruf=mailto:dmarc-forensics@delivrix.com; fo=1"
      }
    ]
  });

  const state = await readRunStateFull(ctx.workspace, "run-1");
  assert.equal(state.dnsProviderId, "ionos");
  assert.equal(state.verifiedOwnedDomainProvider, "ionos");
  assert.equal(state.steps["2"].status, "done");
  assert.equal(state.steps["3"].status, "done");
  assert.equal(JSON.stringify(state).includes("contains:awsdns"), false);
});

test("DNS#IONOS legacy reconstruction skips Route53 registration and awsdns NS wait", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({
      runId: "run-legacy-ionos",
      domain: "annualcorpfilings.com",
      requireExistingDomain: true
    }),
    suggestions: { candidates: [{ domain: "fresh-delivrix.com", priceUsd: 15, available: true }] },
    ownedDomains: ["annualcorpfilings.com"],
    ownedDomainProvider: "ionos",
    outcomes: {
      9: { dkimPublicKey: "v=DKIM1; k=rsa; p=abc" }
    }
  });
  await ctx.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "legacy-ionos",
      hostname: "smtp.annualcorpfilings.com",
      ipv4: "45.136.70.47",
      status: "running"
    }],
    runBindings: [{
      runId: "run-legacy-ionos",
      serverSlug: "legacy-ionos",
      domain: "annualcorpfilings.com",
      boundAt: "2026-05-31T11:45:00.000Z",
      source: "legacy_reconstructed"
    }]
  }));

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-legacy-ionos",
    domain: "annualcorpfilings.com",
    provider: "route53",
    dnsProviderId: "ionos",
    requireExistingDomain: true
  }, ctx.deps);

  assert.equal(result.status, "completed");
  assert.deepEqual(ctx.route53RegistrationWaits, []);
  assert.equal(ctx.planExecutions.some((entry) => entry.step === 2 || entry.step === 3), false);
  const step6 = ctx.planExecutions.find((entry) => entry.step === 6)!;
  assert.equal(step6.skill, "upsert_dns_ionos");
  assert.equal(step6.dnsProviderId, "ionos");

  const state = await readRunStateFull(ctx.workspace, "run-legacy-ionos");
  assert.equal(state.dnsProviderId, "ionos");
  assert.equal(state.serverCreatedByRun, false);
  assert.equal(state.steps["2"].status, "done");
  assert.equal(state.steps["3"].status, "done");
  assert.equal(JSON.stringify(state.steps["2"]).includes("ionos_owned_domain"), true);
  assert.equal(JSON.stringify(state.steps["3"]).includes("contains:awsdns"), false);
  assert.equal(JSON.stringify(state.steps["3"]).includes("ionos_authoritative_nameservers"), true);
});

test("legacy reconstruction marks idempotent server bindings as not created by this run", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval({
      runId: "run-legacy-adopted",
      domain: "annualcorpfilings.com",
      requireExistingDomain: true
    }),
    suggestions: { candidates: [{ domain: "fresh-delivrix.com", priceUsd: 15, available: true }] },
    ownedDomains: ["annualcorpfilings.com"],
    ownedDomainProvider: "ionos",
    outcomes: {
      9: { dkimPublicKey: "v=DKIM1; k=rsa; p=abc" }
    }
  });
  await ctx.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "legacy-adopted",
      hostname: "smtp.annualcorpfilings.com",
      ipv4: "45.136.70.47",
      status: "running"
    }],
    runBindings: [{
      runId: "run-legacy-adopted",
      serverSlug: "legacy-adopted",
      domain: "annualcorpfilings.com",
      boundAt: "2026-05-31T11:45:00.000Z",
      source: "idempotent_already_exists"
    }]
  }));

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-legacy-adopted",
    domain: "annualcorpfilings.com",
    provider: "route53",
    dnsProviderId: "ionos",
    requireExistingDomain: true
  }, ctx.deps);
  const state = await readRunStateFull(ctx.workspace, "run-legacy-adopted");

  assert.equal(result.status, "completed");
  assert.equal(state.serverCreatedByRun, false);
});

for (const source of ["adopted", "reused"]) {
  test(`legacy reconstruction marks ${source} server bindings as not created by this run`, async () => {
    const ctx = createDeps({
      env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
      planApproval: signedPlanApproval({
        runId: `run-legacy-${source}`,
        domain: "annualcorpfilings.com",
        requireExistingDomain: true
      }),
      suggestions: { candidates: [{ domain: "fresh-delivrix.com", priceUsd: 15, available: true }] },
      ownedDomains: ["annualcorpfilings.com"],
      ownedDomainProvider: "ionos",
      outcomes: {
        9: { dkimPublicKey: "v=DKIM1; k=rsa; p=abc" }
      }
    });
    await ctx.workspace.updateInventoryJson("webdock-servers.json", () => ({
      servers: [{
        slug: `legacy-${source}`,
        hostname: "smtp.annualcorpfilings.com",
        ipv4: "45.136.70.47",
        status: "running"
      }],
      runBindings: [{
        runId: `run-legacy-${source}`,
        serverSlug: `legacy-${source}`,
        domain: "annualcorpfilings.com",
        boundAt: "2026-05-31T11:45:00.000Z",
        source
      }]
    }));

    const result = await configureCompleteSmtp({
      ...validInput(),
      runId: `run-legacy-${source}`,
      domain: "annualcorpfilings.com",
      provider: "route53",
      dnsProviderId: "ionos",
      requireExistingDomain: true
    }, ctx.deps);
    const state = await readRunStateFull(ctx.workspace, `run-legacy-${source}`);

    assert.equal(result.status, "completed");
    assert.equal(state.serverCreatedByRun, false);
  });
}

test("DNS#IONOS rejects switching a persisted Route53 run state to IONOS", async () => {
  const ctx = createDeps();
  await seedLegacyRunStateThroughStep4(ctx.workspace, "run-1");

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    dnsProviderId: "ionos",
    requireExistingDomain: true
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 0);
  assert.equal(result.error, "dns_provider_conflict_in_existing_run");
  assert.deepEqual(ctx.approvals, []);
  assert.deepEqual(ctx.planExecutions, []);
  assert.deepEqual(ctx.route53RegistrationWaits, []);
});

test("DNS#guard unknown dnsProviderId fails before side effects", async () => {
  const ctx = createDeps();

  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    dnsProviderId: "cloudflare"
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 0);
  assert.equal(result.error, "unknown_dns_provider:cloudflare");
  assert.deepEqual(ctx.approvals, []);
  assert.deepEqual(ctx.planExecutions, []);
  assert.deepEqual(ctx.route53RegistrationWaits, []);
});

test("configureCompleteSmtp checks kill switch before every plan-approved step", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    killSwitchAfterPlanExecutions: 3
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "cancelled_by_operator");
  assert.equal(result.failedStep, 6);
  assert.equal(result.error, "kill_switch_armed");
  assert.deepEqual(ctx.planExecutions.map((entry) => entry.step), [2, 3, 4]);
});

test("configureCompleteSmtp compacts completed run into episodic memory", async () => {
  const ctx = createDeps({ compactIntent: true });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(ctx.compactions.length, 1);
  assert.equal(ctx.compactions[0].intentId, "run-1");
  assert.equal(ctx.compactions[0].finalStatus, "completed");
  assert.equal(ctx.compactions[0].steps.length, 14);
  assert.equal(ctx.compactions[0].steps.every((step) => /^[a-f0-9]{64}$/.test(step.inputHash)), true);
});

test("configureCompleteSmtp persists compacted steps through the real episodic write gate", async () => {
  const scratchPool = new MemoryScratchPool();
  const ctx = createDeps({ signedAuditEvents: true });
  ctx.deps.compactIntent = async (input) => compactIntent(input, {
    pool: scratchPool,
    auditLog: {
      async append(event) {
        ctx.auditEvents.push(event as never);
        return { id: `audit-${ctx.auditEvents.length}`, ...event } as never;
      },
      async list() {
        return ctx.auditEvents as never;
      }
    },
    now: () => new Date("2026-05-31T12:00:00.000Z")
  });

  const result = await withOperatorSecret("operator-secret", () => configureCompleteSmtp(validInput(), ctx.deps));

  assert.equal(result.status, "completed");
  assert.equal(scratchPool.rows.length, 14);
  assert.equal(ctx.logs.some((entry) => entry.event === "openclaw.orchestrator.compact_intent_failed"), false);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.episodic.intent_compacted"), true);
});

test("configureCompleteSmtp conforms realistic 14-step outcomes before episodic compaction", async () => {
  const scratchPool = new MemoryScratchPool();
  const dirtyOutcomes = realisticSmtpOutcomes();
  const ctx = createDeps({
    signedAuditEvents: true,
    suggestions: dirtyOutcomes[1],
    outcomes: dirtyOutcomes
  });
  ctx.deps.compactIntent = async (input) => compactIntent(input, {
    pool: scratchPool,
    auditLog: {
      async append(event) {
        ctx.auditEvents.push(event as never);
        return { id: `audit-${ctx.auditEvents.length}`, ...event } as never;
      },
      async list() {
        return ctx.auditEvents as never;
      }
    },
    now: () => new Date("2026-05-31T12:00:00.000Z")
  });

  const result = await withOperatorSecret("operator-secret", () => configureCompleteSmtp(validInput(), ctx.deps));

  assert.equal(result.status, "completed");
  assert.equal(result.stepResults.length, 14);
  assert.equal(scratchPool.rows.length, 14);
  assert.equal(ctx.logs.some((entry) => entry.event === "openclaw.orchestrator.compact_intent_failed"), false);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.episodic.intent_compacted"), true);

  const rawSuggestion = result.stepResults.find((step) => step.step === 1)?.outcome as Record<string, unknown>;
  assert.equal(JSON.stringify(rawSuggestion).includes("spamhausDBL"), true);
  assert.equal(JSON.stringify(rawSuggestion).includes("workspace"), true);

  const compacted = JSON.stringify(scratchPool.rows.map((row) => row.outcome_data));
  assert.equal(compacted.includes("spamhausDBL"), false);
  assert.equal(compacted.includes("rationale"), false);
  assert.equal(compacted.includes("postfixLogTail"), true);
  assert.equal(compacted.includes("connect from unknown host"), false);
  assert.equal(compacted.includes("dkimPrivateKeyPath"), false);
  assert.equal(compacted.includes("operator@example.com"), false);
  assert.equal(compacted.includes("[redacted]"), false);
});

test("configureCompleteSmtp compacts plan-approved steps without requiring step signatures", async () => {
  const scratchPool = new MemoryScratchPool();
  const ctx = createDeps({
    planApproval: signedPlanApproval(),
    compactIntent: true
  });
  ctx.deps.env = {
    ...ctx.deps.env,
    OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true"
  };
  ctx.deps.compactIntent = async (input) => compactIntent(input, {
    pool: scratchPool,
    auditLog: {
      async append(event) {
        ctx.auditEvents.push(event as never);
        return { id: `audit-${ctx.auditEvents.length}`, ...event } as never;
      },
      async list() {
        return ctx.auditEvents as never;
      }
    },
    now: () => new Date("2026-05-31T12:00:00.000Z")
  });

  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(scratchPool.rows.length, 14);
  assert.equal(ctx.logs.some((entry) => entry.event === "openclaw.orchestrator.compact_intent_failed"), false);
  assert.equal(ctx.auditEvents.some((event) => event.action === "oc.episodic.intent_compacted"), true);
});

test("configureCompleteSmtp producer outcome keys stay synchronized with memory write gate", async () => {
  const scratchPool = new MemoryScratchPool();
  const ctx = createDeps({ signedAuditEvents: true });
  ctx.deps.compactIntent = async (input) => compactIntent(input, {
    pool: scratchPool,
    auditLog: {
      async append(event) {
        ctx.auditEvents.push(event as never);
        return { id: `audit-${ctx.auditEvents.length}`, ...event } as never;
      },
      async list() {
        return ctx.auditEvents as never;
      }
    },
    now: () => new Date("2026-05-31T12:00:00.000Z")
  });

  await withOperatorSecret("operator-secret", () => configureCompleteSmtp(validInput(), ctx.deps));

  assert.deepEqual(collectOutcomeDataKeys(scratchPool.rows), [
    "available",
    "candidates",
    "deliveryStatus",
    "dkimPublicKeyHash",
    "dkimPublicKeyPresent",
    "domain",
    "ipv4",
    "messageId",
    "ok",
    "priceUsd",
    "skill",
    "slug"
  ]);
});

test("configureCompleteSmtp audits storage write-gate compaction rejection", async () => {
  const ctx = createDeps();
  ctx.deps.compactIntent = async () => {
    throw {
      code: "memory_payload_free_text_forbidden",
      details: {
        rejectionStage: "storage_write_gate",
        rejectionKind: "unknown_outcome_key",
        fieldPath: "outcomeData.hostnameFuture",
        fieldKey: "hostnameFuture",
        normalizedFieldKey: "hostnamefuture",
        step: 4,
        tool: "create_webdock_server",
        inputHash: "a".repeat(64),
        outcome: "success",
        valueType: "string",
        valueLength: 18,
        redaction: {
          rawValueLogged: false,
          rawErrorMessageLogged: false,
          requestBodyLogged: false
        }
      }
    };
  };

  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "completed");
  const log = ctx.logs.find((entry) => entry.event === "openclaw.orchestrator.compact_intent_failed");
  assert.equal(log?.metadata?.fieldPath, "outcomeData.hostnameFuture");
  assert.equal(log?.metadata?.error, undefined);
  const rejected = ctx.auditEvents.find((event) => event.action === "oc.episodic.compaction_rejected");
  assert.equal(rejected?.decision, "reject");
  assert.equal(rejected?.rejectReason, "memory_compaction_rejected");
  const metadata = rejected?.metadata as { fieldPath?: string; redaction?: { rawErrorMessageLogged?: boolean } } | undefined;
  assert.equal(metadata?.fieldPath, "outcomeData.hostnameFuture");
  assert.equal(metadata?.redaction?.rawErrorMessageLogged, false);
});

test("configureCompleteSmtp compacts failed step with failure evidence", async () => {
  const ctx = createDeps({
    compactIntent: true,
    decisions: {
      3: { status: "approval_timeout", proposalId: "p-3", timeoutMs: 10 }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(ctx.compactions.length, 1);
  const failed = ctx.compactions[0].steps.find((step) => step.step === 3);
  assert.equal(ctx.compactions[0].finalStatus, "failed");
  assert.equal(failed?.outcome, "timeout");
  assert.equal(failed?.proposalId, "p-3");
});

test("configureCompleteSmtp compacts execution failure with real outcome data", async () => {
  const ctx = createDeps({
    compactIntent: true,
    decisions: {
      2: {
        status: "execution_failed",
        proposalId: "p-2",
        outcome: { error: "purchase_failed", providerRequestId: "req-2" },
        durationMs: 7,
        error: "purchase_failed"
      }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(ctx.compactions.length, 1);
  const failed = ctx.compactions[0].steps.find((step) => step.step === 2);
  assert.equal(failed?.outcome, "failed");
  assert.equal(failed?.proposalId, "p-2");
  assert.deepEqual(failed?.outcomeData, { error: "purchase_failed", providerRequestId: "req-2" });
});

test("configureCompleteSmtp compacts free-text execution failures as machine-code memory", async () => {
  const scratchPool = new MemoryScratchPool();
  const ctx = createDeps({
    signedAuditEvents: true,
    decisions: {
      2: {
        status: "execution_failed",
        proposalId: "p-2",
        outcome: {
          error: "purchase_failed",
          providerRequestId: "req-2",
          message: "Route53 purchase failed because the provider is still pending",
          details: "manual follow-up text must not enter memory"
        },
        durationMs: 7,
        error: "domain registration failed while provider was pending"
      }
    }
  });
  ctx.deps.compactIntent = async (input) => compactIntent(input, {
    pool: scratchPool,
    auditLog: {
      async append(event) {
        ctx.auditEvents.push(event as never);
        return { id: `audit-${ctx.auditEvents.length}`, ...event } as never;
      },
      async list() {
        return ctx.auditEvents as never;
      }
    },
    now: () => new Date("2026-05-31T12:00:00.000Z")
  });

  const result = await withOperatorSecret("operator-secret", () => configureCompleteSmtp(validInput(), ctx.deps));

  assert.equal(result.status, "failed");
  assert.equal(result.error, "domain registration failed while provider was pending");
  assert.equal(ctx.logs.some((entry) => entry.event === "openclaw.orchestrator.compact_intent_failed"), false);
  const failed = scratchPool.rows.find((row) => row.step === 2);
  assert.equal(failed?.error_message, "domain");
  assert.deepEqual(failed?.outcome_data, { error: "purchase_failed", providerRequestId: "req-2" });
});

test("configureCompleteSmtp persists write-ahead in_flight before a plan-approved dispatch completes", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    planDecisions: {
      2: {
        status: "execution_failed",
        planStepTokenId: "plan-step-2",
        outcome: { error: "purchase_failed" },
        durationMs: 2,
        error: "purchase_failed"
      }
    }
  });
  const result = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  }, ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 2);
  const state = await readRunState(ctx.workspace, "run-1");
  assert.equal(state.steps["2"].status, "in_flight");
  assert.equal(typeof state.steps["2"].attemptId, "string");

  const retry = await configureCompleteSmtp({
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  }, ctx.deps);
  assert.equal(retry.status, "failed");
  assert.equal(retry.failedStep, 2);
  assert.equal(retry.error, "step_in_flight");
  assert.deepEqual(ctx.planExecutions.map((entry) => entry.step), [2]);
});

test("configureCompleteSmtp releases the create_webdock_server lease on failure so a retry is not 423-blocked", async () => {
  const planDecisions: Record<number, PlanApprovedStepDecision> = {
    4: {
      status: "execution_failed",
      planStepTokenId: "plan-step-4",
      outcome: { error: "webdock_payment_failed" },
      durationMs: 2,
      error: "webdock_payment_failed"
    }
  };
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    planDecisions
  });
  const input = {
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  };
  const first = await configureCompleteSmtp(input, ctx.deps);
  assert.equal(first.status, "failed");
  assert.equal(first.failedStep, 4);

  // El create de VPS es idempotente: su lease se libera tras el fallo -> step "pending", sin lease,
  // con el error registrado. Asi un reintento NO queda bloqueado 45min con HTTP 423 step_in_flight.
  const state = await readRunState(ctx.workspace, "run-1");
  assert.equal(state.steps["4"].status, "pending");
  assert.equal(state.steps["4"].leaseUntil, undefined);
  assert.equal(state.steps["4"].lastError, "webdock_payment_failed");

  // Reintento inmediato (simula pago arreglado): NO recibe step_in_flight y completa el run.
  delete planDecisions[4];
  const retry = await configureCompleteSmtp(input, ctx.deps);
  assert.notEqual(retry.error, "step_in_flight");
  assert.equal(retry.status, "completed");
  const finalState = await readRunState(ctx.workspace, "run-1");
  assert.equal(finalState.steps["4"].status, "done");
});

test("configureCompleteSmtp retries an expired in_flight step with the same input hash", async () => {
  const planDecisions: Record<number, PlanApprovedStepDecision> = {
    2: {
      status: "execution_failed",
      planStepTokenId: "plan-step-2",
      outcome: { error: "purchase_failed" },
      durationMs: 2,
      error: "purchase_failed"
    }
  };
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    planDecisions
  });
  const input = {
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  };
  const first = await configureCompleteSmtp(input, ctx.deps);
  assert.equal(first.status, "failed");
  assert.equal(first.failedStep, 2);

  const state = await readRunState(ctx.workspace, "run-1");
  assert.equal(state.steps["2"].status, "in_flight");
  state.steps["2"].leaseUntil = "2026-05-31T11:00:00.000Z";
  await writeRunState(ctx.workspace, "run-1", state);
  delete planDecisions[2];

  const retry = await configureCompleteSmtp(input, ctx.deps);

  assert.equal(retry.status, "completed");
  assert.equal(retry.stepResults.length, 14);
  assert.equal(ctx.planExecutions.filter((entry) => entry.step === 2).length, 2);
  const completedState = await readRunState(ctx.workspace, "run-1");
  assert.equal(completedState.steps["2"].status, "done");
});

test("configureCompleteSmtp retries an expired in_flight step after input hash contract changes", async () => {
  const planDecisions: Record<number, PlanApprovedStepDecision> = {
    2: {
      status: "execution_failed",
      planStepTokenId: "plan-step-2",
      outcome: { error: "purchase_failed" },
      durationMs: 2,
      error: "purchase_failed"
    }
  };
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval(),
    planDecisions
  });
  const input = {
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  };
  const first = await configureCompleteSmtp(input, ctx.deps);
  assert.equal(first.status, "failed");
  assert.equal(first.failedStep, 2);

  const state = await readRunState(ctx.workspace, "run-1");
  assert.equal(state.steps["2"].status, "in_flight");
  state.steps["2"].inputHash = "stale-input-hash-from-previous-code";
  state.steps["2"].leaseUntil = "2026-05-31T11:00:00.000Z";
  await writeRunState(ctx.workspace, "run-1", state);
  delete planDecisions[2];

  const retry = await configureCompleteSmtp(input, ctx.deps);

  assert.equal(retry.status, "completed");
  assert.equal(retry.stepResults.length, 14);
  assert.equal(ctx.planExecutions.filter((entry) => entry.step === 2).length, 2);
  const completedState = await readRunState(ctx.workspace, "run-1");
  assert.equal(completedState.steps["2"].status, "done");
  assert.notEqual(completedState.steps["2"].inputHash, "stale-input-hash-from-previous-code");
});

test("configureCompleteSmtp skips all done steps on replay of a completed run", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval()
  });
  const input = {
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  };

  const first = await configureCompleteSmtp(input, ctx.deps);
  assert.equal(first.status, "completed");
  const planExecutionsAfterFirst = ctx.planExecutions.length;
  const invocationsAfterFirst = ctx.invocations.length;

  const second = await configureCompleteSmtp(input, ctx.deps);
  assert.equal(second.status, "completed");
  assert.equal(ctx.planExecutions.length, planExecutionsAfterFirst);
  assert.equal(ctx.invocations.length, invocationsAfterFirst);
  assert.equal(second.stepResults.length, 14);
});

test("configureCompleteSmtp resume uses signed-state recipient (no false drift) but rejects domain drift", async () => {
  const ctx = createDeps({
    env: { OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE: "true" },
    planApproval: signedPlanApproval()
  });
  const input = {
    ...validInput(),
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53"
  };
  await configureCompleteSmtp(input, ctx.deps);

  // Reanudar con un recipient distinto en el request ya NO aborta: el orquestador ejecuta con el
  // recipient del ESTADO firmado (el request crudo se ignora; el smoke envia a state.params). Antes
  // daba un falso positivo resume_scope_drift: recipient que bloqueaba todo resume legitimo.
  const resumedWithOtherRecipient = await configureCompleteSmtp({
    ...input,
    testEmailRecipient: "other@example.com"
  }, ctx.deps);
  assert.equal(resumedWithOtherRecipient.status, "completed");

  // Pero reanudar con un DOMINIO distinto SI es drift real (reanudar el run de un dominio con otro)
  // y debe abortar.
  const domainDrift = await configureCompleteSmtp({
    ...input,
    domain: "otherdomain.com"
  }, ctx.deps);
  assert.equal(domainDrift.status, "failed");
  assert.equal(domainDrift.error, "resume_scope_drift: domain");
});

test("configureCompleteSmtp blocks concurrent runs for the same runId", async () => {
  let releaseStep2!: () => void;
  const step2Gate = new Promise<void>((resolve) => {
    releaseStep2 = resolve;
  });
  const ctx = createDeps();
  ctx.deps.submitAndAwaitApproval = async (input: ApprovalStepInput): Promise<ApprovalStepDecision> => {
    ctx.approvals.push(input);
    if (input.step === 2) {
      await step2Gate;
    }
    return {
      status: "executed",
      proposalId: `proposal-${input.step}`,
      signatureId: `sig-${input.step}`,
      outcome: defaultOutcome(input.step),
      durationMs: input.step
    };
  };
  const input = { ...validInput(), runId: "run-concurrent" };

  const first = configureCompleteSmtp(input, ctx.deps);
  await waitFor(() => ctx.approvals.some((entry) => entry.step === 2));
  const second = await configureCompleteSmtp(input, ctx.deps);
  assert.equal(second.status, "failed");
  assert.equal(second.error, "run_already_in_progress");
  releaseStep2();
  const firstResult = await first;
  assert.equal(firstResult.status, "completed");
});

test("configureCompleteSmtp run lock outlives 30 minute waits and step lease outlives run lock", async () => {
  let releaseStep2!: () => void;
  const step2Gate = new Promise<void>((resolve) => {
    releaseStep2 = resolve;
  });
  const ctx = createDeps();
  ctx.deps.submitAndAwaitApproval = async (input: ApprovalStepInput): Promise<ApprovalStepDecision> => {
    ctx.approvals.push(input);
    if (input.step === 2) {
      await step2Gate;
    }
    return {
      status: "executed",
      proposalId: `proposal-${input.step}`,
      signatureId: `sig-${input.step}`,
      outcome: defaultOutcome(input.step),
      durationMs: input.step
    };
  };
  const input = { ...validInput(), runId: "run-lease" };

  const first = configureCompleteSmtp(input, ctx.deps);
  await waitFor(() => ctx.approvals.some((entry) => entry.step === 2));

  const leasePath = join(ctx.workspace.getRootDir(), "inventory", ".locks", "run-run-lease.lock", "lease.json");
  const lockLease = JSON.parse(await readFile(leasePath, "utf8")) as { acquiredAt: string; leaseUntil: string };
  const state = await readRunState(ctx.workspace, "run-lease");
  const acquiredAtMs = Date.parse(lockLease.acquiredAt);
  const runLeaseUntilMs = Date.parse(lockLease.leaseUntil);
  const stepLeaseUntilMs = Date.parse(state.steps["2"].leaseUntil ?? "");

  assert.equal(runLeaseUntilMs - acquiredAtMs, 40 * 60 * 1000);
  assert.equal(stepLeaseUntilMs - acquiredAtMs, 45 * 60 * 1000);
  assert.ok(stepLeaseUntilMs > runLeaseUntilMs);

  releaseStep2();
  const firstResult = await first;
  assert.equal(firstResult.status, "completed");
});

function validInput() {
  return {
    brand: "delivrix",
    intent: "ops",
    budgetUsdMax: 25,
    testEmailRecipient: "operator@example.com",
    testEmailSubject: "Operational readiness report",
    testEmailBody: "Authorized operational readiness message for Delivrix infrastructure.",
    seedInboxes: ["seed-a@example.com", "seed-b@example.com", "seed-c@example.com"],
    actorId: "op-1"
  };
}

function signedPlanApproval(overrides: Partial<PlanApprovalRecord["scope"]> = {}): PlanApprovalRecord {
  const scope = {
    runId: "run-1",
    domain: "delivrixops.com",
    provider: "route53",
    budgetUsdMax: 25,
    recipient: "operator@example.com",
    plannedSkill: "configure_complete_smtp" as const,
    plannedSteps: [
      "suggest_safe_domain",
      "register_domain_route53",
      "wait_for_dns_propagation",
      "read_route53_domain_detail",
      "read_route53_zone_records",
      "read_dns_ionos",
      "read_webdock_servers",
      "create_webdock_server",
      "upsert_dns_route53",
      "bind_webdock_main_domain",
      "provision_smtp_postfix",
      "configure_email_auth",
      "seed_warmup_pool",
      "send_real_email",
      "compact_intent"
    ],
    ...overrides
  };
  return {
    status: "signed",
    signedAt: "2026-05-31T11:59:00.000Z",
    expiresAt: "2026-05-31T13:00:00.000Z",
    signatureId: "sig-plan-1",
    scopeHash: createHash("sha256").update(stableStringify(scope)).digest("hex"),
    scope,
    flagEnabled: true
  };
}

function createDeps(options: {
  decisions?: Record<number, ApprovalStepDecision>;
  planDecisions?: Record<number, PlanApprovedStepDecision>;
  outcomes?: Record<number, unknown>;
  suggestions?: unknown;
  killSwitchEnabled?: boolean;
  auditOk?: boolean;
  env?: Record<string, string | undefined>;
  canvasEmitFails?: boolean;
  compactIntent?: boolean;
  signedAuditEvents?: boolean;
  planApproval?: PlanApprovalRecord | null;
  killSwitchAfterPlanExecutions?: number;
  ownedDomains?: string[];
  route53RegistrationWaitResults?: Route53DomainRegistrationWaitResult[];
  route53RegistrationWait?: (input: Route53DomainRegistrationWaitInput) => Promise<Route53DomainRegistrationWaitResult> | Route53DomainRegistrationWaitResult;
  creationServers?: Array<{ creationDate?: string }>;
  creationReadError?: unknown;
  creationSourceKind?: "live" | "mock" | string;
  creationResponseOk?: boolean;
  creationOverride?: CreationRateOverrideDecision;
  ownedDomainProvider?: OwnedDomainVerification["provider"];
  // 5.12 multicuenta: cuentas write-capable + inventario/estado por cuenta (account-aware).
  creationAccounts?: Array<{ accountId: string; enabled: boolean; healthStatus?: string; lifecycleStatus?: string }>;
  creationByAccount?: Record<string, {
    servers?: Array<{ creationDate?: string }>;
    sourceKind?: "live" | "mock" | string;
    responseOk?: boolean;
    readError?: unknown;
    readErrors?: unknown[];
  }>;
} = {}): {
  deps: ConfigureCompleteSmtpDeps;
  approvals: ApprovalStepInput[];
  planExecutions: PlanApprovedStepInput[];
  invocations: SkillInvocationInput[];
  creationReads: string[];
  creationOverrides: CreationRateOverrideInput[];
  route53RegistrationWaits: Route53DomainRegistrationWaitInput[];
  rollbacks: Array<{ skill: string; params: Record<string, unknown>; serverAccountId?: string }>;
  creationAccountReads: number;
  auditEvents: Array<Record<string, unknown> & { action: string; metadata?: unknown }>;
  canvasEvents: Array<Record<string, unknown> & { action?: string }>;
  compactions: Array<{
    intentId: string;
    finalStatus: string;
    steps: Array<{ step: number; tool: string; inputHash: string; outcome: string; proposalId?: string; outcomeData?: Record<string, unknown> }>;
  }>;
  logs: Array<{ level: string; event: string; metadata?: Record<string, unknown> }>;
  ownershipChecks: string[];
  workspace: OpenClawWorkspace;
  verifyCount: number;
} {
  const approvals: ApprovalStepInput[] = [];
  const planExecutions: PlanApprovedStepInput[] = [];
  const invocations: SkillInvocationInput[] = [];
  const creationReads: string[] = [];
  const creationOverrides: CreationRateOverrideInput[] = [];
  const route53RegistrationWaits: Route53DomainRegistrationWaitInput[] = [];
  const rollbacks: Array<{ skill: string; params: Record<string, unknown>; serverAccountId?: string }> = [];
  let creationAccountReads = 0;
  const auditEvents: Array<Record<string, unknown> & { action: string; metadata?: unknown }> = [];
  const canvasEvents: Array<Record<string, unknown> & { action?: string }> = [];
  const logs: Array<{ level: string; event: string; metadata?: Record<string, unknown> }> = [];
  const ownershipChecks: string[] = [];
  const compactions: Array<{
    intentId: string;
    finalStatus: string;
    steps: Array<{ step: number; tool: string; inputHash: string; outcome: string; proposalId?: string; outcomeData?: Record<string, unknown> }>;
  }> = [];
  let verifyCount = 0;
  const workspace = new OpenClawWorkspace({
    rootDir: mkdtempSync(join(tmpdir(), "openclaw-smtp-orchestrator-test-")),
    now: () => new Date("2026-05-31T12:00:00.000Z")
  });

  const ctx = {
    deps: {
      workspace,
      auditLog: {
        async append(event: Record<string, unknown> & { action: string; metadata?: unknown }) {
          auditEvents.push(event);
          return { id: `audit-${auditEvents.length}` };
        }
      },
      async invokeSkill(input: SkillInvocationInput) {
        invocations.push(input);
        if (input.skill === "suggest_safe_domain") {
          return options.suggestions ?? {
            candidates: [{ domain: "delivrixops.com", priceUsd: 15, available: true }]
          };
        }
        return options.outcomes?.[input.step] ?? { ok: true, skill: input.skill };
      },
      ...(options.creationAccounts ? {
        listCreationAccounts() {
          creationAccountReads += 1;
          return options.creationAccounts!;
        }
      } : {}),
      async listWebdockCreationServers(input: { accountId: string }) {
        creationReads.push(input.accountId);
        // Modo account-aware (multicuenta): inventario/estado por cuenta.
        const perAccount = options.creationByAccount?.[input.accountId];
        if (perAccount) {
          if (perAccount.readErrors?.length) {
            throw perAccount.readErrors.shift();
          }
          if (perAccount.readError) {
            throw perAccount.readError;
          }
          return {
            accountId: input.accountId,
            accountLabel: `Webdock ${input.accountId}`,
            sourceKind: perAccount.sourceKind ?? "live",
            responseOk: perAccount.responseOk ?? true,
            servers: perAccount.servers ?? []
          };
        }
        // Modo single-account (compat byte-identica con los tests previos): siempre "ops".
        if (options.creationReadError) {
          throw options.creationReadError;
        }
        return {
          accountId: "ops",
          accountLabel: "Webdock Ops",
          sourceKind: options.creationSourceKind ?? "live",
          responseOk: options.creationResponseOk ?? true,
          servers: options.creationServers ?? []
        };
      },
      async resolveCreationRateOverride(input: CreationRateOverrideInput) {
        creationOverrides.push(input);
        return options.creationOverride ?? { approved: false };
      },
      async submitAndAwaitApproval(input: ApprovalStepInput): Promise<ApprovalStepDecision> {
        approvals.push(input);
        const decision = options.decisions?.[input.step];
        if (decision) return decision;
        if (options.signedAuditEvents) {
          auditEvents.push({
            id: `audit-sig-${input.step}`,
            occurredAt: "2026-05-31T12:00:00.000Z",
            action: "oc.proposal.signed",
            targetType: "proposal",
            targetId: `proposal-${input.step}`,
            actorType: "operator",
            actorId: input.actorId,
            decision: "allow",
            humanApproved: true,
            metadata: { signatureId: `sig-${input.step}` },
            hash: `hash-sig-${input.step}`
          });
        }
        return {
          status: "executed",
          proposalId: `proposal-${input.step}`,
          signatureId: `sig-${input.step}`,
          outcome: options.outcomes?.[input.step] ?? defaultOutcome(input.step),
          durationMs: input.step
        };
      },
      async resolvePlanApproval(input) {
        if (options.planApproval === undefined) return null;
        return options.planApproval?.scope.runId === input.runId ? options.planApproval : null;
      },
      async executePlanApprovedStep(input: PlanApprovedStepInput) {
        planExecutions.push(input);
        const decision = options.planDecisions?.[input.step];
        if (decision) return decision;
        return {
          status: "executed" as const,
          planStepTokenId: `plan-step-${input.step}`,
          signatureId: input.planApproval.signatureId,
          outcome: options.outcomes?.[input.step] ?? defaultOutcome(input.step),
          durationMs: input.step,
          statusCode: 200
        };
      },
      async verifyOwnedDomain(domain: string) {
        ownershipChecks.push(domain);
        return {
          owned: options.ownedDomains?.includes(domain) ?? false,
          provider: options.ownedDomainProvider ?? "route53",
          sourceKind: "live",
          responseOk: true
        };
      },
      async waitForRoute53DomainRegistration(input: Route53DomainRegistrationWaitInput): Promise<Route53DomainRegistrationWaitResult> {
        route53RegistrationWaits.push(input);
        if (options.route53RegistrationWait) {
          return options.route53RegistrationWait(input);
        }
        return options.route53RegistrationWaitResults?.shift() ?? {
          status: "owned",
          operationId: input.operationId,
          operationStatus: "SUCCESSFUL",
          attempts: 1,
          durationMs: 0
        };
      },
      async submitRollbackProposal(input: { skill: "delete_webdock_server"; params: Record<string, unknown>; serverAccountId?: string }) {
        rollbacks.push(input);
        return { proposalId: "rollback-1" };
      },
      verifyAuditChain() {
        verifyCount += 1;
        return { ok: options.auditOk ?? true };
      },
      readKillSwitch() {
        return {
          enabled: options.killSwitchEnabled ??
            (options.killSwitchAfterPlanExecutions !== undefined && planExecutions.length >= options.killSwitchAfterPlanExecutions)
        };
      },
      canvasLiveEvents: {
        async emit(event) {
          if (options.canvasEmitFails) {
            throw new Error("canvas emit failed");
          }
          canvasEvents.push(event as unknown as Record<string, unknown> & { action?: string });
          return event;
        }
      },
      ...(options.compactIntent ? {
        async compactIntent(input: {
          intentId: string;
          finalStatus: string;
          steps: Array<{ step: number; tool: string; inputHash: string; outcome: string; proposalId?: string; outcomeData?: Record<string, unknown> }>;
        }) {
          compactions.push(input);
          return { entriesWritten: input.steps.length };
        }
      } : {}),
      env: options.env ?? {},
      now: () => new Date("2026-05-31T12:00:00.000Z"),
      randomId: () => "run-1",
      logger: {
        logPath: "",
        info: async (event, _message, metadata) => {
          logs.push({ level: "info", event, ...(metadata ? { metadata } : {}) });
        },
        warn: async (event, _message, metadata) => {
          logs.push({ level: "warn", event, ...(metadata ? { metadata } : {}) });
        },
        error: async (event, _message, metadata) => {
          logs.push({ level: "error", event, ...(metadata ? { metadata } : {}) });
        }
      }
    } satisfies ConfigureCompleteSmtpDeps,
    approvals,
    planExecutions,
    invocations,
    creationReads,
    creationOverrides,
    route53RegistrationWaits,
    rollbacks,
    auditEvents,
    canvasEvents,
    compactions,
    logs,
    ownershipChecks,
    workspace,
    get creationAccountReads() {
      return creationAccountReads;
    },
    get verifyCount() {
      return verifyCount;
    }
  };

  return ctx;
}

async function readRunState(workspace: OpenClawWorkspace, runId: string): Promise<{
  steps: Record<string, { status: string; inputHash?: string; attemptId?: string; leaseUntil?: string }>;
}> {
  return JSON.parse(await workspace.readWorkspaceFile(`inventory/smtp-runs/${runId}.json`)) as {
    steps: Record<string, { status: string; inputHash?: string; attemptId?: string; leaseUntil?: string }>;
  };
}

async function writeRunState(
  workspace: OpenClawWorkspace,
  runId: string,
  state: { steps: Record<string, { status: string; inputHash?: string; attemptId?: string; leaseUntil?: string }> }
): Promise<void> {
  await workspace.writeWorkspaceFileAtomic(`inventory/smtp-runs/${runId}.json`, `${JSON.stringify(state, null, 2)}\n`);
}

async function readRunStateFull(workspace: OpenClawWorkspace, runId: string): Promise<{
  serverAccountId?: string;
  providerId?: string;
  serverCreatedByRun?: boolean;
  dnsProviderId?: string;
  verifiedOwnedDomainProvider?: string;
  serverSlug?: string;
  serverIpv4?: string;
  steps: Record<string, { status: string; inputHash?: string }>;
}> {
  return JSON.parse(await workspace.readWorkspaceFile(`inventory/smtp-runs/${runId}.json`)) as {
    serverAccountId?: string;
    providerId?: string;
    serverCreatedByRun?: boolean;
    dnsProviderId?: string;
    verifiedOwnedDomainProvider?: string;
    serverSlug?: string;
    serverIpv4?: string;
    steps: Record<string, { status: string; inputHash?: string }>;
  };
}

function fourServers(): Array<{ creationDate: string }> {
  return [
    { creationDate: "2026-05-31T11:00:00.000Z" },
    { creationDate: "2026-05-31T10:00:00.000Z" },
    { creationDate: "2026-05-31T09:00:00.000Z" },
    { creationDate: "2026-05-31T08:00:00.000Z" }
  ];
}

// Siembra un runState LEGACY (sin serverAccountId) con los pasos 1-5 ya "done" (server creado),
// para reanudar y forzar el fallo del bind (step 8) sin re-seleccionar cuenta. hashInput debe
// coincidir con el de los params que el orquestador recomputa en cada paso, o el resume aborta.
async function seedLegacyRunStateThroughStep4(
  workspace: OpenClawWorkspace,
  runId: string,
  options: { serverCreatedByRun?: boolean } = {}
): Promise<void> {
  const hash = (params: Record<string, unknown>) => createHash("sha256").update(stableStringify(params)).digest("hex");
  const done = (step: number, skill: string, params: Record<string, unknown>, outcome: unknown, estimatedCostUsd?: number) => ({
    step,
    skill,
    status: "done" as const,
    inputHash: hash(params),
    result: { step, skill, inputHash: hash(params), outcome, durationMs: 0, ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }) },
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    startedAt: "2026-05-31T12:00:00.000Z",
    completedAt: "2026-05-31T12:00:00.000Z",
    updatedAt: "2026-05-31T12:00:00.000Z"
  });
  const state = {
    schemaVersion: "smtp-run-state/v1",
    runId,
    status: "running",
    createdAt: "2026-05-31T12:00:00.000Z",
    updatedAt: "2026-05-31T12:00:00.000Z",
    params: {
      brand: "delivrix",
      intent: "ops",
      provider: "route53",
      requireExistingDomain: false,
      budgetUsdMax: 25,
      testEmailRecipient: "operator@example.com",
      testEmailSubject: "Operational readiness report",
      testEmailBody: "Authorized operational readiness message for Delivrix infrastructure.",
      seedInboxes: ["seed-a@example.com", "seed-b@example.com", "seed-c@example.com"]
    },
    chosenDomain: "delivrixops.com",
    smtpHost: "smtp.delivrixops.com",
    serverSlug: "srv-delivrix",
    serverIpv4: "203.0.113.10",
    // NOTA: serverAccountId AUSENTE a proposito (runState viejo, pre-multicuenta).
    ...(options.serverCreatedByRun === undefined ? {} : { serverCreatedByRun: options.serverCreatedByRun }),
    selector: "s2026a",
    budgetSpentUsd: 0,
    lastCompletedStep: 5,
    steps: {
      "1": done(1, "suggest_safe_domain", { brand: "delivrix", intent: "ops", count: 5, actorId: "op-1" }, { candidates: [{ domain: "delivrixops.com", priceUsd: 15, available: true }] }),
      "2": done(2, "register_domain_route53", { domain: "delivrixops.com", years: 1, autoRenew: false }, { ok: true, status: "owned", operationId: "op-2" }, 0),
      "3": done(3, "wait_for_dns_propagation", { domain: "delivrixops.com", expectedRecord: { type: "NS", value: "contains:awsdns" }, maxWaitMs: 1_800_000, pollIntervalMs: 60_000 }, { ok: true }),
      "4": done(4, "create_webdock_server", { runId, profile: "bit", locationId: "dk", hostname: "smtp.delivrixops.com", imageSlug: "ubuntu-2404" }, { slug: "srv-delivrix", ipv4: "203.0.113.10" }),
      "5": done(5, "wait_server_running", { serverSlug: "srv-delivrix", maxWaitMs: 600_000 }, { ok: true })
    }
  };
  await workspace.writeWorkspaceFileAtomic(`inventory/smtp-runs/${runId}.json`, `${JSON.stringify(state, null, 2)}\n`);
}

async function seedContaboRunStateThroughStep4WithoutIp(workspace: OpenClawWorkspace, runId: string): Promise<void> {
  const hash = (params: Record<string, unknown>) => createHash("sha256").update(stableStringify(params)).digest("hex");
  const done = (step: number, skill: string, params: Record<string, unknown>, outcome: unknown, estimatedCostUsd?: number) => ({
    step,
    skill,
    status: "done" as const,
    inputHash: hash(params),
    result: { step, skill, inputHash: hash(params), outcome, durationMs: 0, ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }) },
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    startedAt: "2026-05-31T12:00:00.000Z",
    completedAt: "2026-05-31T12:00:00.000Z",
    updatedAt: "2026-05-31T12:00:00.000Z"
  });
  const state = {
    schemaVersion: "smtp-run-state/v1",
    runId,
    status: "running",
    createdAt: "2026-05-31T12:00:00.000Z",
    updatedAt: "2026-05-31T12:00:00.000Z",
    params: {
      brand: "delivrix",
      intent: "ops",
      provider: "route53",
      requireExistingDomain: false,
      budgetUsdMax: 25,
      testEmailRecipient: "operator@example.com",
      testEmailSubject: "Operational readiness report",
      testEmailBody: "Authorized operational readiness message for Delivrix infrastructure.",
      seedInboxes: ["seed-a@example.com", "seed-b@example.com", "seed-c@example.com"]
    },
    chosenDomain: "delivrixops.com",
    smtpHost: "smtp.delivrixops.com",
    serverSlug: "contabo-203386827",
    providerId: "contabo",
    selector: "s2026a",
    budgetSpentUsd: 0,
    lastCompletedStep: 4,
    steps: {
      "1": done(1, "suggest_safe_domain", { brand: "delivrix", intent: "ops", count: 5, actorId: "op-1" }, { candidates: [{ domain: "delivrixops.com", priceUsd: 15, available: true }] }),
      "2": done(2, "register_domain_route53", { domain: "delivrixops.com", years: 1, autoRenew: false }, { ok: true, status: "owned", operationId: "op-2" }, 0),
      "3": done(3, "wait_for_dns_propagation", { domain: "delivrixops.com", expectedRecord: { type: "NS", value: "contains:awsdns" }, maxWaitMs: 1_800_000, pollIntervalMs: 60_000 }, { ok: true }),
      "4": done(4, "create_webdock_server", { runId, profile: "bit", locationId: "dk", hostname: "smtp.delivrixops.com", imageSlug: "ubuntu-2404" }, { slug: "contabo-203386827", serverSlug: "contabo-203386827", ipv4: null })
    }
  };
  await workspace.writeWorkspaceFileAtomic(`inventory/smtp-runs/${runId}.json`, `${JSON.stringify(state, null, 2)}\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function defaultOutcome(step: number): unknown {
  if (step === 4) return { slug: "srv-delivrix", ipv4: "203.0.113.10" };
  if (step === 9) return { dkimPublicKey: "v=DKIM1; k=rsa; p=abc" };
  if (step === 14) return { messageId: "<delivrix-0123456789abcdef@delivrixops.com>", deliveryStatus: "sent" };
  return { ok: true };
}

function realisticSmtpOutcomes(): Record<number, unknown> {
  return {
    1: {
      candidates: [{
        domain: "delivrixops.com",
        priceUsd: 15,
        available: true,
        spamhausDBL: "clear at check time, prose should be dropped",
        rationale: "short brand match with low collision risk",
        registrarOptions: [{ registrar: "route53", priceUsd: 15 }]
      }],
      workspace: { path: "/tmp/openclaw/run-1" }
    },
    2: {
      domain: "delivrixops.com",
      operationId: "op-domain-1",
      reservationOperationId: "res-domain-1",
      expectedExpiry: "2027-06-05T00:00:00.000Z",
      message: "provider returned a friendly sentence"
    },
    3: {
      status: "propagated",
      nameservers: ["ns-1.awsdns-01.com", "ns-2.awsdns-02.net"],
      zoneResolution: { source: "route53 lookup", smtpSetup: "ready", cleanupSuggested: "none" }
    },
    4: {
      slug: "srv-delivrix",
      serverSlug: "srv-delivrix",
      ipv4: "203.0.113.10",
      publicKeyId: "ssh-key-ops",
      workspace: { path: "/tmp/openclaw/webdock" }
    },
    5: {
      status: "running",
      serverSlug: "srv-delivrix",
      workspace: { path: "/tmp/openclaw/server-running" }
    },
    6: {
      status: "bound",
      domain: "delivrixops.com",
      serverSlug: "srv-delivrix",
      ptrSkipReason: "Webdock PTR endpoint unavailable",
      operatorAction: "ptr_manual"
    },
    7: {
      changeId: "/change/C123456789",
      zoneId: "Z03595092JW2AXJBZGN4E",
      records: [
        { name: "mail.delivrixops.com", type: "A", value: "203.0.113.10" },
        { name: "delivrixops.com", type: "MX", value: "10 mail.delivrixops.com." }
      ],
      workspace: { path: "/tmp/openclaw/dns" }
    },
    8: {
      status: "propagated",
      recordName: "mail.delivrixops.com",
      recordType: "A",
      recordValue: "203.0.113.10",
      preValidations: ["resolver returned expected A record"]
    },
    9: {
      status: "configured",
      serverSlug: "srv-delivrix",
      dkimPublicKey: "v=DKIM1; k=rsa; p=abc",
      dkimPrivateKeyPath: "/inventory/dkim-keys/delivrixops.com/s2026a.private",
      postfixLogTail: "connect from unknown host then queued successfully ".repeat(8)
    },
    10: {
      status: "configured",
      selector: "s2026a",
      dkimPublicKeyHash: "a".repeat(64),
      records: [
        { name: "s2026a._domainkey.delivrixops.com", type: "TXT", value: "v=DKIM1; k=rsa; p=abc" },
        { name: "delivrixops.com", type: "TXT", value: "v=SPF1 ip4:203.0.113.10 ~all" }
      ],
      workspace: { path: "/tmp/openclaw/email-auth" }
    },
    11: {
      status: "propagated",
      recordName: "s2026a._domainkey.delivrixops.com",
      recordType: "TXT",
      recordValue: "v=DKIM1; k=rsa; p=abc"
    },
    12: {
      status: "seeded",
      sent: [
        { to: "operator@example.com", msgId: "msg-seed-1", deliveryStatus: "sent" },
        { to: "seed@example.com", msgId: "msg-seed-2", deliveryStatus: "sent" }
      ],
      workspace: { path: "/tmp/openclaw/warmup" }
    },
    13: {
      status: "scheduled",
      nextBatchAt: "2026-06-05T18:00:00.000Z",
      schedule: "daily",
      preValidations: ["warmup queue inspected"]
    },
    14: {
      messageId: "<delivrix-final-1@delivrixops.com>",
      deliveryStatus: "sent",
      tlsStatus: "valid",
      postfixLogTail: "250 queued as ABC123 after human-readable SMTP dialogue ".repeat(8),
      sent: [{ to: "operator@example.com", msgId: "<delivrix-final-1@delivrixops.com>" }]
    }
  };
}

async function withOperatorSecret<T>(secret: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_OPERATOR_HMAC_SECRET;
  process.env.OPENCLAW_OPERATOR_HMAC_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_OPERATOR_HMAC_SECRET;
    } else {
      process.env.OPENCLAW_OPERATOR_HMAC_SECRET = previous;
    }
  }
}

interface MemoryRow {
  id: string;
  intent_id: string;
  step: number;
  tool: string;
  input_hash: string;
  outcome: string;
  outcome_data: Record<string, unknown> | null;
  error_class: string | null;
  error_message: string | null;
  source: string;
  trust_score: number;
  plane: string;
  provenance: Record<string, unknown>;
  reliability: number;
  valid_at: Date;
  invalid_at: Date | null;
  ttl_expires_at: Date;
  created_at: Date;
  metadata: Record<string, unknown>;
}

class MemoryScratchPool {
  rows: MemoryRow[] = [];
  now = new Date("2026-05-31T12:00:00.000Z");
  #id = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: MemoryRow[]; rowCount: number }> {
    if (!sql.includes("INSERT INTO openclaw_episodic_scratch")) {
      throw new Error(`Unexpected SQL in orchestrator memory test: ${sql}`);
    }
    const ttlDays = Number(params[15]);
    const row: MemoryRow = {
      id: `scratch-${++this.#id}`,
      intent_id: String(params[0]),
      step: Number(params[1]),
      tool: String(params[2]),
      input_hash: String(params[3]),
      outcome: String(params[4]),
      outcome_data: parseJsonRecord(params[5]),
      error_class: typeof params[6] === "string" ? params[6] : null,
      error_message: typeof params[7] === "string" ? params[7] : null,
      source: String(params[8]),
      trust_score: Number(params[9]),
      plane: String(params[10]),
      provenance: parseJsonRecord(params[11]) ?? {},
      reliability: Number(params[12]),
      valid_at: params[13] instanceof Date ? params[13] : new Date(String(params[13])),
      invalid_at: params[14] instanceof Date ? params[14] : null,
      ttl_expires_at: new Date(this.now.getTime() + ttlDays * 24 * 60 * 60 * 1000),
      created_at: new Date(this.now.getTime() + this.#id),
      metadata: parseJsonRecord(params[16]) ?? {}
    };
    this.rows.push(row);
    return { rows: [row], rowCount: 1 };
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function collectOutcomeDataKeys(rows: MemoryRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    collectKeys(row.outcome_data, keys);
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

function collectKeys(value: unknown, keys: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectKeys(item, keys);
  }
}

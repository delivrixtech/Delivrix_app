import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInternalHttpAdapter } from "../internal-http-adapter.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  configureCompleteSmtp,
  handleConfigureCompleteSmtp,
  readSmtpRunProgress,
  type ApprovalStepDecision,
  type ApprovalStepInput,
  type ConfigureCompleteSmtpDeps,
  type PlanApprovedStepInput,
  type PlanApprovedStepDecision,
  type Route53DomainRegistrationWaitInput,
  type Route53DomainRegistrationWaitResult,
  type SkillInvocationInput
} from "./orchestrator-smtp.ts";
import type { PlanApprovalRecord } from "./proposals-sign.ts";
import { compactIntent } from "./openclaw-compact-intent.ts";

test("configureCompleteSmtp completes the 14-step happy path", async () => {
  const ctx = createDeps();
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "completed");
  assert.equal(result.stepResults.length, 14);
  assert.deepEqual(result.stepResults.map((step) => step.step), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(result.finalEmailMessageId, "msg-1");
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
    selector: "s2026a",
    budgetSpentUsd: 0,
    lastCompletedStep: 0,
    steps: {
      "1": {
        step: 1,
        skill: "suggest_safe_domain",
        status: "done",
        result: {
          step: 1,
          skill: "suggest_safe_domain",
          inputHash: "hash-1",
          outcome: { token: "super-secret-token" },
          durationMs: 10
        },
        updatedAt: "2026-05-31T12:00:10.000Z"
      },
      "2": {
        step: 2,
        skill: "register_domain_route53",
        status: "in_flight",
        inputHash: "hash-2",
        leaseUntil: "2026-05-31T12:10:00.000Z",
        updatedAt: "2026-05-31T12:00:20.000Z"
      }
    }
  }, null, 2)}\n`);

  const progress = await readSmtpRunProgress({ workspace: ctx.workspace }, "run-progress");

  assert.deepEqual(progress, {
    runId: "run-progress",
    status: "running",
    lastCompletedStep: 1,
    steps: [
      { step: 1, skill: "suggest_safe_domain", status: "done" },
      { step: 2, skill: "register_domain_route53", status: "in_flight" },
      { step: 3, skill: "wait_for_dns_propagation", status: "pending" },
      { step: 4, skill: "create_webdock_server", status: "pending" },
      { step: 5, skill: "wait_server_running", status: "pending" },
      { step: 6, skill: "upsert_dns_route53", status: "pending" },
      { step: 7, skill: "wait_for_dns_propagation", status: "pending" },
      { step: 8, skill: "bind_webdock_main_domain", status: "pending" },
      { step: 9, skill: "provision_smtp_postfix", status: "pending" },
      { step: 10, skill: "configure_email_auth", status: "pending" },
      { step: 11, skill: "wait_for_dns_propagation", status: "pending" },
      { step: 12, skill: "seed_warmup_pool", status: "pending" },
      { step: 13, skill: "wait_warmup_initial", status: "pending" },
      { step: 14, skill: "send_real_email", status: "pending" }
    ]
  });
  assert.doesNotMatch(JSON.stringify(progress), /super-secret-token|secret subject|secret body|operator@example\.test/);
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
      14: { messageId: "msg-queued", deliveryStatus: "queued" }
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

test("configureCompleteSmtp rejects resume scope drift before invoking tools", async () => {
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

  const drift = await configureCompleteSmtp({
    ...input,
    testEmailRecipient: "other@example.com"
  }, ctx.deps);
  assert.equal(drift.status, "failed");
  assert.equal(drift.error, "resume_scope_drift: recipient");
  assert.equal(ctx.planExecutions.length, 11);
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
    scopeHash: "plan-scope-hash-1",
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
} = {}): {
  deps: ConfigureCompleteSmtpDeps;
  approvals: ApprovalStepInput[];
  planExecutions: PlanApprovedStepInput[];
  invocations: SkillInvocationInput[];
  route53RegistrationWaits: Route53DomainRegistrationWaitInput[];
  rollbacks: Array<{ skill: string; params: Record<string, unknown> }>;
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
  const route53RegistrationWaits: Route53DomainRegistrationWaitInput[] = [];
  const rollbacks: Array<{ skill: string; params: Record<string, unknown> }> = [];
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
          provider: "route53" as const,
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
      async submitRollbackProposal(input: { skill: "delete_webdock_server"; params: Record<string, unknown> }) {
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
          canvasEvents.push(event as Record<string, unknown> & { action?: string });
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
    route53RegistrationWaits,
    rollbacks,
    auditEvents,
    canvasEvents,
    compactions,
    logs,
    ownershipChecks,
    workspace,
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
  if (step === 14) return { messageId: "msg-1", deliveryStatus: "sent" };
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
      messageId: "msg-final-1",
      deliveryStatus: "sent",
      tlsStatus: "valid",
      postfixLogTail: "250 queued as ABC123 after human-readable SMTP dialogue ".repeat(8),
      sent: [{ to: "operator@example.com", msgId: "msg-final-1" }]
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

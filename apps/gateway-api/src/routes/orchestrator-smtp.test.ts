import assert from "node:assert/strict";
import test from "node:test";
import { createInternalHttpAdapter } from "../internal-http-adapter.ts";
import {
  configureCompleteSmtp,
  handleConfigureCompleteSmtp,
  type ApprovalStepDecision,
  type ApprovalStepInput,
  type ConfigureCompleteSmtpDeps,
  type PlanApprovedStepInput,
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

test("configureCompleteSmtp emits rollback proposal when step 6 fails after VPS creation", async () => {
  const ctx = createDeps({
    decisions: {
      6: { status: "execution_failed", proposalId: "p-6", outcome: { error: "bind_failed" }, durationMs: 9 }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 6);
  assert.equal(ctx.rollbacks.length, 1);
  assert.equal(ctx.rollbacks[0].skill, "delete_webdock_server");
  assert.equal(ctx.rollbacks[0].params.serverSlug, "srv-delivrix");
});

test("configureCompleteSmtp maps operator rejection at step 8 to cancelled_by_operator", async () => {
  const ctx = createDeps({
    decisions: {
      8: { status: "rejected", proposalId: "p-8", reason: "operator stopped DNS wait" }
    }
  });
  const result = await configureCompleteSmtp(validInput(), ctx.deps);

  assert.equal(result.status, "cancelled_by_operator");
  assert.equal(result.failedStep, 8);
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

test("create_webdock_server uses the root chosen domain as hostname", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step4 = ctx.approvals.find((entry) => entry.step === 4);
  assert.equal(step4?.params.hostname, "delivrixops.com");
});

test("route53 DNS step includes A and MX records", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp(validInput(), ctx.deps);
  const step7 = ctx.approvals.find((entry) => entry.step === 7);
  assert.deepEqual(step7?.params.records, [
    { name: "delivrixops.com", type: "A", ttl: 300, values: ["203.0.113.10"] },
    { name: "delivrixops.com", type: "MX", ttl: 300, values: ["10 delivrixops.com."] }
  ]);
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

test("seed warmup defaults to the operator recipient when seedInboxes is absent", async () => {
  const ctx = createDeps();
  await configureCompleteSmtp({ ...validInput(), seedInboxes: undefined }, ctx.deps);
  const step12 = ctx.approvals.find((entry) => entry.step === 12);
  assert.deepEqual(step12?.params.seedInboxes, [validInput().testEmailRecipient]);
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
  assert.equal(ctx.approvals.find((entry) => entry.step === 8)?.approvalTimeoutMs, 750_000);
  assert.equal(ctx.approvals.find((entry) => entry.step === 11)?.approvalTimeoutMs, 750_000);
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

test("configureCompleteSmtp fails closed when signed plan domain is not in suggestions", async () => {
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

  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, 1);
  assert.equal(result.error, "plan_domain_not_in_suggestions: approved_domain=approved.example.com");
  assert.equal(ctx.approvals.length, 0);
  assert.equal(ctx.planExecutions.length, 0);
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

function validInput() {
  return {
    brand: "delivrix",
    intent: "ops",
    budgetUsdMax: 25,
    testEmailRecipient: "operator@example.com",
    testEmailSubject: "Operational readiness report",
    testEmailBody: "Authorized operational readiness message for Delivrix infrastructure.",
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
      "bind_webdock_main_domain",
      "upsert_dns_route53",
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
} = {}): {
  deps: ConfigureCompleteSmtpDeps;
  approvals: ApprovalStepInput[];
  planExecutions: PlanApprovedStepInput[];
  invocations: SkillInvocationInput[];
  rollbacks: Array<{ skill: string; params: Record<string, unknown> }>;
  auditEvents: Array<Record<string, unknown> & { action: string; metadata?: unknown }>;
  canvasEvents: Array<Record<string, unknown> & { action?: string }>;
  compactions: Array<{
    intentId: string;
    finalStatus: string;
    steps: Array<{ step: number; tool: string; inputHash: string; outcome: string; proposalId?: string; outcomeData?: Record<string, unknown> }>;
  }>;
  logs: Array<{ level: string; event: string; metadata?: Record<string, unknown> }>;
  verifyCount: number;
} {
  const approvals: ApprovalStepInput[] = [];
  const planExecutions: PlanApprovedStepInput[] = [];
  const invocations: SkillInvocationInput[] = [];
  const rollbacks: Array<{ skill: string; params: Record<string, unknown> }> = [];
  const auditEvents: Array<Record<string, unknown> & { action: string; metadata?: unknown }> = [];
  const canvasEvents: Array<Record<string, unknown> & { action?: string }> = [];
  const logs: Array<{ level: string; event: string; metadata?: Record<string, unknown> }> = [];
  const compactions: Array<{
    intentId: string;
    finalStatus: string;
    steps: Array<{ step: number; tool: string; inputHash: string; outcome: string; proposalId?: string; outcomeData?: Record<string, unknown> }>;
  }> = [];
  let verifyCount = 0;

  const ctx = {
    deps: {
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
        return { ok: true, skill: input.skill };
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
        return {
          status: "executed" as const,
          planStepTokenId: `plan-step-${input.step}`,
          signatureId: input.planApproval.signatureId,
          outcome: options.outcomes?.[input.step] ?? defaultOutcome(input.step),
          durationMs: input.step,
          statusCode: 200
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
    rollbacks,
    auditEvents,
    canvasEvents,
    compactions,
    logs,
    get verifyCount() {
      return verifyCount;
    }
  };

  return ctx;
}

function defaultOutcome(step: number): unknown {
  if (step === 4) return { slug: "srv-delivrix", ipv4: "203.0.113.10" };
  if (step === 9) return { dkimPublicKey: "v=DKIM1; k=rsa; p=abc" };
  if (step === 14) return { messageId: "msg-1", deliveryStatus: "sent" };
  return { ok: true };
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

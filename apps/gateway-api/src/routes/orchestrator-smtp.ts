import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEventInput,
  CanvasLiveEvent
} from "../../../../packages/domain/src/index.ts";
import {
  configureCompleteSmtpParamSchema,
  type ConfigureCompleteSmtpParams
} from "../skill-schemas.ts";
import {
  noopGatewayRuntimeLogger,
  summarizeOperationalParams,
  type GatewayRuntimeLogger
} from "../gateway-runtime-log.ts";
import { readRequestBody } from "../request-body.ts";

export type ConfigureSmtpStatus =
  | "completed"
  | "executing"
  | "failed"
  | "rolled_back"
  | "cancelled_by_operator";

export interface ConfigureCompleteSmtpStepResult {
  step: number;
  skill: string;
  inputHash: string;
  proposalId?: string;
  signatureId?: string;
  outcome: unknown;
  durationMs: number;
  estimatedCostUsd?: number;
}

export interface ConfigureCompleteSmtpResult {
  runId: string;
  status: ConfigureSmtpStatus;
  stepResults: ConfigureCompleteSmtpStepResult[];
  totalDurationMs: number;
  totalCostUsd: number;
  finalEmailMessageId?: string;
  finalDeliveryStatus?: "queued" | "delivered" | "deferred" | "bounced";
  rollbackProposalId?: string;
  error?: string;
  failedStep?: number;
}

export interface SkillInvocationInput {
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ApprovalStepInput extends SkillInvocationInput {
  actorId: string;
  approvalTimeoutMs: number;
  estimatedCostUsd?: number;
}

export type ApprovalStepDecision =
  | {
      status: "executed";
      proposalId: string;
      signatureId?: string;
      outcome: unknown;
      durationMs: number;
      statusCode?: number;
    }
  | {
      status: "execution_failed";
      proposalId: string;
      signatureId?: string;
      outcome?: unknown;
      durationMs: number;
      statusCode?: number;
      error?: string;
    }
  | {
      status: "rejected";
      proposalId: string;
      reason?: string;
    }
  | {
      status: "approval_timeout" | "execution_timeout";
      proposalId: string;
      timeoutMs: number;
    };

export interface RollbackProposalInput {
  runId: string;
  failedStep: number;
  skill: "delete_webdock_server";
  params: Record<string, unknown>;
  actorId: string;
  reason: string;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

interface CompactIntentSink {
  (input: {
    intentId: string;
    finalStatus: "completed" | "failed" | "cancelled" | "rolled_back";
    decision: string;
    ttlDays?: number;
    steps: Array<{
      step: number;
      tool: string;
      inputHash: string;
      outcome: "success" | "failed" | "rolled_back" | "rollback_failed" | "cancelled_by_operator" | "timeout" | "partial";
      outcomeData?: Record<string, unknown>;
      errorClass?: string;
      errorMessage?: string;
      durationMs?: number;
      proposalId?: string;
      signatureId?: string;
    }>;
  }): Promise<unknown>;
}

type CompactIntentStepInput = Parameters<CompactIntentSink>[0]["steps"][number];

export interface ConfigureCompleteSmtpDeps {
  request?: IncomingMessage;
  response?: ServerResponse;
  auditLog: AuditSink;
  invokeSkill(input: SkillInvocationInput): Promise<unknown>;
  submitAndAwaitApproval(input: ApprovalStepInput): Promise<ApprovalStepDecision>;
  submitRollbackProposal?: (input: RollbackProposalInput) => Promise<{ proposalId: string }>;
  verifyAuditChain?: () => Promise<{ ok: boolean; details?: unknown }> | { ok: boolean; details?: unknown };
  readKillSwitch?: () => Promise<{ enabled: boolean }> | { enabled: boolean };
  canvasLiveEvents?: CanvasEmitter;
  compactIntent?: CompactIntentSink;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  randomId?: () => string;
  logger?: GatewayRuntimeLogger;
}

const defaultApprovalTimeoutMs = 10 * 60 * 1000;
const longRunningStepTimeoutPaddingMs = 2 * 60 * 1000;
const minEstimatedCostUsd = 15 + 4.30 / 30;

export async function handleConfigureCompleteSmtp(
  deps: ConfigureCompleteSmtpDeps & { request: IncomingMessage; response: ServerResponse }
): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(deps.request);
  } catch {
    return json(deps.response, 400, {
      error: "invalid_json",
      details: { _errors: ["Request body must be valid JSON."] }
    });
  }

  const parsed = configureCompleteSmtpParamSchema.safeParse(body);
  if (!parsed.success) {
    return json(deps.response, 400, {
      error: "invalid_params",
      details: parsed.error.format()
    });
  }

  const killSwitch = await deps.readKillSwitch?.();
  if (killSwitch?.enabled) {
    return json(deps.response, 423, { error: "kill_switch_armed" });
  }

  if (parsed.data.budgetUsdMax < minEstimatedCostUsd) {
    return json(deps.response, 422, {
      error: "budget_too_low",
      minEstimatedCostUsd: roundUsd(minEstimatedCostUsd)
    });
  }

  const result = await configureCompleteSmtp(parsed.data, deps);
  return json(deps.response, result.status === "completed" ? 200 : 424, result);
}

export async function configureCompleteSmtp(
  input: ConfigureCompleteSmtpParams,
  deps: ConfigureCompleteSmtpDeps
): Promise<ConfigureCompleteSmtpResult> {
  const startedAt = deps.now?.() ?? new Date();
  const startedMs = startedAt.getTime();
  const runId = deps.randomId?.() ?? randomUUID();
  const stepResults: ConfigureCompleteSmtpStepResult[] = [];
  const approvalTimeoutMs = positiveInt(deps.env?.OPENCLAW_CONFIGURE_SMTP_APPROVAL_TIMEOUT_MS) ??
    defaultApprovalTimeoutMs;
  let chosenDomain = "";
  let serverSlug = "";
  let serverIpv4 = "";
  let rollbackProposalId: string | undefined;
  const logger = deps.logger ?? noopGatewayRuntimeLogger;

  void logger.info("openclaw.orchestrator.run_started", "configure_complete_smtp run started.", {
    runId,
    brand: input.brand,
    intent: input.intent,
    budgetUsdMax: input.budgetUsdMax,
    actorId: input.actorId
  });
  await emitRunTask(deps, runId, "running", {
    title: `configure_complete_smtp · ${input.brand}`,
    createdAt: startedAt.toISOString()
  });
  await emitRunAction(deps, runId, "oc.orchestrator.run_started", "low");
  await audit(deps, "oc.skill.invoked", "openclaw_intent", runId, "low", {
    skillSlug: "configure_complete_smtp",
    intentId: runId,
    runId,
    actorId: input.actorId
  });
  await audit(deps, "oc.orchestrator.run_started", "openclaw_orchestrator_run", runId, "high", {
    skill: "configure_complete_smtp",
    budgetUsdMax: input.budgetUsdMax,
    actorId: input.actorId
  });

  try {
    await verifyAuditChain(deps);

    const suggestions = await runReadOnlyStep({
      deps,
      runId,
      step: 1,
      skill: "suggest_safe_domain",
      params: {
        brand: input.brand,
        intent: input.intent ?? "ops",
        count: 5,
        actorId: input.actorId
      },
      stepResults
    });
    chosenDomain = chooseDomain(suggestions);

    await runGatedStep({
      deps,
      runId,
      step: 2,
      skill: "register_domain_route53",
      actorId: input.actorId,
      approvalTimeoutMs,
      estimatedCostUsd: 15,
      budgetUsdMax: input.budgetUsdMax,
      params: { domain: chosenDomain, years: 1, autoRenew: false },
      stepResults
    });

    await runGatedStep({
      deps,
      runId,
      step: 3,
      skill: "wait_for_dns_propagation",
      actorId: input.actorId,
      approvalTimeoutMs,
      budgetUsdMax: input.budgetUsdMax,
      params: {
        domain: chosenDomain,
        expectedRecord: { type: "NS", value: "contains:awsdns" },
        maxWaitMs: 1_800_000,
        pollIntervalMs: 60_000
      },
      stepResults
    });

    const vps = await runGatedStep({
      deps,
      runId,
      step: 4,
      skill: "create_webdock_server",
      actorId: input.actorId,
      approvalTimeoutMs,
      estimatedCostUsd: 4.30 / 30,
      budgetUsdMax: input.budgetUsdMax,
      params: {
        profile: "bit",
        locationId: "dk",
        hostname: chosenDomain,
        imageSlug: "ubuntu-2404"
      },
      stepResults
    });
    serverSlug = stringFromOutcome(vps.outcome, ["slug", "serverSlug"]);
    serverIpv4 = stringFromOutcome(vps.outcome, ["ipv4", "serverIp"]);

    await runReadOnlyStep({
      deps,
      runId,
      step: 5,
      skill: "wait_server_running",
      params: { serverSlug, maxWaitMs: 600_000 },
      stepResults
    });

    await runGatedStep({
      deps,
      runId,
      step: 6,
      skill: "bind_webdock_main_domain",
      actorId: input.actorId,
      approvalTimeoutMs,
      budgetUsdMax: input.budgetUsdMax,
      params: { serverSlug, domain: chosenDomain },
      stepResults
    });

    await runGatedStep({
      deps,
      runId,
      step: 7,
      skill: "upsert_dns_route53",
      actorId: input.actorId,
      approvalTimeoutMs,
      budgetUsdMax: input.budgetUsdMax,
      params: {
        domain: chosenDomain,
        records: [
          { name: chosenDomain, type: "A", ttl: 300, values: [serverIpv4] },
          { name: chosenDomain, type: "MX", ttl: 300, values: [`10 ${chosenDomain}.`] }
        ]
      },
      stepResults
    });

    await runGatedStep({
      deps,
      runId,
      step: 8,
      skill: "wait_for_dns_propagation",
      actorId: input.actorId,
      approvalTimeoutMs,
      budgetUsdMax: input.budgetUsdMax,
      params: {
        domain: chosenDomain,
        expectedRecord: { type: "A", value: serverIpv4 },
        maxWaitMs: 600_000,
        pollIntervalMs: 30_000
      },
      stepResults
    });

    const smtp = await runGatedStep({
      deps,
      runId,
      step: 9,
      skill: "provision_smtp_postfix",
      actorId: input.actorId,
      approvalTimeoutMs,
      budgetUsdMax: input.budgetUsdMax,
      params: { serverSlug, domain: chosenDomain, serverIp: serverIpv4, selector: "s2026a" },
      stepResults
    });

    await runGatedStep({
      deps,
      runId,
      step: 10,
      skill: "configure_email_auth",
      actorId: input.actorId,
      approvalTimeoutMs,
      budgetUsdMax: input.budgetUsdMax,
      params: {
        domain: chosenDomain,
        mxServerIp: serverIpv4,
        selector: "s2026a",
        dmarcPolicy: "quarantine",
        dkimPublicKey: stringFromOutcome(smtp.outcome, ["dkimPublicKey"], "")
      },
      stepResults
    });

    await runGatedStep({
      deps,
      runId,
      step: 11,
      skill: "wait_for_dns_propagation",
      actorId: input.actorId,
      approvalTimeoutMs,
      budgetUsdMax: input.budgetUsdMax,
      params: {
        domain: `s2026a._domainkey.${chosenDomain}`,
        expectedRecord: { type: "TXT", value: "v=DKIM1" },
        maxWaitMs: 600_000,
        pollIntervalMs: 30_000
      },
      stepResults
    });

    await runGatedStep({
      deps,
      runId,
      step: 12,
      skill: "seed_warmup_pool",
      actorId: input.actorId,
      approvalTimeoutMs,
      budgetUsdMax: input.budgetUsdMax,
      params: {
        domain: chosenDomain,
        serverSlug,
        serverIp: serverIpv4,
        seedInboxes: input.seedInboxes ?? [input.testEmailRecipient]
      },
      stepResults
    });

    await runReadOnlyStep({
      deps,
      runId,
      step: 13,
      skill: "wait_warmup_initial",
      params: { domain: chosenDomain, expectedDeliveries: 5, maxWaitMs: 3_600_000 },
      stepResults
    });

    const realEmail = await runGatedStep({
      deps,
      runId,
      step: 14,
      skill: "send_real_email",
      actorId: input.actorId,
      approvalTimeoutMs,
      budgetUsdMax: input.budgetUsdMax,
      params: {
        fromAddress: `hello@${chosenDomain}`,
        toAddress: input.testEmailRecipient,
        subject: input.testEmailSubject,
        body: input.testEmailBody,
        serverSlug
      },
      stepResults
    });

    const totalDurationMs = elapsed(deps, startedMs);
    const totalCostUsd = roundUsd(totalEstimatedCost(stepResults));
    await audit(deps, "oc.orchestrator.run_completed", "openclaw_orchestrator_run", runId, "high", {
      stepCount: stepResults.length,
      totalCostUsd,
      totalDurationMs
    });
    await compactRunIntent(deps, {
      runId,
      status: "completed",
      decision: "configure_complete_smtp completed all 14 steps",
      stepResults
    });
    await emitRunAction(deps, runId, "oc.orchestrator.run_completed", "low");
    await emitRunTask(deps, runId, "completed");
    void logger.info("openclaw.orchestrator.run_completed", "configure_complete_smtp completed.", {
      runId,
      stepCount: stepResults.length,
      totalCostUsd,
      totalDurationMs,
      finalDeliveryStatus: normalizeDeliveryStatus(stringFromOutcome(realEmail.outcome, ["deliveryStatus"], undefined))
    });

    return {
      runId,
      status: "completed",
      stepResults,
      totalDurationMs,
      totalCostUsd,
      finalEmailMessageId: stringFromOutcome(realEmail.outcome, ["messageId"], undefined),
      finalDeliveryStatus: normalizeDeliveryStatus(stringFromOutcome(realEmail.outcome, ["deliveryStatus"], undefined))
    };
  } catch (error) {
    const failure = normalizeFailure(error);
    await emitStep(deps, "oc.orchestrator.step_failed", runId, failure.step, failure.skill, {
      error: failure.message,
      status: failure.status
    });
    await audit(deps, "oc.orchestrator.step_failed", "openclaw_orchestrator_run", runId, "high", {
      step: failure.step,
      skill: failure.skill,
      error: failure.message,
      status: failure.status
    });

    if (serverSlug && failure.step >= 6 && deps.submitRollbackProposal) {
      void logger.warn("openclaw.orchestrator.rollback_proposal_requested", "configure_complete_smtp requested rollback proposal after failure.", {
        runId,
        failedStep: failure.step,
        skill: failure.skill,
        serverSlug,
        chosenDomain
      });
      const rollback = await deps.submitRollbackProposal({
        runId,
        failedStep: failure.step,
        skill: "delete_webdock_server",
        params: { serverSlug, domain: chosenDomain },
        actorId: input.actorId,
        reason: `configure_complete_smtp failed at step ${failure.step}: ${failure.message}`
      });
      rollbackProposalId = rollback.proposalId;
    }

    await compactRunIntent(deps, {
      runId,
      status: failure.status === "cancelled_by_operator" ? "cancelled" : "failed",
      decision: `configure_complete_smtp failed at step ${failure.step}: ${failure.message}`,
      stepResults,
      failure
    });
    await emitRunAction(deps, runId, "oc.orchestrator.run_failed", "high");
    await emitRunTask(deps, runId, "failed");
    void logger.error("openclaw.orchestrator.run_failed", "configure_complete_smtp failed.", {
      runId,
      failedStep: failure.step,
      skill: failure.skill,
      status: failure.status,
      error: failure.message,
      rollbackProposalId
    });
    return {
      runId,
      status: failure.status,
      stepResults,
      totalDurationMs: elapsed(deps, startedMs),
      totalCostUsd: roundUsd(totalEstimatedCost(stepResults)),
      rollbackProposalId,
      error: failure.message,
      failedStep: failure.step
    };
  }
}

async function runReadOnlyStep(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<unknown> {
  await verifyAuditChain(input.deps);
  void (input.deps.logger ?? noopGatewayRuntimeLogger).info("openclaw.orchestrator.step_started", "Read-only orchestrator step started.", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    approvalRequired: false,
    params: summarizeOperationalParams(input.params)
  });
  await emitStep(input.deps, "oc.orchestrator.step_started", input.runId, input.step, input.skill, {
    approvalRequired: false
  });
  const startedAt = Date.now();
  const inputHash = hashInput(input.params);
  const outcome = await input.deps.invokeSkill({
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    params: input.params
  });
  const result = {
    step: input.step,
    skill: input.skill,
    inputHash,
    outcome,
    durationMs: Date.now() - startedAt
  };
  input.stepResults.push(result);
  await emitStep(input.deps, "oc.orchestrator.step_completed", input.runId, input.step, input.skill, {
    durationMs: result.durationMs
  });
  void (input.deps.logger ?? noopGatewayRuntimeLogger).info("openclaw.orchestrator.step_completed", "Read-only orchestrator step completed.", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    durationMs: result.durationMs
  });
  return outcome;
}

async function runGatedStep(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  actorId: string;
  approvalTimeoutMs: number;
  estimatedCostUsd?: number;
  budgetUsdMax: number;
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<ConfigureCompleteSmtpStepResult> {
  await verifyAuditChain(input.deps);
  const inputHash = hashInput(input.params);
  ensureBudgetForStep(input, inputHash);
  void (input.deps.logger ?? noopGatewayRuntimeLogger).info("openclaw.orchestrator.step_started", "Gated orchestrator step started; operator approval required.", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    approvalRequired: true,
    estimatedCostUsd: input.estimatedCostUsd ?? 0,
    params: summarizeOperationalParams(input.params)
  });
  await emitStep(input.deps, "oc.orchestrator.step_started", input.runId, input.step, input.skill, {
    approvalRequired: true,
    estimatedCostUsd: input.estimatedCostUsd ?? 0
  });
  const approvalTimeoutMs = approvalTimeoutForStep(input.skill, input.params, input.approvalTimeoutMs);
  void (input.deps.logger ?? noopGatewayRuntimeLogger).info("openclaw.orchestrator.awaiting_approval", "Waiting for ApprovalGate signature.", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    approvalTimeoutMs
  });
  const decision = await input.deps.submitAndAwaitApproval({
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    params: input.params,
    actorId: input.actorId,
    approvalTimeoutMs,
    estimatedCostUsd: input.estimatedCostUsd
  });

  if (decision.status === "executed") {
    const result: ConfigureCompleteSmtpStepResult = {
      step: input.step,
      skill: input.skill,
      inputHash,
      proposalId: decision.proposalId,
      signatureId: decision.signatureId,
      outcome: decision.outcome,
      durationMs: decision.durationMs,
      ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: input.estimatedCostUsd })
    };
    input.stepResults.push(result);
    await emitStep(input.deps, "oc.orchestrator.step_completed", input.runId, input.step, input.skill, {
      proposalId: decision.proposalId,
      durationMs: decision.durationMs
    });
    void (input.deps.logger ?? noopGatewayRuntimeLogger).info("openclaw.orchestrator.step_completed", "Gated orchestrator step executed.", {
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      proposalId: decision.proposalId,
      signatureId: decision.signatureId,
      statusCode: decision.statusCode,
      durationMs: decision.durationMs
    });
    return result;
  }

  if (decision.status === "rejected") {
    void (input.deps.logger ?? noopGatewayRuntimeLogger).warn("openclaw.orchestrator.step_rejected", "Operator rejected gated orchestrator step.", {
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      proposalId: decision.proposalId,
      reason: decision.reason
    });
    throw new OrchestratorFailure(
      "cancelled_by_operator",
      input.step,
      input.skill,
      decision.reason ?? "operator_rejected",
      decision.proposalId,
      inputHash
    );
  }

  if (decision.status === "approval_timeout" || decision.status === "execution_timeout") {
    void (input.deps.logger ?? noopGatewayRuntimeLogger).warn(`openclaw.orchestrator.${decision.status}`, "Gated orchestrator step timed out.", {
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      proposalId: decision.proposalId,
      timeoutMs: decision.timeoutMs
    });
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      decision.status,
      decision.proposalId,
      inputHash
    );
  }

  void (input.deps.logger ?? noopGatewayRuntimeLogger).error("openclaw.orchestrator.step_execution_failed", "Gated orchestrator step execution failed.", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    proposalId: decision.proposalId,
    statusCode: "statusCode" in decision ? decision.statusCode : undefined,
    error: "error" in decision ? decision.error : undefined,
    outcome: "outcome" in decision ? decision.outcome : undefined
  });
  const failureMessage = "error" in decision ? decision.error ?? "execution_failed" : "execution_failed";
  input.stepResults.push({
    step: input.step,
    skill: input.skill,
    inputHash,
    proposalId: decision.proposalId,
    outcome: "outcome" in decision ? decision.outcome ?? { error: failureMessage } : { error: failureMessage },
    durationMs: "durationMs" in decision ? decision.durationMs : 0,
    ...("signatureId" in decision && decision.signatureId ? { signatureId: decision.signatureId } : {}),
    ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: input.estimatedCostUsd })
  });
  throw new OrchestratorFailure(
    "failed",
    input.step,
    input.skill,
    failureMessage,
    decision.proposalId,
    inputHash
  );
}

async function verifyAuditChain(deps: ConfigureCompleteSmtpDeps): Promise<void> {
  const chain = await deps.verifyAuditChain?.();
  if (chain && !chain.ok) {
    throw new OrchestratorFailure("failed", 0, "audit_chain", "audit_chain_broken");
  }
}

async function emitRunTask(
  deps: ConfigureCompleteSmtpDeps,
  runId: string,
  status: "running" | "completed" | "failed",
  input: { title?: string; createdAt?: string } = {}
): Promise<void> {
  const now = (deps.now?.() ?? new Date()).toISOString();
  if (status === "running") {
    await safeEmit(deps, {
      type: "oc.task.declare",
      taskId: runId,
      title: input.title ?? `configure_complete_smtp · ${runId}`,
      status: "running",
      createdAt: input.createdAt ?? now,
      actorId: "openclaw/configure_complete_smtp"
    } as CanvasLiveEvent);
    return;
  }

  await safeEmit(deps, {
    type: "oc.task.update",
    taskId: runId,
    status,
    updatedAt: now
  } as CanvasLiveEvent);
}

async function emitRunAction(
  deps: ConfigureCompleteSmtpDeps,
  runId: string,
  action: "oc.orchestrator.run_started" | "oc.orchestrator.run_completed" | "oc.orchestrator.run_failed",
  riskLevel: "low" | "high"
): Promise<void> {
  await safeEmit(deps, {
    type: "oc.action.now",
    taskId: runId,
    kind: "audit",
    action,
    targetType: "openclaw_orchestrator_run",
    targetId: runId,
    riskLevel,
    occurredAt: (deps.now?.() ?? new Date()).toISOString()
  } as CanvasLiveEvent);
}

async function emitStep(
  deps: ConfigureCompleteSmtpDeps,
  action: "oc.orchestrator.step_started" | "oc.orchestrator.step_completed" | "oc.orchestrator.step_failed",
  runId: string,
  step: number,
  skill: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await safeEmit(deps, {
    type: "oc.action.now",
    taskId: runId,
    kind: "audit",
    action,
    targetType: "openclaw_orchestrator_step",
    targetId: `${runId}:${step}:${skill}`,
    riskLevel: action.endsWith("failed") ? "high" : "low",
    occurredAt: (deps.now?.() ?? new Date()).toISOString()
  } as CanvasLiveEvent);
  void metadata;
}

async function safeEmit(deps: ConfigureCompleteSmtpDeps, event: CanvasLiveEvent): Promise<void> {
  if (!deps.canvasLiveEvents) return;
  try {
    await deps.canvasLiveEvents.emit(event);
  } catch (error) {
    console.error("[canvas-live] emit failed for event", event.type, errorMessage(error));
  }
}

function approvalTimeoutForStep(skill: string, params: Record<string, unknown>, baseTimeoutMs: number): number {
  const maxWaitMs = positiveIntFromUnknown(params.maxWaitMs);
  const pollIntervalMs = positiveIntFromUnknown(params.pollIntervalMs) ?? 0;
  if (skill === "wait_for_dns_propagation" && maxWaitMs !== undefined) {
    return Math.max(baseTimeoutMs, maxWaitMs + pollIntervalMs + longRunningStepTimeoutPaddingMs);
  }
  return baseTimeoutMs;
}

async function audit(
  deps: ConfigureCompleteSmtpDeps,
  action: string,
  targetType: string,
  targetId: string,
  riskLevel: "low" | "medium" | "high" | "critical",
  metadata: Record<string, unknown>
): Promise<void> {
  await deps.auditLog.append({
    actorType: "openclaw",
    actorId: "configure_complete_smtp",
    action,
    targetType,
    targetId,
    riskLevel,
    decision: "n/a",
    metadata
  });
}

function chooseDomain(outcome: unknown): string {
  const candidates = isRecord(outcome) && Array.isArray(outcome.candidates) ? outcome.candidates : [];
  const first = candidates.find(isRecord);
  if (!first || typeof first.domain !== "string" || !first.domain.trim()) {
    throw new OrchestratorFailure("failed", 1, "suggest_safe_domain", "no_domain_candidate");
  }
  return first.domain.trim().toLowerCase().replace(/\.$/, "");
}

function stringFromOutcome(
  outcome: unknown,
  keys: string[],
  fallback?: string
): string {
  if (isRecord(outcome)) {
    for (const key of keys) {
      const value = outcome[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  if (fallback !== undefined) return fallback;
  throw new OrchestratorFailure("failed", 0, "outcome_parser", `missing ${keys.join("/")}`);
}

function normalizeDeliveryStatus(value: string | undefined): "queued" | "delivered" | "deferred" | "bounced" | undefined {
  if (value === "queued" || value === "deferred" || value === "bounced") return value;
  if (value === "sent" || value === "delivered") return "delivered";
  return undefined;
}

function normalizeFailure(error: unknown): OrchestratorFailure {
  if (error instanceof OrchestratorFailure) return error;
  return new OrchestratorFailure("failed", 0, "configure_complete_smtp", errorMessage(error));
}

async function compactRunIntent(
  deps: ConfigureCompleteSmtpDeps,
  input: {
    runId: string;
    status: "completed" | "failed" | "cancelled" | "rolled_back";
    decision: string;
    stepResults: ConfigureCompleteSmtpStepResult[];
    failure?: OrchestratorFailure;
  }
): Promise<void> {
  if (!deps.compactIntent) return;
  const steps: CompactIntentStepInput[] = input.stepResults.map((step) => compactStepFromResult(step, input.failure));
  const failureAlreadyRecorded = input.failure
    ? steps.some((step) => step.step === input.failure?.step && step.tool === input.failure?.skill)
    : true;
  if (input.failure && !failureAlreadyRecorded) {
    steps.push({
      step: input.failure.step,
      tool: input.failure.skill,
      inputHash: input.failure.inputHash ?? hashInput({ failure: input.failure.message, proposalId: input.failure.proposalId }),
      outcome: failureOutcome(input.failure),
      errorClass: input.failure.status,
      errorMessage: input.failure.message,
      durationMs: 0,
      ...(input.failure.proposalId ? { proposalId: input.failure.proposalId } : {})
    });
  }

  try {
    await deps.compactIntent({
      intentId: input.runId,
      finalStatus: input.status,
      decision: input.decision.slice(0, 280),
      ttlDays: positiveInt(deps.env?.OPENCLAW_EPISODIC_SCRATCH_TTL_DAYS) ?? 30,
      steps
    });
  } catch (error) {
    void (deps.logger ?? noopGatewayRuntimeLogger).warn("openclaw.orchestrator.compact_intent_failed", "Episodic memory compaction failed.", {
      runId: input.runId,
      status: input.status,
      error: errorMessage(error)
    });
  }
}

function compactStepFromResult(
  step: ConfigureCompleteSmtpStepResult,
  failure: OrchestratorFailure | undefined
): CompactIntentStepInput {
  const isFailureStep = failure && step.step === failure.step && step.skill === failure.skill;
  const isAfterFailure = failure && step.step > failure.step;
  return {
    step: step.step,
    tool: step.skill,
    inputHash: step.inputHash,
    outcome: isFailureStep ? failureOutcome(failure) : isAfterFailure ? "partial" : "success",
    outcomeData: summarizeOutcome(step.outcome),
    durationMs: step.durationMs,
    ...(isFailureStep ? {
      errorClass: failure.status,
      errorMessage: failure.message
    } : {}),
    ...(isAfterFailure ? {
      errorClass: "not_executed_after_failure",
      errorMessage: `Step ${step.step} was recorded after failure at step ${failure.step}.`
    } : {}),
    ...(step.proposalId ? { proposalId: step.proposalId } : {}),
    ...(step.signatureId ? { signatureId: step.signatureId } : {})
  };
}

function failureOutcome(failure: OrchestratorFailure): "failed" | "cancelled_by_operator" | "timeout" {
  if (failure.status === "cancelled_by_operator") return "cancelled_by_operator";
  if (failure.message.includes("timeout")) return "timeout";
  return "failed";
}

function summarizeOutcome(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { value };
  }
  const entries = Object.entries(value)
    .filter(([key]) => !/token|secret|password|private|api[_-]?key|credential|authorization/i.test(key))
    .slice(0, 20);
  return Object.fromEntries(entries);
}

function totalEstimatedCost(results: ConfigureCompleteSmtpStepResult[]): number {
  return results.reduce((total, step) => total + (step.estimatedCostUsd ?? extractCost(step.outcome)), 0);
}

function ensureBudgetForStep(
  input: {
    deps: ConfigureCompleteSmtpDeps;
    runId: string;
    step: number;
    skill: string;
    estimatedCostUsd?: number;
    budgetUsdMax: number;
    stepResults: ConfigureCompleteSmtpStepResult[];
  },
  inputHash: string
): void {
  const estimatedCostUsd = input.estimatedCostUsd ?? 0;
  if (estimatedCostUsd <= 0) {
    return;
  }

  const committedCostUsd = totalEstimatedCost(input.stepResults);
  const projectedCostUsd = roundUsd(committedCostUsd + estimatedCostUsd);
  if (projectedCostUsd <= input.budgetUsdMax) {
    return;
  }

  void (input.deps.logger ?? noopGatewayRuntimeLogger).warn("openclaw.orchestrator.budget_exceeded", "Gated orchestrator step blocked by budget cap.", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    committedCostUsd: roundUsd(committedCostUsd),
    estimatedCostUsd: roundUsd(estimatedCostUsd),
    projectedCostUsd,
    budgetUsdMax: input.budgetUsdMax
  });
  throw new OrchestratorFailure(
    "failed",
    input.step,
    input.skill,
    `budget_exceeded: projected_cost_usd=${projectedCostUsd} budget_usd_max=${input.budgetUsdMax}`,
    undefined,
    inputHash
  );
}

function extractCost(outcome: unknown): number {
  if (!isRecord(outcome)) return 0;
  for (const key of ["costUsd", "priceUsd", "estimatedCostUsd"]) {
    const value = outcome[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function elapsed(deps: ConfigureCompleteSmtpDeps, startedMs: number): number {
  return Math.max(0, (deps.now?.() ?? new Date()).getTime() - startedMs);
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveIntFromUnknown(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function hashInput(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const raw = await readRequestBody(request);
  return raw.trim() ? JSON.parse(raw) : {};
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown orchestrator error";
}

class OrchestratorFailure extends Error {
  readonly status: Exclude<ConfigureSmtpStatus, "completed" | "executing" | "rolled_back">;
  readonly step: number;
  readonly skill: string;
  readonly proposalId?: string;
  readonly inputHash?: string;

  constructor(
    status: Exclude<ConfigureSmtpStatus, "completed" | "executing" | "rolled_back">,
    step: number,
    skill: string,
    message: string,
    proposalId?: string,
    inputHash?: string
  ) {
    super(message);
    this.status = status;
    this.step = step;
    this.skill = skill;
    this.proposalId = proposalId;
    this.inputHash = inputHash;
  }
}

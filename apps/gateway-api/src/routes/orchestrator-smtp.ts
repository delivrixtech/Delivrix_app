import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEventInput,
  CanvasLiveEvent
} from "../../../../packages/domain/src/index.ts";
import {
  configureCompleteSmtpParamSchema,
  type ConfigureCompleteSmtpParams
} from "../skill-schemas.ts";

export type ConfigureSmtpStatus =
  | "completed"
  | "executing"
  | "failed"
  | "rolled_back"
  | "cancelled_by_operator";

export interface ConfigureCompleteSmtpStepResult {
  step: number;
  skill: string;
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
  env?: Record<string, string | undefined>;
  now?: () => Date;
  randomId?: () => string;
}

const defaultApprovalTimeoutMs = 10 * 60 * 1000;
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
      params: {
        domain: chosenDomain,
        expectedRecord: { type: "NS", value: "awsdns" },
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
  await emitStep(input.deps, "oc.orchestrator.step_started", input.runId, input.step, input.skill, {
    approvalRequired: false
  });
  const startedAt = Date.now();
  const outcome = await input.deps.invokeSkill({
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    params: input.params
  });
  const result = {
    step: input.step,
    skill: input.skill,
    outcome,
    durationMs: Date.now() - startedAt
  };
  input.stepResults.push(result);
  await emitStep(input.deps, "oc.orchestrator.step_completed", input.runId, input.step, input.skill, {
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
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<ConfigureCompleteSmtpStepResult> {
  await verifyAuditChain(input.deps);
  await emitStep(input.deps, "oc.orchestrator.step_started", input.runId, input.step, input.skill, {
    approvalRequired: true,
    estimatedCostUsd: input.estimatedCostUsd ?? 0
  });
  const decision = await input.deps.submitAndAwaitApproval({
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    params: input.params,
    actorId: input.actorId,
    approvalTimeoutMs: input.approvalTimeoutMs,
    estimatedCostUsd: input.estimatedCostUsd
  });

  if (decision.status === "executed") {
    const result: ConfigureCompleteSmtpStepResult = {
      step: input.step,
      skill: input.skill,
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
    return result;
  }

  if (decision.status === "rejected") {
    throw new OrchestratorFailure(
      "cancelled_by_operator",
      input.step,
      input.skill,
      decision.reason ?? "operator_rejected",
      decision.proposalId
    );
  }

  if (decision.status === "approval_timeout" || decision.status === "execution_timeout") {
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      decision.status,
      decision.proposalId
    );
  }

  throw new OrchestratorFailure(
    "failed",
    input.step,
    input.skill,
    "error" in decision ? decision.error ?? "execution_failed" : "execution_failed",
    decision.proposalId
  );
}

async function verifyAuditChain(deps: ConfigureCompleteSmtpDeps): Promise<void> {
  const chain = await deps.verifyAuditChain?.();
  if (chain && !chain.ok) {
    throw new OrchestratorFailure("failed", 0, "audit_chain", "audit_chain_broken");
  }
}

async function emitStep(
  deps: ConfigureCompleteSmtpDeps,
  action: "oc.orchestrator.step_started" | "oc.orchestrator.step_completed" | "oc.orchestrator.step_failed",
  runId: string,
  step: number,
  skill: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await deps.canvasLiveEvents?.emit({
    type: "oc.action.now",
    taskId: runId,
    kind: "audit",
    action,
    targetType: "openclaw_orchestrator_step",
    targetId: `${runId}:${step}:${skill}`,
    riskLevel: action.endsWith("failed") ? "high" : "low",
    occurredAt: (deps.now?.() ?? new Date()).toISOString(),
    metadata: { runId, step, skill, ...metadata }
  } as CanvasLiveEvent & { metadata: Record<string, unknown> });
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

function totalEstimatedCost(results: ConfigureCompleteSmtpStepResult[]): number {
  return results.reduce((total, step) => total + (step.estimatedCostUsd ?? extractCost(step.outcome)), 0);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
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

  constructor(
    status: Exclude<ConfigureSmtpStatus, "completed" | "executing" | "rolled_back">,
    step: number,
    skill: string,
    message: string,
    proposalId?: string
  ) {
    super(message);
    this.status = status;
    this.step = step;
    this.skill = skill;
    this.proposalId = proposalId;
  }
}

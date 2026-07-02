import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEvent,
  AuditEventInput,
  AuditRiskLevel,
  CanvasLiveArtifactSnapshot
} from "../../../../packages/domain/src/index.ts";
import { stableStringify } from "../../../../packages/storage/src/stable-stringify.ts";
import { issueApprovalToken } from "../security/approval-token.ts";
import { validateOpenClawHmac } from "../security/hmac.ts";
import type { AuditChainVerifyResult } from "../audit-chain.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import type { DispatchResult, SkillDispatcher } from "../skill-dispatcher.ts";
import {
  canonicalSkillSlug,
  hashSkillExecutionContext,
  validateSkillActionBinding
} from "../skill-contracts.ts";
import {
  noopGatewayRuntimeLogger,
  summarizeOperationalParams,
  type GatewayRuntimeLogger
} from "../gateway-runtime-log.ts";
import { readRequestBody } from "../request-body.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<AuditEvent>;
  list?(): Promise<AuditEvent[]>;
}

interface AuditChainVerifier {
  verify(): Promise<AuditChainVerifyResult>;
}

interface CanvasStateWriter {
  upsertArtifact(input: CanvasLiveArtifactSnapshot): Promise<unknown>;
}

interface WebhookBroadcaster {
  broadcast(event: AuditEventInput): Promise<unknown>;
}

interface KillSwitchState {
  enabled: boolean;
}

export interface PlanApprovalScope {
  runId: string;
  domain: string;
  provider: string;
  vpsProviderId?: string;
  serverAccountId?: string;
  reuseServerSlug?: string;
  requireExistingDomain?: boolean;
  budgetUsdMax: number;
  recipient: string;
  plannedSkill: "configure_complete_smtp";
  plannedSteps: string[];
}

export interface PlanApprovalRecord {
  status: "signed";
  signedAt: string;
  expiresAt: string;
  signatureId: string;
  scopeHash: string;
  scope: PlanApprovalScope;
  flagEnabled: true;
}

export interface ProposalSignStoredProposal {
  id: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  headline?: string;
  body?: string;
  runbookRef?: string;
  targetRef: string;
  targetType?: string;
  skillSlug?: string;
  params?: unknown;
  proposalHash?: string;
  delivrix_actions_required?: string[];
  requiresApproval: boolean;
  status: string;
  expiresAt: string;
  artifactSnapshot?: CanvasLiveArtifactSnapshot;
  signedAt?: string;
  signatureId?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  executionOutcome?: unknown;
  executionStatusCode?: number;
  executionDurationMs?: number;
  executionCompletedAt?: string;
  planApproval?: PlanApprovalRecord;
}

export interface HandleProposalSignDeps {
  request: IncomingMessage;
  response: ServerResponse;
  proposalId: string;
  auditLog: AuditSink;
  auditChain: AuditChainVerifier;
  proposalsStore: ProposalSignStoredProposal[];
  canvasState: CanvasStateWriter;
  webhookBroadcaster?: WebhookBroadcaster;
  dispatcher: SkillDispatcher;
  readKillSwitch: () => Promise<KillSwitchState> | KillSwitchState;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  logger?: GatewayRuntimeLogger;
}

interface SignBody {
  actorId?: unknown;
  reason?: unknown;
  signature?: unknown;
  signatureMetadata?: unknown;
}

export async function handleProposalSign(deps: HandleProposalSignDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const logger = deps.logger ?? noopGatewayRuntimeLogger;
  const killSwitch = await deps.readKillSwitch();
  if (killSwitch.enabled) {
    void logger.warn("openclaw.proposal.sign_blocked", "Proposal signature blocked by kill switch.", {
      proposalId: deps.proposalId
    });
    return json(deps.response, 423, {
      ok: false,
      rejectReason: "kill_switch_armed"
    });
  }

  if (!isUuidV4(deps.proposalId)) {
    return json(deps.response, 400, {
      ok: false,
      rejectReason: "schema_mismatch",
      details: "proposalId must be a UUID v4."
    });
  }

  const { raw, body } = await readRawBodyAndJson<SignBody>(deps.request);
  const parsed = parseSignBody(body);
  if (!parsed.ok) {
    void logger.warn("openclaw.proposal.sign_rejected", "Proposal signature body failed validation.", {
      proposalId: deps.proposalId,
      reason: "schema_mismatch",
      details: parsed.details
    });
    return json(deps.response, 400, {
      ok: false,
      rejectReason: "schema_mismatch",
      details: parsed.details
    });
  }

  const auth = validateRequestAuth({
    request: deps.request,
    raw,
    env: deps.env
  });
  if (!auth.ok) {
    void logger.warn("openclaw.proposal.sign_rejected", "Proposal signature auth failed.", {
      proposalId: deps.proposalId,
      reason: auth.rejectReason,
      details: auth.details
    });
    return json(deps.response, 401, {
      ok: false,
      rejectReason: auth.rejectReason,
      details: auth.details
    });
  }

  const proposal = deps.proposalsStore.find((candidate) => candidate.id === deps.proposalId);
  if (!proposal) {
    void logger.warn("openclaw.proposal.sign_rejected", "Proposal signature requested for missing proposal.", {
      proposalId: deps.proposalId,
      reason: "proposal_not_found"
    });
    return json(deps.response, 404, {
      ok: false,
      rejectReason: "proposal_not_found"
    });
  }

  if (proposal.status !== "pending") {
    void logger.warn("openclaw.proposal.sign_rejected", "Proposal signature requested for non-pending proposal.", {
      proposalId: proposal.id,
      reason: "proposal_not_pending",
      currentStatus: proposal.status
    });
    return json(deps.response, 409, {
      ok: false,
      rejectReason: "proposal_not_pending",
      currentStatus: proposal.status
    });
  }

  if (Date.parse(proposal.expiresAt) <= now.getTime()) {
    proposal.status = "expired";
    await deps.auditLog.append({
      actorType: "system",
      actorId: "gateway-api",
      action: "oc.proposal.expired",
      targetType: "proposal",
      targetId: proposal.id,
      riskLevel: riskLevelFromProposalSeverity(proposal.severity),
      decision: "reject",
      metadata: { expiresAt: proposal.expiresAt }
    });
    void logger.warn("openclaw.proposal.sign_rejected", "Proposal expired before signature.", {
      proposalId: proposal.id,
      reason: "proposal_expired",
      expiresAt: proposal.expiresAt
    });
    return json(deps.response, 410, {
      ok: false,
      rejectReason: "proposal_expired"
    });
  }

  if (!proposal.requiresApproval) {
    void logger.warn("openclaw.proposal.sign_rejected", "Proposal does not require approval.", {
      proposalId: proposal.id,
      reason: "proposal_does_not_require_approval"
    });
    return json(deps.response, 409, {
      ok: false,
      rejectReason: "proposal_does_not_require_approval"
    });
  }

  const chain = await deps.auditChain.verify();
  if (!chain.ok) {
    void logger.error("openclaw.proposal.sign_rejected", "Audit chain is broken; signature blocked.", {
      proposalId: proposal.id,
      reason: "audit_chain_broken",
      totalEvents: chain.totalEvents,
      brokenAt: chain.brokenAt
    });
    return json(deps.response, 503, {
      ok: false,
      rejectReason: "audit_chain_broken",
      lastValidSeq: chain.brokenAt ? chain.brokenAt.seq - 1 : chain.totalEvents
    });
  }

  const target = proposalTarget(proposal);
  const skill = skillForProposal(proposal);
  const actionBinding = validateSkillActionBinding({
    skill,
    actionIds: proposal.delivrix_actions_required ?? [],
    requireKnownSkill: true
  });
  if (!actionBinding.ok) {
    void logger.warn("openclaw.proposal.sign_rejected", "Proposal action binding failed.", {
      proposalId: proposal.id,
      skill,
      reason: actionBinding.rejectReason,
      expectedActionIds: actionBinding.expectedActionIds ?? []
    });
    return json(deps.response, 409, {
      ok: false,
      rejectReason: actionBinding.rejectReason,
      skill,
      expectedActionIds: actionBinding.expectedActionIds ?? []
    });
  }
  const executionContextHash = hashSkillExecutionContext({
    proposalId: proposal.id,
    skill: actionBinding.canonicalSkill,
    actionIds: proposal.delivrix_actions_required ?? [],
    targetType: target.type,
    targetId: target.id,
    params: proposal.params ?? {}
  });
  const signatureId = `sig_${randomUUID()}`;
  const planApprovalResolution = resolvePlanApproval({
    env: deps.env,
    proposal,
    skill: actionBinding.canonicalSkill,
    actorId: parsed.actorId,
    signatureId,
    now
  });
  if (planApprovalResolution.enabled && !planApprovalResolution.ok) {
    void logger.warn("openclaw.proposal.sign_rejected", "Plan approval scope failed validation.", {
      proposalId: proposal.id,
      reason: planApprovalResolution.rejectReason,
      details: planApprovalResolution.details
    });
    return json(deps.response, 422, {
      ok: false,
      rejectReason: planApprovalResolution.rejectReason,
      details: planApprovalResolution.details
    });
  }
  const token = issueApprovalToken({
    actionId: proposal.runbookRef || proposal.category,
    targetType: target.type,
    targetId: target.id,
    approverId: parsed.actorId
  }, now);
  const privateApprovalTokenHash = approvalTokenHash(token.tokenId);
  const planApproval = planApprovalResolution.enabled && planApprovalResolution.ok
    ? planApprovalResolution.planApproval
    : null;

  const signedEvent = await deps.auditLog.append({
    actorType: "operator",
    actorId: parsed.actorId,
    action: "oc.proposal.signed",
    targetType: "proposal",
    targetId: proposal.id,
    riskLevel: riskLevelFromProposalSeverity(proposal.severity),
    decision: "allow",
    humanApproved: true,
    approverIds: [parsed.actorId],
    metadata: {
      reason: parsed.reason,
      skillSlug: actionBinding.canonicalSkill,
      proposalHash: proposal.proposalHash ?? null,
      executionContextHash,
      signatureId,
      approvalTokenHash: privateApprovalTokenHash,
      authMode: auth.authMode,
      runbookRef: proposal.runbookRef ?? null,
      panelVersion: parsed.signatureMetadata.panelVersion ?? null,
      chainPrevHash: chain.lastHash,
      ...(planApproval ? {
        planApproval: {
          scopeHash: planApproval.scopeHash,
          scope: planApproval.scope,
          expiresAt: planApproval.expiresAt,
          flag: "OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE"
        }
      } : {})
    }
  });

  await deps.auditLog.append({
    actorType: "operator",
    actorId: parsed.actorId,
    action: "oc.artifact.approved",
    targetType: target.type,
    targetId: target.id,
    riskLevel: riskLevelFromProposalSeverity(proposal.severity),
    decision: "allow",
    humanApproved: true,
    approverIds: [parsed.actorId],
    metadata: {
      executionId: signatureId,
      proposalId: proposal.id,
      skillSlug: actionBinding.canonicalSkill,
      executionContextHash,
      approvalTokenHash: privateApprovalTokenHash
    }
  });

  if (planApproval) {
    proposal.planApproval = planApproval;
    await deps.auditLog.append({
      actorType: "operator",
      actorId: parsed.actorId,
      action: "oc.plan.signed",
      targetType: "openclaw_orchestrator_run",
      targetId: planApproval.scope.runId,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [parsed.actorId],
      metadata: {
        proposalId: proposal.id,
        signatureId,
        signedEventHash: signedEvent.hash ?? null,
        executionContextHash,
        scopeHash: planApproval.scopeHash,
        scope: planApproval.scope,
        expiresAt: planApproval.expiresAt,
        flag: "OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE"
      }
    });
  }

  await deps.canvasState.upsertArtifact(approvedArtifactSnapshot({
    proposal,
    executionId: signatureId,
    actorId: parsed.actorId,
    now
  }));

  proposal.status = "signed";
  proposal.signedAt = now.toISOString();
  proposal.signatureId = signatureId;
  void logger.info("openclaw.proposal.signed", "Operator signed ApprovalGate proposal; dispatch starting.", {
    proposalId: proposal.id,
    skill: actionBinding.canonicalSkill,
    actorId: parsed.actorId,
    signatureId,
    targetType: target.type,
    targetId: target.id,
    params: summarizeOperationalParams(isRecord(proposal.params) ? proposal.params : {})
  });

  const killSwitchBeforeDispatch = await deps.readKillSwitch();
  if (killSwitchBeforeDispatch.enabled) {
    proposal.status = "execution_failed";
    proposal.executionOutcome = { error: "kill_switch_armed" };
    proposal.executionStatusCode = 423;
    proposal.executionDurationMs = 0;
    proposal.executionCompletedAt = now.toISOString();
    const abortedInput = proposalExecutionAuditInput({
      proposal,
      actorId: parsed.actorId,
      action: "oc.proposal.aborted",
      riskLevel: riskLevelFromProposalSeverity(proposal.severity),
      dispatchResult: {
        ok: false,
        statusCode: 423,
        summary: { error: "kill_switch_armed" },
        durationMs: 0
      },
      skill: actionBinding.canonicalSkill,
      signatureId,
      signedEventHash: signedEvent.hash ?? null,
      executionContextHash,
      reason: "kill_switch_armed_before_dispatch"
    });
    await deps.auditLog.append(abortedInput);
    void logger.warn("openclaw.proposal.dispatch_aborted", "Proposal dispatch aborted because kill switch armed before execution.", {
      proposalId: proposal.id,
      skill: actionBinding.canonicalSkill,
      signatureId
    });
    return json(deps.response, 423, {
      ok: false,
      status: "aborted",
      rejectReason: "kill_switch_armed",
      proposalId: proposal.id,
      signatureId,
      ...(planApproval ? { planApproval: publicPlanApproval(planApproval) } : {}),
      signedAt: proposal.signedAt
    });
  }

  const dispatchResult = await deps.dispatcher.dispatch({
    skill: actionBinding.canonicalSkill,
    params: proposal.params ?? {},
    actorId: parsed.actorId,
    approvalToken: token,
    timeoutMs: 60_000
  });

  if (isDispatchTimeout(dispatchResult)) {
    proposal.status = "executing";
    await deps.auditLog.append({
      actorType: "operator",
      actorId: parsed.actorId,
      action: "oc.proposal.executing",
      targetType: "proposal",
      targetId: proposal.id,
      riskLevel: riskLevelFromProposalSeverity(proposal.severity),
      decision: "allow",
      humanApproved: true,
      approverIds: [parsed.actorId],
      metadata: {
        skillSlug: actionBinding.canonicalSkill,
        signatureId,
        executionContextHash,
        timeoutMs: 60_000
      }
    });
    if (dispatchResult.settled) {
      dispatchResult.settled
        .then((settled) => finalizeTimedOutDispatch({
          deps,
          proposal,
          actorId: parsed.actorId,
          skill: actionBinding.canonicalSkill,
          signatureId,
          signedEventHash: signedEvent.hash ?? null,
          executionContextHash,
          dispatchResult: settled
        }))
        .catch(() => undefined);
    }
    void logger.warn("openclaw.proposal.dispatch_executing", "Proposal dispatch exceeded synchronous window; polling continues.", {
      proposalId: proposal.id,
      skill: actionBinding.canonicalSkill,
      signatureId,
      timeoutMs: 60_000
    });
    return json(deps.response, 202, {
      ok: true,
      status: "executing",
      proposalId: proposal.id,
      signatureId,
      signedAt: proposal.signedAt,
      ...(planApproval ? { planApproval: publicPlanApproval(planApproval) } : {}),
      pollEndpoint: `/v1/openclaw/proposals/${encodeURIComponent(proposal.id)}/status`
    });
  }

  proposal.status = dispatchResult.ok ? "executed" : "execution_failed";
  proposal.executionOutcome = redactSecrets(dispatchResult.summary);
  proposal.executionStatusCode = dispatchResult.statusCode;
  proposal.executionDurationMs = dispatchResult.durationMs;
  proposal.executionCompletedAt = now.toISOString();
  const executedInput = proposalExecutionAuditInput({
    proposal,
    actorId: parsed.actorId,
    action: dispatchResult.statusCode === 423 ? "oc.proposal.aborted" : "oc.proposal.executed",
    riskLevel: riskLevelFromProposalSeverity(proposal.severity),
    dispatchResult,
    skill: actionBinding.canonicalSkill,
    signatureId,
    signedEventHash: signedEvent.hash ?? null,
    executionContextHash,
    reason: dispatchResult.statusCode === 423 ? "kill_switch_armed_mid_execution" : undefined
  });
  await deps.auditLog.append(executedInput);
  const webhookBroadcast = await deps.webhookBroadcaster?.broadcast(executedInput).catch((error) => ({
    delivered: false,
    buffered: false,
    error: errorMessage(error)
  }));

  void (dispatchResult.ok
    ? logger.info("openclaw.proposal.dispatch_executed", "Proposal dispatch executed successfully.", {
      proposalId: proposal.id,
      skill: actionBinding.canonicalSkill,
      signatureId,
      statusCode: dispatchResult.statusCode,
      durationMs: dispatchResult.durationMs
    })
    : logger.error("openclaw.proposal.dispatch_failed", "Proposal dispatch failed.", {
      proposalId: proposal.id,
      skill: actionBinding.canonicalSkill,
      signatureId,
      statusCode: dispatchResult.statusCode,
      durationMs: dispatchResult.durationMs,
      outcome: redactSecrets(dispatchResult.summary)
    }));

  return json(deps.response, dispatchResult.ok ? 200 : 502, {
    ok: dispatchResult.ok,
    status: dispatchResult.ok ? "executed" : "execution_failed",
    proposalId: proposal.id,
    signatureId,
    signedAt: proposal.signedAt,
    skill: actionBinding.canonicalSkill,
    ...(planApproval ? { planApproval: publicPlanApproval(planApproval) } : {}),
    outcome: redactSecrets(dispatchResult.summary),
    webhookBroadcast: webhookBroadcast ?? null
  });
}

function parseSignBody(body: SignBody | null): {
  ok: true;
  actorId: string;
  reason: string;
  signatureMetadata: Record<string, string>;
} | { ok: false; details: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, details: "Request body must be a JSON object." };
  }
  const actorId = normalizeActorId(body.actorId);
  if (!actorId) {
    return { ok: false, details: "actorId must be 3-64 chars and use operator-safe characters." };
  }
  const reason = normalizeReason(body.reason, body.signature);
  if (!reason) {
    return { ok: false, details: "reason must be 10-500 chars." };
  }
  const metadata = normalizeSignatureMetadata(body.signatureMetadata);
  if (!metadata.ok) {
    return { ok: false, details: metadata.details };
  }
  return {
    ok: true,
    actorId,
    reason,
    signatureMetadata: metadata.value
  };
}

const configureCompleteSmtpPlanSteps = [
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
] as const;

function resolvePlanApproval(input: {
  env?: Record<string, string | undefined>;
  proposal: ProposalSignStoredProposal;
  skill: string;
  actorId: string;
  signatureId: string;
  now: Date;
}): { enabled: false } | {
  enabled: true;
  ok: true;
  planApproval: PlanApprovalRecord;
} | {
  enabled: true;
  ok: false;
  rejectReason: "plan_scope_missing";
  details: string[];
} {
  if (!envFlagEnabled(input.env?.OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE)) {
    return { enabled: false };
  }
  if (input.skill !== "configure_complete_smtp") {
    return { enabled: false };
  }

  const scope = extractConfigureCompleteSmtpPlanScope(input.proposal.params);
  if (!scope.ok) {
    return {
      enabled: true,
      ok: false,
      rejectReason: "plan_scope_missing",
      details: scope.details
    };
  }

  return {
    enabled: true,
    ok: true,
    planApproval: {
      status: "signed",
      signedAt: input.now.toISOString(),
      expiresAt: input.proposal.expiresAt,
      signatureId: input.signatureId,
      scopeHash: hashPlanApprovalScope(scope.value),
      scope: scope.value,
      flagEnabled: true
    }
  };
}

function extractConfigureCompleteSmtpPlanScope(params: unknown): {
  ok: true;
  value: PlanApprovalScope;
} | {
  ok: false;
  details: string[];
} {
  const details: string[] = [];
  if (!isRecord(params)) {
    return {
      ok: false,
      details: ["params must be an object when plan-signature autonomy is enabled."]
    };
  }

  const runId = normalizedScopeString(params.runId);
  const domain = normalizedScopeString(params.domain ?? params.approvedDomain)?.toLowerCase();
  const provider = (normalizedScopeString(params.provider) ?? normalizedScopeString(params.vpsProviderId))?.toLowerCase();
  const vpsProviderId = normalizedProviderId(params.vpsProviderId, "vpsProviderId", details);
  const serverAccountId = normalizedAccountId(params.serverAccountId, "serverAccountId", details);
  const reuseServerSlug = normalizedServerSlug(params.reuseServerSlug, "reuseServerSlug", details);
  const requireExistingDomain = optionalScopeBoolean(params.requireExistingDomain);
  const budgetUsdMax = Number(params.budgetUsdMax);
  const recipient = normalizedScopeString(params.testEmailRecipient ?? params.recipient)?.toLowerCase();

  if (!runId) details.push("params.runId is required.");
  if (!domain || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(domain)) {
    details.push("params.domain must be a verified domain.");
  }
  if (!provider) details.push("params.provider or params.vpsProviderId is required.");
  if (requireExistingDomain === null) details.push("params.requireExistingDomain must be boolean when present.");
  if (!Number.isInteger(budgetUsdMax) || budgetUsdMax < 1 || budgetUsdMax > 10_000) {
    details.push("params.budgetUsdMax must be an integer between 1 and 10000.");
  }
  if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    details.push("params.testEmailRecipient must be a valid recipient email.");
  }

  if (details.length > 0) {
    return { ok: false, details };
  }

  return {
    ok: true,
    value: {
      runId: runId!,
      domain: domain!,
      provider: provider!,
      ...(vpsProviderId ? { vpsProviderId } : {}),
      ...(serverAccountId ? { serverAccountId } : {}),
      ...(reuseServerSlug ? { reuseServerSlug } : {}),
      ...(requireExistingDomain === true ? { requireExistingDomain: true } : {}),
      budgetUsdMax,
      recipient: recipient!,
      plannedSkill: "configure_complete_smtp",
      plannedSteps: [...configureCompleteSmtpPlanSteps]
    }
  };
}

function normalizedScopeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizedProviderId(value: unknown, field: string, details: string[]): string | undefined {
  const raw = normalizedScopeString(value);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalized)) {
    details.push(`params.${field} must be provider id-safe.`);
    return undefined;
  }
  return normalized === "webdock" ? undefined : normalized;
}

function normalizedAccountId(value: unknown, field: string, details: string[]): string | undefined {
  const raw = normalizedScopeString(value);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    details.push(`params.${field} must be account id-safe.`);
    return undefined;
  }
  return normalized;
}

function normalizedServerSlug(value: unknown, field: string, details: string[]): string | undefined {
  const raw = normalizedScopeString(value);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(normalized)) {
    details.push(`params.${field} must be server slug-safe.`);
    return undefined;
  }
  return normalized;
}

function optionalScopeBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "boolean" ? value : null;
}

function hashPlanApprovalScope(scope: PlanApprovalScope): string {
  return createHash("sha256").update(stableStringify(scope)).digest("hex");
}

function publicPlanApproval(planApproval: PlanApprovalRecord): {
  scopeHash: string;
  runId: string;
  domain: string;
  provider: string;
  vpsProviderId?: string;
  serverAccountId?: string;
  reuseServerSlug?: string;
  expiresAt: string;
} {
  return {
    scopeHash: planApproval.scopeHash,
    runId: planApproval.scope.runId,
    domain: planApproval.scope.domain,
    provider: planApproval.scope.provider,
    ...(planApproval.scope.vpsProviderId ? { vpsProviderId: planApproval.scope.vpsProviderId } : {}),
    ...(planApproval.scope.serverAccountId ? { serverAccountId: planApproval.scope.serverAccountId } : {}),
    ...(planApproval.scope.reuseServerSlug ? { reuseServerSlug: planApproval.scope.reuseServerSlug } : {}),
    expiresAt: planApproval.expiresAt
  };
}

function envFlagEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

async function finalizeTimedOutDispatch(input: {
  deps: HandleProposalSignDeps;
  proposal: ProposalSignStoredProposal;
  actorId: string;
  skill: string;
  signatureId: string;
  signedEventHash: string | null;
  executionContextHash: string;
  dispatchResult: DispatchResult;
}): Promise<void> {
  const completedAt = (input.deps.now?.() ?? new Date()).toISOString();
  input.proposal.status = input.dispatchResult.ok ? "executed" : "execution_failed";
  input.proposal.executionOutcome = redactSecrets(input.dispatchResult.summary);
  input.proposal.executionStatusCode = input.dispatchResult.statusCode;
  input.proposal.executionDurationMs = input.dispatchResult.durationMs;
  input.proposal.executionCompletedAt = completedAt;
  const event = proposalExecutionAuditInput({
    proposal: input.proposal,
    actorId: input.actorId,
    action: input.dispatchResult.statusCode === 423 ? "oc.proposal.aborted" : "oc.proposal.executed",
    riskLevel: riskLevelFromProposalSeverity(input.proposal.severity),
    dispatchResult: input.dispatchResult,
    skill: input.skill,
    signatureId: input.signatureId,
    signedEventHash: input.signedEventHash,
    executionContextHash: input.executionContextHash,
    reason: input.dispatchResult.statusCode === 423 ? "kill_switch_armed_mid_execution" : undefined
  });
  await input.deps.auditLog.append(event);
  await input.deps.webhookBroadcaster?.broadcast(event).catch(() => undefined);
  const logger = input.deps.logger ?? noopGatewayRuntimeLogger;
  void (input.dispatchResult.ok
    ? logger.info("openclaw.proposal.dispatch_settled", "Async proposal dispatch settled successfully.", {
      proposalId: input.proposal.id,
      skill: input.skill,
      signatureId: input.signatureId,
      statusCode: input.dispatchResult.statusCode,
      durationMs: input.dispatchResult.durationMs
    })
    : logger.error("openclaw.proposal.dispatch_settled_failed", "Async proposal dispatch settled with failure.", {
      proposalId: input.proposal.id,
      skill: input.skill,
      signatureId: input.signatureId,
      statusCode: input.dispatchResult.statusCode,
      durationMs: input.dispatchResult.durationMs,
      outcome: redactSecrets(input.dispatchResult.summary)
    }));
}

function proposalExecutionAuditInput(input: {
  proposal: ProposalSignStoredProposal;
  actorId: string;
  action: "oc.proposal.executed" | "oc.proposal.aborted";
  riskLevel: AuditRiskLevel;
  dispatchResult: DispatchResult;
  skill: string;
  signatureId: string;
  signedEventHash: string | null;
  executionContextHash: string;
  reason?: string;
}): AuditEventInput {
  return {
    actorType: "operator",
    actorId: input.actorId,
    action: input.action,
    targetType: "proposal",
    targetId: input.proposal.id,
    riskLevel: input.riskLevel,
    decision: input.dispatchResult.ok ? "allow" : "reject",
    humanApproved: true,
    approverIds: [input.actorId],
    metadata: {
      outcome: input.dispatchResult.ok ? "success" : "failure",
      proposalStatus: input.proposal.status,
      handlerStatusCode: input.dispatchResult.statusCode,
      handlerResponseSummary: redactSecrets(input.dispatchResult.summary),
      durationMs: input.dispatchResult.durationMs,
      skillSlug: input.skill,
      signatureId: input.signatureId,
      executionContextHash: input.executionContextHash,
      chainPrevHash: input.signedEventHash,
      ...(input.reason ? { reason: input.reason } : {})
    }
  };
}

function validateRequestAuth(input: {
  request: IncomingMessage;
  raw: string;
  env?: Record<string, string | undefined>;
}): { ok: true; authMode: "hmac" | "local_unsigned_panel" } | {
  ok: false;
  rejectReason: "signature_invalid" | "signature_required";
  details: string;
} {
  if (hasOpenClawSignature(input.request)) {
    const hmac = validateOpenClawHmac(input.request.headers, input.raw);
    return hmac.ok
      ? { ok: true, authMode: "hmac" }
      : { ok: false, rejectReason: "signature_invalid", details: hmac.rejectReason };
  }

  if (allowsUnsignedLocalPanel(input.request, input.env)) {
    return { ok: true, authMode: "local_unsigned_panel" };
  }

  return {
    ok: false,
    rejectReason: "signature_required",
    details: "Missing x-openclaw-signature for proposal signing."
  };
}

function allowsUnsignedLocalPanel(request: IncomingMessage, env?: Record<string, string | undefined>): boolean {
  if (env?.OPENCLAW_SIGN_ALLOW_UNSIGNED_LOCAL_PANEL !== "true") return false;
  if (env?.NODE_ENV === "production") return false;
  if (!isLoopbackRemoteAddress(request.socket?.remoteAddress)) return false;
  const origin = headerString(request.headers.origin);
  return !!origin && /^https?:\/\/(127\.0\.0\.1|localhost):5173$/i.test(origin);
}

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1";
}

function normalizeActorId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\//g, "-");
  if (!/^[a-z0-9._-]{3,64}$/.test(normalized)) return null;
  return normalized;
}

function normalizeReason(reason: unknown, signature: unknown): string | null {
  const raw = typeof reason === "string" && reason.trim()
    ? reason.trim()
    : typeof signature === "string" && signature.trim()
      ? `ApprovalGate signature ${signature.trim()}`
      : "";
  if (raw.length < 10 || raw.length > 500) return null;
  return raw;
}

function normalizeSignatureMetadata(value: unknown): { ok: true; value: Record<string, string> } | { ok: false; details: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: {} };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, details: "signatureMetadata must be an object." };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10) {
    return { ok: false, details: "signatureMetadata supports max 10 keys." };
  }
  const normalized: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (typeof item !== "string" || item.length > 256) {
      return { ok: false, details: `signatureMetadata.${key} must be a string <= 256 chars.` };
    }
    normalized[key] = item;
  }
  return { ok: true, value: normalized };
}

function approvedArtifactSnapshot(input: {
  proposal: ProposalSignStoredProposal;
  executionId: string;
  actorId: string;
  now: Date;
}): CanvasLiveArtifactSnapshot {
  const base = input.proposal.artifactSnapshot;
  const nowIso = input.now.toISOString();
  return {
    artifactId: base?.artifactId ?? `proposal-${input.proposal.id}`,
    taskId: base?.taskId ?? `proposal-${input.proposal.id}`,
    kind: base?.kind ?? "proposal",
    title: base?.title ?? input.proposal.headline ?? `Proposal ${input.proposal.id}`,
    editable: base?.editable ?? true,
    createdAt: base?.createdAt ?? nowIso,
    updatedAt: nowIso,
    approvalStatus: "approved",
    approvedBy: input.actorId,
    approvedAt: nowIso,
    executionId: input.executionId,
    blocks: base?.blocks?.length
      ? base.blocks
      : [{
          blockId: "summary",
          order: 1,
          kind: "paragraph",
          content: input.proposal.body ?? input.proposal.category,
          editable: true,
          status: "complete",
          updatedAt: nowIso
        }]
  };
}

function proposalTarget(proposal: ProposalSignStoredProposal): { type: string; id: string } {
  return {
    type: proposal.targetType || (looksLikeDomain(proposal.targetRef) ? "domain" : "proposal_target"),
    id: proposal.targetRef
  };
}

function skillForProposal(proposal: ProposalSignStoredProposal): string {
  return canonicalSkillSlug(proposal.skillSlug || proposal.category);
}

function riskLevelFromProposalSeverity(severity: ProposalSignStoredProposal["severity"]): AuditRiskLevel {
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

function isDispatchTimeout(result: { statusCode: number; summary: unknown }): boolean {
  return result.statusCode === 504 &&
    typeof result.summary === "object" &&
    result.summary !== null &&
    (result.summary as { error?: unknown }).error === "handler_timeout";
}

function hasOpenClawSignature(request: IncomingMessage): boolean {
  return typeof request.headers["x-openclaw-signature"] === "string" ||
    Array.isArray(request.headers["x-openclaw-signature"]);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readRawBodyAndJson<T>(request: IncomingMessage): Promise<{ raw: string; body: T | null }> {
  const raw = await readRequestBody(request, { trim: false });
  if (!raw.trim()) return { raw, body: null };
  try {
    return { raw, body: JSON.parse(raw) as T };
  } catch {
    return { raw, body: null };
  }
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "string") return redactSecretString(value);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(token|secret|password|private[_-]?key|api[_-]?key|bearer)/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactSecrets(item);
    }
  }
  return output;
}

function redactSecretString(value: string): string {
  return value
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1=[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown proposal sign error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

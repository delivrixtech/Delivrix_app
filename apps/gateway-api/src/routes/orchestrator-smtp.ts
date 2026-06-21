import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type {
  AuditEventInput,
  CanvasLiveEvent,
  CanvasLiveRunIdentity,
  CanvasLiveRunProgress
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
import {
  DEFAULT_CREATION_ACCOUNT_ID,
  evaluateAccountSelection,
  evaluateCreationBudget,
  evaluateCreationBudgetReadError,
  type CreationAccountForSelection,
  type CreationAccountGovernorState,
  type CreationRateServer,
  type CreationRateWindow
} from "../../../../packages/domain/src/creation-rate-governor.ts";
import { readRequestBody } from "../request-body.ts";
import { coerceSafeDomainIntent } from "./domains-suggest.ts";
import { SPAM_FLAG_WORDS } from "./send-email.ts";
import { smtpHostForDomain } from "../smtp-naming.ts";
import { conformOutcomeData, machineErrorCode } from "../../../../packages/storage/src/episodic-scratch.ts";
import { stableStringify } from "../../../../packages/storage/src/stable-stringify.ts";
import type { PlanApprovalRecord } from "./proposals-sign.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";

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
  planStepTokenId?: string;
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
  /**
   * Canal paralelo para lecturas provider/account-aware. No entra en params/hashInput.
   */
  serverAccountId?: string;
  providerId?: string;
}

export interface ApprovalStepInput extends SkillInvocationInput {
  actorId: string;
  approvalTimeoutMs: number;
  estimatedCostUsd?: number;
  /**
   * Cuenta Webdock destino del create (5.12 multicuenta). Canal PARALELO: viaja fuera de
   * `params`, NO entra al hashInput. undefined => cuenta-1 "ops" (single-account byte-identico).
   */
  serverAccountId?: string;
  /**
   * Proveedor de VPS destino del create (Contabo, etc.). Canal PARALELO HERMANO de serverAccountId:
   * viaja fuera de `params`, NO entra al hashInput. undefined o "webdock" => Webdock (byte-identico).
   */
  providerId?: string;
  /**
   * Proveedor DNS destino del run. Canal PARALELO HERMANO: viaja fuera de `params` y solo se usa para
   * enrutar/validar el proveedor DNS. undefined o "route53" => Route53 (byte-identico).
   */
  dnsProviderId?: string;
}

export interface PlanApprovalLookupInput {
  runId: string;
  params: ConfigureCompleteSmtpParams;
}

export interface OwnedDomainVerification {
  owned: boolean;
  provider: "route53" | "ionos";
  reason?: string;
  sourceKind?: string;
  responseOk?: boolean;
}

export type Route53DomainRegistrationWaitResult =
  | {
      status: "owned";
      operationId: string;
      operationStatus: string;
      attempts: number;
      durationMs: number;
    }
  | {
      status: "skipped";
      reason: string;
      operationId?: string;
      attempts: number;
      durationMs: number;
    }
  | {
      status: "blocked";
      blockers: string[];
      operationId?: string;
      operationStatus?: string;
      message?: string;
      attempts: number;
      durationMs: number;
    };

export interface Route53DomainRegistrationWaitInput {
  domain: string;
  operationId: string;
  expectedExpiry?: string;
  costUsd?: number;
  maxWaitMs: number;
  pollIntervalMs: number;
}

export interface WebdockCreationAccount {
  accountId: string;
  /** canCreate() REAL del adapter (post Fase 0): salvaguarda contra elegir una cuenta sin write. */
  enabled: boolean;
}

export interface WebdockCreationInventoryInput {
  accountId: string;
}

export interface WebdockCreationInventoryResult {
  accountId?: string;
  accountLabel?: string;
  sourceKind?: "live" | "mock" | string;
  responseOk?: boolean;
  servers: CreationRateServer[];
}

export interface CreationRateOverrideInput {
  runId: string;
  step: number;
  skill: "create_webdock_server";
  accountId: string;
  createdCount: number;
  cap: number;
}

export interface CreationRateOverrideDecision {
  approved: boolean;
  signatureId?: string;
  reason?: string;
  actorId?: string;
}

export interface PlanApprovedStepInput extends SkillInvocationInput {
  actorId: string;
  inputHash: string;
  estimatedCostUsd?: number;
  planApproval: PlanApprovalRecord;
  /**
   * Cuenta Webdock destino del create (5.12 multicuenta). Canal PARALELO fuera de `params`/
   * hashInput. undefined => cuenta-1 "ops" (single-account byte-identico).
   */
  serverAccountId?: string;
  /**
   * Proveedor de VPS destino del create. Canal PARALELO HERMANO de serverAccountId fuera de
   * `params`/hashInput. undefined o "webdock" => Webdock (byte-identico).
   */
  providerId?: string;
  /**
   * Proveedor DNS destino del run. Canal PARALELO HERMANO fuera de `params`/hashInput.
   * undefined o "route53" => Route53 (byte-identico).
   */
  dnsProviderId?: string;
}

export type PlanApprovedStepDecision =
  | {
      status: "executed";
      planStepTokenId: string;
      signatureId?: string;
      outcome: unknown;
      durationMs: number;
      statusCode?: number;
    }
  | {
      status: "execution_failed";
      planStepTokenId: string;
      signatureId?: string;
      outcome?: unknown;
      durationMs: number;
      statusCode?: number;
      error?: string;
    }
  | {
      status: "replay_detected" | "scope_rejected" | "kill_switch_armed";
      planStepTokenId?: string;
      reason?: string;
    };

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
  /**
   * Cuenta Webdock donde vive el server a borrar (5.12 multicuenta). El delete DEBE ir a ESTA
   * cuenta, no a la cuenta-1, o el server queda huerfano. runState viejo sin el campo => "ops".
   */
  serverAccountId?: string;
  /**
   * Proveedor de VPS donde vive el server a borrar. Canal PARALELO HERMANO de serverAccountId: el
   * delete debe enrutar a ESTE proveedor (Contabo) o el VPS queda huerfano. undefined => Webdock.
   */
  providerId?: string;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<Array<Record<string, unknown>>>;
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
  resolvePlanApproval?: (input: PlanApprovalLookupInput) => Promise<PlanApprovalRecord | null> | PlanApprovalRecord | null;
  executePlanApprovedStep?: (input: PlanApprovedStepInput) => Promise<PlanApprovedStepDecision>;
  verifyOwnedDomain?: (domain: string) => Promise<OwnedDomainVerification> | OwnedDomainVerification;
  listWebdockCreationServers?: (
    input: WebdockCreationInventoryInput
  ) => Promise<WebdockCreationInventoryResult> | WebdockCreationInventoryResult;
  /**
   * Cuentas Webdock write-capable a evaluar en el selector multicuenta (5.12). Devuelve
   * UNA entrada por CUENTA REAL (de-dup roles primary/ops/account -> 1 cuenta). Si la dep
   * no esta o devuelve vacio, el orquestador cae al modo single-account "ops" byte-identico.
   */
  listCreationAccounts?: () =>
    | Promise<WebdockCreationAccount[]>
    | WebdockCreationAccount[];
  resolveCreationRateOverride?: (
    input: CreationRateOverrideInput
  ) => Promise<CreationRateOverrideDecision> | CreationRateOverrideDecision;
  waitForRoute53DomainRegistration?: (
    input: Route53DomainRegistrationWaitInput
  ) => Promise<Route53DomainRegistrationWaitResult> | Route53DomainRegistrationWaitResult;
  submitRollbackProposal?: (input: RollbackProposalInput) => Promise<{ proposalId: string }>;
  verifyAuditChain?: () => Promise<{ ok: boolean; details?: unknown }> | { ok: boolean; details?: unknown };
  readKillSwitch?: () => Promise<{ enabled: boolean }> | { enabled: boolean };
  canvasLiveEvents?: CanvasEmitter;
  compactIntent?: CompactIntentSink;
  workspace?: Pick<OpenClawWorkspace,
    "ensureBase" |
    "getRootDir" |
    "readWorkspaceFile" |
    "writeWorkspaceFileAtomic" |
    "readInventoryJson" |
    "updateInventoryJson"
  >;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  randomId?: () => string;
  logger?: GatewayRuntimeLogger;
}

const defaultApprovalTimeoutMs = 10 * 60 * 1000;
const longRunningStepTimeoutPaddingMs = 2 * 60 * 1000;
const minEstimatedCostUsd = 15 + 4.30 / 30;
const smtpRunStateVersion = "smtp-run-state/v1";
const smtpRunStateLockLeaseMs = 40 * 60 * 1000;
const smtpRunStepLeaseMs = 45 * 60 * 1000;
/**
 * Safety del loop de failover de pago (step 4) contra loop infinito. El terminador REAL es el break
 * por "" de resolveCreationAccount (todas las write-capable excluidas), que ocurre en <=N+1 iteraciones
 * con N cuentas; este tope alto solo cubre un bug teorico + holgura para agregar muchas cuentas.
 */
const smtpCreateAccountFailoverMaxAttempts = 25;
type ServerProvenanceClassification = "created" | "reused" | "unknown";
const createdServerProvenance = new Set(["created"]);
const reusedServerProvenance = new Set(["idempotent_already_exists", "adopted", "reused"]);
const route53DomainRegistrationWaitMaxMs = 1_800_000;
const route53DomainRegistrationWaitPollMs = 30_000;
const smtpRunLocalLocks = new Map<string, Promise<void>>();
const provisionSmtpPostfixStep = 9;
const smtpRunProgressSteps = [
  { step: 1, skill: "suggest_safe_domain" },
  { step: 2, skill: "register_domain_route53" },
  { step: 3, skill: "wait_for_dns_propagation" },
  { step: 4, skill: "create_webdock_server" },
  { step: 5, skill: "wait_server_running" },
  { step: 6, skill: "upsert_dns_route53" },
  { step: 7, skill: "wait_for_dns_propagation" },
  { step: 8, skill: "bind_webdock_main_domain" },
  { step: provisionSmtpPostfixStep, skill: "provision_smtp_postfix" },
  { step: 10, skill: "configure_email_auth" },
  { step: 11, skill: "wait_for_dns_propagation" },
  { step: 12, skill: "seed_warmup_pool" },
  { step: 13, skill: "wait_warmup_initial" },
  { step: 14, skill: "send_real_email" }
] as const;

type SmtpRunStatus = "running" | "completed" | "failed" | "cancelled_by_operator";
type SmtpRunStepStatus = "pending" | "in_flight" | "done";

interface SmtpRunStepState {
  step: number;
  skill: string;
  status: SmtpRunStepStatus;
  inputHash?: string;
  attemptId?: string;
  leaseUntil?: string;
  startedAt?: string;
  completedAt?: string;
  estimatedCostUsd?: number;
  result?: ConfigureCompleteSmtpStepResult;
  lastError?: string;
  updatedAt: string;
}

interface SmtpRunState {
  schemaVersion: typeof smtpRunStateVersion;
  runId: string;
  status: SmtpRunStatus;
  createdAt: string;
  updatedAt: string;
  params: {
    brand: string;
    intent?: string;
    provider?: string;
    requireExistingDomain: boolean;
    budgetUsdMax: number;
    testEmailRecipient: string;
    testEmailSubject: string;
    testEmailBody: string;
    seedInboxes: string[];
  };
  plan?: {
    scopeHash: string;
    signatureId: string;
    expiresAt: string;
  };
  chosenDomain?: string;
  smtpHost?: string;
  serverSlug?: string;
  serverIpv4?: string;
  /**
   * Cuenta Webdock donde se creo el server (5.12 multicuenta). OPCIONAL para backward-compat:
   * runStates viejos sin el campo defaultean a "ops" en rollback/delete. Se persiste junto a
   * serverSlug/serverIpv4 ANTES del create, asi un resume firmado retoma la cuenta correcta.
   */
  serverAccountId?: string;
  /**
   * Proveedor de VPS donde se creo el server (Contabo, etc.). OPCIONAL para backward-compat:
   * runStates viejos sin el campo => Webdock en rollback/delete. Se persiste junto a serverAccountId
   * ANTES del create, asi un resume firmado retoma el proveedor correcto. undefined => Webdock.
   */
  providerId?: string;
  /**
   * true SOLO cuando este run creo el VPS. false/undefined => server adoptado/reusado/legacy:
   * no proponer borrado automatico en rollback para no destruir infraestructura preexistente.
   */
  serverCreatedByRun?: boolean;
  /**
   * Proveedor DNS elegido para este run. OPCIONAL para backward-compat: runStates viejos sin el campo
   * usan Route53. Va por canal hermano y se persiste antes de las mutaciones DNS.
   */
  dnsProviderId?: "ionos";
  selector: string;
  verifiedOwnedDomain?: string;
  verifiedOwnedDomainProvider?: OwnedDomainVerification["provider"];
  budgetSpentUsd: number;
  lastCompletedStep: number;
  finalEmailMessageId?: string;
  finalDeliveryStatus?: "queued" | "delivered" | "deferred" | "bounced";
  legacyReconstructed?: boolean;
  steps: Record<string, SmtpRunStepState>;
}

interface DomainsInventoryForResume {
  domains?: Array<{
    domain: string;
    registrar?: string;
    status?: string;
    operationId?: string;
    registeredAt?: string;
    costUsd?: number;
  }>;
  bindings?: Array<{
    domain: string;
    serverSlug: string | null;
    serverIp: string;
    status?: string;
  }>;
}

interface WebdockInventoryForResume {
  servers?: Array<{
    slug: string;
    hostname?: string;
    ipv4: string | null;
    status?: string;
  }>;
  runBindings?: Array<{
    runId: string;
    serverSlug: string;
    domain: string;
    boundAt: string;
    source: string;
  }>;
}

interface SmtpProvisionInventoryForResume {
  servers?: Array<{
    serverSlug: string;
    domain: string;
    serverIp: string;
    selector: string;
    status: string;
  }>;
}

interface WarmupInventoryForResume {
  runs?: Array<{
    runId: string;
    domain: string;
    serverSlug: string | null;
    serverIp: string;
    seedCount: number;
    status: string;
  }>;
}

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
  const statusCode = result.status === "completed"
    ? 200
    : result.error === "run_already_in_progress" || result.error === "step_in_flight"
    ? 423
    : 424;
  return json(deps.response, statusCode, result);
}

export async function configureCompleteSmtp(
  input: ConfigureCompleteSmtpParams,
  deps: ConfigureCompleteSmtpDeps
): Promise<ConfigureCompleteSmtpResult> {
  const startedAt = deps.now?.() ?? new Date();
  const startedMs = startedAt.getTime();
  const runId = input.runId ?? deps.randomId?.() ?? randomUUID();
  const stepResults: ConfigureCompleteSmtpStepResult[] = [];
  const approvalTimeoutMs = positiveInt(deps.env?.OPENCLAW_CONFIGURE_SMTP_APPROVAL_TIMEOUT_MS) ??
    defaultApprovalTimeoutMs;
  let chosenDomain = "";
  let serverSlug = "";
  let serverIpv4 = "";
  let verifiedOwnedDomain: string | null = null;
  let verifiedOwnedProvider: OwnedDomainVerification["provider"] | null = null;
  let rollbackProposalId: string | undefined;
  const logger = deps.logger ?? noopGatewayRuntimeLogger;
  let planApproval: PlanApprovalRecord | null = null;
  let runState: SmtpRunState | null = null;
  let releaseRunLock: (() => Promise<void>) | null = null;
  let selector = "s2026a";
  let effectiveInput = input;

  void logger.info("openclaw.orchestrator.run_started", "configure_complete_smtp run started.", {
    runId,
    brand: input.brand,
    domain: input.domain,
    provider: input.provider,
    dnsProviderId: input.dnsProviderId,
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
    domain: input.domain,
    provider: input.provider,
    dnsProviderId: input.dnsProviderId,
    actorId: input.actorId,
    planSignatureAutonomy: envFlagEnabled(deps.env?.OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE)
  });

  try {
    releaseRunLock = await acquireSmtpRunStateLock(deps, runId);
    runState = await loadOrCreateSmtpRunState({ deps, runId, params: input, startedAt });
    if (backfillSmtpRunStateServerIpv4(runState)) {
      await persistSmtpRunState(deps, runState);
    }
    assertSmtpRunStateServerIpv4Integrity(runState);
    assertDnsProviderResumeCompatible(runState, input);
    effectiveInput = inputFromRunState(input, runState);
    assertKnownNonWebdockVpsProviderId(resolveVpsProviderId(effectiveInput, runState));
    const dnsProviderId = resolveDnsProviderId(effectiveInput, runState);
    assertKnownDnsProviderId(dnsProviderId);
    if (dnsProviderId === "ionos") {
      runState.dnsProviderId = "ionos";
      await persistSmtpRunState(deps, runState);
    }
    selector = runState.selector;
    chosenDomain = runState.chosenDomain ?? "";
    serverSlug = runState.serverSlug ?? "";
    serverIpv4 = runState.serverIpv4 ?? "";
    verifiedOwnedDomain = runState.verifiedOwnedDomain ?? null;
    verifiedOwnedProvider = runState.verifiedOwnedDomainProvider ?? null;
    await verifyAuditChain(deps);
    planApproval = envFlagEnabled(deps.env?.OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE)
      ? await resolveAndValidatePlanApproval({ deps, runId, input: effectiveInput })
      : null;
    validateResumeScopeAgainstRunState({
      state: runState,
      planApproval,
      request: input,
      now: deps.now?.() ?? new Date()
    });
    if (planApproval) {
      runState.plan = {
        scopeHash: planApproval.scopeHash,
        signatureId: planApproval.signatureId,
        expiresAt: planApproval.expiresAt
      };
      await persistSmtpRunState(deps, runState);
      await audit(deps, "oc.plan.run_authorized", "openclaw_orchestrator_run", runId, "critical", {
        runId,
        scopeHash: planApproval.scopeHash,
        scope: planApproval.scope,
        signatureId: planApproval.signatureId,
        expiresAt: planApproval.expiresAt
      });
    }

    const suggestions = await runReadOnlyStepWithState({
      deps,
      runState,
      runId,
      step: 1,
      skill: "suggest_safe_domain",
      params: {
        brand: effectiveInput.brand,
        // El intent de configure_complete_smtp es libre (OpenClaw manda cosas como
        // "ops-smtp-controlledgerdesk"); suggest_safe_domain exige el enum -> se traduce
        // a un SafeDomainIntent valido para que un intent descriptivo no tumbe el step 1.
        intent: coerceSafeDomainIntent(effectiveInput.intent),
        count: 5,
        actorId: effectiveInput.actorId
      },
      stepResults
    });
    const explicitDomain = explicitDomainForRun(effectiveInput, planApproval);
    const requireExistingDomain = requiresExistingDomainForRun(effectiveInput, planApproval);
    if (explicitDomain && (requireExistingDomain || dnsProviderId === "ionos" || !domainInSuggestions(suggestions, explicitDomain))) {
      const ownership = await resolveExistingDomainOwnership({
        deps,
        runId,
        domain: explicitDomain,
        requireExistingDomain
      });
      verifiedOwnedDomain = ownership.owned ? explicitDomain : null;
      verifiedOwnedProvider = ownership.owned ? ownership.provider ?? null : null;
    }
    chosenDomain = runState.chosenDomain ?? chooseDomainForRun(suggestions, planApproval, effectiveInput, verifiedOwnedDomain);
    const smtpHost = smtpHostForDomain(chosenDomain);
    runState.chosenDomain = chosenDomain;
    runState.smtpHost = smtpHost;
    if (verifiedOwnedDomain) {
      runState.verifiedOwnedDomain = verifiedOwnedDomain;
      if (verifiedOwnedProvider) runState.verifiedOwnedDomainProvider = verifiedOwnedProvider;
    }
    await persistSmtpRunState(deps, runState);

    const route53RegistrationParams = { domain: chosenDomain, years: 1, autoRenew: false };
    const ionosAdoptedDnsRun =
      dnsProviderId === "ionos" &&
      verifiedOwnedDomain === chosenDomain &&
      verifiedOwnedProvider === "ionos";
    if (dnsProviderId === "ionos" && !ionosAdoptedDnsRun) {
      throw new OrchestratorFailure(
        "failed",
        2,
        "dns_provider_guard",
        "ionos_dns_requires_ionos_owned_domain"
      );
    }

    if (ionosAdoptedDnsRun) {
      await recordSyntheticDoneStepWithState({
        deps,
        runState,
        runId,
        step: 2,
        skill: "register_domain_route53",
        params: route53RegistrationParams,
        outcome: {
          ok: true,
          status: "skipped",
          reason: "ionos_owned_domain",
          provider: "ionos",
          domain: chosenDomain
        },
        estimatedCostUsd: 0,
        stepResults
      });
      await audit(deps, "oc.domain.registration_skipped", "domain", chosenDomain, "high", {
        runId,
        provider: "ionos",
        reason: "ionos_owned_domain"
      });
    } else {
      const domainRegistration = await runMutatingStepWithState({
        deps,
        runState,
        planApproval,
        runId,
        step: 2,
        skill: "register_domain_route53",
        actorId: effectiveInput.actorId,
        approvalTimeoutMs,
        estimatedCostUsd: verifiedOwnedDomain === chosenDomain ? 0 : 15,
        budgetUsdMax: effectiveInput.budgetUsdMax,
        params: route53RegistrationParams,
        stepResults
      });
      await awaitFreshRoute53Registration({
        deps,
        runId,
        result: domainRegistration,
        domain: chosenDomain,
        costUsd: verifiedOwnedDomain === chosenDomain ? 0 : 15
      });
    }

    const route53NameserverWaitParams = {
      domain: chosenDomain,
      expectedRecord: { type: "NS", value: "contains:awsdns" },
      maxWaitMs: 1_800_000,
      pollIntervalMs: 60_000
    };
    if (ionosAdoptedDnsRun) {
      await recordSyntheticDoneStepWithState({
        deps,
        runState,
        runId,
        step: 3,
        skill: "wait_for_dns_propagation",
        params: {
          domain: chosenDomain,
          expectedRecord: { type: "NS", value: "skipped:ionos-authoritative" },
          maxWaitMs: 0,
          pollIntervalMs: 0
        },
        outcome: {
          ok: true,
          status: "skipped",
          reason: "ionos_authoritative_nameservers",
          provider: "ionos"
        },
        stepResults
      });
      await audit(deps, "oc.dns.nameserver_wait_skipped", "domain", chosenDomain, "high", {
        runId,
        provider: "ionos",
        reason: "ionos_authoritative_nameservers"
      });
    } else {
      await runMutatingStepWithState({
        deps,
        runState,
        planApproval,
        runId,
        step: 3,
        skill: "wait_for_dns_propagation",
        actorId: effectiveInput.actorId,
        approvalTimeoutMs,
        budgetUsdMax: effectiveInput.budgetUsdMax,
        params: route53NameserverWaitParams,
        stepResults
      });
    }

    // Seleccion multicuenta (5.12). En un RESUME reusamos la cuenta YA elegida y persistida
    // (re-seleccionar podria elegir otra cuenta distinta a donde ya vive el server -> huerfano);
    // en un run fresco seleccionamos entre las cuentas write-capable. Con solo la cuenta-1 el
    // ganador es "ops" y el comportamiento (lecturas, audits, governor) es byte-identico al de hoy.
    // FAILOVER de pago multicuenta (2026-06-11). El governor elige la mejor cuenta write-capable; si
    // el create rechaza el PAGO (webdock_payment_failed, recoverable), se excluye esa cuenta y se
    // reintenta en la siguiente, hasta crear o agotarlas. El accountId va por canal paralelo (no
    // re-firma el plan). En RESUME el primer intento reusa la cuenta ya persistida (donde podria vivir
    // el server); con solo "ops" write-capable es identico al de hoy (1 iteracion, byte-identico).
    // Proveedor de VPS (Contabo, etc.). Canal PARALELO HERMANO de serverAccountId: NO entra a params/
    // hashInput. Es una eleccion FIJA del run (no participa del failover de cuentas, que es Webdock
    // multi-cuenta de pago). En RESUME reusamos el persistido; en run fresco viene del skill param
    // vpsProviderId. undefined o "webdock" => Webdock (byte-identico). Se persiste ANTES del create
    // junto a serverAccountId para que un resume firmado retome el proveedor correcto en rollback/delete.
    const vpsProviderId = resolveVpsProviderId(effectiveInput, runState);
    assertKnownNonWebdockVpsProviderId(vpsProviderId);
    if (vpsProviderId) {
      runState.providerId = vpsProviderId;
    }
    const createStepWasAlreadyDone = runState.steps["4"]?.status === "done";
    let vps: ConfigureCompleteSmtpStepResult | undefined;
    if (isNonWebdockProviderId(vpsProviderId)) {
      // PROVEEDOR NO-WEBDOCK (Contabo, etc.): el governor y el failover de pago multicuenta son
      // construcciones Webdock (eligen entre cuentas Webdock write-capable, cuentan por creationDate
      // contra el cap Webdock). NO aplican a otro proveedor:
      // - GOVERNOR SHORT-CIRCUIT (P2 #5): NO se llama resolveCreationAccount. serverAccountId queda
      //   undefined -> runState.serverAccountId NO se setea a una cuenta Webdock enganosa y el cap 24h
      //   del governor NO se contamina con creates de otro proveedor. El dispatcher enruta por
      //   providerId (canal HERMANO), asi que serverAccountId undefined es correcto.
      // - FAILOVER GUARD (P2 #4): un error recuperable NO excluye cuentas ni reintenta en otra cuenta
      //   Webdock (no existe esa nocion aqui). El error PROPAGA de inmediato (un solo intento de create).
      vps = await runMutatingStepWithState({
        deps,
        runState,
        planApproval,
        runId,
        step: 4,
        skill: "create_webdock_server",
        actorId: effectiveInput.actorId,
        approvalTimeoutMs,
        estimatedCostUsd: 4.30 / 30,
        budgetUsdMax: effectiveInput.budgetUsdMax,
        // params byte-identicos al camino Webdock: el adapter del proveedor TRADUCE el vocabulario
        // (profile/locationId/imageSlug) a su propia API. providerId va por canal HERMANO (no en params).
        params: {
          runId,
          profile: "bit",
          locationId: "dk",
          hostname: smtpHost,
          imageSlug: "ubuntu-2404"
        },
        providerId: vpsProviderId,
        stepResults
      });
    } else {
    const excludedFailoverAccounts = new Set<string>();
    let lastCreateFailure: unknown;
    // El break por "" (todas las write-capable excluidas) es el terminador real -> cubre CUALQUIER
    // numero de cuentas; smtpCreateAccountFailoverMaxAttempts es solo safety contra loop infinito.
    for (let attempt = 0; attempt < smtpCreateAccountFailoverMaxAttempts; attempt++) {
      const reuseAccountId = attempt === 0
        && runState.serverAccountId
        && !excludedFailoverAccounts.has(runState.serverAccountId)
        ? runState.serverAccountId
        : undefined;
      const serverAccountId = reuseAccountId
        ?? await resolveCreationAccount({
          deps,
          runId,
          step: 4,
          skill: "create_webdock_server",
          excludeAccounts: excludedFailoverAccounts
        });
      if (!serverAccountId || excludedFailoverAccounts.has(serverAccountId)) {
        break; // no quedan cuentas write-capable con las que reintentar
      }
      // Persistir la cuenta ANTES del create: si el create corre y el proceso muere, un resume
      // (firma POSTERIOR) enruta rollback/delete a ESTA cuenta. Va por estado, no closure.
      runState.serverAccountId = serverAccountId;
      await persistSmtpRunState(deps, runState);
      try {
        vps = await runMutatingStepWithState({
          deps,
          runState,
          planApproval,
          runId,
          step: 4,
          skill: "create_webdock_server",
          actorId: effectiveInput.actorId,
          approvalTimeoutMs,
          estimatedCostUsd: 4.30 / 30,
          budgetUsdMax: effectiveInput.budgetUsdMax,
          // accountId/providerId NO entran a params (idempotencia/resume + el allowlist del schema los
          // descartaria): viajan por los canales paralelos serverAccountId / providerId.
          params: {
            runId,
            profile: "bit",
            locationId: "dk",
            hostname: smtpHost,
            imageSlug: "ubuntu-2404"
          },
          serverAccountId,
          providerId: vpsProviderId,
          stepResults
        });
        break; // VPS creado
      } catch (createError) {
        const createFailure = normalizeFailure(createError);
        if (!isRecoverablePaymentFailure(createFailure, stepResults[stepResults.length - 1])) {
          throw createError; // no es un rechazo de pago -> propagar (no failover a ciegas)
        }
        // La cuenta rechazo el pago: excluirla, liberar su lease del step 4 y probar la siguiente.
        excludedFailoverAccounts.add(serverAccountId);
        lastCreateFailure = createError;
        releaseRunStepLeaseOnFailure(runState, 4, createFailure.message, deps.now?.() ?? new Date());
        runState.serverAccountId = undefined;
        await persistSmtpRunState(deps, runState);
        await audit(deps, "oc.orchestrator.account_payment_failover", "webdock_account", serverAccountId, "high", {
          runId,
          step: 4,
          skill: "create_webdock_server",
          rejectedAccount: serverAccountId,
          excludedCount: excludedFailoverAccounts.size,
          reason: createFailure.message.slice(0, 200)
        });
      }
    }
    if (!vps) {
      throw lastCreateFailure
        ?? new OrchestratorFailure("failed", 4, "create_webdock_server", "all_write_accounts_payment_failed");
    }
    } // fin del camino Webdock (failover multicuenta). El camino no-Webdock siempre asigna vps o lanza.
    if (!vps) {
      // Inalcanzable en runtime (ambos caminos asignan vps o lanzan); narrowing para TS + cinturon.
      throw new OrchestratorFailure("failed", 4, "create_webdock_server", "create_result_missing");
    }
    serverSlug = stringFromOutcome(vps.outcome, ["slug", "serverSlug"]);
    const step4Ipv4 = stringFromOutcome(vps.outcome, ["ipv4", "serverIp"], "");
    const createStatus = stringFromOutcome(vps.outcome, ["status"], "").trim().toLowerCase();
    const serverProvenance = createStepWasAlreadyDone
      ? classifyLegacyServerBindingSource(createStatus)
      : classifyFreshStep4ServerProvenance(createStatus);
    runState.serverSlug = serverSlug;
    if (runState.serverCreatedByRun === undefined) {
      if (!createStepWasAlreadyDone) {
        runState.serverCreatedByRun = serverProvenance === "created";
      } else if (serverProvenance !== "unknown") {
        runState.serverCreatedByRun = serverProvenance === "created";
      }
    }
    if (step4Ipv4) {
      serverIpv4 = step4Ipv4;
      runState.serverIpv4 = step4Ipv4;
    }
    await persistSmtpRunState(deps, runState);

    const waitServerOutcome = await runReadOnlyStepWithState({
      deps,
      runState,
      runId,
      step: 5,
      skill: "wait_server_running",
      params: { serverSlug, maxWaitMs: 600_000 },
      serverAccountId: runState.serverAccountId,
      providerId: vpsProviderId,
      stepResults
    });
    const step5Ipv4 = stringFromOutcome(waitServerOutcome, ["ipv4", "serverIp"], step4Ipv4 || runState.serverIpv4 || "");
    if (!step5Ipv4) {
      throw new OrchestratorFailure("failed", 5, "wait_server_running", "missing ipv4/serverIp");
    }
    serverIpv4 = step5Ipv4;
    runState.serverIpv4 = serverIpv4;
    await persistSmtpRunState(deps, runState);

    await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: 6,
      skill: dnsProviderId === "ionos" ? "upsert_dns_ionos" : "upsert_dns_route53",
      actorId: effectiveInput.actorId,
      approvalTimeoutMs,
      budgetUsdMax: effectiveInput.budgetUsdMax,
      params: dnsProviderId === "ionos"
        ? ionosSmtpRouteDnsParams({ domain: chosenDomain, smtpHost, serverIpv4 })
        : route53SmtpRouteDnsParams({ domain: chosenDomain, smtpHost, serverIpv4 }),
      dnsProviderId,
      stepResults
    });

    await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: 7,
      skill: "wait_for_dns_propagation",
      actorId: effectiveInput.actorId,
      approvalTimeoutMs,
      budgetUsdMax: effectiveInput.budgetUsdMax,
      params: {
        domain: smtpHost,
        expectedRecord: { type: "A", value: serverIpv4 },
        maxWaitMs: 1_800_000,
        pollIntervalMs: 30_000
      },
      stepResults
    });

    await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: 8,
      skill: "bind_webdock_main_domain",
      actorId: effectiveInput.actorId,
      approvalTimeoutMs,
      budgetUsdMax: effectiveInput.budgetUsdMax,
      params: { serverSlug, domain: chosenDomain },
      // providerId por canal HERMANO (NO en params): un run no-Webdock toma el CONTABO BIND PATH en el
      // dispatcher (getServer + hostname por SSH + PTR manual + FCrDNS) en vez de getServer/setServerIdentity
      // contra la API Webdock (que daria 404 para un slug contabo-<id> y tumbaria el run). undefined/"webdock"
      // => bind Webdock byte-identico. El bind no necesita serverAccountId: el Webdock bind usa siempre la
      // cuenta-1 (deps.webdockAdapter) y el Contabo bind resuelve por providerId -> vpsProviderAdapters.
      providerId: vpsProviderId,
      stepResults
    });

    const smtp = await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: provisionSmtpPostfixStep,
      skill: "provision_smtp_postfix",
      actorId: effectiveInput.actorId,
      approvalTimeoutMs,
      budgetUsdMax: effectiveInput.budgetUsdMax,
      params: { serverSlug, domain: chosenDomain, serverIp: serverIpv4, selector },
      stepResults
    });

    const dkimPublicKey = stringFromOutcome(smtp.outcome, ["dkimPublicKey"], "");
    const dkimDnsValue = dkimDnsRecordValue(dkimPublicKey);
    if (dnsProviderId === "ionos" && !dkimDnsValue) {
      throw new OrchestratorFailure("failed", 10, "upsert_dns_ionos", "dkim_public_key_missing");
    }

    await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: 10,
      skill: dnsProviderId === "ionos" ? "upsert_dns_ionos" : "configure_email_auth",
      actorId: effectiveInput.actorId,
      approvalTimeoutMs,
      budgetUsdMax: effectiveInput.budgetUsdMax,
      params: dnsProviderId === "ionos"
        ? ionosEmailAuthDnsParams({
          domain: chosenDomain,
          serverIpv4,
          selector,
          dkimDnsValue
        })
        : {
          domain: chosenDomain,
          mxServerIp: serverIpv4,
          selector,
          dmarcPolicy: "quarantine",
          dkimPublicKey
        },
      dnsProviderId,
      stepResults
    });

    await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: 11,
      skill: "wait_for_dns_propagation",
      actorId: effectiveInput.actorId,
      approvalTimeoutMs,
      budgetUsdMax: effectiveInput.budgetUsdMax,
      params: {
        domain: `${selector}._domainkey.${chosenDomain}`,
        expectedRecord: { type: "TXT", value: "contains:v=DKIM1" },
        maxWaitMs: 1_800_000,
        pollIntervalMs: 30_000
      },
      stepResults
    });

    if (runState.params.seedInboxes.length !== 3) {
      throw new OrchestratorFailure("failed", 12, "seed_warmup_pool", "seed_inboxes_must_be_exactly_3");
    }
    await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: 12,
      skill: "seed_warmup_pool",
      actorId: effectiveInput.actorId,
      approvalTimeoutMs,
      budgetUsdMax: effectiveInput.budgetUsdMax,
      params: {
        domain: chosenDomain,
        serverSlug,
        serverIp: serverIpv4,
        seedInboxes: runState.params.seedInboxes
      },
      stepResults
    });

    await runReadOnlyStepWithState({
      deps,
      runState,
      runId,
      step: 13,
      skill: "wait_warmup_initial",
      params: { domain: chosenDomain, expectedDeliveries: 5, maxWaitMs: 3_600_000 },
      stepResults
    });

    const realEmail = await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: 14,
      skill: "send_real_email",
      actorId: effectiveInput.actorId,
      approvalTimeoutMs,
      budgetUsdMax: effectiveInput.budgetUsdMax,
      params: {
        fromAddress: `hello@${chosenDomain}`,
        toAddress: runState.params.testEmailRecipient,
        subject: coerceSafeSmokeSubject(runState.params.testEmailSubject, chosenDomain),
        body: coerceSafeSmokeBody(runState.params.testEmailBody, chosenDomain),
        serverSlug,
        selector,
        idempotencyKey: runId,
        runId
      },
      stepResults
    });

    // El handler send_real_email devuelve HTTP 400 {error,details} cuando la auth aun no esta
    // completa (p.ej. el DKIM no termino de propagar al momento del envio). El dispatcher lo
    // marca executed igual (corrio), de modo que sin esta guarda el step 14 quedaria "done",
    // el run "completed" pese a que NO se envio, y el parser de abajo lanzaria un confuso
    // "missing messageId". Detectamos el error aca: reportamos la causa REAL y borramos el
    // step 14 del estado para que un resume reintente el envio cuando el DNS termine de propagar.
    const sendErrorCode =
      isRecord(realEmail.outcome) && typeof realEmail.outcome.error === "string"
        ? realEmail.outcome.error.trim()
        : "";
    if (sendErrorCode) {
      const detailObj =
        isRecord(realEmail.outcome) && isRecord(realEmail.outcome.details)
          ? realEmail.outcome.details
          : null;
      const detailStr = detailObj
        ? ` (${Object.entries(detailObj).map(([k, v]) => `${k}=${String(v)}`).join(", ")})`
        : "";
      delete runState.steps[String(14)];
      runState.status = "failed";
      await persistSmtpRunState(deps, runState);
      await emitStep(deps, "oc.orchestrator.step_failed", runId, 14, "send_real_email", {
        error: sendErrorCode,
        ...(detailObj ? { details: detailObj } : {})
      });
      throw new OrchestratorFailure(
        "failed",
        14,
        "send_real_email",
        `${sendErrorCode}${detailStr}`,
        realEmail.proposalId,
        realEmail.inputHash
      );
    }

    const totalDurationMs = elapsed(deps, startedMs);
    const totalCostUsd = roundUsd(totalEstimatedCost(stepResults));
    runState.status = "completed";
    runState.finalEmailMessageId = stringFromOutcome(realEmail.outcome, ["messageId"], undefined);
    runState.finalDeliveryStatus = normalizeDeliveryStatus(stringFromOutcome(realEmail.outcome, ["deliveryStatus"], undefined));
    await persistSmtpRunState(deps, runState);
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
      finalEmailMessageId: runState.finalEmailMessageId,
      finalDeliveryStatus: runState.finalDeliveryStatus
    };
  } catch (error) {
    const failure = normalizeFailure(error);
    if (runState) {
      // Liberar el lease SOLO del create de VPS, que es idempotente (resolveExistingServerForCreate
      // reusa por hostname): asi un reintento tras un fallo recuperable (ej. webdock_payment_failed)
      // NO queda bloqueado los 45min del lease (HTTP 423) ni puede crear un VPS doble. El resto de
      // steps mantiene el lease como proteccion anti-doble-efecto (ej. compra de dominio en step 2).
      // NO liberar en fallos de contencion de lock: ese lease es de otro intento en vuelo.
      if (failure.skill === "create_webdock_server" && !STEP_LOCK_CONTENTION_FAILURES.has(failure.message)) {
        releaseRunStepLeaseOnFailure(runState, failure.step, failure.message, deps.now?.() ?? new Date());
      }
      runState.status = failure.status === "cancelled_by_operator" ? "cancelled_by_operator" : "failed";
      await persistSmtpRunState(deps, runState).catch(() => undefined);
    }
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

    if (serverSlug && failure.step >= 6 && deps.submitRollbackProposal && runState?.serverCreatedByRun === true) {
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
        reason: `configure_complete_smtp failed at step ${failure.step}: ${failure.message}`,
        // Enrutar el delete a la cuenta donde se creo el server (5.12). runState viejo sin el
        // campo => "ops" (backward-compat), igual que antes del cableado multicuenta.
        serverAccountId: runState?.serverAccountId ?? DEFAULT_CREATION_ACCOUNT_ID,
        // Enrutar el delete al proveedor donde se creo el server (canal HERMANO). undefined =>
        // Webdock: el spread condicional deja el payload BYTE-IDENTICO al de hoy en runs Webdock.
        ...(runState?.providerId ? { providerId: runState.providerId } : {})
      });
      rollbackProposalId = rollback.proposalId;
    } else if (serverSlug && failure.step >= 6 && deps.submitRollbackProposal) {
      const rollbackSkipReason = runState?.serverCreatedByRun === false
        ? "server_not_created_by_current_run"
        : "server_created_by_run_unknown";
      const rollbackSkipMessage = runState?.serverCreatedByRun === false
        ? "configure_complete_smtp skipped VPS delete rollback for reused/adopted server."
        : "configure_complete_smtp skipped VPS delete rollback because server ownership is unknown.";
      void logger.warn("openclaw.orchestrator.rollback_delete_skipped_reused_server", rollbackSkipMessage, {
        runId,
        failedStep: failure.step,
        skill: failure.skill,
        serverSlug,
        chosenDomain,
        serverCreatedByRun: runState?.serverCreatedByRun ?? null,
        serverAccountId: runState?.serverAccountId ?? null,
        providerId: runState?.providerId ?? null,
        reason: rollbackSkipReason
      });
      await audit(deps, "oc.orchestrator.rollback_delete_skipped_reused_server", "webdock_server", serverSlug, "high", {
        runId,
        failedStep: failure.step,
        skill: failure.skill,
        serverSlug,
        chosenDomain,
        serverCreatedByRun: runState?.serverCreatedByRun ?? null,
        providerId: runState?.providerId ?? null,
        serverAccountId: runState?.serverAccountId ?? null,
        reason: rollbackSkipReason
      });
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
  } finally {
    if (releaseRunLock) {
      await releaseRunLock();
    }
  }
}

async function acquireSmtpRunStateLock(
  deps: ConfigureCompleteSmtpDeps,
  runId: string
): Promise<() => Promise<void>> {
  const workspace = requireRunStateWorkspace(deps);
  await workspace.ensureBase();
  const key = `${workspace.getRootDir()}:${runId}`;
  if (smtpRunLocalLocks.has(key)) {
    throw new OrchestratorFailure("failed", 0, "run_lock", "run_already_in_progress");
  }

  let releaseLocalLock!: () => void;
  const localLock = new Promise<void>((resolve) => {
    releaseLocalLock = resolve;
  });
  smtpRunLocalLocks.set(key, localLock);

  let releaseFileLock: (() => Promise<void>) | null = null;
  try {
    releaseFileLock = await acquireSmtpRunFileLock(workspace, runId, deps.now?.() ?? new Date());
    return async () => {
      try {
        if (releaseFileLock) {
          await releaseFileLock();
        }
      } finally {
        releaseLocalLock();
        if (smtpRunLocalLocks.get(key) === localLock) {
          smtpRunLocalLocks.delete(key);
        }
      }
    };
  } catch (error) {
    releaseLocalLock();
    if (smtpRunLocalLocks.get(key) === localLock) {
      smtpRunLocalLocks.delete(key);
    }
    throw error;
  }
}

async function acquireSmtpRunFileLock(
  workspace: NonNullable<ConfigureCompleteSmtpDeps["workspace"]>,
  runId: string,
  now: Date
): Promise<() => Promise<void>> {
  const lockRoot = join(workspace.getRootDir(), "inventory", ".locks");
  await mkdir(lockRoot, { recursive: true });
  const lockDir = join(lockRoot, `run-${safeWorkspaceSegment(runId)}.lock`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, "lease.json"), JSON.stringify({
        runId,
        acquiredAt: now.toISOString(),
        leaseUntil: new Date(now.getTime() + smtpRunStateLockLeaseMs).toISOString(),
        pid: process.pid
      }, null, 2), "utf8");
      return async () => {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (!isFileAlreadyExistsError(error)) {
        throw new OrchestratorFailure("failed", 0, "run_lock", "run_lock_unavailable");
      }
      const expired = await smtpRunFileLockExpired(lockDir, now);
      if (expired) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      throw new OrchestratorFailure("failed", 0, "run_lock", "run_already_in_progress");
    }
  }

  throw new OrchestratorFailure("failed", 0, "run_lock", "run_already_in_progress");
}

async function smtpRunFileLockExpired(lockDir: string, now: Date): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    return now.getTime() - info.mtimeMs > smtpRunStateLockLeaseMs;
  } catch {
    return false;
  }
}

function requireRunStateWorkspace(
  deps: ConfigureCompleteSmtpDeps
): NonNullable<ConfigureCompleteSmtpDeps["workspace"]> {
  if (!deps.workspace) {
    throw new OrchestratorFailure("failed", 0, "run_state", "run_state_workspace_missing");
  }
  return deps.workspace;
}

async function loadOrCreateSmtpRunState(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  params: ConfigureCompleteSmtpParams;
  startedAt: Date;
}): Promise<SmtpRunState> {
  const existing = await readSmtpRunState(input.deps, input.runId);
  if (existing) {
    updateRunStateProgress(existing);
    return existing;
  }

  const legacy = await reconstructLegacySmtpRunState(input);
  if (legacy) {
    await persistSmtpRunState(input.deps, legacy);
    return legacy;
  }

  const state: SmtpRunState = {
    schemaVersion: smtpRunStateVersion,
    runId: input.runId,
    status: "running",
    createdAt: input.startedAt.toISOString(),
    updatedAt: input.startedAt.toISOString(),
    params: {
      brand: input.params.brand,
      ...(input.params.intent ? { intent: input.params.intent } : {}),
      ...(input.params.provider ? { provider: input.params.provider.trim().toLowerCase() } : {}),
      requireExistingDomain: input.params.requireExistingDomain === true,
      budgetUsdMax: input.params.budgetUsdMax,
      testEmailRecipient: input.params.testEmailRecipient.trim().toLowerCase(),
      testEmailSubject: input.params.testEmailSubject,
      testEmailBody: input.params.testEmailBody,
      seedInboxes: seedInboxesForRun(input.params, input.deps.env)
    },
    ...(input.params.domain ? { chosenDomain: normalizeDomain(input.params.domain), smtpHost: smtpHostForDomain(normalizeDomain(input.params.domain)) } : {}),
    selector: "s2026a",
    budgetSpentUsd: 0,
    lastCompletedStep: 0,
    steps: {}
  };
  await persistSmtpRunState(input.deps, state);
  return state;
}

function backfillSmtpRunStateServerIpv4(state: SmtpRunState): boolean {
  if (state.serverIpv4) return false;
  if (state.lastCompletedStep < 4) return false;
  const recovered =
    stringFromRunStateStepOutcome(state, 5, ["ipv4", "serverIp"]) ??
    stringFromRunStateStepOutcome(state, 4, ["ipv4", "serverIp"]);
  if (!recovered) return false;
  state.serverIpv4 = recovered;
  return true;
}

function assertSmtpRunStateServerIpv4Integrity(state: SmtpRunState): void {
  if (state.lastCompletedStep >= 5 && !state.serverIpv4) {
    throw new OrchestratorFailure(
      "failed",
      5,
      "wait_server_running",
      "server_ipv4_missing_in_run_state"
    );
  }
}

function stringFromRunStateStepOutcome(
  state: SmtpRunState,
  step: number,
  keys: string[]
): string | null {
  const outcome = state.steps[String(step)]?.result?.outcome;
  if (!isRecord(outcome)) return null;
  for (const key of keys) {
    const value = outcome[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function readSmtpRunState(
  deps: ConfigureCompleteSmtpDeps,
  runId: string
): Promise<SmtpRunState | null> {
  const workspace = requireRunStateWorkspace(deps);
  try {
    const raw = await workspace.readWorkspaceFile(smtpRunStatePath(runId));
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== smtpRunStateVersion || parsed.runId !== runId) {
      throw new OrchestratorFailure("failed", 0, "run_state", "run_state_corrupt");
    }
    return parsed as unknown as SmtpRunState;
  } catch (error) {
    if (error instanceof OrchestratorFailure) throw error;
    return null;
  }
}

export async function readSmtpRunProgress(
  deps: Pick<ConfigureCompleteSmtpDeps, "workspace">,
  runId: string
): Promise<CanvasLiveRunProgress | null> {
  const state = await readSmtpRunState(deps as ConfigureCompleteSmtpDeps, runId).catch(() => null);
  if (!state) return null;
  updateRunStateProgress(state);
  return smtpRunStateToProgress(state);
}

function smtpRunStateToProgress(state: SmtpRunState): CanvasLiveRunProgress {
  const identity = smtpRunStateToIdentity(state);
  return {
    runId: state.runId,
    status: state.status,
    lastCompletedStep: state.lastCompletedStep,
    steps: smtpRunProgressSteps.map((expected) => {
      const stepState = state.steps[String(expected.step)];
      const durationMs = safeNonNegativeNumber(stepState?.result?.durationMs);
      const error = safeProgressError(stepState?.lastError);
      return {
        step: expected.step,
        skill: stepState?.skill || expected.skill,
        status: normalizeSmtpRunProgressStepStatus(stepState?.status),
        label: smtpRunProgressStepLabel(stepState?.skill || expected.skill),
        ...safeTimestampField("startedAt", stepState?.startedAt),
        ...safeTimestampField("completedAt", stepState?.completedAt),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(error ? { error } : {})
      };
    }),
    ...(identity ? { identity } : {})
  };
}

function normalizeSmtpRunProgressStepStatus(status: string | undefined): "pending" | "in_flight" | "done" {
  if (status === "in_flight" || status === "done") return status;
  return "pending";
}

function smtpRunProgressStepLabel(skill: string): string {
  return skill
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function smtpRunStateToIdentity(state: SmtpRunState): CanvasLiveRunIdentity | undefined {
  const domain = state.chosenDomain;
  const smtpHost = state.smtpHost;
  const serverIpv4 = state.serverIpv4;
  const budgetSpentUsd = safeNonNegativeNumber(state.budgetSpentUsd);
  const finalDeliveryStatus = safeFinalDeliveryStatus(state.finalDeliveryStatus);
  const finalEmailMessageId = safeEmailMessageId(state.finalEmailMessageId);
  const dkimPublicKey = safeDkimPublicKey(stringFromOutcome(
    state.steps[String(provisionSmtpPostfixStep)]?.result?.outcome,
    ["dkimPublicKey"],
    ""
  ));
  const dnsRecords = buildSmtpRunIdentityDnsRecords({
    domain,
    smtpHost,
    serverIpv4,
    selector: state.selector,
    dkimPublicKey
  });
  const identity: CanvasLiveRunIdentity = {
    ...(state.params.brand ? { brand: state.params.brand } : {}),
    ...(domain ? { domain } : {}),
    ...(smtpHost ? { smtpHost } : {}),
    ...(state.serverSlug ? { serverSlug: state.serverSlug } : {}),
    ...(serverIpv4 ? { serverIpv4 } : {}),
    ...(state.serverAccountId ? { serverAccountId: state.serverAccountId } : {}),
    ...(state.providerId ? { providerId: state.providerId } : {}),
    ...(state.selector ? { dkimSelector: state.selector } : {}),
    ...(dkimPublicKey ? { dkimPublicKey } : {}),
    ...(dnsRecords.length > 0 ? { dnsRecords } : {}),
    ...(finalDeliveryStatus ? { finalDeliveryStatus } : {}),
    ...(finalEmailMessageId ? { finalEmailMessageId } : {}),
    ...(budgetSpentUsd === undefined ? {} : { budgetSpentUsd })
  };
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function buildSmtpRunIdentityDnsRecords(input: {
  domain?: string;
  smtpHost?: string;
  serverIpv4?: string;
  selector?: string;
  dkimPublicKey?: string;
}): NonNullable<CanvasLiveRunIdentity["dnsRecords"]> {
  const records: NonNullable<CanvasLiveRunIdentity["dnsRecords"]> = [];
  if (input.smtpHost && input.serverIpv4) {
    records.push({ name: input.smtpHost, type: "A", value: input.serverIpv4 });
  }
  if (input.domain && input.smtpHost) {
    records.push({ name: input.domain, type: "MX", value: `10 ${input.smtpHost}.` });
  }
  if (input.domain && input.serverIpv4) {
    records.push({ name: input.domain, type: "TXT", value: `v=spf1 ip4:${input.serverIpv4} -all` });
  }
  if (input.domain && input.selector && input.dkimPublicKey) {
    const dkimValue = dkimDnsRecordValue(input.dkimPublicKey);
    if (dkimValue) {
      records.push({
        name: `${input.selector}._domainkey.${input.domain}`,
        type: "TXT",
        value: dkimValue
      });
    }
  }
  if (input.domain) {
    records.push({
      name: `_dmarc.${input.domain}`,
      type: "TXT",
      value: "v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@delivrix.com; ruf=mailto:dmarc-forensics@delivrix.com; fo=1"
    });
  }
  return records;
}

function route53SmtpRouteDnsParams(input: {
  domain: string;
  smtpHost: string;
  serverIpv4: string;
}): Record<string, unknown> {
  return {
    domain: input.domain,
    records: [
      { name: input.smtpHost, type: "A", ttl: 300, values: [input.serverIpv4] },
      { name: input.domain, type: "MX", ttl: 300, values: [`10 ${input.smtpHost}.`] }
    ]
  };
}

function ionosSmtpRouteDnsParams(input: {
  domain: string;
  smtpHost: string;
  serverIpv4: string;
}): Record<string, unknown> {
  return {
    zone: input.domain,
    records: [
      { name: input.smtpHost, type: "A", ttl: 300, content: input.serverIpv4 },
      { name: input.domain, type: "MX", ttl: 300, content: `${input.smtpHost}.`, prio: 10 }
    ]
  };
}

function ionosEmailAuthDnsParams(input: {
  domain: string;
  serverIpv4: string;
  selector: string;
  dkimDnsValue: string;
}): Record<string, unknown> {
  return {
    zone: input.domain,
    records: [
      { name: input.domain, type: "TXT", ttl: 300, content: `v=spf1 ip4:${input.serverIpv4} -all` },
      { name: `${input.selector}._domainkey.${input.domain}`, type: "TXT", ttl: 300, content: input.dkimDnsValue },
      {
        name: `_dmarc.${input.domain}`,
        type: "TXT",
        ttl: 300,
        content: "v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@delivrix.com; ruf=mailto:dmarc-forensics@delivrix.com; fo=1"
      }
    ]
  };
}

function dkimDnsRecordValue(dkimPublicKey: string): string {
  const safePublicKey = safeDkimPublicKey(dkimPublicKey);
  if (!safePublicKey) return "";
  return /^v\s*=\s*DKIM1\b/i.test(safePublicKey)
    ? safePublicKey
    : `v=DKIM1; k=rsa; p=${safePublicKey}`;
}

function safeDkimPublicKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /PRIVATE KEY|BEGIN [A-Z ]*KEY|END [A-Z ]*KEY/i.test(trimmed)) return "";
  if (isSafeDkimRecordValue(trimmed) || isSafeDkimRawPublicKey(trimmed)) return trimmed;
  return "";
}

function isSafeDkimRecordValue(value: string): boolean {
  if (/[\u0000-\u001f\u007f"'`\\]/.test(value) || value.length > 4096) return false;
  const allowedTags = new Set(["v", "k", "p", "t", "n", "s", "h"]);
  const tags = new Map<string, string>();
  for (const part of value.split(";").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([a-z][a-z0-9_]*)\s*=\s*([A-Za-z0-9+/=:_.,-]+)$/i.exec(part);
    if (!match) return false;
    const key = match[1].toLowerCase();
    if (!allowedTags.has(key) || tags.has(key)) return false;
    tags.set(key, match[2]);
  }
  return tags.get("v")?.toUpperCase() === "DKIM1" && isSafeDkimRawPublicKey(tags.get("p") ?? "");
}

function isSafeDkimRawPublicKey(value: string): boolean {
  return value.length <= 4096 && /^[A-Za-z0-9+/=]+$/.test(value);
}

function safeNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeTimestampField<Key extends "startedAt" | "completedAt">(
  key: Key,
  value: string | undefined
): Partial<Record<Key, string>> {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) return {};
  return { [key]: value } as Partial<Record<Key, string>>;
}

function safeProgressError(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return allowedSmtpProgressErrors.has(trimmed) ? trimmed : "step_error";
}

const allowedSmtpProgressErrors = new Set([
  "cancelled_by_operator",
  "domain_unavailable",
  "dns_propagation_pending",
  "dns_propagation_timeout",
  "gated_multiaccount_unsupported",
  "gated_provider_unsupported",
  "no_eligible_accounts",
  "purchase_failed",
  "rate_limit_exceeded",
  "route53_registration_pending",
  "step_error",
  "step_failed",
  "step_timeout",
  "waiting_for_dns_propagation",
  "waiting_for_route53_operation"
]);

function safeFinalDeliveryStatus(value: string | undefined): string | undefined {
  if (value === "queued" || value === "delivered" || value === "deferred" || value === "bounced") return value;
  return undefined;
}

function safeEmailMessageId(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^<|>$/g, "");
  if (!trimmed || trimmed.length > 220) return undefined;
  if (/token|secret|password|credential|authorization|private|bearer|api[_-]?key/i.test(trimmed)) return undefined;
  return /^delivrix-[a-z0-9-]{1,80}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(trimmed)
    ? trimmed
    : undefined;
}

async function persistSmtpRunState(
  deps: ConfigureCompleteSmtpDeps,
  state: SmtpRunState
): Promise<void> {
  const workspace = requireRunStateWorkspace(deps);
  state.updatedAt = (deps.now?.() ?? new Date()).toISOString();
  updateRunStateProgress(state);
  await workspace.writeWorkspaceFileAtomic(smtpRunStatePath(state.runId), `${JSON.stringify(redactSmtpRunState(state), null, 2)}\n`);
}

function smtpRunStatePath(runId: string): string {
  return `inventory/smtp-runs/${safeWorkspaceSegment(runId)}.json`;
}

function safeWorkspaceSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "unknown";
}

function seedInboxesForRun(
  input: ConfigureCompleteSmtpParams,
  env: Record<string, string | undefined> | undefined
): string[] {
  if (Array.isArray(input.seedInboxes) && input.seedInboxes.length > 0) {
    return input.seedInboxes.map((entry) => entry.trim().toLowerCase());
  }
  return (env?.WARMUP_DEFAULT_SEED_INBOXES ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function inputFromRunState(
  input: ConfigureCompleteSmtpParams,
  state: SmtpRunState
): ConfigureCompleteSmtpParams {
  return {
    ...input,
    runId: state.runId,
    ...(state.chosenDomain ? { domain: state.chosenDomain } : input.domain ? { domain: input.domain } : {}),
    ...(state.params.provider ? { provider: state.params.provider } : input.provider ? { provider: input.provider } : {}),
    ...(state.dnsProviderId ? { dnsProviderId: state.dnsProviderId } : input.dnsProviderId ? { dnsProviderId: input.dnsProviderId } : {}),
    requireExistingDomain: state.params.requireExistingDomain,
    budgetUsdMax: state.params.budgetUsdMax,
    testEmailRecipient: state.params.testEmailRecipient,
    testEmailSubject: state.params.testEmailSubject,
    testEmailBody: state.params.testEmailBody,
    seedInboxes: state.params.seedInboxes
  };
}

function validateResumeScopeAgainstRunState(input: {
  state: SmtpRunState;
  planApproval: PlanApprovalRecord | null;
  request: ConfigureCompleteSmtpParams;
  now: Date;
}): void {
  const state = input.state;
  if (input.planApproval) {
    const details: string[] = [];
    if (state.chosenDomain && input.planApproval.scope.domain !== state.chosenDomain) details.push("domain");
    if (state.params.provider && input.planApproval.scope.provider !== state.params.provider) details.push("provider");
    if (input.planApproval.scope.recipient !== state.params.testEmailRecipient) details.push("recipient");
    if ((input.planApproval.scope.requireExistingDomain === true) !== state.params.requireExistingDomain) details.push("requireExistingDomain");
    if (input.planApproval.scope.budgetUsdMax < state.budgetSpentUsd) details.push("budgetUsdMax");
    if (Date.parse(input.planApproval.expiresAt) <= input.now.getTime()) details.push("plan_approval_expired");
    if (details.length > 0) {
      throw new OrchestratorFailure("failed", 0, "run_state", `resume_scope_drift: ${details.join(",")}`);
    }
  }

  // En un RESUME el orquestador ejecuta SIEMPRE con los params del ESTADO persistido, no con el
  // request crudo que reenvia OpenClaw: inputFromRunState reescribe recipient/budget/etc desde
  // state.params, y p.ej. el smoke envia a runState.params.testEmailRecipient (no a input.request).
  // Por eso NO abortamos si el request difiere en recipient/budget/requireExistingDomain — OpenClaw
  // no memoriza esos valores exactos al reanudar y exigirselos idénticos era un falso positivo que
  // bloqueaba todo resume legitimo (resume_scope_drift: recipient). La proteccion REAL del scope la
  // dan: (1) el bloque de arriba (firma del plan vs estado) y (2) validatePlanApprovedStepScope por
  // cada paso, que aborta si el recipient/domain REAL de la accion no coincide con la firma.
  // Solo el DOMAIN del request, si viene y difiere del ya elegido, es senal fuerte de confusion
  // (reanudar el run de un dominio con otro) y si justifica abortar.
  const requestDomain = input.request.domain ? normalizeDomain(input.request.domain) : null;
  if (requestDomain && state.chosenDomain && requestDomain !== state.chosenDomain) {
    throw new OrchestratorFailure("failed", 0, "run_state", "resume_scope_drift: domain");
  }
}

function assertDnsProviderResumeCompatible(
  state: SmtpRunState,
  request: ConfigureCompleteSmtpParams
): void {
  const requested = normalizeDnsProviderId(request.dnsProviderId);
  if (!requested) return;
  if (state.dnsProviderId === requested) return;
  if (state.dnsProviderId && state.dnsProviderId !== requested) {
    throw new OrchestratorFailure("failed", 0, "dns_provider_guard", "dns_provider_conflict_in_existing_run");
  }
  if (smtpRunStateHasProviderLockedProgress(state)) {
    throw new OrchestratorFailure("failed", 0, "dns_provider_guard", "dns_provider_conflict_in_existing_run");
  }
}

function smtpRunStateHasProviderLockedProgress(state: SmtpRunState): boolean {
  if (state.lastCompletedStep > 0 || state.serverSlug || state.serverIpv4) return true;
  return Object.values(state.steps).some((step) => step.status === "done" || step.status === "in_flight");
}

async function reconstructLegacySmtpRunState(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  params: ConfigureCompleteSmtpParams;
  startedAt: Date;
}): Promise<SmtpRunState | null> {
  const workspace = requireRunStateWorkspace(input.deps);
  const webdock = await workspace.readInventoryJson<WebdockInventoryForResume>("webdock-servers.json").catch(() => null);
  const binding = webdock?.runBindings?.find((entry) => entry.runId === input.runId);
  if (!binding) return null;

  const server = webdock?.servers?.find((entry) => entry.slug === binding.serverSlug);
  const chosenDomain = input.params.domain ? normalizeDomain(input.params.domain) : domainFromLegacyBinding(binding.domain);
  if (!chosenDomain || !binding.serverSlug) return null;
  const legacyIpv4 = typeof server?.ipv4 === "string" && server.ipv4.trim() ? server.ipv4.trim() : "";
  const dnsProviderId = normalizeDnsProviderId(input.params.dnsProviderId);

  const now = input.startedAt.toISOString();
  const state: SmtpRunState = {
    schemaVersion: smtpRunStateVersion,
    runId: input.runId,
    status: "running",
    createdAt: now,
    updatedAt: now,
    params: {
      brand: input.params.brand,
      ...(input.params.intent ? { intent: input.params.intent } : {}),
      ...(input.params.provider ? { provider: input.params.provider.trim().toLowerCase() } : {}),
      requireExistingDomain: input.params.requireExistingDomain === true,
      budgetUsdMax: input.params.budgetUsdMax,
      testEmailRecipient: input.params.testEmailRecipient.trim().toLowerCase(),
      testEmailSubject: input.params.testEmailSubject,
      testEmailBody: input.params.testEmailBody,
      seedInboxes: seedInboxesForRun(input.params, input.deps.env)
    },
    chosenDomain,
    smtpHost: smtpHostForDomain(chosenDomain),
    serverSlug: binding.serverSlug,
    ...(legacyIpv4 ? { serverIpv4: legacyIpv4 } : {}),
    ...(dnsProviderId === "ionos" ? { dnsProviderId } : {}),
    selector: "s2026a",
    budgetSpentUsd: 0,
    lastCompletedStep: 0,
    legacyReconstructed: true,
    steps: {}
  };

  recordLegacyDoneStep(state, 1, "suggest_safe_domain", {
    brand: input.params.brand,
    intent: input.params.intent ?? "ops",
    count: 5,
    actorId: input.params.actorId
  }, { candidates: [{ domain: chosenDomain, available: true, source: "legacy_reconstructed" }] });
  if (dnsProviderId === "ionos") {
    recordLegacyDoneStep(state, 2, "register_domain_route53", {
      domain: chosenDomain,
      years: 1,
      autoRenew: false
    }, {
      ok: true,
      status: "skipped",
      reason: "ionos_owned_domain",
      provider: "ionos",
      domain: chosenDomain
    }, 0);
    recordLegacyDoneStep(state, 3, "wait_for_dns_propagation", {
      domain: chosenDomain,
      expectedRecord: { type: "NS", value: "skipped:ionos-authoritative" },
      maxWaitMs: 0,
      pollIntervalMs: 0
    }, {
      ok: true,
      status: "skipped",
      reason: "ionos_authoritative_nameservers",
      provider: "ionos"
    });
  } else {
    await reconcileLegacyDomainStep(input.deps, state, chosenDomain);
    recordLegacyDoneStep(state, 3, "wait_for_dns_propagation", {
      domain: chosenDomain,
      expectedRecord: { type: "NS", value: "contains:awsdns" },
      maxWaitMs: 1_800_000,
      pollIntervalMs: 60_000
    }, { ok: true, status: "legacy_reconstructed" });
  }
  recordLegacyDoneStep(state, 4, "create_webdock_server", {
    runId: input.runId,
    profile: "bit",
    locationId: "dk",
    hostname: smtpHostForDomain(chosenDomain),
    imageSlug: "ubuntu-2404"
  }, { status: binding.source, serverSlug: binding.serverSlug, slug: binding.serverSlug, ipv4: legacyIpv4 || null, costUsd: 0 });
  state.serverCreatedByRun = classifyLegacyServerBindingSource(binding.source) === "created";
  if (legacyIpv4) {
    recordLegacyDoneStep(state, 5, "wait_server_running", {
      serverSlug: binding.serverSlug,
      maxWaitMs: 600_000
    }, { ok: true, status: "legacy_reconstructed", serverSlug: binding.serverSlug, ipv4: legacyIpv4 });
  }
  updateRunStateProgress(state);
  return state;
}

async function reconcileLegacyDomainStep(
  deps: ConfigureCompleteSmtpDeps,
  state: SmtpRunState,
  domain: string
): Promise<void> {
  const inventory = await requireRunStateWorkspace(deps)
    .readInventoryJson<DomainsInventoryForResume>("domains.json")
    .catch(() => null);
  const entry = inventory?.domains?.find((candidate) => candidate.domain === domain);
  if (!entry || !["owned", "pending", "purchase_reserved", "needs_reconciliation"].includes(entry.status ?? "")) {
    return;
  }
  recordLegacyDoneStep(state, 2, "register_domain_route53", {
    domain,
    years: 1,
    autoRenew: false
  }, {
    ok: true,
    status: entry.status,
    operationId: entry.operationId,
    costUsd: entry.costUsd ?? 0
  }, entry.costUsd ?? 0);
}

function domainFromLegacyBinding(value: string): string | null {
  const normalized = normalizeMaybeDomain(value);
  if (!normalized) return null;
  return normalized.startsWith("smtp.") ? normalizeMaybeDomain(normalized.slice("smtp.".length)) : normalized;
}

function classifyFreshStep4ServerProvenance(status: string): ServerProvenanceClassification {
  const normalized = normalizeServerProvenance(status);
  if (reusedServerProvenance.has(normalized)) return "reused";
  return "created";
}

function classifyLegacyServerBindingSource(source: string): ServerProvenanceClassification {
  const normalized = normalizeServerProvenance(source);
  if (createdServerProvenance.has(normalized)) return "created";
  if (reusedServerProvenance.has(normalized)) return "reused";
  return "unknown";
}

function normalizeServerProvenance(value: string): string {
  return value.trim().toLowerCase();
}

function recordLegacyDoneStep(
  state: SmtpRunState,
  step: number,
  skill: string,
  params: Record<string, unknown>,
  outcome: unknown,
  estimatedCostUsd?: number
): void {
  const inputHash = hashInput(params);
  const result: ConfigureCompleteSmtpStepResult = {
    step,
    skill,
    inputHash,
    outcome,
    durationMs: 0,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd })
  };
  state.steps[String(step)] = {
    step,
    skill,
    status: "done",
    inputHash,
    result,
    estimatedCostUsd,
    startedAt: state.createdAt,
    completedAt: state.createdAt,
    updatedAt: state.createdAt
  };
}

async function recordSyntheticDoneStepWithState(input: {
  deps: ConfigureCompleteSmtpDeps;
  runState: SmtpRunState;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  outcome: unknown;
  estimatedCostUsd?: number;
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<ConfigureCompleteSmtpStepResult> {
  const skipped = await skipDoneStep({
    deps: input.deps,
    runState: input.runState,
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    params: input.params,
    stepResults: input.stepResults
  });
  if (skipped) return skipped;

  const inputHash = hashInput(input.params);
  const result: ConfigureCompleteSmtpStepResult = {
    step: input.step,
    skill: input.skill,
    inputHash,
    outcome: input.outcome,
    durationMs: 0,
    ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: input.estimatedCostUsd })
  };
  input.stepResults.push(result);
  await markRunStepDone({
    deps: input.deps,
    runState: input.runState,
    result
  });
  await emitStep(input.deps, "oc.orchestrator.step_completed", input.runId, input.step, input.skill, {
    synthetic: true,
    durationMs: 0
  });
  return result;
}

function updateRunStateProgress(state: SmtpRunState): void {
  const doneResults = Object.values(state.steps)
    .filter((entry): entry is SmtpRunStepState & { result: ConfigureCompleteSmtpStepResult } =>
      entry.status === "done" && entry.result !== undefined
    )
    .map((entry) => entry.result)
    .sort((left, right) => left.step - right.step);
  state.budgetSpentUsd = roundUsd(totalEstimatedCost(doneResults));
  let cursor = 0;
  for (let step = 1; step <= 14; step += 1) {
    const stateStep = state.steps[String(step)];
    if (stateStep?.status === "done" && stateStep.result) {
      cursor = step;
      continue;
    }
    break;
  }
  state.lastCompletedStep = cursor;
}

function redactSmtpRunState(state: SmtpRunState): SmtpRunState {
  return sanitizeJsonValue(JSON.parse(JSON.stringify(state))) as SmtpRunState;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/private|secret|password|credential|authorization|approvalToken/i.test(key)) {
      output[`${key}Redacted`] = true;
      continue;
    }
    output[key] = sanitizeJsonValue(item);
  }
  return output;
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

async function runReadOnlyStepWithState(input: {
  deps: ConfigureCompleteSmtpDeps;
  runState: SmtpRunState;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  serverAccountId?: string;
  providerId?: string;
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<unknown> {
  const skipped = await skipDoneStep({
    deps: input.deps,
    runState: input.runState,
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    params: input.params,
    stepResults: input.stepResults
  });
  if (skipped) return skipped.outcome;
  return runReadOnlyStep(input);
}

async function runMutatingStepWithState(input: {
  deps: ConfigureCompleteSmtpDeps;
  runState: SmtpRunState;
  planApproval: PlanApprovalRecord | null;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  actorId: string;
  approvalTimeoutMs: number;
  estimatedCostUsd?: number;
  budgetUsdMax: number;
  serverAccountId?: string;
  providerId?: string;
  dnsProviderId?: string;
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<ConfigureCompleteSmtpStepResult> {
  const skipped = await skipDoneStep({
    deps: input.deps,
    runState: input.runState,
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    params: input.params,
    stepResults: input.stepResults
  });
  if (skipped) return skipped;
  return runMutatingStep(input);
}

async function awaitFreshRoute53Registration(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  result: ConfigureCompleteSmtpStepResult;
  domain: string;
  costUsd?: number;
}): Promise<void> {
  const status = stringFromOutcome(input.result.outcome, ["status"], "");
  if (status !== "pending") return;

  const operationId = stringFromOutcome(input.result.outcome, ["operationId"], "");
  if (!operationId || isSyntheticRoute53OperationId(operationId)) {
    await audit(input.deps, "oc.domain.registration_wait_blocked", "domain", input.domain, "critical", {
      runId: input.runId,
      step: input.result.step,
      status,
      operationId,
      reason: operationId ? "synthetic_operation_id" : "missing_operation_id"
    });
    throw new OrchestratorFailure(
      "failed",
      input.result.step,
      input.result.skill,
      "domain_registration_failed",
      input.result.proposalId,
      input.result.inputHash
    );
  }

  if (!input.deps.waitForRoute53DomainRegistration) {
    await audit(input.deps, "oc.domain.registration_wait_blocked", "domain", input.domain, "critical", {
      runId: input.runId,
      step: input.result.step,
      operationId,
      reason: "route53_registration_wait_missing"
    });
    throw new OrchestratorFailure(
      "failed",
      input.result.step,
      input.result.skill,
      "domain_registration_failed",
      input.result.proposalId,
      input.result.inputHash
    );
  }

  await audit(input.deps, "oc.domain.registration_wait_started", "domain", input.domain, "critical", {
    runId: input.runId,
    step: input.result.step,
    operationId,
    maxWaitMs: route53DomainRegistrationWaitMaxMs,
    pollIntervalMs: route53DomainRegistrationWaitPollMs
  });
  const wait = await input.deps.waitForRoute53DomainRegistration({
    domain: input.domain,
    operationId,
    expectedExpiry: stringFromOutcome(input.result.outcome, ["expectedExpiry"], ""),
    costUsd: input.costUsd,
    maxWaitMs: route53DomainRegistrationWaitMaxMs,
    pollIntervalMs: route53DomainRegistrationWaitPollMs
  });

  if (wait.status === "owned" || wait.status === "skipped") {
    await audit(input.deps, "oc.domain.registration_wait_completed", "domain", input.domain, "critical", {
      runId: input.runId,
      step: input.result.step,
      status: wait.status,
      reason: wait.status === "skipped" ? wait.reason : undefined,
      operationId: wait.operationId,
      operationStatus: wait.status === "owned" ? wait.operationStatus : undefined,
      attempts: wait.attempts,
      durationMs: wait.durationMs
    });
    return;
  }

  await audit(input.deps, "oc.domain.registration_wait_failed", "domain", input.domain, "critical", {
    runId: input.runId,
    step: input.result.step,
    blockers: wait.blockers,
    operationId: wait.operationId,
    operationStatus: wait.operationStatus,
    attempts: wait.attempts,
    durationMs: wait.durationMs,
    message: wait.message
  });
  throw new OrchestratorFailure(
    "failed",
    input.result.step,
    input.result.skill,
    "domain_registration_failed",
    input.result.proposalId,
    input.result.inputHash
  );
}

async function skipDoneStep(input: {
  deps: ConfigureCompleteSmtpDeps;
  runState: SmtpRunState;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<ConfigureCompleteSmtpStepResult | null> {
  const inputHash = hashInput(input.params);
  const existing = input.runState.steps[String(input.step)];
  if (!existing) return null;
  if (existing.status === "done") {
    if (!existing.result) {
      throw new OrchestratorFailure("failed", input.step, input.skill, "run_state_corrupt");
    }
    if (existing.skill !== input.skill || existing.inputHash !== inputHash) {
      throw new OrchestratorFailure("failed", input.step, input.skill, "resume_scope_drift: step_input_changed", undefined, inputHash);
    }
    if (!input.stepResults.some((entry) => entry.step === existing.result?.step)) {
      input.stepResults.push(existing.result);
    }
    await emitStep(input.deps, "oc.orchestrator.step_completed", input.runId, input.step, input.skill, {
      skipped: true,
      resume: true,
      durationMs: existing.result.durationMs
    });
    return existing.result;
  }
  if (existing.status === "in_flight") {
    const leaseUntil = Date.parse(existing.leaseUntil ?? "");
    const nowMs = (input.deps.now?.() ?? new Date()).getTime();
    if (Number.isFinite(leaseUntil) && leaseUntil > nowMs) {
      throw new OrchestratorFailure("failed", input.step, input.skill, "step_in_flight", undefined, inputHash);
    }
    if (existing.skill !== input.skill) {
      throw new OrchestratorFailure("failed", input.step, input.skill, "step_reconciliation_required", undefined, inputHash);
    }
    return null;
  }
  return null;
}

async function markRunStepInFlight(input: {
  deps: ConfigureCompleteSmtpDeps;
  runState?: SmtpRunState;
  runId: string;
  step: number;
  skill: string;
  inputHash: string;
  estimatedCostUsd?: number;
}): Promise<void> {
  if (!input.runState) return;
  const now = input.deps.now?.() ?? new Date();
  const existing = input.runState.steps[String(input.step)];
  if (existing?.status === "in_flight") {
    const leaseUntil = Date.parse(existing.leaseUntil ?? "");
    if (Number.isFinite(leaseUntil) && leaseUntil > now.getTime()) {
      throw new OrchestratorFailure("failed", input.step, input.skill, "step_in_flight", undefined, input.inputHash);
    }
    if (existing.skill !== input.skill) {
      throw new OrchestratorFailure("failed", input.step, input.skill, "step_reconciliation_required", undefined, input.inputHash);
    }
  }
  if (existing?.status === "done") {
    throw new OrchestratorFailure("failed", input.step, input.skill, "step_already_done", undefined, input.inputHash);
  }
  input.runState.status = "running";
  input.runState.steps[String(input.step)] = {
    step: input.step,
    skill: input.skill,
    status: "in_flight",
    inputHash: input.inputHash,
    attemptId: randomUUID(),
    leaseUntil: new Date(now.getTime() + smtpRunStepLeaseMs).toISOString(),
    startedAt: now.toISOString(),
    estimatedCostUsd: input.estimatedCostUsd,
    updatedAt: now.toISOString()
  };
  await persistSmtpRunState(input.deps, input.runState);
}

async function markRunStepDone(input: {
  deps: ConfigureCompleteSmtpDeps;
  runState?: SmtpRunState;
  result: ConfigureCompleteSmtpStepResult;
}): Promise<void> {
  if (!input.runState) return;
  const now = input.deps.now?.() ?? new Date();
  input.runState.steps[String(input.result.step)] = {
    step: input.result.step,
    skill: input.result.skill,
    status: "done",
    inputHash: input.result.inputHash,
    result: input.result,
    estimatedCostUsd: input.result.estimatedCostUsd,
    startedAt: input.runState.steps[String(input.result.step)]?.startedAt ?? now.toISOString(),
    completedAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  await persistSmtpRunState(input.deps, input.runState);
}

/**
 * Fallos que provienen de la contencion del lock (no de la ejecucion del step): el lease in_flight
 * pertenece a OTRO intento en vuelo, asi que NO debe liberarse al capturarlos.
 */
const STEP_LOCK_CONTENTION_FAILURES = new Set([
  "step_in_flight",
  "step_already_done",
  "step_reconciliation_required"
]);

/**
 * Libera el lease de un step que quedo in_flight tras un fallo de EJECUCION, para que un reintento no
 * tenga que esperar los 45min del lease (smtpRunStepLeaseMs). Lo deja "pending" (reintentable) y
 * registra el error en lastError. Solo toca steps in_flight; nunca un done. Devuelve true si libero.
 */
function releaseRunStepLeaseOnFailure(
  runState: SmtpRunState | undefined,
  step: number,
  reason: string,
  now: Date
): boolean {
  if (!runState) return false;
  const key = String(step);
  const existing = runState.steps[key];
  if (!existing || existing.status !== "in_flight") return false;
  runState.steps[key] = {
    ...existing,
    status: "pending",
    leaseUntil: undefined,
    attemptId: undefined,
    lastError: reason.slice(0, 500),
    updatedAt: now.toISOString()
  };
  return true;
}

/**
 * Detecta si un fallo del create de VPS fue un RECHAZO DE PAGO recuperable (webdock_payment_failed),
 * para disparar el failover a otra cuenta. Mira el failureCode/error del outcome del step y, como
 * respaldo, el mensaje del fallo. NO dispara failover para otros errores (red, validacion, etc).
 */
function isRecoverablePaymentFailure(
  failure: { message: string },
  lastResult: ConfigureCompleteSmtpStepResult | undefined
): boolean {
  const paymentPattern = /payment failed|payment method|service credit|enough credit|webdock_payment_failed/i;
  const outcome = lastResult?.outcome;
  if (outcome && typeof outcome === "object" && !Array.isArray(outcome)) {
    const record = outcome as Record<string, unknown>;
    if (record.failureCode === "webdock_payment_failed") return true;
    if (typeof record.error === "string" && paymentPattern.test(record.error)) return true;
  }
  return paymentPattern.test(failure.message ?? "");
}

async function runReadOnlyStep(input: {
  deps: ConfigureCompleteSmtpDeps;
  runState?: SmtpRunState;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  serverAccountId?: string;
  providerId?: string;
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
  await markRunStepInFlight({
    deps: input.deps,
    runState: input.runState,
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    inputHash
  });
  const outcome = await input.deps.invokeSkill({
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    params: input.params,
    ...(input.serverAccountId ? { serverAccountId: input.serverAccountId } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {})
  });
  const result = {
    step: input.step,
    skill: input.skill,
    inputHash,
    outcome,
    durationMs: Date.now() - startedAt
  };
  input.stepResults.push(result);
  await markRunStepDone({
    deps: input.deps,
    runState: input.runState,
    result
  });
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
  runState?: SmtpRunState;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  actorId: string;
  approvalTimeoutMs: number;
  estimatedCostUsd?: number;
  budgetUsdMax: number;
  serverAccountId?: string;
  providerId?: string;
  dnsProviderId?: string;
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<ConfigureCompleteSmtpStepResult> {
  await verifyAuditChain(input.deps);
  const inputHash = hashInput(input.params);
  ensureBudgetForStep(input, inputHash);
  await markRunStepInFlight({
    deps: input.deps,
    runState: input.runState,
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    inputHash,
    estimatedCostUsd: input.estimatedCostUsd
  });
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
    estimatedCostUsd: input.estimatedCostUsd,
    // Canales paralelos (no entran a params/hashInput); el create gated los usa para enrutar cuenta/proveedor.
    ...(input.serverAccountId ? { serverAccountId: input.serverAccountId } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.dnsProviderId ? { dnsProviderId: input.dnsProviderId } : {})
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
    await markRunStepDone({
      deps: input.deps,
      runState: input.runState,
      result
    });
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
  const failedResult = {
    step: input.step,
    skill: input.skill,
    inputHash,
    proposalId: decision.proposalId,
    outcome: "outcome" in decision ? decision.outcome ?? { error: failureMessage } : { error: failureMessage },
    durationMs: "durationMs" in decision ? decision.durationMs : 0,
    ...("signatureId" in decision && decision.signatureId ? { signatureId: decision.signatureId } : {}),
    ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: input.estimatedCostUsd })
  };
  input.stepResults.push(failedResult);
  throw new OrchestratorFailure(
    "failed",
    input.step,
    input.skill,
    failureMessage,
    decision.proposalId,
    inputHash
  );
}

async function runMutatingStep(input: {
  deps: ConfigureCompleteSmtpDeps;
  runState?: SmtpRunState;
  planApproval: PlanApprovalRecord | null;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  actorId: string;
  approvalTimeoutMs: number;
  estimatedCostUsd?: number;
  budgetUsdMax: number;
  serverAccountId?: string;
  providerId?: string;
  dnsProviderId?: string;
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<ConfigureCompleteSmtpStepResult> {
  if (input.planApproval) {
    return runPlanApprovedStep({
      deps: input.deps,
      runState: input.runState,
      planApproval: input.planApproval,
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      params: input.params,
      actorId: input.actorId,
      estimatedCostUsd: input.estimatedCostUsd,
      budgetUsdMax: input.budgetUsdMax,
      serverAccountId: input.serverAccountId,
      providerId: input.providerId,
      dnsProviderId: input.dnsProviderId,
      stepResults: input.stepResults
    });
  }

  // Guard multicuenta del camino GATED (5.12). El selector (resolveCreationAccount) corre SIEMPRE,
  // pero el camino gated (submitAndAwaitApproval -> aprobacion humana -> execute) es single-account:
  // su processor NO recibe el accountId, asi que crearia el VPS en la cuenta-1 ("ops") mientras el
  // rollback/delete enruta a runState.serverAccountId (la cuenta elegida) -> VPS HUERFANO que cuesta
  // plata. Si el gated seleccionó una cuenta != "ops", abortamos LIMPIO ANTES de crear, en vez de
  // crear en la cuenta equivocada. (Single-account/produ NO afectados: ops===ops no dispara; el
  // camino autonomo con firma de plan propaga el accountId de verdad por arriba.)
  if (input.serverAccountId && input.serverAccountId !== DEFAULT_CREATION_ACCOUNT_ID) {
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      "gated_multiaccount_unsupported"
    );
  }

  // Guard de proveedor del camino GATED (HERMANO del de multicuenta). El processor gated single-account
  // NO recibe el providerId, asi que crearia el VPS en Webdock mientras el rollback/delete enruta a
  // runState.providerId (Contabo) -> VPS HUERFANO. Si el gated pidio un proveedor != Webdock, abortamos
  // LIMPIO ANTES de crear. (undefined/"webdock" NO dispara; el camino autonomo con firma de plan
  // propaga el providerId de verdad por arriba via executePlanApprovedStep -> dispatch.)
  if (isNonWebdockProviderId(input.providerId)) {
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      "gated_provider_unsupported"
    );
  }

  return runGatedStep(input);
}

async function runPlanApprovedStep(input: {
  deps: ConfigureCompleteSmtpDeps;
  runState?: SmtpRunState;
  planApproval: PlanApprovalRecord;
  runId: string;
  step: number;
  skill: string;
  params: Record<string, unknown>;
  actorId: string;
  estimatedCostUsd?: number;
  budgetUsdMax: number;
  serverAccountId?: string;
  providerId?: string;
  dnsProviderId?: string;
  stepResults: ConfigureCompleteSmtpStepResult[];
}): Promise<ConfigureCompleteSmtpStepResult> {
  if (!input.deps.executePlanApprovedStep) {
    throw new OrchestratorFailure("failed", input.step, input.skill, "plan_executor_missing");
  }
  await verifyAuditChain(input.deps);
  await ensureKillSwitchClear(input.deps, input.step, input.skill);
  const inputHash = hashInput(input.params);
  ensureBudgetForStep(input, inputHash);
  validatePlanApprovedStepScope(input, inputHash);
  await markRunStepInFlight({
    deps: input.deps,
    runState: input.runState,
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    inputHash,
    estimatedCostUsd: input.estimatedCostUsd
  });
  void (input.deps.logger ?? noopGatewayRuntimeLogger).info("openclaw.orchestrator.step_started", "Plan-approved orchestrator step started.", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    approvalRequired: false,
    planApprovalScopeHash: input.planApproval.scopeHash,
    estimatedCostUsd: input.estimatedCostUsd ?? 0,
    params: summarizeOperationalParams(input.params)
  });
  await emitStep(input.deps, "oc.orchestrator.step_started", input.runId, input.step, input.skill, {
    approvalRequired: false,
    planApproved: true,
    estimatedCostUsd: input.estimatedCostUsd ?? 0
  });

  const decision = await input.deps.executePlanApprovedStep({
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    params: input.params,
    actorId: input.actorId,
    inputHash,
    estimatedCostUsd: input.estimatedCostUsd,
    planApproval: input.planApproval,
    // Canales paralelos (no entran a params/hashInput); el dispatch del create los usa como accountId/
    // providerId destino. providerId undefined/"webdock" => Webdock (byte-identico).
    ...(input.serverAccountId ? { serverAccountId: input.serverAccountId } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.dnsProviderId ? { dnsProviderId: input.dnsProviderId } : {})
  });

  if (decision.status === "executed") {
    const result: ConfigureCompleteSmtpStepResult = {
      step: input.step,
      skill: input.skill,
      inputHash,
      proposalId: `plan:${decision.planStepTokenId}`,
      signatureId: decision.signatureId,
      planStepTokenId: decision.planStepTokenId,
      outcome: decision.outcome,
      durationMs: decision.durationMs,
      ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: input.estimatedCostUsd })
    };
    input.stepResults.push(result);
    await markRunStepDone({
      deps: input.deps,
      runState: input.runState,
      result
    });
    await emitStep(input.deps, "oc.orchestrator.step_completed", input.runId, input.step, input.skill, {
      planStepTokenId: decision.planStepTokenId,
      durationMs: decision.durationMs
    });
    await audit(input.deps, "oc.plan.step_executed", "openclaw_orchestrator_step", `${input.runId}:${input.step}:${input.skill}`, "critical", {
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      inputHash,
      planApprovalScopeHash: input.planApproval.scopeHash,
      planStepTokenId: decision.planStepTokenId,
      signatureId: decision.signatureId,
      estimatedCostUsd: input.estimatedCostUsd ?? 0
    });
    return result;
  }

  if (decision.status === "scope_rejected" || decision.status === "replay_detected" || decision.status === "kill_switch_armed") {
    throw new OrchestratorFailure(
      decision.status === "kill_switch_armed" ? "cancelled_by_operator" : "failed",
      input.step,
      input.skill,
      decision.reason ?? decision.status,
      decision.planStepTokenId ? `plan:${decision.planStepTokenId}` : undefined,
      inputHash
    );
  }

  const failureMessage = decision.error ?? "execution_failed";
  input.stepResults.push({
    step: input.step,
    skill: input.skill,
    inputHash,
    proposalId: `plan:${decision.planStepTokenId}`,
    signatureId: decision.signatureId,
    planStepTokenId: decision.planStepTokenId,
    outcome: decision.outcome ?? { error: failureMessage },
    durationMs: decision.durationMs,
    ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: input.estimatedCostUsd })
  });
  throw new OrchestratorFailure(
    "failed",
    input.step,
    input.skill,
    failureMessage,
    `plan:${decision.planStepTokenId}`,
    inputHash
  );
}

async function verifyAuditChain(deps: ConfigureCompleteSmtpDeps): Promise<void> {
  const chain = await deps.verifyAuditChain?.();
  if (chain && !chain.ok) {
    throw new OrchestratorFailure("failed", 0, "audit_chain", "audit_chain_broken");
  }
}

async function ensureKillSwitchClear(
  deps: ConfigureCompleteSmtpDeps,
  step: number,
  skill: string
): Promise<void> {
  const killSwitch = await deps.readKillSwitch?.();
  if (killSwitch?.enabled) {
    throw new OrchestratorFailure("cancelled_by_operator", step, skill, "kill_switch_armed");
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

function chooseDomainForRun(
  outcome: unknown,
  planApproval: PlanApprovalRecord | null,
  input: ConfigureCompleteSmtpParams,
  verifiedOwnedDomain: string | null
): string {
  if (!planApproval) {
    if (input.domain) {
      const requestedDomain = normalizeDomain(input.domain);
      if (
        domainInSuggestions(outcome, requestedDomain) ||
        verifiedOwnedDomain === requestedDomain ||
        input.requireExistingDomain !== true
      ) {
        return requestedDomain;
      }
      throw new OrchestratorFailure(
        "failed",
        1,
        "suggest_safe_domain",
        `domain_not_in_suggestions_or_owned: domain=${requestedDomain}`
      );
    }
    return chooseDomain(outcome);
  }

  const approvedDomain = planApproval.scope.domain;
  if (input.domain && normalizeDomain(input.domain) !== approvedDomain) {
    throw new OrchestratorFailure(
      "failed",
      1,
      "suggest_safe_domain",
      `plan_scope_mismatch: input.domain=${normalizeDomain(input.domain)} approved_domain=${approvedDomain}`
    );
  }
  const candidates = isRecord(outcome) && Array.isArray(outcome.candidates) ? outcome.candidates : [];
  const hasApprovedCandidate = domainInSuggestions(outcome, approvedDomain);
  if (
    planApproval.scope.requireExistingDomain === true &&
    candidates.length > 0 &&
    !hasApprovedCandidate &&
    verifiedOwnedDomain !== approvedDomain
  ) {
    throw new OrchestratorFailure(
      "failed",
      1,
      "suggest_safe_domain",
      `plan_domain_not_in_suggestions: approved_domain=${approvedDomain}`
    );
  }
  return approvedDomain;
}

// El smoke (step 14) lo valida send_real_email: subject 3-200, body 20-8000 y SIN
// palabras spam (SPAM_FLAG_WORDS incluye "test"/"prueba"/"smoke"...). El campo se llama
// "testEmailSubject", asi que OpenClaw tiende a meter "test"/"prueba" -> 400 en el ULTIMO
// step, tras gastar dominio+VPS+DNS+DKIM. Coercionamos a un contenido seguro y neutro
// (mejor para placement tambien) cuando el provisto romperia; si es valido, se respeta.
const SMOKE_SUBJECT_MIN = 3;
const SMOKE_SUBJECT_MAX = 200;
const SMOKE_BODY_MIN = 20;
const SMOKE_BODY_MAX = 8_000;

function smokeContentHasSpamFlag(value: string): boolean {
  const lower = value.toLowerCase();
  return SPAM_FLAG_WORDS.some((word) => lower.includes(word));
}

export function coerceSafeSmokeSubject(raw: string | undefined, domain: string): string {
  const trimmed = (raw ?? "").trim();
  if (
    trimmed.length >= SMOKE_SUBJECT_MIN &&
    trimmed.length <= SMOKE_SUBJECT_MAX &&
    !smokeContentHasSpamFlag(trimmed)
  ) {
    return trimmed;
  }
  return `Delivrix mail infrastructure check for ${domain}`.slice(0, SMOKE_SUBJECT_MAX);
}

export function coerceSafeSmokeBody(raw: string | undefined, domain: string): string {
  const trimmed = (raw ?? "").trim();
  if (
    trimmed.length >= SMOKE_BODY_MIN &&
    trimmed.length <= SMOKE_BODY_MAX &&
    !smokeContentHasSpamFlag(trimmed)
  ) {
    return trimmed;
  }
  return [
    `This message confirms the outbound mail infrastructure for ${domain} is operational.`,
    "SPF, DKIM and DMARC are configured; authentication should report SPF pass, DKIM pass and DMARC pass.",
    "If this arrives in the inbox with full authentication, the stack is ready for gradual warmup."
  ].join("\n");
}

function explicitDomainForRun(
  input: ConfigureCompleteSmtpParams,
  planApproval: PlanApprovalRecord | null
): string | null {
  if (input.domain) return normalizeDomain(input.domain);
  return planApproval?.scope.domain ?? null;
}

function requiresExistingDomainForRun(
  input: ConfigureCompleteSmtpParams,
  planApproval: PlanApprovalRecord | null
): boolean {
  return input.requireExistingDomain === true || planApproval?.scope.requireExistingDomain === true;
}

function domainInSuggestions(outcome: unknown, domain: string): boolean {
  const candidates = isRecord(outcome) && Array.isArray(outcome.candidates) ? outcome.candidates : [];
  return candidates.some((candidate) =>
    isRecord(candidate) &&
    typeof candidate.domain === "string" &&
    normalizeDomain(candidate.domain) === domain
  );
}

async function resolveExistingDomainOwnership(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  domain: string;
  requireExistingDomain: boolean;
}): Promise<{ owned: boolean; provider?: OwnedDomainVerification["provider"] }> {
  await verifyAuditChain(input.deps);
  if (!input.deps.verifyOwnedDomain) {
    throw new OrchestratorFailure(
      "failed",
      1,
      "route53_domain_ownership",
      `domain_ownership_verifier_missing: domain=${input.domain}`
    );
  }
  let verification: OwnedDomainVerification;
  try {
    // Ownership verification is fail-closed: unreadable inventories cannot satisfy strict adoption.
    verification = await input.deps.verifyOwnedDomain(input.domain);
  } catch (error) {
    void (input.deps.logger ?? noopGatewayRuntimeLogger).warn(
      "openclaw.orchestrator.domain_ownership_read_failed",
      "Domain ownership verification failed closed.",
      {
        runId: input.runId,
        domain: input.domain,
        error: errorMessage(error)
      }
    );
    throw new OrchestratorFailure(
      "failed",
      1,
      "route53_domain_ownership",
      `domain_ownership_not_verified: domain=${input.domain}`
    );
  }

  if (verification.owned !== true) {
    if (!input.requireExistingDomain) {
      await audit(input.deps, "oc.domain.ownership_not_owned_fresh_purchase", "domain", input.domain, "high", {
        runId: input.runId,
        provider: verification.provider,
        source: "listOwnedDomains",
        sourceKind: verification.sourceKind,
        responseOk: verification.responseOk,
        decision: "proceed_to_register_domain_route53"
      });
      return { owned: false, provider: verification.provider };
    }
    throw new OrchestratorFailure(
      "failed",
      1,
      "route53_domain_ownership",
      `domain_ownership_not_verified: domain=${input.domain}`
    );
  }

  await audit(input.deps, "oc.domain.ownership_verified", "domain", input.domain, "high", {
    runId: input.runId,
    provider: verification.provider,
    source: "listOwnedDomains",
    sourceKind: verification.sourceKind,
    responseOk: verification.responseOk
  });
  return { owned: true, provider: verification.provider };
}

async function resolveAndValidatePlanApproval(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  input: ConfigureCompleteSmtpParams;
}): Promise<PlanApprovalRecord> {
  if (!input.deps.resolvePlanApproval) {
    throw new OrchestratorFailure("failed", 0, "plan_approval", "plan_approval_resolver_missing");
  }
  const planApproval = await input.deps.resolvePlanApproval({
    runId: input.runId,
    params: input.input
  });
  if (!planApproval) {
    throw new OrchestratorFailure("failed", 0, "plan_approval", "plan_approval_missing");
  }
  if (planApproval.status !== "signed") {
    throw new OrchestratorFailure("failed", 0, "plan_approval", "plan_approval_not_signed");
  }
  if (planApproval.scope.runId !== input.runId) {
    throw new OrchestratorFailure(
      "failed",
      0,
      "plan_approval",
      `plan_scope_mismatch: runId=${input.runId} approved_runId=${planApproval.scope.runId}`
    );
  }
  if (Date.parse(planApproval.expiresAt) <= (input.deps.now?.() ?? new Date()).getTime()) {
    throw new OrchestratorFailure("failed", 0, "plan_approval", "plan_approval_expired");
  }
  const expectedDomain = input.input.domain ? normalizeDomain(input.input.domain) : planApproval.scope.domain;
  const expectedProvider = input.input.provider?.trim().toLowerCase() ?? planApproval.scope.provider;
  const expectedRecipient = input.input.testEmailRecipient.trim().toLowerCase();
  const details: string[] = [];
  if (planApproval.scope.domain !== expectedDomain) details.push("domain");
  if (planApproval.scope.provider !== expectedProvider) details.push("provider");
  if (planApproval.scope.budgetUsdMax !== input.input.budgetUsdMax) details.push("budgetUsdMax");
  if (planApproval.scope.recipient !== expectedRecipient) details.push("recipient");
  if (planApproval.scope.plannedSkill !== "configure_complete_smtp") details.push("plannedSkill");
  if (details.length > 0) {
    throw new OrchestratorFailure(
      "failed",
      0,
      "plan_approval",
      `plan_scope_mismatch: ${details.join(",")}`
    );
  }
  const expectedRequireExistingDomain = input.input.requireExistingDomain === true;
  const approvedRequireExistingDomain = planApproval.scope.requireExistingDomain === true;
  if (approvedRequireExistingDomain !== expectedRequireExistingDomain) {
    throw new OrchestratorFailure(
      "failed",
      0,
      "plan_approval",
      "plan_scope_mismatch: requireExistingDomain"
    );
  }
  return planApproval;
}

function validatePlanApprovedStepScope(
  input: {
    planApproval: PlanApprovalRecord;
    runId: string;
    step: number;
    skill: string;
    params: Record<string, unknown>;
    dnsProviderId?: string;
  },
  inputHash: string
): void {
  const scope = input.planApproval.scope;
  if (scope.runId !== input.runId) {
    throw new OrchestratorFailure("failed", input.step, input.skill, "plan_scope_mismatch:runId", undefined, inputHash);
  }
  if (!plannedScopeAllowsStepSkill(scope.plannedSteps, input.step, input.skill, input.dnsProviderId)) {
    throw new OrchestratorFailure("failed", input.step, input.skill, "plan_scope_mismatch:skill", undefined, inputHash);
  }
  for (const value of domainValuesInParams(input.params)) {
    if (!isSubdomainOrSame(value, scope.domain)) {
      throw new OrchestratorFailure(
        "failed",
        input.step,
        input.skill,
        `plan_scope_mismatch:domain=${value} approved_domain=${scope.domain}`,
        undefined,
        inputHash
      );
    }
  }
  for (const value of recipientValuesInParams(input.params)) {
    if (value !== scope.recipient) {
      throw new OrchestratorFailure(
        "failed",
        input.step,
        input.skill,
        `plan_scope_mismatch:recipient=${value} approved_recipient=${scope.recipient}`,
        undefined,
        inputHash
      );
    }
  }
}

function plannedScopeAllowsStepSkill(
  plannedSteps: string[],
  step: number,
  skill: string,
  dnsProviderId: string | undefined
): boolean {
  if (plannedSteps.includes(skill)) return true;
  if (dnsProviderId !== "ionos" || skill !== "upsert_dns_ionos") return false;
  if (step === 6) return plannedSteps.includes("upsert_dns_route53");
  if (step === 10) return plannedSteps.includes("configure_email_auth");
  return false;
}

function domainValuesInParams(params: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of ["domain", "hostname", "fromAddress"]) {
    const value = params[key];
    if (typeof value !== "string") continue;
    if (key === "fromAddress") {
      const [, domain] = value.split("@");
      if (domain) values.push(normalizeDomain(domain));
      continue;
    }
    const normalized = normalizeOperationalDomain(value);
    if (normalized) values.push(normalized);
  }
  if (Array.isArray(params.records)) {
    for (const record of params.records) {
      if (!isRecord(record) || typeof record.name !== "string") continue;
      const normalized = record.name === "@" ? null : normalizeOperationalDomain(record.name);
      if (normalized) values.push(normalized);
    }
  }
  return [...new Set(values)];
}

function recipientValuesInParams(params: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of ["toAddress", "recipient", "testEmailRecipient"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim().toLowerCase());
  }
  return [...new Set(values)];
}

function isSubdomainOrSame(value: string, root: string): boolean {
  return value === root || value.endsWith(`.${root}`);
}

function normalizeMaybeDomain(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(normalized)
    ? normalized
    : null;
}

function normalizeOperationalDomain(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  const dkimSuffix = "._domainkey.";
  const dkimIndex = normalized.indexOf(dkimSuffix);
  if (dkimIndex >= 0) {
    return normalizeMaybeDomain(normalized.slice(dkimIndex + dkimSuffix.length));
  }
  if (normalized.startsWith("_dmarc.")) {
    return normalizeMaybeDomain(normalized.slice("_dmarc.".length));
  }
  return normalizeMaybeDomain(normalized);
}

function normalizeDomain(value: string): string {
  const normalized = normalizeMaybeDomain(value);
  if (!normalized) {
    throw new OrchestratorFailure("failed", 0, "domain_scope", "invalid_domain_scope");
  }
  return normalized;
}

function isSyntheticRoute53OperationId(operationId: string): boolean {
  return (
    operationId === "idempotent_already_owned" ||
    operationId === "workspace_owned" ||
    operationId.startsWith("route53-reservation-")
  );
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
  // Solo registramos el fallo como "step" del compact si corresponde a un paso real del flujo (>=1).
  // Los fallos pre-paso (outcome_parser, run_state/scope-drift, kill-switch) usan step 0 y NO son
  // pasos ejecutados; incluirlos rompia el compact con "step must be an integer between 1 and 10000".
  if (input.failure && !failureAlreadyRecorded && input.failure.step >= 1) {
    steps.push({
      step: input.failure.step,
      tool: input.failure.skill,
      inputHash: input.failure.inputHash ?? hashInput({ failure: input.failure.message, proposalId: input.failure.proposalId }),
      outcome: failureOutcome(input.failure),
      errorClass: input.failure.status,
      errorMessage: machineErrorCode(input.failure.message),
      durationMs: 0,
      ...(input.failure.proposalId ? { proposalId: input.failure.proposalId } : {})
    });
  }

  // Si no quedo ningun paso real que compactar (p.ej. el run fallo en validacion antes de ejecutar
  // nada), no hay trabajo que guardar y el schema exige >=1 step: salimos limpio en vez de romper.
  if (steps.length === 0) {
    void (deps.logger ?? noopGatewayRuntimeLogger).info(
      "openclaw.orchestrator.compact_intent_skipped",
      "No executed steps to compact; skipping episodic compaction.",
      { runId: input.runId, status: input.status }
    );
    return;
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
    const rejection = compactionRejectionMetadata(error, input.runId, input.status, steps);
    if (rejection) {
      void (deps.logger ?? noopGatewayRuntimeLogger).warn(
        "openclaw.orchestrator.compact_intent_failed",
        "Episodic memory compaction rejected by storage write gate.",
        rejection
      );
      await appendCompactionRejectedAudit(deps, input.runId, input.status, steps.length, rejection);
    } else {
      void (deps.logger ?? noopGatewayRuntimeLogger).warn("openclaw.orchestrator.compact_intent_failed", "Episodic memory compaction failed.", {
        runId: input.runId,
        status: input.status,
        error: errorMessage(error)
      });
    }
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
    outcomeData: compactOutcomeData(step.outcome),
    durationMs: step.durationMs,
    ...(isFailureStep ? {
      errorClass: failure.status,
      errorMessage: machineErrorCode(failure.message)
    } : {}),
    ...(isAfterFailure ? {
      errorClass: "not_executed_after_failure",
      errorMessage: "skipped_after_prior_failure"
    } : {}),
    ...(step.proposalId ? { proposalId: step.proposalId } : {}),
    ...(step.signatureId && !step.proposalId?.startsWith("plan:") ? { signatureId: step.signatureId } : {})
  };
}

function failureOutcome(failure: OrchestratorFailure): "failed" | "cancelled_by_operator" | "timeout" {
  if (failure.status === "cancelled_by_operator") return "cancelled_by_operator";
  if (failure.message.includes("timeout")) return "timeout";
  return "failed";
}

function compactOutcomeData(value: unknown): Record<string, unknown> {
  const conformed = conformOutcomeData(summarizeOutcome(value));
  return isRecord(conformed) ? conformed : {};
}

function summarizeOutcome(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return typeof value === "string"
      ? { valueHash: hashInput(value), valuePresent: value.length > 0 }
      : { value };
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (/token|secret|password|private|api[_-]?key|credential|authorization/i.test(key)) {
      continue;
    }
    if (/^dkimPublicKey$/i.test(key) && typeof item === "string") {
      output.dkimPublicKeyHash = hashInput(item);
      output.dkimPublicKeyPresent = item.length > 0;
      continue;
    }
    if (/^messageId$/i.test(key) && typeof item === "string") {
      const messageId = safeEmailMessageId(item);
      if (messageId) output[key] = messageId;
      continue;
    }
    if (typeof item === "string" && item.length > 200) {
      output[`${key}Hash`] = hashInput(item);
      output[`${key}Present`] = item.length > 0;
      continue;
    }
    output[key] = item;
  }
  return output;
}

interface CompactionRejectionMetadata {
  rejectReason: "memory_compaction_rejected";
  errorCode: string;
  rejectionStage: string;
  rejectionKind: string;
  component: "orchestrator_smtp";
  intentId: string;
  finalStatus: ConfigureSmtpStatus;
  stepsCount: number;
  compactAttemptId: string;
  stepsShapeHash: string;
  fieldPath?: string;
  fieldKey?: string;
  fieldKeyHash?: string;
  normalizedFieldKey?: string;
  step?: number;
  tool?: string;
  inputHash?: string;
  outcome?: string;
  valueType?: string;
  valueLength?: number;
  arrayLength?: number;
  objectKeyCount?: number;
  redaction: {
    rawValueLogged: false;
    rawErrorMessageLogged: false;
    requestBodyLogged: false;
  };
}

function compactionRejectionMetadata(
  error: unknown,
  runId: string,
  status: ConfigureSmtpStatus,
  steps: CompactIntentStepInput[]
): CompactionRejectionMetadata | undefined {
  if (!isRecord(error) || typeof error.code !== "string" || !error.code.startsWith("memory_payload_")) {
    return undefined;
  }
  const details = isRecord(error.details) ? error.details : {};
  const stepsShapeHash = hashInput(steps.map(stepShape));
  return {
    errorCode: error.code,
    rejectionStage: stringRecordValue(details.rejectionStage, "storage_write_gate"),
    rejectionKind: stringRecordValue(details.rejectionKind, "structured_value_invalid"),
    component: "orchestrator_smtp",
    intentId: runId,
    finalStatus: status,
    stepsCount: steps.length,
    compactAttemptId: hashInput({ runId, stepsShapeHash }).slice(0, 32),
    stepsShapeHash,
    ...(copyStringDetail(details, "fieldPath")),
    ...(copyStringDetail(details, "fieldKey")),
    ...(copyStringDetail(details, "fieldKeyHash")),
    ...(copyStringDetail(details, "normalizedFieldKey")),
    ...(copyNumberDetail(details, "step")),
    ...(copyStringDetail(details, "tool")),
    ...(copyStringDetail(details, "inputHash")),
    ...(copyStringDetail(details, "outcome")),
    ...(copyStringDetail(details, "valueType")),
    ...(copyNumberDetail(details, "valueLength")),
    ...(copyNumberDetail(details, "arrayLength")),
    ...(copyNumberDetail(details, "objectKeyCount")),
    rejectReason: "memory_compaction_rejected",
    redaction: {
      rawValueLogged: false,
      rawErrorMessageLogged: false,
      requestBodyLogged: false
    }
  };
}

async function appendCompactionRejectedAudit(
  deps: ConfigureCompleteSmtpDeps,
  runId: string,
  status: ConfigureSmtpStatus,
  stepsCount: number,
  rejection: CompactionRejectionMetadata
): Promise<void> {
  try {
    await deps.auditLog.append({
      actorType: "openclaw",
      actorId: "configure_complete_smtp",
      action: "oc.episodic.compaction_rejected",
      targetType: "openclaw_intent",
      targetId: runId,
      riskLevel: rejection.rejectionKind === "instruction_like_text" ? "high" : "medium",
      decision: "reject",
      rejectReason: "memory_compaction_rejected",
      evidenceRefs: [
        `openclaw_intent:${runId}`,
        `compact_intent:${rejection.compactAttemptId}`
      ],
      metadata: {
        ...rejection,
        stepsCount
      }
    });
  } catch (error) {
    void (deps.logger ?? noopGatewayRuntimeLogger).warn(
      "openclaw.orchestrator.compaction_rejected_audit_failed",
      "Episodic memory rejection audit event could not be appended.",
      {
        runId,
        rejectionKind: rejection.rejectionKind,
        ...(rejection.fieldPath ? { fieldPath: rejection.fieldPath } : {}),
        error: errorMessage(error)
      }
    );
  }
}

function stepShape(step: CompactIntentStepInput): Record<string, unknown> {
  return {
    step: step.step,
    tool: step.tool,
    inputHash: step.inputHash,
    outcome: step.outcome,
    outcomeDataShape: step.outcomeData
      ? Object.fromEntries(Object.entries(step.outcomeData).map(([key, value]) => [key, valueShape(value)]).sort(([left], [right]) => left.localeCompare(right)))
      : {}
  };
}

function valueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array:${value.length}`;
  if (typeof value === "object") return `object:${Object.keys(value as Record<string, unknown>).length}`;
  return typeof value;
}

function copyStringDetail(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function copyNumberDetail(record: Record<string, unknown>, key: string): Record<string, number> {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
}

function stringRecordValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function totalEstimatedCost(results: ConfigureCompleteSmtpStepResult[]): number {
  return results.reduce((total, step) => total + (extractCost(step.outcome) ?? step.estimatedCostUsd ?? 0), 0);
}

function ensureBudgetForStep(
  input: {
    deps: ConfigureCompleteSmtpDeps;
    runState?: SmtpRunState;
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

  const committedCostUsd = input.runState?.budgetSpentUsd ?? totalEstimatedCost(input.stepResults);
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

interface CreationAccountEvaluation {
  accountId: string;
  inventory: WebdockCreationInventoryResult;
  decision: ReturnType<typeof evaluateCreationBudget>;
  inventoryHash: string;
}

/**
 * Selecciona la cuenta Webdock donde crear el VPS (step 4) entre N cuentas write-capable (5.12).
 * Devuelve el accountId ganador (el orquestador lo propaga a runState + create + rollback).
 *
 * Invariante single-account byte-identico: con SOLO la cuenta-1 ("ops") write-capable, esto
 * consulta unicamente "ops", emite los mismos audit/canvas/log events, usa el mismo inventoryHash
 * y devuelve "ops" — identico al `ensureCreationBudgetForAccount({accountId:"ops"})` previo.
 *
 * - Governor OFF: devuelve "ops" sin tocar el reader (igual que antes).
 * - Cuentas no-live (read falla / mock / not-live): NO entran a governorState (no afirmar budget
 *   falso); si TODAS fallan la lectura => handleCreationRateReadError (fail-open/closed por env),
 *   preservando el camino de hoy. Si alguna SI esta live, las no-live solo se excluyen.
 * - enabled = canCreate() del adapter (salvaguarda Fase 0: nunca elegir una cuenta sin write real).
 * - evaluateAccountSelection (no-throw) distingue en audit `creation_rate_exceeded_all_accounts`
 *   vs `no_eligible_accounts`. El override humano sigue aplicando a la cuenta exhausta.
 */
async function resolveCreationAccount(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  step: 4;
  skill: "create_webdock_server";
  /** Cuentas a EXCLUIR (ya rechazaron el pago en este run): el failover prueba las demas. */
  excludeAccounts?: ReadonlySet<string>;
}): Promise<string> {
  const enabled = !envFlagDisabled(input.deps.env?.CREATION_RATE_GOVERNOR_ENABLE);
  if (!enabled) {
    return DEFAULT_CREATION_ACCOUNT_ID;
  }

  const cap = nonNegativeInt(input.deps.env?.CREATION_MAX_PER_DAY) ?? 4;
  const window = creationRateWindow(input.deps.env?.CREATION_RATE_WINDOW);
  const failClosed = creationRateFailClosed(input.deps.env?.CREATION_RATE_GOVERNOR_FAIL_MODE);
  const now = input.deps.now?.() ?? new Date();

  // Cuentas write-capable a evaluar. Sin la dep multicuenta (o vacia) => single-account "ops"
  // de hoy (1 iteracion, byte-identico). De-dup ya viene resuelto por el productor (1 por cuenta).
  const allWriteCapable = await resolveWriteCapableCreationAccounts(input.deps);
  const accounts = input.excludeAccounts && input.excludeAccounts.size > 0
    ? allWriteCapable.filter((account) => !input.excludeAccounts!.has(account.accountId))
    : allWriteCapable;
  // Todas las write-capable ya excluidas por el failover: sin candidato -> "" (el step 4 corta el loop).
  if (accounts.length === 0) {
    return "";
  }

  const reader = input.deps.listWebdockCreationServers;
  const evaluations: CreationAccountEvaluation[] = [];
  const selectionAccounts: CreationAccountForSelection[] = [];
  const governorState: CreationAccountGovernorState[] = [];
  const readFailures: Array<{ accountId: string; enabled: boolean; error: unknown; inventoryHash: string }> = [];

  for (const account of accounts) {
    const inventoryHash = hashInput({
      accountId: account.accountId,
      cap,
      window,
      gate: "creation_rate_governor"
    });

    if (!reader) {
      readFailures.push({ accountId: account.accountId, enabled: account.enabled, error: "creation_inventory_reader_missing", inventoryHash });
      selectionAccounts.push({ accountId: account.accountId, healthy: false, enabled: account.enabled });
      continue;
    }

    let inventory: WebdockCreationInventoryResult;
    try {
      inventory = await reader({ accountId: account.accountId });
    } catch (error) {
      readFailures.push({ accountId: account.accountId, enabled: account.enabled, error, inventoryHash });
      selectionAccounts.push({ accountId: account.accountId, healthy: false, enabled: account.enabled });
      continue;
    }

    if (inventory.sourceKind !== "live" || inventory.responseOk !== true) {
      readFailures.push({
        accountId: account.accountId,
        enabled: account.enabled,
        error: `creation_inventory_not_live: sourceKind=${inventory.sourceKind ?? "unknown"} responseOk=${String(inventory.responseOk)}`,
        inventoryHash
      });
      selectionAccounts.push({ accountId: account.accountId, healthy: false, enabled: account.enabled });
      continue;
    }

    const decision = evaluateCreationBudget({
      servers: inventory.servers,
      now,
      cap,
      accountId: inventory.accountId ?? account.accountId,
      window,
      enabled
    });
    evaluations.push({ accountId: decision.accountId, inventory, decision, inventoryHash });
    selectionAccounts.push({ accountId: decision.accountId, healthy: true, enabled: account.enabled });
    governorState.push({
      accountId: decision.accountId,
      allowed: decision.allowed,
      createdInWindow: decision.createdInWindow,
      cap: decision.cap
    });
  }

  // Ninguna cuenta live => preservar el camino de read-error de hoy (fail-open/closed). Con solo
  // "ops" configurada, este es exactamente el handleCreationRateReadError previo (mismo inventoryHash).
  if (evaluations.length === 0) {
    const failure = readFailures[0] ?? {
      accountId: DEFAULT_CREATION_ACCOUNT_ID,
      enabled: true,
      error: "creation_inventory_reader_missing",
      inventoryHash: hashInput({ accountId: DEFAULT_CREATION_ACCOUNT_ID, cap, window, gate: "creation_rate_governor" })
    };
    await handleCreationRateReadError({
      deps: input.deps,
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      accountId: failure.accountId,
      cap,
      window,
      enabled,
      failClosed,
      error: failure.error,
      inputHash: failure.inventoryHash
    });
    // fail-open no lanzo: no hay budget afirmable, seguimos contra la cuenta-1 como hoy.
    return failure.accountId;
  }

  const selection = evaluateAccountSelection({ accounts: selectionAccounts, governorState });

  if (selection.selectedAccountId) {
    const winner = evaluations.find((entry) => entry.accountId === selection.selectedAccountId) ?? evaluations[0];
    void (input.deps.logger ?? noopGatewayRuntimeLogger).info("openclaw.orchestrator.creation_rate_allowed", "Creation-rate governor allowed Webdock create step.", {
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      accountId: winner.decision.accountId,
      createdInWindow: winner.decision.createdInWindow,
      cap: winner.decision.cap,
      window: winner.decision.window
    });
    return winner.decision.accountId;
  }

  // No hay ganador: o todas las cuentas healthy estan en cap (exhausted) o ninguna es elegible.
  // El override humano aplica a la PRIMERA cuenta exhausta (con solo "ops" exhausta = "ops" exacto).
  const exhausted = evaluations.find((entry) => !entry.decision.allowed) ?? evaluations[0];
  const decision = exhausted.decision;
  const inventory = exhausted.inventory;
  const inventoryHash = exhausted.inventoryHash;

  const override = await input.deps.resolveCreationRateOverride?.({
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    accountId: decision.accountId,
    createdCount: decision.createdInWindow,
    cap: decision.cap
  });
  if (override?.approved) {
    await audit(input.deps, "oc.orchestrator.creation_rate_override", "webdock_account", decision.accountId, "critical", {
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      accountId: decision.accountId,
      createdInWindow: decision.createdInWindow,
      cap: decision.cap,
      window: decision.window,
      signatureId: override.signatureId,
      reason: override.reason,
      actorId: override.actorId
    });
    return decision.accountId;
  }

  // Distinguir el motivo REAL del no-ganador (5.12):
  //  - "no_eligible_accounts": ninguna cuenta es write-capable/healthy (NO fue exceso de rate).
  //    Etiquetar esto como "creation_rate_exceeded" con "created_24h=X cap=Y" es enganoso, asi que
  //    emitimos un codigo/accion/mensaje propios (no_write_capable_account). Casi inalcanzable hoy
  //    (el create siempre pasa por aca con al menos "ops"), pero correcto.
  //  - resto (exhausted / creation_rate_exceeded_all_accounts): camino de rate previo, byte-identico.
  const noWriteCapable = selection.reason === "no_eligible_accounts";
  const action = noWriteCapable
    ? "oc.orchestrator.no_write_capable_account"
    : "oc.orchestrator.creation_rate_exceeded";
  const logEvent = noWriteCapable
    ? "openclaw.orchestrator.no_write_capable_account"
    : "openclaw.orchestrator.creation_rate_exceeded";
  const message = noWriteCapable
    ? `no_write_capable_account: account=${decision.accountId}`
    : decision.failure?.message ?? `creation_rate_exceeded: created_24h=${decision.createdInWindow} cap=${decision.cap} account=${decision.accountId}`;
  await audit(input.deps, action, "webdock_account", decision.accountId, "critical", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    accountId: decision.accountId,
    accountLabel: inventory.accountLabel,
    sourceKind: inventory.sourceKind,
    responseOk: inventory.responseOk,
    createdInWindow: decision.createdInWindow,
    cap: decision.cap,
    window: decision.window,
    reason: selection.reason === "creation_rate_exceeded_all_accounts" ? decision.reason : selection.reason
  });
  await safeEmit(input.deps, {
    type: "oc.action.now",
    taskId: input.runId,
    kind: "audit",
    action,
    targetType: "webdock_account",
    targetId: decision.accountId,
    riskLevel: "critical",
    metadata: {
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      accountId: decision.accountId,
      createdInWindow: decision.createdInWindow,
      cap: decision.cap,
      window: decision.window,
      reason: selection.reason === "creation_rate_exceeded_all_accounts" ? decision.reason : selection.reason
    },
    occurredAt: (input.deps.now?.() ?? new Date()).toISOString()
  } as CanvasLiveEvent);
  void (input.deps.logger ?? noopGatewayRuntimeLogger).warn(logEvent, noWriteCapable
    ? "No write-capable Webdock account available for create step."
    : "Creation-rate governor blocked Webdock create step.", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    accountId: decision.accountId,
    createdInWindow: decision.createdInWindow,
    cap: decision.cap,
    window: decision.window
  });
  throw new OrchestratorFailure("failed", input.step, input.skill, message, undefined, inventoryHash);
}

/**
 * Cuentas write-capable a evaluar en el selector. Sin la dep multicuenta (o si devuelve vacio),
 * cae al unico candidato "ops" de hoy -> el loop corre 1 iteracion y todo queda byte-identico.
 */
async function resolveWriteCapableCreationAccounts(
  deps: ConfigureCompleteSmtpDeps
): Promise<WebdockCreationAccount[]> {
  if (!deps.listCreationAccounts) {
    return [{ accountId: DEFAULT_CREATION_ACCOUNT_ID, enabled: true }];
  }
  const accounts = await deps.listCreationAccounts();
  const normalized = accounts
    .map((account) => ({ accountId: account.accountId.trim(), enabled: account.enabled }))
    .filter((account) => account.accountId.length > 0);
  return normalized.length > 0 ? normalized : [{ accountId: DEFAULT_CREATION_ACCOUNT_ID, enabled: true }];
}

async function handleCreationRateReadError(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  step: 4;
  skill: "create_webdock_server";
  accountId: string;
  cap: number;
  window: CreationRateWindow;
  enabled: boolean;
  failClosed: boolean;
  error: unknown;
  inputHash: string;
}): Promise<void> {
  const decision = evaluateCreationBudgetReadError({
    now: input.deps.now?.() ?? new Date(),
    accountId: input.accountId,
    cap: input.cap,
    enabled: input.enabled,
    window: input.window,
    failMode: input.failClosed ? "fail_closed" : "fail_open",
    error: input.error
  });
  await audit(input.deps, "oc.orchestrator.creation_rate_read_failed", "webdock_account", input.accountId, input.failClosed ? "critical" : "high", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    accountId: input.accountId,
    cap: decision.cap,
    window: decision.window,
    failMode: input.failClosed ? "closed" : "open",
    reason: decision.reason,
    readErrorMessage: decision.readErrorMessage
  });
  void (input.deps.logger ?? noopGatewayRuntimeLogger).warn("openclaw.orchestrator.creation_rate_read_failed", "Creation-rate governor inventory read failed.", {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    accountId: input.accountId,
    failMode: input.failClosed ? "closed" : "open",
    error: decision.readErrorMessage
  });
  if (!decision.allowed) {
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      decision.failure?.message ?? "creation_rate_read_failed",
      undefined,
      input.inputHash
    );
  }
}

function extractCost(outcome: unknown): number | undefined {
  if (!isRecord(outcome)) return undefined;
  for (const key of ["costUsd", "priceUsd", "estimatedCostUsd"]) {
    const value = outcome[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
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

function nonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveIntFromUnknown(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function envFlagEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

function envFlagDisabled(value: string | undefined): boolean {
  return value === "false" || value === "0" || value === "no" || value === "off";
}

function creationRateWindow(value: string | undefined): CreationRateWindow {
  return value === "calendar_day_bogota" ? "calendar_day_bogota" : "rolling_24h";
}

function creationRateFailClosed(value: string | undefined): boolean {
  return value === "closed" || value === "fail_closed" || value === "true" || value === "1";
}

/**
 * Resuelve el proveedor de VPS del run (canal HERMANO de serverAccountId). Fuente:
 * (1) runState.providerId si ya se persistio (RESUME: el server podria vivir alli);
 * (2) el skill param vpsProviderId en un run fresco. Normaliza a minusculas. Devuelve
 * undefined cuando esta ausente o es "webdock", de modo que el spread condicional aguas
 * arriba NO agregue la clave providerId y el camino Webdock quede BYTE-IDENTICO (no toca
 * params/hashInput/plan-signature). NUNCA reusa el `provider` (registrar DNS route53).
 */
function resolveVpsProviderId(
  input: ConfigureCompleteSmtpParams,
  state: SmtpRunState
): string | undefined {
  const raw = state.providerId ?? (typeof input.vpsProviderId === "string" ? input.vpsProviderId : undefined);
  return normalizeVpsProviderId(raw);
}

function normalizeVpsProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "webdock") return undefined;
  return normalized;
}

function assertKnownNonWebdockVpsProviderId(value: string | undefined): void {
  if (value === undefined || value === "contabo") return;
  throw new OrchestratorFailure("failed", 0, "vps_provider_guard", `unknown_vps_provider:${value}`);
}

/** True si hay un proveedor de VPS explicito distinto de Webdock (dispara el guard gated). */
function isNonWebdockProviderId(value: string | undefined): boolean {
  return normalizeVpsProviderId(value) !== undefined;
}

/**
 * Resuelve el proveedor DNS del run (canal HERMANO de params). Fuente state-first para que RESUME
 * retome el proveedor persistido. undefined/"route53" no se propaga aguas arriba y conserva Route53
 * byte-identico.
 */
function resolveDnsProviderId(
  input: ConfigureCompleteSmtpParams,
  state: SmtpRunState
): string | undefined {
  const raw = state.dnsProviderId ?? (typeof input.dnsProviderId === "string" ? input.dnsProviderId : undefined);
  return normalizeDnsProviderId(raw);
}

function normalizeDnsProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "route53") return undefined;
  return normalized;
}

function assertKnownDnsProviderId(value: string | undefined): void {
  if (value === undefined || value === "ionos") return;
  throw new OrchestratorFailure("failed", 0, "dns_provider_guard", `unknown_dns_provider:${value}`);
}

function hashInput(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
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

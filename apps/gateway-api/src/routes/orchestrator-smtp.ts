import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
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
import {
  defaultSmokeAuthDnsResolver,
  verifySmokeAuthGate,
  type SmokeAuthDnsResolver
} from "./smoke-auth-gate.ts";
import {
  upsertConfiguredSmtpInventoryEntry,
  type SmtpProvisioningInventory
} from "../smtp-inventory-management.ts";

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
  identity?: CanvasLiveRunIdentity;
  steps?: CanvasLiveRunProgress["steps"];
  finalEmailMessageId?: string;
  finalDeliveryStatus?: "queued" | "delivered" | "deferred" | "bounced";
  rollbackProposalId?: string;
  error?: string;
  /**
   * Guia operativa legible para el agente/operador ante errores accionables (p.ej. un run en curso o
   * un lock huerfano). ADITIVO: solo se agrega para errores conocidos; nunca reemplaza `error`.
   */
  guidance?: string;
  failedStep?: number;
  retryable?: boolean;
  failureKind?: "smoke_auth_not_ready";
  retryAfterMs?: number;
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
  provider: "route53" | "ionos" | "namecheap";
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
  /** Snapshot pulido por health/lifecycle poller. Ausente => legacy healthy. */
  healthStatus?: string;
  lifecycleStatus?: string;
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
   * Cuenta Webdock destino de operaciones account-aware. Canal PARALELO fuera de `params`/
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
  /**
   * True si hay un adapter cargado para el providerId de VPS no-Webdock (Contabo, etc.). Permite el
   * FAIL-FAST en el step 0 (antes de gastar en el step 2): si el operador/agente referencia un
   * contabo-N sin credenciales cargadas, el run muere ANTES de comprar el dominio en vez de morir en
   * el step 4 (create server) con el dominio ya comprado. Opcional: sin la dep no se valida (el
   * dispatcher sigue siendo la ultima linea) y el comportamiento es byte-identico al de hoy.
   */
  hasVpsProviderAdapter?: (providerId: string) => boolean;
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
  /**
   * Preflight LIVE de credenciales de la cuenta elegida para el create (2 GETs baratos contra
   * la API del proveedor). Detecta tokens presentes-pero-revocados ANTES de gastar, cubriendo
   * los caminos que el governor no valida (reuseAccountId de un resume, governor apagado, y
   * write/account token muerto con read vivo). Opcional: sin la dep, comportamiento identico.
   */
  preflightCreationAccount?: (input: { accountId: string }) =>
    | Promise<{ ok: boolean; reason?: string }>
    | { ok: boolean; reason?: string };
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
  smokeAuthDnsResolver?: SmokeAuthDnsResolver;
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
const smokeAuthRetryAfterMs = 5 * 60_000;
/**
 * Safety del loop de failover de pago (step 4) contra loop infinito. El terminador REAL es el break
 * por "" de resolveCreationAccount (todas las write-capable excluidas), que ocurre en <=N+1 iteraciones
 * con N cuentas; este tope alto solo cubre un bug teorico + holgura para agregar muchas cuentas.
 */
const smtpCreateAccountFailoverMaxAttempts = 25;
const requestedCreationAccountPreflightRetryDelayMs = 25;
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
  /** Slug de VPS existente que este run adopta; preserva resume/idempotencia sin crear VPS. */
  reuseServerSlug?: string;
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
  dnsProviderId?: "ionos" | "namecheap";
  selector: string;
  verifiedOwnedDomain?: string;
  verifiedOwnedDomainProvider?: OwnedDomainVerification["provider"];
  budgetSpentUsd: number;
  lastCompletedStep: number;
  finalEmailMessageId?: string;
  finalDeliveryStatus?: "queued" | "delivered" | "deferred" | "bounced";
  retryableFailure?: boolean;
  failureCategory?: "smoke_auth_not_ready" | "send_retry_exhausted";
  failureRetryAfterMs?: number;
  sendAttempts?: number;
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
    accountId?: string;
    serverAccountId?: string;
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
    serverAccountId: input.serverAccountId,
    reuseServerSlug: input.reuseServerSlug,
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
    serverAccountId: input.serverAccountId,
    reuseServerSlug: input.reuseServerSlug,
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
    // Fail-fast semantico (P1): si el provider no-Webdock no tiene adapter cargado, abortar en el
    // step 0 ANTES del gasto del step 2, en vez de morir en el step 4 con el dominio ya comprado.
    assertVpsProviderAdapterLoaded(resolveVpsProviderId(effectiveInput, runState), deps);
    const dnsProviderId = resolveDnsProviderId(effectiveInput, runState);
    assertKnownDnsProviderId(dnsProviderId);
    if (dnsProviderId === "ionos" || dnsProviderId === "namecheap") {
      runState.dnsProviderId = dnsProviderId;
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
      ? await resolveAndValidatePlanApproval({ deps, runId, input: effectiveInput, request: input, runState })
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

    const requestedServerAccountId = normalizeServerAccountId(effectiveInput.serverAccountId);
    const initialVpsProviderId = resolveVpsProviderId(effectiveInput, runState);
    assertKnownNonWebdockVpsProviderId(initialVpsProviderId);
    const initialReuseServerSlug = await resolveReuseServerSlugForProvider({
      deps,
      rawValue: effectiveInput.reuseServerSlug,
      vpsProviderId: initialVpsProviderId,
      runId,
      auditIgnore: true
    });
    if (initialReuseServerSlug) {
      // Guard temprano: el slug a reusar debe existir en webdock-servers.json ANTES de cualquier
      // paso con costo (la compra de dominio del step 2). Un slug inexistente no debe dejar un run
      // failed con un dominio ya comprado. El step 4 re-valida incluyendo el hostname.
      await readReusableWebdockServer(deps, initialReuseServerSlug, {
        mode: "pre-run",
        failure: { step: 0, skill: "reuse_server_guard" }
      });
    }
    if (requestedServerAccountId) {
      if (isNonWebdockProviderId(initialVpsProviderId)) {
        throw new OrchestratorFailure(
          "failed",
          0,
          "server_account_guard",
          `requested_account_unsupported_for_provider: provider=${initialVpsProviderId} account=${requestedServerAccountId}`
        );
      }
      if (!initialReuseServerSlug && !planApproval && requestedServerAccountId !== DEFAULT_CREATION_ACCOUNT_ID) {
        throw new OrchestratorFailure("failed", 0, "server_account_guard", "gated_multiaccount_unsupported");
      }
      if (!initialReuseServerSlug) {
        const requestedCreationAccounts = await assertRequestedCreationAccountSnapshotEligible({
          deps,
          runId,
          accountId: requestedServerAccountId
        });
        await assertRequestedCreationAccountBudgetPreflight({
          deps,
          runId,
          accountId: requestedServerAccountId,
          accounts: requestedCreationAccounts
        });
      }
      runState.serverAccountId = requestedServerAccountId;
      await persistSmtpRunState(deps, runState);
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
    if (explicitDomain && (requireExistingDomain || dnsProviderId === "ionos" || dnsProviderId === "namecheap" || !domainInSuggestions(suggestions, explicitDomain))) {
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
    const namecheapRegistrationParams = { domain: chosenDomain, years: 1, whoisPrivacy: true };
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
    // Namecheap: registrador + DNS autoritativo INDEPENDIENTE (espejo de IONOS, pero con COMPRA in-run).
    // Si el dominio ya es propio en Namecheap se SALTA el registro (idempotente); si no, se registra en
    // Namecheap (paso 2, dinero). En ambos casos Namecheap es autoritativo de su zona -> el wait de NS
    // awsdns se salta (no hay delegacion a Route53). El DNS del SMTP se escribe en Namecheap (paso 6/10).
    const namecheapDnsRun = dnsProviderId === "namecheap";
    const namecheapOwnedRun =
      namecheapDnsRun &&
      verifiedOwnedDomain === chosenDomain &&
      verifiedOwnedProvider === "namecheap";

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
    } else if (namecheapOwnedRun) {
      await recordSyntheticDoneStepWithState({
        deps,
        runState,
        runId,
        step: 2,
        skill: "register_domain_namecheap",
        params: namecheapRegistrationParams,
        outcome: {
          ok: true,
          status: "skipped",
          reason: "namecheap_owned_domain",
          provider: "namecheap",
          domain: chosenDomain
        },
        estimatedCostUsd: 0,
        stepResults
      });
      await audit(deps, "oc.domain.registration_skipped", "domain", chosenDomain, "high", {
        runId,
        provider: "namecheap",
        reason: "namecheap_owned_domain"
      });
    } else if (namecheapDnsRun) {
      // Compra REAL del dominio en Namecheap (sincrona: el adapter devuelve "registered"; NO hay poll de
      // propagacion de registro como Route53 porque Namecheap es autoritativo desde el registro).
      await runMutatingStepWithState({
        deps,
        runState,
        planApproval,
        runId,
        step: 2,
        skill: "register_domain_namecheap",
        actorId: effectiveInput.actorId,
        approvalTimeoutMs,
        estimatedCostUsd: 15,
        budgetUsdMax: effectiveInput.budgetUsdMax,
        params: namecheapRegistrationParams,
        // Canal HERMANO (NO en params/hash): habilita el alias de plan-scope del registro Namecheap
        // (register_domain_namecheap ocupa el slot firmado register_domain_route53).
        dnsProviderId,
        stepResults
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
    } else if (namecheapDnsRun) {
      await recordSyntheticDoneStepWithState({
        deps,
        runState,
        runId,
        step: 3,
        skill: "wait_for_dns_propagation",
        params: {
          domain: chosenDomain,
          expectedRecord: { type: "NS", value: "skipped:namecheap-authoritative" },
          maxWaitMs: 0,
          pollIntervalMs: 0
        },
        outcome: {
          ok: true,
          status: "skipped",
          reason: "namecheap_authoritative_nameservers",
          provider: "namecheap"
        },
        stepResults
      });
      await audit(deps, "oc.dns.nameserver_wait_skipped", "domain", chosenDomain, "high", {
        runId,
        provider: "namecheap",
        reason: "namecheap_authoritative_nameservers"
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
    let reuseServerSlug = await resolveReuseServerSlugForProvider({
      deps,
      rawValue: effectiveInput.reuseServerSlug,
      vpsProviderId,
      runId,
      // el guard temprano (pre-run) ya audito el ignore; aca solo se aplica.
      auditIgnore: false
    });
    if (!reuseServerSlug && isNonWebdockProviderId(vpsProviderId) && runState.reuseServerSlug) {
      // Limpia un slug persistido por un run-state viejo para que el resume firmado no compare
      // contra un valor que este flujo ignora.
      delete runState.reuseServerSlug;
    }
    // Safety + autonomía: si NO vino reuseServerSlug pero smtp.<dominio> ya resuelve a un server vivo
    // de la flota local, REUSAR ese server en vez de crear uno nuevo. Evita que un rescate donde el
    // modelo omitió reuseServerSlug termine creando un VPS por accidente. Es self-gating: solo reusa
    // cuando el dominio YA apunta a infraestructura conocida; si no resuelve o apunta a una IP
    // desconocida, cae al create (comportamiento byte-idéntico para dominios frescos).
    let reuseServerAutoDerived = false;
    if (!reuseServerSlug && !isNonWebdockProviderId(vpsProviderId) && !runState.serverCreatedByRun) {
      const derived = await deriveReuseServerFromLiveDomain(deps, smtpHost, runId).catch(() => undefined);
      if (derived) {
        reuseServerSlug = derived;
        reuseServerAutoDerived = true;
        void logger.info("openclaw.orchestrator.reuse_server_auto_derived", "configure_complete_smtp derivó el server de reuse desde el A record del dominio.", {
          runId,
          serverSlug: derived,
          domain: chosenDomain,
          smtpHost
        });
      }
    }
    const createStepWasAlreadyDone = runState.steps["4"]?.status === "done";
    let vps: ConfigureCompleteSmtpStepResult | undefined;
    if (reuseServerSlug) {
      const reusableServer = await readReusableWebdockServer(deps, reuseServerSlug, {
        mode: "full",
        expectedHostname: smtpHost
      });
      if (requestedServerAccountId && reusableServer.serverAccountId && requestedServerAccountId !== reusableServer.serverAccountId) {
        throw new OrchestratorFailure("failed", 0, "server_account_guard", "reuse_server_account_mismatch");
      }
      runState.serverSlug = reusableServer.slug;
      runState.reuseServerSlug = reuseServerSlug;
      runState.serverIpv4 = reusableServer.ipv4;
      runState.serverCreatedByRun = false;
      if (reusableServer.serverAccountId) {
        runState.serverAccountId = reusableServer.serverAccountId;
      } else if (requestedServerAccountId) {
        runState.serverAccountId = requestedServerAccountId;
      }
      await persistSmtpRunState(deps, runState);
      void logger.info("openclaw.orchestrator.webdock_server_reused", "configure_complete_smtp reused an existing Webdock server.", {
        runId,
        reuseServerSlug,
        serverSlug: reusableServer.slug,
        serverIpv4: reusableServer.ipv4,
        serverAccountId: runState.serverAccountId ?? null,
        domain: chosenDomain,
        smtpHost
      });
      await audit(deps, "oc.orchestrator.webdock_server_reused", "webdock_server", reusableServer.slug, "high", {
        runId,
        actorId: effectiveInput.actorId,
        reuseServerSlug,
        autoDerived: reuseServerAutoDerived,
        serverSlug: reusableServer.slug,
        serverIpv4: reusableServer.ipv4,
        serverAccountId: runState.serverAccountId ?? null,
        domain: chosenDomain,
        smtpHost,
        source: reuseServerAutoDerived ? "dns_a_record+webdock-servers.json" : "webdock-servers.json"
      });
      vps = await recordSyntheticDoneStepWithState({
        deps,
        runState,
        runId,
        step: 4,
        skill: "create_webdock_server",
        params: {
          runId,
          profile: "bit",
          locationId: "dk",
          hostname: smtpHost,
          imageSlug: "ubuntu-2404",
          reuseServerSlug
        },
        outcome: {
          status: "reused",
          slug: reusableServer.slug,
          serverSlug: reusableServer.slug,
          ipv4: reusableServer.ipv4,
          costUsd: 0
        },
        estimatedCostUsd: 0,
        stepResults
      });
    } else if (isNonWebdockProviderId(vpsProviderId)) {
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
      const reuseAccountId = !requestedServerAccountId
        && attempt === 0
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
          requestedAccountId: requestedServerAccountId,
          excludeAccounts: excludedFailoverAccounts
        });
      if (!serverAccountId || excludedFailoverAccounts.has(serverAccountId)) {
        break; // no quedan cuentas write-capable con las que reintentar
      }
      // Preflight LIVE de credenciales de la cuenta elegida (2 GETs): un token revocado del
      // lado del proveedor ya no revienta a mitad del create. Cuenta explicita => falla exacta;
      // elegida por governor/reuse => se excluye y se prueba la siguiente (mismo patron que el
      // payment-failover). Apagable con CREATION_ACCOUNT_LIVE_PREFLIGHT_ENABLE=false.
      const livePreflight = await runCreationAccountLivePreflight({ deps, runId, accountId: serverAccountId });
      if (!livePreflight.ok) {
        if (requestedServerAccountId) {
          throw new OrchestratorFailure(
            "failed",
            0,
            "server_account_guard",
            `requested_account_ineligible: account=${serverAccountId} reason=credentials_${livePreflight.reason}`
          );
        }
        excludedFailoverAccounts.add(serverAccountId);
        lastCreateFailure = new OrchestratorFailure(
          "failed",
          4,
          "create_webdock_server",
          `creation_account_credentials_rejected: account=${serverAccountId} reason=credentials_${livePreflight.reason}`
        );
        continue;
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
        if (requestedServerAccountId) {
          throw createError; // cuenta explicita = exactamente ahi; nunca failover silencioso.
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

    const bindServerAccountId = runState.serverAccountId && runState.serverAccountId !== DEFAULT_CREATION_ACCOUNT_ID
      ? runState.serverAccountId
      : undefined;

    await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: 6,
      skill: dnsProviderId === "ionos"
        ? "upsert_dns_ionos"
        : dnsProviderId === "namecheap"
          ? "upsert_dns_namecheap"
          : "upsert_dns_route53",
      actorId: effectiveInput.actorId,
      approvalTimeoutMs,
      budgetUsdMax: effectiveInput.budgetUsdMax,
      params: dnsProviderId === "ionos"
        ? ionosSmtpRouteDnsParams({ domain: chosenDomain, smtpHost, serverIpv4 })
        : dnsProviderId === "namecheap"
          ? namecheapSmtpRouteDnsParams({ domain: chosenDomain, smtpHost, serverIpv4 })
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
      // Canales HERMANOS (NO en params/hash): providerId enruta binds no-Webdock al path del proveedor;
      // serverAccountId enruta binds Webdock no-default al adapter de esa cuenta. undefined/"webdock" + ops
      // preservan el bind Webdock single-account byte-identico.
      serverAccountId: bindServerAccountId,
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
    if ((dnsProviderId === "ionos" || dnsProviderId === "namecheap") && !dkimDnsValue) {
      throw new OrchestratorFailure(
        "failed",
        10,
        dnsProviderId === "ionos" ? "upsert_dns_ionos" : "upsert_dns_namecheap",
        "dkim_public_key_missing"
      );
    }

    await runMutatingStepWithState({
      deps,
      runState,
      planApproval,
      runId,
      step: 10,
      skill: dnsProviderId === "ionos"
        ? "upsert_dns_ionos"
        : dnsProviderId === "namecheap"
          ? "upsert_dns_namecheap"
          : "configure_email_auth",
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
        : dnsProviderId === "namecheap"
          ? namecheapEmailAuthDnsParams({
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

    const runSmokeAuthGate = () => verifySmokeAuthGate({
      domain: chosenDomain,
      smtpHost,
      serverIpv4,
      selector,
      resolver: deps.smokeAuthDnsResolver ?? defaultSmokeAuthDnsResolver
    });
    let smokeAuthGate = await runSmokeAuthGate();
    // Retry acotado: tras repuntar/crear el DNS de un rescate, spf/ptr/fcrdns pueden no haber
    // propagado todavía al resolver (TTL del A viejo cacheado). En vez de fallar y exigir un
    // resume manual, esperamos a que propague hasta un techo y recién ahí fallamos-cerrado si
    // siguen mal. NO se reintenta ante invalid_precondition (error de config duro, no de
    // propagación). Default 0 => sin espera (comportamiento previo intacto para los tests); el
    // gateway lo activa vía OPENCLAW_SMOKE_AUTH_GATE_MAX_WAIT_MS.
    const smokeAuthGateMaxWaitMs = positiveInt(deps.env?.OPENCLAW_SMOKE_AUTH_GATE_MAX_WAIT_MS) ?? 0;
    const smokeAuthGatePollMs = positiveInt(deps.env?.OPENCLAW_SMOKE_AUTH_GATE_POLL_MS) ?? 20_000;
    if (!smokeAuthGate.ok && smokeAuthGateMaxWaitMs > 0 && !smokeAuthGate.missing.includes("invalid_precondition")) {
      const smokeAuthDeadline = Date.now() + smokeAuthGateMaxWaitMs;
      while (!smokeAuthGate.ok && !smokeAuthGate.missing.includes("invalid_precondition") && Date.now() < smokeAuthDeadline) {
        const wait = Math.min(smokeAuthGatePollMs, Math.max(0, smokeAuthDeadline - Date.now()));
        if (wait <= 0) break;
        await delay(wait);
        smokeAuthGate = await runSmokeAuthGate();
      }
    }
    if (!smokeAuthGate.ok) {
      delete runState.steps[String(14)];
      runState.status = "failed";
      markRunFailureClassification(runState, "smoke_auth_not_ready");
      await persistSmtpRunState(deps, runState);
      await audit(deps, "oc.orchestrator.smoke_blocked_auth_not_ready", "openclaw_orchestrator_run", runId, "critical", {
        error: "smoke_blocked_auth_not_ready",
        domain: chosenDomain,
        smtpHost,
        serverIpv4,
        selector,
        missing: smokeAuthGate.missing,
        gateError: smokeAuthGate.error,
        retryable: true,
        retryAfterMs: smokeAuthRetryAfterMs,
        checks: smokeAuthGate.checks
      });
      throw new OrchestratorFailure(
        "failed",
        14,
        "send_real_email",
        `smoke_blocked_auth_not_ready: ${smokeAuthGate.missing.join(",")}`
      );
    }

    // Auto-retry del envio DENTRO del run: un fallo retryable del step 14 (auth propagando,
    // transitorio de SSH/Postfix) no debe tumbar el run y exigir un resume manual. Default 1
    // intento (comportamiento previo intacto); el gateway lo activa via
    // OPENCLAW_SEND_REAL_EMAIL_MAX_ATTEMPTS. El SMOKE_AUTH_GATE de arriba y el polling interno
    // del handler (~150s) ya cubren la espera de propagacion; este loop solo reintenta el step.
    const sendMaxAttempts = positiveInt(deps.env?.OPENCLAW_SEND_REAL_EMAIL_MAX_ATTEMPTS) ?? 1;
    const sendRetryBackoffMs = positiveInt(deps.env?.OPENCLAW_SEND_REAL_EMAIL_RETRY_BACKOFF_MS) ?? 60_000;
    const sendRetryMaxWaitMs = positiveInt(deps.env?.OPENCLAW_SEND_REAL_EMAIL_RETRY_MAX_WAIT_MS) ?? 900_000;
    const sendRetryDeadline = Date.now() + sendRetryMaxWaitMs;

    let realEmail: Awaited<ReturnType<typeof runMutatingStepWithState>>;
    let sendAttempt = 0;
    for (;;) {
      sendAttempt += 1;
      // Solo se persiste cuando hubo reintento: los runs de 1 intento conservan el shape previo.
      if (sendAttempt > 1) runState.sendAttempts = sendAttempt;
      realEmail = await runMutatingStepWithState({
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
      // step 14 del estado para que un reintento (in-run o resume) reenvie cuando propague.
      const sendErrorCode =
        isRecord(realEmail.outcome) && typeof realEmail.outcome.error === "string"
          ? realEmail.outcome.error.trim()
          : "";
      if (!sendErrorCode) break;

      const retryableSendError = isRetryableSendErrorCode(sendErrorCode);
      if (
        retryableSendError &&
        sendAttempt < sendMaxAttempts &&
        Date.now() + sendRetryBackoffMs <= sendRetryDeadline
      ) {
        delete runState.steps[String(14)];
        await persistSmtpRunState(deps, runState);
        await audit(deps, "oc.orchestrator.send_retry_scheduled", "openclaw_orchestrator_run", runId, "high", {
          attempt: sendAttempt,
          maxAttempts: sendMaxAttempts,
          errorCode: sendErrorCode,
          backoffMs: sendRetryBackoffMs,
          domain: chosenDomain
        });
        await delay(sendRetryBackoffMs);
        continue;
      }

      const detailObj =
        isRecord(realEmail.outcome) && isRecord(realEmail.outcome.details)
          ? realEmail.outcome.details
          : null;
      const detailStr = detailObj
        ? ` (${Object.entries(detailObj).map(([k, v]) => `${k}=${String(v)}`).join(", ")})`
        : "";
      delete runState.steps[String(14)];
      runState.status = "failed";
      // Solo se clasifica como agotado si hubo reintentos reales: con el default de 1 intento
      // el comportamiento (y el shape del estado) queda identico al previo.
      if (retryableSendError && sendAttempt > 1) {
        markRunFailureClassification(runState, "send_retry_exhausted");
      } else {
        clearRunFailureClassification(runState);
      }
      await persistSmtpRunState(deps, runState);
      await emitStep(deps, "oc.orchestrator.step_failed", runId, 14, "send_real_email", {
        error: sendErrorCode,
        ...(detailObj ? { details: detailObj } : {}),
        ...(sendAttempt > 1 ? { sendAttempts: sendAttempt } : {})
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

    const postSmokeAuth = evaluatePostSmokeAuthenticationOutcome(realEmail.outcome);
    if (!postSmokeAuth.ok) {
      delete runState.steps[String(14)];
      runState.status = "failed";
      clearRunFailureClassification(runState);
      await persistSmtpRunState(deps, runState);
      if (postSmokeAuth.anomalies.length > 0) {
        await audit(deps, "oc.orchestrator.smoke_auth_result_parse_anomaly", "openclaw_orchestrator_run", runId, "high", {
          error: "smoke_auth_result_parse_anomaly",
          domain: chosenDomain,
          smtpHost,
          serverIpv4,
          selector,
          details: postSmokeAuth.details,
          anomalies: postSmokeAuth.anomalies
        });
      }
      await audit(deps, "oc.orchestrator.smoke_auth_result_failed", "openclaw_orchestrator_run", runId, "critical", {
        error: "smoke_authentication_result_failed",
        domain: chosenDomain,
        smtpHost,
        serverIpv4,
        selector,
        details: postSmokeAuth.details,
        failures: postSmokeAuth.failures
      });
      throw new OrchestratorFailure(
        "failed",
        14,
        "send_real_email",
        `smoke_authentication_result_failed: ${postSmokeAuth.failures.join(",")}`,
        realEmail.proposalId,
        realEmail.inputHash
      );
    }

    await persistConfiguredSmtpInventoryForRun(deps, {
      domain: chosenDomain,
      serverSlug,
      serverIp: serverIpv4,
      selector
    });

    const totalDurationMs = elapsed(deps, startedMs);
    const totalCostUsd = roundUsd(totalEstimatedCost(stepResults));
    runState.status = "completed";
    clearRunFailureClassification(runState);
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
    const progress = smtpRunStateToProgress(runState);

    return {
      runId,
      status: "completed",
      stepResults,
      totalDurationMs,
      totalCostUsd,
      ...(progress.identity ? { identity: progress.identity } : {}),
      steps: progress.steps,
      finalEmailMessageId: runState.finalEmailMessageId,
      finalDeliveryStatus: runState.finalDeliveryStatus
    };
  } catch (error) {
    const failure = normalizeFailure(error);
    const retryableSmokeAuthFailure = isSmokeAuthReadinessFailure(failure);
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
      if (retryableSmokeAuthFailure) {
        markRunFailureClassification(runState, "smoke_auth_not_ready");
      } else if (runState.failureCategory !== "send_retry_exhausted") {
        // send_retry_exhausted ya fue clasificado por el retry-loop del step 14: se preserva.
        clearRunFailureClassification(runState);
      }
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

    // No proponer delete del VPS ante fallos retryables del step 14: un resume puede completar
    // el envio sin re-provisionar (smoke auth propagando, o reintentos de envio agotados).
    const skipRollbackForSmokeAuth = retryableSmokeAuthFailure || runState?.failureCategory === "send_retry_exhausted";
    if (serverSlug && failure.step >= 6 && deps.submitRollbackProposal && runState?.serverCreatedByRun === true && !skipRollbackForSmokeAuth) {
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
      const rollbackSkipReason = skipRollbackForSmokeAuth
        ? (retryableSmokeAuthFailure ? "smoke_auth_not_ready_retryable" : "send_retry_exhausted_retryable")
        : runState?.serverCreatedByRun === false
        ? "server_not_created_by_current_run"
        : "server_created_by_run_unknown";
      const rollbackSkipMessage = skipRollbackForSmokeAuth
        ? "configure_complete_smtp skipped VPS delete rollback because the send step can be retried."
        : runState?.serverCreatedByRun === false
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
    const progress = runState ? smtpRunStateToProgress(runState) : null;
    const failureGuidance = guidanceForFailure(failure.message);
    return {
      runId,
      status: failure.status,
      stepResults,
      totalDurationMs: elapsed(deps, startedMs),
      totalCostUsd: roundUsd(totalEstimatedCost(stepResults)),
      ...(progress?.identity ? { identity: progress.identity } : {}),
      ...(progress ? { steps: progress.steps } : {}),
      rollbackProposalId,
      error: failure.message,
      ...(failureGuidance ? { guidance: failureGuidance } : {}),
      failedStep: failure.step,
      ...(runState?.retryableFailure ? { retryable: true } : {}),
      ...(runState?.failureCategory ? { failureKind: runState.failureCategory } : {}),
      ...(runState?.failureRetryAfterMs ? { retryAfterMs: runState.failureRetryAfterMs } : {})
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
        pid: process.pid,
        // hostname habilita el chequeo de pid vivo SOLO same-host: en otro host un pid puede existir
        // y pertenecer a otro proceso, asi que sin coincidencia de host caemos al lease por mtime.
        hostname: hostname()
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
  // 1) pid muerto en ESTE host: el proceso que tomo el lock ya no existe (p.ej. reinicio del gateway a
  //    mitad de run). Expira de inmediato sin esperar los 40 min del lease. Solo valido same-host.
  const lease = await readSmtpRunLockLease(lockDir);
  if (
    lease &&
    typeof lease.pid === "number" &&
    typeof lease.hostname === "string" &&
    lease.hostname === hostname() &&
    !isPidAlive(lease.pid)
  ) {
    return true;
  }
  // 2) Fallback por mtime (lease sin pid legible, o host distinto): proteccion anti-doble-efecto igual
  //    que antes.
  try {
    const info = await stat(lockDir);
    return now.getTime() - info.mtimeMs > smtpRunStateLockLeaseMs;
  } catch {
    return false;
  }
}

interface SmtpRunLockLease {
  runId?: string;
  pid?: number;
  hostname?: string;
  acquiredAt?: string;
  leaseUntil?: string;
}

async function readSmtpRunLockLease(lockDir: string): Promise<SmtpRunLockLease | null> {
  try {
    return JSON.parse(await readFile(join(lockDir, "lease.json"), "utf8")) as SmtpRunLockLease;
  } catch {
    return null;
  }
}

/**
 * true si el pid sigue vivo en este host. `process.kill(pid, 0)` no envia senal, solo chequea:
 * ESRCH => no existe (muerto); EPERM => existe pero sin permiso (vivo). Cualquier otro error se trata
 * como vivo (fail-safe: no liberar un lock por un error inesperado).
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Solo ESRCH (no existe el proceso) cuenta como muerto y habilita liberar el lock. EPERM
    // (existe, sin permiso) y CUALQUIER otro errno inesperado => vivo, para no soltar por error
    // un lock que gatea runs que gastan dinero.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const smtpRunLockDirPattern = /^run-.*\.lock$/;

function smtpRunLocksRoot(workspace: Pick<OpenClawWorkspace, "getRootDir">): string {
  return join(workspace.getRootDir(), "inventory", ".locks");
}

async function listSmtpRunLockDirs(lockRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(lockRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && smtpRunLockDirPattern.test(entry.name))
      .map((entry) => join(lockRoot, entry.name));
  } catch {
    return [];
  }
}

/**
 * Barrido de arranque: borra los locks de run cuyo lease tenga un pid MUERTO en este host. Cierra el
 * disparador del incidente 2026-07-13 (reinicio del gateway a mitad de run -> lock huerfano -> HTTP 423
 * hasta 40 min). No toca locks de otro host (mtime sigue protegiendo) ni con pid vivo.
 */
export async function sweepDeadSmtpRunLocks(
  workspace: Pick<OpenClawWorkspace, "getRootDir" | "ensureBase">,
  logger?: GatewayRuntimeLogger
): Promise<{ removed: string[] }> {
  await workspace.ensureBase().catch(() => undefined);
  const lockRoot = smtpRunLocksRoot(workspace);
  const removed: string[] = [];
  for (const lockDir of await listSmtpRunLockDirs(lockRoot)) {
    const lease = await readSmtpRunLockLease(lockDir);
    const deadSameHost =
      lease &&
      typeof lease.pid === "number" &&
      typeof lease.hostname === "string" &&
      lease.hostname === hostname() &&
      !isPidAlive(lease.pid);
    if (!deadSameHost) continue;
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    removed.push(lockDir);
    void (logger ?? noopGatewayRuntimeLogger).warn(
      "openclaw.orchestrator.orphan_run_lock_swept",
      "Removed orphan SMTP run lock whose owner process is dead.",
      { lockDir, runId: lease?.runId, pid: lease?.pid }
    );
  }
  return { removed };
}

/**
 * Shutdown graceful (SIGTERM): libera los locks de run que tomo ESTE proceso (lease.pid === process.pid)
 * para que un reinicio inmediato no herede un lock huerfano. Idempotente y fail-safe.
 */
export async function releaseOwnSmtpRunLocks(
  workspace: Pick<OpenClawWorkspace, "getRootDir">,
  logger?: GatewayRuntimeLogger
): Promise<{ removed: string[] }> {
  const lockRoot = smtpRunLocksRoot(workspace);
  const removed: string[] = [];
  for (const lockDir of await listSmtpRunLockDirs(lockRoot)) {
    const lease = await readSmtpRunLockLease(lockDir);
    // Same-host guard: en un workspace compartido (NFS) otro host podría tener un lease con el mismo
    // pid numérico; solo liberamos locks que ESTE proceso tomó en ESTE host (igual que sweep/expired).
    if (!lease || lease.pid !== process.pid || lease.hostname !== hostname()) continue;
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    removed.push(lockDir);
    void (logger ?? noopGatewayRuntimeLogger).info(
      "openclaw.orchestrator.run_lock_released_on_shutdown",
      "Released own SMTP run lock during graceful shutdown.",
      { lockDir, runId: lease.runId }
    );
  }
  return { removed };
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
    // reuse solo esta soportado en Webdock: para proveedores no-Webdock el slug se ignora aca
    // (el guard tolerante del flujo lo audita) en vez de tumbar el run por un param del agente.
    ...(input.params.reuseServerSlug && !isNonWebdockProviderId(normalizeVpsProviderId(input.params.vpsProviderId))
      ? { reuseServerSlug: normalizeReuseServerSlug(input.params.reuseServerSlug) }
      : {}),
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
    ...(identity ? { identity } : {}),
    ...(state.retryableFailure ? { retryableFailure: true } : {}),
    ...(state.failureCategory ? { failureCategory: state.failureCategory } : {}),
    ...(state.failureRetryAfterMs ? { failureRetryAfterMs: state.failureRetryAfterMs } : {}),
    ...(state.sendAttempts ? { sendAttempts: state.sendAttempts } : {})
  };
}

function markRunFailureClassification(
  state: SmtpRunState,
  category: NonNullable<SmtpRunState["failureCategory"]>
): void {
  state.retryableFailure = true;
  state.failureCategory = category;
  state.failureRetryAfterMs = smokeAuthRetryAfterMs;
}

function clearRunFailureClassification(state: SmtpRunState): void {
  delete state.retryableFailure;
  delete state.failureCategory;
  delete state.failureRetryAfterMs;
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

// Namecheap DNS autoritativo: mismo shape de records {name,type,content,ttl,prio} que IONOS; el
// upsert Namecheap traduce FQDN->host relativo y prio->mxPref. La zona se referencia por `domain`.
function namecheapSmtpRouteDnsParams(input: {
  domain: string;
  smtpHost: string;
  serverIpv4: string;
}): Record<string, unknown> {
  return {
    domain: input.domain,
    records: [
      { name: input.smtpHost, type: "A", ttl: 300, content: input.serverIpv4 },
      { name: input.domain, type: "MX", ttl: 300, content: `${input.smtpHost}.`, prio: 10 }
    ]
  };
}

function namecheapEmailAuthDnsParams(input: {
  domain: string;
  serverIpv4: string;
  selector: string;
  dkimDnsValue: string;
}): Record<string, unknown> {
  // DMARC rua/ruf AUTO-referenciados al propio dominio (dmarc@<domain>): dominio de envío
  // independiente y sin fuga de marca en el DNS público (opsec: los dominios de envío no revelan marca).
  return {
    domain: input.domain,
    records: [
      { name: input.domain, type: "TXT", ttl: 300, content: `v=spf1 ip4:${input.serverIpv4} -all` },
      { name: `${input.selector}._domainkey.${input.domain}`, type: "TXT", ttl: 300, content: input.dkimDnsValue },
      {
        name: `_dmarc.${input.domain}`,
        type: "TXT",
        ttl: 300,
        content: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${input.domain}; ruf=mailto:dmarc@${input.domain}; fo=1`
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
    // brand/intent son DERIVADOS del estado en un resume: OpenClaw no memoriza el literal exacto al
    // reanudar (mandaba "annualfiling" cuando el run nacio con "controlannualfiling"), y el replay del
    // paso 1 recomputa su hash con estos valores -> sin propagarlos el resume moria con
    // resume_scope_drift: step_input_changed. Se pisan SIEMPRE (incluido intent undefined) para
    // reproducir byte-identico el input del run original.
    brand: state.params.brand,
    intent: state.params.intent,
    ...(state.chosenDomain ? { domain: state.chosenDomain } : input.domain ? { domain: input.domain } : {}),
    ...(state.params.provider ? { provider: state.params.provider } : input.provider ? { provider: input.provider } : {}),
    ...(state.providerId ? { vpsProviderId: state.providerId } : input.vpsProviderId ? { vpsProviderId: input.vpsProviderId } : {}),
    ...(state.serverAccountId ? { serverAccountId: state.serverAccountId } : input.serverAccountId ? { serverAccountId: input.serverAccountId } : {}),
    ...(state.reuseServerSlug ? { reuseServerSlug: state.reuseServerSlug } : input.reuseServerSlug ? { reuseServerSlug: input.reuseServerSlug } : {}),
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
    if (input.planApproval.scope.vpsProviderId && state.providerId && input.planApproval.scope.vpsProviderId !== state.providerId) details.push("vpsProviderId");
    if (input.planApproval.scope.serverAccountId && state.serverAccountId && input.planApproval.scope.serverAccountId !== state.serverAccountId) details.push("serverAccountId");
    const stateReuseServerSlug = state.reuseServerSlug ?? state.serverSlug;
    if (input.planApproval.scope.reuseServerSlug && stateReuseServerSlug && input.planApproval.scope.reuseServerSlug !== stateReuseServerSlug) details.push("reuseServerSlug");
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

type ReuseServerValidation =
  | { mode: "pre-run"; failure: { step: number; skill: string } }
  | { mode: "full"; expectedHostname: string; failure?: { step: number; skill: string } };

/**
 * Deriva el server de reuse cuando el operador/modelo NO pasó reuseServerSlug: resuelve el A record
 * de smtp.<dominio> y busca un server RUNNING en webdock-servers.json cuyo ipv4 coincida. Devuelve el
 * slug o undefined. Fail-safe: cualquier error de resolución/lectura => undefined (=> el orquestador
 * crea, comportamiento byte-idéntico). Self-gating: solo matchea si el dominio ya apunta a un server
 * conocido de la flota, evitando crear un VPS nuevo por accidente en un rescate.
 */
async function deriveReuseServerFromLiveDomain(
  deps: ConfigureCompleteSmtpDeps,
  smtpHost: string,
  runId: string
): Promise<string | undefined> {
  const resolver = deps.smokeAuthDnsResolver;
  if (!resolver) return undefined;
  const inventory = await requireRunStateWorkspace(deps)
    .readInventoryJson<WebdockInventoryForResume>("webdock-servers.json")
    .catch(() => null);
  // Si este run YA tiene un binding (resume o reconstrucción legacy), ese path resuelve el server;
  // no derivamos por DNS para no pisar su lógica.
  const alreadyBound = inventory?.runBindings?.some((binding) => binding.runId === runId);
  if (alreadyBound) return undefined;
  const ips = await resolver.resolve4(smtpHost).catch(() => [] as string[]);
  if (!ips || ips.length === 0) return undefined;
  const ipSet = new Set(ips.map((ip) => ip.trim()).filter(Boolean));
  if (ipSet.size === 0) return undefined;
  const match = inventory?.servers?.find((server) => {
    const status = typeof server.status === "string" ? server.status.trim().toLowerCase() : "running";
    const running = !status || ["running", "active", "online"].includes(status);
    const ipv4 = typeof server.ipv4 === "string" ? server.ipv4.trim() : "";
    return running && Boolean(ipv4) && ipSet.has(ipv4);
  });
  return match ? match.slug.trim().toLowerCase() : undefined;
}

async function readReusableWebdockServer(
  deps: ConfigureCompleteSmtpDeps,
  reuseServerSlug: string,
  validation: ReuseServerValidation
): Promise<{ slug: string; ipv4: string; serverAccountId?: string }> {
  const failure = validation.failure ?? { step: 4, skill: "create_webdock_server" };
  const inventory = await requireRunStateWorkspace(deps)
    .readInventoryJson<WebdockInventoryForResume>("webdock-servers.json")
    .catch(() => null);
  const server = inventory?.servers?.find((entry) => entry.slug.trim().toLowerCase() === reuseServerSlug);
  if (!server) {
    throw new OrchestratorFailure("failed", failure.step, failure.skill, `reuse_server_not_found:${reuseServerSlug}`);
  }
  const status = typeof server.status === "string" ? server.status.trim().toLowerCase() : "running";
  if (status && !["running", "active", "online"].includes(status)) {
    throw new OrchestratorFailure("failed", failure.step, failure.skill, `reuse_server_not_running:${reuseServerSlug}`);
  }
  const ipv4 = typeof server.ipv4 === "string" && server.ipv4.trim() ? server.ipv4.trim() : "";
  if (!ipv4) {
    throw new OrchestratorFailure("failed", failure.step, failure.skill, `reuse_server_ipv4_missing:${reuseServerSlug}`);
  }
  const hostname = typeof server.hostname === "string" ? normalizeHostnameForReuse(server.hostname) : "";
  // El guard protege contra reusar por accidente un server que YA es el endpoint SMTP DEDICADO de
  // otro dominio (hostname "smtp.<otro-dominio>"). Un hostname base (p.ej. "controldelivrix.app") NO
  // es un endpoint dedicado: un mismo VPS sirve smtp.<dominio> para varios dominios, así que un
  // hostname base distinto es esperable en un reuse multi-dominio y no debe bloquear — el operador
  // elige el slug explícitamente y firma el ApprovalGate, y el A record de smtp.<dominio> ya
  // corrobora el server. Solo los hostnames "smtp.*" cargan identidad de endpoint dedicado.
  const storedIsDedicatedSmtpHost = hostname.startsWith("smtp.");
  if (
    validation.mode === "full" &&
    storedIsDedicatedSmtpHost &&
    hostname !== normalizeHostnameForReuse(validation.expectedHostname)
  ) {
    throw new OrchestratorFailure("failed", failure.step, failure.skill, "reuse_server_hostname_mismatch");
  }
  const serverAccountId = normalizeServerAccountId(server.accountId ?? server.serverAccountId);
  return {
    slug: server.slug.trim().toLowerCase(),
    ipv4,
    ...(serverAccountId ? { serverAccountId } : {})
  };
}

function normalizeHostnameForReuse(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
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
 * Errores del step 14 (send_real_email) que ameritan auto-retry dentro del run: propagacion de
 * auth aun en curso o transitorios de Postfix/SSH. Todo lo demas (burner, approval, kill switch,
 * rate_limit_exceeded que escala por hora) es terminal: reintentar no cambia el resultado.
 */
const SEND_RETRYABLE_ERROR_CODES = new Set([
  "email_auth_incomplete",
  "postfix_not_running",
  "rate_limit_reservation_failed"
]);
const SEND_RETRYABLE_ERROR_PREFIXES = ["send_command_failed", "send_preflight_failed"];

function isRetryableSendErrorCode(code: string): boolean {
  return (
    SEND_RETRYABLE_ERROR_CODES.has(code) ||
    SEND_RETRYABLE_ERROR_PREFIXES.some((prefix) => code.startsWith(prefix))
  );
}

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
  request: ConfigureCompleteSmtpParams;
  runState: SmtpRunState;
}): Promise<PlanApprovalRecord> {
  if (!input.deps.resolvePlanApproval) {
    throw new OrchestratorFailure("failed", 0, "plan_approval", "plan_approval_resolver_missing");
  }
  const planParams: ConfigureCompleteSmtpParams = { ...input.input };
  if (normalizeServerAccountId(input.request.serverAccountId) === undefined) {
    delete planParams.serverAccountId;
  }
  const planApproval = await input.deps.resolvePlanApproval({
    runId: input.runId,
    params: planParams
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
  const expectedVpsProviderId = normalizeVpsProviderId(input.input.vpsProviderId);
  const expectedServerAccountId = normalizeServerAccountId(input.input.serverAccountId);
  const expectedReuseServerSlug = normalizeReuseServerSlug(input.input.reuseServerSlug);
  const requestedVpsProviderId = normalizeVpsProviderId(input.request.vpsProviderId);
  const requestedServerAccountId = normalizeServerAccountId(input.request.serverAccountId);
  const requestedReuseServerSlug = normalizeReuseServerSlug(input.request.reuseServerSlug);
  const expectedRecipient = input.input.testEmailRecipient.trim().toLowerCase();
  const details: string[] = [];
  if (planApproval.scope.domain !== expectedDomain) details.push("domain");
  if (planApproval.scope.provider !== expectedProvider) details.push("provider");
  if (planApproval.scope.vpsProviderId ? planApproval.scope.vpsProviderId !== expectedVpsProviderId : requestedVpsProviderId !== undefined) details.push("vpsProviderId");
  if (planApproval.scope.serverAccountId ? planApproval.scope.serverAccountId !== expectedServerAccountId : requestedServerAccountId !== undefined) details.push("serverAccountId");
  if (planApproval.scope.reuseServerSlug ? planApproval.scope.reuseServerSlug !== expectedReuseServerSlug : requestedReuseServerSlug !== undefined) details.push("reuseServerSlug");
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
    // requireExistingDomain SOLO gobierna si el paso 2 puede COMPRAR. Cuando la compra ya quedo
    // asentada en este run (paso 2 done / dominio propio / dinero gastado), el flag es DERIVADO: exigir
    // igualdad estricta contra el snapshot de nacimiento condena todo resume legitimo (16 fallos el
    // 2026-07-13). Adoptamos el valor del plan recien firmado, lo persistimos y lo auditamos. Mantenemos
    // la igualdad estricta SOLO cuando el paso 2 aun NO corrio (ahi el flag decide si se gasta dinero).
    if (!runStatePurchaseSettled(input.runState)) {
      throw new OrchestratorFailure(
        "failed",
        0,
        "plan_approval",
        "plan_scope_mismatch: requireExistingDomain"
      );
    }
    if (input.runState.params.requireExistingDomain !== approvedRequireExistingDomain) {
      input.runState.params.requireExistingDomain = approvedRequireExistingDomain;
      await persistSmtpRunState(input.deps, input.runState);
      await audit(input.deps, "oc.plan.scope_field_reconciled", "openclaw_orchestrator_run", input.runId, "high", {
        runId: input.runId,
        field: "requireExistingDomain",
        from: expectedRequireExistingDomain,
        to: approvedRequireExistingDomain,
        reason: "purchase_already_settled"
      });
    }
  }
  return planApproval;
}

/**
 * True si la compra de dominio (paso 2) ya quedo asentada en este run: el paso ya corrio, el dominio
 * ya es propio, o ya se gasto presupuesto con un dominio elegido. En ese estado requireExistingDomain
 * es DERIVADO (ya no decide un gasto) y no debe condenar un resume por igualdad estricta.
 */
function runStatePurchaseSettled(state: SmtpRunState): boolean {
  if (state.lastCompletedStep >= 2) return true;
  if (state.verifiedOwnedDomain) return true;
  if (state.chosenDomain && state.budgetSpentUsd > 0) return true;
  return state.steps["2"]?.status === "done";
}

function validatePlanApprovedStepScope(
  input: {
    planApproval: PlanApprovalRecord;
    runId: string;
    step: number;
    skill: string;
    params: Record<string, unknown>;
    serverAccountId?: string;
    providerId?: string;
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
  if (input.skill === "create_webdock_server" && normalizeVpsProviderId(input.providerId) !== scope.vpsProviderId) {
    throw new OrchestratorFailure("failed", input.step, input.skill, "plan_scope_mismatch:vpsProviderId", undefined, inputHash);
  }
  if (input.skill === "create_webdock_server" && scope.serverAccountId && normalizeServerAccountId(input.serverAccountId) !== scope.serverAccountId) {
    throw new OrchestratorFailure("failed", input.step, input.skill, "plan_scope_mismatch:serverAccountId", undefined, inputHash);
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
  // IONOS: el upsert autoritativo IONOS ocupa los slots del upsert Route53 (6) y del email-auth (10).
  if (dnsProviderId === "ionos" && skill === "upsert_dns_ionos") {
    if (step === 6) return plannedSteps.includes("upsert_dns_route53");
    if (step === 10) return plannedSteps.includes("configure_email_auth");
  }
  // Namecheap (registrador + DNS autoritativo independiente): el registro Namecheap ocupa el slot del
  // registro Route53 (2), y el upsert autoritativo Namecheap ocupa los slots del upsert Route53 (6) y
  // del email-auth (10). El plan firmado usa los nombres canonicos Route53; el alias los mapea.
  if (dnsProviderId === "namecheap") {
    if (step === 2 && skill === "register_domain_namecheap") return plannedSteps.includes("register_domain_route53");
    if (skill === "upsert_dns_namecheap") {
      if (step === 6) return plannedSteps.includes("upsert_dns_route53");
      if (step === 10) return plannedSteps.includes("configure_email_auth");
    }
  }
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

async function persistConfiguredSmtpInventoryForRun(
  deps: ConfigureCompleteSmtpDeps,
  input: { domain: string; serverSlug: string; serverIp: string; selector: string }
): Promise<void> {
  const workspace = requireRunStateWorkspace(deps);
  const domain = normalizeDomain(input.domain);
  const now = deps.now ?? (() => new Date());
  const existingInventory = await workspace.readInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json").catch(() => null);
  const existing = existingInventory?.servers?.find((entry) =>
    normalizeDomain(entry.domain) === domain &&
    entry.serverSlug === input.serverSlug
  );
  await upsertConfiguredSmtpInventoryEntry(workspace, {
    ...existing,
    domain,
    serverSlug: input.serverSlug,
    serverIp: input.serverIp,
    selector: input.selector,
    status: "configured",
    configuredAt: existing?.configuredAt ?? now().toISOString()
  }, now);
}

function evaluatePostSmokeAuthenticationOutcome(outcome: unknown):
  | { ok: true; status: "not_reported" | "pass"; details?: Record<string, unknown>; anomalies: string[] }
  | { ok: false; status: "failed"; failures: string[]; details: Record<string, unknown>; anomalies: string[] } {
  const auth = findAuthenticationResults(outcome);
  if (auth === null) {
    return { ok: true, status: "not_reported", anomalies: [] };
  }

  const parsed = authenticationResultDetails(auth);
  const details = parsed.details;
  const failures = ["spf", "dkim", "dmarc"].filter((key) => details[key] !== "pass");
  if (failures.length > 0) {
    return { ok: false, status: "failed", failures, details, anomalies: parsed.anomalies };
  }
  return { ok: true, status: "pass", details, anomalies: parsed.anomalies };
}

function findAuthenticationResults(outcome: unknown): unknown | null {
  if (!isRecord(outcome)) return null;
  const direct = outcome.authenticationResults ?? outcome.authResults ?? outcome.authentication_results;
  if (direct !== undefined) return direct;
  const nested = outcome.verification;
  if (isRecord(nested)) {
    return nested.authenticationResults ?? nested.authResults ?? nested.authentication_results ?? null;
  }
  return null;
}

function authenticationResultDetails(value: unknown): { details: Record<string, string>; anomalies: string[] } {
  if (typeof value === "string") return authenticationResultDetailsFromString(value);
  if (isRecord(value)) {
    const details = {
      spf: authStatusFromUnknown(value.spf),
      dkim: authStatusFromUnknown(value.dkim),
      dmarc: authStatusFromUnknown(value.dmarc)
    };
    return {
      details,
      anomalies: Object.entries(details)
        .filter(([, status]) => status === "unknown")
        .map(([key]) => key)
    };
  }
  return { details: { spf: "missing", dkim: "missing", dmarc: "missing" }, anomalies: [] };
}

function authenticationResultDetailsFromString(value: string): { details: Record<string, string>; anomalies: string[] } {
  const details = {
    spf: authStatusFromHeader(value, "spf"),
    dkim: authStatusFromHeader(value, "dkim"),
    dmarc: authStatusFromHeader(value, "dmarc")
  };
  return {
    details,
    anomalies: Object.entries(details)
      .filter(([, status]) => status === "unknown")
      .map(([key]) => key)
  };
}

function authStatusFromHeader(value: string, key: string): string {
  const match = new RegExp(`(?:^|\\s|;)${key}\\s*=\\s*([^;\\s]+)`, "i").exec(value);
  if (!match) {
    return new RegExp(`(?:^|\\s|;)${key}\\s*=`, "i").test(value) ? "unknown" : "missing";
  }
  return normalizeAuthStatus(match[1]);
}

function authStatusFromUnknown(value: unknown): string {
  if (typeof value === "string") return normalizeAuthStatus(value);
  if (isRecord(value)) {
    const result = value.result ?? value.status;
    return typeof result === "string" && result.trim() ? normalizeAuthStatus(result) : "missing";
  }
  if (value === true) return "pass";
  return "missing";
}

function normalizeAuthStatus(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "missing";
  if (["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror"].includes(normalized)) {
    return normalized;
  }
  return "unknown";
}

function isSmokeAuthReadinessFailure(failure: OrchestratorFailure): boolean {
  return failure.step === 14 && failure.message.startsWith("smoke_blocked_auth_not_ready");
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
/**
 * Preflight LIVE de la cuenta elegida para el create. Devuelve ok:true si la dep no esta
 * inyectada o el flag CREATION_ACCOUNT_LIVE_PREFLIGHT_ENABLE esta en false (default: activo
 * cuando hay dep). Audita cada rechazo con oc.orchestrator.creation_account_rejected.
 */
async function runCreationAccountLivePreflight(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  accountId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!input.deps.preflightCreationAccount) return { ok: true };
  if (envFlagDisabled(input.deps.env?.CREATION_ACCOUNT_LIVE_PREFLIGHT_ENABLE)) return { ok: true };
  let result: { ok: boolean; reason?: string };
  try {
    result = await input.deps.preflightCreationAccount({ accountId: input.accountId });
  } catch (error) {
    result = { ok: false, reason: `preflight_error:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}` };
  }
  if (result.ok) return { ok: true };
  const reason = result.reason ?? "unknown";
  await audit(input.deps, "oc.orchestrator.creation_account_rejected", "webdock_account", input.accountId, "high", {
    runId: input.runId,
    accountId: input.accountId,
    reason: `credentials_${reason}`
  });
  return { ok: false, reason };
}

async function resolveCreationAccount(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  step: 4;
  skill: "create_webdock_server";
  /** Cuenta Webdock nombrada por el operador. Si existe, se usa exactamente esa o se falla. */
  requestedAccountId?: string;
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
  if (allWriteCapable.length === 0) {
    await audit(input.deps, "oc.orchestrator.no_write_capable_account", "openclaw_orchestrator_run", input.runId, "critical", {
      runId: input.runId,
      error: "no_write_capable_account",
      detail: "ninguna cuenta Webdock write-capable configurada (par _WRITE+_ACCOUNT u ops)"
    });
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      "no_write_capable_account: none_configured"
    );
  }
  if (input.requestedAccountId) {
    return resolveRequestedCreationAccount({
      ...input,
      requestedAccountId: input.requestedAccountId,
      accounts: allWriteCapable,
      cap,
      window,
      now
    });
  }
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
    await auditCreationAccountChosen(input.deps, {
      runId: input.runId,
      step: input.step,
      skill: input.skill,
      selectedAccountId: winner.decision.accountId,
      selectionReason: selection.reason,
      candidates: creationSelectionCandidates(selectionAccounts, governorState)
    });
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
    // Compat de harness/tests: en produccion main.ts SIEMPRE inyecta la dep. Sin ella se asume
    // el single-account "ops" de siempre (quitar este branch romperia el harness de tests).
    return [{ accountId: DEFAULT_CREATION_ACCOUNT_ID, enabled: true }];
  }
  const accounts = await deps.listCreationAccounts();
  const normalized = accounts
    .map((account) => ({
      accountId: account.accountId.trim().toLowerCase(),
      enabled: account.enabled,
      ...(account.healthStatus ? { healthStatus: account.healthStatus } : {}),
      ...(account.lifecycleStatus ? { lifecycleStatus: account.lifecycleStatus } : {})
    }))
    .filter((account) => account.accountId.length > 0);
  // Dep presente y lista vacia = NO hay ninguna cuenta write-capable real. Antes se inventaba
  // una cuenta "ops" fantasma con enabled=true (aunque no tuviera keys) y el fallo aparecia
  // recien en el create real. Ahora se devuelve vacio y el caller falla limpio.
  return normalized;
}

async function assertRequestedCreationAccountSnapshotEligible(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  accountId: string;
}): Promise<WebdockCreationAccount[]> {
  const accounts = await resolveWriteCapableCreationAccounts(input.deps);
  const account = accounts.find((entry) => entry.accountId === input.accountId);
  const reason = account ? creationAccountSnapshotIneligibleReason(account) : "unknown";
  if (!reason) return accounts;
  await audit(input.deps, "oc.orchestrator.creation_account_rejected", "webdock_account", input.accountId, "critical", {
    runId: input.runId,
    step: 0,
    skill: "server_account_guard",
    requestedAccountId: input.accountId,
    reason
  });
  throw new OrchestratorFailure(
    "failed",
    0,
    "server_account_guard",
    `requested_account_ineligible: account=${input.accountId} reason=${reason}`
  );
}

async function assertRequestedCreationAccountBudgetPreflight(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  accountId: string;
  accounts: WebdockCreationAccount[];
}): Promise<void> {
  const enabled = !envFlagDisabled(input.deps.env?.CREATION_RATE_GOVERNOR_ENABLE);
  if (!enabled) return;

  const account = input.accounts.find((entry) => entry.accountId === input.accountId);
  const snapshotReason = account ? creationAccountSnapshotIneligibleReason(account) : "unknown";
  if (snapshotReason) return;

  const cap = nonNegativeInt(input.deps.env?.CREATION_MAX_PER_DAY) ?? 4;
  const window = creationRateWindow(input.deps.env?.CREATION_RATE_WINDOW);
  const now = input.deps.now?.() ?? new Date();
  const inventoryHash = requestedCreationAccountBudgetHash(input.accountId, cap, window);
  const readResult = await readRequestedCreationAccountInventoryWithRetry({
    deps: input.deps,
    accountId: input.accountId
  });

  if (!readResult.inventory) {
    const readDecision = evaluateCreationBudgetReadError({
      now,
      accountId: input.accountId,
      cap,
      enabled: true,
      window,
      failMode: "fail_closed",
      error: readResult.error
    });
    await auditRequestedCreationAccountPreflightRejected(input.deps, {
      runId: input.runId,
      accountId: input.accountId,
      reason: "budget_unverifiable",
      readErrorMessage: readDecision.readErrorMessage
    });
    throw new OrchestratorFailure(
      "failed",
      0,
      "server_account_guard",
      `requested_account_budget_unverifiable: account=${input.accountId}`,
      undefined,
      inventoryHash
    );
  }

  const decision = evaluateCreationBudget({
    servers: readResult.inventory.servers,
    now,
    cap,
    accountId: readResult.inventory.accountId ?? input.accountId,
    window,
    enabled: true
  });
  if (!decision.allowed) {
    await auditRequestedCreationAccountPreflightRejected(input.deps, {
      runId: input.runId,
      accountId: decision.accountId,
      reason: "rate_exceeded",
      createdInWindow: decision.createdInWindow
    });
    throw new OrchestratorFailure(
      "failed",
      0,
      "server_account_guard",
      `requested_account_ineligible: account=${decision.accountId} reason=rate_exceeded`,
      undefined,
      inventoryHash
    );
  }
}

async function readRequestedCreationAccountInventoryWithRetry(input: {
  deps: ConfigureCompleteSmtpDeps;
  accountId: string;
}): Promise<{ inventory?: WebdockCreationInventoryResult; error?: unknown }> {
  const reader = input.deps.listWebdockCreationServers;
  if (!reader) {
    return { error: "creation_inventory_reader_missing" };
  }

  let lastError: unknown = "creation_inventory_unverifiable";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const inventory = await reader({ accountId: input.accountId });
      if (inventory.sourceKind === "live" && inventory.responseOk === true) {
        return { inventory };
      }
      lastError = `creation_inventory_not_live: sourceKind=${inventory.sourceKind ?? "unknown"} responseOk=${String(inventory.responseOk)}`;
    } catch (error) {
      lastError = error;
    }

    if (attempt === 0) {
      await delay(requestedCreationAccountPreflightRetryDelayMs);
    }
  }

  return { error: lastError };
}

function requestedCreationAccountBudgetHash(
  accountId: string,
  cap: number,
  window: CreationRateWindow
): string {
  return hashInput({
    accountId,
    cap,
    window,
    gate: "creation_rate_governor",
    requested: true
  });
}

async function resolveRequestedCreationAccount(input: {
  deps: ConfigureCompleteSmtpDeps;
  runId: string;
  step: 4;
  skill: "create_webdock_server";
  requestedAccountId: string;
  accounts: WebdockCreationAccount[];
  cap: number;
  window: CreationRateWindow;
  now: Date;
}): Promise<string> {
  const account = input.accounts.find((entry) => entry.accountId === input.requestedAccountId);
  const snapshotReason = account ? creationAccountSnapshotIneligibleReason(account) : "unknown";
  if (snapshotReason) {
    await auditRequestedCreationAccountRejected(input.deps, input, snapshotReason);
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      `requested_account_ineligible: account=${input.requestedAccountId} reason=${snapshotReason}`
    );
  }
  const inventoryHash = requestedCreationAccountBudgetHash(input.requestedAccountId, input.cap, input.window);
  if (!input.deps.listWebdockCreationServers) {
    await auditRequestedCreationAccountRejected(input.deps, input, "unhealthy");
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      `requested_account_ineligible: account=${input.requestedAccountId} reason=unhealthy`,
      undefined,
      inventoryHash
    );
  }
  let inventory: WebdockCreationInventoryResult;
  try {
    inventory = await input.deps.listWebdockCreationServers({ accountId: input.requestedAccountId });
  } catch {
    await auditRequestedCreationAccountRejected(input.deps, input, "unhealthy");
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      `requested_account_ineligible: account=${input.requestedAccountId} reason=unhealthy`,
      undefined,
      inventoryHash
    );
  }
  if (inventory.sourceKind !== "live" || inventory.responseOk !== true) {
    await auditRequestedCreationAccountRejected(input.deps, input, "unhealthy");
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      `requested_account_ineligible: account=${input.requestedAccountId} reason=unhealthy`,
      undefined,
      inventoryHash
    );
  }
  const decision = evaluateCreationBudget({
    servers: inventory.servers,
    now: input.now,
    cap: input.cap,
    accountId: inventory.accountId ?? input.requestedAccountId,
    window: input.window,
    enabled: true
  });
  if (!decision.allowed) {
    await auditRequestedCreationAccountRejected(input.deps, input, "rate_exceeded", decision.createdInWindow);
    throw new OrchestratorFailure(
      "failed",
      input.step,
      input.skill,
      `requested_account_ineligible: account=${decision.accountId} reason=rate_exceeded`,
      undefined,
      inventoryHash
    );
  }
  await auditCreationAccountChosen(input.deps, {
    runId: input.runId,
    step: input.step,
    skill: input.skill,
    selectedAccountId: decision.accountId,
    requestedAccountId: input.requestedAccountId,
    selectionReason: "operator_requested",
    candidates: [{
      accountId: decision.accountId,
      enabled: true,
      healthy: true,
      budgetAllowed: true,
      remaining: Math.max(0, decision.cap - decision.createdInWindow)
    }]
  });
  return decision.accountId;
}

function creationAccountSnapshotIneligibleReason(account: WebdockCreationAccount): "not_write_capable" | "unhealthy" | undefined {
  if (!account.enabled) return "not_write_capable";
  const lifecycleStatus = account.lifecycleStatus?.trim().toLowerCase();
  const healthStatus = account.healthStatus?.trim().toLowerCase();
  if (lifecycleStatus === "disabled" || lifecycleStatus === "retired") return "not_write_capable";
  if (lifecycleStatus === "unauthorized" || lifecycleStatus === "suspended") return "unhealthy";
  if (healthStatus === "unauthorized" || healthStatus === "suspended_candidate" || healthStatus === "retired") return "unhealthy";
  return undefined;
}

function creationSelectionCandidates(
  accounts: CreationAccountForSelection[],
  governorState: CreationAccountGovernorState[]
): Array<{ accountId: string; enabled: boolean; healthy: boolean; budgetAllowed: boolean; remaining: number }> {
  return accounts.map((account) => {
    const state = governorState.find((entry) => entry.accountId === account.accountId);
    return {
      accountId: account.accountId,
      enabled: account.enabled ?? true,
      healthy: account.healthy,
      budgetAllowed: state?.allowed ?? false,
      remaining: state ? Math.max(0, state.cap - state.createdInWindow) : 0
    };
  });
}

async function auditCreationAccountChosen(input: ConfigureCompleteSmtpDeps, metadata: {
  runId: string;
  step: 4;
  skill: "create_webdock_server";
  selectedAccountId: string;
  requestedAccountId?: string;
  selectionReason: string;
  candidates: Array<{ accountId: string; enabled: boolean; healthy: boolean; budgetAllowed: boolean; remaining: number }>;
}): Promise<void> {
  await audit(input, "oc.orchestrator.creation_account_chosen", "webdock_account", metadata.selectedAccountId, "high", metadata);
}

async function auditRequestedCreationAccountRejected(input: ConfigureCompleteSmtpDeps, metadata: {
  runId: string;
  step: 4;
  skill: "create_webdock_server";
  requestedAccountId: string;
}, reason: string, createdInWindow?: number): Promise<void> {
  await audit(input, "oc.orchestrator.creation_account_rejected", "webdock_account", metadata.requestedAccountId, "critical", {
    runId: metadata.runId,
    step: metadata.step,
    skill: metadata.skill,
    requestedAccountId: metadata.requestedAccountId,
    reason,
    ...(createdInWindow === undefined ? {} : { createdInWindow })
  });
}

async function auditRequestedCreationAccountPreflightRejected(input: ConfigureCompleteSmtpDeps, metadata: {
  runId: string;
  accountId: string;
  reason: string;
  createdInWindow?: number;
  readErrorMessage?: string;
}): Promise<void> {
  await audit(input, "oc.orchestrator.creation_account_rejected", "webdock_account", metadata.accountId, "critical", {
    runId: metadata.runId,
    step: 0,
    skill: "server_account_guard",
    requestedAccountId: metadata.accountId,
    reason: metadata.reason,
    ...(metadata.createdInWindow === undefined ? {} : { createdInWindow: metadata.createdInWindow }),
    ...(metadata.readErrorMessage === undefined ? {} : { readErrorMessage: metadata.readErrorMessage })
  });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeServerAccountId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new OrchestratorFailure("failed", 0, "server_account_guard", "invalid_server_account_id");
  }
  return normalized;
}

function normalizeReuseServerSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/.test(normalized)) {
    throw new OrchestratorFailure("failed", 0, "reuse_server_guard", "invalid_reuse_server_slug");
  }
  return normalized;
}

/**
 * Guard TOLERANTE de reuseServerSlug: reuse solo esta soportado en Webdock. Si el run pide un
 * proveedor no-Webdock (familia Contabo) con reuseServerSlug — un error tipico del agente — el
 * parametro se IGNORA (log + audit) y el run sigue sin reuse, en vez de tumbarlo. El chequeo de
 * provider corre ANTES de normalizar, asi un slug malformado tampoco tumba el run en Contabo.
 * Para Webdock se mantiene el throw por formato invalido: ahi reuse SI aplica y "ignorar" un
 * typo podria crear un VPS con costo.
 */
async function resolveReuseServerSlugForProvider(input: {
  deps: ConfigureCompleteSmtpDeps;
  rawValue: unknown;
  vpsProviderId: string | undefined;
  runId: string;
  auditIgnore: boolean;
}): Promise<string | undefined> {
  if (isNonWebdockProviderId(input.vpsProviderId) && typeof input.rawValue === "string" && input.rawValue.trim()) {
    const requested = input.rawValue.trim().toLowerCase().slice(0, 120);
    void (input.deps.logger ?? noopGatewayRuntimeLogger).info(
      "openclaw.orchestrator.reuse_server_slug_ignored",
      "configure_complete_smtp ignoró reuseServerSlug: reuse solo está soportado en Webdock.",
      { runId: input.runId, vpsProviderId: input.vpsProviderId, requestedReuseServerSlug: requested }
    );
    if (input.auditIgnore) {
      await audit(input.deps, "oc.orchestrator.reuse_server_slug_ignored", "openclaw_orchestrator_run", input.runId, "medium", {
        runId: input.runId,
        vpsProviderId: input.vpsProviderId,
        requestedReuseServerSlug: requested
      });
    }
    return undefined;
  }
  return normalizeReuseServerSlug(input.rawValue);
}

/**
 * Familia Contabo: cuenta flat "contabo" + cuentas indexadas "contabo-N" (multicuenta).
 * El registry/dispatcher ya rutean cualquiera de estas por lookup en el map; el orquestador
 * debe aceptar toda la familia para no bloquear un SMTP en la cuenta nueva (contabo-2, etc.).
 */
function isContaboProviderId(value: string | undefined): boolean {
  return value === "contabo" || (typeof value === "string" && /^contabo-\d+$/.test(value));
}

function assertKnownNonWebdockVpsProviderId(value: string | undefined): void {
  if (value === undefined || isContaboProviderId(value)) return;
  throw new OrchestratorFailure("failed", 0, "vps_provider_guard", `unknown_vps_provider:${value}`);
}

/**
 * FAIL-FAST semantico del provider en el step 0 (antes de cualquier gasto). El guard sintactico
 * (assertKnownNonWebdockVpsProviderId) acepta cualquier contabo-N bien formado sin mirar si existe
 * adapter cargado; por eso hoy un contabo-N sin credenciales pasa los pasos 1-3 (incluida la compra
 * del dominio en el step 2) y recien muere en el step 4. Aca, si hay dep para consultar el registry de
 * adapters, abortamos ANTES de gastar. Sin la dep no se valida (byte-identico; el dispatcher del step 4
 * sigue siendo la ultima linea de defensa).
 */
function assertVpsProviderAdapterLoaded(
  providerId: string | undefined,
  deps: ConfigureCompleteSmtpDeps
): void {
  if (providerId === undefined) return;
  if (!deps.hasVpsProviderAdapter) return;
  if (deps.hasVpsProviderAdapter(providerId)) return;
  throw new OrchestratorFailure("failed", 0, "vps_provider_guard", `unknown_vps_provider:${providerId}`);
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
  if (value === undefined || value === "ionos" || value === "namecheap") return;
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

/**
 * Guia operativa para errores accionables del orquestador. Devuelve un texto que el agente/operador
 * debe leer para NO tomar la decision costosa equivocada (p.ej. cambiar de dominio ante un run en
 * curso). Devuelve undefined para errores sin guia especifica (comportamiento aditivo, byte-identico).
 */
function guidanceForFailure(message: string): string | undefined {
  if (message === "run_already_in_progress") {
    return "Hay un run en curso o un lock huerfano para este runId. Espera a que termine o pedi al operador " +
      "que limpie el lock; NO inicies un run con otro dominio (cada compra cuesta dinero). Reintenta el MISMO runId.";
  }
  return undefined;
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

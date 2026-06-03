import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import {
  AwsRoute53DomainsAdapter,
  AwsRoute53DnsAdapter,
  createWebdockAdaptersFromEnv,
  IonosDnsActuator,
  IonosDomainsAdapter,
  PorkbunAdapter,
  ProxmoxAdapter,
  WebdockAdapter,
  WebdockRealAdapter,
  type ProxmoxMockNodeConfig,
  type WebdockBridgeNodeConfig
} from "../../../packages/adapters/src/index.ts";
import {
  MailPolicyEngine,
  RateLimitService,
  SenderNodeRegistry,
  buildAdminOverview,
  buildAdminClusterOverview,
  buildAdminPanelWorkflow,
  buildBackupPlan,
  buildComplianceStatus,
  buildDevOpsCollectorStatus,
  buildIamRoles,
  buildIamSessions,
  buildManualCollectorSnapshotIngestionContract,
  buildHardwareTelemetryHistory,
  buildHardwareTelemetrySnapshot,
  buildOperationalSummary,
  buildDelivrixMvpDemoRunReport,
  createId,
  buildOpenClawLiveCanvas,
  buildOpenClawIncidentDemoReport,
  buildOpenClawLearningPlan,
  buildMvpFinalDemoReport,
  buildOpenClawEvidence,
  buildOpenClawOnboardingState,
  buildOpenClawProvisioningState,
  buildOpenClawReadinessSignals,
  buildOpenClawSkillsAudit,
  buildWebdockInventoryContract,
  evaluateWebdockDrift,
  buildPhysicalHostSnapshot,
  evaluateSenderNodeHealth,
  evaluateIpReputation,
  evaluateKillSwitch,
  evaluateSenderNodeManualControl,
  evaluateSenderNodeRetirementApproval,
  evaluateSendResultIngestion,
  evaluateOpenClawOnboarding,
  evaluateOperatingActionGate,
  ingestManualCollectorSnapshot,
  isSenderNodeManualAction,
  buildDelivrixMvpDemoBlueprint,
  buildNfcBridgeCapacityPlan,
  buildOpenClawOperationalRunbook,
  buildOpenClawProvisioningDryRun,
  runOpenClawScheduler,
  buildOpenClawTopologyPlan,
  buildSupervisedCollectorPlan,
  executePauseIpRunbook,
  executeQuarantineRunbook,
  executeRegisterSenderNodeRunbook,
  executeWarmingStepRunbook,
  getOpenClawOnboardingQuestionnaire,
  getOperatingNorthSnapshot,
  revertRunbook,
  requestRateLimitRules,
  senderNodeRateLimitRule,
  simulateBackup,
  simulateSendResult,
  type AuditEvent,
  type AuditEventInput,
  type BackupPlanInput,
  type BackupResource,
  type BackupResourceSnapshot,
  type CanvasLiveArtifactSnapshot,
  type IpReputationExternalSignal,
  type DelivrixMvpDemoBlueprintInput,
  type OpenClawOnboardingInput,
  type OpenClawCanvasPromptCard,
  type OpenClawProvisioningDryRunInput,
  type OpenClawRunbookInput,
  type OpenClawSchedulerInput,
  type OpenClawTopologyPlannerInput,
  type QuarantineRevertTargetStatus,
  type RegisterSenderNodeInput,
  type RunbookContext,
  type RunbookId,
  type SuppressionReason,
  type SendRequest,
  type SenderNodeManualAction,
  type SendResultStatus,
  type StuckJobRecoveryAction
} from "../../../packages/domain/src/index.ts";
import {
  InvalidAuditEventError,
  LocalFileAuditLog,
  LocalFileBackupSimulationStore,
  LocalFileIpReputationReportStore,
  LocalFileKillSwitchStore,
  LocalFileProvisioningRunStore,
  LocalFileRateLimitStore,
  LocalFileRunbookExecutionStore,
  LocalFileSendResultStore,
  LocalFileSenderNodeStore,
  LocalFileSuppressionList
} from "../../../packages/local-store/src/index.ts";
import { LocalFileSendQueue } from "../../../packages/queue/src/index.ts";
import {
  cleanupApprovalNonces,
  issueApprovalToken,
  listApprovalNoncesForTarget,
  reconstructApprovalToken,
  validateApprovalToken
} from "./security/approval-token.ts";
import {
  resolveBusinessHoursQuorum,
  resolveGatewayNow,
  type QuorumResolution
} from "./security/business-hours.ts";
import {
  operatorIdFromHeaders,
  validateGatewayMutationHmac
} from "./security/gateway-mutation-auth.ts";
import { validateOpenClawHmac } from "./security/hmac.ts";
import { validateRunbookExecuteAuthorization } from "./security/runbook-authorization.ts";
import {
  consumeRollbackSnapshot,
  getRollbackSnapshot,
  listRollbackSnapshots,
  persistRollbackSnapshot
} from "./security/rollback-snapshot.ts";
import { computeAuditHash, GENESIS_PREV_HASH } from "./audit/hash-chain.ts";
import { SafetyRealtimeCache } from "./safety-realtime-cache.ts";
import {
  handleChatInterruptHttp,
  handleChatSendHttp,
  OpenClawChatProxy,
  type ChatInterruptRequest,
  type ChatSendRequest
} from "./openclaw-chat.ts";
import { createRuntimeEnvReloader } from "./runtime-env.ts";
import {
  checkGatewayDependencies,
  defaultPostgresUrl,
  dependencyStatus,
  type GatewayDependencyHealth
} from "./dependency-health.ts";
import { maybeHandleOpenClawDomainChatSkill } from "./openclaw-domain-chat-skill.ts";
import { createOpenClawBedrockBridgeFromEnv } from "./openclaw-bedrock-bridge.ts";
import { createOpenClawSshBridgeFromEnv } from "./openclaw-ssh-bridge.ts";
import {
  handleAwsDomainDiscoveryError,
  handleAwsDomainDiscoveryHttp
} from "./routes/aws-domain-discovery.ts";
import {
  handleDomainAvailabilityHttp,
  handleDomainDiscoverError,
  handleDomainPricesHttp,
  handleDomainSuggestionsHttp,
  handleOwnedDomainsHttp
} from "./routes/domains.ts";
import {
  handleRoute53DomainPurchaseError,
  handleRoute53DomainRegisterHttp
} from "./routes/domains-purchase.ts";
import {
  handleRoute53DnsError,
  handleRoute53HostedZoneDeleteHttp,
  handleRoute53DnsUpsertHttp
} from "./routes/domains-dns.ts";
import { handleReadRoute53DomainDetail } from "./routes/route53-domain-detail.ts";
import { handleReadRoute53ZoneRecords } from "./routes/route53-zone-records.ts";
import {
  handleIonosDnsUpsertError,
  handleIonosDnsUpsertHttp
} from "./routes/dns-ionos-upsert.ts";
import {
  handleEmailAuthConfigureHttp,
  handleEmailAuthError
} from "./routes/domains-email-auth.ts";
import {
  handleDomainBindError,
  handleDomainBindHttp
} from "./routes/domains-bind.ts";
import {
  createAuditApprovalGuard,
  handleWaitForDnsPropagationHttp,
  handleWaitForDnsPropagationReadOnlyHttp
} from "./routes/dns-wait.ts";
import {
  handleWebdockServerCreateError,
  handleWebdockServerCreateHttp,
  handleWebdockServerDeleteError,
  handleWebdockServerDeleteHttp
} from "./routes/webdock-servers.ts";
import {
  createBindWebdockMainDomainApprovalGuard,
  handleBindWebdockMainDomain,
  handleBindWebdockMainDomainError
} from "./routes/webdock-bind-domain.ts";
import {
  createSmtpSshRunnerFromEnv,
  handleSmtpProvisionError,
  handleSmtpProvisionHttp
} from "./routes/smtp-provisioning.ts";
import {
  handleWarmupStartError,
  handleWarmupStartHttp
} from "./routes/warmup.ts";
import { handleSendRealEmailHttp } from "./routes/send-email.ts";
import {
  handleRampGetByDomainHttp,
  handleRampGetHttp,
  handleRampPauseHttp,
  handleRampResumeHttp,
  handleRampStartHttp,
  handleWarmupRampError,
  RampScheduler,
  resumeRampsOnBoot
} from "./routes/warmup-ramp.ts";
import {
  createGmailImapAdapterFromEnv,
  handlePlacementCheckError,
  handlePlacementCheckHttp
} from "./routes/placement-check.ts";
import { handleSenderPoolStatusHttp } from "./routes/sender-pool-status.ts";
import {
  createGatewayOnboardDomainFlowRunner,
  handleOnboardBatchHttp,
  handleOnboardFlowError,
  handleOnboardSenderDomainHttp
} from "./routes/onboard-flow.ts";
import {
  handleDomainCompareError,
  handleDomainCompareHttp
} from "./routes/domains-compare.ts";
import {
  createDomainAvailabilityCheck,
  handleSuggestSafeDomainHttp
} from "./routes/domains-suggest.ts";
import {
  handleCanvasLiveError,
  handleCanvasLiveEventIngestHttp,
  handleCanvasLiveStateHttp,
  routeCanvasArtifactMutation
} from "./routes/canvas-live.ts";
import {
  handlePorkbunDomainAvailabilityHttp,
  handlePorkbunDomainDiscoverError,
  handlePorkbunDomainPricesHttp,
  handlePorkbunDomainSuggestionsHttp,
  handlePorkbunOwnedDomainsHttp,
  handlePorkbunPingHttp
} from "./routes/domains-porkbun.ts";
import { handleInfrastructureInventoryHttp } from "./routes/infrastructure.ts";
import {
  handleOpenClawWorkspaceError,
  handleOpenClawWorkspaceFileHttp,
  handleOpenClawWorkspaceTreeHttp,
  WorkspaceReadRateLimiter
} from "./routes/openclaw-workspace.ts";
import { CanvasLiveEventService } from "./services/canvas-live-events.ts";
import { GatewayLogStreamService } from "./gateway-log-stream.ts";
import {
  createGatewayRuntimeLogger,
  runtimeErrorMetadata
} from "./gateway-runtime-log.ts";
import { installGatewayProcessGuards } from "./gateway-process-guards.ts";
import {
  positiveIntegerOrDefault,
  readRequestBody,
  RequestBodyTooLargeError,
  defaultMaxRequestBodyBytes
} from "./request-body.ts";
import { shouldAuditWebdockInventoryPoll } from "./webdock-inventory-audit.ts";
import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import { createAuditChainStoreFromEnv } from "./audit-chain.ts";
import { createAutoRollbackManagerFromEnv } from "./auto-rollback.ts";
import { EquipoWebhookBroadcaster } from "./webhook-broadcast.ts";
import { buildAuditChainAnchor, AuditChainAnchorError } from "./audit-chain-anchor.ts";
import { hardenIncomingAuditBatchEvent } from "./audit-batch-origin.ts";
import { classifyLiveActionMutation } from "./live-action-kill-switch.ts";
import { createSkillDispatcher } from "./skill-dispatcher.ts";
import { createHttpToolUseProcessor } from "./tool-use-processor.ts";
import { routeGatewayWebSocketUpgrade } from "./gateway-upgrade-router.ts";
import { handleProposalSign } from "./routes/proposals-sign.ts";
import { handleProposalReject } from "./routes/proposals-reject.ts";
import {
  handleConfigureCompleteSmtp,
  type ApprovalStepDecision
} from "./routes/orchestrator-smtp.ts";
import { handleReadEpisodicScratchHttp } from "./routes/episodic-scratch.ts";
import {
  compactIntent,
  handleCompactIntentHttp
} from "./routes/openclaw-compact-intent.ts";
import { startEpisodicScratchTtlJob } from "./episodic-scratch-ttl.ts";
import {
  canonicalSkillSlug,
  hashSkillExecutionContext,
  validateSkillActionBinding
} from "./skill-contracts.ts";

const port = Number(process.env.GATEWAY_PORT ?? 3000);
const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
const gatewayRuntimeLog = createGatewayRuntimeLogger();
installGatewayProcessGuards(gatewayRuntimeLog);
const gatewayMaxRequestBodyBytes = positiveIntegerOrDefault(
  process.env.GATEWAY_MAX_REQUEST_BODY_BYTES,
  defaultMaxRequestBodyBytes
);
const runtimeEnvReloader = createRuntimeEnvReloader({
  env: process.env,
  envFilePath: ".env.local",
  onError: (error) => {
    void gatewayRuntimeLog.warn("gateway.env_reload_failed", "Runtime env reload failed.", runtimeErrorMetadata(error));
  }
});
runtimeEnvReloader.start();

const auditLog = new LocalFileAuditLog();
const auditChainStore = createAuditChainStoreFromEnv();
const killSwitchStore = new LocalFileKillSwitchStore();
const autoRollbackManager = createAutoRollbackManagerFromEnv();
const sendResultStore = new LocalFileSendResultStore();
const suppressionList = new LocalFileSuppressionList();
const sendQueue = new LocalFileSendQueue();
const policyEngine = new MailPolicyEngine(suppressionList);
const senderNodeRegistry = new SenderNodeRegistry(new LocalFileSenderNodeStore());
const rateLimitStore = new LocalFileRateLimitStore();
const rateLimitService = new RateLimitService(rateLimitStore);
const webdockAdapter = new WebdockAdapter();
const webdockRealAdapter = new WebdockRealAdapter();
const webdockOpsAdapter = new WebdockRealAdapter({
  readApiKey: process.env.WEBDOCK_API_KEY_PRIMARY,
  writeApiKey: process.env.WEBDOCK_API_KEY_OPS,
  accountId: "ops",
  accountLabel: process.env.WEBDOCK_ACCOUNT_OPS_LABEL ?? "Webdock Ops",
  cacheTtlMs: 0
});
const webdockAccountAdapters = createWebdockAdaptersFromEnv();
const awsRoute53DomainsAdapter = new AwsRoute53DomainsAdapter();
const awsRoute53DnsAdapter = new AwsRoute53DnsAdapter();
const ionosDnsAdapter = new IonosDnsActuator();
const ionosDomainsAdapter = new IonosDomainsAdapter();
const porkbunAdapter = new PorkbunAdapter();
const proxmoxAdapter = new ProxmoxAdapter();
const provisioningRunStore = new LocalFileProvisioningRunStore();
const ipReputationReportStore = new LocalFileIpReputationReportStore();
const backupSimulationStore = new LocalFileBackupSimulationStore();
const safetyRealtimeCache = new SafetyRealtimeCache();
const learningRealtimeCache = new SafetyRealtimeCache();
const openClawBedrockBridge = createOpenClawBedrockBridgeFromEnv(process.env, {
  logger: gatewayRuntimeLog,
  auditLog
});
const openClawSshBridge = openClawBedrockBridge ? null : createOpenClawSshBridgeFromEnv();
const openClawChatBridge = openClawBedrockBridge ?? openClawSshBridge;
const canvasLiveEvents = new CanvasLiveEventService();
const episodicScratchPool = new Pool({
  connectionString: process.env.POSTGRES_URL ?? defaultPostgresUrl,
  application_name: "delivrix-openclaw-episodic-scratch"
});
const gatewayLogStream = new GatewayLogStreamService({ logPath: gatewayRuntimeLog.logPath });
const equipoWebhookBroadcaster = new EquipoWebhookBroadcaster({
  killSwitchProvider: async () => (await killSwitchStore.get()).enabled
});
const openClawWorkspace = new OpenClawWorkspace();
const workspaceReadRateLimiter = new WorkspaceReadRateLimiter();
const smtpSshRunner = createSmtpSshRunnerFromEnv();
const gmailImapAdapter = createGmailImapAdapterFromEnv(process.env);
const rampScheduler = new RampScheduler({
  auditLog,
  sshRunner: smtpSshRunner,
  workspace: openClawWorkspace,
  canvasLiveEvents,
  readCanvasState: () => canvasLiveEvents.snapshot(),
  env: process.env,
  autoRollbackManager,
  webhookBroadcaster: equipoWebhookBroadcaster
});
const gatewaySelfBaseUrl = process.env.DELIVRIX_GATEWAY_INTERNAL_BASE_URL ?? `http://${host}:${port}`;
const sensitiveReadBoundaryToken = process.env.DELIVRIX_READ_BOUNDARY_TOKEN ?? process.env.DELIVRIX_OPENCLAW_TOKEN;
const configureSmtpToolProcessor = createHttpToolUseProcessor({
  delivrixBaseUrl: gatewaySelfBaseUrl,
  env: process.env,
  readBoundaryToken: sensitiveReadBoundaryToken,
  pollIntervalMs: Number(process.env.OPENCLAW_CONFIGURE_SMTP_POLL_INTERVAL_MS ?? 1_000),
  logger: gatewayRuntimeLog
});
const configureSmtpRuntimeDeps = {
  invokeSkill: async (input: {
    runId: string;
    step: number;
    skill: string;
    params: Record<string, unknown>;
  }) => {
    if (input.skill === "suggest_safe_domain") {
      const response = await fetch(`${gatewaySelfBaseUrl}/v1/skills/suggest-safe-domain`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(input.params)
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(`suggest_safe_domain failed with HTTP ${response.status}`);
      }
      return body;
    }

    if (input.skill === "wait_server_running" || input.skill === "wait_warmup_initial") {
      return {
        ok: true,
        status: "observed_or_deferred",
        skill: input.skill,
        params: input.params
      };
    }

    throw new Error(`unsupported_read_only_orchestrator_step:${input.skill}`);
  },
  submitAndAwaitApproval: async (input: {
    runId: string;
    step: number;
    skill: string;
    params: Record<string, unknown>;
    actorId: string;
    approvalTimeoutMs: number;
    estimatedCostUsd?: number;
  }): Promise<ApprovalStepDecision> => {
    const result = await configureSmtpToolProcessor({
      toolUseId: `configure-complete-smtp:${input.runId}:${input.step}`,
      toolName: input.skill,
      toolInput: input.params,
      chatSession: { id: `configure-complete-smtp:${input.runId}`, msgId: `step-${input.step}` },
      timeoutMs: input.approvalTimeoutMs
    });

    if (result.ok) {
      return {
        status: "executed" as const,
        proposalId: result.proposalId,
        signatureId: result.signatureId,
        outcome: result.result,
        durationMs: result.durationMs ?? 0,
        statusCode: result.statusCode
      };
    }

    if (result.error === "rejected_by_operator") {
      return {
        status: "rejected" as const,
        proposalId: result.proposalId ?? `unknown-step-${input.step}`,
        reason: result.reason
      };
    }

    if (result.error === "approval_timeout" || result.error === "execution_timeout") {
      const timeoutStatus = result.error === "execution_timeout" ? "execution_timeout" : "approval_timeout";
      return {
        status: timeoutStatus,
        proposalId: result.proposalId ?? `unknown-step-${input.step}`,
        timeoutMs: result.timeoutMs ?? input.approvalTimeoutMs
      };
    }

    return {
      status: "execution_failed" as const,
      proposalId: result.proposalId ?? `unknown-step-${input.step}`,
      outcome: result.details ?? { error: result.error },
      durationMs: 0,
      statusCode: result.statusCode,
      error: result.error
    };
  },
  submitRollbackProposal: async (input: {
    runId: string;
    failedStep: number;
    skill: "delete_webdock_server";
    params: Record<string, unknown>;
    actorId: string;
    reason: string;
  }) => {
    await auditLog.append({
      actorType: "openclaw",
      actorId: "configure_complete_smtp",
      action: "oc.rollback.proposal_requested",
      targetType: "webdock_server",
      targetId: typeof input.params.serverSlug === "string" ? input.params.serverSlug : input.runId,
      riskLevel: "critical",
      decision: "n/a",
      metadata: {
        runId: input.runId,
        failedStep: input.failedStep,
        skill: input.skill,
        reason: input.reason
      }
    });
    return { proposalId: `rollback-requested-${input.runId}-${input.failedStep}` };
  },
  compactIntent: async (input: {
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
      toolUseId?: string;
      toolCallId?: string;
      auditEventId?: string;
    }>;
  }) => compactIntent(input, {
    pool: episodicScratchPool,
    auditLog,
    canvasLiveEvents,
    now: () => resolveGatewayNow()
  }),
  verifyAuditChain: () => auditChainStore.verify(),
  logger: gatewayRuntimeLog
};
const skillDispatcher = createSkillDispatcher({
  auditLog,
  workspace: openClawWorkspace,
  readCanvasState: () => canvasLiveEvents.snapshot(),
  domainPurchaseAdapter: awsRoute53DomainsAdapter,
  route53DnsAdapter: awsRoute53DnsAdapter,
  ionosDnsAdapter,
  webdockAdapter: webdockOpsAdapter,
  smtpSshRunner,
  rampScheduler,
  porkbunDomainAdapter: porkbunAdapter,
  canvasLiveEvents,
  autoRollbackManager,
  webhookBroadcaster: equipoWebhookBroadcaster,
  readKillSwitch: () => killSwitchStore.get(),
  configureSmtpDeps: configureSmtpRuntimeDeps,
  env: process.env
});
const onboardDomainFlowRunner = createGatewayOnboardDomainFlowRunner({
  auditLog,
  workspace: openClawWorkspace,
  canvasLiveEvents,
  domainPurchaseAdapter: awsRoute53DomainsAdapter,
  dnsAdapter: awsRoute53DnsAdapter,
  webdockAdapter: webdockOpsAdapter,
  sshRunner: smtpSshRunner,
  readCanvasState: () => canvasLiveEvents.snapshot(),
  env: process.env
});
const openClawChatProxy = new OpenClawChatProxy(auditLog, {
  bridgeKind: openClawBedrockBridge ? "bedrock" : openClawSshBridge ? "ssh" : "http",
  sshBridge: openClawChatBridge,
  localFallbackEnabled: process.env.OPENCLAW_CHAT_LOCAL_FALLBACK !== "0",
  canvasLiveEvents
});
const defaultStuckJobThresholdMs = Number(process.env.STUCK_JOB_THRESHOLD_MS ?? 5 * 60 * 1000);
const requestRateLimitProfile = {
  campaignDailyLimit: Number(process.env.RATE_LIMIT_CAMPAIGN_DAILY ?? 100),
  senderDomainDailyLimit: Number(process.env.RATE_LIMIT_SENDER_DOMAIN_DAILY ?? 300),
  recipientDomainDailyLimit: Number(process.env.RATE_LIMIT_RECIPIENT_DOMAIN_DAILY ?? 100)
};

interface AgentProposal {
  id: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  headline: string;
  body: string;
  evidenceRefs: string[];
  runbookRef: string;
  targetRef: string;
  targetType?: string;
  skillSlug?: string;
  params?: unknown;
  proposalHash?: string;
  artifactSnapshot?: CanvasLiveArtifactSnapshot;
  delivrix_actions_required: string[];
}

interface AgentProposalRequest {
  proposal?: Partial<AgentProposal>;
  audit?: {
    skillSlug?: string;
    modelVersion?: string;
    promptVersion?: string;
    tokensUsed?: number;
  };
  schemaVersion?: string;
}

interface AuditBatchRequest {
  batchId?: string;
  events?: Array<Record<string, unknown> & {
    id?: string;
    prevHash?: string;
    hash?: string;
  }>;
}

interface RunbookExecuteRequest {
  proposalId?: string;
  runbookId?: string;
  input?: unknown;
}

interface RunbookRevertRequest {
  rollbackToken?: string;
  reason?: string;
  metadata?: {
    targetStatus?: string;
  };
}

interface StoredProposal extends AgentProposal {
  receivedAt: string;
  expiresAt: string;
  status: "pending" | "resolved" | "expired" | "signed" | "rejected" | "executing" | "executed" | "execution_failed";
  requiresApproval: boolean;
  requiredApprovals: number;
  signedAt?: string;
  signatureId?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  executionOutcome?: unknown;
  executionStatusCode?: number;
  executionDurationMs?: number;
  executionCompletedAt?: string;
  resolution?: {
    decision: "allow" | "reject";
    resolvedAt: string;
    approverIds?: string[];
  };
  quorumResolution?: (QuorumResolution | { requiredApprovals: number; mode: "static" });
  execution?: {
    executedAt: string;
    runbookId: RunbookId;
    rollbackToken: string;
    rollbackExpiresAt: string;
    newState: unknown;
  };
}

type AgentPermissionCategory =
  | "allowed_read_only"
  | "allowed_dry_run"
  | "supervised_local_state"
  | "future_live_requires_new_phase"
  | "prohibited";

type AgentPermissionRejectReason =
  | "unknown_action"
  | "prohibited_action"
  | "live_blocked_hito_5_11_b"
  | "human_approval_missing"
  | "kill_switch_armed"
  | "schema_mismatch";

interface AgentPermissionEntry {
  actionId: string;
  category: AgentPermissionCategory;
}

const proposalsStore: StoredProposal[] = [];
const runbookExecutionStore = new LocalFileRunbookExecutionStore();
const proposalTtlMs = 60 * 60 * 1000;
const agentPermissionMatrix: AgentPermissionEntry[] = [
  permission("read_health", "allowed_read_only"),
  permission("read_admin_clusters", "allowed_read_only"),
  permission("read_admin_overview", "allowed_read_only"),
  permission("read_admin_workflow", "allowed_read_only"),
  permission("read_collector_snapshot_ingestion", "allowed_read_only"),
  permission("read_collector_status", "allowed_read_only"),
  permission("read_collector_supervised_plan", "allowed_read_only"),
  permission("read_hardware_physical_host", "allowed_read_only"),
  permission("read_hardware_telemetry_history", "allowed_read_only"),
  permission("read_hardware_telemetry_latest", "allowed_read_only"),
  permission("read_openclaw_learning_plan", "allowed_read_only"),
  permission("read_openclaw_live_canvas", "allowed_read_only"),
  permission("read_openclaw_onboarding_state", "allowed_read_only"),
  permission("read_openclaw_provisioning_state", "allowed_read_only"),
  permission("read_openclaw_readiness_signals", "allowed_read_only"),
  permission("read_openclaw_workspace_tree", "allowed_read_only"),
  permission("read_openclaw_workspace_file", "allowed_read_only"),
  permission("read_operating_north", "allowed_read_only"),
  permission("read_kill_switch", "allowed_read_only"),
  permission("read_audit_events", "allowed_read_only"),
  permission("read_sender_nodes", "allowed_read_only"),
  permission("read_ip_reputation_reports", "allowed_read_only"),
  permission("read_send_results", "allowed_read_only"),
  permission("read_stuck_jobs", "allowed_read_only"),
  permission("read_operational_summary", "allowed_read_only"),
  permission("read_iam_roles", "allowed_read_only"),
  permission("read_iam_sessions", "allowed_read_only"),
  permission("read_compliance_status", "allowed_read_only"),
  permission("read_openclaw_skills_audit", "allowed_read_only"),
  permission("read_openclaw_evidence", "allowed_read_only"),
  permission("read_webdock_inventory", "allowed_read_only"),
  permission("read_webdock_servers", "allowed_read_only"),
  permission("read_episodic_scratch", "allowed_read_only"),
  permission("openclaw_memory_read", "allowed_read_only"),
  permission("read_route53_domain_detail", "allowed_read_only"),
  permission("read_route53_zone_records", "allowed_read_only"),
  permission("suggest_safe_domain", "allowed_read_only"),
  permission("naming_suggest", "allowed_read_only"),
  permission("propose_warming_step", "allowed_dry_run"),
  permission("propose_pause_ip", "allowed_dry_run"),
  permission("propose_rotate_dns", "allowed_dry_run"),
  permission("propose_register_sender_node", "allowed_dry_run"),
  permission("propose_quarantine", "allowed_dry_run"),
  permission("propose_postfix_config", "allowed_dry_run"),
  permission("propose_topology_plan", "allowed_dry_run"),
  permission("propose_provisioning_plan", "allowed_dry_run"),
  permission("generate_daily_report", "allowed_dry_run"),
  permission("evaluate_webdock_drift", "allowed_dry_run"),
  permission("register_sender_node_local", "supervised_local_state"),
  permission("update_sender_node_metadata", "supervised_local_state"),
  permission("mark_evidence_curated", "supervised_local_state"),
  permission("snooze_proposal", "supervised_local_state"),
  permission("record_human_decision", "supervised_local_state"),
  permission("register_domain_route53", "supervised_local_state"),
  permission("upsert_dns_route53", "supervised_local_state"),
  permission("route53_dns_upsert", "supervised_local_state"),
  permission("upsert_dns_ionos", "supervised_local_state"),
  permission("ionos_dns_upsert", "supervised_local_state"),
  permission("create_webdock_server", "supervised_local_state"),
  permission("provision_webdock_vps", "supervised_local_state"),
  permission("bind_webdock_main_domain", "supervised_local_state"),
  permission("webdock_main_domain_bind", "supervised_local_state"),
  permission("provision_smtp_postfix", "supervised_local_state"),
  permission("install_smtp_stack", "supervised_local_state"),
  permission("configure_email_auth", "supervised_local_state"),
  permission("bind_domain_to_server", "supervised_local_state"),
  permission("wait_for_dns_propagation", "supervised_local_state"),
  permission("dns_propagation_wait", "supervised_local_state"),
  permission("seed_warmup_pool", "supervised_local_state"),
  permission("start_warmup_seed", "supervised_local_state"),
  permission("start_warmup_ramp", "supervised_local_state"),
  permission("warmup_ramp_scheduler", "supervised_local_state"),
  permission("send_real_email", "supervised_local_state"),
  permission("smtp_send_real", "supervised_local_state"),
  permission("smtp_send_real_email", "supervised_local_state"),
  permission("compact_intent", "allowed_dry_run"),
  permission("openclaw_memory_compact", "allowed_dry_run"),
  permission("configure_complete_smtp", "supervised_local_state"),
  permission("configure_smtp_complete", "supervised_local_state"),
  permission("proxmox_live_create_vps", "future_live_requires_new_phase"),
  permission("proxmox_live_destroy_vps", "future_live_requires_new_phase"),
  permission("webdock_create_server", "future_live_requires_new_phase"),
  permission("webdock_destroy_server", "future_live_requires_new_phase"),
  permission("webdock_snapshot_restore", "future_live_requires_new_phase"),
  permission("dns_live_change", "future_live_requires_new_phase"),
  permission("dns_record_delete", "future_live_requires_new_phase"),
  permission("postfix_apply_live_config", "future_live_requires_new_phase"),
  permission("tls_cert_renew_live", "future_live_requires_new_phase"),
  permission("ssh_root_access", "future_live_requires_new_phase"),
  permission("ssh_exec_command", "future_live_requires_new_phase"),
  permission("smtp_send_to_unconfirmed_recipient", "prohibited"),
  permission("nfc_production_write", "prohibited"),
  permission("nfc_activate_bridge", "prohibited"),
  permission("ip_rotation_to_sustain_volume_after_reputation_event", "prohibited"),
  permission("plaintext_smtp_credentials_in_production", "prohibited"),
  permission("write_secrets_to_repo", "prohibited"),
  permission("bypass_kill_switch", "prohibited"),
  permission("export_pii_outside_audit", "prohibited"),
  permission("auto_self_promote_ml_model", "prohibited"),
  permission("purge_remote_queue", "prohibited")
];
const agentPermissionByAction = new Map(
  agentPermissionMatrix.map((entry) => [entry.actionId, entry])
);

setInterval(() => cleanupApprovalNonces(), 60_000).unref();

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      await runtimeEnvReloader.refreshNow();
      const killSwitch = await killSwitchStore.get();
      const operatingNorth = getOperatingNorthSnapshot();
      const dependencies = await checkGatewayDependencies();
      const runtimeFlags = runtimeEnvReloader.snapshot();

      return json(response, 200, {
        status: "ok",
        service: "gateway-api",
        postgres: dependencyStatus(dependencies.postgres),
        redis: dependencyStatus(dependencies.redis),
        dependencies,
        role: "delivrix-control-plane",
        queue: "local-file",
        auditLog: "local-file",
        suppressionList: "local-file",
        senderNodes: "local-file",
        rateLimits: "local-file",
        provisioningRuns: "local-file",
        ipReputationReports: "local-file",
        backupSimulations: "local-file",
        runtimeFlags,
        killSwitch: {
          enabled: killSwitch.enabled,
          updatedAt: killSwitch.updatedAt,
          updatedBy: killSwitch.updatedBy
        },
        operatingNorth: {
          sourceOfTruth: operatingNorth.sourceOfTruth,
          delivrixSendsRealEmail: operatingNorth.delivrixSendsRealEmail,
          nfcSendsRealEmail: operatingNorth.nfcSendsRealEmail,
          nfcProductionWritesEnabled: operatingNorth.nfcProductionWritesEnabled,
          liveInfrastructureWritesEnabled: operatingNorth.liveInfrastructureWritesEnabled
        },
        openClaw: {
          currentMilestone: "5.9-manual-snapshot-ingestion-ux",
          adminClusterOverviewEnabled: true,
          learningPlanEnabled: true,
          physicalHostContractEnabled: true,
          hardwareTelemetryContractEnabled: true,
          liveCanvasContractEnabled: true,
          onboardingStateContractEnabled: true,
          provisioningStateContractEnabled: true,
          readinessSignalsEnabled: true,
          devOpsCollectorStatusEnabled: true,
          supervisedCollectorPlanEnabled: true,
          manualSnapshotIngestionContractEnabled: true,
          manualSnapshotIngestionEnabled: true,
          onboardingEnabled: true,
          topologyPlannerEnabled: true,
          provisioningDryRunEnabled: true,
          schedulerEnabled: true,
          runbookEnabled: true,
          demoBlueprintEnabled: true,
          demoRunnerEnabled: true,
          incidentDemoEnabled: true,
          finalDemoReportEnabled: true,
          killSwitchProofEnabled: true,
          llmLiveCallsEnabled: false,
          liveActionsEnabled: false
        },
        nfcBridge: {
          mode: "mock",
          liveWritesEnabled: false,
          providersActivatedByDefault: false
        },
        phase: operatingNorth.phase
      });
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/chat/send") {
      await runtimeEnvReloader.refreshNow();
      const body = await readJson<ChatSendRequest>(request);
      const chatMsgId = typeof body.msgId === "string" ? body.msgId : null;
      const chatMessage = typeof body.message === "string"
        ? body.message
        : typeof body.text === "string"
          ? body.text
          : "";
      void gatewayRuntimeLog.info("openclaw.chat.received", "Operator message received by gateway.", {
        msgId: chatMsgId,
        messageChars: chatMessage.length,
        bridgeKind: openClawBedrockBridge ? "bedrock" : openClawSshBridge ? "ssh" : "http"
      });
      const gatewaySkillResult = await maybeHandleOpenClawDomainChatSkill({
        body,
        chatProxy: openClawChatProxy,
        canvasLiveEvents,
        auditLog,
        ionosDomains: ionosDomainsAdapter,
        ionosDns: ionosDnsAdapter
      });
      if (gatewaySkillResult) {
        void gatewayRuntimeLog.info("openclaw.chat.handled_by_gateway_skill", "Gateway handled chat locally without Bedrock.", {
          msgId: gatewaySkillResult.msgId,
          source: gatewaySkillResult.assistant?.source,
          skillsInvoked: gatewaySkillResult.assistant?.skillsInvoked
        });
        return json(response, 200, gatewaySkillResult);
      }
      void gatewayRuntimeLog.info("openclaw.chat.forwarded_to_bridge", "Chat forwarded to OpenClaw bridge.", {
        msgId: chatMsgId,
        bridgeKind: openClawBedrockBridge ? "bedrock" : openClawSshBridge ? "ssh" : "http"
      });
      return handleChatSendHttp(openClawChatProxy, body, response, gatewayRuntimeLog);
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/chat/interrupt") {
      const body = await readJson<ChatInterruptRequest>(request);
      return handleChatInterruptHttp(openClawChatProxy, body, response, gatewayRuntimeLog);
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/canvas/live/state")) {
      return handleCanvasLiveStateHttp({
        request,
        response,
        service: canvasLiveEvents,
        auditLog
      });
    }

    if (request.method === "POST" && request.url === "/v1/canvas/live/events") {
      try {
        return await handleCanvasLiveEventIngestHttp({
          request,
          response,
          service: canvasLiveEvents,
          auditLog
        });
      } catch (error) {
        if (handleCanvasLiveError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.url?.startsWith("/v1/canvas/artifact/")) {
      try {
        const routed = routeCanvasArtifactMutation({
          request,
          response,
          service: canvasLiveEvents,
          auditLog
        });
        if (routed) {
          return await routed;
        }
      } catch (error) {
        if (handleCanvasLiveError(error, response)) {
          return;
        }
        throw error;
      }
    }

    const liveActionMutation = classifyLiveActionMutation(
      request.method,
      requestUrl(request).pathname
    );
    if (liveActionMutation) {
      const killSwitchDecision = evaluateKillSwitch(
        await killSwitchStore.get(),
        liveActionMutation.operation
      );
      if (!killSwitchDecision.allowed) {
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "oc.live_action.blocked_by_kill_switch",
          targetType: liveActionMutation.targetType,
          targetId: liveActionMutation.targetId,
          riskLevel: "critical",
          decision: "reject",
          rejectReason: "kill_switch_armed",
          humanApproved: false,
          killSwitchState: "active",
          metadata: {
            method: liveActionMutation.method,
            path: liveActionMutation.path,
            operation: liveActionMutation.operation,
            message: killSwitchDecision.message
          }
        });
        return json(response, 423, {
          ok: false,
          rejectReason: "kill_switch_armed",
          message: killSwitchDecision.message,
          operation: liveActionMutation.operation,
          killSwitch: killSwitchDecision.state
        });
      }
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/openclaw/workspace/tree")) {
      try {
        return await handleOpenClawWorkspaceTreeHttp({
          request,
          response,
          auditLog,
          rootDir: openClawWorkspace.getRootDir(),
          rateLimiter: workspaceReadRateLimiter
        });
      } catch (error) {
        if (handleOpenClawWorkspaceError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/openclaw/workspace/file")) {
      try {
        return await handleOpenClawWorkspaceFileHttp({
          request,
          response,
          auditLog,
          rootDir: openClawWorkspace.getRootDir(),
          rateLimiter: workspaceReadRateLimiter
        });
      } catch (error) {
        if (handleOpenClawWorkspaceError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "GET" && request.url === "/v1/operating-north") {
      return json(response, 200, getOperatingNorthSnapshot());
    }

    if (request.method === "GET" && request.url === "/v1/iam/roles") {
      const payload = await safetyRealtimeCache.resolve(
        "/v1/iam/roles",
        async (now) => buildIamRoles({
          auditEvents: await auditLog.list(),
          now
        }),
        (now) => buildIamRoles({ now })
      );
      return json(response, 200, payload);
    }

    if (request.method === "GET" && request.url === "/v1/iam/sessions") {
      const payload = await safetyRealtimeCache.resolve(
        "/v1/iam/sessions",
        async (now) => buildIamSessions({
          auditEvents: await auditLog.list(),
          now
        }),
        (now) => buildIamSessions({ now })
      );
      return json(response, 200, payload);
    }

    if (request.method === "GET" && request.url === "/v1/compliance/status") {
      const payload = await safetyRealtimeCache.resolve(
        "/v1/compliance/status",
        async (now) => buildLiveComplianceStatus(now),
        (now) => buildComplianceStatus({ now })
      );
      return json(response, 200, payload);
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/skills/audit") {
      const payload = await learningRealtimeCache.resolve(
        "/v1/openclaw/skills/audit",
        async (now) => buildOpenClawSkillsAudit({
          auditEvents: await auditLog.list(),
          now
        }),
        (now) => buildOpenClawSkillsAudit({ now })
      );
      return json(response, 200, payload);
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/evidence") {
      const payload = await learningRealtimeCache.resolve(
        "/v1/openclaw/evidence",
        async (now) => buildOpenClawEvidence({
          auditEvents: await auditLog.list(),
          now
        }),
        (now) => buildOpenClawEvidence({ now })
      );
      return json(response, 200, payload);
    }

    if (request.method === "GET" && request.url === "/v1/webdock/inventory") {
      const result = await webdockRealAdapter.listServers();
      const senderNodes = await senderNodeRegistry.list();
      const drift = evaluateWebdockDrift({
        webdockServers: result.servers,
        senderNodes
      });
      const contract = buildWebdockInventoryContract({
        servers: result.servers,
        source: result.source
      });

      if (shouldAuditWebdockInventoryPoll(request.headers)) {
        await auditLog.append({
          actorType: "openclaw",
          actorId: "delivrix-fleet-ops",
          action: "oc.webdock.inventory_polled",
          targetType: "webdock_inventory",
          targetId: result.source.kind,
          riskLevel: result.source.responseOk ? "low" : "medium",
          metadata: {
            serverCount: contract.summary.total,
            driftProposals: drift.proposals.length,
            sourceKind: result.source.kind,
            responseOk: result.source.responseOk,
            errorMessage: result.source.errorMessage
          }
        });
      }

      return json(response, 200, {
        inventory: contract,
        drift
      });
    }

    if (request.method === "POST" && request.url === "/v1/webdock/servers/create") {
      try {
        await runtimeEnvReloader.refreshNow();
        return await handleWebdockServerCreateHttp({
          request,
          response,
          auditLog,
          adapter: webdockOpsAdapter,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          readCanvasState: () => canvasLiveEvents.snapshot(),
          env: process.env
        });
      } catch (error) {
        if (handleWebdockServerCreateError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && request.url === "/v1/skills/bind-webdock-main-domain") {
      try {
        return await handleBindWebdockMainDomain({
          request,
          response,
          deps: {
            auditLog,
            approvalGuard: createBindWebdockMainDomainApprovalGuard({
              auditLog,
              readCanvasState: () => canvasLiveEvents.snapshot()
            }),
            webdockAdapter: webdockOpsAdapter,
            sshRunner: smtpSshRunner,
            now: () => Date.now()
          }
        });
      } catch (error) {
        if (handleBindWebdockMainDomainError(error, response)) {
          return;
        }
        throw error;
      }
    }

    const webdockDeleteMatch = request.url?.match(/^\/v1\/webdock\/servers\/([^/]+)$/);
    if (request.method === "DELETE" && webdockDeleteMatch) {
      try {
        return await handleWebdockServerDeleteHttp({
          request,
          response,
          auditLog,
          adapter: webdockOpsAdapter,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          readCanvasState: () => canvasLiveEvents.snapshot(),
          serverSlug: decodeURIComponent(webdockDeleteMatch[1]),
          env: process.env
        });
      } catch (error) {
        if (handleWebdockServerDeleteError(error, response)) {
          return;
        }
        throw error;
      }
    }

    const smtpProvisionMatch = request.url?.match(/^\/v1\/servers\/([^/]+)\/provision-smtp$/);
    if (request.method === "POST" && smtpProvisionMatch) {
      try {
        return await handleSmtpProvisionHttp({
          request,
          response,
          serverSlug: smtpProvisionMatch[1],
          auditLog,
          sshRunner: smtpSshRunner,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          readCanvasState: () => canvasLiveEvents.snapshot(),
          env: process.env
        });
      } catch (error) {
        if (handleSmtpProvisionError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && (request.url === "/v1/warmup/start" || request.url === "/v1/warmup/seed")) {
      try {
        return await handleWarmupStartHttp({
          request,
          response,
          auditLog,
          sshRunner: smtpSshRunner,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          readCanvasState: () => canvasLiveEvents.snapshot(),
          env: process.env
        });
      } catch (error) {
        if (handleWarmupStartError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && request.url === "/v1/warmup/ramp/start") {
      try {
        return await handleRampStartHttp({
          request,
          response,
          scheduler: rampScheduler,
          auditLog,
          sshRunner: smtpSshRunner,
          workspace: openClawWorkspace,
          readCanvasState: () => canvasLiveEvents.snapshot(),
          env: process.env
        });
      } catch (error) {
        if (handleWarmupRampError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && request.url === "/v1/skills/send-real-email") {
      return await handleSendRealEmailHttp({
        request,
        response,
        auditLog,
        sshRunner: smtpSshRunner,
        workspace: openClawWorkspace,
        readCanvasState: () => canvasLiveEvents.snapshot(),
        readKillSwitch: () => killSwitchStore.get()
      });
    }

    if (request.method === "POST" && requestUrl(request).pathname === "/v1/openclaw/orchestrator/configure-smtp") {
      return await handleConfigureCompleteSmtp({
        request,
        response,
        auditLog,
        canvasLiveEvents,
        readKillSwitch: () => killSwitchStore.get(),
        env: process.env,
        ...configureSmtpRuntimeDeps
      });
    }

    if (request.method === "GET" && requestUrl(request).pathname === "/v1/openclaw/scratch") {
      return await handleReadEpisodicScratchHttp({
        request,
        response,
        pool: episodicScratchPool,
        readBoundaryToken: process.env.DELIVRIX_READ_BOUNDARY_TOKEN
      });
    }

    if (request.method === "POST" && requestUrl(request).pathname === "/v1/openclaw/compact-intent") {
      return await handleCompactIntentHttp({
        request,
        response,
        pool: episodicScratchPool,
        auditLog,
        canvasLiveEvents,
        allowUnsignedLocal: process.env.OPENCLAW_COMPACT_INTENT_ALLOW_UNSIGNED_LOCAL === "true",
        now: () => resolveGatewayNow()
      });
    }

    {
      const rampPauseMatch = request.method === "POST" && request.url
        ? /^\/v1\/warmup\/ramp\/(ramp-[A-Za-z0-9-]+)\/pause$/.exec(request.url)
        : null;
      if (rampPauseMatch) {
        try {
          return await handleRampPauseHttp({
            request,
            response,
            scheduler: rampScheduler,
            rampId: rampPauseMatch[1]
          });
        } catch (error) {
          if (handleWarmupRampError(error, response)) {
            return;
          }
          throw error;
        }
      }
    }

    {
      const rampResumeMatch = request.method === "POST" && request.url
        ? /^\/v1\/warmup\/ramp\/(ramp-[A-Za-z0-9-]+)\/resume$/.exec(request.url)
        : null;
      if (rampResumeMatch) {
        try {
          return await handleRampResumeHttp({
            request,
            response,
            scheduler: rampScheduler,
            rampId: rampResumeMatch[1]
          });
        } catch (error) {
          if (handleWarmupRampError(error, response)) {
            return;
          }
          throw error;
        }
      }
    }

    {
      const rampGetMatch = request.method === "GET" && request.url
        ? /^\/v1\/warmup\/ramp\/(ramp-[A-Za-z0-9-]+)$/.exec(request.url)
        : null;
      if (rampGetMatch) {
        try {
          return await handleRampGetHttp({
            request,
            response,
            scheduler: rampScheduler,
            rampId: rampGetMatch[1]
          });
        } catch (error) {
          if (handleWarmupRampError(error, response)) {
            return;
          }
          throw error;
        }
      }
    }

    {
      const rampByDomainMatch = request.method === "GET" && request.url
        ? /^\/v1\/warmup\/ramp\/by-domain\/([A-Za-z0-9.-]+)$/.exec(request.url)
        : null;
      if (rampByDomainMatch) {
        try {
          return await handleRampGetByDomainHttp({
            request,
            response,
            scheduler: rampScheduler,
            domain: rampByDomainMatch[1]
          });
        } catch (error) {
          if (handleWarmupRampError(error, response)) {
            return;
          }
          throw error;
        }
      }
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/skills/placement-check") {
      try {
        return await handlePlacementCheckHttp({
          request,
          response,
          auditLog,
          adapter: gmailImapAdapter,
          env: process.env
        });
      } catch (error) {
        if (handlePlacementCheckError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && request.url === "/v1/skills/wait-for-dns-propagation") {
      return await handleWaitForDnsPropagationHttp({
        request,
        response,
        auditLog,
        approvalGuard: createAuditApprovalGuard({
          auditLog,
          readCanvasState: () => canvasLiveEvents.snapshot()
        }),
        readKillSwitch: () => killSwitchStore.get()
      });
    }

    if (request.method === "POST" && request.url === "/v1/skills/wait-for-dns-propagation/read-only") {
      return await handleWaitForDnsPropagationReadOnlyHttp({
        request,
        response,
        auditLog,
        readKillSwitch: () => killSwitchStore.get()
      });
    }

    if (request.method === "POST" && request.url === "/v1/flows/onboard-sender-domain") {
      try {
        return await handleOnboardSenderDomainHttp({
          request,
          response,
          auditLog,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          runner: onboardDomainFlowRunner,
          env: process.env
        });
      } catch (error) {
        if (handleOnboardFlowError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && request.url === "/v1/flows/onboard-batch") {
      try {
        return await handleOnboardBatchHttp({
          request,
          response,
          auditLog,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          runner: onboardDomainFlowRunner,
          env: process.env
        });
      } catch (error) {
        if (handleOnboardFlowError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "GET" && request.url === "/v1/infrastructure/inventory") {
      return handleInfrastructureInventoryHttp({
        request,
        response,
        auditLog,
        webdockListServers: async () =>
          Promise.all(
            webdockAccountAdapters.map(async (account) => ({
              accountId: account.id,
              accountLabel: account.label,
              result: await account.adapter.listServers()
            }))
          ),
        ionosListDnsInventory: () => ionosDnsAdapter.listInventory(),
        ionosListDomainsInventory: () => ionosDomainsAdapter.listInventory(),
        awsRoute53DomainsListInventory: () => awsRoute53DomainsAdapter.listInventory(),
        porkbunListInventory: () => porkbunAdapter.listInventory(),
        env: process.env
      });
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/infrastructure/domain-discovery")) {
      try {
        return await handleAwsDomainDiscoveryHttp({
          request,
          response,
          auditLog,
          discoverDomains: (input) => awsRoute53DomainsAdapter.discoverDomains(input)
        });
      } catch (error) {
        if (handleAwsDomainDiscoveryError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/compare")) {
      try {
        return await handleDomainCompareHttp({
          request,
          response,
          awsAdapter: awsRoute53DomainsAdapter,
          porkbunAdapter
        });
      } catch (error) {
        if (handleDomainCompareError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && request.url === "/v1/skills/suggest-safe-domain") {
      return await handleSuggestSafeDomainHttp({
        request,
        response,
        deps: {
          auditLog,
          route53Availability: createDomainAvailabilityCheck(awsRoute53DomainsAdapter),
          porkbunAvailability: createDomainAvailabilityCheck(porkbunAdapter)
        }
      });
    }

    if (request.method === "POST" && request.url === "/v1/domains/route53/register") {
      try {
        return await handleRoute53DomainRegisterHttp({
          request,
          response,
          auditLog,
          adapter: awsRoute53DomainsAdapter,
          workspace: openClawWorkspace,
          readCanvasState: () => canvasLiveEvents.snapshot(),
          env: process.env
        });
      } catch (error) {
        if (handleRoute53DomainPurchaseError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "GET" && requestUrl(request).pathname === "/v1/route53/domain-detail") {
      return await handleReadRoute53DomainDetail(request, response, {
        canvasLiveEvents,
        emitAudit: appendRoute53ReadAudit,
        now: () => new Date(),
        readBoundaryToken: sensitiveReadBoundaryToken
      });
    }

    if (request.method === "GET" && requestUrl(request).pathname === "/v1/route53/zone-records") {
      return await handleReadRoute53ZoneRecords(request, response, {
        canvasLiveEvents,
        emitAudit: appendRoute53ReadAudit,
        now: () => new Date(),
        readBoundaryToken: sensitiveReadBoundaryToken
      });
    }

    if (request.method === "POST" && request.url === "/v1/domains/route53/dns/upsert") {
      try {
        return await handleRoute53DnsUpsertHttp({
          request,
          response,
          auditLog,
          adapter: awsRoute53DnsAdapter,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          autoRollbackManager,
          webhookBroadcaster: equipoWebhookBroadcaster,
          readCanvasState: () => canvasLiveEvents.snapshot()
        });
      } catch (error) {
        if (handleRoute53DnsError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && request.url === "/v1/dns/ionos/upsert") {
      try {
        return await handleIonosDnsUpsertHttp({
          request,
          response,
          auditLog,
          adapter: ionosDnsAdapter,
          workspace: openClawWorkspace,
          readCanvasState: () => canvasLiveEvents.snapshot(),
          autoRollbackManager,
          webhookBroadcaster: equipoWebhookBroadcaster,
          env: process.env
        });
      } catch (error) {
        if (handleIonosDnsUpsertError(error, response)) {
          return;
        }
        throw error;
      }
    }

    const route53HostedZoneDeleteMatch = request.url?.match(/^\/v1\/domains\/route53\/hosted-zones\/([^/?]+)$/);
    if (request.method === "DELETE" && route53HostedZoneDeleteMatch) {
      try {
        return await handleRoute53HostedZoneDeleteHttp({
          request,
          response,
          auditLog,
          adapter: awsRoute53DnsAdapter,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          readCanvasState: () => canvasLiveEvents.snapshot()
        }, route53HostedZoneDeleteMatch[1]);
      } catch (error) {
        if (handleRoute53DnsError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && request.url === "/v1/domains/auth/configure") {
      try {
        return await handleEmailAuthConfigureHttp({
          request,
          response,
          auditLog,
          dnsAdapter: awsRoute53DnsAdapter,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          readCanvasState: () => canvasLiveEvents.snapshot(),
          env: process.env
        });
      } catch (error) {
        if (handleEmailAuthError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "POST" && request.url === "/v1/domains/bind") {
      try {
        return await handleDomainBindHttp({
          request,
          response,
          auditLog,
          dnsAdapter: awsRoute53DnsAdapter,
          workspace: openClawWorkspace,
          canvasLiveEvents,
          readCanvasState: () => canvasLiveEvents.snapshot(),
          env: process.env
        });
      } catch (error) {
        if (handleDomainBindError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/porkbun/availability")) {
      try {
        return await handlePorkbunDomainAvailabilityHttp({
          request,
          response,
          auditLog,
          adapter: porkbunAdapter
        });
      } catch (error) {
        if (handlePorkbunDomainDiscoverError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/porkbun/suggestions")) {
      return await handlePorkbunDomainSuggestionsHttp({
        request,
        response,
        auditLog,
        adapter: porkbunAdapter
      });
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/porkbun/prices")) {
      return await handlePorkbunDomainPricesHttp({
        request,
        response,
        auditLog,
        adapter: porkbunAdapter
      });
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/porkbun/owned")) {
      return await handlePorkbunOwnedDomainsHttp({
        request,
        response,
        auditLog,
        adapter: porkbunAdapter
      });
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/porkbun/ping")) {
      return await handlePorkbunPingHttp({
        request,
        response,
        auditLog,
        adapter: porkbunAdapter
      });
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/availability")) {
      try {
        return await handleDomainAvailabilityHttp({
          request,
          response,
          auditLog,
          adapter: awsRoute53DomainsAdapter
        });
      } catch (error) {
        if (handleDomainDiscoverError(error, response)) {
          return;
        }
        throw error;
      }
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/suggestions")) {
      return await handleDomainSuggestionsHttp({
        request,
        response,
        auditLog,
        adapter: awsRoute53DomainsAdapter
      });
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/prices")) {
      return await handleDomainPricesHttp({
        request,
        response,
        auditLog,
        adapter: awsRoute53DomainsAdapter
      });
    }

    if (request.method === "GET" && request.url?.startsWith("/v1/domains/owned")) {
      return await handleOwnedDomainsHttp({
        request,
        response,
        auditLog,
        adapter: awsRoute53DomainsAdapter
      });
    }

    if (request.method === "POST" && request.url === "/v1/demo/mvp/blueprint") {
      const body = await readOptionalJson<DelivrixMvpDemoBlueprintInput>(request);
      const killSwitch = await killSwitchStore.get();
      const blueprint = buildDelivrixMvpDemoBlueprint({
        ...body,
        killSwitch: body?.killSwitch ?? killSwitch
      });

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId: blueprint.actorId,
        action: "demo.mvp_blueprint_created",
        targetType: "mvp_demo",
        targetId: blueprint.id,
        riskLevel: blueprint.decision.status === "blocked" ? "high" : blueprint.decision.status === "needs_review" ? "medium" : "low",
        metadata: {
          phase: blueprint.phase,
          decision: blueprint.decision,
          route: blueprint.pipeline.route,
          patternReview: blueprint.patternReview.map((item) => ({
            pattern: item.pattern,
            status: item.status
          })),
          openClaw: {
            onboardingDecision: blueprint.openClaw.onboarding.decision.status,
            topologyDecision: blueprint.openClaw.topology.decision.status,
            provisioningDecision: blueprint.openClaw.provisioning.decision.status,
            schedulerDecision: blueprint.openClaw.scheduler.decision.status,
            runbookDecision: blueprint.openClaw.runbook.decision.status
          },
          dryRun: blueprint.dryRun,
          sideEffects: blueprint.sideEffects,
          liveEmailSendingEnabled: false,
          liveInfrastructureWritesEnabled: false,
          nfcProductionWritesEnabled: false,
          localStateOnlyForPipelineDemo: blueprint.safety.localStateOnlyForPipelineDemo
        }
      });

      return json(response, 200, {
        blueprint
      });
    }

    if (request.method === "POST" && request.url === "/v1/demo/mvp/run") {
      const body = await readOptionalJson<DelivrixMvpDemoBlueprintInput & { demoRunId?: string }>(request);
      const killSwitch = await killSwitchStore.get();
      const actorId = body?.actorId?.trim() || "operator_local";
      const demoRunId = body?.demoRunId?.trim() || createId("demo_run");
      const blueprint = buildDelivrixMvpDemoBlueprint({
        ...body,
        actorId,
        killSwitch: body?.killSwitch ?? killSwitch
      });
      const auditEventIds: string[] = [];
      const appendDemoAudit = async (event: Parameters<typeof auditLog.append>[0]) => {
        const auditEvent = await auditLog.append({
          ...event,
          metadata: {
            ...event.metadata,
            demoRunId,
            blueprintId: blueprint.id,
            smtpEnabled: false,
            liveInfrastructureWritesEnabled: false,
            nfcProductionWritesEnabled: false
          }
        });
        auditEventIds.push(auditEvent.id);
        return auditEvent;
      };
      let senderNode = undefined;
      let job = undefined;
      let result = undefined;
      let blockedReason = undefined;

      if (blueprint.decision.status !== "ready_for_demo") {
        blockedReason = `Blueprint is ${blueprint.decision.status}: ${blueprint.decision.reason}`;
        await appendDemoAudit({
          actorType: body?.actorId ? "operator" : "system",
          actorId,
          action: "demo.mvp_run.blocked_by_blueprint",
          targetType: "mvp_demo",
          targetId: demoRunId,
          riskLevel: "high",
          metadata: {
            decision: blueprint.decision
          }
        });
      } else {
        const killSwitchDecision = evaluateKillSwitch(killSwitch, "apply_supervised_local_action");

        if (!killSwitchDecision.allowed) {
          blockedReason = killSwitchDecision.message;
          await appendDemoAudit({
            actorType: body?.actorId ? "operator" : "system",
            actorId,
            action: "demo.mvp_run.blocked_by_kill_switch",
            targetType: "mvp_demo",
            targetId: demoRunId,
            riskLevel: "critical",
            metadata: {
              decision: killSwitchDecision
            }
          });
        } else {
          senderNode = await senderNodeRegistry.register(blueprint.pipeline.senderNode);
          await appendDemoAudit({
            actorType: body?.actorId ? "operator" : "system",
            actorId,
            action: "demo.sender_node.seeded",
            targetType: "sender_node",
            targetId: senderNode.id,
            riskLevel: "medium",
            metadata: {
              provider: senderNode.provider,
              status: senderNode.status,
              dailyLimit: senderNode.dailyLimit,
              sideEffects: "local-state-only"
            }
          });

          const policyDecision = await policyEngine.evaluate(blueprint.pipeline.sendRequest);

          if (!policyDecision.allowed) {
            blockedReason = "Policy rejected the demo request.";
            await appendDemoAudit({
              actorType: "system",
              actorId: "gateway-api",
              action: "demo.send_request.rejected",
              targetType: "campaign",
              targetId: blueprint.pipeline.sendRequest.campaignId,
              riskLevel: "medium",
              metadata: {
                violations: policyDecision.violations,
                warnings: policyDecision.warnings
              }
            });
          } else {
            const gatewayRateLimitDecision = await rateLimitService.check(
              requestRateLimitRules(blueprint.pipeline.sendRequest, requestRateLimitProfile)
            );

            if (!gatewayRateLimitDecision.allowed) {
              blockedReason = "Rate limit rejected the demo request at Gateway.";
              await appendDemoAudit({
                actorType: "system",
                actorId: "gateway-api",
                action: "demo.send_request.rate_limited",
                targetType: "campaign",
                targetId: blueprint.pipeline.sendRequest.campaignId,
                riskLevel: "medium",
                metadata: {
                  violations: gatewayRateLimitDecision.violations
                }
              });
            } else {
              job = await sendQueue.add(blueprint.pipeline.sendRequest);
              await appendDemoAudit({
                actorType: "system",
                actorId: "gateway-api",
                action: "demo.send_request.accepted",
                targetType: "send_job",
                targetId: job.id,
                riskLevel: "low",
                metadata: {
                  campaignId: job.request.campaignId,
                  recipient: job.request.recipient.email,
                  classification: job.request.classification
                }
              });

              const claimedJob = await sendQueue.claim(job.id);

              if (!claimedJob) {
                blockedReason = "Demo job could not be claimed from the local queue.";
                await appendDemoAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.send_job.claim_failed",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "high",
                  metadata: {
                    reason: blockedReason
                  }
                });
              } else {
                job = claimedJob;
                await appendDemoAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.send_job.claimed",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "low",
                  metadata: {
                    recipient: job.request.recipient.email,
                    campaignId: job.request.campaignId
                  }
                });

                await sendQueue.assignSenderNode(job.id, senderNode.id);
                job = {
                  ...job,
                  senderNodeId: senderNode.id
                };
                await appendDemoAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.send_job.sender_node_assigned",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "low",
                  metadata: {
                    senderNodeId: senderNode.id,
                    provider: senderNode.provider,
                    status: senderNode.status
                  }
                });

                const workerRateLimitDecision = await rateLimitService.consume([
                  ...requestRateLimitRules(job.request, requestRateLimitProfile),
                  senderNodeRateLimitRule(senderNode)
                ]);

                if (!workerRateLimitDecision.allowed) {
                  blockedReason = "Rate limit exceeded during demo worker enforcement.";
                  await sendQueue.markBlocked(job.id, blockedReason);
                  job = {
                    ...job,
                    status: "blocked",
                    failureReason: blockedReason,
                    completedAt: new Date().toISOString()
                  };
                  await appendDemoAudit({
                    actorType: "system",
                    actorId: "demo-runner",
                    action: "demo.send_job.rate_limited",
                    targetType: "send_job",
                    targetId: job.id,
                    riskLevel: "medium",
                    metadata: {
                      violations: workerRateLimitDecision.violations,
                      senderNodeId: senderNode.id
                    }
                  });
                } else {
                  const simulatedResult = simulateSendResult(job);
                  result = await sendResultStore.create({
                    sendJobId: job.id,
                    senderNodeId: senderNode.id,
                    ...simulatedResult,
                    metadata: {
                      ...simulatedResult.metadata,
                      demoRunId,
                      blueprintId: blueprint.id,
                      smtpEnabled: false
                    }
                  });

                  if (result.status === "failed") {
                    await sendQueue.markFailed(job.id, "Simulated demo result failed.");
                    job = {
                      ...job,
                      status: "failed",
                      failureReason: "Simulated demo result failed.",
                      completedAt: new Date().toISOString()
                    };
                  } else {
                    await sendQueue.markCompleted(job.id);
                    job = {
                      ...job,
                      status: "completed",
                      completedAt: new Date().toISOString()
                    };
                  }

                  await appendDemoAudit({
                    actorType: "system",
                    actorId: "demo-runner",
                    action: "demo.send_result.simulated",
                    targetType: "send_result",
                    targetId: result.id,
                    riskLevel: result.status === "complaint" || result.status === "bounce" ? "medium" : "low",
                    metadata: {
                      sendJobId: job.id,
                      senderNodeId: senderNode.id,
                      status: result.status,
                      sideEffects: "local-state-only"
                    }
                  });
                }
              }
            }
          }
        }
      }

      const jobs = await sendQueue.list();
      const senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();
      let auditEvents = await auditLog.list();
      const healthDecisions = evaluateSenderNodeHealth(senderNodes, sendResults);
      let operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      job = job ? jobs.find((candidate) => candidate.id === job?.id) ?? job : undefined;
      const draftReport = buildDelivrixMvpDemoRunReport({
        id: demoRunId,
        actorId,
        blueprint,
        senderNode,
        job,
        result,
        healthDecisions,
        operationalSummary,
        auditEventIds,
        blockedReason
      });

      await appendDemoAudit({
        actorType: body?.actorId ? "operator" : "system",
        actorId,
        action: draftReport.decision.status === "blocked" ? "demo.mvp_run.blocked" : "demo.mvp_run.completed",
        targetType: "mvp_demo",
        targetId: demoRunId,
        riskLevel: draftReport.decision.status === "blocked" ? "high" : draftReport.decision.status === "needs_review" ? "medium" : "low",
        metadata: {
          decision: draftReport.decision,
          artifacts: draftReport.artifacts,
          route: draftReport.route
        }
      });

      auditEvents = await auditLog.list();
      operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });

      const report = buildDelivrixMvpDemoRunReport({
        id: demoRunId,
        actorId,
        blueprint,
        senderNode,
        job,
        result,
        healthDecisions,
        operationalSummary,
        auditEventIds,
        blockedReason
      });

      return json(response, 200, {
        report
      });
    }

    if (request.method === "POST" && request.url === "/v1/demo/openclaw/incident") {
      const body = await readOptionalJson<DelivrixMvpDemoBlueprintInput & {
        incidentDemoId?: string;
        demoRunId?: string;
        incidentStatus?: SendResultStatus;
        humanApproved?: boolean;
        applyLocalAction?: boolean;
      }>(request);
      const requestedStatus = body?.incidentStatus ?? body?.simulatedResultStatus ?? "complaint";

      if (
        requestedStatus !== "bounce"
        && requestedStatus !== "complaint"
        && requestedStatus !== "deferred"
        && requestedStatus !== "failed"
      ) {
        return json(response, 422, {
          error: "invalid_openclaw_incident_status",
          message: "incidentStatus must be bounce, complaint, deferred, or failed."
        });
      }

      const killSwitch = await killSwitchStore.get();
      const actorId = body?.actorId?.trim() || "operator_local";
      const incidentDemoId = body?.incidentDemoId?.trim() || createId("openclaw_incident_demo");
      const demoRunId = body?.demoRunId?.trim() || createId("demo_run");
      const humanApproved = body?.humanApproved ?? true;
      const shouldApplyLocalAction = body?.applyLocalAction !== false;
      const blueprint = buildDelivrixMvpDemoBlueprint({
        ...body,
        actorId,
        simulatedResultStatus: requestedStatus,
        killSwitch: body?.killSwitch ?? killSwitch
      });
      const auditEventIds: string[] = [];
      const appendIncidentAudit = async (event: Parameters<typeof auditLog.append>[0]) => {
        const auditEvent = await auditLog.append({
          ...event,
          metadata: {
            ...event.metadata,
            incidentDemoId,
            demoRunId,
            blueprintId: blueprint.id,
            smtpEnabled: false,
            liveInfrastructureWritesEnabled: false,
            nfcProductionWritesEnabled: false
          }
        });
        auditEventIds.push(auditEvent.id);
        return auditEvent;
      };
      let senderNode = undefined;
      let appliedSenderNode = undefined;
      let job = undefined;
      let result = undefined;
      let blockedReason = undefined;

      if (blueprint.decision.status !== "ready_for_demo") {
        blockedReason = `Blueprint is ${blueprint.decision.status}: ${blueprint.decision.reason}`;
        await appendIncidentAudit({
          actorType: body?.actorId ? "operator" : "system",
          actorId,
          action: "demo.openclaw_incident.blocked_by_blueprint",
          targetType: "mvp_demo",
          targetId: incidentDemoId,
          riskLevel: "high",
          metadata: {
            decision: blueprint.decision
          }
        });
      } else {
        const killSwitchDecision = evaluateKillSwitch(killSwitch, "apply_supervised_local_action");

        if (!killSwitchDecision.allowed) {
          blockedReason = killSwitchDecision.message;
          await appendIncidentAudit({
            actorType: body?.actorId ? "operator" : "system",
            actorId,
            action: "demo.openclaw_incident.blocked_by_kill_switch",
            targetType: "mvp_demo",
            targetId: incidentDemoId,
            riskLevel: "critical",
            metadata: {
              decision: killSwitchDecision
            }
          });
        } else {
          senderNode = await senderNodeRegistry.register(blueprint.pipeline.senderNode);
          await appendIncidentAudit({
            actorType: body?.actorId ? "operator" : "system",
            actorId,
            action: "demo.openclaw_incident.sender_node_seeded",
            targetType: "sender_node",
            targetId: senderNode.id,
            riskLevel: "medium",
            metadata: {
              provider: senderNode.provider,
              status: senderNode.status,
              dailyLimit: senderNode.dailyLimit,
              sideEffects: "local-state-only"
            }
          });

          const policyDecision = await policyEngine.evaluate(blueprint.pipeline.sendRequest);

          if (!policyDecision.allowed) {
            blockedReason = "Policy rejected the OpenClaw incident demo request.";
            await appendIncidentAudit({
              actorType: "system",
              actorId: "gateway-api",
              action: "demo.openclaw_incident.send_request_rejected",
              targetType: "campaign",
              targetId: blueprint.pipeline.sendRequest.campaignId,
              riskLevel: "medium",
              metadata: {
                violations: policyDecision.violations,
                warnings: policyDecision.warnings
              }
            });
          } else {
            const gatewayRateLimitDecision = await rateLimitService.check(
              requestRateLimitRules(blueprint.pipeline.sendRequest, requestRateLimitProfile)
            );

            if (!gatewayRateLimitDecision.allowed) {
              blockedReason = "Rate limit rejected the OpenClaw incident demo request at Gateway.";
              await appendIncidentAudit({
                actorType: "system",
                actorId: "gateway-api",
                action: "demo.openclaw_incident.send_request_rate_limited",
                targetType: "campaign",
                targetId: blueprint.pipeline.sendRequest.campaignId,
                riskLevel: "medium",
                metadata: {
                  violations: gatewayRateLimitDecision.violations
                }
              });
            } else {
              job = await sendQueue.add(blueprint.pipeline.sendRequest);
              await appendIncidentAudit({
                actorType: "system",
                actorId: "gateway-api",
                action: "demo.openclaw_incident.send_request_accepted",
                targetType: "send_job",
                targetId: job.id,
                riskLevel: "low",
                metadata: {
                  campaignId: job.request.campaignId,
                  recipient: job.request.recipient.email,
                  classification: job.request.classification,
                  expectedIncidentStatus: requestedStatus
                }
              });

              const claimedJob = await sendQueue.claim(job.id);

              if (!claimedJob) {
                blockedReason = "OpenClaw incident demo job could not be claimed from the local queue.";
                await appendIncidentAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.openclaw_incident.send_job_claim_failed",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "high",
                  metadata: {
                    reason: blockedReason
                  }
                });
              } else {
                job = claimedJob;
                await appendIncidentAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.openclaw_incident.send_job_claimed",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "low",
                  metadata: {
                    recipient: job.request.recipient.email,
                    campaignId: job.request.campaignId
                  }
                });

                await sendQueue.assignSenderNode(job.id, senderNode.id);
                job = {
                  ...job,
                  senderNodeId: senderNode.id
                };
                await appendIncidentAudit({
                  actorType: "system",
                  actorId: "demo-runner",
                  action: "demo.openclaw_incident.sender_node_assigned",
                  targetType: "send_job",
                  targetId: job.id,
                  riskLevel: "low",
                  metadata: {
                    senderNodeId: senderNode.id,
                    provider: senderNode.provider,
                    status: senderNode.status
                  }
                });

                const workerRateLimitDecision = await rateLimitService.consume([
                  ...requestRateLimitRules(job.request, requestRateLimitProfile),
                  senderNodeRateLimitRule(senderNode)
                ]);

                if (!workerRateLimitDecision.allowed) {
                  blockedReason = "Rate limit exceeded during OpenClaw incident demo worker enforcement.";
                  await sendQueue.markBlocked(job.id, blockedReason);
                  job = {
                    ...job,
                    status: "blocked",
                    failureReason: blockedReason,
                    completedAt: new Date().toISOString()
                  };
                  await appendIncidentAudit({
                    actorType: "system",
                    actorId: "demo-runner",
                    action: "demo.openclaw_incident.send_job_rate_limited",
                    targetType: "send_job",
                    targetId: job.id,
                    riskLevel: "medium",
                    metadata: {
                      violations: workerRateLimitDecision.violations,
                      senderNodeId: senderNode.id
                    }
                  });
                } else {
                  const simulatedResult = simulateSendResult(job);
                  result = await sendResultStore.create({
                    sendJobId: job.id,
                    senderNodeId: senderNode.id,
                    ...simulatedResult,
                    metadata: {
                      ...simulatedResult.metadata,
                      incidentDemoId,
                      demoRunId,
                      blueprintId: blueprint.id,
                      smtpEnabled: false
                    }
                  });

                  if (result.status === "failed") {
                    await sendQueue.markFailed(job.id, "Simulated OpenClaw incident result failed.");
                    job = {
                      ...job,
                      status: "failed",
                      failureReason: "Simulated OpenClaw incident result failed.",
                      completedAt: new Date().toISOString()
                    };
                  } else {
                    await sendQueue.markCompleted(job.id);
                    job = {
                      ...job,
                      status: "completed",
                      completedAt: new Date().toISOString()
                    };
                  }

                  await appendIncidentAudit({
                    actorType: "system",
                    actorId: "demo-runner",
                    action: "demo.openclaw_incident.result_simulated",
                    targetType: "send_result",
                    targetId: result.id,
                    riskLevel: result.status === "complaint" ? "critical" : "medium",
                    metadata: {
                      sendJobId: job.id,
                      senderNodeId: senderNode.id,
                      status: result.status,
                      sideEffects: "local-state-only"
                    }
                  });
                }
              }
            }
          }
        }
      }

      let jobs = await sendQueue.list();
      let senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();
      let auditEvents = await auditLog.list();
      const healthDecisions = evaluateSenderNodeHealth(senderNodes, sendResults);
      let operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      job = job ? jobs.find((candidate) => candidate.id === job?.id) ?? job : undefined;
      const demoRun = buildDelivrixMvpDemoRunReport({
        id: demoRunId,
        actorId,
        blueprint,
        senderNode,
        job,
        result,
        healthDecisions,
        operationalSummary,
        auditEventIds,
        blockedReason
      });
      const draftIncidentReport = buildOpenClawIncidentDemoReport({
        id: incidentDemoId,
        actorId,
        demoRun,
        killSwitch,
        humanApproved,
        auditEventIds
      });

      await appendIncidentAudit({
        actorType: "openclaw",
        actorId: "alert-ops",
        action: draftIncidentReport.detection.detected
          ? "demo.openclaw_incident.detected"
          : "demo.openclaw_incident.not_detected",
        targetType: "send_result",
        targetId: draftIncidentReport.detection.sendResultId ?? "missing",
        riskLevel: draftIncidentReport.detection.severity === "critical" ? "critical" : draftIncidentReport.detection.detected ? "medium" : "low",
        metadata: {
          detection: draftIncidentReport.detection
        }
      });

      await appendIncidentAudit({
        actorType: "openclaw",
        actorId: "alert-ops",
        action: draftIncidentReport.proposal.action
          ? "demo.openclaw_incident.action_proposed"
          : "demo.openclaw_incident.no_action_required",
        targetType: "sender_node",
        targetId: draftIncidentReport.proposal.targetSenderNodeId ?? "none",
        riskLevel: draftIncidentReport.proposal.manualAction === "quarantine" ? "critical" : draftIncidentReport.proposal.manualAction ? "high" : "low",
        metadata: {
          proposal: draftIncidentReport.proposal
        }
      });

      await appendIncidentAudit({
        actorType: "system",
        actorId: "openclaw-runbook",
        action: "demo.openclaw_incident.permission_evaluated",
        targetType: "sender_node",
        targetId: draftIncidentReport.proposal.targetSenderNodeId ?? "none",
        riskLevel: draftIncidentReport.permissionChecks.withHumanApproval?.riskLevel ?? "low",
        metadata: {
          humanApproved,
          permissionChecks: draftIncidentReport.permissionChecks
        }
      });

      if (
        shouldApplyLocalAction
        && humanApproved
        && senderNode
        && draftIncidentReport.permissionChecks.withHumanApproval?.allowed
        && draftIncidentReport.localAction.decision?.allowed
        && draftIncidentReport.localAction.decision.nextStatus
      ) {
        appliedSenderNode = await senderNodeRegistry.updateStatus(
          senderNode.id,
          draftIncidentReport.localAction.decision.nextStatus
        );
        await appendIncidentAudit({
          actorType: "operator",
          actorId,
          action: "demo.openclaw_incident.local_action_applied",
          targetType: "sender_node",
          targetId: senderNode.id,
          riskLevel: draftIncidentReport.localAction.decision.riskLevel,
          metadata: {
            humanApproved,
            action: draftIncidentReport.localAction.decision.action,
            previousStatus: senderNode.status,
            currentStatus: appliedSenderNode.status,
            reason: draftIncidentReport.localAction.decision.reason,
            sideEffects: "local-state-only"
          }
        });
      } else {
        await appendIncidentAudit({
          actorType: humanApproved ? "system" : "operator",
          actorId: humanApproved ? "openclaw-runbook" : actorId,
          action: "demo.openclaw_incident.local_action_not_applied",
          targetType: "sender_node",
          targetId: senderNode?.id ?? "none",
          riskLevel: draftIncidentReport.permissionChecks.withHumanApproval?.allowed === false ? "critical" : "medium",
          metadata: {
            humanApproved,
            shouldApplyLocalAction,
            permission: draftIncidentReport.permissionChecks.withHumanApproval,
            localAction: draftIncidentReport.localAction
          }
        });
      }

      jobs = await sendQueue.list();
      senderNodes = await senderNodeRegistry.list();
      auditEvents = await auditLog.list();
      operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      const finalDemoRun = buildDelivrixMvpDemoRunReport({
        id: demoRunId,
        actorId,
        blueprint,
        senderNode,
        job,
        result,
        healthDecisions,
        operationalSummary,
        auditEventIds,
        blockedReason
      });
      const finalDraftReport = buildOpenClawIncidentDemoReport({
        id: incidentDemoId,
        actorId,
        demoRun: finalDemoRun,
        killSwitch,
        humanApproved,
        appliedSenderNode,
        auditEventIds
      });

      await appendIncidentAudit({
        actorType: body?.actorId ? "operator" : "system",
        actorId,
        action: finalDraftReport.decision.status === "blocked"
          ? "demo.openclaw_incident.blocked"
          : finalDraftReport.decision.status === "needs_review"
            ? "demo.openclaw_incident.needs_review"
            : "demo.openclaw_incident.completed",
        targetType: "mvp_demo",
        targetId: incidentDemoId,
        riskLevel: finalDraftReport.decision.status === "blocked" ? "high" : finalDraftReport.decision.status === "needs_review" ? "medium" : "low",
        metadata: {
          decision: finalDraftReport.decision,
          detection: finalDraftReport.detection,
          proposal: finalDraftReport.proposal,
          localAction: finalDraftReport.localAction
        }
      });

      const report = buildOpenClawIncidentDemoReport({
        id: incidentDemoId,
        actorId,
        demoRun: finalDemoRun,
        killSwitch,
        humanApproved,
        appliedSenderNode,
        auditEventIds
      });

      return json(response, 200, {
        report
      });
    }

    if (request.method === "POST" && request.url === "/v1/demo/mvp/final-report") {
      const body = await readOptionalJson<{
        actorId?: string;
        reportId?: string;
      }>(request);
      const actorId = body?.actorId?.trim() || "operator_local";
      const reportId = body?.reportId?.trim() || createId("mvp_final_demo_report");
      const killSwitch = await killSwitchStore.get();
      const jobs = await sendQueue.list();
      const senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();
      let auditEvents = await auditLog.list();
      const healthDecisions = evaluateSenderNodeHealth(senderNodes, sendResults);
      let operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      let adminOverview = buildAdminOverview({
        summary: operationalSummary,
        health: healthDecisions,
        auditEvents,
        killSwitch
      });
      const draftReport = buildMvpFinalDemoReport({
        id: reportId,
        actorId,
        auditEvents,
        operationalSummary,
        adminOverview,
        operatingNorth: getOperatingNorthSnapshot()
      });

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId,
        action: "demo.mvp_final_report_generated",
        targetType: "mvp_demo",
        targetId: reportId,
        riskLevel: draftReport.decision.status === "blocked" ? "high" : draftReport.decision.status === "needs_review" ? "medium" : "low",
        metadata: {
          phase: draftReport.phase,
          decision: draftReport.decision,
          evidence: draftReport.evidence,
          limitedProductionGates: draftReport.limitedProductionGates,
          residualRisks: draftReport.residualRisks,
          safety: draftReport.safety,
          smtpEnabled: false,
          liveInfrastructureWritesEnabled: false,
          nfcProductionWritesEnabled: false
        }
      });

      auditEvents = await auditLog.list();
      operationalSummary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters: await rateLimitStore.list()
      });
      adminOverview = buildAdminOverview({
        summary: operationalSummary,
        health: healthDecisions,
        auditEvents,
        killSwitch
      });

      const report = buildMvpFinalDemoReport({
        id: reportId,
        actorId,
        auditEvents,
        operationalSummary,
        adminOverview,
        operatingNorth: getOperatingNorthSnapshot()
      });

      return json(response, 200, {
        report
      });
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/onboarding/questionnaire") {
      return json(response, 200, getOpenClawOnboardingQuestionnaire());
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/onboarding/evaluate") {
      const body = await readOptionalJson<OpenClawOnboardingInput>(request);
      const snapshot = evaluateOpenClawOnboarding(body ?? {});

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId: snapshot.actorId,
        action: "openclaw_onboarding.evaluated",
        targetType: "openclaw_onboarding",
        targetId: snapshot.id,
        riskLevel: snapshot.decision.riskLevel,
        metadata: {
          phase: snapshot.phase,
          decision: snapshot.decision,
          readiness: snapshot.readiness,
          blockers: snapshot.blockers,
          warnings: snapshot.warnings,
          missingCriticalFields: snapshot.missingCriticalFields,
          dryRun: snapshot.dryRun,
          sideEffects: snapshot.sideEffects,
          liveInfrastructureWritesEnabled: false,
          sshEnabled: false,
          smtpEnabled: false,
          dnsLiveChangesEnabled: false,
          nfcWritesEnabled: false
        }
      });

      return json(response, 200, {
        snapshot
      });
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/topology/plan") {
      const body = await readJson<OpenClawTopologyPlannerInput>(request);
      const plan = buildOpenClawTopologyPlan(body);

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId: plan.actorId,
        action: "openclaw_topology.plan_created",
        targetType: "openclaw_topology",
        targetId: plan.id,
        riskLevel: plan.decision.riskLevel,
        metadata: {
          phase: plan.phase,
          strategy: plan.strategy,
          decision: plan.decision,
          summary: plan.summary,
          risks: plan.risks,
          dryRun: plan.dryRun,
          sideEffects: plan.sideEffects,
          liveInfrastructureWritesEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false,
          smtpEnabled: false,
          dnsLiveChangesEnabled: false,
          nfcWritesEnabled: false
        }
      });

      return json(response, 200, {
        plan
      });
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/provisioning/dry-run") {
      const body = await readJson<OpenClawProvisioningDryRunInput>(request);
      const plan = buildOpenClawProvisioningDryRun(body);

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId: plan.actorId,
        action: "openclaw_provisioning.dry_run_created",
        targetType: "openclaw_provisioning",
        targetId: plan.id,
        riskLevel: plan.decision.riskLevel,
        metadata: {
          phase: plan.phase,
          decision: plan.decision,
          summary: plan.summary,
          risks: plan.risks,
          dryRun: plan.dryRun,
          sideEffects: plan.sideEffects,
          liveInfrastructureWritesEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false,
          postfixLiveApplyEnabled: false,
          openDkimLiveKeyGenerationEnabled: false,
          tlsLiveCertificateRequestEnabled: false,
          dnsLiveChangesEnabled: false,
          smtpEnabled: false,
          nfcWritesEnabled: false
        }
      });

      return json(response, 200, {
        plan
      });
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/scheduler/run") {
      const body = await readOptionalJson<OpenClawSchedulerInput>(request);
      const run = runOpenClawScheduler(body ?? {});

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId: run.actorId,
        action: "openclaw_scheduler.run_simulated",
        targetType: "openclaw_scheduler",
        targetId: run.id,
        riskLevel: run.decision.riskLevel,
        metadata: {
          phase: run.phase,
          decision: run.decision,
          sourceProvisioningId: run.sourceProvisioningId,
          llmRouter: run.llmRouter,
          tasks: run.tasks.map((task) => ({
            name: task.name,
            skill: task.skill,
            cadence: task.cadence,
            due: task.due,
            sideEffects: task.sideEffects,
            liveActionsEnabled: task.liveActionsEnabled
          })),
          skills: run.skills.map((skill) => ({
            name: skill.name,
            status: skill.status,
            proposedActions: skill.proposedActions.length
          })),
          dailyReport: {
            humanReviewRequired: run.dailyReport.humanReviewRequired,
            plannedSenderNodes: run.dailyReport.fleet.plannedSenderNodes,
            provisioningDecision: run.dailyReport.fleet.provisioningDecision,
            alerts: {
              critical: run.dailyReport.alerts.critical,
              high: run.dailyReport.alerts.high,
              medium: run.dailyReport.alerts.medium,
              low: run.dailyReport.alerts.low
            }
          },
          dryRun: run.dryRun,
          sideEffects: run.sideEffects,
          liveInfrastructureWritesEnabled: false,
          llmLiveCallsEnabled: false,
          actionExecutorLiveEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false,
          smtpEnabled: false,
          dnsLiveChangesEnabled: false,
          nfcWritesEnabled: false
        }
      });

      return json(response, 200, {
        run
      });
    }

    if (request.method === "POST" && request.url === "/v1/openclaw/runbook/evaluate") {
      const body = await readOptionalJson<OpenClawRunbookInput>(request);
      const currentKillSwitch = await killSwitchStore.get();
      const runbook = buildOpenClawOperationalRunbook({
        ...body,
        killSwitch: body?.killSwitch ?? currentKillSwitch
      });

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId: runbook.actorId,
        action: "openclaw_runbook.evaluated",
        targetType: "openclaw_runbook",
        targetId: runbook.id,
        riskLevel: runbook.decision.riskLevel,
        metadata: {
          phase: runbook.phase,
          decision: runbook.decision,
          permissionMatrixItems: runbook.permissionMatrix.length,
          checklist: runbook.checklist,
          killSwitchProof: {
            currentState: runbook.killSwitchProof.currentState,
            blocksOpenClawProposedActions: runbook.killSwitchProof.blocksOpenClawProposedActions,
            blocksSupervisedLocalActions: runbook.killSwitchProof.blocksSupervisedLocalActions,
            blocksLiveInfrastructureActions: runbook.killSwitchProof.blocksLiveInfrastructureActions,
            blocksQueueProcessing: runbook.killSwitchProof.blocksQueueProcessing
          },
          dryRun: runbook.dryRun,
          sideEffects: runbook.sideEffects,
          liveInfrastructureWritesEnabled: false,
          liveEmailSendingEnabled: false,
          nfcProductionWritesEnabled: false,
          sshEnabled: false,
          dnsLiveChangesEnabled: false,
          proxmoxApiEnabled: false,
          llmAutonomousExecutionEnabled: false
        }
      });

      return json(response, 200, {
        runbook
      });
    }

    if (request.method === "GET" && request.url === "/v1/hardware/physical-host") {
      return json(response, 200, {
        physicalHost: buildPhysicalHostSnapshot()
      });
    }

    if (request.method === "GET" && request.url === "/v1/hardware/telemetry/latest") {
      return json(response, 200, {
        telemetry: buildHardwareTelemetrySnapshot()
      });
    }

    if (request.method === "GET" && request.url === "/v1/hardware/telemetry/history") {
      return json(response, 200, {
        history: buildHardwareTelemetryHistory()
      });
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/onboarding/state") {
      const now = new Date();
      const snapshot = evaluateOpenClawOnboarding({
        actorId: "openclaw-read-model"
      }, now);

      return json(response, 200, {
        onboardingState: buildOpenClawOnboardingState({
          snapshot,
          now
        })
      });
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/provisioning/state") {
      return json(response, 200, {
        provisioningState: buildOpenClawProvisioningState()
      });
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/readiness-signals") {
      const now = new Date();
      const physicalHost = buildPhysicalHostSnapshot({ now });
      const telemetry = buildHardwareTelemetrySnapshot({ now });

      return json(response, 200, {
        signals: buildOpenClawReadinessSignals({
          physicalHost,
          telemetry,
          now
        })
      });
    }

    if (request.method === "GET" && request.url === "/v1/devops/collector/status") {
      return json(response, 200, {
        collector: buildDevOpsCollectorStatus()
      });
    }

    if (request.method === "GET" && request.url === "/v1/devops/collector/supervised-plan") {
      return json(response, 200, {
        supervisedCollector: buildSupervisedCollectorPlan({
          now: new Date()
        })
      });
    }

    if (request.method === "GET" && request.url === "/v1/devops/collector/snapshot-ingestion") {
      return json(response, 200, {
        snapshotIngestion: buildManualCollectorSnapshotIngestionContract({
          now: new Date()
        })
      });
    }

    if (request.method === "POST" && request.url === "/v1/devops/collector/manual-snapshots/ingest") {
      const body = await readOptionalJson<{
        actorId?: string;
        humanApproved?: boolean;
        snapshot?: unknown;
      }>(request);
      const gate = evaluateOperatingActionGate({
        action: "ingest_manual_collector_snapshot",
        mode: "supervised",
        humanApproved: body?.humanApproved === true
      });

      if (!gate.allowed) {
        return json(response, 403, {
          error: "manual_snapshot_ingestion_blocked",
          gate
        });
      }

      const ingestion = ingestManualCollectorSnapshot({
        actorId: body?.actorId?.trim() || "operator_local",
        rawSnapshot: body && "snapshot" in body ? body.snapshot : body,
        now: new Date()
      });
      const auditEvent = await auditLog.append(ingestion.auditEventCandidate);

      return json(response, ingestion.status === "rejected" ? 422 : 202, {
        ingestion,
        auditEvent
      });
    }

    if (request.method === "GET" && requestUrl(request).pathname === "/v1/openclaw/proposals") {
      const now = new Date();
      pruneExpiredProposals(now);

      return json(response, 200, {
        schemaVersion: "2026-05-29.openclaw-proposals.v1",
        generatedAt: now.toISOString(),
        proposals: proposalsStore
          .filter((proposal) =>
            proposal.status === "pending" &&
            proposal.requiresApproval &&
            Date.parse(proposal.expiresAt) > now.getTime()
          )
          .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
          .map((proposal) => ({
            id: proposal.id,
            category: proposal.category,
            severity: proposal.severity,
            headline: proposal.headline,
            body: proposal.body,
            runbookRef: proposal.runbookRef,
            targetRef: proposal.targetRef,
            targetType: proposal.targetType,
            skillSlug: proposal.skillSlug,
            params: proposal.params ?? null,
            evidenceRefs: proposal.evidenceRefs,
            delivrixActionsRequired: proposal.delivrix_actions_required,
            receivedAt: proposal.receivedAt,
            expiresAt: proposal.expiresAt,
            requiredApprovals: proposal.requiredApprovals,
            currentApprovals: approvalStateForProposal(proposal).current
          }))
      });
    }

    if (request.method === "POST" && request.url === "/v1/agent/proposals") {
      const { raw, body } = await readRawBodyAndJson<AgentProposalRequest>(request);
      const hmac = validateOpenClawHmac(request.headers, raw);

      if (!hmac.ok) {
        await auditLog.append({
          actorType: "openclaw",
          actorId: "openclaw-hostinger-prod",
          action: "oc.hmac.validated.fail",
          targetType: "agent_request",
          targetId: "proposals",
          riskLevel: "medium",
          metadata: {
            rejectReason: hmac.rejectReason
          }
        });

        return json(response, 401, {
          rejectReason: hmac.rejectReason
        });
      }

      await auditLog.append({
        actorType: "openclaw",
        actorId: "openclaw-hostinger-prod",
        action: "oc.hmac.validated.ok",
        targetType: "agent_request",
        targetId: "proposals",
        riskLevel: "low",
        metadata: {
          timestamp: request.headers["x-openclaw-timestamp"]
        }
      });

      if (!body) {
        return json(response, 400, {
          rejectReason: "schema_mismatch",
          details: "Invalid JSON payload."
        });
      }

      const proposal = normalizeAgentProposal(body.proposal);
      const audit = body.audit;

      if (
        body.schemaVersion !== "2026-05-18.v1" ||
        !proposal ||
        !audit ||
        !isNonEmptyString(audit.skillSlug) ||
        !isNonEmptyString(audit.modelVersion) ||
        !isNonEmptyString(audit.promptVersion)
      ) {
        return json(response, 400, {
          rejectReason: "schema_mismatch",
          details: "Missing proposal, audit, or schemaVersion fields."
        });
      }

      const permissions = proposal.delivrix_actions_required.map((actionId) =>
        evaluateAgentActionPermission(actionId, {
          humanApproved: false,
          killSwitchEnabled: false,
          schemaVersion: body.schemaVersion
        })
      );
      const terminalRejection = permissions.find(
        (decision) => decision.decision === "reject" && decision.rejectReason !== "human_approval_missing"
      );

      if (terminalRejection && terminalRejection.rejectReason) {
        await auditLog.append({
          actorType: "openclaw",
          actorId: "openclaw-hostinger-prod",
          action: "oc.permission.rejected",
          targetType: "proposal",
          targetId: proposal.id,
          riskLevel: "high",
          metadata: {
            actionId: terminalRejection.actionId,
            rejectReason: terminalRejection.rejectReason,
            skillSlug: audit.skillSlug,
            category: proposal.category,
            targetRef: proposal.targetRef
          }
        });

        return json(response, httpStatusForPermissionReject(terminalRejection.rejectReason), {
          rejectReason: terminalRejection.rejectReason,
          details: `Action ${terminalRejection.actionId} blocked by matrix`
        });
      }

      const now = new Date();
      pruneExpiredProposals(now);

      const hash = hashProposal(proposal);
      const existing = findPendingProposalByHash(hash, now);
      const requiresApproval = permissions.some(
        (decision) => decision.category === "supervised_local_state"
      );
      const skillSlug = canonicalSkillSlug(proposal.skillSlug ?? audit.skillSlug);
      const skillBinding = validateSkillActionBinding({
        skill: skillSlug,
        actionIds: proposal.delivrix_actions_required
      });
      if (!skillBinding.ok) {
        await auditLog.append({
          actorType: "openclaw",
          actorId: "openclaw-hostinger-prod",
          action: "oc.permission.rejected",
          targetType: "proposal",
          targetId: proposal.id,
          riskLevel: "high",
          metadata: {
            rejectReason: skillBinding.rejectReason,
            skillSlug,
            expectedActionIds: skillBinding.expectedActionIds ?? [],
            actionIds: proposal.delivrix_actions_required,
            category: proposal.category,
            targetRef: proposal.targetRef
          }
        });

        return json(response, 409, {
          rejectReason: skillBinding.rejectReason,
          details: `Skill ${skillSlug} is not authorized by proposal actions`
        });
      }
      const targetType = proposal.targetType ?? (looksLikeDomain(proposal.targetRef) ? "domain" : "proposal_target");
      const executionContextHash = hashSkillExecutionContext({
        proposalId: proposal.id,
        skill: skillSlug,
        actionIds: proposal.delivrix_actions_required,
        targetType,
        targetId: proposal.targetRef,
        params: proposal.params ?? {}
      });

      if (existing) {
        return json(response, 200, {
          proposalId: existing.id,
          injectedIntoCanvas: true,
          duplicate: true,
          requiresApproval: existing.requiresApproval,
          requiredApprovals: existing.requiredApprovals
        });
      }

      const stored: StoredProposal = {
        ...proposal,
        skillSlug,
        proposalHash: hash,
        receivedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + proposalTtlMs).toISOString(),
        status: "pending",
        requiresApproval,
        requiredApprovals: getRequiredApprovalsForRunbook(getRunbookIdForProposal(proposal))
      };
      proposalsStore.push(stored);

      await auditLog.append({
        actorType: "openclaw",
        actorId: "openclaw-hostinger-prod",
        action: "oc.proposal.submitted",
        targetType: "proposal",
        targetId: proposal.id,
        riskLevel: riskLevelFromProposalSeverity(proposal.severity),
        metadata: {
          category: proposal.category,
          severity: proposal.severity,
          requiresApproval,
          targetRef: proposal.targetRef,
          proposalHash: hash,
          executionContextHash,
          runbookRef: proposal.runbookRef,
          skillSlug,
          modelVersion: audit.modelVersion,
          promptVersion: audit.promptVersion,
          tokensUsed: audit.tokensUsed
        }
      });

      return json(response, 200, {
        proposalId: proposal.id,
        injectedIntoCanvas: true,
        duplicate: false,
        requiresApproval,
        requiredApprovals: stored.requiredApprovals
      });
    }

    if (request.method === "POST" && requestUrl(request).pathname === "/v1/agent/audit/batch") {
      const { raw, body } = await readRawBodyAndJson<AuditBatchRequest>(request);
      const hmac = validateOpenClawHmac(request.headers, raw);

      if (!hmac.ok) {
        return json(response, 401, {
          rejectReason: hmac.rejectReason
        });
      }

      if (!body || !Array.isArray(body.events) || body.events.length === 0) {
        return json(response, 400, {
          rejectReason: "schema_mismatch"
        });
      }

      if (body.events.length > 50) {
        return json(response, 400, {
          rejectReason: "batch_too_large",
          max: 50
        });
      }

      const batchId = isUuid(body.batchId) ? body.batchId : randomUUID();
      const accepted: string[] = [];
      const rejected: Array<{ id: string; reason: string }> = [];

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "oc.audit.batch_received",
        targetType: "audit_batch",
        targetId: batchId,
        riskLevel: "low",
        decision: "n/a",
        metadata: {
          eventCount: body.events.length,
          sourceActor: "openclaw-hostinger-prod"
        }
      });

      for (const incoming of body.events) {
        try {
          const claimedPrev = typeof incoming.prevHash === "string" && incoming.prevHash ? incoming.prevHash : null;
          const hardened = hardenIncomingAuditBatchEvent(incoming as Record<string, unknown>, {
            caller: {
              actorType: "openclaw",
              actorId: process.env.OPENCLAW_AUDIT_CALLER_ID ?? "openclaw-hostinger-prod"
            }
          });
          const persistedEventId = isUuid(hardened.event.id) ? hardened.event.id : randomUUID();
          const hardenedEvent: AuditEventInput = {
            ...hardened.event,
            id: persistedEventId
          };
          const appended = await auditLog.appendMany((expectedPrev) => {
            const events: AuditEventInput[] = [hardenedEvent];
            if (claimedPrev && claimedPrev !== expectedPrev) {
              events.push({
                actorType: "system",
                actorId: "gateway-api",
                action: "oc.audit.chain_continuity_drift",
                targetType: "audit_event",
                targetId: persistedEventId,
                riskLevel: "medium",
                decision: "n/a",
                metadata: {
                  expectedPrev,
                  agentClaimedPrev: claimedPrev,
                  incomingEventId: typeof incoming.id === "string" ? incoming.id : null,
                  note: "Gateway recalcula prevHash; el del agente es referencial."
                }
              });
            }
            return events;
          });
          const persisted = appended.at(0);
          if (!persisted) {
            throw new Error("audit batch append produced no event");
          }

          accepted.push(persisted.id);
        } catch (error) {
          const reason = error instanceof InvalidAuditEventError ? "schema_mismatch" : "gateway_internal_error";
          rejected.push({
            id: typeof incoming.id === "string" ? incoming.id : "unknown",
            reason
          });
        }
      }

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "oc.audit.batch_persisted",
        targetType: "audit_batch",
        targetId: batchId,
        riskLevel: rejected.length > 0 ? "medium" : "low",
        decision: "n/a",
        metadata: {
          acceptedCount: accepted.length,
          rejectedCount: rejected.length,
          rejectedDetails: rejected
        }
      });

      return json(response, 200, {
        batchId,
        accepted,
        rejected
      });
    }

    if (request.method === "POST") {
      const signMatch = requestUrl(request).pathname.match(/^\/v1\/openclaw\/proposals\/([^/]+)\/sign$/);
      if (signMatch) {
        await runtimeEnvReloader.refreshNow();
        return await handleProposalSign({
          request,
          response,
          proposalId: decodeURIComponent(signMatch[1] ?? ""),
          auditLog,
          auditChain: auditChainStore,
          proposalsStore,
          canvasState: {
            upsertArtifact: (artifact) => canvasLiveEvents.upsertArtifactSnapshot(artifact)
          },
          webhookBroadcaster: equipoWebhookBroadcaster,
          dispatcher: skillDispatcher,
          readKillSwitch: () => killSwitchStore.get(),
          env: process.env,
          logger: gatewayRuntimeLog
        });
      }

      const rejectMatch = requestUrl(request).pathname.match(/^\/v1\/openclaw\/proposals\/([^/]+)\/reject$/);
      if (rejectMatch) {
        await runtimeEnvReloader.refreshNow();
        return await handleProposalReject({
          request,
          response,
          proposalId: decodeURIComponent(rejectMatch[1] ?? ""),
          auditLog,
          auditChain: auditChainStore,
          proposalsStore,
          canvasState: {
            upsertArtifact: (artifact) => canvasLiveEvents.upsertArtifactSnapshot(artifact)
          },
          webhookBroadcaster: equipoWebhookBroadcaster,
          readKillSwitch: () => killSwitchStore.get(),
          env: process.env
        });
      }
    }

    {
      const statusMatch = request.method === "GET"
        ? requestUrl(request).pathname.match(/^\/v1\/openclaw\/proposals\/([^/]+)\/status$/)
        : null;
      if (statusMatch) {
        const proposalId = decodeURIComponent(statusMatch[1] ?? "");
        const proposal = proposalsStore.find((candidate) => candidate.id === proposalId);
        if (!proposal) {
          return json(response, 404, { ok: false, rejectReason: "proposal_not_found" });
        }
        return json(response, 200, {
          ok: true,
          proposalId: proposal.id,
          status: proposal.status,
          signedAt: proposal.signedAt,
          signatureId: proposal.signatureId,
          rejectedAt: proposal.rejectedAt,
          rejectionReason: proposal.rejectionReason,
          executionOk: proposal.status === "executed",
          outcome: proposal.executionOutcome ?? null,
          executionStatusCode: proposal.executionStatusCode ?? null,
          executionDurationMs: proposal.executionDurationMs ?? null,
          executionCompletedAt: proposal.executionCompletedAt ?? null
        });
      }
    }

    const approveMatch = request.url?.match(/^\/v1\/agent\/proposals\/([^/]+)\/approve$/);

    if (request.method === "POST" && approveMatch) {
      const proposalId = decodeURIComponent(approveMatch[1] ?? "");
      const operatorId = request.headers["x-operator-id"];

      if (!isNonEmptyString(operatorId) || !operatorId.startsWith("op-")) {
        return json(response, 401, {
          rejectReason: "operator_unauthenticated"
        });
      }

      const proposal = proposalsStore.find((candidate) => candidate.id === proposalId);

      if (!proposal) {
        return json(response, 404, {
          rejectReason: "proposal_not_found"
        });
      }

      if (proposal.status !== "pending") {
        return json(response, 409, {
          rejectReason: "proposal_not_pending",
          currentStatus: proposal.status
        });
      }

      if (!proposal.requiresApproval) {
        return json(response, 400, {
          rejectReason: "proposal_does_not_require_approval"
        });
      }

      const runbookId = getRunbookIdForProposal(proposal);
      const quorumResolution = resolveQuorumForProposal(proposal, resolveGatewayNow());
      proposal.requiredApprovals = quorumResolution.requiredApprovals;

      const supervisedAction = proposal.delivrix_actions_required.find(
        (actionId) => matrixCategoryOf(actionId) === "supervised_local_state"
      );

      if (!supervisedAction) {
        return json(response, 400, {
          rejectReason: "proposal_has_no_supervised_action"
        });
      }

      const killSwitch = await killSwitchStore.get();
      const decision = evaluateAgentActionPermission(supervisedAction, {
        humanApproved: true,
        killSwitchEnabled: killSwitch.enabled,
        schemaVersion: "2026-05-18.v1"
      });

      if (decision.decision === "reject" && decision.rejectReason) {
        await auditLog.append({
          actorType: "operator",
          actorId: operatorId,
          action: "oc.permission.rejected",
          targetType: "proposal",
          targetId: proposal.id,
          riskLevel: "high",
          metadata: {
            actionId: supervisedAction,
            rejectReason: decision.rejectReason,
            targetRef: proposal.targetRef
          }
        });

        return json(response, httpStatusForPermissionReject(decision.rejectReason), {
          rejectReason: decision.rejectReason
        });
      }

      cleanupApprovalNonces();
      const existingIssued = listApprovalNoncesForTarget({
        actionId: supervisedAction,
        targetType: "proposal",
        targetId: proposal.targetRef,
        status: "issued"
      });

      if (existingIssued.some((row) => row.approverId === operatorId)) {
        return json(response, 409, {
          rejectReason: "approver_already_signed",
          quorum: approvalQuorumForRows(existingIssued, proposal.requiredApprovals, quorumResolution)
        });
      }

      const token = issueApprovalToken({
        actionId: supervisedAction,
        targetType: "proposal",
        targetId: proposal.targetRef,
        approverId: operatorId
      });
      if (runbookId === "incident-quarantine" && !proposal.quorumResolution) {
        proposal.quorumResolution = quorumResolution;
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "oc.approval.quorum_resolved",
          targetType: "proposal",
          targetId: proposal.id,
          riskLevel: "medium",
          decision: "n/a",
          metadata: {
            runbookId,
            mode: "mode" in quorumResolution ? quorumResolution.mode : "static",
            requiredApprovals: quorumResolution.requiredApprovals,
            serverTime: "serverTime" in quorumResolution ? quorumResolution.serverTime : null,
            operatorLocalHour: "operatorLocalHour" in quorumResolution ? quorumResolution.operatorLocalHour : null
          }
        });
      } else {
        proposal.quorumResolution ??= quorumResolution;
      }
      const issued = listApprovalNoncesForTarget({
        actionId: supervisedAction,
        targetType: "proposal",
        targetId: proposal.targetRef,
        status: "issued"
      });
      const quorum = approvalQuorumForRows(issued, proposal.requiredApprovals, quorumResolution);

      await auditLog.append({
        actorType: "operator",
        actorId: operatorId,
        action: "oc.proposal.approved",
        targetType: "proposal",
        targetId: proposal.id,
        riskLevel: "medium",
        metadata: {
          approvalTokenId: token.tokenId,
          actionId: supervisedAction,
          targetRef: proposal.targetRef
        }
      });
      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "oc.approval_token.issued",
        targetType: "approval_token",
        targetId: token.tokenId,
        riskLevel: "medium",
        metadata: {
          actionId: supervisedAction,
          approverId: operatorId,
          expiresAt: token.expiresAt
        }
      });

      if (quorum.reached) {
        const resolvedAt = new Date().toISOString();
        proposal.status = "resolved";
        proposal.resolution = {
          decision: "allow",
          resolvedAt,
          approverIds: quorum.approverIds
        };

        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "oc.approval.quorum_reached",
          targetType: "proposal",
          targetId: proposal.id,
          riskLevel: "medium",
          decision: "allow",
          humanApproved: true,
          approverIds: quorum.approverIds,
          metadata: {
            requiredApprovals: proposal.requiredApprovals,
            currentApprovals: quorum.current,
            runbookId,
            targetRef: proposal.targetRef
          }
        });
      }

      return json(response, 200, {
        approvalToken: token,
        quorum
      });
    }

    if (request.method === "POST" && requestUrl(request).pathname === "/v1/agent/runbook/execute") {
      const { raw, body } = await readRawBodyAndJson<RunbookExecuteRequest>(request);
      const auth = validateRunbookExecuteAuthorization(request, raw);

      if (!auth.ok) {
        return json(response, 401, {
          rejectReason: auth.rejectReason
        });
      }

      if (!body || !isNonEmptyString(body.proposalId) || !isNonEmptyString(body.runbookId)) {
        return json(response, 400, {
          rejectReason: "schema_mismatch"
        });
      }

      const proposal = proposalsStore.find((candidate) => candidate.id === body.proposalId);

      if (!proposal) {
        return json(response, 404, {
          rejectReason: "proposal_not_found"
        });
      }

      if (proposal.status !== "resolved") {
        return json(response, 409, {
          rejectReason: "proposal_not_resolved",
          currentStatus: proposal.status
        });
      }

      if (proposal.execution) {
        return json(response, 409, {
          rejectReason: "proposal_already_executed",
          execution: proposal.execution
        });
      }

      const runbookId = normalizeRunbookId(body.runbookId);
      const expectedRunbookId = getRunbookIdForProposal(proposal);

      if (!runbookId || runbookId !== expectedRunbookId) {
        return json(response, 400, {
          rejectReason: "unknown_runbook",
          runbookId: body.runbookId,
          expectedRunbookId
        });
      }

      const supervisedAction = supervisedActionForProposal(proposal);

      if (!supervisedAction) {
        return json(response, 400, {
          rejectReason: "proposal_has_no_supervised_action"
        });
      }

      cleanupApprovalNonces();
      const issued = listApprovalNoncesForTarget({
        actionId: supervisedAction,
        targetType: "proposal",
        targetId: proposal.targetRef,
        status: "issued"
      });
      const quorum = approvalQuorumForRows(issued, proposal.requiredApprovals);

      if (!quorum.reached) {
        return json(response, 401, {
          rejectReason: "human_approval_missing",
          quorum
        });
      }

      const tokenRows = selectTokenRowsForQuorum(issued, proposal.requiredApprovals);

      for (const row of tokenRows) {
        const validation = validateApprovalToken(
          reconstructApprovalToken(row),
          {
            actionId: supervisedAction,
            targetType: "proposal",
            targetId: proposal.targetRef
          }
        );

        if (!validation.ok) {
          return json(response, 401, {
            rejectReason: validation.rejectReason,
            tokenId: row.tokenId
          });
        }
      }

      const killSwitch = await killSwitchStore.get();
      const occurredAt = new Date().toISOString();
      const result = await dispatchRunbook(runbookId, body.input, proposal, {
        proposalId: proposal.id,
        approverIds: quorum.approverIds,
        killSwitchState: killSwitch.enabled ? "active" : "armed",
        occurredAt,
        repository: senderNodeRegistry,
        executionTracker: runbookExecutionStore,
        persistRollbackSnapshot: (input) => persistRollbackSnapshot(input).rollbackToken
      });

      if (!result.ok) {
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: result.rejectReason === "preconditions_failed"
            ? "oc.runbook.preconditions_failed"
            : `oc.runbook.${auditSlugForRunbook(runbookId)}.failed_partial`,
          targetType: "runbook",
          targetId: runbookId,
          riskLevel: "high",
          decision: "reject",
          humanApproved: true,
          approverIds: quorum.approverIds,
          killSwitchState: killSwitch.enabled ? "active" : "armed",
          metadata: {
            proposalId: proposal.id,
            detail: result.detail,
            rejectReason: result.rejectReason
          }
        });

        return json(response, 409, {
          rejectReason: result.rejectReason,
          detail: result.detail
        });
      }

      const rollbackSnapshot = getRollbackSnapshot(result.rollbackToken);
      const rollbackExpiresAt = rollbackSnapshot?.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      proposal.execution = {
        executedAt: occurredAt,
        runbookId,
        rollbackToken: result.rollbackToken,
        rollbackExpiresAt,
        newState: result.newState
      };

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: result.auditAction,
        targetType: "runbook",
        targetId: runbookId,
        riskLevel: runbookId === "pause-ip" || runbookId === "incident-quarantine" ? "high" : "medium",
        decision: "allow",
        humanApproved: true,
        approverIds: quorum.approverIds,
        killSwitchState: killSwitch.enabled ? "active" : "armed",
        rollbackToken: result.rollbackToken,
        metadata: {
          proposalId: proposal.id,
          targetRef: proposal.targetRef,
          prevState: result.prevState,
          newState: result.newState,
          rollbackExpiresAt
        }
      });

      if (runbookId === "incident-quarantine" && !process.env.NOTION_API_KEY) {
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "oc.quarantine.notion_skipped",
          targetType: "runbook",
          targetId: runbookId,
          riskLevel: "medium",
          decision: "n/a",
          metadata: {
            reason: "NOTION_API_KEY ausente; tarjeta critica Notion omitida.",
            decisionFile: ".audit/decision-skip-notion-side-effect.md",
            proposalId: proposal.id,
            nodeId: isRecord(body.input) && isNonEmptyString(body.input.nodeId) ? body.input.nodeId : proposal.targetRef
          }
        });
      }

      return json(response, 200, {
        runbookId,
        rollbackToken: result.rollbackToken,
        rollbackExpiresAt,
        newState: result.newState
      });
    }

    if (request.method === "POST" && requestUrl(request).pathname === "/v1/agent/runbook/revert") {
      const operatorId = request.headers["x-operator-id"];

      if (!isNonEmptyString(operatorId) || !operatorId.startsWith("op-")) {
        return json(response, 401, {
          rejectReason: "operator_unauthenticated"
        });
      }

      const { body } = await readRawBodyAndJson<RunbookRevertRequest>(request);

      if (!body || !isNonEmptyString(body.rollbackToken) || !isNonEmptyString(body.reason)) {
        return json(response, 400, {
          rejectReason: "schema_mismatch"
        });
      }

      const snapshot = getRollbackSnapshot(body.rollbackToken);

      if (!snapshot) {
        return json(response, 404, {
          rejectReason: "rollback_token_not_found"
        });
      }

      if (snapshot.status !== "available") {
        return json(response, 409, {
          rejectReason: snapshot.status === "expired" ? "rollback_token_expired" : "rollback_token_consumed"
        });
      }

      const targetStatus = normalizeQuarantineTargetStatus(body.metadata?.targetStatus);
      const defaultedTargetStatus = snapshot.runbookId === "incident-quarantine" && !body.metadata?.targetStatus;
      if (snapshot.runbookId === "incident-quarantine" && body.metadata?.targetStatus && !targetStatus) {
        return json(response, 400, {
          rejectReason: "invalid_target_status",
          validValues: ["active", "retired", "quarantined"]
        });
      }
      const nodeBeforeRevert = await senderNodeRegistry.get(snapshot.targetId);
      const revertSnapshot = nodeBeforeRevert
        ? persistRollbackSnapshot({
            runbookId: `${snapshot.runbookId}-revert`,
            targetType: "sender_node",
            targetId: snapshot.targetId,
            prevStateJson: JSON.stringify({
              status: nodeBeforeRevert.status,
              warmupDay: nodeBeforeRevert.warmupDay,
              dailyLimit: nodeBeforeRevert.dailyLimit
            })
          })
        : null;
      const result = await revertRunbook({
        snapshot,
        repository: senderNodeRegistry,
        metadata: snapshot.runbookId === "incident-quarantine" ? { targetStatus: targetStatus ?? undefined } : undefined
      });

      if (!result.ok) {
        return json(response, 409, {
          rejectReason: result.rejectReason,
          detail: result.detail
        });
      }

      if (!consumeRollbackSnapshot(body.rollbackToken)) {
        return json(response, 409, {
          rejectReason: "rollback_token_replay_detected"
        });
      }

      await auditLog.append({
        actorType: "operator",
        actorId: operatorId,
        action: `oc.runbook.${auditSlugForRunbook(snapshot.runbookId)}.reverted`,
        targetType: "sender_node",
        targetId: snapshot.targetId,
        riskLevel: "high",
        decision: "allow",
        humanApproved: true,
        approverIds: [operatorId],
        rollbackToken: body.rollbackToken,
        metadata: {
          reason: body.reason,
          restoredState: result.restoredState,
          newState: result.newState,
          rollbackToken: body.rollbackToken,
          revertRollbackToken: revertSnapshot?.rollbackToken ?? null,
          targetStatus: snapshot.runbookId === "incident-quarantine" ? targetStatus ?? "active" : null,
          defaultedTargetStatus,
          newStatus: isRecord(result.newState) && typeof result.newState.status === "string" ? result.newState.status : null
        }
      });

      return json(response, 200, {
        reverted: true,
        restoredState: result.restoredState,
        newState: result.newState,
        revertRollbackToken: revertSnapshot?.rollbackToken ?? null
      });
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/live-canvas") {
      const now = new Date();
      const physicalHost = buildPhysicalHostSnapshot({ now });
      const telemetry = buildHardwareTelemetrySnapshot({ now });
      const onboardingState = buildOpenClawOnboardingState({
        snapshot: evaluateOpenClawOnboarding({
          actorId: "openclaw-read-model"
        }, now),
        now
      });
      const provisioningState = buildOpenClawProvisioningState({ now });
      const readinessSignals = buildOpenClawReadinessSignals({
        physicalHost,
        telemetry,
        now
      });
      const collector = buildDevOpsCollectorStatus({ now });

      return json(response, 200, {
        canvas: buildOpenClawLiveCanvas({
          physicalHost,
          telemetry,
          onboardingState,
          provisioningState,
          readinessSignals,
          collector,
          promptOverride: getActiveAgentProposalPrompt(now),
          now
        })
      });
    }

    if (request.method === "POST" && request.url === "/v1/nfc/bridge/capacity-plan") {
      const body = await readOptionalJson<{
        senderNodeIds?: string[];
        actorId?: string;
        providerNamePrefix?: string;
        emailFromName?: string;
        emailsPerMinute?: number;
      }>(request);
      const nodes = await senderNodeRegistry.list();
      const selectedNodeIds = body?.senderNodeIds?.filter(Boolean) ?? [];
      const selectedNodes = selectedNodeIds.length > 0
        ? nodes.filter((node) => selectedNodeIds.includes(node.id))
        : nodes;
      const missingNodeIds = selectedNodeIds.filter((id) => !nodes.some((node) => node.id === id));

      if (missingNodeIds.length > 0) {
        return json(response, 422, {
          error: "unknown_sender_nodes",
          missingNodeIds
        });
      }

      const plan = buildNfcBridgeCapacityPlan({
        senderNodes: selectedNodes,
        actorId: body?.actorId,
        providerNamePrefix: body?.providerNamePrefix,
        emailFromName: body?.emailFromName,
        emailsPerMinute: body?.emailsPerMinute
      });

      await auditLog.append({
        actorType: "operator",
        actorId: plan.actorId,
        action: "nfc_bridge.capacity_plan_generated",
        targetType: "nfc_bridge_plan",
        targetId: plan.id,
        riskLevel: plan.summary.blocked > 0 || plan.summary.needsReview > 0 ? "medium" : "low",
        metadata: {
          dryRun: true,
          nfcProductionWritesEnabled: false,
          providersToCreate: plan.summary.providersToCreate,
          smtpServersToCreate: plan.summary.smtpServersToCreate,
          blockedOperations: plan.blockedOperations
        }
      });

      return json(response, 200, plan);
    }

    if (request.method === "GET" && requestUrl(request).pathname === "/v1/audit-events") {
      const url = requestUrl(request);
      const limit = Number(url.searchParams.get("limit"));
      const events = await auditLog.list();
      return json(response, 200, {
        events: Number.isFinite(limit) && limit > 0 ? events.slice(-limit) : events
      });
    }

    if (request.method === "GET" && requestUrl(request).pathname === "/v1/audit-chain/verify") {
      const result = await auditChainStore.verify();
      const { sourcePath: _sourcePath, ...publicResult } = result;
      return json(response, result.ok ? 200 : 422, publicResult);
    }

    if (request.method === "GET" && requestUrl(request).pathname === "/v1/audit-chain/anchor") {
      const verify = await auditChainStore.verify();
      try {
        return json(response, 200, buildAuditChainAnchor({
          verify,
          key: process.env.AUDIT_ANCHOR_KEY ?? process.env.OPENCLAW_HMAC_SECRET
        }));
      } catch (error) {
        if (error instanceof AuditChainAnchorError) {
          return json(response, error.statusCode, {
            ok: false,
            error: error.message,
            ...(verify.ok ? {} : { verify })
          });
        }
        throw error;
      }
    }

    if (request.method === "GET" && request.url === "/v1/send-jobs") {
      return json(response, 200, {
        jobs: await sendQueue.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/send-results") {
      return json(response, 200, {
        results: await sendResultStore.list()
      });
    }

    if (request.method === "POST" && request.url === "/v1/send-results/ingest") {
      const body = await readJson<{
        sendJobId?: string;
        senderNodeId?: string;
        status?: SendResultStatus;
        smtpResponse?: string;
        bounceCode?: string;
        complaintSource?: string;
        source?: string;
        actorId?: string;
        metadata?: Record<string, unknown>;
      }>(request);

      if (!body.sendJobId?.trim() || !body.status) {
        return json(response, 422, {
          error: "invalid_send_result_ingestion_payload",
          message: "sendJobId and status are required."
        });
      }

      const jobs = await sendQueue.list();
      const senderNodes = await senderNodeRegistry.list();
      const job = jobs.find((candidate) => candidate.id === body.sendJobId);
      const resolvedSenderNodeId = body.senderNodeId ?? job?.senderNodeId;
      const senderNode = resolvedSenderNodeId
        ? senderNodes.find((candidate) => candidate.id === resolvedSenderNodeId)
        : undefined;
      const decision = evaluateSendResultIngestion({
        sendJobId: body.sendJobId,
        senderNodeId: body.senderNodeId,
        status: body.status,
        smtpResponse: body.smtpResponse,
        bounceCode: body.bounceCode,
        complaintSource: body.complaintSource,
        source: body.source,
        metadata: body.metadata
      }, {
        job,
        senderNode
      });
      const actorId = body.actorId?.trim() || "mock-ingestion";

      if (!decision.allowed || !decision.normalizedStatus || !decision.senderNodeId) {
        await auditLog.append({
          actorType: body.actorId ? "operator" : "system",
          actorId,
          action: "send_result.ingestion_rejected",
          targetType: "send_job",
          targetId: body.sendJobId,
          riskLevel: decision.riskLevel,
          metadata: {
            decision,
            payloadStatus: body.status,
            smtpEnabled: false
          }
        });

        return json(response, 422, {
          allowed: false,
          decision
        });
      }

      const result = await sendResultStore.create({
        sendJobId: decision.sendJobId,
        senderNodeId: decision.senderNodeId,
        status: decision.normalizedStatus,
        smtpResponse: body.smtpResponse,
        bounceCode: body.bounceCode,
        complaintSource: body.complaintSource,
        metadata: {
          ...(body.metadata ?? {}),
          ingested: true,
          source: body.source ?? "mock-ingestion"
        }
      });
      const suppressionEntry = decision.suppression
        ? await suppressionList.add(decision.suppression)
        : undefined;

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId,
        action: "send_result.ingested",
        targetType: "send_result",
        targetId: result.id,
        riskLevel: decision.riskLevel,
        metadata: {
          decision,
          sendJobId: result.sendJobId,
          senderNodeId: result.senderNodeId,
          status: result.status,
          suppressionEntry,
          smtpEnabled: false,
          sideEffects: "local-state-only"
        }
      });

      return json(response, 201, {
        allowed: true,
        result,
        suppressionEntry,
        decision
      });
    }

    if (request.method === "GET" && request.url === "/v1/suppression-entries") {
      return json(response, 200, {
        entries: await suppressionList.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/sender-nodes") {
      return json(response, 200, {
        nodes: await senderNodeRegistry.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/sender-pool/status") {
      const { status, body } = await handleSenderPoolStatusHttp({
        workspace: openClawWorkspace
      });
      return json(response, status, body as Record<string, unknown>);
    }

    if (request.method === "GET" && request.url === "/v1/provisioning-runs") {
      return json(response, 200, {
        runs: await provisioningRunStore.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/ip-reputation/reports") {
      return json(response, 200, {
        reports: evaluateIpReputation(
          await senderNodeRegistry.list(),
          await sendResultStore.list()
        )
      });
    }

    if (request.method === "GET" && request.url === "/v1/ip-reputation/history") {
      return json(response, 200, {
        reports: await ipReputationReportStore.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/backups/simulations") {
      return json(response, 200, {
        simulations: await backupSimulationStore.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/rate-limit-counters") {
      return json(response, 200, {
        counters: await rateLimitStore.list()
      });
    }

    if (request.method === "GET" && request.url === "/v1/operational-summary") {
      const summary = buildOperationalSummary({
        jobs: await sendQueue.list(),
        sendResults: await sendResultStore.list(),
        auditEvents: await auditLog.list(),
        senderNodes: await senderNodeRegistry.list(),
        rateLimitCounters: await rateLimitStore.list()
      });

      return json(response, 200, {
        summary
      });
    }

    if (request.method === "GET" && request.url === "/v1/admin/overview") {
      const jobs = await sendQueue.list();
      const sendResults = await sendResultStore.list();
      const auditEvents = await auditLog.list();
      const senderNodes = await senderNodeRegistry.list();
      const rateLimitCounters = await rateLimitStore.list();
      const killSwitch = await killSwitchStore.get();
      const summary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters
      });
      const health = evaluateSenderNodeHealth(senderNodes, sendResults);
      const overview = buildAdminOverview({
        summary,
        health,
        auditEvents,
        killSwitch
      });

      return json(response, 200, {
        overview
      });
    }

    if (request.method === "GET" && request.url === "/v1/admin/workflow") {
      const jobs = await sendQueue.list();
      const sendResults = await sendResultStore.list();
      const auditEvents = await auditLog.list();
      const senderNodes = await senderNodeRegistry.list();
      const rateLimitCounters = await rateLimitStore.list();
      const killSwitch = await killSwitchStore.get();
      const summary = buildOperationalSummary({
        jobs,
        sendResults,
        auditEvents,
        senderNodes,
        rateLimitCounters
      });
      const health = evaluateSenderNodeHealth(senderNodes, sendResults);
      const overview = buildAdminOverview({
        summary,
        health,
        auditEvents,
        killSwitch
      });
      const workflow = buildAdminPanelWorkflow({
        overview,
        operatingNorth: getOperatingNorthSnapshot(),
        killSwitch
      });

      return json(response, 200, {
        workflow
      });
    }

    if (request.method === "GET" && request.url === "/v1/admin/clusters") {
      const senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();
      const health = evaluateSenderNodeHealth(senderNodes, sendResults);
      const clusterOverview = buildAdminClusterOverview({
        senderNodes,
        health,
        provisioningRuns: await provisioningRunStore.list(),
        killSwitch: await killSwitchStore.get()
      });

      return json(response, 200, {
        clusterOverview
      });
    }

    if (request.method === "GET" && request.url === "/v1/openclaw/learning-plan") {
      const learningPlan = buildOpenClawLearningPlan({
        auditEvents: await auditLog.list(),
        provisioningRuns: await provisioningRunStore.list(),
        sendResults: await sendResultStore.list()
      });

      return json(response, 200, {
        learningPlan
      });
    }

    if (request.method === "GET" && request.url === "/v1/admin/phase-3-overview") {
      const senderNodes = await senderNodeRegistry.list();
      const sendResults = await sendResultStore.list();

      return json(response, 200, {
        overview: {
          generatedAt: new Date().toISOString(),
          phase: "infraestructura-propia-piloto",
          proxmox: proxmoxAdapter.describeCapabilities(),
          provisioningRuns: await provisioningRunStore.list(),
          currentIpReputation: evaluateIpReputation(senderNodes, sendResults),
          ipReputationHistory: await ipReputationReportStore.list(),
          backupSimulations: await backupSimulationStore.list(),
          humanActions: [
            "pause",
            "reactivate",
            "degrade",
            "quarantine",
            "approve-retirement",
            "activate-kill-switch"
          ],
          safety: {
            smtpEnabled: false,
            proxmoxApiEnabled: false,
            sshEnabled: false,
            sideEffects: "local-state-only"
          }
        }
      });
    }

    if (request.method === "GET" && request.url === "/v1/kill-switch") {
      return json(response, 200, {
        killSwitch: await killSwitchStore.get()
      });
    }

    if (request.method === "POST" && request.url === "/v1/kill-switch") {
      const body = await readJson<{
        enabled?: unknown;
        reason?: string;
        actorId?: string;
      }>(request);

      if (typeof body.enabled !== "boolean") {
        return json(response, 422, {
          error: "invalid_kill_switch_payload",
          message: "enabled must be a boolean."
        });
      }

      if (body.enabled && !body.reason?.trim()) {
        return json(response, 422, {
          error: "kill_switch_reason_required",
          message: "reason is required when enabling kill switch."
        });
      }

      const previous = await killSwitchStore.get();
      const killSwitch = await killSwitchStore.update({
        enabled: body.enabled,
        reason: body.reason,
        updatedBy: body.actorId ?? "gateway-api"
      });

      await auditLog.append({
        actorType: body.actorId ? "operator" : "system",
        actorId: body.actorId ?? "gateway-api",
        action: killSwitch.enabled ? "kill_switch.activated" : "kill_switch.deactivated",
        targetType: "operation",
        targetId: "global_send_pipeline",
        riskLevel: killSwitch.enabled ? "critical" : "high",
        metadata: {
          previous,
          current: killSwitch,
          smtpEnabled: false
        }
      });

      return json(response, 200, {
        killSwitch
      });
    }

    if (request.method === "GET" && requestUrl(request).pathname === "/v1/stuck-jobs") {
      const staleAfterMs = parseStaleAfterMs(
        requestUrl(request).searchParams.get("staleAfterMs"),
        defaultStuckJobThresholdMs
      );

      if (staleAfterMs === null) {
        return json(response, 422, {
          error: "invalid_stale_after_ms",
          message: "staleAfterMs must be a positive number."
        });
      }

      const generatedAt = new Date();
      const stuckJobs = await sendQueue.listStuckProcessingJobs(staleAfterMs, generatedAt);

      return json(response, 200, {
        generatedAt: generatedAt.toISOString(),
        staleAfterMs,
        count: stuckJobs.length,
        stuckJobs
      });
    }

    if (request.method === "POST" && requestUrl(request).pathname === "/v1/stuck-jobs/recover") {
      const body = await readOptionalJson<{
        action?: StuckJobRecoveryAction;
        staleAfterMs?: number;
        reason?: string;
      }>(request);
      const action = body?.action ?? "fail";

      if (!isStuckJobRecoveryAction(action)) {
        return json(response, 422, {
          error: "invalid_recovery_action",
          message: "action must be fail or requeue."
        });
      }

      const staleAfterMs = parseStaleAfterMs(body?.staleAfterMs, defaultStuckJobThresholdMs);

      if (staleAfterMs === null) {
        return json(response, 422, {
          error: "invalid_stale_after_ms",
          message: "staleAfterMs must be a positive number."
        });
      }

      const report = await sendQueue.recoverStuckProcessingJobs({
        action,
        staleAfterMs,
        reason: body?.reason
      });

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "send_jobs.stuck_recovered",
        targetType: "send_job",
        targetId: "stuck-processing",
        riskLevel: report.recovered.length > 0 ? "medium" : "low",
        metadata: {
          action,
          staleAfterMs,
          detectedCount: report.detected.length,
          recoveredCount: report.recovered.length,
          recoveredJobIds: report.recovered.map((job) => job.id),
          smtpEnabled: false
        }
      });

      return json(response, 200, {
        report
      });
    }

    if (request.method === "GET" && request.url === "/v1/sender-node-health") {
      const decisions = evaluateSenderNodeHealth(
        await senderNodeRegistry.list(),
        await sendResultStore.list()
      );

      return json(response, 200, {
        decisions
      });
    }

    if (request.method === "POST" && request.url === "/v1/sender-node-health/reconcile") {
      const decisions = evaluateSenderNodeHealth(
        await senderNodeRegistry.list(),
        await sendResultStore.list()
      );
      const applied = [];

      for (const decision of decisions) {
        if (decision.currentStatus === decision.recommendedStatus) {
          continue;
        }

        const node = await senderNodeRegistry.updateStatus(decision.senderNodeId, decision.recommendedStatus);
        applied.push({
          senderNodeId: node.id,
          previousStatus: decision.currentStatus,
          currentStatus: node.status,
          severity: decision.severity,
          reasons: decision.reasons
        });
      }

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "sender_node_health.reconciled",
        targetType: "sender_node",
        targetId: "all",
        riskLevel: applied.length > 0 ? "medium" : "low",
        metadata: {
          appliedCount: applied.length,
          applied
        }
      });

      return json(response, 200, {
        applied,
        decisions
      });
    }

    if (request.method === "POST" && request.url === "/v1/ip-reputation/reconcile") {
      const body = await readOptionalJson<{
        actorId?: string;
        signals?: IpReputationExternalSignal[];
        apply?: boolean;
      }>(request);
      const actorId = body?.actorId?.trim() || "gateway-api";
      const reports = evaluateIpReputation(
        await senderNodeRegistry.list(),
        await sendResultStore.list(),
        Array.isArray(body?.signals) ? body.signals : []
      );
      await ipReputationReportStore.appendMany(reports);

      const applied = [];
      const shouldApply = body?.apply !== false;

      if (shouldApply) {
        for (const report of reports) {
          if (report.currentStatus === report.recommendedStatus) {
            continue;
          }

          const node = await senderNodeRegistry.updateStatus(report.senderNodeId, report.recommendedStatus);
          applied.push({
            senderNodeId: node.id,
            previousStatus: report.currentStatus,
            currentStatus: node.status,
            state: report.state,
            recommendedAction: report.recommendedAction,
            signals: report.signals
          });
        }
      }

      await auditLog.append({
        actorType: body?.actorId ? "operator" : "system",
        actorId,
        action: "ip_reputation.reconciled",
        targetType: "sender_node",
        targetId: "all",
        riskLevel: applied.some((item) => item.currentStatus === "quarantined") ? "critical" : applied.length > 0 ? "high" : "low",
        metadata: {
          reportsGenerated: reports.length,
          appliedCount: applied.length,
          applied,
          apply: shouldApply,
          sideEffects: "local-state-only",
          smtpEnabled: false
        }
      });

      return json(response, 200, {
        applied,
        reports
      });
    }

    const retirementApprovalRoute = parseSenderNodeRetirementApprovalRoute(request);

    if (request.method === "POST" && retirementApprovalRoute) {
      const body = await readJson<{
        reason?: string;
        actorId?: string;
      }>(request);
      const nodes = await senderNodeRegistry.list();
      const node = nodes.find((candidate) => candidate.id === retirementApprovalRoute.senderNodeId);

      if (!node) {
        return json(response, 404, {
          error: "sender_node_not_found",
          message: `Sender node not found: ${retirementApprovalRoute.senderNodeId}`
        });
      }

      const decision = evaluateSenderNodeRetirementApproval({
        node,
        reason: body.reason
      });
      const actorId = body.actorId?.trim() || "local-operator";

      if (!decision.allowed || !decision.nextStatus) {
        await auditLog.append({
          actorType: "operator",
          actorId,
          action: decision.auditAction,
          targetType: "sender_node",
          targetId: node.id,
          riskLevel: decision.riskLevel,
          metadata: {
            reason: decision.reason ?? body.reason,
            currentStatus: decision.currentStatus,
            code: decision.code,
            message: decision.message,
            smtpEnabled: false
          }
        });

        return json(response, 422, {
          allowed: false,
          decision
        });
      }

      const updatedNode = await senderNodeRegistry.updateStatus(node.id, decision.nextStatus);

      await auditLog.append({
        actorType: "operator",
        actorId,
        action: decision.auditAction,
        targetType: "sender_node",
        targetId: node.id,
        riskLevel: decision.riskLevel,
        metadata: {
          reason: decision.reason,
          previousStatus: node.status,
          currentStatus: updatedNode.status,
          provider: node.provider,
          smtpEnabled: false,
          sideEffects: "local-state-only"
        }
      });

      return json(response, 200, {
        allowed: true,
        node: updatedNode,
        decision
      });
    }

    const senderNodeControlRoute = parseSenderNodeControlRoute(request);

    if (request.method === "POST" && senderNodeControlRoute) {
      if (!isSenderNodeManualAction(senderNodeControlRoute.action)) {
        return json(response, 422, {
          error: "invalid_sender_node_manual_action",
          message: "action must be pause, reactivate, degrade, or quarantine."
        });
      }

      const body = await readJson<{
        reason?: string;
        actorId?: string;
      }>(request);
      const nodes = await senderNodeRegistry.list();
      const node = nodes.find((candidate) => candidate.id === senderNodeControlRoute.senderNodeId);

      if (!node) {
        return json(response, 404, {
          error: "sender_node_not_found",
          message: `Sender node not found: ${senderNodeControlRoute.senderNodeId}`
        });
      }

      const decision = evaluateSenderNodeManualControl({
        node,
        action: senderNodeControlRoute.action,
        reason: body.reason
      });
      const actorId = body.actorId?.trim() || "local-operator";

      if (!decision.allowed || !decision.nextStatus) {
        await auditLog.append({
          actorType: "operator",
          actorId,
          action: decision.auditAction,
          targetType: "sender_node",
          targetId: node.id,
          riskLevel: decision.riskLevel,
          metadata: {
            action: decision.action,
            reason: decision.reason ?? body.reason,
            currentStatus: decision.currentStatus,
            code: decision.code,
            message: decision.message,
            smtpEnabled: false
          }
        });

        return json(response, 422, {
          allowed: false,
          decision
        });
      }

      const updatedNode = await senderNodeRegistry.updateStatus(node.id, decision.nextStatus);

      await auditLog.append({
        actorType: "operator",
        actorId,
        action: decision.auditAction,
        targetType: "sender_node",
        targetId: node.id,
        riskLevel: decision.riskLevel,
        metadata: {
          action: decision.action,
          reason: decision.reason,
          previousStatus: node.status,
          currentStatus: updatedNode.status,
          provider: node.provider,
          smtpEnabled: false,
          sideEffects: "local-state-only"
        }
      });

      return json(response, 200, {
        allowed: true,
        node: updatedNode,
        decision
      });
    }

    if (request.method === "POST" && request.url === "/v1/sender-nodes") {
      const body = await readJson<RegisterSenderNodeInput>(request);
      const node = await senderNodeRegistry.register(body);

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "sender_node.registered",
        targetType: "sender_node",
        targetId: node.id,
        riskLevel: "medium",
        metadata: {
          provider: node.provider,
          status: node.status,
          dailyLimit: node.dailyLimit
        }
      });

      return json(response, 201, {
        node
      });
    }

    if (request.method === "POST" && request.url === "/v1/webdock/bridge-nodes/seed") {
      const { raw, body } = await readRawBodyAndJson<{ nodes: WebdockBridgeNodeConfig[] } | WebdockBridgeNodeConfig[]>(request);
      const auth = validateGatewayMutationHmac(request, raw);

      if (!auth.ok) {
        return json(response, 401, {
          rejectReason: auth.rejectReason
        });
      }

      const configs = Array.isArray(body) ? body : body?.nodes;
      const actorId = operatorIdFromRequest(request) ?? "openclaw-hmac";

      if (!Array.isArray(configs)) {
        return json(response, 422, {
          error: "invalid_webdock_seed_payload",
          message: "Expected an array or an object with a nodes array."
        });
      }

      const nodes = [];
      for (const config of configs) {
        const node = await senderNodeRegistry.register(webdockAdapter.toSenderNodeInput(config));
        nodes.push({
          ...node,
          capabilities: webdockAdapter.describeCapabilities(node)
        });
      }

      await auditLog.append({
        actorType: "operator",
        actorId,
        action: "webdock_bridge_nodes.seeded",
        targetType: "sender_node",
        targetId: "webdock",
        riskLevel: "medium",
        metadata: {
          count: nodes.length,
          sideEffects: "none",
          smtpEnabledByPlatform: false
        }
      });

      return json(response, 201, {
        nodes
      });
    }

    if (request.method === "POST" && request.url === "/v1/proxmox/provisioning-plan") {
      const { raw, body } = await readRawBodyAndJson<ProxmoxMockNodeConfig & { actorId?: string }>(request);
      const auth = validateGatewayMutationHmac(request, raw);

      if (!auth.ok) {
        return json(response, 401, {
          rejectReason: auth.rejectReason
        });
      }

      if (!body) {
        return json(response, 422, {
          error: "invalid_proxmox_plan_payload",
          message: "Expected a provisioning plan payload."
        });
      }

      const actorId = body.actorId?.trim() || (operatorIdFromRequest(request) ?? "openclaw-hmac");
      const plan = tryBuild(response, () => proxmoxAdapter.planProvisioning(body));

      if (!plan) {
        return;
      }

      await auditLog.append({
        actorType: "operator",
        actorId,
        action: "proxmox.provisioning_plan_created",
        targetType: "sender_node",
        targetId: plan.targetSenderNode.id,
        riskLevel: "medium",
        metadata: {
          planId: plan.id,
          provider: "proxmox",
          dryRun: plan.dryRun,
          sideEffects: plan.sideEffects,
          blockedOperations: plan.blockedOperations,
          smtpEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false
        }
      });

      return json(response, 201, {
        plan,
        capabilities: proxmoxAdapter.describeCapabilities()
      });
    }

    if (request.method === "POST" && request.url === "/v1/proxmox/provisioning-runs/simulate") {
      const { raw, body } = await readRawBodyAndJson<{
        node?: ProxmoxMockNodeConfig;
        registerSenderNode?: boolean;
        actorId?: string;
      } & ProxmoxMockNodeConfig>(request);
      const auth = validateGatewayMutationHmac(request, raw);

      if (!auth.ok) {
        return json(response, 401, {
          rejectReason: auth.rejectReason
        });
      }

      if (!body) {
        return json(response, 422, {
          error: "invalid_proxmox_simulation_payload",
          message: "Expected a provisioning simulation payload."
        });
      }

      const config = body.node ?? body;
      const actorId = body.actorId?.trim() || (operatorIdFromRequest(request) ?? "openclaw-hmac");
      const plan = tryBuild(response, () => proxmoxAdapter.planProvisioning(config));

      if (!plan) {
        return;
      }

      const shouldRegisterSenderNode = body.registerSenderNode !== false;
      const node = shouldRegisterSenderNode
        ? await senderNodeRegistry.register(plan.targetSenderNode)
        : undefined;
      const run = await provisioningRunStore.append(
        proxmoxAdapter.simulateProvisioning(plan, node?.id)
      );

      await auditLog.append({
        actorType: "operator",
        actorId,
        action: "proxmox.provisioning_run_simulated",
        targetType: "sender_node",
        targetId: plan.targetSenderNode.id,
        riskLevel: "medium",
        metadata: {
          runId: run.id,
          planId: plan.id,
          registeredSenderNodeId: node?.id,
          completedSteps: run.summary.completedSteps,
          sideEffects: run.sideEffects,
          smtpEnabled: false,
          proxmoxApiEnabled: false,
          sshEnabled: false
        }
      });

      return json(response, 201, {
        run,
        node: node
          ? {
            ...node,
            capabilities: proxmoxAdapter.describeCapabilities(node)
          }
          : undefined
      });
    }

    if (request.method === "POST" && request.url === "/v1/proxmox/mock-nodes/seed") {
      const { raw, body } = await readRawBodyAndJson<{
        nodes?: ProxmoxMockNodeConfig[];
        actorId?: string;
      } | ProxmoxMockNodeConfig[]>(request);
      const auth = validateGatewayMutationHmac(request, raw);

      if (!auth.ok) {
        return json(response, 401, {
          rejectReason: auth.rejectReason
        });
      }

      const configs = Array.isArray(body) ? body : body?.nodes;
      const actorId = Array.isArray(body)
        ? (operatorIdFromRequest(request) ?? "openclaw-hmac")
        : body?.actorId?.trim() || (operatorIdFromRequest(request) ?? "openclaw-hmac");

      if (!Array.isArray(configs)) {
        return json(response, 422, {
          error: "invalid_proxmox_seed_payload",
          message: "Expected an array or an object with a nodes array."
        });
      }

      const nodes = [];
      const runs = [];

      for (const config of configs) {
        const plan = tryBuild(response, () => proxmoxAdapter.planProvisioning(config));

        if (!plan) {
          return;
        }

        const node = await senderNodeRegistry.register(plan.targetSenderNode);
        const run = await provisioningRunStore.append(
          proxmoxAdapter.simulateProvisioning(plan, node.id)
        );

        nodes.push({
          ...node,
          capabilities: proxmoxAdapter.describeCapabilities(node)
        });
        runs.push(run);
      }

      await auditLog.append({
        actorType: Array.isArray(body) ? "system" : body.actorId ? "operator" : "system",
        actorId,
        action: "proxmox_mock_nodes.seeded",
        targetType: "sender_node",
        targetId: "proxmox",
        riskLevel: "medium",
        metadata: {
          count: nodes.length,
          runIds: runs.map((run) => run.id),
          sideEffects: "local-state-only",
          smtpEnabledByPlatform: false,
          proxmoxApiEnabled: false,
          sshEnabled: false
        }
      });

      return json(response, 201, {
        nodes,
        runs
      });
    }

    if (request.method === "POST" && request.url === "/v1/backups/plan") {
      const body = await readOptionalJson<BackupPlanInput>(request);
      const plan = tryBuild(response, () => buildBackupPlan(body ?? {}));

      if (!plan) {
        return;
      }

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "backup.plan_created",
        targetType: "backup",
        targetId: plan.id,
        riskLevel: "medium",
        metadata: {
          target: plan.target,
          resources: plan.resources,
          dryRun: plan.dryRun,
          sideEffects: plan.sideEffects,
          blockedOperations: plan.blockedOperations
        }
      });

      return json(response, 201, {
        plan
      });
    }

    if (request.method === "POST" && request.url === "/v1/backups/simulate") {
      const body = await readOptionalJson<BackupPlanInput>(request);
      const plan = tryBuild(response, () => buildBackupPlan(body ?? {}));

      if (!plan) {
        return;
      }

      const simulation = await backupSimulationStore.append(
        simulateBackup(plan, await backupSnapshots(plan.resources))
      );

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "backup.simulated",
        targetType: "backup",
        targetId: simulation.id,
        riskLevel: simulation.status === "blocked" ? "high" : "medium",
        metadata: {
          planId: plan.id,
          status: simulation.status,
          snapshots: simulation.snapshots,
          warnings: simulation.warnings,
          dryRun: simulation.dryRun,
          sideEffects: simulation.sideEffects
        }
      });

      return json(response, 201, {
        simulation
      });
    }

    if (request.method === "POST" && request.url === "/v1/suppression-entries") {
      const body = await readJson<{
        email: string;
        reason: SuppressionReason;
        source: string;
      }>(request);

      const entry = await suppressionList.add({
        email: body.email,
        reason: body.reason,
        source: body.source
      });

      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "suppression_entry.created",
        targetType: "suppression_entry",
        targetId: entry.email,
        riskLevel: "medium",
        metadata: {
          reason: entry.reason,
          source: entry.source
        }
      });

      return json(response, 201, {
        entry
      });
    }

    if (request.method === "POST" && request.url === "/v1/send-requests") {
      const body = await readJson<SendRequest>(request);
      const killSwitchDecision = evaluateKillSwitch(await killSwitchStore.get(), "accept_send_request");

      if (!killSwitchDecision.allowed) {
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "send_request.blocked_by_kill_switch",
          targetType: "campaign",
          targetId: body.campaignId ?? "unknown",
          riskLevel: "critical",
          metadata: {
            recipient: body.recipient?.email,
            decision: killSwitchDecision,
            smtpEnabled: false
          }
        });

        return json(response, 423, {
          allowed: false,
          reason: "kill_switch_active",
          message: killSwitchDecision.message,
          killSwitch: killSwitchDecision.state
        });
      }

      const decision = await policyEngine.evaluate(body);

      if (!decision.allowed) {
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "send_request.rejected",
          targetType: "campaign",
          targetId: body.campaignId ?? "unknown",
          riskLevel: "medium",
          metadata: {
            violations: decision.violations,
            recipient: body.recipient?.email
          }
        });

        return json(response, 422, {
          allowed: false,
          violations: decision.violations,
          warnings: decision.warnings
        });
      }

      const rateLimitRules = requestRateLimitRules(body, requestRateLimitProfile);
      const rateLimitDecision = await rateLimitService.check(rateLimitRules);

      if (!rateLimitDecision.allowed) {
        await auditLog.append({
          actorType: "system",
          actorId: "gateway-api",
          action: "send_request.rate_limited",
          targetType: "campaign",
          targetId: body.campaignId,
          riskLevel: "medium",
          metadata: {
            violations: rateLimitDecision.violations,
            recipient: body.recipient.email
          }
        });

        return json(response, 429, {
          allowed: false,
          reason: "rate_limited",
          violations: rateLimitDecision.violations
        });
      }

      const job = await sendQueue.add(body);
      await auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "send_request.accepted",
        targetType: "send_job",
        targetId: job.id,
        riskLevel: "low",
        metadata: {
          campaignId: body.campaignId,
          recipient: body.recipient.email,
          classification: body.classification
        }
      });

      return json(response, 202, {
        allowed: true,
        job,
        warnings: decision.warnings
      });
    }

    return json(response, 404, {
      error: "not_found"
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json(response, error.statusCode, {
        error: error.code,
        message: error.message,
        maxBytes: error.maxBytes
      });
    }
    logUnhandledRequestError(request, error);
    return json(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

server.on("upgrade", (request, socket, head) => {
  routeGatewayWebSocketUpgrade(request, socket, head, {
    openClawChatProxy,
    canvasLiveEvents,
    gatewayLogStream,
    logger: gatewayRuntimeLog
  });
});

server.listen(port, host, () => {
  console.log(`gateway-api listening on http://${host}:${port}`);
  void gatewayRuntimeLog.info("gateway.started", "Gateway API is listening.", {
    host,
    port,
    logPath: gatewayRuntimeLog.logPath,
    bridgeKind: openClawBedrockBridge ? "bedrock" : openClawSshBridge ? "ssh" : "http",
    bedrockModelId: process.env.AWS_BEDROCK_MODEL_ID ?? null
  });
  void logGatewayDependencyWarnings();
  void resumeRampsOnStartup();
  if (process.env.OPENCLAW_EPISODIC_SCRATCH_TTL_JOB_ENABLE === "true") {
    startEpisodicScratchTtlJob({
      pool: episodicScratchPool,
      auditLog,
      canvasLiveEvents,
      logger: gatewayRuntimeLog,
      intervalMs: Number(process.env.OPENCLAW_EPISODIC_SCRATCH_TTL_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
    });
  }
});

async function resumeRampsOnStartup(): Promise<void> {
  try {
    const resumed = await resumeRampsOnBoot({
      scheduler: rampScheduler,
      workspace: openClawWorkspace
    });
    if (resumed.length > 0) {
      console.log(`[gateway] resumed ${resumed.length} warmup ramp(s) from disk: ${resumed.join(", ")}`);
      void gatewayRuntimeLog.info("gateway.warmup_ramps_resumed", "Warmup ramps resumed from disk.", {
        count: resumed.length,
        rampIds: resumed
      });
    }
  } catch (error) {
    console.warn(`[gateway] WARN: failed to resume warmup ramps on boot: ${error instanceof Error ? error.message : String(error)}`);
    void gatewayRuntimeLog.warn("gateway.warmup_ramps_resume_failed", "Failed to resume warmup ramps on boot.", runtimeErrorMetadata(error));
  }
}

async function logGatewayDependencyWarnings(): Promise<void> {
  const dependencies = await checkGatewayDependencies();
  logDependencyWarning("Postgres", dependencies.postgres, "POSTGRES_URL", "docker compose -f infra/docker-compose.yml up -d");
  logDependencyWarning("Redis", dependencies.redis, "REDIS_URL", "docker compose -f infra/docker-compose.yml up -d");
}

function logDependencyWarning(name: string, check: GatewayDependencyHealth[keyof GatewayDependencyHealth], envVar: string, command: string): void {
  if (check.status === "ok") {
    return;
  }

  console.warn(`[gateway] WARN: ${name} no responde en ${envVar}. ¿Levantaste \`${command}\`? ${check.message ?? ""}`.trim());
  void gatewayRuntimeLog.warn("gateway.dependency_down", `${name} dependency is down.`, {
    dependency: name,
    envVar,
    status: check.status,
    message: check.message ?? "",
    suggestedCommand: command
  });
}

async function buildLiveComplianceStatus(now: Date) {
  const [auditEvents, killSwitch] = await Promise.all([
    auditLog.list(),
    killSwitchStore.get()
  ]);

  return buildComplianceStatus({
    auditEvents,
    chainOk: verifyAuditChain(auditEvents),
    killSwitchArmed: !killSwitch.enabled,
    now
  });
}

function verifyAuditChain(events: AuditEvent[]): boolean {
  let prevHash = GENESIS_PREV_HASH;

  for (const event of events) {
    if (event.prevHash !== prevHash) {
      return false;
    }

    const expectedHash = computeAuditHash(event as unknown as Record<string, unknown>, prevHash);
    if (event.hash !== expectedHash) {
      return false;
    }

    prevHash = event.hash ?? prevHash;
  }

  return true;
}

function permission(actionId: string, category: AgentPermissionCategory): AgentPermissionEntry {
  return { actionId, category };
}

function matrixCategoryOf(actionId: string): AgentPermissionCategory | undefined {
  return agentPermissionByAction.get(actionId)?.category;
}

function evaluateAgentActionPermission(
  actionId: string,
  context: {
    humanApproved: boolean;
    killSwitchEnabled: boolean;
    schemaVersion: string | undefined;
  }
): {
  decision: "allow" | "reject";
  actionId: string;
  category: AgentPermissionCategory | "unknown";
  rejectReason?: AgentPermissionRejectReason;
} {
  if (context.schemaVersion !== "2026-05-18.v1") {
    return {
      decision: "reject",
      actionId,
      category: "unknown",
      rejectReason: "schema_mismatch"
    };
  }

  const entry = agentPermissionByAction.get(actionId);

  if (!entry) {
    return {
      decision: "reject",
      actionId,
      category: "unknown",
      rejectReason: "unknown_action"
    };
  }

  if (entry.category === "prohibited") {
    return {
      decision: "reject",
      actionId,
      category: entry.category,
      rejectReason: "prohibited_action"
    };
  }

  if (entry.category === "future_live_requires_new_phase") {
    return {
      decision: "reject",
      actionId,
      category: entry.category,
      rejectReason: "live_blocked_hito_5_11_b"
    };
  }

  if (entry.category === "supervised_local_state") {
    if (context.killSwitchEnabled) {
      return {
        decision: "reject",
        actionId,
        category: entry.category,
        rejectReason: "kill_switch_armed"
      };
    }

    if (!context.humanApproved) {
      return {
        decision: "reject",
        actionId,
        category: entry.category,
        rejectReason: "human_approval_missing"
      };
    }
  }

  return {
    decision: "allow",
    actionId,
    category: entry.category
  };
}

function httpStatusForPermissionReject(reason: AgentPermissionRejectReason): number {
  if (reason === "schema_mismatch") return 400;
  if (reason === "unknown_action") return 400;
  if (reason === "human_approval_missing") return 401;
  if (reason === "kill_switch_armed") return 423;
  return 403;
}

function pruneExpiredProposals(now: Date): void {
  for (const proposal of proposalsStore) {
    if (proposal.status === "pending" && Date.parse(proposal.expiresAt) <= now.getTime()) {
      proposal.status = "expired";
    }
  }
}

function findPendingProposalByHash(hash: string, now: Date): StoredProposal | undefined {
  return proposalsStore.find(
    (proposal) =>
      proposal.status === "pending" &&
      Date.parse(proposal.expiresAt) > now.getTime() &&
      hashProposal(proposal) === hash
  );
}

function getActiveAgentProposalPrompt(now: Date): OpenClawCanvasPromptCard | null {
  pruneExpiredProposals(now);

  const proposal = proposalsStore
    .filter((candidate) => candidate.status !== "expired" && Date.parse(candidate.expiresAt) > now.getTime())
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0];

  return proposal ? mapStoredProposalToPromptCard(proposal) : null;
}

function mapStoredProposalToPromptCard(proposal: StoredProposal): OpenClawCanvasPromptCard {
  const approval = approvalStateForProposal(proposal);
  return {
    proposalId: proposal.id,
    nodeId: nodeIdForProposal(proposal),
    headline: proposal.headline,
    body: proposal.body,
    severity: proposal.severity,
    requiresApproval: proposal.requiresApproval,
    runbookId: getRunbookIdForProposal(proposal),
    targetRef: proposal.targetRef,
    requiredApprovals: proposal.requiredApprovals,
    currentApprovals: approval.current,
    quorumReached: approval.reached,
    quorumResolution: proposal.quorumResolution,
    signedByOperatorIds: approval.approverIds,
    rollbackToken: proposal.execution?.rollbackToken,
    rollbackExpiresAt: proposal.execution?.rollbackExpiresAt,
    primaryAction: {
      kind: "open_runbook",
      label: "Revisar plan dry-run",
      runbookRef: proposal.runbookRef
    },
    secondaryAction: {
      kind: "snooze",
      label: "Posponer"
    },
    evidenceRefs: proposal.evidenceRefs
  };
}

function nodeIdForProposal(proposal: AgentProposal): string {
  if (proposal.category.includes("register") || proposal.category.includes("orphan")) {
    return "sender_nodes";
  }

  if (proposal.category.includes("pause") || proposal.category.includes("quarantine")) {
    return "reputation_escalation";
  }

  if (proposal.category.includes("warming")) {
    return "warming_plan";
  }

  return "onboarding_validate";
}

function getRunbookIdForProposal(proposal: Pick<AgentProposal, "runbookRef">): RunbookId {
  return normalizeRunbookId(proposal.runbookRef) ?? "register-sender-node-local";
}

function normalizeRunbookId(value: string): RunbookId | null {
  const normalized = value.toLowerCase();

  if (normalized.includes("register-sender-node")) {
    return "register-sender-node-local";
  }

  if (normalized.includes("warming-step")) {
    return "warming-step";
  }

  if (normalized.includes("pause-ip")) {
    return "pause-ip";
  }

  if (normalized.includes("incident-quarantine")) {
    return "incident-quarantine";
  }

  return null;
}

function getRequiredApprovalsForRunbook(runbookId: RunbookId): number {
  return runbookId === "warming-step" ? 2 : 1;
}

function resolveQuorumForProposal(
  proposal: Pick<AgentProposal, "runbookRef"> & { quorumResolution?: StoredProposal["quorumResolution"] },
  now: Date
): QuorumResolution | { requiredApprovals: number; mode: "static" } {
  if (proposal.quorumResolution) {
    return proposal.quorumResolution;
  }

  const runbookId = getRunbookIdForProposal(proposal);

  if (runbookId === "incident-quarantine") {
    return resolveBusinessHoursQuorum(now, runbookId);
  }

  return {
    requiredApprovals: getRequiredApprovalsForRunbook(runbookId),
    mode: "static"
  };
}

function supervisedActionForProposal(proposal: AgentProposal): string | null {
  return proposal.delivrix_actions_required.find(
    (actionId) => matrixCategoryOf(actionId) === "supervised_local_state"
  ) ?? null;
}

function approvalStateForProposal(proposal: StoredProposal): {
  current: number;
  required: number;
  reached: boolean;
  approverIds: string[];
} {
  if (proposal.resolution?.approverIds?.length) {
    const approverIds = [...new Set(proposal.resolution.approverIds)];
    return {
      current: approverIds.length,
      required: proposal.requiredApprovals,
      reached: approverIds.length >= proposal.requiredApprovals,
      approverIds
    };
  }

  const supervisedAction = supervisedActionForProposal(proposal);

  if (!supervisedAction) {
    return {
      current: 0,
      required: proposal.requiredApprovals,
      reached: false,
      approverIds: []
    };
  }

  return approvalQuorumForRows(
    listApprovalNoncesForTarget({
      actionId: supervisedAction,
      targetType: "proposal",
      targetId: proposal.targetRef,
      status: "issued"
    }),
    proposal.requiredApprovals,
    proposal.quorumResolution
  );
}

function approvalQuorumForRows(
  rows: Array<{ approverId: string }>,
  requiredApprovals: number,
  resolution?: QuorumResolution | { mode: "static"; requiredApprovals: number }
): {
  current: number;
  required: number;
  reached: boolean;
  approverIds: string[];
  mode?: "business_hours" | "off_hours" | "static";
  serverTime?: string;
  operatorLocalHour?: number;
} {
  const approverIds = [...new Set(rows.map((row) => row.approverId))];

  return {
    current: approverIds.length,
    required: requiredApprovals,
    reached: approverIds.length >= requiredApprovals,
    approverIds,
    mode: resolution?.mode,
    serverTime: resolution && "serverTime" in resolution ? resolution.serverTime : undefined,
    operatorLocalHour: resolution && "operatorLocalHour" in resolution ? resolution.operatorLocalHour : undefined
  };
}

function selectTokenRowsForQuorum<T extends { approverId: string }>(
  rows: T[],
  requiredApprovals: number
): T[] {
  const selected = new Map<string, T>();

  for (const row of rows) {
    if (!selected.has(row.approverId)) {
      selected.set(row.approverId, row);
    }

    if (selected.size >= requiredApprovals) {
      break;
    }
  }

  return [...selected.values()];
}

async function dispatchRunbook(
  runbookId: RunbookId,
  input: unknown,
  proposal: StoredProposal,
  ctx: RunbookContext
) {
  if (runbookId === "register-sender-node-local") {
    return executeRegisterSenderNodeRunbook(input as RegisterSenderNodeInput, ctx);
  }

  if (runbookId === "warming-step") {
    const runbookInput = isRecord(input) && isNonEmptyString(input.nodeId)
      ? { nodeId: input.nodeId }
      : { nodeId: proposal.targetRef };
    return executeWarmingStepRunbook(runbookInput, ctx);
  }

  if (runbookId === "incident-quarantine") {
    const runbookInput = isRecord(input)
      ? {
          nodeId: isNonEmptyString(input.nodeId) ? input.nodeId : proposal.targetRef,
          reason: typeof input.reason === "string" ? input.reason : proposal.body,
          evidenceRefs: Array.isArray(input.evidenceRefs)
            ? input.evidenceRefs.filter((item): item is string => typeof item === "string")
            : proposal.evidenceRefs
        }
      : {
          nodeId: proposal.targetRef,
          reason: proposal.body,
          evidenceRefs: proposal.evidenceRefs
        };
    return executeQuarantineRunbook(runbookInput, ctx);
  }

  const runbookInput = isRecord(input) && isNonEmptyString(input.nodeId)
    ? { nodeId: input.nodeId, reason: typeof input.reason === "string" ? input.reason : undefined }
    : { nodeId: proposal.targetRef };
  return executePauseIpRunbook(runbookInput, ctx);
}

function auditSlugForRunbook(runbookId: RunbookId): string {
  return runbookId === "incident-quarantine" ? "quarantine" : runbookId.replace(/-/g, "_");
}

function normalizeQuarantineTargetStatus(value: unknown): QuarantineRevertTargetStatus | null {
  if (value === "active" || value === "retired" || value === "quarantined") {
    return value;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashProposal(proposal: Pick<AgentProposal, "category" | "targetRef">): string {
  return createHash("sha256")
    .update(`${proposal.category}|${proposal.targetRef}`)
    .digest("hex")
    .slice(0, 16);
}

function normalizeAgentProposal(value: Partial<AgentProposal> | undefined): AgentProposal | null {
  if (!value) {
    return null;
  }

  const target = normalizeProposalTargetRef((value as Record<string, unknown>).targetRef);
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.category) ||
    !isAgentProposalSeverity(value.severity) ||
    !isNonEmptyString(value.headline) ||
    !isNonEmptyString(value.body) ||
    !isNonEmptyString(value.runbookRef) ||
    !target ||
    !Array.isArray(value.delivrix_actions_required) ||
    value.delivrix_actions_required.length === 0
  ) {
    return null;
  }

  const actions = value.delivrix_actions_required.filter(isNonEmptyString);

  if (actions.length !== value.delivrix_actions_required.length) {
    return null;
  }

  return {
    id: value.id.trim(),
    category: value.category.trim(),
    severity: value.severity,
    headline: value.headline.trim(),
    body: value.body.trim(),
    evidenceRefs: Array.isArray(value.evidenceRefs)
      ? value.evidenceRefs.filter(isNonEmptyString)
      : [],
    runbookRef: value.runbookRef.trim(),
    targetRef: target.id,
    ...(target.type ? { targetType: target.type } : {}),
    ...(isNonEmptyString(value.skillSlug) ? { skillSlug: value.skillSlug.trim() } : {}),
    ...(isRecord((value as Record<string, unknown>).params) ? { params: (value as Record<string, unknown>).params } : {}),
    ...(isCanvasArtifactSnapshot((value as Record<string, unknown>).artifactSnapshot)
      ? { artifactSnapshot: (value as Record<string, unknown>).artifactSnapshot as CanvasLiveArtifactSnapshot }
      : {}),
    delivrix_actions_required: actions.map((action) => action.trim())
  };
}

function normalizeProposalTargetRef(value: unknown): { id: string; type?: string } | null {
  if (isNonEmptyString(value)) {
    return { id: value.trim() };
  }
  if (isRecord(value) && isNonEmptyString(value.id)) {
    return {
      id: value.id.trim(),
      ...(isNonEmptyString(value.type) ? { type: value.type.trim() } : {})
    };
  }
  return null;
}

function isCanvasArtifactSnapshot(value: unknown): value is CanvasLiveArtifactSnapshot {
  return isRecord(value) &&
    isNonEmptyString(value.artifactId) &&
    isNonEmptyString(value.taskId) &&
    isNonEmptyString(value.title) &&
    Array.isArray(value.blocks);
}

function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function operatorIdFromRequest(request: IncomingMessage): string | null {
  return operatorIdFromHeaders(request.headers);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isAgentProposalSeverity(value: unknown): value is AgentProposal["severity"] {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function riskLevelFromProposalSeverity(severity: AgentProposal["severity"]): "low" | "medium" | "high" {
  if (severity === "critical" || severity === "high") {
    return "high";
  }

  if (severity === "medium") {
    return "medium";
  }

  return "low";
}

async function appendRoute53ReadAudit(event: { type: string; [key: string]: unknown }): Promise<void> {
  const domain = typeof event.domain === "string" ? event.domain : undefined;
  const zoneId = typeof event.zoneId === "string" ? event.zoneId : undefined;
  await auditLog.append({
    actorType: "openclaw",
    actorId: "openclaw-route53-read-tools",
    action: event.type,
    targetType: domain ? "domain" : "route53_hosted_zone",
    targetId: domain ?? zoneId ?? "unknown",
    riskLevel: "low",
    decision: "allow",
    humanApproved: false,
    metadata: {
      provider: "aws-route53",
      ...event
    }
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readBody(request);

  if (!raw) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(raw) as T;
}

async function readOptionalJson<T>(request: IncomingMessage): Promise<T | undefined> {
  const raw = await readBody(request);

  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw) as T;
}

async function readRawBodyAndJson<T>(request: IncomingMessage): Promise<{ raw: string; body: T | null }> {
  const raw = await readBody(request);

  if (!raw) {
    return { raw, body: null };
  }

  try {
    return { raw, body: JSON.parse(raw) as T };
  } catch {
    return { raw, body: null };
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  return readRequestBody(request, { maxBytes: gatewayMaxRequestBodyBytes });
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
}

function logUnhandledRequestError(request: IncomingMessage, error: unknown): void {
  let path = request.url ?? "/";
  try {
    path = requestUrl(request).pathname;
  } catch {
    path = request.url ?? "/";
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("[gateway] unhandled request error", {
    method: request.method ?? "UNKNOWN",
    path,
    message
  });
  console.error(stack);
  void gatewayRuntimeLog.error("gateway.unhandled_request_error", "Unhandled request error.", {
    method: request.method ?? "UNKNOWN",
    path,
    message,
    stack
  });
}

function parseStaleAfterMs(value: string | number | null | undefined, fallback: number): number | null {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function tryBuild<T>(response: ServerResponse, factory: () => T): T | undefined {
  try {
    return factory();
  } catch (error) {
    json(response, 422, {
      error: "validation_error",
      message: error instanceof Error ? error.message : "Invalid request payload."
    });
    return undefined;
  }
}

async function backupSnapshots(resources: BackupResource[]): Promise<BackupResourceSnapshot[]> {
  const snapshots: BackupResourceSnapshot[] = [];

  for (const resource of resources) {
    snapshots.push({
      resource,
      count: await countBackupResource(resource),
      source: sourceForBackupResource(resource)
    });
  }

  return snapshots;
}

async function countBackupResource(resource: BackupResource): Promise<number> {
  if (resource === "audit_events") {
    return (await auditLog.list()).length;
  }

  if (resource === "sender_nodes") {
    return (await senderNodeRegistry.list()).length;
  }

  if (resource === "send_jobs") {
    return (await sendQueue.list()).length;
  }

  if (resource === "send_results") {
    return (await sendResultStore.list()).length;
  }

  if (resource === "suppression_entries") {
    return (await suppressionList.list()).length;
  }

  if (resource === "rate_limit_counters") {
    return (await rateLimitStore.list()).length;
  }

  if (resource === "provisioning_runs") {
    return (await provisioningRunStore.list()).length;
  }

  if (resource === "ip_reputation_reports") {
    return (await ipReputationReportStore.list()).length;
  }

  return 0;
}

function sourceForBackupResource(resource: BackupResource): string {
  return `local-file:${resource}`;
}

function isStuckJobRecoveryAction(value: unknown): value is StuckJobRecoveryAction {
  return value === "fail" || value === "requeue";
}

function parseSenderNodeRetirementApprovalRoute(request: IncomingMessage): {
  senderNodeId: string;
} | null {
  const parts = requestUrl(request).pathname.split("/").filter(Boolean);

  if (parts.length !== 4 || parts[0] !== "v1" || parts[1] !== "sender-nodes" || parts[3] !== "approve-retirement") {
    return null;
  }

  return {
    senderNodeId: decodeURIComponent(parts[2] ?? "")
  };
}

function parseSenderNodeControlRoute(request: IncomingMessage): {
  senderNodeId: string;
  action: SenderNodeManualAction | string;
} | null {
  const parts = requestUrl(request).pathname.split("/").filter(Boolean);

  if (parts.length !== 4 || parts[0] !== "v1" || parts[1] !== "sender-nodes") {
    return null;
  }

  return {
    senderNodeId: decodeURIComponent(parts[2] ?? ""),
    action: parts[3] ?? ""
  };
}

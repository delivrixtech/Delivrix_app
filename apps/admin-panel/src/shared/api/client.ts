import {
  assertReadEndpoint,
  listReadEndpoints,
  READ_ENDPOINTS,
  type ReadEndpoint
} from "./read-boundary.ts";

export { assertReadEndpoint, listReadEndpoints, READ_ENDPOINTS };

export type ContractStatus =
  | "ok"
  | "healthy"
  | "ready"
  | "success"
  | "warning"
  | "needs_review"
  | "blocked"
  | "critical"
  | "unknown"
  | "not_started"
  | "requires_approval"
  | "disabled_by_mvp"
  | "inactive"
  | "active_true"
  | string;

export interface ContractSafety {
  liveInfrastructureWritesEnabled: boolean;
  sshEnabled: boolean;
  smtpEnabled: boolean;
  nfcWritesEnabled: boolean;
}

export interface ContractQuality {
  completeness: number;
  confidence: number;
  unknownFields: string[];
}

export interface ContractSource {
  kind: string;
  trusted: boolean;
  freshness: "fresh" | "stale" | "unknown" | string;
  collectedAt: string | null;
}

export interface ContractBase {
  schemaVersion: string;
  generatedAt: string;
  mode: "read_only";
  source: ContractSource;
  quality: ContractQuality;
  safety: ContractSafety;
}

export interface HealthPayload {
  status: string;
  service: string;
  phase: string;
  openClaw: Record<string, boolean | string>;
  operatingNorth: {
    delivrixSendsRealEmail: boolean;
    nfcSendsRealEmail: boolean;
    nfcProductionWritesEnabled: boolean;
    liveInfrastructureWritesEnabled: boolean;
  };
}

export interface OperatingNorthPayload {
  phase: string;
  delivrixRole: string;
  openClawRole: string;
  nfcRole: string;
  allowedActions: string[];
  blockedActions: string[];
  gates: string[];
  delivrixSendsRealEmail: boolean;
  nfcSendsRealEmail: boolean;
  liveInfrastructureWritesEnabled: boolean;
  nfcProductionWritesEnabled: boolean;
}

export interface AdminOverviewPayload {
  overview: {
    generatedAt: string;
    state: ContractStatus;
    summary: {
      totals: Record<string, number>;
      jobsByStatus: Record<string, number>;
      sendResultsByStatus: Record<string, number>;
      senderNodesByStatus: Record<string, number>;
    };
    alerts: Array<{
      severity: ContractStatus;
      title: string;
      message: string;
    }>;
    health: Array<{
      senderNodeId: string;
      severity: ContractStatus;
      currentStatus: string;
      recommendedStatus: string;
      reasons: string[];
    }>;
    recentAuditEvents: Array<{
      id: string;
      occurredAt: string;
      actorType: string;
      actorId: string;
      action: string;
      targetType: string;
      targetId: string;
      riskLevel: ContractStatus;
    }>;
  };
}

export interface WorkflowPayload {
  workflow: {
    generatedAt: string;
    phase: string;
    mode: "read_only";
    summary: string;
    readBoundary: {
      allowedMethods: string[];
      blockedMethods: string[];
      allowedEndpoints: string[];
    };
    steps: Array<{
      id: string;
      order: number;
      navLabel: string;
      title: string;
      operatorQuestion: string;
      purpose: string;
      dataSources: string[];
      evidenceToShow: string[];
      status: ContractStatus;
      statusReason: string;
      nextStepId?: string;
    }>;
  };
}

export interface ClusterOverviewPayload {
  clusterOverview: {
    generatedAt: string;
    mode: "read_only";
    totals: Record<string, number>;
    clusters: Array<{
      id: string;
      provider: string;
      managementState: ContractStatus;
      senderNodes: Array<{
        id: string;
        label: string;
        status: string;
        healthSeverity?: ContractStatus;
      }>;
    }>;
    nextActions: Array<{
      id: string;
      label: string;
      status: ContractStatus;
    }>;
  };
}

export interface LearningPlanPayload {
  learningPlan: {
    generatedAt: string;
    mode: string;
    modelGovernance?: Record<string, unknown>;
    stages: Array<{
      id: string;
      order: number;
      /** Domain field is `title`. Older drafts used `label` — kept optional for safety. */
      title: string;
      label?: string;
      status: ContractStatus;
      goal?: string;
      evidence?: string[];
      exitGate?: string;
      gates?: string[];
    }>;
  };
}

export interface KillSwitchPayload {
  killSwitch: {
    enabled: boolean;
    reason: string;
    updatedAt: string;
    updatedBy: string;
  };
}

export interface PhysicalHostPayload {
  physicalHost: ContractBase & {
    identity: {
      hostId: string;
      label: string;
      vendor: string;
      model: string;
      serialNumber: string;
      location: string;
      operatingSystem: string;
      kernelVersion: string;
      proxmoxVersion: string;
      uptimeSeconds: number | null;
    };
    capacity: {
      cpuCores: number | null;
      cpuThreads: number | null;
      memoryGb: number | null;
      storageUsableGb: number | null;
      networkInterfaces: number;
      ipPoolSize: number | null;
    };
    readiness: {
      status: ContractStatus;
      blockers: string[];
      warnings: string[];
      requiredHumanInputs: string[];
      primaryBlocker?: string;
      recommendedNextStep?: {
        label: string;
        endpoint: string;
        severity: "info" | "warning" | "critical";
      };
    };
  };
}

export interface HardwareTelemetryPayload {
  telemetry: ContractBase & {
    summary: {
      status: ContractStatus;
      riskLevel: ContractStatus;
      stale: boolean;
    };
    cpu: {
      usagePercent: number | null;
      temperatureCelsius: number | null;
      loadAverage: number[];
      thermalStatus: ContractStatus;
    };
    memory: Record<string, number | null>;
    storage: Record<string, number | string | null>;
    network: {
      interfaces: unknown[];
      rxMbps: number | null;
      txMbps: number | null;
      packetDrops: number | null;
      latencyMs: number | null;
    };
    power: Record<string, number | string | null>;
  };
}

export interface HardwareTelemetryHistoryPayload {
  history: ContractBase & {
    window: string;
    series: Array<{
      metric: string;
      unit: string;
      points: Array<{
        timestamp: string;
        value: number | null;
        quality: string;
      }>;
    }>;
    gaps: Array<Record<string, string>>;
  };
}

/** H.23: 5 lanes literales del Pencil swimlane. */
export type OpenClawCanvasLane =
  | "onboarding"
  | "hardware"
  | "provisioning"
  | "warming"
  | "reputation";

export type OpenClawCanvasTimeRangeId = "1h" | "24h" | "7d";

export interface OpenClawCanvasPromptAction {
  label: string;
  runbookRef?: string;
  kind: "open_runbook" | "snooze" | "ack" | "view_evidence";
}

export interface OpenClawCanvasPromptCard {
  proposalId?: string;
  nodeId: string;
  headline: string;
  body: string;
  severity?: "low" | "medium" | "high" | "critical";
  requiresApproval?: boolean;
  runbookId?: string;
  targetRef?: string;
  requiredApprovals?: number;
  currentApprovals?: number;
  quorumReached?: boolean;
  quorumResolution?: {
    requiredApprovals: number;
    mode: "static" | "business_hours" | "off_hours";
    serverTime?: string;
    operatorLocalHour?: number;
  };
  signedByOperatorIds?: string[];
  rollbackToken?: string;
  rollbackExpiresAt?: string;
  primaryAction: OpenClawCanvasPromptAction;
  secondaryAction: OpenClawCanvasPromptAction;
  evidenceRefs: string[];
}

export interface OpenClawCanvasPayload {
  canvas: ContractBase & {
    currentStepId: string;
    nodes: Array<{
      id: string;
      kind: string;
      /** H.23: en qué carril del swimlane se dibuja. */
      lane: OpenClawCanvasLane;
      label: string;
      status: ContractStatus;
      progressPercent: number;
      riskLevel: ContractStatus;
      summary: string;
      metrics: Array<{
        id: string;
        label: string;
        value: number | string | null;
        unit: string | null;
        quality: string;
      }>;
      badges: string[];
      drilldown: {
        endpoint: string;
        label: string;
      };
    }>;
    edges: Array<{
      id: string;
      from: string;
      to: string;
      status: ContractStatus;
      label: string;
    }>;
    timeline: Array<{
      id: string;
      occurredAt: string;
      actor: string;
      action: string;
      status: ContractStatus;
      evidenceRefs: string[];
    }>;
    blockedBy: Array<{
      code: string;
      label: string;
      category: "hardware" | "openclaw" | "network" | "provider" | "other";
      severity: "warning" | "critical";
    }>;
    requiresHumanApproval: string[];
    /** H.23: meta del Pencil. */
    lanes: OpenClawCanvasLane[];
    cluster: {
      activeId: string;
      options: Array<{ id: string; label: string }>;
    };
    timeRange: {
      active: OpenClawCanvasTimeRangeId;
      options: OpenClawCanvasTimeRangeId[];
    };
    scale: { zoomPercent: number };
    lastActivity: {
      actor: string;
      occurredAt: string;
      auditHash: string;
    };
    selectedNodeId: string | null;
    prompt: OpenClawCanvasPromptCard | null;
  };
}

export interface OpenClawOnboardingStatePayload {
  onboardingState: ContractBase & {
    readinessByCategory: Record<string, number>;
    pendingQuestions: Array<{
      id: string;
      category: string;
      priority: string;
      fieldPath: string;
      prompt: string;
      reason: string;
    }>;
    knownInputs: Record<string, unknown>;
    blockers: string[];
    warnings: string[];
    canGenerateTopologyPlan: boolean;
  };
}

export interface OpenClawProvisioningStatePayload {
  provisioningState: ContractBase & {
    topologySource: {
      id: string | null;
      decisionStatus: string;
    };
    steps: Array<{
      id: string;
      label: string;
      status: ContractStatus;
      requiresHumanApproval: boolean;
      evidenceRefs: string[];
    }>;
    requiredApprovals: string[];
    blockedActions: string[];
    dryRunArtifacts: string[];
  };
}

export interface ReadinessSignalsPayload {
  signals: ContractBase & {
    scores: Record<string, {
      score: number | null;
      confidence: number;
      status: ContractStatus;
      reason: string;
    }>;
    recommendations: Array<{
      id: string;
      label: string;
      status: ContractStatus;
      evidenceRefs: string[];
      requiresHumanApproval: boolean;
    }>;
    modelGovernance: {
      modelMode: string;
      modelVersion: string;
      promptVersion: string;
      canSelfPromote: boolean;
      requiresHumanApproval: boolean;
    };
  };
}

export interface CollectorStatusPayload {
  collector: ContractBase & {
    collectorMode: string;
    status: ContractStatus;
    sources: Array<{
      kind: string;
      enabled: boolean;
      readOnly: boolean;
      lastCollectedAt: string | null;
      error: string | null;
    }>;
    permissions: {
      sshEnabled: boolean;
      proxmoxApiWriteEnabled: boolean;
      ipmiEnabled: boolean;
      prometheusEnabled: boolean;
    };
    unknownCapabilities: string[];
    collectorVersion: string;
  };
}

export interface SupervisedCollectorPayload {
  supervisedCollector: ContractBase & {
    collectorMode: "supervised_read_only";
    status: ContractStatus;
    sources: Array<{
      id: string;
      kind: string;
      label: string;
      purpose: string;
      status: ContractStatus;
      readOnly: boolean;
      minimumPermission: string;
      expectedSignals: string[];
      safeCollection: {
        transport: string;
        requiresSecret: boolean;
        writesEnabled: boolean;
        commandPreview: string | null;
        endpoint: string | null;
      };
      freshness: {
        lastCollectedAt: string | null;
        maxAgeSeconds: number;
        stale: boolean;
      };
      blockedBy: string[];
    }>;
    ingestionPolicy: {
      acceptsManualSnapshot: boolean;
      acceptsLiveMutation: boolean;
      requiresOperatorApprovalForSourceChange: boolean;
      storesRawSecrets: boolean;
      snapshotSchemaVersion: string;
    };
    auditPolicy: {
      appendOnly: boolean;
      redactsSecrets: boolean;
      snapshotHashRequired: boolean;
      retainedFields: string[];
      rejectedFields: string[];
    };
    freshness: {
      freshSources: number;
      staleSources: number;
      unknownSources: number;
      lastCollectedAt: string | null;
      staleAfterSeconds: number;
    };
    gates: string[];
    nextSafeActions: string[];
    blockedActions: string[];
  };
}

export type AuditActorType =
  | "operator"
  | "system"
  | "openclaw"
  | "collector"
  | "scheduler"
  | "external"
  | string;

export type AuditRiskLevel = "info" | "low" | "medium" | "high" | "critical" | string;

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  riskLevel: AuditRiskLevel;
  metadata: Record<string, unknown>;
}

export interface AuditEventsPayload {
  events: AuditEvent[];
}

/* ============================================================
 * Wave 2B: contratos del gateway que el panel cablea para
 * eliminar slots hardcoded en Clústeres y Overview.
 * ============================================================ */

export type SenderNodeProvider = "webdock" | "proxmox" | "racknerd" | "manual" | string;

export type SenderNodeStatusContract =
  | "active"
  | "warming"
  | "paused"
  | "quarantined"
  | "degraded"
  | "retired_pending_approval"
  | "retired"
  | string;

export interface SenderNodeContract {
  id: string;
  label: string;
  provider: SenderNodeProvider;
  status: SenderNodeStatusContract;
  ipAddress?: string;
  hostname?: string;
  dailyLimit: number;
  warmupDay: number;
}

export interface SenderNodesPayload {
  nodes: SenderNodeContract[];
}

export type IpReputationState = "healthy" | "watch" | "critical" | string;
export type IpReputationRecommendedAction =
  | "continue"
  | "pause"
  | "degrade"
  | "quarantine"
  | string;

export interface IpReputationReport {
  id: string;
  generatedAt: string;
  senderNodeId: string;
  provider: SenderNodeProvider;
  ipAddress?: string;
  currentStatus: SenderNodeStatusContract;
  recommendedStatus: SenderNodeStatusContract;
  recommendedAction: IpReputationRecommendedAction;
  state: IpReputationState;
  score: number;
  metrics: {
    totalResults: number;
    sentRate: number;
    bounceRate: number;
    deferredRate: number;
    failedCount: number;
    complaintCount: number;
  };
  signals: Array<{ kind: string; severity: ContractStatus; message: string }>;
  thresholds: Record<string, number>;
}

export interface IpReputationReportsPayload {
  reports: IpReputationReport[];
}

export type SendJobStatusContract = "queued" | "processing" | "completed" | "failed" | "blocked" | string;
export type SendResultStatusContract =
  | "sent"
  | "delivered"
  | "bounce"
  | "complaint"
  | "deferred"
  | "failed"
  | string;

export interface SendResult {
  id: string;
  sendJobId: string;
  senderNodeId?: string;
  status: SendResultStatusContract;
  smtpResponse?: string;
  bounceCode?: string;
  complaintSource?: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface SendResultsPayload {
  results: SendResult[];
}

export interface StuckJob {
  id: string;
  status: SendJobStatusContract;
  createdAt: string;
  processingStartedAt?: string;
  senderNodeId?: string;
  failureReason?: string;
}

export interface StuckJobsPayload {
  generatedAt: string;
  staleAfterMs: number;
  count: number;
  stuckJobs: StuckJob[];
}

export interface CountByKey {
  key: string;
  count: number;
}

export interface OperationalSummary {
  generatedAt: string;
  totals: {
    jobs: number;
    auditEvents: number;
    senderNodes: number;
    sendResults: number;
  };
  jobsByStatus: Record<string, number>;
  sendResultsByStatus: Record<string, number>;
  senderNodesByStatus: Record<string, number>;
  jobsByCampaign: CountByKey[];
  sendResultsByCampaign: CountByKey[];
  jobsBySenderNode: CountByKey[];
  sendResultsBySenderNode: CountByKey[];
  jobsBySenderDomain: CountByKey[];
  jobsByRecipientDomain: CountByKey[];
  auditActions: CountByKey[];
  rateLimitCounters: Array<{
    key: string;
    windowSeconds: number;
    count: number;
    limit: number;
  }>;
}

export interface OperationalSummaryPayload {
  summary: OperationalSummary;
}

/* Wave 3A: contratos mock del backend para Seguridad + Aprendizaje */

export type RealTimeDataSource = "live" | "cached" | "fallback";

export interface RealTimeMeta {
  dataSource: RealTimeDataSource;
  staleSinceMs: number | null;
  evaluatedAt: string;
}

export type IamRoleColor = "amber" | "green" | "blue" | "violet" | "neutral";

export interface IamRole {
  id: string;
  name: string;
  color: IamRoleColor;
  userCount: number;
  permissions: string[];
  countDerivedFrom?: string;
}

export interface IamRolesPayload {
  roles: IamRole[];
  meta?: RealTimeMeta;
}

export type IamSessionTransport = "vpn" | "internal" | "mfa" | string;
export type IamSessionRisk = "low" | "medium" | "high" | string;

export interface IamSession {
  actor: string;
  location: string;
  transport: IamSessionTransport;
  startedAt: string;
  lastSeenAt: string;
  risk: IamSessionRisk;
}

export interface IamSessionsPayload {
  sessions: IamSession[];
  meta?: RealTimeMeta;
}

export type ComplianceControlState = "ok" | "warning" | "info" | "critical" | string;

export interface ComplianceControl {
  id: string;
  title: string;
  state: ComplianceControlState;
  lines: string[];
  runbookRef?: string;
  evaluatedAt?: string;
  metrics?: Record<string, boolean | number | string>;
}

export interface ComplianceStatusPayload {
  controls: ComplianceControl[];
  meta?: RealTimeMeta;
}

export interface DashboardSafetyRealtimeMeta {
  iamRoles: RealTimeMeta | null;
  iamSessions: RealTimeMeta | null;
  complianceStatus: RealTimeMeta | null;
}

export interface OpenClawSkillsAuditEvent {
  id: string;
  occurredAt: string;
  action: string;
  actor: string;
  body: string;
  skillId?: string;
  lessonId?: string;
}

export interface OpenClawSkillsAuditPayload {
  events: OpenClawSkillsAuditEvent[];
}

export type OpenClawEvidenceImpact = "alto" | "medio" | "bajo" | string;

export interface OpenClawEvidenceItem {
  snapshotId: string;
  type: string;
  description: string;
  actor: string;
  capturedAt: string;
  mode: "get-only" | string;
  impact: OpenClawEvidenceImpact;
}

export interface OpenClawEvidencePayload {
  curated: OpenClawEvidenceItem[];
}

/* Hito 5.11.A — Webdock READ + OpenClaw rules-based drift */

export type WebdockServerStatus =
  | "running"
  | "stopped"
  | "suspended"
  | "provisioning"
  | "reinstalling"
  | "rebooting"
  | "deleting"
  | "error"
  | "unknown"
  | string;

export interface WebdockInventoryServer {
  slug: string;
  name: string;
  ipv4: string;
  ipv6?: string;
  status: WebdockServerStatus;
  profileSlug?: string;
  location?: string;
  creationDate?: string;
  lastDataReceived?: string;
  imageSlug?: string;
  description?: string;
  snapshotRunTime?: number;
}

export interface WebdockInventorySummary {
  total: number;
  running: number;
  stopped: number;
  suspended: number;
  other: number;
}

export interface WebdockInventorySourceInfo {
  kind: "live" | "mock";
  apiBase: string;
  fetchedAt: string;
  responseOk: boolean;
  errorMessage?: string;
}

export interface WebdockInventoryContract {
  schemaVersion: string;
  generatedAt: string;
  mode: "read_only";
  source: WebdockInventorySourceInfo;
  summary: WebdockInventorySummary;
  servers: WebdockInventoryServer[];
}

export type OpenClawDriftSeverity = "low" | "medium" | "high";
export type OpenClawDriftCategory =
  | "node_resume_proposed"
  | "node_pause_proposed"
  | "node_register_proposed"
  | "node_orphan_warning"
  | string;

export interface OpenClawDriftProposal {
  id: string;
  category: OpenClawDriftCategory;
  severity: OpenClawDriftSeverity;
  headline: string;
  body: string;
  evidenceRefs: string[];
  runbookRef: string;
  targetRef: string;
}

export interface WebdockInventoryPayload {
  inventory: WebdockInventoryContract;
  drift: {
    proposals: OpenClawDriftProposal[];
    unmatchedWebdockSlugs: string[];
    unmatchedSenderNodeIds: string[];
  };
}

export interface SnapshotIngestionPayload {
  snapshotIngestion: ContractBase & {
    status: ContractStatus;
    snapshotSchemaVersion: string;
    manualEndpoint: {
      method: "POST";
      path: string;
      exposedInAdminPanel: boolean;
      requiresHumanApproval: boolean;
      storesRawPayload: boolean;
    };
    uiPolicy: {
      adminPanelCanPost: boolean;
      adminPanelCanUploadFiles: boolean;
      adminPanelShowsContractOnly: boolean;
      allowedPanelMethods: string[];
      manualIngestionRequiresExternalOperatorAction: boolean;
    };
    acceptedFieldPaths: Array<{
      path: string;
      type: string;
      mapsTo: string;
      requiredFor: string;
    }>;
    redactionPolicy: {
      rejectsSecretLikeKeys: boolean;
      storesRawSecrets: boolean;
      rejectedKeys: string[];
      rejectedKeyPatterns: string[];
      redactsBeforeHash: boolean;
    };
    parserOutputs: string[];
    gates: string[];
    nextSafeActions: string[];
    blockedActions: string[];
  };
}

export interface DashboardData {
  health: HealthPayload;
  operatingNorth: OperatingNorthPayload;
  overview: AdminOverviewPayload["overview"];
  workflow: WorkflowPayload["workflow"];
  clusters: ClusterOverviewPayload["clusterOverview"];
  learningPlan: LearningPlanPayload["learningPlan"];
  killSwitch: KillSwitchPayload["killSwitch"];
  physicalHost: PhysicalHostPayload["physicalHost"];
  telemetry: HardwareTelemetryPayload["telemetry"];
  telemetryHistory: HardwareTelemetryHistoryPayload["history"];
  canvas: OpenClawCanvasPayload["canvas"];
  onboardingState: OpenClawOnboardingStatePayload["onboardingState"];
  provisioningState: OpenClawProvisioningStatePayload["provisioningState"];
  readinessSignals: ReadinessSignalsPayload["signals"];
  collector: CollectorStatusPayload["collector"];
  supervisedCollector: SupervisedCollectorPayload["supervisedCollector"];
  snapshotIngestion: SnapshotIngestionPayload["snapshotIngestion"];
  auditEvents: AuditEvent[];
  senderNodes: SenderNodeContract[];
  ipReputationReports: IpReputationReport[];
  sendResults: SendResult[];
  stuckJobs: StuckJobsPayload;
  operationalSummary: OperationalSummary;
  iamRoles: IamRole[];
  iamSessions: IamSession[];
  complianceControls: ComplianceControl[];
  safetyRealtime: DashboardSafetyRealtimeMeta;
  openClawSkillsAudit: OpenClawSkillsAuditEvent[];
  openClawEvidence: OpenClawEvidenceItem[];
  webdockInventory: WebdockInventoryContract;
  webdockDrift: WebdockInventoryPayload["drift"];
}

export async function loadDashboardData(): Promise<DashboardData> {
  const [
    health,
    adminClusters,
    adminOverview,
    adminWorkflow,
    collectorSnapshotIngestion,
    collectorStatus,
    collectorSupervisedPlan,
    hardwarePhysicalHost,
    hardwareTelemetryHistory,
    hardwareTelemetryLatest,
    openClawLearningPlan,
    openClawLiveCanvas,
    openClawOnboardingState,
    openClawProvisioningState,
    openClawReadinessSignals,
    operatingNorth,
    killSwitch,
    auditEvents,
    senderNodes,
    ipReputationReports,
    sendResults,
    stuckJobs,
    operationalSummary,
    iamRoles,
    iamSessions,
    complianceStatus,
    openClawSkillsAudit,
    openClawEvidence,
    webdockInventory
  ] = await Promise.all([
    getJson<HealthPayload>(READ_ENDPOINTS.health),
    getJson<ClusterOverviewPayload>(READ_ENDPOINTS.adminClusters),
    getJson<AdminOverviewPayload>(READ_ENDPOINTS.adminOverview),
    getJson<WorkflowPayload>(READ_ENDPOINTS.adminWorkflow),
    getJson<SnapshotIngestionPayload>(READ_ENDPOINTS.collectorSnapshotIngestion),
    getJson<CollectorStatusPayload>(READ_ENDPOINTS.collectorStatus),
    getJson<SupervisedCollectorPayload>(READ_ENDPOINTS.collectorSupervisedPlan),
    getJson<PhysicalHostPayload>(READ_ENDPOINTS.hardwarePhysicalHost),
    getJson<HardwareTelemetryHistoryPayload>(READ_ENDPOINTS.hardwareTelemetryHistory),
    getJson<HardwareTelemetryPayload>(READ_ENDPOINTS.hardwareTelemetryLatest),
    getJson<LearningPlanPayload>(READ_ENDPOINTS.openClawLearningPlan),
    getJson<OpenClawCanvasPayload>(READ_ENDPOINTS.openClawLiveCanvas),
    getJson<OpenClawOnboardingStatePayload>(READ_ENDPOINTS.openClawOnboardingState),
    getJson<OpenClawProvisioningStatePayload>(READ_ENDPOINTS.openClawProvisioningState),
    getJson<ReadinessSignalsPayload>(READ_ENDPOINTS.openClawReadinessSignals),
    getJson<OperatingNorthPayload>(READ_ENDPOINTS.operatingNorth),
    getJson<KillSwitchPayload>(READ_ENDPOINTS.killSwitch),
    getJson<AuditEventsPayload>(READ_ENDPOINTS.auditEvents),
    getJson<SenderNodesPayload>(READ_ENDPOINTS.senderNodes),
    getJson<IpReputationReportsPayload>(READ_ENDPOINTS.ipReputationReports),
    getJson<SendResultsPayload>(READ_ENDPOINTS.sendResults),
    getJson<StuckJobsPayload>(READ_ENDPOINTS.stuckJobs),
    getJson<OperationalSummaryPayload>(READ_ENDPOINTS.operationalSummary),
    getJson<IamRolesPayload>(READ_ENDPOINTS.iamRoles),
    getJson<IamSessionsPayload>(READ_ENDPOINTS.iamSessions),
    getJson<ComplianceStatusPayload>(READ_ENDPOINTS.complianceStatus),
    getJson<OpenClawSkillsAuditPayload>(READ_ENDPOINTS.openClawSkillsAudit),
    getJson<OpenClawEvidencePayload>(READ_ENDPOINTS.openClawEvidence),
    getJson<WebdockInventoryPayload>(READ_ENDPOINTS.webdockInventory)
  ]);

  return {
    health,
    clusters: adminClusters.clusterOverview,
    overview: adminOverview.overview,
    workflow: adminWorkflow.workflow,
    snapshotIngestion: collectorSnapshotIngestion.snapshotIngestion,
    collector: collectorStatus.collector,
    supervisedCollector: collectorSupervisedPlan.supervisedCollector,
    physicalHost: hardwarePhysicalHost.physicalHost,
    telemetryHistory: hardwareTelemetryHistory.history,
    telemetry: hardwareTelemetryLatest.telemetry,
    learningPlan: openClawLearningPlan.learningPlan,
    canvas: openClawLiveCanvas.canvas,
    onboardingState: openClawOnboardingState.onboardingState,
    provisioningState: openClawProvisioningState.provisioningState,
    readinessSignals: openClawReadinessSignals.signals,
    operatingNorth,
    killSwitch: killSwitch.killSwitch,
    auditEvents: auditEvents.events ?? [],
    senderNodes: senderNodes.nodes ?? [],
    ipReputationReports: ipReputationReports.reports ?? [],
    sendResults: sendResults.results ?? [],
    stuckJobs,
    operationalSummary: operationalSummary.summary,
    iamRoles: iamRoles.roles ?? [],
    iamSessions: iamSessions.sessions ?? [],
    complianceControls: complianceStatus.controls ?? [],
    safetyRealtime: {
      iamRoles: iamRoles.meta ?? null,
      iamSessions: iamSessions.meta ?? null,
      complianceStatus: complianceStatus.meta ?? null
    },
    openClawSkillsAudit: openClawSkillsAudit.events ?? [],
    openClawEvidence: openClawEvidence.curated ?? [],
    webdockInventory: webdockInventory.inventory,
    webdockDrift: webdockInventory.drift
  };
}

export async function getJson<TPayload>(endpoint: ReadEndpoint): Promise<TPayload> {
  assertReadEndpoint(endpoint);

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      accept: "application/json"
    },
    cache: "no-store"
  });

  const payload = await response.json().catch(() => ({})) as Partial<{ message: string }>;

  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : `GET ${endpoint} failed.`;
    throw new Error(message);
  }

  return payload as TPayload;
}

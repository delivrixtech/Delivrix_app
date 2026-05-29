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

/**
 * Codex 50876e5 (OPS OrbStack): /health ahora reporta el status real de
 * postgres y redis con SELECT 1 y PING. Frontend usa estos chips en el
 * topbar para visibilidad rápida sin entrar a `/safety`.
 */
export type DependencyStatus = "ok" | "down";

export interface DependencyCheck {
  status: DependencyStatus;
  checkedAt: string;
  message?: string;
}

export interface HealthPayload {
  status: string;
  service: string;
  phase: string;
  /** Codex 50876e5 — status agregado de Postgres pgvector. */
  postgres?: DependencyStatus;
  /** Codex 50876e5 — status agregado de Redis. */
  redis?: DependencyStatus;
  /** Codex 50876e5 — detalle con checkedAt y opcional message. */
  dependencies?: {
    postgres: DependencyCheck;
    redis: DependencyCheck;
  };
  openClaw: Record<string, boolean | string>;
  operatingNorth: {
    delivrixSendsRealEmail: boolean;
    nfcSendsRealEmail: boolean;
    nfcProductionWritesEnabled: boolean;
    liveInfrastructureWritesEnabled: boolean;
  };
}

/**
 * Detalle ES de un gate del norte operativo. Codex lo expone en commit
 * 6500a15 (A-ALT-02 — auditoría frontend jueves 28-may).
 * Mantenemos `gates: string[]` por compat con el read-boundary.
 */
export interface OperatingNorthGateDetail {
  id: string;
  displayLabel: string;
  description?: string;
}

export interface OperatingNorthRoleDisplayNames {
  control_plane: string;
  future_optional_external_integration: string;
  intelligent_cluster_operator_read_only: string;
}

export interface OperatingNorthPayload {
  phase: string;
  /** Codex 6500a15: separado de `releasePhase` para distinguir runtime de sprint. */
  environment?: "mvp.local";
  releasePhase?: string;
  delivrixRole: string;
  openClawRole: string;
  nfcRole: string;
  /** Codex 6500a15: nombres ES de los 3 roles del norte. */
  roleDisplayNames?: OperatingNorthRoleDisplayNames;
  allowedActions: string[];
  blockedActions: string[];
  gates: string[];
  /** Codex 6500a15: gates con displayLabel ES + description opcional. */
  gateDetails?: OperatingNorthGateDetail[];
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
    // A-CRIT-04 (2026-05-28): Codex agrega este field opcional para que
    // el empty state pueda decir "última captura aceptada hace Xh".
    // Mientras no lo retorne el backend, el frontend usa copy genérico.
    lastCaptureAt?: string | null;
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
      x?: number;
      y?: number;
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

/**
 * Sección del onboarding con conteo de campos detectados. Codex 6500a15
 * (A-MED-07). Permite al frontend mostrar tag warning si detectedFieldCount=0
 * en vez del verde "detectado por el recolector" engañoso.
 */
export interface OpenClawOnboardingSectionState {
  id: string;
  displayName: string;
  detectedFieldCount: number;
  totalFieldCount: number;
  source: "onboarding.snapshot" | "fallback.mock";
}

export interface OpenClawOnboardingStatePayload {
  onboardingState: ContractBase & {
    /** Codex 6500a15 (A-MED-05): runtime env separado del sprint phase. */
    environment?: "mvp.local";
    releasePhase?: string;
    readinessByCategory: Record<string, number>;
    /** Codex 6500a15 (A-MED-07): conteo de campos detectados por sección. */
    sections?: OpenClawOnboardingSectionState[];
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
  /**
   * Codex 6500a15 (A-BAJ-04): label expandido en ES, ej. "Operador
   * supervisado (sólo lectura)" en vez del `name` corto "Operador".
   * Opcional para backward compat.
   */
  displayName?: string;
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

export interface DashboardLearningRealtimeMeta {
  openClawSkillsAudit: RealTimeMeta | null;
  openClawEvidence: RealTimeMeta | null;
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
  meta?: RealTimeMeta | null;
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
  meta?: RealTimeMeta | null;
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
  learningRealtime: DashboardLearningRealtimeMeta;
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
    learningRealtime: {
      openClawSkillsAudit: openClawSkillsAudit.meta ?? null,
      openClawEvidence: openClawEvidence.meta ?? null
    },
    openClawSkillsAudit: openClawSkillsAudit.events ?? [],
    openClawEvidence: openClawEvidence.curated ?? [],
    webdockInventory: webdockInventory.inventory,
    webdockDrift: webdockInventory.drift
  };
}

/* ============================================================
 * Hito 5.12 — placement-check (Gmail IMAP, sub-agente D)
 *
 * Endpoint POST /v1/openclaw/skills/placement-check. NO está en
 * READ_ENDPOINTS — usa postJson sin assertReadEndpoint. El App Password
 * jamás se envía desde el panel; el adapter lo carga del .env del gateway.
 * ============================================================ */

export type PlacementMatchBy = "subject" | "from" | "messageId";
export type PlacementFolder = "inbox" | "spam" | "promotions" | "other";

export interface PlacementSample {
  uid: number;
  folder: PlacementFolder;
  subject: string;
  from: string;
  receivedAt: string;
}

export interface PlacementCheckResult {
  ok: true;
  rampId?: string;
  matched: number;
  inbox: number;
  spam: number;
  promotions: number;
  other: number;
  placementRate: number;
  samples: PlacementSample[];
  meta: {
    matcher: string;
    matchBy: PlacementMatchBy;
    windowMinutes: number;
    queriedAt: string;
    elapsedMs: number;
  };
}

export interface PlacementCheckRequest {
  matchBy: PlacementMatchBy;
  matcher: string;
  windowMinutes: number;
  actorId: string;
  rampId?: string;
}

export interface PlacementCheckError {
  ok: false;
  error: string;
  message: string;
}

export async function postPlacementCheck(
  input: PlacementCheckRequest
): Promise<PlacementCheckResult> {
  const response = await fetch("/v1/openclaw/skills/placement-check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(input),
    cache: "no-store"
  });

  const payload = (await response.json().catch(() => ({}))) as
    | PlacementCheckResult
    | PlacementCheckError
    | Partial<{ message: string; error: string }>;

  if (!response.ok || ("ok" in payload && payload.ok === false)) {
    const errorCode =
      "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `http_${response.status}`;
    const message =
      "message" in payload && typeof payload.message === "string"
        ? payload.message
        : `POST /v1/openclaw/skills/placement-check failed (${response.status}).`;
    const err = new Error(`${errorCode}: ${message}`);
    (err as Error & { code: string }).code = errorCode;
    throw err;
  }

  return payload as PlacementCheckResult;
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

/**
 * Variante de getJson para endpoints con query string. La base sigue validada
 * contra el read boundary; los params se serializan via URLSearchParams.
 *
 * Uso: getJsonWithQuery<T>(READ_ENDPOINTS.domainAvailability, { name: "foo.com" })
 */
export async function getJsonWithQuery<TPayload>(
  base: ReadEndpoint,
  params: Record<string, string | number | boolean | undefined | null>
): Promise<TPayload> {
  assertReadEndpoint(base);

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  const url = qs ? `${base}?${qs}` : base;

  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  const payload = (await response.json().catch(() => ({}))) as Partial<{ message: string }>;

  if (!response.ok) {
    const message = typeof payload.message === "string" ? payload.message : `GET ${url} failed.`;
    throw new Error(message);
  }

  return payload as TPayload;
}

/* ────────────────── Warmup Ramp (Bloque 10 · Carril C) ────────────────── */

export type WarmupRampState =
  | "running"
  | "paused"
  | "auto_paused"
  | "completed"
  | "failed";

export type WarmupRampPauseReason =
  | "manual"
  | "auto_bounce_rate"
  | "auto_delivery_floor"
  | "send_failed";

export interface WarmupRampBatch {
  batchIndex: number;
  scheduledAt: string;
  emailCount: number;
  status: "pending" | "running" | "sent" | "failed";
  sentCount?: number;
  bouncedCount?: number;
  deliveryRate?: number;
  bounceRate?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface WarmupRampStatus {
  rampId: string;
  domain: string;
  schedule: "demo-fast" | "production-14d";
  state: WarmupRampState;
  pauseReason?: WarmupRampPauseReason;
  serverSlug: string | null;
  serverIp: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  nextBatchAt?: string;
  totals: {
    planned: number;
    sent: number;
    bounced: number;
    deliveryRate: number;
    bounceRate: number;
  };
  batches: WarmupRampBatch[];
  sparkline: Array<{ batchIndex: number; emailCount: number; sentCount: number }>;
}

export async function getWarmupRamp(rampId: string): Promise<WarmupRampStatus> {
  // El read-boundary cubre solo by-domain; el lookup por rampId también es read-only
  // y vive en /v1/warmup/ramp/:id — lo permitimos con prefix match defensivo.
  const url = `/v1/warmup/ramp/${encodeURIComponent(rampId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<{ message: string }>;
  if (!response.ok) {
    throw new Error(
      typeof payload.message === "string" ? payload.message : `GET ${url} failed.`
    );
  }
  return payload as WarmupRampStatus;
}

export async function getWarmupRampByDomain(
  domain: string
): Promise<WarmupRampStatus | null> {
  const url = `${READ_ENDPOINTS.warmupRampByDomain}/${encodeURIComponent(domain)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  if (response.status === 404) return null;
  const payload = (await response.json().catch(() => ({}))) as Partial<{ message: string }>;
  if (!response.ok) {
    throw new Error(
      typeof payload.message === "string" ? payload.message : `GET ${url} failed.`
    );
  }
  return payload as WarmupRampStatus;
}

/**
 * Inicia un warmup ramp para un dominio. El operador (humano) elige las
 * direcciones de prueba en runtime — NO viven en .env. La env solo expone
 * un fallback opcional para tests automáticos.
 */
export interface StartWarmupRampInput {
  domain: string;
  schedule: "demo-fast" | "production-14d";
  recipientPool: string[]; // 3+ direcciones que el operador escribe en el panel
  actorId: string;
  approvalToken: string;
  serverSlug?: string;
  serverIp?: string;
}

export interface StartWarmupRampResult {
  ok: boolean;
  rampId?: string;
  batchesPlanned?: number;
  totalPlanned?: number;
  nextBatchAt?: string | null;
  status?: "started" | "blocked";
  blockers?: string[];
}

export async function startWarmupRamp(
  input: StartWarmupRampInput
): Promise<StartWarmupRampResult> {
  const url = "/v1/warmup/ramp/start";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(input)
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<{
    ok: boolean;
    rampId: string;
    batchesPlanned: number;
    totalPlanned: number;
    nextBatchAt: string | null;
    status: "started" | "blocked";
    blockers: string[];
    message: string;
  }>;
  if (response.status === 409) {
    // gates bloqueados (ej. WARMUP_ENABLE_SEND off, recipientPool too small)
    return {
      ok: false,
      status: "blocked",
      blockers: Array.isArray(payload.blockers) ? payload.blockers : []
    };
  }
  if (!response.ok) {
    throw new Error(
      typeof payload.message === "string" ? payload.message : `POST ${url} failed.`
    );
  }
  return {
    ok: payload.ok ?? true,
    rampId: payload.rampId,
    batchesPlanned: payload.batchesPlanned,
    totalPlanned: payload.totalPlanned,
    nextBatchAt: payload.nextBatchAt ?? null,
    status: payload.status ?? "started"
  };
}

export async function pauseWarmupRamp(
  rampId: string,
  actorId: string
): Promise<{ ok: boolean; status: WarmupRampState; rampId: string }> {
  const url = `/v1/warmup/ramp/${encodeURIComponent(rampId)}/pause`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ actorId })
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<{
    message: string;
    ok: boolean;
    status: WarmupRampState;
    rampId: string;
  }>;
  if (!response.ok) {
    throw new Error(
      typeof payload.message === "string" ? payload.message : `POST ${url} failed.`
    );
  }
  return {
    ok: payload.ok ?? false,
    status: payload.status ?? "paused",
    rampId: payload.rampId ?? rampId
  };
}

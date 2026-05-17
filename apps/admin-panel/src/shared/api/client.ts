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

export interface OpenClawCanvasPayload {
  canvas: ContractBase & {
    currentStepId: string;
    nodes: Array<{
      id: string;
      kind: string;
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
    killSwitch
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
    getJson<KillSwitchPayload>(READ_ENDPOINTS.killSwitch)
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
    killSwitch: killSwitch.killSwitch
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

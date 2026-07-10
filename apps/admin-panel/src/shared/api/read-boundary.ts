export const READ_ENDPOINTS = Object.freeze({
  health: "/health",
  adminClusters: "/v1/admin/clusters",
  adminOverview: "/v1/admin/overview",
  adminWorkflow: "/v1/admin/workflow",
  collectorSnapshotIngestion: "/v1/devops/collector/snapshot-ingestion",
  collectorStatus: "/v1/devops/collector/status",
  collectorSupervisedPlan: "/v1/devops/collector/supervised-plan",
  hardwarePhysicalHost: "/v1/hardware/physical-host",
  hardwareTelemetryHistory: "/v1/hardware/telemetry/history",
  hardwareTelemetryLatest: "/v1/hardware/telemetry/latest",
  openClawLearningPlan: "/v1/openclaw/learning-plan",
  openClawLiveCanvas: "/v1/openclaw/live-canvas",
  openClawOnboardingState: "/v1/openclaw/onboarding/state",
  openClawProposals: "/v1/openclaw/proposals",
  openClawProvisioningState: "/v1/openclaw/provisioning/state",
  openClawReadinessSignals: "/v1/openclaw/readiness-signals",
  openClawWorkspaceFile: "/v1/openclaw/workspace/file",
  openClawWorkspaceTree: "/v1/openclaw/workspace/tree",
  operatingNorth: "/v1/operating-north",
  killSwitch: "/v1/kill-switch",
  mxtoolboxDailyReport: "/v1/mxtoolbox/daily-report",
  mxtoolboxHealth: "/v1/mxtoolbox/health",
  auditEvents: "/v1/audit-events",
  senderPoolStatus: "/v1/sender-pool/status",
  senderPoolCredentialsExport: "/v1/sender-pool/credentials/export",
  senderNodes: "/v1/sender-nodes",
  ipReputationReports: "/v1/ip-reputation/reports",
  sendResults: "/v1/send-results",
  stuckJobs: "/v1/stuck-jobs",
  operationalSummary: "/v1/operational-summary",
  iamRoles: "/v1/iam/roles",
  iamSessions: "/v1/iam/sessions",
  complianceStatus: "/v1/compliance/status",
  openClawSkillsAudit: "/v1/openclaw/skills/audit",
  openClawEvidence: "/v1/openclaw/evidence",
  canvasLiveState: "/v1/canvas/live/state",
  webdockInventory: "/v1/webdock/inventory",
  infrastructureInventory: "/v1/infrastructure/inventory",
  awsDomainDiscovery: "/v1/infrastructure/domain-discovery",
  domainAvailability: "/v1/domains/availability",
  domainSuggestions: "/v1/domains/suggestions",
  domainPrices: "/v1/domains/prices",
  ownedDomains: "/v1/domains/owned",
  warmupRampByDomain: "/v1/warmup/ramp/by-domain",
  warmupStatus: "/v1/warmup/status"
} as const);

export type ReadEndpoint = (typeof READ_ENDPOINTS)[keyof typeof READ_ENDPOINTS];

export function listReadEndpoints(): ReadEndpoint[] {
  return Object.values(READ_ENDPOINTS);
}

export function assertReadEndpoint(endpoint: string): asserts endpoint is ReadEndpoint {
  if (!listReadEndpoints().includes(endpoint as ReadEndpoint)) {
    throw new Error(`Endpoint is outside the admin panel read boundary: ${endpoint}`);
  }
}

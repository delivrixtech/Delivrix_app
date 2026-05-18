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
  openClawProvisioningState: "/v1/openclaw/provisioning/state",
  openClawReadinessSignals: "/v1/openclaw/readiness-signals",
  operatingNorth: "/v1/operating-north",
  killSwitch: "/v1/kill-switch",
  auditEvents: "/v1/audit-events",
  senderNodes: "/v1/sender-nodes",
  ipReputationReports: "/v1/ip-reputation/reports",
  sendResults: "/v1/send-results",
  stuckJobs: "/v1/stuck-jobs",
  operationalSummary: "/v1/operational-summary",
  iamRoles: "/v1/iam/roles",
  iamSessions: "/v1/iam/sessions",
  complianceStatus: "/v1/compliance/status",
  openClawSkillsAudit: "/v1/openclaw/skills/audit",
  openClawEvidence: "/v1/openclaw/evidence"
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

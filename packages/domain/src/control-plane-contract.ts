export const controlPlaneContractSchemaVersion = "2026-05-08.v1";

export type ControlPlaneContractMode = "read_only";
export type ControlPlaneSourceKind = "mock" | "local" | "collector" | "proxmox" | "ipmi" | "prometheus";
export type ControlPlaneFreshness = "fresh" | "stale" | "unknown";
export type ControlPlaneRiskLevel = "low" | "medium" | "high" | "critical" | "unknown";
export type ControlPlaneReadinessStatus = "ready" | "needs_review" | "blocked" | "unknown";

export interface ControlPlaneSource {
  kind: ControlPlaneSourceKind;
  trusted: boolean;
  freshness: ControlPlaneFreshness;
  collectedAt: string | null;
}

export interface ControlPlaneQuality {
  completeness: number;
  confidence: number;
  unknownFields: string[];
}

export interface ControlPlaneSafety {
  liveInfrastructureWritesEnabled: false;
  sshEnabled: false;
  smtpEnabled: false;
  nfcWritesEnabled: false;
}

export interface ControlPlaneContractBase {
  schemaVersion: typeof controlPlaneContractSchemaVersion;
  generatedAt: string;
  mode: ControlPlaneContractMode;
  source: ControlPlaneSource;
  quality: ControlPlaneQuality;
  safety: ControlPlaneSafety;
}

export const readOnlyControlPlaneSafety: ControlPlaneSafety = {
  liveInfrastructureWritesEnabled: false,
  sshEnabled: false,
  smtpEnabled: false,
  nfcWritesEnabled: false
};

export function generatedAt(now = new Date()): string {
  return now.toISOString();
}

export function mockSource(overrides: Partial<ControlPlaneSource> = {}): ControlPlaneSource {
  return {
    kind: "mock",
    trusted: false,
    freshness: "unknown",
    collectedAt: null,
    ...overrides
  };
}

export function qualityFromUnknownFields(
  unknownFields: string[],
  confidence = 0
): ControlPlaneQuality {
  return {
    completeness: completenessFromUnknownFields(unknownFields),
    confidence: clampScore(confidence),
    unknownFields: [...unknownFields]
  };
}

export function buildContractBase(
  now = new Date(),
  source: ControlPlaneSource = mockSource(),
  quality: ControlPlaneQuality = qualityFromUnknownFields([])
): ControlPlaneContractBase {
  return {
    schemaVersion: controlPlaneContractSchemaVersion,
    generatedAt: generatedAt(now),
    mode: "read_only",
    source,
    quality,
    safety: readOnlyControlPlaneSafety
  };
}

function completenessFromUnknownFields(unknownFields: string[]): number {
  if (unknownFields.length === 0) {
    return 1;
  }

  return 0;
}

function clampScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

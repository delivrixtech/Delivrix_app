import {
  buildContractBase,
  type ControlPlaneContractBase,
  type ControlPlaneQuality,
  type ControlPlaneReadinessStatus,
  type ControlPlaneSource,
  mockSource,
  qualityFromUnknownFields
} from "./control-plane-contract.ts";

export interface PhysicalHostIdentity {
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
}

export interface PhysicalHostCapacity {
  cpuCores: number | null;
  cpuThreads: number | null;
  memoryGb: number | null;
  storageUsableGb: number | null;
  networkInterfaces: number;
  ipPoolSize: number | null;
}

export interface PhysicalHostReadiness {
  status: ControlPlaneReadinessStatus;
  blockers: string[];
  warnings: string[];
  requiredHumanInputs: string[];
  primaryBlocker?: string;
  recommendedNextStep?: PhysicalHostRecommendedNextStep;
}

export interface PhysicalHostRecommendedNextStep {
  label: string;
  endpoint: string;
  severity: "info" | "warning" | "critical";
}

export interface PhysicalHostSnapshot extends ControlPlaneContractBase {
  identity: PhysicalHostIdentity;
  capacity: PhysicalHostCapacity;
  readiness: PhysicalHostReadiness;
}

export interface BuildPhysicalHostSnapshotInput {
  identity?: Partial<PhysicalHostIdentity>;
  capacity?: Partial<PhysicalHostCapacity>;
  readiness?: Partial<PhysicalHostReadiness>;
  source?: ControlPlaneSource;
  quality?: ControlPlaneQuality;
  now?: Date;
}

const defaultUnknownFields = [
  "identity.model",
  "identity.operatingSystem",
  "identity.kernelVersion",
  "identity.proxmoxVersion",
  "identity.uptimeSeconds",
  "capacity.cpuCores",
  "capacity.cpuThreads",
  "capacity.memoryGb",
  "capacity.storageUsableGb",
  "capacity.ipPoolSize"
];

export function buildPhysicalHostSnapshot(input: BuildPhysicalHostSnapshotInput = {}): PhysicalHostSnapshot {
  const identity: PhysicalHostIdentity = {
    hostId: "physical_host_primary",
    label: "Servidor fisico primario",
    vendor: "IBM/Lenovo",
    model: "unknown",
    serialNumber: "redacted_or_unknown",
    location: "Popayan",
    operatingSystem: "unknown",
    kernelVersion: "unknown",
    proxmoxVersion: "unknown",
    uptimeSeconds: null,
    ...input.identity
  };
  const capacity: PhysicalHostCapacity = {
    cpuCores: null,
    cpuThreads: null,
    memoryGb: null,
    storageUsableGb: null,
    networkInterfaces: 0,
    ipPoolSize: null,
    ...input.capacity
  };
  const readiness = buildReadiness(input.readiness, identity, capacity);
  const unknownFields = collectUnknownFields(identity, capacity);
  const quality = input.quality ?? qualityFromUnknownFields(unknownFields, unknownFields.length === 0 ? 0.75 : 0);

  return {
    ...buildContractBase(input.now, input.source ?? mockSource(), quality),
    identity,
    capacity,
    readiness
  };
}

function buildReadiness(
  input: Partial<PhysicalHostReadiness> | undefined,
  identity: PhysicalHostIdentity,
  capacity: PhysicalHostCapacity
): PhysicalHostReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const requiredHumanInputs: string[] = [];

  if (identity.model === "unknown") {
    requiredHumanInputs.push("server_model");
  }

  if (capacity.cpuCores === null || capacity.memoryGb === null || capacity.storageUsableGb === null) {
    blockers.push("hardware_capacity_unknown");
    requiredHumanInputs.push("cpu_memory_storage_capacity");
  }

  if (capacity.ipPoolSize === null) {
    warnings.push("ip_pool_size_unknown");
    requiredHumanInputs.push("ip_pool_size");
  }

  const resolvedBlockers = input?.blockers ?? blockers;
  const resolvedWarnings = input?.warnings ?? warnings;
  const resolvedRequiredHumanInputs = input?.requiredHumanInputs ?? requiredHumanInputs;
  const primaryBlocker = input?.primaryBlocker ?? primaryBlockerFor(resolvedBlockers, resolvedWarnings);

  return {
    status: input?.status ?? (resolvedBlockers.length > 0 ? "unknown" : resolvedWarnings.length > 0 ? "needs_review" : "ready"),
    blockers: resolvedBlockers,
    warnings: resolvedWarnings,
    requiredHumanInputs: resolvedRequiredHumanInputs,
    ...(primaryBlocker ? { primaryBlocker } : {}),
    ...(input?.recommendedNextStep
      ? { recommendedNextStep: input.recommendedNextStep }
      : recommendedNextStepFor(primaryBlocker))
  };
}

function primaryBlockerFor(blockers: string[], warnings: string[]): string | undefined {
  return blockers[0] ?? warnings[0];
}

function recommendedNextStepFor(primaryBlocker: string | undefined): Partial<Pick<PhysicalHostReadiness, "recommendedNextStep">> {
  if (!primaryBlocker) {
    return {};
  }

  if (primaryBlocker === "hardware_capacity_unknown") {
    return {
      recommendedNextStep: {
        label: "Ingestar snapshot manual",
        endpoint: "POST /v1/devops/collector/manual-snapshots/ingest",
        severity: "warning"
      }
    };
  }

  if (primaryBlocker === "ip_pool_size_unknown") {
    return {
      recommendedNextStep: {
        label: "Confirmar tamano del pool de IPs",
        endpoint: "POST /v1/devops/collector/manual-snapshots/ingest",
        severity: "info"
      }
    };
  }

  return {
    recommendedNextStep: {
      label: "Completar evidencia del host fisico",
      endpoint: "POST /v1/devops/collector/manual-snapshots/ingest",
      severity: "warning"
    }
  };
}

function collectUnknownFields(
  identity: PhysicalHostIdentity,
  capacity: PhysicalHostCapacity
): string[] {
  return defaultUnknownFields.filter((field) => {
    if (field === "identity.model") return identity.model === "unknown";
    if (field === "identity.operatingSystem") return identity.operatingSystem === "unknown";
    if (field === "identity.kernelVersion") return identity.kernelVersion === "unknown";
    if (field === "identity.proxmoxVersion") return identity.proxmoxVersion === "unknown";
    if (field === "identity.uptimeSeconds") return identity.uptimeSeconds === null;
    if (field === "capacity.cpuCores") return capacity.cpuCores === null;
    if (field === "capacity.cpuThreads") return capacity.cpuThreads === null;
    if (field === "capacity.memoryGb") return capacity.memoryGb === null;
    if (field === "capacity.storageUsableGb") return capacity.storageUsableGb === null;
    if (field === "capacity.ipPoolSize") return capacity.ipPoolSize === null;
    return false;
  });
}

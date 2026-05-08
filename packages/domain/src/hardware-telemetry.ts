import {
  buildContractBase,
  type ControlPlaneContractBase,
  type ControlPlaneQuality,
  type ControlPlaneRiskLevel,
  type ControlPlaneSource,
  mockSource,
  qualityFromUnknownFields
} from "./control-plane-contract.ts";

export type HardwareMetricStatus = "healthy" | "warning" | "critical" | "unknown";

export interface HardwareTelemetrySummary {
  status: HardwareMetricStatus;
  riskLevel: ControlPlaneRiskLevel;
  stale: boolean;
}

export interface HardwareCpuTelemetry {
  usagePercent: number | null;
  loadAverage: number[];
  temperatureCelsius: number | null;
  thermalStatus: HardwareMetricStatus;
}

export interface HardwareMemoryTelemetry {
  totalGb: number | null;
  usedGb: number | null;
  availableGb: number | null;
  usagePercent: number | null;
  swapUsagePercent: number | null;
}

export interface HardwareStorageTelemetry {
  totalGb: number | null;
  usedGb: number | null;
  availableGb: number | null;
  usagePercent: number | null;
  smartStatus: HardwareMetricStatus;
  ioWaitPercent: number | null;
}

export interface HardwareNetworkTelemetry {
  interfaces: Array<{
    name: string;
    linkSpeedMbps: number | null;
    ipAddresses: string[];
    rxMbps: number | null;
    txMbps: number | null;
    packetDrops: number | null;
    errors: number | null;
  }>;
  rxMbps: number | null;
  txMbps: number | null;
  packetDrops: number | null;
  latencyMs: number | null;
}

export interface HardwarePowerTelemetry {
  watts: number | null;
  psuStatus: HardwareMetricStatus;
  upsStatus: HardwareMetricStatus;
  fanStatus: HardwareMetricStatus;
  chassisTemperatureCelsius: number | null;
}

export interface HardwareTelemetrySnapshot extends ControlPlaneContractBase {
  summary: HardwareTelemetrySummary;
  cpu: HardwareCpuTelemetry;
  memory: HardwareMemoryTelemetry;
  storage: HardwareStorageTelemetry;
  network: HardwareNetworkTelemetry;
  power: HardwarePowerTelemetry;
}

export interface HardwareTelemetryPoint {
  timestamp: string;
  value: number | null;
  quality: "observed" | "gap" | "unknown";
}

export interface HardwareTelemetrySeries {
  metric: string;
  unit: "percent" | "gb" | "mbps" | "ms" | "watts" | "celsius" | "count";
  points: HardwareTelemetryPoint[];
}

export interface HardwareTelemetryHistorySnapshot extends ControlPlaneContractBase {
  window: string;
  series: HardwareTelemetrySeries[];
  gaps: Array<{
    metric: string;
    reason: string;
    startedAt?: string;
    endedAt?: string;
  }>;
}

export interface BuildHardwareTelemetrySnapshotInput {
  summary?: Partial<HardwareTelemetrySummary>;
  cpu?: Partial<HardwareCpuTelemetry>;
  memory?: Partial<HardwareMemoryTelemetry>;
  storage?: Partial<HardwareStorageTelemetry>;
  network?: Partial<HardwareNetworkTelemetry>;
  power?: Partial<HardwarePowerTelemetry>;
  source?: ControlPlaneSource;
  quality?: ControlPlaneQuality;
  now?: Date;
}

export interface BuildHardwareTelemetryHistoryInput {
  window?: string;
  series?: HardwareTelemetrySeries[];
  gaps?: HardwareTelemetryHistorySnapshot["gaps"];
  source?: ControlPlaneSource;
  quality?: ControlPlaneQuality;
  now?: Date;
}

const telemetryUnknownFields = [
  "cpu.usagePercent",
  "cpu.temperatureCelsius",
  "memory.totalGb",
  "memory.usagePercent",
  "storage.totalGb",
  "storage.smartStatus",
  "network.interfaces",
  "network.rxMbps",
  "network.txMbps",
  "network.latencyMs",
  "power.watts",
  "power.psuStatus",
  "power.upsStatus",
  "power.fanStatus",
  "power.chassisTemperatureCelsius"
];

export function buildHardwareTelemetrySnapshot(
  input: BuildHardwareTelemetrySnapshotInput = {}
): HardwareTelemetrySnapshot {
  const cpu: HardwareCpuTelemetry = {
    usagePercent: null,
    loadAverage: [],
    temperatureCelsius: null,
    thermalStatus: "unknown",
    ...input.cpu
  };
  const memory: HardwareMemoryTelemetry = {
    totalGb: null,
    usedGb: null,
    availableGb: null,
    usagePercent: null,
    swapUsagePercent: null,
    ...input.memory
  };
  const storage: HardwareStorageTelemetry = {
    totalGb: null,
    usedGb: null,
    availableGb: null,
    usagePercent: null,
    smartStatus: "unknown",
    ioWaitPercent: null,
    ...input.storage
  };
  const network: HardwareNetworkTelemetry = {
    interfaces: [],
    rxMbps: null,
    txMbps: null,
    packetDrops: null,
    latencyMs: null,
    ...input.network
  };
  const power: HardwarePowerTelemetry = {
    watts: null,
    psuStatus: "unknown",
    upsStatus: "unknown",
    fanStatus: "unknown",
    chassisTemperatureCelsius: null,
    ...input.power
  };
  const summary: HardwareTelemetrySummary = {
    status: "unknown",
    riskLevel: "unknown",
    stale: true,
    ...input.summary
  };
  const unknownFields = collectTelemetryUnknownFields(cpu, memory, storage, network, power);
  const quality = input.quality ?? qualityFromUnknownFields(unknownFields, unknownFields.length === 0 ? 0.8 : 0);

  return {
    ...buildContractBase(input.now, input.source ?? mockSource(), quality),
    summary,
    cpu,
    memory,
    storage,
    network,
    power
  };
}

export function buildHardwareTelemetryHistory(
  input: BuildHardwareTelemetryHistoryInput = {}
): HardwareTelemetryHistorySnapshot {
  const series = input.series ?? [];
  const gaps = input.gaps ?? [];
  const unknownFields = series.length === 0 ? ["series"] : [];
  const quality = input.quality ?? qualityFromUnknownFields(unknownFields, series.length > 0 ? 0.6 : 0);

  return {
    ...buildContractBase(input.now, input.source ?? mockSource(), quality),
    window: input.window ?? "1h",
    series,
    gaps
  };
}

function collectTelemetryUnknownFields(
  cpu: HardwareCpuTelemetry,
  memory: HardwareMemoryTelemetry,
  storage: HardwareStorageTelemetry,
  network: HardwareNetworkTelemetry,
  power: HardwarePowerTelemetry
): string[] {
  return telemetryUnknownFields.filter((field) => {
    if (field === "cpu.usagePercent") return cpu.usagePercent === null;
    if (field === "cpu.temperatureCelsius") return cpu.temperatureCelsius === null;
    if (field === "memory.totalGb") return memory.totalGb === null;
    if (field === "memory.usagePercent") return memory.usagePercent === null;
    if (field === "storage.totalGb") return storage.totalGb === null;
    if (field === "storage.smartStatus") return storage.smartStatus === "unknown";
    if (field === "network.interfaces") return network.interfaces.length === 0;
    if (field === "network.rxMbps") return network.rxMbps === null;
    if (field === "network.txMbps") return network.txMbps === null;
    if (field === "network.latencyMs") return network.latencyMs === null;
    if (field === "power.watts") return power.watts === null;
    if (field === "power.psuStatus") return power.psuStatus === "unknown";
    if (field === "power.upsStatus") return power.upsStatus === "unknown";
    if (field === "power.fanStatus") return power.fanStatus === "unknown";
    if (field === "power.chassisTemperatureCelsius") return power.chassisTemperatureCelsius === null;
    return false;
  });
}

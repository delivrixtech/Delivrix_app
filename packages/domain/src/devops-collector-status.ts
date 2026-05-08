import {
  buildContractBase,
  type ControlPlaneContractBase,
  type ControlPlaneSourceKind,
  mockSource,
  qualityFromUnknownFields
} from "./control-plane-contract.ts";

export type DevOpsCollectorMode = "mock" | "local" | "agent" | "prometheus" | "proxmox" | "ipmi";
export type DevOpsCollectorStatusValue = "ready" | "degraded" | "unavailable" | "unknown";

export interface DevOpsCollectorSourceStatus {
  kind: ControlPlaneSourceKind;
  enabled: boolean;
  readOnly: true;
  lastCollectedAt: string | null;
  error: string | null;
}

export interface DevOpsCollectorPermissions {
  sshEnabled: false;
  proxmoxApiWriteEnabled: false;
  ipmiEnabled: boolean;
  prometheusEnabled: boolean;
}

export interface DevOpsCollectorStatus extends ControlPlaneContractBase {
  collectorMode: DevOpsCollectorMode;
  status: DevOpsCollectorStatusValue;
  sources: DevOpsCollectorSourceStatus[];
  permissions: DevOpsCollectorPermissions;
  unknownCapabilities: string[];
  collectorVersion: string;
}

export interface BuildDevOpsCollectorStatusInput {
  collectorMode?: DevOpsCollectorMode;
  status?: DevOpsCollectorStatusValue;
  sources?: DevOpsCollectorSourceStatus[];
  permissions?: Partial<DevOpsCollectorPermissions>;
  unknownCapabilities?: string[];
  collectorVersion?: string;
  now?: Date;
}

const defaultUnknownCapabilities = [
  "power.watts",
  "fanStatus",
  "chassisTemperatureCelsius",
  "ipmi.redfish",
  "proxmox.readOnlyApi"
];

export function buildDevOpsCollectorStatus(input: BuildDevOpsCollectorStatusInput = {}): DevOpsCollectorStatus {
  const sources = input.sources ?? [
    {
      kind: "mock",
      enabled: true,
      readOnly: true,
      lastCollectedAt: null,
      error: null
    }
  ];
  const unknownCapabilities = input.unknownCapabilities ?? defaultUnknownCapabilities;

  return {
    ...buildContractBase(
      input.now,
      mockSource({
        kind: sources[0]?.kind ?? "mock",
        freshness: sources.some((source) => source.lastCollectedAt) ? "fresh" : "unknown",
        collectedAt: sources.find((source) => source.lastCollectedAt)?.lastCollectedAt ?? null
      }),
      qualityFromUnknownFields(unknownCapabilities, unknownCapabilities.length === 0 ? 0.8 : 0.15)
    ),
    collectorMode: input.collectorMode ?? "mock",
    status: input.status ?? "ready",
    sources,
    permissions: {
      sshEnabled: false,
      proxmoxApiWriteEnabled: false,
      ipmiEnabled: false,
      prometheusEnabled: false,
      ...input.permissions
    },
    unknownCapabilities,
    collectorVersion: input.collectorVersion ?? "mock-collector-0"
  };
}

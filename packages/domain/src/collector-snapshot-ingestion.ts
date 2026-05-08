import { createHash } from "node:crypto";
import type { AuditEvent, AuditRiskLevel } from "./audit-log.ts";
import {
  buildContractBase,
  mockSource,
  qualityFromUnknownFields,
  type ControlPlaneContractBase,
  type ControlPlaneReadinessStatus
} from "./control-plane-contract.ts";
import {
  buildPhysicalHostSnapshot,
  type BuildPhysicalHostSnapshotInput,
  type PhysicalHostSnapshot
} from "./hardware-inventory.ts";
import {
  buildHardwareTelemetrySnapshot,
  type BuildHardwareTelemetrySnapshotInput,
  type HardwareMetricStatus,
  type HardwareTelemetrySnapshot
} from "./hardware-telemetry.ts";

export const manualCollectorSnapshotSchemaVersion = "2026-05-08.collector-snapshot.v1" as const;

export type ManualCollectorSnapshotStatus = "accepted" | "needs_review" | "rejected";
export type ManualCollectorSnapshotFieldType = "string" | "number" | "status" | "array" | "object";

export interface ManualCollectorSnapshotEndpoint {
  method: "POST";
  path: "/v1/devops/collector/manual-snapshots/ingest";
  exposedInAdminPanel: false;
  requiresHumanApproval: true;
  storesRawPayload: false;
}

export interface ManualCollectorSnapshotAcceptedField {
  path: string;
  type: ManualCollectorSnapshotFieldType;
  mapsTo: string;
  requiredFor: "physical_host" | "telemetry" | "readiness" | "optional";
}

export interface ManualCollectorSnapshotRedactionPolicy {
  rejectsSecretLikeKeys: true;
  storesRawSecrets: false;
  rejectedKeys: string[];
  rejectedKeyPatterns: string[];
  redactsBeforeHash: true;
}

export interface ManualCollectorSnapshotUiPolicy {
  adminPanelCanPost: false;
  adminPanelCanUploadFiles: false;
  adminPanelShowsContractOnly: true;
  allowedPanelMethods: ["GET"];
  manualIngestionRequiresExternalOperatorAction: true;
}

export interface ManualCollectorSnapshotIngestionContract extends ControlPlaneContractBase {
  status: ControlPlaneReadinessStatus;
  snapshotSchemaVersion: typeof manualCollectorSnapshotSchemaVersion;
  manualEndpoint: ManualCollectorSnapshotEndpoint;
  uiPolicy: ManualCollectorSnapshotUiPolicy;
  acceptedFieldPaths: ManualCollectorSnapshotAcceptedField[];
  redactionPolicy: ManualCollectorSnapshotRedactionPolicy;
  parserOutputs: ["physicalHost", "telemetry"];
  gates: string[];
  nextSafeActions: string[];
  blockedActions: string[];
}

export interface ManualCollectorSnapshotRedactionResult {
  rejectedPaths: string[];
  retainedTopLevelKeys: string[];
  secretLikeFieldsRemoved: number;
}

export interface ManualCollectorSnapshotParsedOutput {
  physicalHost: PhysicalHostSnapshot;
  telemetry: HardwareTelemetrySnapshot;
}

export interface ManualCollectorSnapshotIngestionResult extends ControlPlaneContractBase {
  snapshotSchemaVersion: typeof manualCollectorSnapshotSchemaVersion;
  snapshotId: string;
  snapshotHash: string;
  status: ManualCollectorSnapshotStatus;
  redaction: ManualCollectorSnapshotRedactionResult;
  recognizedFieldPaths: string[];
  parsed: ManualCollectorSnapshotParsedOutput;
  auditEventCandidate: Omit<AuditEvent, "id" | "occurredAt">;
  warnings: string[];
  blockedBy: string[];
  nextSafeActions: string[];
}

export interface BuildManualCollectorSnapshotIngestionContractInput {
  now?: Date;
}

export interface IngestManualCollectorSnapshotInput {
  actorId: string;
  rawSnapshot: unknown;
  now?: Date;
}

const rejectedKeys = [
  "private_key",
  "password",
  "token",
  "secret",
  "smtp_credentials",
  "ssh_private_key"
];

const rejectedKeyPatternSources = [
  "password",
  "token",
  "secret",
  "private[_-]?key",
  "smtp[_-]?credentials",
  "ssh[_-]?private[_-]?key",
  "api[_-]?key",
  "credential"
];

const secretLikeKeyPattern = new RegExp(rejectedKeyPatternSources.join("|"), "i");

const acceptedFieldPaths: ManualCollectorSnapshotAcceptedField[] = [
  { path: "host.label", type: "string", mapsTo: "physicalHost.identity.label", requiredFor: "optional" },
  { path: "host.vendor", type: "string", mapsTo: "physicalHost.identity.vendor", requiredFor: "optional" },
  { path: "host.model", type: "string", mapsTo: "physicalHost.identity.model", requiredFor: "readiness" },
  { path: "host.location", type: "string", mapsTo: "physicalHost.identity.location", requiredFor: "optional" },
  { path: "host.operatingSystem", type: "string", mapsTo: "physicalHost.identity.operatingSystem", requiredFor: "optional" },
  { path: "host.kernelVersion", type: "string", mapsTo: "physicalHost.identity.kernelVersion", requiredFor: "optional" },
  { path: "host.proxmoxVersion", type: "string", mapsTo: "physicalHost.identity.proxmoxVersion", requiredFor: "optional" },
  { path: "host.uptimeSeconds", type: "number", mapsTo: "physicalHost.identity.uptimeSeconds", requiredFor: "optional" },
  { path: "capacity.cpuCores", type: "number", mapsTo: "physicalHost.capacity.cpuCores", requiredFor: "readiness" },
  { path: "capacity.cpuThreads", type: "number", mapsTo: "physicalHost.capacity.cpuThreads", requiredFor: "optional" },
  { path: "capacity.memoryGb", type: "number", mapsTo: "physicalHost.capacity.memoryGb", requiredFor: "readiness" },
  { path: "capacity.storageUsableGb", type: "number", mapsTo: "physicalHost.capacity.storageUsableGb", requiredFor: "readiness" },
  { path: "capacity.networkInterfaces", type: "number", mapsTo: "physicalHost.capacity.networkInterfaces", requiredFor: "optional" },
  { path: "capacity.ipPoolSize", type: "number", mapsTo: "physicalHost.capacity.ipPoolSize", requiredFor: "optional" },
  { path: "telemetry.cpu.usagePercent", type: "number", mapsTo: "telemetry.cpu.usagePercent", requiredFor: "telemetry" },
  { path: "telemetry.cpu.temperatureCelsius", type: "number", mapsTo: "telemetry.cpu.temperatureCelsius", requiredFor: "optional" },
  { path: "telemetry.cpu.loadAverage", type: "array", mapsTo: "telemetry.cpu.loadAverage", requiredFor: "optional" },
  { path: "telemetry.memory.totalGb", type: "number", mapsTo: "telemetry.memory.totalGb", requiredFor: "optional" },
  { path: "telemetry.memory.usedGb", type: "number", mapsTo: "telemetry.memory.usedGb", requiredFor: "optional" },
  { path: "telemetry.memory.availableGb", type: "number", mapsTo: "telemetry.memory.availableGb", requiredFor: "optional" },
  { path: "telemetry.memory.usagePercent", type: "number", mapsTo: "telemetry.memory.usagePercent", requiredFor: "telemetry" },
  { path: "telemetry.storage.totalGb", type: "number", mapsTo: "telemetry.storage.totalGb", requiredFor: "optional" },
  { path: "telemetry.storage.usedGb", type: "number", mapsTo: "telemetry.storage.usedGb", requiredFor: "optional" },
  { path: "telemetry.storage.availableGb", type: "number", mapsTo: "telemetry.storage.availableGb", requiredFor: "optional" },
  { path: "telemetry.storage.usagePercent", type: "number", mapsTo: "telemetry.storage.usagePercent", requiredFor: "telemetry" },
  { path: "telemetry.storage.smartStatus", type: "status", mapsTo: "telemetry.storage.smartStatus", requiredFor: "optional" },
  { path: "telemetry.network.rxMbps", type: "number", mapsTo: "telemetry.network.rxMbps", requiredFor: "optional" },
  { path: "telemetry.network.txMbps", type: "number", mapsTo: "telemetry.network.txMbps", requiredFor: "optional" },
  { path: "telemetry.network.packetDrops", type: "number", mapsTo: "telemetry.network.packetDrops", requiredFor: "optional" },
  { path: "telemetry.network.latencyMs", type: "number", mapsTo: "telemetry.network.latencyMs", requiredFor: "optional" },
  { path: "telemetry.power.watts", type: "number", mapsTo: "telemetry.power.watts", requiredFor: "optional" },
  { path: "telemetry.power.psuStatus", type: "status", mapsTo: "telemetry.power.psuStatus", requiredFor: "optional" },
  { path: "telemetry.power.upsStatus", type: "status", mapsTo: "telemetry.power.upsStatus", requiredFor: "optional" },
  { path: "telemetry.power.fanStatus", type: "status", mapsTo: "telemetry.power.fanStatus", requiredFor: "optional" },
  { path: "telemetry.power.chassisTemperatureCelsius", type: "number", mapsTo: "telemetry.power.chassisTemperatureCelsius", requiredFor: "optional" }
];

export function buildManualCollectorSnapshotIngestionContract(
  input: BuildManualCollectorSnapshotIngestionContractInput = {}
): ManualCollectorSnapshotIngestionContract {
  const unknownFields = acceptedFieldPaths
    .filter((field) => field.requiredFor === "readiness" || field.requiredFor === "telemetry")
    .map((field) => field.path);

  return {
    ...buildContractBase(
      input.now,
      mockSource({
        kind: "collector",
        freshness: "unknown",
        collectedAt: null
      }),
      qualityFromUnknownFields(unknownFields, 0.25)
    ),
    status: "needs_review",
    snapshotSchemaVersion: manualCollectorSnapshotSchemaVersion,
    manualEndpoint: {
      method: "POST",
      path: "/v1/devops/collector/manual-snapshots/ingest",
      exposedInAdminPanel: false,
      requiresHumanApproval: true,
      storesRawPayload: false
    },
    uiPolicy: {
      adminPanelCanPost: false,
      adminPanelCanUploadFiles: false,
      adminPanelShowsContractOnly: true,
      allowedPanelMethods: ["GET"],
      manualIngestionRequiresExternalOperatorAction: true
    },
    acceptedFieldPaths,
    redactionPolicy: buildRedactionPolicy(),
    parserOutputs: ["physicalHost", "telemetry"],
    gates: [
      "manual_snapshot_requires_operator",
      "redact_before_hash",
      "hash_required_before_audit",
      "append_only_audit_event_required",
      "admin_panel_remains_get_only",
      "no_ssh_from_snapshot_ingestion",
      "no_live_proxmox_write_from_snapshot_ingestion"
    ],
    nextSafeActions: [
      "capture_local_snapshot_outside_admin_panel",
      "remove_secret_like_fields_before_submit",
      "submit_snapshot_to_gateway_manual_endpoint",
      "review_snapshot_hash_and_redaction_report",
      "let_frontend_refresh_get_contracts_only"
    ],
    blockedActions: [
      "admin-ui-post",
      "automatic-ssh-scan",
      "proxmox-live-create",
      "ipmi-power-cycle",
      "dns-live-change",
      "smtp-send"
    ]
  };
}

export function ingestManualCollectorSnapshot(
  input: IngestManualCollectorSnapshotInput
): ManualCollectorSnapshotIngestionResult {
  const now = input.now ?? new Date();
  const actorId = input.actorId.trim() || "operator_local";
  const redaction = redactSnapshot(input.rawSnapshot);
  const redactedRecord = isPlainRecord(redaction.value) ? redaction.value : {};
  const recognizedFieldPaths = collectRecognizedFieldPaths(redactedRecord);
  const snapshotHash = hashCanonicalJson(redaction.value);
  const snapshotId = `collector_snapshot_${snapshotHash.slice(0, 12)}`;
  const blockedBy = deriveBlockedReasons(input.rawSnapshot, recognizedFieldPaths);
  const status = deriveIngestionStatus(blockedBy, redaction.rejectedPaths);
  const warnings = deriveWarnings(status, redaction.rejectedPaths, recognizedFieldPaths);
  const parsed = parseSnapshotOutputs(redactedRecord, now);
  const riskLevel = riskForStatus(status);

  return {
    ...buildContractBase(
      now,
      mockSource({
        kind: "local",
        trusted: false,
        freshness: status === "rejected" ? "unknown" : "fresh",
        collectedAt: status === "rejected" ? null : now.toISOString()
      }),
      qualityFromUnknownFields(blockedBy, status === "accepted" ? 0.8 : status === "needs_review" ? 0.45 : 0)
    ),
    snapshotSchemaVersion: manualCollectorSnapshotSchemaVersion,
    snapshotId,
    snapshotHash,
    status,
    redaction: {
      rejectedPaths: redaction.rejectedPaths,
      retainedTopLevelKeys: Object.keys(redactedRecord).sort(),
      secretLikeFieldsRemoved: redaction.rejectedPaths.length
    },
    recognizedFieldPaths,
    parsed,
    auditEventCandidate: {
      actorType: "operator",
      actorId,
      action: "collector.manual_snapshot_ingested",
      targetType: "collector_snapshot",
      targetId: snapshotId,
      riskLevel,
      metadata: {
        snapshotSchemaVersion: manualCollectorSnapshotSchemaVersion,
        snapshotHash,
        status,
        recognizedFieldPaths,
        rejectedPaths: redaction.rejectedPaths,
        blockedBy,
        adminPanelCanPost: false,
        storesRawPayload: false,
        liveInfrastructureWritesEnabled: false,
        sshEnabled: false,
        smtpEnabled: false,
        nfcWritesEnabled: false
      }
    },
    warnings,
    blockedBy,
    nextSafeActions: nextActionsForStatus(status)
  };
}

function buildRedactionPolicy(): ManualCollectorSnapshotRedactionPolicy {
  return {
    rejectsSecretLikeKeys: true,
    storesRawSecrets: false,
    rejectedKeys,
    rejectedKeyPatterns: rejectedKeyPatternSources,
    redactsBeforeHash: true
  };
}

function redactSnapshot(value: unknown): { value: unknown; rejectedPaths: string[] } {
  const rejectedPaths: string[] = [];
  const redacted = redactValue(value, [], rejectedPaths);

  return {
    value: redacted,
    rejectedPaths
  };
}

function redactValue(value: unknown, path: string[], rejectedPaths: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, [...path, String(index)], rejectedPaths));
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];

    if (isSecretLikeKey(key)) {
      rejectedPaths.push(nextPath.join("."));
      continue;
    }

    redacted[key] = redactValue(child, nextPath, rejectedPaths);
  }

  return redacted;
}

function isSecretLikeKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return rejectedKeys.includes(normalized) || secretLikeKeyPattern.test(normalized);
}

function collectRecognizedFieldPaths(snapshot: Record<string, unknown>): string[] {
  return acceptedFieldPaths
    .filter((field) => getPath(snapshot, field.path) !== undefined)
    .map((field) => field.path);
}

function deriveBlockedReasons(rawSnapshot: unknown, recognizedFieldPaths: string[]): string[] {
  const blockedBy: string[] = [];

  if (!isPlainRecord(rawSnapshot)) {
    blockedBy.push("snapshot_payload_must_be_object");
  }

  if (recognizedFieldPaths.length === 0) {
    blockedBy.push("snapshot_has_no_recognized_operational_fields");
  }

  return blockedBy;
}

function deriveIngestionStatus(
  blockedBy: string[],
  rejectedPaths: string[]
): ManualCollectorSnapshotStatus {
  if (blockedBy.length > 0) {
    return "rejected";
  }

  if (rejectedPaths.length > 0) {
    return "needs_review";
  }

  return "accepted";
}

function deriveWarnings(
  status: ManualCollectorSnapshotStatus,
  rejectedPaths: string[],
  recognizedFieldPaths: string[]
): string[] {
  const warnings: string[] = [];

  if (status === "needs_review") {
    warnings.push("operator_review_required_before_contract_promotion");
  }

  if (rejectedPaths.length > 0) {
    warnings.push("secret_like_fields_removed_before_hash");
  }

  if (recognizedFieldPaths.length < acceptedFieldPaths.length) {
    warnings.push("snapshot_is_partial");
  }

  return warnings;
}

function parseSnapshotOutputs(
  snapshot: Record<string, unknown>,
  now: Date
): ManualCollectorSnapshotParsedOutput {
  const source = mockSource({
    kind: "local",
    trusted: false,
    freshness: "fresh",
    collectedAt: now.toISOString()
  });
  const physicalHostInput: BuildPhysicalHostSnapshotInput = {
    now,
    source,
    identity: definedProperties({
      label: stringFromPaths(snapshot, ["host.label", "identity.label"]),
      vendor: stringFromPaths(snapshot, ["host.vendor", "identity.vendor"]),
      model: stringFromPaths(snapshot, ["host.model", "identity.model"]),
      location: stringFromPaths(snapshot, ["host.location", "identity.location"]),
      operatingSystem: stringFromPaths(snapshot, ["host.operatingSystem", "identity.operatingSystem"]),
      kernelVersion: stringFromPaths(snapshot, ["host.kernelVersion", "identity.kernelVersion"]),
      proxmoxVersion: stringFromPaths(snapshot, ["host.proxmoxVersion", "identity.proxmoxVersion"]),
      uptimeSeconds: numberFromPaths(snapshot, ["host.uptimeSeconds", "identity.uptimeSeconds"])
    }),
    capacity: definedProperties({
      cpuCores: numberFromPaths(snapshot, ["capacity.cpuCores"]),
      cpuThreads: numberFromPaths(snapshot, ["capacity.cpuThreads"]),
      memoryGb: numberFromPaths(snapshot, ["capacity.memoryGb"]),
      storageUsableGb: numberFromPaths(snapshot, ["capacity.storageUsableGb"]),
      networkInterfaces: integerFromPaths(snapshot, ["capacity.networkInterfaces"]),
      ipPoolSize: numberFromPaths(snapshot, ["capacity.ipPoolSize"])
    })
  };
  const telemetryInput: BuildHardwareTelemetrySnapshotInput = {
    now,
    source,
    summary: {
      status: "healthy",
      riskLevel: "low",
      stale: false
    },
    cpu: definedProperties({
      usagePercent: numberFromPaths(snapshot, ["telemetry.cpu.usagePercent"]),
      temperatureCelsius: numberFromPaths(snapshot, ["telemetry.cpu.temperatureCelsius"]),
      loadAverage: numberArrayFromPath(snapshot, "telemetry.cpu.loadAverage")
    }),
    memory: definedProperties({
      totalGb: numberFromPaths(snapshot, ["telemetry.memory.totalGb"]),
      usedGb: numberFromPaths(snapshot, ["telemetry.memory.usedGb"]),
      availableGb: numberFromPaths(snapshot, ["telemetry.memory.availableGb"]),
      usagePercent: numberFromPaths(snapshot, ["telemetry.memory.usagePercent"]),
      swapUsagePercent: numberFromPaths(snapshot, ["telemetry.memory.swapUsagePercent"])
    }),
    storage: definedProperties({
      totalGb: numberFromPaths(snapshot, ["telemetry.storage.totalGb"]),
      usedGb: numberFromPaths(snapshot, ["telemetry.storage.usedGb"]),
      availableGb: numberFromPaths(snapshot, ["telemetry.storage.availableGb"]),
      usagePercent: numberFromPaths(snapshot, ["telemetry.storage.usagePercent"]),
      smartStatus: statusFromPaths(snapshot, ["telemetry.storage.smartStatus"]),
      ioWaitPercent: numberFromPaths(snapshot, ["telemetry.storage.ioWaitPercent"])
    }),
    network: definedProperties({
      rxMbps: numberFromPaths(snapshot, ["telemetry.network.rxMbps"]),
      txMbps: numberFromPaths(snapshot, ["telemetry.network.txMbps"]),
      packetDrops: numberFromPaths(snapshot, ["telemetry.network.packetDrops"]),
      latencyMs: numberFromPaths(snapshot, ["telemetry.network.latencyMs"])
    }),
    power: definedProperties({
      watts: numberFromPaths(snapshot, ["telemetry.power.watts"]),
      psuStatus: statusFromPaths(snapshot, ["telemetry.power.psuStatus"]),
      upsStatus: statusFromPaths(snapshot, ["telemetry.power.upsStatus"]),
      fanStatus: statusFromPaths(snapshot, ["telemetry.power.fanStatus"]),
      chassisTemperatureCelsius: numberFromPaths(snapshot, ["telemetry.power.chassisTemperatureCelsius"])
    })
  };

  return {
    physicalHost: buildPhysicalHostSnapshot(physicalHostInput),
    telemetry: buildHardwareTelemetrySnapshot(telemetryInput)
  };
}

function riskForStatus(status: ManualCollectorSnapshotStatus): AuditRiskLevel {
  if (status === "accepted") {
    return "low";
  }

  if (status === "needs_review") {
    return "medium";
  }

  return "high";
}

function nextActionsForStatus(status: ManualCollectorSnapshotStatus): string[] {
  if (status === "accepted") {
    return [
      "review_audit_event",
      "refresh_admin_panel_get_contracts",
      "compare_snapshot_against_physical_host_contract"
    ];
  }

  if (status === "needs_review") {
    return [
      "review_redaction_report",
      "confirm_no_secret_values_remain",
      "resubmit_cleaner_snapshot_if_needed"
    ];
  }

  return [
    "submit_valid_json_object",
    "include_host_capacity_or_telemetry_fields",
    "keep_admin_panel_read_only"
  ];
}

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortForCanonicalJson(value)))
    .digest("hex");
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortForCanonicalJson(child)])
  );
}

function stringFromPaths(snapshot: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getPath(snapshot, path);

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function integerFromPaths(snapshot: Record<string, unknown>, paths: string[]): number | undefined {
  const value = numberFromPaths(snapshot, paths);
  return value === undefined ? undefined : Math.max(0, Math.trunc(value));
}

function numberFromPaths(snapshot: Record<string, unknown>, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = getPath(snapshot, path);
    const parsed = numberFromUnknown(value);

    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function numberArrayFromPath(snapshot: Record<string, unknown>, path: string): number[] | undefined {
  const value = getPath(snapshot, path);

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map(numberFromUnknown)
    .filter((item): item is number => item !== undefined);
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function definedProperties<TValue extends Record<string, unknown>>(value: TValue): Partial<TValue> {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined)
  ) as Partial<TValue>;
}

function statusFromPaths(snapshot: Record<string, unknown>, paths: string[]): HardwareMetricStatus | undefined {
  for (const path of paths) {
    const value = getPath(snapshot, path);

    if (isHardwareMetricStatus(value)) {
      return value;
    }
  }

  return undefined;
}

function isHardwareMetricStatus(value: unknown): value is HardwareMetricStatus {
  return value === "healthy" || value === "warning" || value === "critical" || value === "unknown";
}

function getPath(snapshot: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!isPlainRecord(current)) {
      return undefined;
    }

    return current[part];
  }, snapshot);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

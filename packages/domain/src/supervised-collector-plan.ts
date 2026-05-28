import {
  buildContractBase,
  type ControlPlaneContractBase,
  type ControlPlaneFreshness,
  type ControlPlaneQuality,
  type ControlPlaneReadinessStatus,
  type ControlPlaneSource,
  type ControlPlaneSourceKind,
  mockSource,
  qualityFromUnknownFields
} from "./control-plane-contract.ts";

export type SupervisedCollectorMode = "supervised_read_only";
export type SupervisedCollectorTransport = "local_command" | "read_only_api" | "http_scrape" | "manual_snapshot";

export interface SupervisedCollectorFreshness {
  lastCollectedAt: string | null;
  maxAgeSeconds: number;
  stale: boolean;
}

export interface SupervisedCollectorSafeCollection {
  transport: SupervisedCollectorTransport;
  requiresSecret: boolean;
  writesEnabled: false;
  commandPreview: string | null;
  endpoint: string | null;
}

export interface SupervisedCollectorSource {
  id: string;
  kind: ControlPlaneSourceKind;
  label: string;
  purpose: string;
  status: ControlPlaneReadinessStatus;
  readOnly: true;
  minimumPermission: string;
  expectedSignals: string[];
  expectedInMvp: boolean;
  url: string | null;
  safeCollection: SupervisedCollectorSafeCollection;
  freshness: SupervisedCollectorFreshness;
  blockedBy: string[];
  blockedReason?: string;
  blockedReasonOperator?: string;
}

export interface SupervisedCollectorIngestionPolicy {
  acceptsManualSnapshot: true;
  acceptsLiveMutation: false;
  requiresOperatorApprovalForSourceChange: true;
  storesRawSecrets: false;
  snapshotSchemaVersion: "2026-05-08.collector.v1";
}

export interface SupervisedCollectorAuditPolicy {
  appendOnly: true;
  redactsSecrets: true;
  snapshotHashRequired: true;
  retainedFields: string[];
  rejectedFields: string[];
}

export interface SupervisedCollectorFreshnessSummary {
  freshSources: number;
  staleSources: number;
  unknownSources: number;
  lastCollectedAt: string | null;
  staleAfterSeconds: number;
}

export interface SupervisedCollectorPlan extends ControlPlaneContractBase {
  collectorMode: SupervisedCollectorMode;
  status: ControlPlaneReadinessStatus;
  sources: SupervisedCollectorSource[];
  ingestionPolicy: SupervisedCollectorIngestionPolicy;
  auditPolicy: SupervisedCollectorAuditPolicy;
  freshness: SupervisedCollectorFreshnessSummary;
  gates: string[];
  nextSafeActions: string[];
  blockedActions: string[];
}

export interface BuildSupervisedCollectorPlanInput {
  sources?: SupervisedCollectorSource[];
  source?: ControlPlaneSource;
  quality?: ControlPlaneQuality;
  now?: Date;
}

const snapshotSchemaVersion = "2026-05-08.collector.v1" as const;
const defaultStaleAfterSeconds = 300;

export function buildSupervisedCollectorPlan(
  input: BuildSupervisedCollectorPlanInput = {}
): SupervisedCollectorPlan {
  const sources = input.sources ?? buildDefaultCollectorSources();
  const freshness = summarizeFreshness(sources);
  const unknownFields = collectCollectorUnknownFields(sources);
  const quality = input.quality ?? qualityFromUnknownFields(
    unknownFields,
    freshness.freshSources > 0 ? 0.35 : 0.2
  );
  const status = deriveCollectorPlanStatus(sources);

  return {
    ...buildContractBase(
      input.now,
      input.source ?? mockSource({
        kind: "collector",
        freshness: freshness.freshSources > 0 ? "fresh" : "unknown",
        collectedAt: freshness.lastCollectedAt
      }),
      quality
    ),
    collectorMode: "supervised_read_only",
    status,
    sources,
    ingestionPolicy: {
      acceptsManualSnapshot: true,
      acceptsLiveMutation: false,
      requiresOperatorApprovalForSourceChange: true,
      storesRawSecrets: false,
      snapshotSchemaVersion
    },
    auditPolicy: {
      appendOnly: true,
      redactsSecrets: true,
      snapshotHashRequired: true,
      retainedFields: [
        "source.kind",
        "source.freshness",
        "hardware.identity.redacted",
        "hardware.capacity",
        "telemetry.summary",
        "telemetry.cpu",
        "telemetry.memory",
        "telemetry.storage",
        "telemetry.network",
        "telemetry.power.status"
      ],
      rejectedFields: [
        "private_key",
        "password",
        "token",
        "secret",
        "smtp_credentials",
        "ssh_private_key"
      ]
    },
    freshness,
    gates: [
      "collector_read_only_only",
      "operator_approves_source_changes",
      "snapshot_redaction_before_storage",
      "append_only_audit_event_required",
      "no_ssh_without_human_approval",
      "no_proxmox_write_permission",
      "no_smtp_activation_from_collector"
    ],
    nextSafeActions: [
      "confirm_physical_host_inventory",
      "choose_first_read_only_source",
      "capture_manual_snapshot_with_redaction",
      "configure_prometheus_or_node_exporter_read_only",
      "confirm_proxmox_read_only_api_scope",
      "verify_ipmi_or_redfish_availability"
    ],
    blockedActions: [
      "ssh-connect",
      "proxmox-live-create",
      "proxmox-live-update",
      "ipmi-power-cycle",
      "dns-live-change",
      "smtp-send"
    ]
  };
}

export function buildDefaultCollectorSources(): SupervisedCollectorSource[] {
  return [
    {
      id: "local_hardware_snapshot",
      kind: "local",
      label: "Snapshot local de hardware",
      purpose: "Capturar CPU, RAM, storage, red y version del host sin modificar el servidor.",
      status: "needs_review",
      readOnly: true,
      minimumPermission: "operator_shell_read_only_or_manual_upload",
      expectedSignals: [
        "cpu.cores",
        "cpu.threads",
        "memory.totalGb",
        "storage.usableGb",
        "network.interfaces",
        "kernel.version",
        "uptime.seconds"
      ],
      expectedInMvp: true,
      url: null,
      safeCollection: {
        transport: "manual_snapshot",
        requiresSecret: false,
        writesEnabled: false,
        commandPreview: "lscpu && free -g && lsblk --json && ip -j addr",
        endpoint: null
      },
      freshness: freshness(null, "unknown"),
      blockedBy: ["manual_snapshot_not_uploaded"],
      blockedReason: "manual_snapshot_not_uploaded",
      blockedReasonOperator: "Falta cargar un snapshot manual redactado del host físico."
    },
    {
      id: "proxmox_read_only_api",
      kind: "proxmox",
      label: "API Proxmox read-only",
      purpose: "Leer nodos, storage, LXC/VM y version de Proxmox sin crear ni modificar recursos.",
      status: "blocked",
      readOnly: true,
      minimumPermission: "proxmox_auditor_role",
      expectedSignals: [
        "proxmox.version",
        "nodes.status",
        "storage.availableGb",
        "lxc.count",
        "vm.count"
      ],
      expectedInMvp: true,
      url: null,
      safeCollection: {
        transport: "read_only_api",
        requiresSecret: true,
        writesEnabled: false,
        commandPreview: null,
        endpoint: null
      },
      freshness: freshness(null, "unknown"),
      blockedBy: ["missing_proxmox_endpoint", "missing_read_only_token", "operator_approval_required"],
      blockedReason: "missing_proxmox_endpoint",
      blockedReasonOperator: "Falta configurar la URL real de Proxmox y un token read-only aprobado."
    },
    {
      id: "prometheus_node_exporter",
      kind: "prometheus",
      label: "Prometheus / Node Exporter",
      purpose: "Recolectar metricas de CPU, memoria, storage, red y temperatura con scraping read-only.",
      status: "blocked",
      readOnly: true,
      minimumPermission: "http_get_metrics_only",
      expectedSignals: [
        "node_cpu_seconds_total",
        "node_memory_MemTotal_bytes",
        "node_filesystem_avail_bytes",
        "node_network_receive_bytes_total",
        "node_hwmon_temp_celsius"
      ],
      expectedInMvp: true,
      url: "http://127.0.0.1:9100/metrics",
      safeCollection: {
        transport: "http_scrape",
        requiresSecret: false,
        writesEnabled: false,
        commandPreview: "GET /metrics",
        endpoint: "http://127.0.0.1:9100/metrics"
      },
      freshness: freshness(null, "unknown"),
      blockedBy: ["node_exporter_not_confirmed", "prometheus_url_missing"],
      blockedReason: "node_exporter_not_confirmed",
      blockedReasonOperator: "Falta confirmar que Node Exporter está instalado y accesible solo por lectura."
    },
    {
      id: "ipmi_redfish",
      kind: "ipmi",
      label: "IPMI / Redfish",
      purpose: "Leer energia, temperatura, ventiladores y chasis si el hardware lo soporta.",
      status: "blocked",
      readOnly: true,
      minimumPermission: "bmc_read_only",
      expectedSignals: [
        "power.watts",
        "fan.status",
        "psu.status",
        "chassis.temperatureCelsius"
      ],
      expectedInMvp: false,
      url: null,
      safeCollection: {
        transport: "read_only_api",
        requiresSecret: true,
        writesEnabled: false,
        commandPreview: null,
        endpoint: null
      },
      freshness: freshness(null, "unknown"),
      blockedBy: ["hardware_capability_unconfirmed", "bmc_network_missing", "read_only_credentials_missing"],
      blockedReason: "hardware_capability_unconfirmed",
      blockedReasonOperator: "IPMI/Redfish es opcional: primero hay que confirmar que el hardware lo soporta."
    }
  ];
}

function freshness(
  lastCollectedAt: string | null,
  freshnessValue: ControlPlaneFreshness,
  maxAgeSeconds = defaultStaleAfterSeconds
): SupervisedCollectorFreshness {
  return {
    lastCollectedAt,
    maxAgeSeconds,
    stale: freshnessValue !== "fresh"
  };
}

function summarizeFreshness(sources: SupervisedCollectorSource[]): SupervisedCollectorFreshnessSummary {
  const collectedAtValues = sources
    .map((source) => source.freshness.lastCollectedAt)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const lastCollectedAt = mostRecentIso(collectedAtValues);

  return {
    freshSources: sources.filter((source) => source.freshness.lastCollectedAt && !source.freshness.stale).length,
    staleSources: sources.filter((source) => source.freshness.lastCollectedAt && source.freshness.stale).length,
    unknownSources: sources.filter((source) => !source.freshness.lastCollectedAt).length,
    lastCollectedAt,
    staleAfterSeconds: sources.length > 0
      ? Math.min(...sources.map((source) => source.freshness.maxAgeSeconds))
      : defaultStaleAfterSeconds
  };
}

function mostRecentIso(values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }

  return values
    .slice()
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function collectCollectorUnknownFields(sources: SupervisedCollectorSource[]): string[] {
  return sources.flatMap((source) => {
    if (source.status === "ready" && source.blockedBy.length === 0) {
      return [];
    }

    return source.blockedBy.map((reason) => `${source.id}.${reason}`);
  });
}

function deriveCollectorPlanStatus(sources: SupervisedCollectorSource[]): ControlPlaneReadinessStatus {
  if (sources.every((source) => source.status === "ready")) {
    return "ready";
  }

  if (sources.some((source) => source.status === "needs_review")) {
    return "needs_review";
  }

  return "blocked";
}

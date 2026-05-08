import {
  buildContractBase,
  type ControlPlaneContractBase,
  type ControlPlaneReadinessStatus,
  mockSource,
  qualityFromUnknownFields
} from "./control-plane-contract.ts";
import type { HardwareTelemetrySnapshot } from "./hardware-telemetry.ts";
import type { PhysicalHostSnapshot } from "./hardware-inventory.ts";

export type OpenClawScoreStatus = ControlPlaneReadinessStatus;

export interface OpenClawReadinessScore {
  score: number | null;
  confidence: number;
  status: OpenClawScoreStatus;
  reason: string;
}

export interface OpenClawReadinessRecommendation {
  id: string;
  label: string;
  status: OpenClawScoreStatus;
  evidenceRefs: string[];
  requiresHumanApproval: boolean;
}

export interface OpenClawModelGovernance {
  modelMode: "rules_and_evals";
  modelVersion: "none";
  promptVersion: "none";
  canSelfPromote: false;
  requiresHumanApproval: true;
}

export interface OpenClawReadinessSignals extends ControlPlaneContractBase {
  scores: {
    hardwareCapacity: OpenClawReadinessScore;
    thermalRisk: OpenClawReadinessScore;
    provisioningReadiness: OpenClawReadinessScore;
  };
  recommendations: OpenClawReadinessRecommendation[];
  modelGovernance: OpenClawModelGovernance;
}

export interface BuildOpenClawReadinessSignalsInput {
  physicalHost?: PhysicalHostSnapshot;
  telemetry?: HardwareTelemetrySnapshot;
  recommendations?: OpenClawReadinessRecommendation[];
  now?: Date;
}

export function buildOpenClawReadinessSignals(
  input: BuildOpenClawReadinessSignalsInput = {}
): OpenClawReadinessSignals {
  const hardwareCapacity = hardwareCapacityScore(input.physicalHost);
  const thermalRisk = thermalRiskScore(input.telemetry);
  const provisioningReadiness = provisioningReadinessScore(input.physicalHost, input.telemetry);
  const recommendations = input.recommendations ?? buildRecommendations(hardwareCapacity, thermalRisk, provisioningReadiness);
  const unknownFields = collectUnknownFields(hardwareCapacity, thermalRisk, provisioningReadiness);

  return {
    ...buildContractBase(
      input.now,
      mockSource(),
      qualityFromUnknownFields(unknownFields, unknownFields.length === 0 ? 0.7 : 0)
    ),
    scores: {
      hardwareCapacity,
      thermalRisk,
      provisioningReadiness
    },
    recommendations,
    modelGovernance: {
      modelMode: "rules_and_evals",
      modelVersion: "none",
      promptVersion: "none",
      canSelfPromote: false,
      requiresHumanApproval: true
    }
  };
}

function hardwareCapacityScore(physicalHost: PhysicalHostSnapshot | undefined): OpenClawReadinessScore {
  if (!physicalHost || physicalHost.readiness.status === "unknown") {
    return {
      score: null,
      confidence: 0,
      status: "unknown",
      reason: "hardware_capacity_unknown"
    };
  }

  if (physicalHost.readiness.status === "blocked") {
    return {
      score: 0,
      confidence: 0.6,
      status: "blocked",
      reason: "physical_host_readiness_blocked"
    };
  }

  return {
    score: physicalHost.readiness.status === "ready" ? 1 : 0.5,
    confidence: 0.6,
    status: physicalHost.readiness.status,
    reason: "physical_host_readiness_available"
  };
}

function thermalRiskScore(telemetry: HardwareTelemetrySnapshot | undefined): OpenClawReadinessScore {
  if (!telemetry || telemetry.cpu.temperatureCelsius === null) {
    return {
      score: null,
      confidence: 0,
      status: "unknown",
      reason: "sensor_not_available"
    };
  }

  if (telemetry.cpu.temperatureCelsius >= 85) {
    return {
      score: 0,
      confidence: 0.75,
      status: "blocked",
      reason: "cpu_temperature_critical"
    };
  }

  if (telemetry.cpu.temperatureCelsius >= 75) {
    return {
      score: 0.4,
      confidence: 0.65,
      status: "needs_review",
      reason: "cpu_temperature_warning"
    };
  }

  return {
    score: 1,
    confidence: 0.65,
    status: "ready",
    reason: "thermal_signal_within_threshold"
  };
}

function provisioningReadinessScore(
  physicalHost: PhysicalHostSnapshot | undefined,
  telemetry: HardwareTelemetrySnapshot | undefined
): OpenClawReadinessScore {
  if (!physicalHost || !telemetry || physicalHost.readiness.status !== "ready" || telemetry.summary.status === "unknown") {
    return {
      score: null,
      confidence: 0,
      status: "needs_review",
      reason: "dry_run_required"
    };
  }

  return {
    score: 0.6,
    confidence: 0.5,
    status: "needs_review",
    reason: "provisioning_dry_run_required_before_ready"
  };
}

function buildRecommendations(
  hardwareCapacity: OpenClawReadinessScore,
  thermalRisk: OpenClawReadinessScore,
  provisioningReadiness: OpenClawReadinessScore
): OpenClawReadinessRecommendation[] {
  const recommendations: OpenClawReadinessRecommendation[] = [];

  if (hardwareCapacity.status === "unknown") {
    recommendations.push({
      id: "collect_hardware_capacity",
      label: "Recolectar capacidad CPU/RAM/storage/IP antes de planear VPS.",
      status: "needs_review",
      evidenceRefs: ["hardwareCapacity"],
      requiresHumanApproval: false
    });
  }

  if (thermalRisk.status === "unknown") {
    recommendations.push({
      id: "confirm_sensor_availability",
      label: "Confirmar sensores de temperatura/energia o marcar como no disponibles.",
      status: "needs_review",
      evidenceRefs: ["thermalRisk"],
      requiresHumanApproval: false
    });
  }

  if (provisioningReadiness.status !== "ready") {
    recommendations.push({
      id: "run_provisioning_dry_run",
      label: "Mantener provisioning en dry-run hasta tener evidencia suficiente.",
      status: provisioningReadiness.status,
      evidenceRefs: ["provisioningReadiness"],
      requiresHumanApproval: false
    });
  }

  return recommendations;
}

function collectUnknownFields(...scores: OpenClawReadinessScore[]): string[] {
  const labels = ["scores.hardwareCapacity", "scores.thermalRisk", "scores.provisioningReadiness"];

  return scores
    .map((score, index) => ({ score, index }))
    .filter(({ score }) => score.score === null || score.status === "unknown")
    .map(({ index }) => labels[index])
    .filter((label): label is string => typeof label === "string");
}

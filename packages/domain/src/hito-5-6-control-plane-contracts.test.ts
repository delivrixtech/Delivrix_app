import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDevOpsCollectorStatus,
  buildHardwareTelemetryHistory,
  buildHardwareTelemetrySnapshot,
  buildOpenClawLiveCanvas,
  buildOpenClawOnboardingState,
  buildOpenClawProvisioningState,
  buildOpenClawReadinessSignals,
  buildPhysicalHostSnapshot,
  controlPlaneContractSchemaVersion,
  evaluateOpenClawOnboarding,
  mockSource
} from "./index.ts";

const fixedNow = new Date("2026-05-08T15:00:00.000Z");

test("physical host contract starts unknown, safe, and redacted", () => {
  const physicalHost = buildPhysicalHostSnapshot({ now: fixedNow });

  assert.equal(physicalHost.schemaVersion, controlPlaneContractSchemaVersion);
  assert.equal(physicalHost.generatedAt, fixedNow.toISOString());
  assert.equal(physicalHost.mode, "read_only");
  assert.equal(physicalHost.identity.serialNumber, "redacted_or_unknown");
  assert.equal(physicalHost.readiness.status, "unknown");
  assert.ok(physicalHost.readiness.blockers.includes("hardware_capacity_unknown"));
  assert.ok(physicalHost.quality.unknownFields.includes("capacity.cpuCores"));
  assert.equal(physicalHost.safety.liveInfrastructureWritesEnabled, false);
  assert.equal(physicalHost.safety.sshEnabled, false);
  assert.equal(physicalHost.safety.smtpEnabled, false);
  assert.equal(physicalHost.safety.nfcWritesEnabled, false);
});

test("physical host contract can become ready only with explicit capacity evidence", () => {
  const physicalHost = buildPhysicalHostSnapshot({
    now: fixedNow,
    source: mockSource({
      kind: "local",
      freshness: "fresh",
      collectedAt: fixedNow.toISOString()
    }),
    identity: {
      model: "IBM System x3630 M4",
      operatingSystem: "Ubuntu Server 24.04 LTS",
      kernelVersion: "6.8.0",
      proxmoxVersion: "8.2",
      uptimeSeconds: 3600
    },
    capacity: {
      cpuCores: 24,
      cpuThreads: 48,
      memoryGb: 256,
      storageUsableGb: 4000,
      networkInterfaces: 4,
      ipPoolSize: 16
    }
  });

  assert.equal(physicalHost.source.kind, "local");
  assert.equal(physicalHost.source.freshness, "fresh");
  assert.equal(physicalHost.readiness.status, "ready");
  assert.deepEqual(physicalHost.readiness.blockers, []);
  assert.deepEqual(physicalHost.quality.unknownFields, []);
});

test("hardware telemetry defaults to stale unknown values and history is explicit", () => {
  const telemetry = buildHardwareTelemetrySnapshot({ now: fixedNow });
  const history = buildHardwareTelemetryHistory({ now: fixedNow });

  assert.equal(telemetry.summary.status, "unknown");
  assert.equal(telemetry.summary.stale, true);
  assert.equal(telemetry.cpu.temperatureCelsius, null);
  assert.ok(telemetry.quality.unknownFields.includes("power.watts"));
  assert.equal(telemetry.safety.liveInfrastructureWritesEnabled, false);
  assert.equal(history.window, "1h");
  assert.deepEqual(history.series, []);
  assert.ok(history.quality.unknownFields.includes("series"));
});

test("readiness signals expose evidence, null scores, and no model self-promotion", () => {
  const physicalHost = buildPhysicalHostSnapshot({ now: fixedNow });
  const telemetry = buildHardwareTelemetrySnapshot({ now: fixedNow });
  const signals = buildOpenClawReadinessSignals({
    physicalHost,
    telemetry,
    now: fixedNow
  });

  assert.equal(signals.scores.hardwareCapacity.score, null);
  assert.equal(signals.scores.hardwareCapacity.status, "unknown");
  assert.equal(signals.scores.thermalRisk.score, null);
  assert.equal(signals.scores.provisioningReadiness.reason, "dry_run_required");
  assert.equal(signals.modelGovernance.canSelfPromote, false);
  assert.equal(signals.modelGovernance.requiresHumanApproval, true);
  assert.ok(signals.recommendations.some((recommendation) => recommendation.evidenceRefs.includes("hardwareCapacity")));
});

test("readiness signals block critical thermal readings without enabling writes", () => {
  const physicalHost = buildPhysicalHostSnapshot({
    now: fixedNow,
    identity: {
      model: "IBM System x3630 M4",
      operatingSystem: "Ubuntu Server 24.04 LTS",
      kernelVersion: "6.8.0",
      proxmoxVersion: "8.2",
      uptimeSeconds: 3600
    },
    capacity: {
      cpuCores: 24,
      cpuThreads: 48,
      memoryGb: 256,
      storageUsableGb: 4000,
      networkInterfaces: 4,
      ipPoolSize: 16
    }
  });
  const telemetry = buildHardwareTelemetrySnapshot({
    now: fixedNow,
    summary: {
      status: "critical",
      riskLevel: "critical",
      stale: false
    },
    cpu: {
      usagePercent: 75,
      temperatureCelsius: 88,
      thermalStatus: "critical"
    }
  });
  const signals = buildOpenClawReadinessSignals({ physicalHost, telemetry, now: fixedNow });

  assert.equal(signals.scores.thermalRisk.status, "blocked");
  assert.equal(signals.scores.thermalRisk.reason, "cpu_temperature_critical");
  assert.equal(signals.safety.liveInfrastructureWritesEnabled, false);
});

test("OpenClaw state contracts keep onboarding and provisioning auditable", () => {
  const onboardingSnapshot = evaluateOpenClawOnboarding({}, fixedNow);
  const onboardingState = buildOpenClawOnboardingState({
    snapshot: onboardingSnapshot,
    now: fixedNow
  });
  const provisioningState = buildOpenClawProvisioningState({ now: fixedNow });

  assert.equal(onboardingState.canGenerateTopologyPlan, false);
  assert.ok(onboardingState.pendingQuestions.length > 0);
  assert.ok(onboardingState.blockers.includes("missing_server_model"));
  assert.equal(provisioningState.topologySource.id, null);
  assert.ok(provisioningState.steps.every((step) => step.status === "not_started"));
  assert.ok(provisioningState.blockedActions.includes("ssh-connect"));
});

test("DevOps collector status is read-only and declares unavailable capabilities", () => {
  const collector = buildDevOpsCollectorStatus({ now: fixedNow });

  assert.equal(collector.collectorMode, "mock");
  assert.equal(collector.status, "ready");
  assert.equal(collector.permissions.sshEnabled, false);
  assert.equal(collector.permissions.proxmoxApiWriteEnabled, false);
  assert.ok(collector.unknownCapabilities.includes("ipmi.redfish"));
  assert.equal(collector.sources[0]?.readOnly, true);
});

test("OpenClaw live canvas composes the graph without embedding sensitive operations", () => {
  const physicalHost = buildPhysicalHostSnapshot({ now: fixedNow });
  const telemetry = buildHardwareTelemetrySnapshot({ now: fixedNow });
  const onboardingState = buildOpenClawOnboardingState({
    snapshot: evaluateOpenClawOnboarding({}, fixedNow),
    now: fixedNow
  });
  const provisioningState = buildOpenClawProvisioningState({ now: fixedNow });
  const readinessSignals = buildOpenClawReadinessSignals({
    physicalHost,
    telemetry,
    now: fixedNow
  });
  const collector = buildDevOpsCollectorStatus({ now: fixedNow });
  const canvas = buildOpenClawLiveCanvas({
    physicalHost,
    telemetry,
    onboardingState,
    provisioningState,
    readinessSignals,
    collector,
    now: fixedNow
  });

  assert.equal(canvas.mode, "read_only");
  assert.equal(canvas.currentStepId, "physical_host");
  assert.ok(canvas.nodes.some((node) => node.id === "physical_host"));
  assert.ok(canvas.nodes.some((node) => node.id === "prepared_capacity" && node.status === "disabled_by_mvp"));
  assert.ok(canvas.edges.some((edge) => edge.from === "proxmox_host" && edge.to === "cluster_plan"));
  assert.ok(canvas.timeline.some((event) => event.actor === "openclaw"));
  assert.ok(canvas.blockedBy.includes("hardware_capacity_unknown"));
  assert.ok(canvas.requiresHumanApproval.includes("smtp_activation_approval"));
  assert.equal(canvas.safety.liveInfrastructureWritesEnabled, false);
  assert.equal(JSON.stringify(canvas).includes("private_key"), false);
  assert.equal(JSON.stringify(canvas).includes("token"), false);
});

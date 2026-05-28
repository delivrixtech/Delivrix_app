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
  assert.equal(physicalHost.readiness.primaryBlocker, "hardware_capacity_unknown");
  assert.deepEqual(physicalHost.readiness.recommendedNextStep, {
    label: "Ingestar snapshot manual",
    endpoint: "POST /v1/devops/collector/manual-snapshots/ingest",
    severity: "warning"
  });
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
  assert.equal(physicalHost.readiness.primaryBlocker, undefined);
  assert.equal(physicalHost.readiness.recommendedNextStep, undefined);
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

  assert.equal(onboardingState.environment, "mvp.local");
  assert.equal(onboardingState.releasePhase, "5.9-manual-snapshot-ingestion-ux");
  assert.equal(onboardingState.canGenerateTopologyPlan, false);
  assert.ok(onboardingState.pendingQuestions.length > 0);
  assert.equal(onboardingState.sections.find((section) => section.id === "server")?.source, "onboarding.snapshot");
  assert.equal(onboardingState.sections.find((section) => section.id === "server")?.totalFieldCount, 5);
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
  // H.23: el primer nodo con status pendiente queda como currentStepId.
  // Con onboarding_capture introducido en el lane onboarding, ese pasa a ser
  // el primero porque physical_host queda "unknown" sin readiness real.
  assert.ok(["onboarding_capture", "onboarding_validate", "physical_host"].includes(canvas.currentStepId));
  assert.ok(canvas.nodes.some((node) => node.id === "physical_host"));
  assert.ok(canvas.nodes.some((node) => node.id === "prepared_capacity" && node.status === "disabled_by_mvp"));
  assert.ok(canvas.edges.some((edge) => edge.from === "proxmox_host" && edge.to === "cluster_plan"));
  assert.ok(canvas.edges.length >= 8);
  for (const edge of canvas.edges) {
    assert.equal(typeof edge.id, "string");
    assert.equal(typeof edge.from, "string");
    assert.equal(typeof edge.to, "string");
    assert.equal(typeof edge.label, "string");
    assert.ok(edge.label.length > 0);
    const sourceNode = canvas.nodes.find((node) => node.id === edge.from);
    assert.ok(sourceNode, `missing source node for edge ${edge.id}`);
    assert.ok(["ready", "in_progress", "blocked"].includes(edge.status));
    assert.equal(
      edge.status,
      sourceNode.status === "ready"
        ? "ready"
        : sourceNode.status === "blocked" || sourceNode.status === "error" || sourceNode.status === "disabled_by_mvp"
          ? "blocked"
          : "in_progress"
    );
  }
  assert.ok(canvas.timeline.some((event) => event.actor === "openclaw"));
  assert.ok(canvas.blockedBy.some((blocker) => blocker.code === "hardware_capacity_unknown"));
  assert.ok(canvas.blockedBy.some((blocker) =>
    blocker.code === "hardware_capacity_unknown"
    && blocker.label === "hardware capacity unknown"
    && blocker.category === "hardware"
    && blocker.severity === "critical"
  ));
  assert.ok(canvas.requiresHumanApproval.includes("smtp_activation_approval"));
  assert.equal(canvas.safety.liveInfrastructureWritesEnabled, false);
  assert.equal(JSON.stringify(canvas).includes("private_key"), false);
  assert.equal(JSON.stringify(canvas).includes("token"), false);

  // H.23: swimlanes + meta del Pencil toolbar/footer.
  assert.deepEqual(canvas.lanes, ["onboarding", "hardware", "provisioning", "warming", "reputation"]);
  // Cada nodo trae su lane canónica.
  assert.ok(canvas.nodes.every((n) => canvas.lanes.includes(n.lane)));
  // El backend entrega posiciones sugeridas estables para evitar re-layouts.
  for (const lane of canvas.lanes) {
    const laneIndex = canvas.lanes.indexOf(lane);
    const laneNodes = canvas.nodes.filter((n) => n.lane === lane);
    laneNodes.forEach((node, index) => {
      assert.equal(typeof node.x, "number");
      assert.equal(typeof node.y, "number");
      assert.equal(node.x, index * 240);
      assert.equal(node.y, laneIndex * 160);
    });
  }
  // Hay al menos un nodo por lane.
  for (const lane of canvas.lanes) {
    assert.ok(canvas.nodes.some((n) => n.lane === lane), `lane ${lane} sin nodos`);
  }
  // Toolbar metadata.
  assert.equal(canvas.cluster.activeId, "svc-warmup-01");
  assert.ok(canvas.cluster.options.length >= 1);
  assert.deepEqual(canvas.timeRange.options, ["1h", "24h", "7d"]);
  assert.equal(canvas.timeRange.active, "24h");
  assert.equal(canvas.scale.zoomPercent, 100);
  // Footer metadata.
  assert.ok(canvas.lastActivity.actor.length > 0);
  assert.ok(canvas.lastActivity.auditHash.startsWith("sha"));
  // Prompt es GET-only: las acciones nunca son POSTs, son punteros a runbook
  // o snooze client-side.
  if (canvas.prompt) {
    assert.ok(["open_runbook", "snooze", "ack", "view_evidence"].includes(canvas.prompt.primaryAction.kind));
    assert.ok(["open_runbook", "snooze", "ack", "view_evidence"].includes(canvas.prompt.secondaryAction.kind));
    assert.ok(canvas.nodes.some((n) => n.id === canvas.prompt!.nodeId));
  }
});

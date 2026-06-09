import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanvasLiveActionNowEventWire, CanvasLiveRunProgressWire } from "./live-tool-types.ts";
import {
  applyOrchestratorProgressEvent,
  applyRecorridoOverlayToCanvas,
  buildRecorridoOverlay,
  buildSmtpBuildStepViews,
  buildTopologyStatusOverlay,
  currentBuildStepNumber,
  liveRunProgressFromSnapshot,
  parseOrchestratorAuditProgress,
  RECORRIDO_EDGES,
  selectActiveRunProgress,
  type LiveRunProgress,
  type LiveRunProgressMap
} from "./smtp-live-progress.ts";

function auditEvent(
  action: string,
  targetId: string,
  occurredAt = "2026-06-08T12:00:00.000Z"
): CanvasLiveActionNowEventWire {
  return {
    type: "oc.action.now",
    taskId: targetId.split(":")[0] || "run-a",
    kind: "audit",
    action,
    targetType: "orchestrator_smtp",
    targetId,
    riskLevel: "low",
    occurredAt
  };
}

function runProgress(overrides: Partial<LiveRunProgress> = {}): LiveRunProgress {
  return {
    runStatus: "running",
    currentStep: null,
    lastCompletedStep: 0,
    steps: new Map(),
    ...overrides
  };
}

test("parseOrchestratorAuditProgress parses run and step actions, preserving colon skills", () => {
  assert.deepEqual(
    parseOrchestratorAuditProgress(auditEvent("oc.orchestrator.run_started", "run-123")),
    {
      runId: "run-123",
      kind: "run",
      runStatus: "running",
      occurredAt: "2026-06-08T12:00:00.000Z"
    }
  );

  assert.deepEqual(
    parseOrchestratorAuditProgress(auditEvent("oc.orchestrator.step_started", "run-123:7:upsert:dns:route53")),
    {
      runId: "run-123",
      kind: "step",
      step: 7,
      skill: "upsert:dns:route53",
      stepStatus: "in_progress",
      occurredAt: "2026-06-08T12:00:00.000Z"
    }
  );

  assert.equal(parseOrchestratorAuditProgress(auditEvent("oc.other.event", "run-123")), null);
  assert.equal(parseOrchestratorAuditProgress(auditEvent("oc.orchestrator.step_started", "run-123:x:skill")), null);
});

test("applyOrchestratorProgressEvent accumulates step and run status transitions", () => {
  const progress: LiveRunProgressMap = new Map();

  assert.equal(applyOrchestratorProgressEvent(progress, auditEvent("oc.orchestrator.run_started", "run-a")), true);
  assert.equal(applyOrchestratorProgressEvent(progress, auditEvent("oc.orchestrator.step_started", "run-a:1:suggest_safe_domain", "2026-06-08T12:00:01.000Z")), true);
  assert.equal(progress.get("run-a")?.currentStep, 1);
  assert.equal(progress.get("run-a")?.steps.get(1)?.status, "in_progress");

  assert.equal(applyOrchestratorProgressEvent(progress, auditEvent("oc.orchestrator.step_completed", "run-a:1:suggest_safe_domain", "2026-06-08T12:00:03.000Z")), true);
  assert.equal(progress.get("run-a")?.currentStep, null);
  assert.equal(progress.get("run-a")?.lastCompletedStep, 1);
  assert.equal(progress.get("run-a")?.steps.get(1)?.status, "ready");
  assert.equal(progress.get("run-a")?.steps.get(1)?.startedAt, "2026-06-08T12:00:01.000Z");
  assert.equal(progress.get("run-a")?.steps.get(1)?.completedAt, "2026-06-08T12:00:03.000Z");

  assert.equal(applyOrchestratorProgressEvent(progress, auditEvent("oc.orchestrator.step_failed", "run-a:2:register_domain_route53")), true);
  assert.equal(progress.get("run-a")?.runStatus, "failed");
  assert.equal(progress.get("run-a")?.steps.get(2)?.status, "error");

  assert.equal(applyOrchestratorProgressEvent(progress, auditEvent("oc.orchestrator.run_completed", "run-a")), true);
  assert.equal(progress.get("run-a")?.runStatus, "completed");
  assert.equal(progress.get("run-a")?.currentStep, null);
});

test("liveRunProgressFromSnapshot seeds progress and omits pending steps", () => {
  const snapshot: CanvasLiveRunProgressWire[] = [{
    runId: "run-snapshot",
    status: "running",
    lastCompletedStep: 1,
    steps: [
      { step: 1, skill: "suggest_safe_domain", status: "done" },
      { step: 2, skill: "register_domain_route53", status: "in_flight" },
      { step: 3, skill: "wait_for_dns_propagation", status: "pending" }
    ]
  }];

  const progress = liveRunProgressFromSnapshot(snapshot);
  const run = progress.get("run-snapshot");

  assert.equal(run?.runStatus, "running");
  assert.equal(run?.currentStep, 2);
  assert.equal(run?.lastCompletedStep, 1);
  assert.equal(run?.steps.get(1)?.status, "ready");
  assert.equal(run?.steps.get(2)?.status, "in_progress");
  assert.equal(run?.steps.has(3), false);
});

test("buildTopologyStatusOverlay aggregates node statuses by priority and suppresses stale in-progress", () => {
  const run = runProgress({
    steps: new Map([
      [2, { skill: "register_domain_route53", status: "ready" }],
      [3, { skill: "wait_for_dns_propagation", status: "in_progress" }],
      [10, { skill: "configure_email_auth", status: "error" }],
      [4, { skill: "create_webdock_server", status: "ready" }],
      [5, { skill: "wait_server_running", status: "in_progress" }],
      [14, { skill: "send_real_email", status: "in_progress" }]
    ]),
    currentStep: 14
  });

  assert.deepEqual(buildTopologyStatusOverlay(run), {
    dns_identity: "error",
    vps_lxc_plan: "in_progress",
    sender_nodes: "in_progress",
    reputation_gates: "in_progress"
  });

  const completed = runProgress({
    runStatus: "completed",
    steps: new Map([[5, { skill: "wait_server_running", status: "in_progress" }]]),
    currentStep: 5
  });
  assert.deepEqual(buildTopologyStatusOverlay(completed), {});
});

test("buildRecorridoOverlay marks the active frontier around an intermediate SMTP step", () => {
  const run = runProgress({
    currentStep: 9,
    lastCompletedStep: 8,
    steps: new Map([
      [8, { skill: "wait_for_dns_propagation", status: "ready" }],
      [9, { skill: "provision_smtp_postfix", status: "in_progress" }]
    ])
  });

  const overlay = buildRecorridoOverlay(run);

  assert.equal(overlay.activeNodeId, "sender_nodes");
  assert.deepEqual(overlay.edges, {
    proxmox_to_cluster: "ready",
    cluster_to_vps: "ready",
    vps_to_dns: "ready",
    dns_to_sender: "in_progress",
    sender_to_warming: "in_progress",
    warming_plan_to_ramp: "pending",
    warming_to_reputation: "pending"
  });
  assert.equal(overlay.nodes.sender_nodes, "in_progress");
});

test("buildRecorridoOverlay keeps an empty overlay only when there is no run", () => {
  assert.deepEqual(buildRecorridoOverlay(null), {
    nodes: {},
    edges: {},
    activeNodeId: null,
    buildNodeIds: []
  });

  const completed = runProgress({
    runStatus: "completed",
    currentStep: 9,
    steps: new Map([[9, { skill: "provision_smtp_postfix", status: "ready" }]])
  });

  const completedOverlay = buildRecorridoOverlay(completed);
  assert.equal(completedOverlay.activeNodeId, null);
  assert.equal(completedOverlay.nodes.sender_nodes, "ready");
  assert.equal(completedOverlay.edges.dns_to_sender, "pending");
  assert.ok(completedOverlay.buildNodeIds.includes("sender_nodes"));
});

test("buildRecorridoOverlay keeps the frontier monotonic when later SMTP steps revisit DNS", () => {
  const run = runProgress({
    currentStep: 10,
    lastCompletedStep: 9,
    steps: new Map([
      [9, { skill: "provision_smtp_postfix", status: "ready" }],
      [10, { skill: "configure_email_auth", status: "in_progress" }]
    ])
  });

  const overlay = buildRecorridoOverlay(run);

  assert.equal(overlay.activeNodeId, "dns_identity");
  assert.deepEqual(overlay.edges, {
    proxmox_to_cluster: "ready",
    cluster_to_vps: "ready",
    vps_to_dns: "ready",
    dns_to_sender: "in_progress",
    sender_to_warming: "in_progress",
    warming_plan_to_ramp: "pending",
    warming_to_reputation: "pending"
  });
});

test("applyRecorridoOverlayToCanvas preserves the same canvas reference when overlay is empty", () => {
  const canvas = {
    nodes: [{ id: "proxmox_host", status: "ready" }],
    edges: [{ id: "proxmox_to_cluster", status: "in_progress" }]
  };

  assert.equal(applyRecorridoOverlayToCanvas(canvas, buildRecorridoOverlay(null)), canvas);
});

test("buildRecorridoOverlay exposes the fixed recorrido spine node ids", () => {
  const run = runProgress({
    currentStep: 12,
    lastCompletedStep: 11,
    steps: new Map([[12, { skill: "seed_warmup_pool", status: "in_progress" }]])
  });

  assert.deepEqual(
    buildRecorridoOverlay(run).buildNodeIds,
    ["proxmox_host", "cluster_plan", "vps_lxc_plan", "dns_identity", "sender_nodes", "warming_plan", "warming_ramp", "reputation_gates"]
  );
  assert.deepEqual(
    RECORRIDO_EDGES.map((edge) => edge.id),
    ["proxmox_to_cluster", "cluster_to_vps", "vps_to_dns", "dns_to_sender", "sender_to_warming", "warming_plan_to_ramp", "warming_to_reputation"]
  );
});

test("selectActiveRunProgress scopes topology and stepper to the active run only", () => {
  const progress: LiveRunProgressMap = new Map([
    ["run-a", runProgress({ currentStep: 4 })],
    ["run-b", runProgress({ currentStep: 9 })]
  ]);

  assert.equal(selectActiveRunProgress(progress, "run-b")?.currentStep, 9);
  assert.equal(selectActiveRunProgress(progress, "missing"), null);
  assert.equal(selectActiveRunProgress(progress, null), null);
});

test("buildSmtpBuildStepViews exposes all 14 steps and currentBuildStepNumber follows active/completed state", () => {
  const run = runProgress({
    currentStep: 9,
    lastCompletedStep: 8,
    steps: new Map([
      [7, { skill: "wait_for_dns_propagation", status: "ready" }],
      [8, { skill: "bind_webdock_main_domain", status: "ready" }],
      [9, { skill: "provision_smtp_postfix", status: "in_progress" }]
    ])
  });

  const views = buildSmtpBuildStepViews(run);
  assert.equal(views.length, 14);
  assert.equal(views[6].label, "Esperando propagación A");
  assert.equal(views[6].status, "ready");
  assert.equal(views[7].label, "Alineando identidad + FCrDNS");
  assert.equal(views[7].status, "ready");
  assert.equal(views[8].label, "Instalando Postfix + DKIM + TLS");
  assert.equal(views[8].status, "in_progress");
  assert.equal(currentBuildStepNumber(run), 9);
  assert.equal(currentBuildStepNumber(runProgress({ lastCompletedStep: 14 })), 14);
});

test("buildSmtpBuildStepViews suppresses stale in-progress spinner after terminal run status", () => {
  const failed = runProgress({
    runStatus: "failed",
    currentStep: null,
    steps: new Map([[9, { skill: "provision_smtp_postfix", status: "in_progress" }]])
  });
  const completed = runProgress({
    runStatus: "completed",
    currentStep: null,
    steps: new Map([[14, { skill: "send_real_email", status: "in_progress" }]])
  });

  assert.equal(buildSmtpBuildStepViews(failed)[8].status, "error");
  assert.equal(buildSmtpBuildStepViews(completed)[13].status, "pending");
});

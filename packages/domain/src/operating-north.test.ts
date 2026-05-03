import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOperatingActionGate,
  getOperatingNorthSnapshot
} from "./operating-north.ts";

test("defines Delivrix as control plane and final demo report as current phase", () => {
  const snapshot = getOperatingNorthSnapshot();

  assert.equal(snapshot.phase, "5.3-final-demo-report");
  assert.equal(snapshot.delivrixRole, "control_plane");
  assert.equal(snapshot.openClawRole, "intelligent_demo_evidence_reporter");
  assert.equal(snapshot.nfcRole, "future_optional_external_integration");
  assert.equal(snapshot.delivrixSendsRealEmail, false);
  assert.equal(snapshot.nfcSendsRealEmail, false);
  assert.equal(snapshot.nfcProductionWritesEnabled, false);
});

test("allows OpenClaw onboarding evaluation in dry-run mode", () => {
  const decision = evaluateOperatingActionGate({
    action: "evaluate_openclaw_onboarding",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("allows cluster topology planning in dry-run mode", () => {
  const decision = evaluateOperatingActionGate({
    action: "build_cluster_topology_plan",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("allows provisioning dry-run generation in dry-run mode", () => {
  const decision = evaluateOperatingActionGate({
    action: "build_provisioning_dry_run",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("allows OpenClaw scheduler runs in dry-run mode", () => {
  const decision = evaluateOperatingActionGate({
    action: "run_openclaw_scheduler",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("allows OpenClaw runbook evaluation in dry-run mode", () => {
  const decision = evaluateOperatingActionGate({
    action: "evaluate_openclaw_runbook",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("allows MVP demo blueprint generation in dry-run mode", () => {
  const decision = evaluateOperatingActionGate({
    action: "build_mvp_demo_blueprint",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("allows MVP local demo runner in dry-run mode", () => {
  const decision = evaluateOperatingActionGate({
    action: "run_mvp_demo_local",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("allows OpenClaw incident demo in dry-run mode", () => {
  const decision = evaluateOperatingActionGate({
    action: "run_openclaw_incident_demo",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("allows MVP final demo report in dry-run mode", () => {
  const decision = evaluateOperatingActionGate({
    action: "build_mvp_final_demo_report",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("allows dry-run bridge payload generation", () => {
  const decision = evaluateOperatingActionGate({
    action: "build_nfc_bridge_payload",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("blocks real email sending in Hito 5.3", () => {
  const decision = evaluateOperatingActionGate({
    action: "send_email_real",
    mode: "live",
    humanApproved: true
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.riskLevel, "critical");
  assert.deepEqual(decision.blockedBy, ["north_operating_boundary", "phase_5_3_gate"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOperatingActionGate,
  getOperatingNorthSnapshot
} from "./operating-north.ts";

test("defines Delivrix as control plane and NFC as real send pipeline", () => {
  const snapshot = getOperatingNorthSnapshot();

  assert.equal(snapshot.delivrixRole, "control_plane");
  assert.equal(snapshot.nfcRole, "campaign_and_real_send_pipeline");
  assert.equal(snapshot.delivrixSendsRealEmail, false);
  assert.equal(snapshot.nfcSendsRealEmail, true);
  assert.equal(snapshot.nfcProductionWritesEnabled, false);
});

test("allows dry-run bridge payload generation", () => {
  const decision = evaluateOperatingActionGate({
    action: "build_nfc_bridge_payload",
    mode: "dry_run"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.riskLevel, "low");
});

test("blocks real email sending in Hito 4.0", () => {
  const decision = evaluateOperatingActionGate({
    action: "send_email_real",
    mode: "live",
    humanApproved: true
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.riskLevel, "critical");
  assert.deepEqual(decision.blockedBy, ["north_operating_boundary", "phase_4_0_gate"]);
});

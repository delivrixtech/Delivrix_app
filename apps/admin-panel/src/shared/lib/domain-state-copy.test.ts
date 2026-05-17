import assert from "node:assert/strict";
import test from "node:test";
import {
  collectorCopy,
  hardwareCopy,
  learningCopy,
  pickBinary,
  pickCapacityCopy,
  safetyCopy
} from "./domain-state-copy.ts";

test("pickBinary returns the enabled state copy when value is true", () => {
  const result = pickBinary(safetyCopy.liveInfrastructureWrites, true);
  assert.equal(result.copy, "Riesgo: writes en vivo");
  assert.equal(result.tone, "critical");
});

test("pickBinary returns the disabled state copy when value is false", () => {
  const result = pickBinary(safetyCopy.delivrixSendsRealEmail, false);
  assert.equal(result.copy, "Solo simulacion");
  assert.equal(result.tone, "success");
});

test("requiresHumanApproval flips tone: required is success, optional is critical", () => {
  assert.equal(pickBinary(learningCopy.requiresHumanApproval, true).tone, "success");
  assert.equal(pickBinary(learningCopy.requiresHumanApproval, false).tone, "critical");
});

test("canSelfPromote: enabled is critical, blocked is success", () => {
  assert.equal(pickBinary(learningCopy.canSelfPromote, true).tone, "critical");
  assert.equal(pickBinary(learningCopy.canSelfPromote, false).tone, "success");
});

test("pickCapacityCopy: null returns 'Esperando snapshot manual' with warning tone", () => {
  const result = pickCapacityCopy(null);
  assert.equal(result.copy, "Esperando snapshot manual");
  assert.equal(result.tone, "warning");
});

test("pickCapacityCopy: numeric value returns 'Snapshot vigente' with success tone", () => {
  const result = pickCapacityCopy(64);
  assert.equal(result.copy, "Snapshot vigente");
  assert.equal(result.tone, "success");
});

test("collectorCopy panelWrites: enabled is critical, disabled is success", () => {
  assert.equal(collectorCopy.panelWrites.enabled.tone, "critical");
  assert.equal(collectorCopy.panelWrites.disabled.tone, "success");
});

test("hardwareCopy capacityField exposes known and unknown states", () => {
  assert.equal(hardwareCopy.capacityField.known.copy, "Snapshot vigente");
  assert.equal(hardwareCopy.capacityField.unknown.copy, "Esperando snapshot manual");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { AuthReadinessContract, WarmupNode } from "../domain/types.ts";
import {
  canNodeSend,
  canNodeSendDetailed,
  evaluateAuthContract
} from "./auth-gate.ts";

const NOW = new Date("2026-07-09T12:00:00Z");
const REQUIRED = ["SPF_PASS", "DKIM_ALIGN", "PTR_FCRDNS"];
const acceptAll = () => true;

function contract(overrides: Partial<AuthReadinessContract> = {}): AuthReadinessContract {
  return {
    nodeId: "n1",
    checks: { SPF_PASS: "pass", DKIM_ALIGN: "pass", PTR_FCRDNS: "pass" },
    signature: "sig-ok",
    issuedAt: new Date("2026-07-09T11:00:00Z"),
    expiresAt: new Date("2026-07-09T13:00:00Z"),
    ...overrides
  };
}

// ---- evaluateAuthContract: cada causa de fail-closed (§8) ----

test("contrato null ⇒ fail-closed contract_missing", () => {
  const r = evaluateAuthContract(null, { now: NOW, requiredChecks: REQUIRED, verifySignature: acceptAll });
  assert.deepEqual(r, { ready: false, reason: "contract_missing" });
});

test("contrato undefined ⇒ fail-closed contract_missing", () => {
  const r = evaluateAuthContract(undefined, { now: NOW, requiredChecks: REQUIRED, verifySignature: acceptAll });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "contract_missing");
});

test("contrato expirado (expiresAt <= now) ⇒ contract_expired", () => {
  const expired = contract({ expiresAt: new Date("2026-07-09T11:59:00Z") });
  const r = evaluateAuthContract(expired, { now: NOW, requiredChecks: REQUIRED, verifySignature: acceptAll });
  assert.deepEqual(r, { ready: false, reason: "contract_expired" });
});

test("expiración exacta (expiresAt == now) también bloquea (<=)", () => {
  const r = evaluateAuthContract(contract({ expiresAt: NOW }), {
    now: NOW,
    requiredChecks: REQUIRED,
    verifySignature: acceptAll
  });
  assert.equal(r.reason, "contract_expired");
});

test("firma inválida ⇒ signature_invalid (aunque esté vigente y con checks ok)", () => {
  const r = evaluateAuthContract(contract(), { now: NOW, requiredChecks: REQUIRED, verifySignature: () => false });
  assert.deepEqual(r, { ready: false, reason: "signature_invalid" });
});

test("un requiredCheck en fail ⇒ check_failed:<name>", () => {
  const c = contract({ checks: { SPF_PASS: "pass", DKIM_ALIGN: "fail", PTR_FCRDNS: "pass" } });
  const r = evaluateAuthContract(c, { now: NOW, requiredChecks: REQUIRED, verifySignature: acceptAll });
  assert.deepEqual(r, { ready: false, reason: "check_failed:DKIM_ALIGN" });
});

test("un requiredCheck en unknown ⇒ check_failed (solo pass cuenta)", () => {
  const c = contract({ checks: { SPF_PASS: "pass", DKIM_ALIGN: "pass", PTR_FCRDNS: "unknown" } });
  const r = evaluateAuthContract(c, { now: NOW, requiredChecks: REQUIRED, verifySignature: acceptAll });
  assert.equal(r.reason, "check_failed:PTR_FCRDNS");
});

test("un requiredCheck ausente del contrato ⇒ check_failed", () => {
  const c = contract({ checks: { SPF_PASS: "pass", DKIM_ALIGN: "pass" } });
  const r = evaluateAuthContract(c, { now: NOW, requiredChecks: REQUIRED, verifySignature: acceptAll });
  assert.equal(r.reason, "check_failed:PTR_FCRDNS");
});

test("todo pasa ⇒ ready:true", () => {
  const r = evaluateAuthContract(contract(), { now: NOW, requiredChecks: REQUIRED, verifySignature: acceptAll });
  assert.deepEqual(r, { ready: true, reason: "ready" });
});

test("sin requiredChecks: vigente + firma ok ⇒ ready:true", () => {
  const r = evaluateAuthContract(contract(), { now: NOW, requiredChecks: [], verifySignature: acceptAll });
  assert.equal(r.ready, true);
});

test("orden de precedencia: expirado gana sobre firma/checks", () => {
  const c = contract({ expiresAt: new Date("2026-07-09T10:00:00Z"), checks: { SPF_PASS: "fail" } });
  const r = evaluateAuthContract(c, { now: NOW, requiredChecks: REQUIRED, verifySignature: () => false });
  assert.equal(r.reason, "contract_expired");
});

// ---- canNodeSend / canNodeSendDetailed: por cada estado ----

function node(overrides: Partial<WarmupNode> = {}): WarmupNode {
  return {
    id: "n1",
    mailbox: "warm@delivrix.io",
    domain: "delivrix.io",
    infraType: "postfix",
    state: "fresh",
    authReady: true,
    contractExpiresAt: new Date("2026-07-09T13:00:00Z"),
    dailyLimit: 10,
    increaseByDay: 1,
    dayIndex: 1,
    weekdaysOnly: false,
    ...overrides
  };
}

test("canNodeSend: authReady + fresh + contrato vigente ⇒ true", () => {
  assert.equal(canNodeSend(node(), NOW), true);
});

test("canNodeSend: warm también envía", () => {
  assert.equal(canNodeSend(node({ state: "warm" }), NOW), true);
});

test("canNodeSend: authReady false ⇒ false (auth_not_ready)", () => {
  assert.equal(canNodeSend(node({ authReady: false }), NOW), false);
  assert.equal(canNodeSendDetailed(node({ authReady: false }), NOW).reason, "auth_not_ready");
});

test("canNodeSend: state blocked ⇒ false", () => {
  assert.equal(canNodeSend(node({ state: "blocked" }), NOW), false);
  assert.equal(canNodeSendDetailed(node({ state: "blocked" }), NOW).reason, "node_blocked");
});

test("canNodeSend: state quarantined ⇒ false", () => {
  assert.equal(canNodeSend(node({ state: "quarantined" }), NOW), false);
  assert.equal(canNodeSendDetailed(node({ state: "quarantined" }), NOW).reason, "node_quarantined");
});

test("canNodeSend: state paused ⇒ false", () => {
  assert.equal(canNodeSend(node({ state: "paused" }), NOW), false);
  assert.equal(canNodeSendDetailed(node({ state: "paused" }), NOW).reason, "node_paused");
});

test("canNodeSend: contrato expirado (<=now) ⇒ false aunque authReady siga true", () => {
  const n = node({ contractExpiresAt: new Date("2026-07-09T11:00:00Z") });
  assert.equal(canNodeSend(n, NOW), false);
  assert.equal(canNodeSendDetailed(n, NOW).reason, "contract_expired");
});

test("canNodeSend: sin contractExpiresAt (null) no bloquea por expiración", () => {
  assert.equal(canNodeSend(node({ contractExpiresAt: undefined }), NOW), true);
});

test("canNodeSendDetailed: happy path reason ok", () => {
  assert.deepEqual(canNodeSendDetailed(node(), NOW), { canSend: true, reason: "ok" });
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildAuthReadinessContract, authContractPayload, PENDING_V1_CHECKS } from "./auth-contract-builder.ts";
import { evaluateAuthContract } from "./auth-gate.ts";
import { V1_REQUIRED_CHECKS, type AuthChecker, type AuthCheckId, type CheckResult } from "../domain/auth-checks.ts";

const now = new Date("2026-07-09T12:00:00.000Z");
const ctx = {
  domain: "annualfilings-infra.com",
  smtpHost: "smtp.annualfilings-infra.com",
  sendingIp: "217.216.55.33",
  heloFqdn: "smtp.annualfilings-infra.com",
  dkimSelector: "s2026a"
};

function checker(results: { id: AuthCheckId; verdict: CheckResult["verdict"] }[]): AuthChecker {
  return { ids: results.map((r) => r.id), run: async () => results };
}
function allPassExcept(pending: readonly AuthCheckId[]): AuthChecker {
  const results = V1_REQUIRED_CHECKS
    .filter((id) => !pending.includes(id))
    .map((id) => ({ id, verdict: "pass" as const }));
  return checker(results);
}

test("los checks requeridos que ningún checker produce quedan unknown (fail-closed)", async () => {
  const contract = await buildAuthReadinessContract({
    nodeId: "n1", ctx, checkers: [], sign: () => "sig", now
  });
  for (const id of V1_REQUIRED_CHECKS) assert.equal(contract.checks[id], "unknown");
});

test("un checker que lanza no tumba el build; sus checks siguen unknown", async () => {
  const throwing: AuthChecker = { ids: ["SPF_PASS"], run: async () => { throw new Error("dns down"); } };
  const contract = await buildAuthReadinessContract({
    nodeId: "n1", ctx, checkers: [throwing], sign: () => "sig", now
  });
  assert.equal(contract.checks.SPF_PASS, "unknown");
});

test("agrega los verdicts de varios checkers y firma un payload estable", async () => {
  let signed = "";
  const contract = await buildAuthReadinessContract({
    nodeId: "n1",
    ctx,
    checkers: [checker([{ id: "SPF_PASS", verdict: "pass" }, { id: "DKIM_ALIGN", verdict: "fail" }])],
    sign: (p) => { signed = p; return "sig-" + p.length; },
    now
  });
  assert.equal(contract.checks.SPF_PASS, "pass");
  assert.equal(contract.checks.DKIM_ALIGN, "fail");
  assert.equal(contract.signature, "sig-" + signed.length);
  // El payload es determinista (checks ordenados alfabéticamente).
  assert.match(signed, /^n1\|DEDICATED_IP_SCHEDULE=unknown,DKIM_ALIGN=fail,/);
});

test("TTL: expiresAt = now + ttl; sendingLimits pasa al contrato", async () => {
  const contract = await buildAuthReadinessContract({
    nodeId: "n1", ctx, checkers: [], sign: () => "sig", now, ttlMs: 60_000, sendingLimits: { maxPerDay: 40 }
  });
  assert.equal(contract.expiresAt.getTime() - contract.issuedAt.getTime(), 60_000);
  assert.deepEqual(contract.sendingLimits, { maxPerDay: 40 });
});

test("end-to-end: un solo check requerido en unknown bloquea el ready (fail-closed)", async () => {
  // Todos los checks en pass menos IMAP_AUTH, que ningún checker produce ⇒ queda unknown.
  const contract = await buildAuthReadinessContract({
    nodeId: "n1", ctx, checkers: [allPassExcept(["IMAP_AUTH"])], sign: () => "sig", now
  });
  const decision = evaluateAuthContract(contract, {
    now,
    requiredChecks: [...V1_REQUIRED_CHECKS],
    verifySignature: () => true
  });
  assert.equal(decision.ready, false, "un check requerido en unknown bloquea el ready");
  assert.match(decision.reason, /IMAP_AUTH/);
});

test("PENDING_V1_CHECKS está vacío: los 13 checks del §8 tienen checker", () => {
  assert.deepEqual([...PENDING_V1_CHECKS], []);
});

test("end-to-end: con TODOS los checks en pass el gate da ready", async () => {
  const all = V1_REQUIRED_CHECKS.map((id) => ({ id, verdict: "pass" as const }));
  const contract = await buildAuthReadinessContract({
    nodeId: "n1", ctx, checkers: [checker(all)], sign: () => "sig", now
  });
  const decision = evaluateAuthContract(contract, {
    now, requiredChecks: [...V1_REQUIRED_CHECKS], verifySignature: () => true
  });
  assert.equal(decision.ready, true, decision.reason);
});

test("authContractPayload ordena los checks de forma estable", () => {
  const p = authContractPayload({
    nodeId: "n", checks: { B: "pass", A: "fail" }, issuedAt: now, expiresAt: now
  });
  assert.match(p, /^n\|A=fail,B=pass\|/);
});

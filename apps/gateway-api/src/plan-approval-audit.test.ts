import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent } from "../../../packages/domain/src/index.ts";
import { stableStringify } from "../../../packages/storage/src/stable-stringify.ts";
import { findSignedPlanApprovalInAuditEvents } from "./plan-approval-audit.ts";
import type { PlanApprovalScope } from "./routes/proposals-sign.ts";

test("findSignedPlanApprovalInAuditEvents rehydrates a signed plan after gateway restart", () => {
  const scope = planScope();
  const plan = findSignedPlanApprovalInAuditEvents({
    events: [planSignedEvent(scope)],
    runId: scope.runId,
    params: {
      domain: "CONTROLFILING.EXAMPLE.",
      provider: scope.provider,
      budgetUsdMax: scope.budgetUsdMax,
      testEmailRecipient: "INFRA@DELIVRIX.COM"
    },
    now: new Date("2026-06-05T06:10:00.000Z")
  });

  assert.equal(plan?.status, "signed");
  assert.equal(plan?.scope.runId, "smtp-controlfiling-20260605-v2");
  assert.equal(plan?.scope.domain, "controlfiling.example");
  assert.equal(plan?.signatureId, "sig-plan-1");
  assert.equal(plan?.flagEnabled, true);
});

test("findSignedPlanApprovalInAuditEvents rejects expired or hash-tampered audit plans", () => {
  const scope = planScope();
  const expired = findSignedPlanApprovalInAuditEvents({
    events: [planSignedEvent(scope, { expiresAt: "2026-06-05T06:00:00.000Z" })],
    runId: scope.runId,
    params: { domain: scope.domain },
    now: new Date("2026-06-05T06:10:00.000Z")
  });
  const tampered = findSignedPlanApprovalInAuditEvents({
    events: [planSignedEvent({ ...scope, domain: "other.example" }, { scopeHash: hashPlanApprovalScope(scope) })],
    runId: scope.runId,
    params: { domain: "other.example" },
    now: new Date("2026-06-05T06:10:00.000Z")
  });

  assert.equal(expired, null);
  assert.equal(tampered, null);
});

test("findSignedPlanApprovalInAuditEvents enforces request scope filters", () => {
  const scope = planScope();
  const plan = planSignedEvent(scope);

  assert.equal(findSignedPlanApprovalInAuditEvents({
    events: [plan],
    runId: scope.runId,
    params: { domain: "wrong.example" },
    now: new Date("2026-06-05T06:10:00.000Z")
  }), null);
  assert.equal(findSignedPlanApprovalInAuditEvents({
    events: [plan],
    runId: scope.runId,
    params: { provider: "ionos" },
    now: new Date("2026-06-05T06:10:00.000Z")
  }), null);
  assert.equal(findSignedPlanApprovalInAuditEvents({
    events: [plan],
    runId: scope.runId,
    params: { budgetUsdMax: 25 },
    now: new Date("2026-06-05T06:10:00.000Z")
  }), null);
});

test("findSignedPlanApprovalInAuditEvents enforces provider/account scope filters", () => {
  const scope = planScope({ vpsProviderId: "contabo", serverAccountId: "quaternary" });
  const plan = planSignedEvent(scope);

  const match = findSignedPlanApprovalInAuditEvents({
    events: [plan],
    runId: scope.runId,
    params: {
      domain: scope.domain,
      provider: scope.provider,
      vpsProviderId: "CONTABO",
      serverAccountId: "QUATERNARY",
      budgetUsdMax: scope.budgetUsdMax,
      testEmailRecipient: scope.recipient
    },
    now: new Date("2026-06-05T06:10:00.000Z")
  });

  assert.equal(match?.scope.vpsProviderId, "contabo");
  assert.equal(match?.scope.serverAccountId, "quaternary");
  assert.equal(findSignedPlanApprovalInAuditEvents({
    events: [plan],
    runId: scope.runId,
    params: { vpsProviderId: "webdock" },
    now: new Date("2026-06-05T06:10:00.000Z")
  }), null);
  assert.equal(findSignedPlanApprovalInAuditEvents({
    events: [plan],
    runId: scope.runId,
    params: { serverAccountId: "ops" },
    now: new Date("2026-06-05T06:10:00.000Z")
  }), null);
});

function planScope(overrides: Partial<PlanApprovalScope> = {}): PlanApprovalScope {
  return {
    runId: "smtp-controlfiling-20260605-v2",
    domain: "controlfiling.example",
    provider: "webdock-route53",
    budgetUsdMax: 50,
    recipient: "infra@delivrix.com",
    plannedSkill: "configure_complete_smtp",
    plannedSteps: [
      "suggest_safe_domain",
      "register_domain_route53",
      "wait_for_dns_propagation",
      "configure_email_auth",
      "seed_warmup_pool",
      "send_real_email",
      "compact_intent"
    ],
    ...overrides
  };
}

function planSignedEvent(
  scope: PlanApprovalScope,
  overrides: Partial<{
    expiresAt: string;
    scopeHash: string;
  }> = {}
): AuditEvent {
  const scopeHash = overrides.scopeHash ?? hashPlanApprovalScope(scope);
  return {
    id: "audit-plan-1",
    occurredAt: "2026-06-05T05:33:12.000Z",
    actorType: "operator",
    actorId: "operator-juanes",
    action: "oc.plan.signed",
    targetType: "openclaw_orchestrator_run",
    targetId: scope.runId,
    riskLevel: "critical",
    metadata: {
      proposalId: "proposal-1",
      signatureId: "sig-plan-1",
      signedEventHash: "a".repeat(64),
      executionContextHash: "b".repeat(64),
      scopeHash,
      scope,
      expiresAt: overrides.expiresAt ?? "2026-06-05T06:33:12.000Z",
      flag: "OPENCLAW_PLAN_SIGNATURE_AUTONOMY_ENABLE"
    },
    decision: "allow",
    rejectReason: null,
    humanApproved: true,
    approverIds: ["operator-juanes"],
    killSwitchState: "unknown",
    rollbackToken: null,
    schemaVersion: "2026-05-18.v1",
    promptVersion: null,
    modelVersion: null,
    evidenceRefs: [],
    prevHash: "c".repeat(64),
    hash: "d".repeat(64)
  };
}

function hashPlanApprovalScope(scope: PlanApprovalScope): string {
  return createHash("sha256").update(stableStringify(scope)).digest("hex");
}

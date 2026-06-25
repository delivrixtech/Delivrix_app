import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInfrastructureAccountRetireProposal,
  isSustainedUnauthorizedWebdockRetireCandidate
} from "./infrastructure-account-retire-proposal.ts";

test("Infrastructure account retire proposal requires sustained Webdock unauthorized failures", () => {
  assert.equal(isSustainedUnauthorizedWebdockRetireCandidate(record({ consecutiveFailures: 1 }), 3), false);
  assert.equal(isSustainedUnauthorizedWebdockRetireCandidate(record({ consecutiveFailures: 3 }), 3), true);
  assert.equal(isSustainedUnauthorizedWebdockRetireCandidate(record({ providerId: "contabo", consecutiveFailures: 3 }), 3), false);
  assert.equal(isSustainedUnauthorizedWebdockRetireCandidate(record({ healthStatus: "degraded", consecutiveFailures: 3 }), 3), false);
  assert.equal(isSustainedUnauthorizedWebdockRetireCandidate(record({ lifecycleStatus: "retired", consecutiveFailures: 3 }), 3), false);
});

test("Infrastructure account retire proposal is gated and targets soft-retire action only", () => {
  const proposal = buildInfrastructureAccountRetireProposal({
    record: record({
      accountId: "secondary",
      accountLabel: "Cuenta 2",
      consecutiveFailures: 4,
      firstUnhealthyAt: "2026-06-24T10:05:01.000Z"
    }),
    threshold: 3,
    observedAt: new Date("2026-06-24T10:20:01.000Z"),
    id: "00000000-0000-4000-8000-000000000001"
  });

  assert.equal(proposal.skillSlug, "retire_infrastructure_account");
  assert.deepEqual(proposal.delivrix_actions_required, ["retire_infrastructure_account"]);
  assert.equal(proposal.targetRef, "webdock:secondary");
  assert.equal(proposal.targetType, "infrastructure_account");
  assert.equal(proposal.params.providerId, "webdock");
  assert.equal(proposal.params.accountId, "secondary");
  assert.match(proposal.body, /Propuesta gated/);
  assert.match(proposal.params.reason, /soft-retire local-only/);
});

function record(overrides: Record<string, unknown> = {}) {
  return {
    accountKey: "webdock:secondary",
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    lifecycleStatus: "unauthorized",
    healthStatus: "unauthorized",
    consecutiveFailures: 1,
    updatedAt: "2026-06-24T10:05:01.000Z",
    updatedBy: "gateway-api",
    ...overrides
  } as never;
}

import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "../../shared/api/client.ts";
import { computeWalletTransactions } from "./sender-pool-wallet.ts";

test("wallet transactions use metadata.costUsd and targetId fallback", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");
  const events: AuditEvent[] = [
    auditEvent({
      id: "audit-a",
      occurredAt: "2026-06-10T10:00:00.000Z",
      action: "oc.domain.registered",
      targetId: "target-domain.com",
      metadata: { costUsd: 12.34 }
    }),
    auditEvent({
      id: "audit-b",
      occurredAt: "2026-06-10T10:00:00.000Z",
      action: "register_domain_route53.success",
      targetId: "target-ignored.com",
      metadata: { costUsd: 9, domain: "metadata-domain.com" }
    }),
    auditEvent({
      id: "audit-old",
      occurredAt: "2026-05-30T10:00:00.000Z",
      action: "oc.domain.registered",
      targetId: "old-domain.com",
      metadata: { costUsd: 99 }
    }),
    auditEvent({
      id: "audit-legacy-payload",
      occurredAt: "2026-06-11T10:00:00.000Z",
      action: "oc.domain.registered",
      targetId: "legacy-domain.com",
      metadata: {}
    })
  ];

  const transactions = computeWalletTransactions(events, now);

  assert.deepEqual(transactions.map((tx) => tx.id), ["audit-b", "audit-a"]);
  assert.equal(transactions[0]?.domain, "metadata-domain.com");
  assert.equal(transactions[1]?.domain, "target-domain.com");
  assert.equal(transactions.reduce((sum, tx) => sum + tx.amount, 0), 21.34);
});

function auditEvent(input: Partial<AuditEvent>): AuditEvent {
  return {
    id: input.id ?? "audit-test",
    occurredAt: input.occurredAt ?? "2026-06-01T00:00:00.000Z",
    actorType: input.actorType ?? "openclaw",
    actorId: input.actorId ?? "openclaw/scheduler",
    action: input.action ?? "oc.domain.registered",
    targetType: input.targetType ?? "domain",
    targetId: input.targetId ?? "example.com",
    riskLevel: input.riskLevel ?? "low",
    metadata: input.metadata ?? {}
  };
}

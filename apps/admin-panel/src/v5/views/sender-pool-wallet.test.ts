import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEvent } from "../../shared/api/client.ts";
import { buildEnableSmtpAuthIntent } from "./sender-pool-intents.ts";
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
      // La acción REAL del alta por Namecheap. La lista vieja trackeaba
      // "register_domain_route53.success", que no la emite nadie en el repo, y se perdía esta.
      action: "oc.domain.register",
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

  // La compra sin costUsd ya NO desaparece: viaja con amount null para que la vista la muestre
  // como "costo no registrado" en vez de borrarla de la lista de movimientos.
  assert.deepEqual(transactions.map((tx) => tx.id), ["audit-legacy-payload", "audit-b", "audit-a"]);
  assert.equal(transactions[0]?.amount, null);
  assert.equal(transactions[1]?.domain, "metadata-domain.com");
  assert.equal(transactions[2]?.domain, "target-domain.com");
  assert.equal(transactions.reduce((sum, tx) => sum + (tx.amount ?? 0), 0), 21.34);
});

test("una accion que el gateway ya no emite no cuenta como compra", () => {
  // register_domain_route53.success no existe en el repo: si vuelve a aparecer en la whitelist,
  // este test lo caza antes de que el wallet invente un movimiento.
  const transactions = computeWalletTransactions(
    [
      auditEvent({
        id: "audit-fantasma",
        occurredAt: "2026-06-10T10:00:00.000Z",
        action: "register_domain_route53.success",
        metadata: { costUsd: 9 }
      })
    ],
    new Date("2026-06-15T12:00:00.000Z")
  );
  assert.deepEqual(transactions, []);
});

test("enable SMTP auth intent asks OpenClaw for one approved domain without executing inline", () => {
  const intent = buildEnableSmtpAuthIntent("Example.COM");

  assert.equal(intent.source, "sender-pool:enable-smtp-auth:example.com");
  assert.match(intent.prompt, /example\.com/);
  assert.match(intent.prompt, /un solo dominio/);
  assert.match(intent.prompt, /aprobaci[oó]n/i);
  assert.doesNotMatch(intent.prompt, /password|contrase(?:ñ|n)a/i);
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

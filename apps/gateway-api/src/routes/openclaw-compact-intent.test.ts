import test from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent, AuditEventInput } from "../../../../packages/domain/src/index.ts";
import { compactIntent, CompactIntentValidationError, type CompactIntentInput } from "./openclaw-compact-intent.ts";

test("compactIntent rejects a body-supplied signatureId that is not in the audit chain", async () => {
  const ctx = context();

  await assert.rejects(
    () => compactIntent(input({ signatureId: "sig_forged" }), ctx.deps),
    (error) =>
      error instanceof CompactIntentValidationError &&
      error.code === "signature_id_not_verified"
  );
  assert.equal(ctx.pool.rows.length, 0);
});

test("compactIntent marks operator memory only after matching a signed audit event", async () => {
  const ctx = context({
    events: [
      skillInvokedEvent(),
      signedEvent({
        targetId: "proposal-1",
        signatureId: "sig_verified"
      })
    ]
  });

  const output = await compactIntent(input({
    proposalId: "proposal-1",
    signatureId: "sig_verified"
  }), ctx.deps);

  assert.equal(output.entriesWritten, 1);
  assert.equal(ctx.pool.rows[0].source, "operator");
  assert.equal(ctx.pool.rows[0].trust_score, 95);
  assert.equal(ctx.pool.rows[0].plane, "verified_fact");
  assert.deepEqual(ctx.pool.rows[0].provenance, {
    kind: "operator_signature",
    signatureId: "sig_verified",
    proposalId: "proposal-1"
  });
  assert.deepEqual(ctx.pool.rows[0].metadata, {
    intentFinalStatus: "completed",
    decisionHash: ctx.pool.rows[0].metadata.decisionHash,
    proposalId: "proposal-1",
    signatureId: "sig_verified",
    operatorSignatureId: "sig_verified",
    operatorSignatureVerified: true,
    operatorSignatureActorId: "juanescanar-cto",
    operatorSignatureAuditEventId: "audit-signed",
    operatorSignatureAuditEventHash: "hash-signed",
    operatorSignatureSignedAt: "2026-06-02T12:00:00.000Z",
    operatorSignatureProposalId: "proposal-1"
  });
});

test("compactIntent rejects a verified signature when proposalId is omitted", async () => {
  const ctx = context({
    events: [
      skillInvokedEvent(),
      signedEvent({
        targetId: "proposal-1",
        signatureId: "sig_verified"
      })
    ]
  });

  await assert.rejects(
    () => compactIntent(input({ signatureId: "sig_verified" }), ctx.deps),
    (error) =>
      error instanceof CompactIntentValidationError &&
      error.code === "signature_id_not_verified"
  );
  assert.equal(ctx.pool.rows.length, 0);
});

test("compactIntent rejects a verified signature attached to a different proposal", async () => {
  const ctx = context({
    events: [
      skillInvokedEvent(),
      signedEvent({
        targetId: "proposal-real",
        signatureId: "sig_verified"
      })
    ]
  });

  await assert.rejects(
    () => compactIntent(input({
      proposalId: "proposal-forged",
      signatureId: "sig_verified"
    }), ctx.deps),
    (error) =>
      error instanceof CompactIntentValidationError &&
      error.code === "signature_id_not_verified"
  );
  assert.equal(ctx.pool.rows.length, 0);
});

function input(step: Partial<CompactIntentInput["steps"][number]> = {}): CompactIntentInput {
  return {
    intentId: "intent-1",
    finalStatus: "completed",
    decision: "La accion quedo validada por el operador.",
    steps: [{
      step: 1,
      tool: "runbook_execute",
      inputHash: "0123456789abcdef",
      outcome: "success",
      ...step
    }]
  };
}

function context(options: { events?: AuditEvent[] } = {}) {
  const pool = new MemoryScratchPool();
  const events = options.events ?? [skillInvokedEvent()];
  const deps = {
    pool,
    auditLog: {
      async append(event: AuditEventInput): Promise<AuditEvent> {
        const persisted = {
          id: `audit-${events.length + 1}`,
          occurredAt: "2026-06-02T12:01:00.000Z",
          decision: "allow",
          rejectReason: null,
          humanApproved: false,
          approverIds: [],
          killSwitchState: "unknown",
          rollbackToken: null,
          schemaVersion: "2026-05-18.v1",
          promptVersion: null,
          modelVersion: null,
          evidenceRefs: [],
          prevHash: events.at(-1)?.hash ?? "GENESIS",
          hash: `hash-${events.length + 1}`,
          ...event
        } as AuditEvent;
        events.push(persisted);
        return persisted;
      },
      async list(): Promise<AuditEvent[]> {
        return events;
      }
    },
    now: () => new Date("2026-06-02T12:01:00.000Z")
  };
  return { deps, pool, events };
}

function skillInvokedEvent(): AuditEvent {
  return event({
    id: "audit-intent",
    action: "oc.skill.invoked",
    targetType: "openclaw_intent",
    targetId: "intent-1",
    actorType: "openclaw",
    actorId: "openclaw-agent",
    metadata: { intentId: "intent-1" }
  });
}

function signedEvent(input: { targetId: string; signatureId: string }): AuditEvent {
  return event({
    id: "audit-signed",
    occurredAt: "2026-06-02T12:00:00.000Z",
    action: "oc.proposal.signed",
    targetType: "proposal",
    targetId: input.targetId,
    actorType: "operator",
    actorId: "juanescanar-cto",
    decision: "allow",
    humanApproved: true,
    approverIds: ["juanescanar-cto"],
    metadata: { signatureId: input.signatureId },
    hash: "hash-signed"
  });
}

function event(input: Partial<AuditEvent>): AuditEvent {
  return {
    id: "audit-1",
    occurredAt: "2026-06-02T12:00:00.000Z",
    actorType: "system",
    actorId: "gateway-api",
    action: "test.event",
    targetType: "test",
    targetId: "test",
    riskLevel: "low",
    metadata: {},
    decision: "allow",
    rejectReason: null,
    humanApproved: false,
    approverIds: [],
    killSwitchState: "unknown",
    rollbackToken: null,
    schemaVersion: "2026-05-18.v1",
    promptVersion: null,
    modelVersion: null,
    evidenceRefs: [],
    prevHash: "GENESIS",
    hash: "hash-1",
    ...input
  };
}

interface MemoryRow {
  id: string;
  intent_id: string;
  step: number;
  tool: string;
  input_hash: string;
  outcome: string;
  outcome_data: Record<string, unknown> | null;
  error_class: string | null;
  error_message: string | null;
  source: string;
  trust_score: number;
  plane: string;
  provenance: Record<string, unknown>;
  reliability: number;
  valid_at: Date;
  invalid_at: Date | null;
  ttl_expires_at: Date;
  created_at: Date;
  metadata: Record<string, unknown>;
}

class MemoryScratchPool {
  rows: MemoryRow[] = [];
  now = new Date("2026-06-02T12:01:00.000Z");
  #id = 0;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: MemoryRow[]; rowCount: number }> {
    if (!sql.includes("INSERT INTO openclaw_episodic_scratch")) {
      throw new Error(`Unexpected SQL in compact intent test: ${sql}`);
    }

    const ttlDays = Number(params[15]);
    const row: MemoryRow = {
      id: `scratch-${++this.#id}`,
      intent_id: String(params[0]),
      step: Number(params[1]),
      tool: String(params[2]),
      input_hash: String(params[3]),
      outcome: String(params[4]),
      outcome_data: typeof params[5] === "string" ? JSON.parse(params[5]) : null,
      error_class: typeof params[6] === "string" ? params[6] : null,
      error_message: typeof params[7] === "string" ? params[7] : null,
      source: String(params[8]),
      trust_score: Number(params[9]),
      plane: String(params[10]),
      provenance: typeof params[11] === "string" ? JSON.parse(params[11]) : {},
      reliability: Number(params[12]),
      valid_at: params[13] instanceof Date ? params[13] : new Date(String(params[13])),
      invalid_at: params[14] instanceof Date ? params[14] : null,
      ttl_expires_at: new Date(this.now.getTime() + ttlDays * 24 * 60 * 60 * 1000),
      metadata: typeof params[16] === "string" ? JSON.parse(params[16]) : {},
      created_at: new Date(this.now.getTime() + this.#id)
    };
    this.rows.push(row);
    return { rows: [row], rowCount: 1 };
  }
}

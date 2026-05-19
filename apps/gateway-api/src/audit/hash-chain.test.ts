import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, computeAuditHash, GENESIS_PREV_HASH } from "./hash-chain.ts";
import { InvalidAuditEventError, validateAuditEvent } from "./schema.ts";

test("canonicalize produces same output regardless of key order in input", () => {
  const a = { c: 1, a: 2, b: 3 };
  const b = { a: 2, b: 3, c: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
});

test("canonicalize excludes the hash field from canonical output", () => {
  const event = { id: "x", hash: "should-not-appear" };
  assert.equal(canonicalize(event).includes("should-not-appear"), false);
});

test("canonicalize sorts nested object keys", () => {
  const event = { meta: { z: 1, a: 2 } };
  assert.equal(canonicalize(event), "{\"meta\":{\"a\":2,\"z\":1}}");
});

test("canonicalize preserves array order", () => {
  assert.equal(canonicalize({ arr: [3, 1, 2] }), "{\"arr\":[3,1,2]}");
});

test("computeAuditHash is deterministic", () => {
  const event = { id: "a", action: "test.foo" };
  assert.equal(
    computeAuditHash(event, GENESIS_PREV_HASH),
    computeAuditHash(event, GENESIS_PREV_HASH)
  );
});

test("computeAuditHash changes when any field changes", () => {
  const a = { id: "a", action: "test.foo" };
  const b = { id: "a", action: "test.bar" };
  assert.notEqual(
    computeAuditHash(a, GENESIS_PREV_HASH),
    computeAuditHash(b, GENESIS_PREV_HASH)
  );
});

test("computeAuditHash changes when prevHash changes", () => {
  const event = { id: "a" };
  assert.notEqual(computeAuditHash(event, "GENESIS"), computeAuditHash(event, "abc123"));
});

test("computeAuditHash returns 64 hex chars", () => {
  const hash = computeAuditHash({ id: "a" }, GENESIS_PREV_HASH);
  assert.match(hash, /^[a-f0-9]{64}$/);
});

test("validateAuditEvent accepts a canonical chained event", () => {
  const event = {
    id: "018f7b54-7d4d-7cc2-9c90-df7486c5a111",
    occurredAt: "2026-05-19T00:00:00.000Z",
    actorType: "system",
    actorId: "gateway-api",
    action: "oc.audit.chain_started",
    targetType: "audit_log",
    targetId: "audit-events.jsonl",
    riskLevel: "low",
    decision: "n/a",
    rejectReason: null,
    humanApproved: false,
    approverIds: [],
    killSwitchState: "armed",
    rollbackToken: null,
    schemaVersion: "2026-05-18.v1",
    promptVersion: null,
    modelVersion: null,
    evidenceRefs: [],
    metadata: {},
    prevHash: "GENESIS",
    hash: ""
  };
  event.hash = computeAuditHash(event, event.prevHash);
  assert.doesNotThrow(() => validateAuditEvent(event));
});

test("validateAuditEvent rejects malformed action id", () => {
  const event = {
    id: "018f7b54-7d4d-7cc2-9c90-df7486c5a111",
    occurredAt: "2026-05-19T00:00:00.000Z",
    actorType: "system",
    actorId: "gateway-api",
    action: "Bad Action",
    targetType: "audit_log",
    targetId: "audit-events.jsonl",
    riskLevel: "low",
    decision: "n/a",
    rejectReason: null,
    humanApproved: false,
    approverIds: [],
    killSwitchState: "armed",
    rollbackToken: null,
    schemaVersion: "2026-05-18.v1",
    promptVersion: null,
    modelVersion: null,
    evidenceRefs: [],
    metadata: {},
    prevHash: "GENESIS",
    hash: "0".repeat(64)
  };
  assert.throws(() => validateAuditEvent(event), InvalidAuditEventError);
});

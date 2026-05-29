import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditChainAnchorError,
  auditChainAnchorMessage,
  buildAuditChainAnchor
} from "./audit-chain-anchor.ts";
import { GENESIS_PREV_HASH } from "./audit/hash-chain.ts";

test("buildAuditChainAnchor signs headHash, headSeq and signedAt", () => {
  const anchor = buildAuditChainAnchor({
    verify: {
      ok: true,
      totalEvents: 7,
      emptyChain: false,
      lastHash: "a".repeat(64),
      sourcePath: ".audit/audit-events.jsonl"
    },
    key: "x".repeat(32),
    now: () => new Date("2026-05-29T18:00:00.000Z")
  });

  assert.equal(anchor.headHash, "a".repeat(64));
  assert.equal(anchor.headSeq, 7);
  assert.equal(anchor.signedAt, "2026-05-29T18:00:00.000Z");
  assert.match(anchor.signature, /^[a-f0-9]{64}$/);
});

test("buildAuditChainAnchor fails closed when key is missing or weak", () => {
  assert.throws(
    () => buildAuditChainAnchor({
      verify: {
        ok: true,
        totalEvents: 0,
        emptyChain: true,
        lastHash: GENESIS_PREV_HASH,
        sourcePath: ".audit/audit-events.jsonl"
      },
      key: "short"
    }),
    (error) => error instanceof AuditChainAnchorError && error.statusCode === 503
  );
});

test("buildAuditChainAnchor refuses broken chains", () => {
  assert.throws(
    () => buildAuditChainAnchor({
      verify: {
        ok: false,
        totalEvents: 1,
        emptyChain: false,
        lastHash: GENESIS_PREV_HASH,
        sourcePath: ".audit/audit-events.jsonl",
        brokenAt: {
          seq: 1,
          reason: "hash_mismatch",
          expectedHash: "expected",
          actualHash: "actual"
        }
      },
      key: "x".repeat(32)
    }),
    (error) => error instanceof AuditChainAnchorError && error.statusCode === 422
  );
});

test("auditChainAnchorMessage is stable", () => {
  assert.equal(
    auditChainAnchorMessage({
      headHash: "h",
      headSeq: 3,
      signedAt: "2026-05-29T18:00:00.000Z"
    }),
    "h|3|2026-05-29T18:00:00.000Z"
  );
});

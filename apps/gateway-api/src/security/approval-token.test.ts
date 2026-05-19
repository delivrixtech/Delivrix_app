import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

process.env.OPENCLAW_HMAC_SECRET = "test-approval-secret";
process.env.GATEWAY_SQLITE_FILE = `/private/tmp/delivrix-approval-token-${process.pid}.sqlite`;
rmSync(process.env.GATEWAY_SQLITE_FILE, { force: true });

const {
  getApprovalNonceForToken,
  issueApprovalToken,
  validateApprovalToken
} = await import("./approval-token.ts");

test("issueApprovalToken persists nonce and validateApprovalToken detects replay", () => {
  const token = issueApprovalToken({
    actionId: "register_sender_node_local",
    targetType: "proposal",
    targetId: "svc-new",
    approverId: "op-juanes"
  }, new Date("2026-05-18T22:00:00.000Z"));

  const row = getApprovalNonceForToken(token.tokenId);
  assert.equal(row?.status, "issued");
  assert.equal(row?.actionId, "register_sender_node_local");

  const first = validateApprovalToken(token, {
    actionId: "register_sender_node_local",
    targetType: "proposal",
    targetId: "svc-new"
  }, new Date("2026-05-18T22:01:00.000Z"));

  assert.deepEqual(first, { ok: true });
  assert.equal(getApprovalNonceForToken(token.tokenId)?.status, "consumed");

  const replay = validateApprovalToken(token, {
    actionId: "register_sender_node_local",
    targetType: "proposal",
    targetId: "svc-new"
  }, new Date("2026-05-18T22:01:01.000Z"));

  assert.deepEqual(replay, { ok: false, rejectReason: "token_replay_detected" });
});

test("validateApprovalToken rejects target mismatch before consuming nonce", () => {
  const token = issueApprovalToken({
    actionId: "register_sender_node_local",
    targetType: "proposal",
    targetId: "svc-other",
    approverId: "op-juanes"
  }, new Date("2026-05-18T22:05:00.000Z"));

  const result = validateApprovalToken(token, {
    actionId: "register_sender_node_local",
    targetType: "proposal",
    targetId: "svc-wrong"
  }, new Date("2026-05-18T22:05:10.000Z"));

  assert.deepEqual(result, { ok: false, rejectReason: "token_target_mismatch" });
  assert.equal(getApprovalNonceForToken(token.tokenId)?.status, "issued");
});

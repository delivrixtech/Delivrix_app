import { createHmac } from "node:crypto";
import type { AuditChainVerifyResult } from "./audit-chain.ts";

export interface AuditChainAnchor {
  headHash: string;
  headSeq: number;
  signedAt: string;
  signature: string;
}

export function buildAuditChainAnchor(input: {
  verify: AuditChainVerifyResult;
  key: string | undefined;
  now?: () => Date;
}): AuditChainAnchor {
  if (!input.verify.ok) {
    throw new AuditChainAnchorError("audit_chain_broken", 422);
  }
  const key = input.key?.trim() ?? "";
  if (key.length < 32) {
    throw new AuditChainAnchorError("audit_anchor_key_missing_or_weak", 503);
  }
  const signedAt = (input.now?.() ?? new Date()).toISOString();
  const message = auditChainAnchorMessage({
    headHash: input.verify.lastHash,
    headSeq: input.verify.totalEvents,
    signedAt
  });
  return {
    headHash: input.verify.lastHash,
    headSeq: input.verify.totalEvents,
    signedAt,
    signature: createHmac("sha256", key).update(message).digest("hex")
  };
}

export function auditChainAnchorMessage(input: {
  headHash: string;
  headSeq: number;
  signedAt: string;
}): string {
  return `${input.headHash}|${input.headSeq}|${input.signedAt}`;
}

export class AuditChainAnchorError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "AuditChainAnchorError";
    this.statusCode = statusCode;
  }
}

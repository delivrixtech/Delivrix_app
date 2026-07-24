import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AuditEvent,
  CanvasLiveArtifactSnapshot
} from "../../../packages/domain/src/index.ts";

export function approvalTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function auditApprovalMatchesToken(event: AuditEvent, approvalToken: string): boolean {
  if (event.action !== "oc.artifact.approved") return false;
  const hash = metadataString(event.metadata, "approvalTokenHash");
  return !!hash && hashesEqual(hash, approvalTokenHash(approvalToken));
}

/**
 * When an approval was recorded against a concrete domain target
 * (`targetType === "domain"`), returns the normalized domain the approval
 * authorizes so callers can bind a mutation request to it. Returns `null` when
 * the approval records no domain target (e.g. a generic canvas artifact or
 * proposal target), in which case callers keep their existing unbound
 * behaviour. This lets a verifier reject a confused-deputy replay — an approval
 * signed for one domain being used to act on a different domain — without
 * changing how approvals are issued.
 */
export function auditApprovalDomainTarget(event: AuditEvent): string | null {
  if (event.action !== "oc.artifact.approved") return null;
  if (event.targetType !== "domain") return null;
  return normalizeApprovalDomain(event.targetId);
}

export function normalizeApprovalDomain(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  return normalized.length > 0 ? normalized : null;
}

export function artifactMatchesAuditApproval(input: {
  artifact: CanvasLiveArtifactSnapshot;
  approvalEvent: AuditEvent;
  approvalToken: string;
  now: Date;
  maxAgeMs: number;
}): boolean {
  const expectedExecutionId = metadataString(input.approvalEvent.metadata, "executionId") ?? input.approvalToken;
  if (
    input.artifact.approvalStatus !== "approved" ||
    input.artifact.executionId !== expectedExecutionId ||
    !input.artifact.approvedAt
  ) {
    return false;
  }
  const approvedAt = Date.parse(input.artifact.approvedAt);
  if (!Number.isFinite(approvedAt)) return false;
  const ageMs = input.now.getTime() - approvedAt;
  return ageMs >= 0 && ageMs <= input.maxAgeMs;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hashesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

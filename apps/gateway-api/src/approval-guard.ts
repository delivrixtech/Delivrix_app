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

/**
 * When a send approval was recorded against a concrete message, returns the
 * recorded `inputHash` — the `sha256(stableStringify(params))` the orchestrator
 * hashed at issuance over the exact send step params
 * (fromAddress/toAddress/subject/body/serverSlug/selector/idempotencyKey/runId).
 * Returns `null` when the approval records no well-formed `inputHash` (e.g. a
 * proposal-sign or plain canvas artifact approval), so callers keep their
 * existing unbound behaviour. This lets the send handler reject a confused-deputy
 * replay — an approval bound to one message reused to send a different
 * recipient/body/server — without changing how approvals are issued.
 */
export function auditApprovalSendInputHash(event: AuditEvent): string | null {
  if (event.action !== "oc.artifact.approved") return null;
  const value = metadataString(event.metadata, "inputHash");
  return value && /^[a-f0-9]{64}$/i.test(value) ? value : null;
}

/**
 * Binds a canvas-artifact approval (`targetType !== "domain"`) to the concrete
 * skill and params it was issued for, so a verifier can reject a confused-deputy
 * replay of such a token onto a different domain WITHOUT changing how approvals
 * are issued.
 *
 * The only issuance path that records an `approvalTokenHash` on a
 * `canvas_artifact` `oc.artifact.approved` event — the orchestrator plan step
 * (`executePlanApprovedStep`) — always also records the executed `skill` and its
 * `inputHash`, where `inputHash === sha256(stableStringify(skillParams))` and the
 * params include the target domain. A caller that recomputes that same hash from
 * its request can therefore confirm the approval was issued for exactly this
 * domain/skill.
 *
 * Returns `true` (binding not applicable, keep prior behaviour) for non-approval
 * events, for domain-scoped approvals (bound separately via
 * `auditApprovalDomainTarget`), and for canvas approvals that record no
 * `inputHash` — no matchable production issuance path produces the latter, so
 * their previous unbound behaviour is preserved rather than newly rejected.
 * Returns `false` only when a canvas approval records a `skill`/`inputHash` that
 * contradicts the expected binding.
 */
export function auditApprovalCanvasBindingAllows(
  event: AuditEvent,
  expected: { skill: string; inputHash: string }
): boolean {
  if (event.action !== "oc.artifact.approved") return true;
  if (event.targetType === "domain") return true;
  const recordedInputHash = metadataString(event.metadata, "inputHash");
  if (!recordedInputHash) return true;
  const recordedSkill = metadataString(event.metadata, "skill");
  if (recordedSkill !== null && recordedSkill !== expected.skill) return false;
  return hashesEqual(recordedInputHash, expected.inputHash);
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

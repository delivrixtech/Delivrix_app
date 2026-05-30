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

import type { AuditActorType, AuditEventInput } from "../../../packages/domain/src/index.ts";

export interface AuditBatchCaller {
  actorType: Extract<AuditActorType, "openclaw" | "system">;
  actorId: string;
}

export interface HardenedAuditBatchEvent {
  event: AuditEventInput;
  impersonationAttempt: boolean;
  humanApprovalStripped: boolean;
}

export interface AuditBatchOriginOptions {
  caller?: AuditBatchCaller;
  validSignatureIds?: Iterable<string>;
}

const defaultCaller: AuditBatchCaller = {
  actorType: "openclaw",
  actorId: "openclaw-hostinger-prod"
};

export function hardenIncomingAuditBatchEvent(
  incoming: Record<string, unknown>,
  options: AuditBatchOriginOptions | AuditBatchCaller = {}
): HardenedAuditBatchEvent {
  const caller = isLegacyCaller(options) ? options : options.caller ?? defaultCaller;
  const validSignatureIds = new Set(isLegacyCaller(options) ? [] : options.validSignatureIds ?? []);
  const { prevHash: _prevHash, hash: _hash, ...withoutChain } = incoming;
  const metadata = isRecord(withoutChain.metadata) ? { ...withoutChain.metadata } : {};
  const claimedActorType = typeof withoutChain.actorType === "string" ? withoutChain.actorType : undefined;
  const claimedActorId = typeof withoutChain.actorId === "string" ? withoutChain.actorId : undefined;
  const impersonationAttempt =
    (claimedActorType !== undefined && claimedActorType !== caller.actorType) ||
    (claimedActorId !== undefined && claimedActorId !== caller.actorId);

  if (impersonationAttempt) {
    metadata._impersonation_attempt = true;
    metadata.claimedActorType = claimedActorType ?? null;
    metadata.claimedActorId = claimedActorId ?? null;
    metadata.enforcedActorType = caller.actorType;
    metadata.enforcedActorId = caller.actorId;
  }

  const signatureId = typeof metadata.signatureId === "string" && metadata.signatureId.trim()
    ? metadata.signatureId.trim()
    : null;
  const signatureTrusted = signatureId !== null && validSignatureIds.has(signatureId);
  const humanApprovalStripped = withoutChain.humanApproved === true && !signatureTrusted;
  if (humanApprovalStripped) {
    metadata._human_approval_stripped = true;
  }

  const event: AuditEventInput = {
    ...(withoutChain as AuditEventInput),
    actorType: caller.actorType,
    actorId: caller.actorId,
    humanApproved: withoutChain.humanApproved === true && signatureTrusted,
    approverIds: withoutChain.humanApproved === true && signatureTrusted
      ? normalizeApproverIds(withoutChain.approverIds)
      : [],
    metadata
  };

  return { event, impersonationAttempt, humanApprovalStripped };
}

function isLegacyCaller(value: AuditBatchOriginOptions | AuditBatchCaller): value is AuditBatchCaller {
  return "actorType" in value && "actorId" in value;
}

function normalizeApproverIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

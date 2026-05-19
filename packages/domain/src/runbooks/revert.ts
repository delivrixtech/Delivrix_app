import type { SenderNode } from "../types.ts";
import type {
  QuarantineRevertTargetStatus,
  RevertRunbookResult,
  RollbackSnapshot,
  RunbookSenderNodeRepository
} from "./types.ts";

export async function revertRunbook(params: {
  snapshot: RollbackSnapshot;
  repository: RunbookSenderNodeRepository;
  now?: Date;
  metadata?: {
    targetStatus?: QuarantineRevertTargetStatus;
  };
}): Promise<RevertRunbookResult> {
  const now = params.now ?? new Date();

  if (params.snapshot.status === "consumed") {
    return { ok: false, rejectReason: "rollback_token_consumed", detail: "Rollback snapshot already consumed." };
  }

  if (params.snapshot.status === "expired" || Date.parse(params.snapshot.expiresAt) <= now.getTime()) {
    return { ok: false, rejectReason: "rollback_token_expired", detail: "Rollback snapshot expired." };
  }

  const prevState = parsePrevState(params.snapshot.prevStateJson);

  if (!prevState) {
    return { ok: false, rejectReason: "state_inconsistent", detail: "Rollback snapshot payload is invalid." };
  }

  switch (params.snapshot.runbookId) {
    case "register-sender-node-local":
      return revertRegister(params.snapshot.targetId, prevState, params.repository);
    case "warming-step":
      return revertWarming(params.snapshot.targetId, prevState, params.repository);
    case "pause-ip":
      return revertPause(params.snapshot.targetId, prevState, params.repository);
    case "incident-quarantine":
      return revertQuarantine(params.snapshot.targetId, params.metadata?.targetStatus ?? "active", params.repository);
    default:
      return { ok: false, rejectReason: "unknown_runbook", detail: `Unknown runbook ${params.snapshot.runbookId}.` };
  }
}

async function revertRegister(
  nodeId: string,
  prevState: Record<string, unknown>,
  repository: RunbookSenderNodeRepository
): Promise<RevertRunbookResult> {
  if (prevState.existed !== false) {
    return { ok: false, rejectReason: "state_inconsistent", detail: "Register rollback only supports existed=false." };
  }

  const updated = await repository.updateStatus(nodeId, "retired_pending_approval");
  return {
    ok: true,
    restoredState: prevState,
    newState: pickSenderNodeRollbackState(updated)
  };
}

async function revertWarming(
  nodeId: string,
  prevState: Record<string, unknown>,
  repository: RunbookSenderNodeRepository
): Promise<RevertRunbookResult> {
  if (!isNumber(prevState.warmupDay) || !isNumber(prevState.dailyLimit)) {
    return { ok: false, rejectReason: "state_inconsistent", detail: "Warming rollback snapshot is incomplete." };
  }

  const updated = await repository.updateMetadata(nodeId, {
    warmupDay: prevState.warmupDay,
    dailyLimit: prevState.dailyLimit,
    status: isSenderNodeStatus(prevState.status) ? prevState.status : undefined
  });

  return {
    ok: true,
    restoredState: prevState,
    newState: pickSenderNodeRollbackState(updated)
  };
}

async function revertPause(
  nodeId: string,
  prevState: Record<string, unknown>,
  repository: RunbookSenderNodeRepository
): Promise<RevertRunbookResult> {
  if (!isSenderNodeStatus(prevState.status)) {
    return { ok: false, rejectReason: "state_inconsistent", detail: "Pause rollback snapshot is missing status." };
  }

  const updated = await repository.updateMetadata(nodeId, {
    status: prevState.status,
    warmupDay: isNumber(prevState.warmupDay) ? prevState.warmupDay : undefined,
    dailyLimit: isNumber(prevState.dailyLimit) ? prevState.dailyLimit : undefined
  });

  return {
    ok: true,
    restoredState: prevState,
    newState: pickSenderNodeRollbackState(updated)
  };
}

async function revertQuarantine(
  nodeId: string,
  targetStatus: QuarantineRevertTargetStatus,
  repository: RunbookSenderNodeRepository
): Promise<RevertRunbookResult> {
  if (!isQuarantineTargetStatus(targetStatus)) {
    return {
      ok: false,
      rejectReason: "invalid_target_status",
      detail: "targetStatus must be one of active, retired, quarantined."
    };
  }

  const updated = await repository.updateStatus(nodeId, targetStatus);

  return {
    ok: true,
    restoredState: { status: targetStatus },
    newState: pickSenderNodeRollbackState(updated)
  };
}

function parsePrevState(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSenderNodeStatus(value: unknown): value is SenderNode["status"] {
  return (
    value === "active" ||
    value === "warming" ||
    value === "paused" ||
    value === "quarantined" ||
    value === "degraded" ||
    value === "retired_pending_approval" ||
    value === "retired"
  );
}

function isQuarantineTargetStatus(value: unknown): value is QuarantineRevertTargetStatus {
  return value === "active" || value === "retired" || value === "quarantined";
}

function pickSenderNodeRollbackState(node: SenderNode): Pick<SenderNode, "id" | "status" | "warmupDay" | "dailyLimit"> {
  return {
    id: node.id,
    status: node.status,
    warmupDay: node.warmupDay,
    dailyLimit: node.dailyLimit
  };
}

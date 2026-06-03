import type { RegisterSenderNodeInput } from "../sender-node-registry.ts";
import type { SenderNode } from "../types.ts";

export type RunbookId = "register-sender-node-local" | "warming-step" | "pause-ip" | "incident-quarantine";

export type RunbookRejectReason =
  | "preconditions_failed"
  | "kill_switch_armed"
  | "race_condition"
  | "state_inconsistent";

export interface PersistRollbackSnapshotInput {
  runbookId: RunbookId | `${RunbookId}-revert`;
  targetType: "sender_node";
  targetId: string;
  prevStateJson: string;
}

export interface ReserveRunbookExecutionInput {
  proposalId: string;
  runbookId: RunbookId;
  occurredAt: string;
}

export interface RunbookExecutionTracker {
  reserve(input: ReserveRunbookExecutionInput): Promise<"reserved" | "already_reserved">;
}

export interface RunbookSenderNodeRepository {
  list(): Promise<SenderNode[]>;
  get(senderNodeId: string): Promise<SenderNode | null>;
  exists(senderNodeId: string): Promise<boolean>;
  existsByIp(ipAddress: string | undefined): Promise<boolean>;
  register(input: RegisterSenderNodeInput): Promise<SenderNode>;
  updateStatus(senderNodeId: string, status: SenderNode["status"]): Promise<SenderNode>;
  updateMetadata(
    senderNodeId: string,
    patch: Partial<Pick<SenderNode, "status" | "dailyLimit" | "warmupDay" | "ipAddress" | "hostname" | "label">>
  ): Promise<SenderNode>;
}

export interface RunbookContext {
  proposalId: string;
  approverIds: string[];
  killSwitchState: "armed" | "active";
  occurredAt: string;
  repository: RunbookSenderNodeRepository;
  persistRollbackSnapshot(input: PersistRollbackSnapshotInput): Promise<string> | string;
  executionTracker: RunbookExecutionTracker;
}

export type RunbookResult = {
  ok: true;
  rollbackToken: string;
  newState: unknown;
  prevState: unknown;
  auditAction: string;
} | {
  ok: false;
  rejectReason: RunbookRejectReason;
  detail: string;
};

export interface RegisterSenderNodeRunbookInput extends RegisterSenderNodeInput {}

export interface WarmingStepInput {
  nodeId: string;
}

export interface PauseIpInput {
  nodeId: string;
  reason?: string;
}

export interface QuarantineInput {
  nodeId: string;
  reason: string;
  evidenceRefs: string[];
}

export interface RollbackSnapshot {
  rollbackToken: string;
  runbookId: RunbookId;
  targetType: "sender_node";
  targetId: string;
  prevStateJson: string;
  createdAt: string;
  expiresAt: string;
  status: "available" | "consumed" | "expired";
}

export type RevertRunbookResult = {
  ok: true;
  restoredState: unknown;
  newState: unknown;
} | {
  ok: false;
  rejectReason:
    | "rollback_token_not_found"
    | "rollback_token_expired"
    | "rollback_token_consumed"
    | "unknown_runbook"
    | "state_inconsistent"
    | "invalid_target_status";
  detail: string;
};

export type QuarantineRevertTargetStatus = "active" | "retired" | "quarantined";

export function rejectRunbook(rejectReason: RunbookRejectReason, detail: string): RunbookResult {
  return { ok: false, rejectReason, detail };
}

export async function reserveProposalExecution(
  ctx: RunbookContext,
  runbookId: RunbookId
): Promise<RunbookResult | null> {
  try {
    const reservation = await ctx.executionTracker.reserve({
      proposalId: ctx.proposalId,
      runbookId,
      occurredAt: ctx.occurredAt
    });
    if (reservation === "already_reserved") {
      return rejectRunbook("state_inconsistent", `Proposal ${ctx.proposalId} already executed.`);
    }
    return null;
  } catch {
    return rejectRunbook(
      "state_inconsistent",
      `Runbook idempotency tracker unavailable for proposal ${ctx.proposalId}; refusing execution.`
    );
  }
}

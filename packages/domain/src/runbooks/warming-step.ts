import {
  hasProposalExecuted,
  markProposalExecuted,
  rejectRunbook,
  type RunbookContext,
  type RunbookResult,
  type WarmingStepInput
} from "./types.ts";

const maxWarmupDay = 30;

export async function executeWarmingStepRunbook(
  input: WarmingStepInput,
  ctx: RunbookContext
): Promise<RunbookResult> {
  if (ctx.killSwitchState === "active") {
    return rejectRunbook("kill_switch_armed", "Kill switch enabled.");
  }

  if (hasProposalExecuted(ctx)) {
    return rejectRunbook("state_inconsistent", `Proposal ${ctx.proposalId} already executed.`);
  }

  const approverIds = [...new Set(ctx.approverIds)];

  if (approverIds.length < 2) {
    return rejectRunbook("preconditions_failed", "warming-step requires 2 distinct approvers.");
  }

  const node = await ctx.repository.get(input.nodeId);

  if (!node) {
    return rejectRunbook("state_inconsistent", `Node ${input.nodeId} not found.`);
  }

  if (node.status !== "warming") {
    return rejectRunbook("preconditions_failed", `Node status is ${node.status}, expected warming.`);
  }

  if (node.warmupDay >= maxWarmupDay) {
    return rejectRunbook("preconditions_failed", `warmupDay ${node.warmupDay} is at max.`);
  }

  const prevState = {
    status: node.status,
    warmupDay: node.warmupDay,
    dailyLimit: node.dailyLimit
  };
  const newWarmupDay = node.warmupDay + 1;
  const newDailyLimit = computeDailyLimitForDay(newWarmupDay, node.dailyLimit);

  const rollbackToken = await ctx.persistRollbackSnapshot({
    runbookId: "warming-step",
    targetType: "sender_node",
    targetId: input.nodeId,
    prevStateJson: JSON.stringify(prevState)
  });

  const updated = await ctx.repository.updateMetadata(input.nodeId, {
    warmupDay: newWarmupDay,
    dailyLimit: newDailyLimit
  });

  markProposalExecuted(ctx);

  return {
    ok: true,
    rollbackToken,
    newState: {
      status: updated.status,
      warmupDay: updated.warmupDay,
      dailyLimit: updated.dailyLimit
    },
    prevState,
    auditAction: "oc.runbook.warming_step.executed"
  };
}

export function computeDailyLimitForDay(warmupDay: number, previousLimit: number): number {
  return Math.max(previousLimit, warmupDay * 50);
}

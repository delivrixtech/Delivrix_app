import {
  rejectRunbook,
  reserveProposalExecution,
  type PauseIpInput,
  type RunbookContext,
  type RunbookResult
} from "./types.ts";

export async function executePauseIpRunbook(
  input: PauseIpInput,
  ctx: RunbookContext
): Promise<RunbookResult> {
  if (ctx.killSwitchState === "active") {
    return rejectRunbook("kill_switch_armed", "Kill switch enabled.");
  }

  const node = await ctx.repository.get(input.nodeId);

  if (!node) {
    return rejectRunbook("state_inconsistent", `Node ${input.nodeId} not found.`);
  }

  if (node.status !== "active" && node.status !== "warming") {
    return rejectRunbook("preconditions_failed", `Cannot pause node in status ${node.status}.`);
  }

  const prevState = {
    status: node.status,
    warmupDay: node.warmupDay,
    dailyLimit: node.dailyLimit
  };

  const idempotencyResult = await reserveProposalExecution(ctx, "pause-ip");
  if (idempotencyResult) {
    return idempotencyResult;
  }

  const rollbackToken = await ctx.persistRollbackSnapshot({
    runbookId: "pause-ip",
    targetType: "sender_node",
    targetId: input.nodeId,
    prevStateJson: JSON.stringify(prevState)
  });

  const updated = await ctx.repository.updateStatus(input.nodeId, "paused");

  return {
    ok: true,
    rollbackToken,
    newState: {
      status: updated.status,
      warmupDay: updated.warmupDay,
      dailyLimit: updated.dailyLimit
    },
    prevState,
    auditAction: "oc.runbook.pause_ip.executed"
  };
}

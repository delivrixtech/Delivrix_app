import {
  rejectRunbook,
  reserveProposalExecution,
  type QuarantineInput,
  type RunbookContext,
  type RunbookResult
} from "./types.ts";

export async function executeQuarantineRunbook(
  input: QuarantineInput,
  ctx: RunbookContext
): Promise<RunbookResult> {
  if (ctx.killSwitchState === "active") {
    return rejectRunbook("kill_switch_armed", "Kill switch enabled.");
  }

  if (!input.reason?.trim()) {
    return rejectRunbook("preconditions_failed", "Quarantine reason is required.");
  }

  const node = await ctx.repository.get(input.nodeId);

  if (!node) {
    return rejectRunbook("state_inconsistent", `Node ${input.nodeId} not found.`);
  }

  if (node.status !== "active" && node.status !== "warming" && node.status !== "paused") {
    return rejectRunbook("preconditions_failed", `Cannot quarantine node in status ${node.status}.`);
  }

  const prevState = {
    status: node.status,
    warmupDay: node.warmupDay,
    dailyLimit: node.dailyLimit
  };

  const idempotencyResult = await reserveProposalExecution(ctx, "incident-quarantine");
  if (idempotencyResult) {
    return idempotencyResult;
  }

  const rollbackToken = await ctx.persistRollbackSnapshot({
    runbookId: "incident-quarantine",
    targetType: "sender_node",
    targetId: input.nodeId,
    prevStateJson: JSON.stringify(prevState)
  });

  const updated = await ctx.repository.updateStatus(input.nodeId, "quarantined");

  return {
    ok: true,
    rollbackToken,
    newState: {
      status: updated.status,
      warmupDay: updated.warmupDay,
      dailyLimit: updated.dailyLimit,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs
    },
    prevState,
    auditAction: "oc.runbook.quarantine.executed"
  };
}

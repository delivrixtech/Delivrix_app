import type { SenderNode } from "../types.ts";
import {
  rejectRunbook,
  reserveProposalExecution,
  type RegisterSenderNodeRunbookInput,
  type RunbookContext,
  type RunbookResult
} from "./types.ts";

export async function executeRegisterSenderNodeRunbook(
  input: RegisterSenderNodeRunbookInput,
  ctx: RunbookContext
): Promise<RunbookResult> {
  if (ctx.killSwitchState === "active") {
    return rejectRunbook("kill_switch_armed", "Kill switch enabled.");
  }

  if (await ctx.repository.exists(input.id)) {
    return rejectRunbook("state_inconsistent", `Node ${input.id} already registered.`);
  }

  if (await ctx.repository.existsByIp(input.ipAddress)) {
    return rejectRunbook("state_inconsistent", `IP ${input.ipAddress} already registered.`);
  }

  const idempotencyResult = await reserveProposalExecution(ctx, "register-sender-node-local");
  if (idempotencyResult) {
    return idempotencyResult;
  }

  const prevState = { existed: false };
  const rollbackToken = await ctx.persistRollbackSnapshot({
    runbookId: "register-sender-node-local",
    targetType: "sender_node",
    targetId: input.id,
    prevStateJson: JSON.stringify(prevState)
  });

  await ctx.repository.register(input);
  const found = await ctx.repository.get(input.id);

  if (!found) {
    return rejectRunbook("state_inconsistent", `Node ${input.id} not found after register.`);
  }

  return {
    ok: true,
    rollbackToken,
    newState: pickSenderNodeState(found),
    prevState,
    auditAction: "oc.runbook.register_sender_node.executed"
  };
}

function pickSenderNodeState(node: SenderNode): SenderNode {
  return { ...node };
}

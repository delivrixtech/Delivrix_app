import type { SenderNode } from "../types.ts";
import {
  hasProposalExecuted,
  markProposalExecuted,
  rejectRunbook,
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

  if (hasProposalExecuted(ctx)) {
    return rejectRunbook("state_inconsistent", `Proposal ${ctx.proposalId} already executed.`);
  }

  if (await ctx.repository.exists(input.id)) {
    return rejectRunbook("state_inconsistent", `Node ${input.id} already registered.`);
  }

  if (await ctx.repository.existsByIp(input.ipAddress)) {
    return rejectRunbook("state_inconsistent", `IP ${input.ipAddress} already registered.`);
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

  markProposalExecuted(ctx);

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

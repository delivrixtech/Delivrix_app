export type KillSwitchOperation =
  | "accept_send_request"
  | "claim_send_job"
  | "execute_openclaw_proposed_action"
  | "apply_supervised_local_action"
  | "apply_live_infrastructure_action";

export interface KillSwitchState {
  enabled: boolean;
  reason?: string;
  updatedAt: string;
  updatedBy: string;
}

export interface UpdateKillSwitchInput {
  enabled: boolean;
  reason?: string;
  updatedBy?: string;
  now?: Date;
}

export interface KillSwitchDecision {
  allowed: boolean;
  operation: KillSwitchOperation;
  code: "kill_switch_inactive" | "kill_switch_active";
  message: string;
  state: KillSwitchState;
}

export function defaultKillSwitchState(now = new Date()): KillSwitchState {
  return {
    enabled: false,
    reason: "Kill switch has not been activated.",
    updatedAt: now.toISOString(),
    updatedBy: "system"
  };
}

export function buildKillSwitchState(input: UpdateKillSwitchInput): KillSwitchState {
  const reason = normalizedReason(input.reason);

  if (input.enabled && !reason) {
    throw new Error("reason is required when enabling kill switch.");
  }

  return {
    enabled: input.enabled,
    reason: reason ?? (input.enabled ? undefined : "Kill switch disabled."),
    updatedAt: (input.now ?? new Date()).toISOString(),
    updatedBy: normalizedUpdatedBy(input.updatedBy)
  };
}

export function evaluateKillSwitch(
  state: KillSwitchState,
  operation: KillSwitchOperation
): KillSwitchDecision {
  if (!state.enabled) {
    return {
      allowed: true,
      operation,
      code: "kill_switch_inactive",
      message: "Kill switch is inactive.",
      state
    };
  }

  return {
    allowed: false,
    operation,
    code: "kill_switch_active",
    message: state.reason ? `Kill switch is active: ${state.reason}` : "Kill switch is active.",
    state
  };
}

function normalizedReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizedUpdatedBy(updatedBy: string | undefined): string {
  const trimmed = updatedBy?.trim();
  return trimmed || "local-operator";
}

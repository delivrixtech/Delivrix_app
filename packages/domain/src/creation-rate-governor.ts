import type { WebdockInventoryServer } from "./webdock-inventory.ts";

export const CREATION_RATE_STEP = 4;
export const CREATION_RATE_SKILL = "create_webdock_server";
export const DEFAULT_CREATION_ACCOUNT_ID = "ops";
export const DEFAULT_CREATION_MAX_PER_DAY = 4;
export const ROLLING_24H_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CreationRateWindow = "rolling_24h" | "calendar_day_bogota";
export type CreationRateFailMode = "fail_open" | "fail_closed";

export type CreationRateFailureCode =
  | "creation_rate_exceeded"
  | "creation_rate_read_failed";

export type CreationRateDecisionReason =
  | "creation_rate_allowed"
  | "creation_rate_disabled"
  | "creation_rate_exceeded"
  | "creation_rate_read_failed_fail_open"
  | "creation_rate_read_failed_fail_closed";

export type CreationRateAuditEventName =
  | "oc.orchestrator.creation_rate_exceeded"
  | "oc.orchestrator.creation_rate_read_failed"
  | "oc.orchestrator.creation_rate_governor_disabled";

export interface CreationRateServer {
  creationDate?: string | null;
}

export interface EvaluateCreationBudgetInput {
  servers: CreationRateServer[];
  now: Date;
  accountId?: string;
  cap?: number;
  enabled?: boolean;
  window?: CreationRateWindow;
}

export interface EvaluateCreationReadErrorInput {
  now: Date;
  accountId?: string;
  cap?: number;
  enabled?: boolean;
  window?: CreationRateWindow;
  failMode?: CreationRateFailMode;
  error?: unknown;
}

export interface CreationRateFailure {
  code: CreationRateFailureCode;
  step: typeof CREATION_RATE_STEP;
  skill: typeof CREATION_RATE_SKILL;
  message: string;
}

export interface CreationRateAuditHint {
  eventName: CreationRateAuditEventName;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface CreationBudgetDecision {
  allowed: boolean;
  accountId: string;
  enabled: boolean;
  window: CreationRateWindow;
  cap: number;
  createdInWindow: number;
  remaining: number;
  reason: CreationRateDecisionReason;
  readErrorMessage?: string;
  failure?: CreationRateFailure;
  audit?: CreationRateAuditHint;
}

export interface CreationAccountForSelection {
  accountId: string;
  healthy: boolean;
  enabled?: boolean;
}

export interface CreationAccountGovernorState {
  accountId: string;
  allowed: boolean;
  createdInWindow: number;
  cap: number;
}

export interface SelectAccountForCreationInput {
  accounts: CreationAccountForSelection[];
  governorState: CreationAccountGovernorState[];
}

export type CreationAccountSelectionReason =
  | "selected"
  | "no_accounts"
  | "no_eligible_accounts"
  | "creation_rate_exceeded_all_accounts";

export interface CreationAccountSelectionCandidate {
  accountId: string;
  enabled: boolean;
  healthy: boolean;
  budgetKnown: boolean;
  budgetAllowed: boolean;
  createdInWindow: number;
  cap: number;
  remaining: number;
}

export interface CreationAccountSelectionDecision {
  selectedAccountId: string | null;
  reason: CreationAccountSelectionReason;
  candidates: CreationAccountSelectionCandidate[];
}

export class CreationRateGovernorError extends Error {
  readonly decision: CreationBudgetDecision;
  readonly code: CreationRateFailureCode;
  readonly step = CREATION_RATE_STEP;
  readonly skill = CREATION_RATE_SKILL;

  constructor(decision: CreationBudgetDecision) {
    super(decision.failure?.message ?? decision.reason);
    this.name = "CreationRateGovernorError";
    this.decision = decision;
    this.code = decision.failure?.code ?? "creation_rate_exceeded";
  }
}

export class CreationAccountSelectionError extends Error {
  readonly decision: CreationAccountSelectionDecision;
  readonly code: CreationAccountSelectionReason;
  readonly step = CREATION_RATE_STEP;
  readonly skill = CREATION_RATE_SKILL;

  constructor(decision: CreationAccountSelectionDecision) {
    super(decision.reason);
    this.name = "CreationAccountSelectionError";
    this.decision = decision;
    this.code = decision.reason;
  }
}

export function countCreatedInRolling24h(
  servers: CreationRateServer[] | WebdockInventoryServer[],
  now: Date
): number {
  const nowMs = validDateMs(now, "now");
  const windowStartMs = nowMs - ROLLING_24H_WINDOW_MS;

  return servers.filter((server) => {
    const createdAtMs = parseCreationDateMs(server.creationDate);
    return createdAtMs !== null && createdAtMs >= windowStartMs && createdAtMs <= nowMs;
  }).length;
}

export function countCreatedInWindow(
  servers: CreationRateServer[] | WebdockInventoryServer[],
  now: Date,
  window: CreationRateWindow = "rolling_24h"
): number {
  if (window === "calendar_day_bogota") {
    validDateMs(now, "now");
    const today = bogotaDayKey(now);
    return servers.filter((server) => {
      const createdAtMs = parseCreationDateMs(server.creationDate);
      return createdAtMs !== null
        && createdAtMs <= now.getTime()
        && bogotaDayKey(new Date(createdAtMs)) === today;
    }).length;
  }
  return countCreatedInRolling24h(servers, now);
}

export function evaluateCreationBudget(input: EvaluateCreationBudgetInput): CreationBudgetDecision {
  const accountId = normalizeAccountId(input.accountId);
  const cap = normalizeCap(input.cap);
  const window = normalizeWindow(input.window);
  const enabled = input.enabled ?? true;
  const createdInWindow = countCreatedInWindow(input.servers, input.now, window);
  const remaining = Math.max(cap - createdInWindow, 0);

  if (!enabled) {
    return {
      allowed: true,
      accountId,
      enabled,
      window,
      cap,
      createdInWindow,
      remaining,
      reason: "creation_rate_disabled",
      audit: {
        eventName: "oc.orchestrator.creation_rate_governor_disabled",
        severity: "warning",
        message: `creation_rate_governor_disabled: created_24h=${createdInWindow} cap=${cap} account=${accountId}`
      }
    };
  }

  if (createdInWindow >= cap) {
    const message = exceededMessage(createdInWindow, cap, accountId);
    return {
      allowed: false,
      accountId,
      enabled,
      window,
      cap,
      createdInWindow,
      remaining,
      reason: "creation_rate_exceeded",
      failure: {
        code: "creation_rate_exceeded",
        step: CREATION_RATE_STEP,
        skill: CREATION_RATE_SKILL,
        message
      },
      audit: {
        eventName: "oc.orchestrator.creation_rate_exceeded",
        severity: "error",
        message
      }
    };
  }

  return {
    allowed: true,
    accountId,
    enabled,
    window,
    cap,
    createdInWindow,
    remaining,
    reason: "creation_rate_allowed"
  };
}

export function ensureCreationBudget(input: EvaluateCreationBudgetInput): CreationBudgetDecision {
  const decision = evaluateCreationBudget(input);

  if (!decision.allowed) {
    throw new CreationRateGovernorError(decision);
  }

  return decision;
}

export function evaluateCreationBudgetReadError(
  input: EvaluateCreationReadErrorInput
): CreationBudgetDecision {
  const accountId = normalizeAccountId(input.accountId);
  const cap = normalizeCap(input.cap);
  const window = normalizeWindow(input.window);
  const enabled = input.enabled ?? true;
  const failMode = input.failMode ?? "fail_open";
  const readErrorMessage = normalizeErrorMessage(input.error);

  validDateMs(input.now, "now");

  if (!enabled) {
    return {
      allowed: true,
      accountId,
      enabled,
      window,
      cap,
      createdInWindow: 0,
      remaining: cap,
      reason: "creation_rate_disabled",
      readErrorMessage,
      audit: {
        eventName: "oc.orchestrator.creation_rate_governor_disabled",
        severity: "warning",
        message: `creation_rate_governor_disabled: read_error=${readErrorMessage} cap=${cap} account=${accountId}`
      }
    };
  }

  if (failMode === "fail_open") {
    return {
      allowed: true,
      accountId,
      enabled,
      window,
      cap,
      createdInWindow: 0,
      remaining: cap,
      reason: "creation_rate_read_failed_fail_open",
      readErrorMessage,
      audit: {
        eventName: "oc.orchestrator.creation_rate_read_failed",
        severity: "warning",
        message: `creation_rate_read_failed: mode=fail_open cap=${cap} account=${accountId} error=${readErrorMessage}`
      }
    };
  }

  const message = `creation_rate_read_failed: mode=fail_closed cap=${cap} account=${accountId} error=${readErrorMessage}`;
  return {
    allowed: false,
    accountId,
    enabled,
    window,
    cap,
    createdInWindow: 0,
    remaining: 0,
    reason: "creation_rate_read_failed_fail_closed",
    readErrorMessage,
    failure: {
      code: "creation_rate_read_failed",
      step: CREATION_RATE_STEP,
      skill: CREATION_RATE_SKILL,
      message
    },
    audit: {
      eventName: "oc.orchestrator.creation_rate_read_failed",
      severity: "error",
      message
    }
  };
}

export function ensureCreationBudgetReadError(
  input: EvaluateCreationReadErrorInput
): CreationBudgetDecision {
  const decision = evaluateCreationBudgetReadError(input);

  if (!decision.allowed) {
    throw new CreationRateGovernorError(decision);
  }

  return decision;
}

export function evaluateAccountSelection(
  input: SelectAccountForCreationInput
): CreationAccountSelectionDecision {
  const candidates = buildSelectionCandidates(input);

  if (candidates.length === 0) {
    return {
      selectedAccountId: null,
      reason: "no_accounts",
      candidates
    };
  }

  const eligible = candidates
    .filter((candidate) => candidate.enabled)
    .filter((candidate) => candidate.healthy)
    .filter((candidate) => candidate.budgetAllowed)
    .sort(compareSelectionCandidates);

  if (eligible.length > 0) {
    return {
      selectedAccountId: eligible[0].accountId,
      reason: "selected",
      candidates
    };
  }

  const healthyAccounts = candidates.filter((candidate) => candidate.enabled && candidate.healthy);
  const allHealthyAccountsExhausted = healthyAccounts.length > 0
    && healthyAccounts.every((candidate) => candidate.budgetKnown && !candidate.budgetAllowed);

  return {
    selectedAccountId: null,
    reason: allHealthyAccountsExhausted ? "creation_rate_exceeded_all_accounts" : "no_eligible_accounts",
    candidates
  };
}

export function selectAccountForCreation(input: SelectAccountForCreationInput): string {
  const decision = evaluateAccountSelection(input);

  if (!decision.selectedAccountId) {
    throw new CreationAccountSelectionError(decision);
  }

  return decision.selectedAccountId;
}

function buildSelectionCandidates(input: SelectAccountForCreationInput): CreationAccountSelectionCandidate[] {
  const stateByAccountId = new Map(
    input.governorState.map((state) => [normalizeAccountId(state.accountId), state])
  );

  return input.accounts.map((account) => {
    const accountId = normalizeAccountId(account.accountId);
    const state = stateByAccountId.get(accountId);
    const cap = state ? normalizeCap(state.cap) : 0;
    const createdInWindow = state ? Math.max(0, state.createdInWindow) : 0;
    const remaining = Math.max(cap - createdInWindow, 0);

    return {
      accountId,
      enabled: account.enabled ?? true,
      healthy: account.healthy,
      budgetKnown: state !== undefined,
      budgetAllowed: state?.allowed ?? false,
      createdInWindow,
      cap,
      remaining
    };
  });
}

function compareSelectionCandidates(
  left: CreationAccountSelectionCandidate,
  right: CreationAccountSelectionCandidate
): number {
  const budgetRank = right.remaining - left.remaining;

  if (budgetRank !== 0) {
    return budgetRank;
  }

  return left.accountId.localeCompare(right.accountId);
}

function exceededMessage(createdInWindow: number, cap: number, accountId: string): string {
  return `creation_rate_exceeded: created_24h=${createdInWindow} cap=${cap} account=${accountId}`;
}

function parseCreationDateMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validDateMs(value: Date, field: string): number {
  const ms = value.getTime();

  if (!Number.isFinite(ms)) {
    throw new Error(`${field} must be a valid Date.`);
  }

  return ms;
}

function normalizeAccountId(accountId: string | undefined): string {
  return accountId?.trim() || DEFAULT_CREATION_ACCOUNT_ID;
}

function normalizeCap(cap: number | undefined): number {
  const resolved = cap ?? DEFAULT_CREATION_MAX_PER_DAY;

  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error("Creation cap must be a non-negative integer.");
  }

  return resolved;
}

function normalizeWindow(window: CreationRateWindow | undefined): CreationRateWindow {
  return window ?? "rolling_24h";
}

function bogotaDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "inventory_read_failed";
}

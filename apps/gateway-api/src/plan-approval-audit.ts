import { createHash } from "node:crypto";
import type { AuditEvent } from "../../../packages/domain/src/index.ts";
import { stableStringify } from "../../../packages/storage/src/stable-stringify.ts";
import type { PlanApprovalRecord, PlanApprovalScope } from "./routes/proposals-sign.ts";

export function findSignedPlanApprovalInAuditEvents(input: {
  events: AuditEvent[];
  runId: string;
  params: {
    domain?: unknown;
    provider?: unknown;
    budgetUsdMax?: unknown;
    testEmailRecipient?: unknown;
  };
  now: Date;
}): PlanApprovalRecord | null {
  for (const event of input.events.toReversed()) {
    const restored = planApprovalFromAuditEvent(event, input.now);
    if (!restored || restored.scope.runId !== input.runId) continue;
    if (!planApprovalMatchesParams(restored, input.params)) continue;
    return restored;
  }
  return null;
}

function planApprovalFromAuditEvent(event: AuditEvent, now: Date): PlanApprovalRecord | null {
  if (event.action !== "oc.plan.signed") return null;
  if (event.targetType !== "openclaw_orchestrator_run") return null;
  if (event.decision !== "allow" || event.humanApproved !== true) return null;

  const metadata = event.metadata;
  const signatureId = stringValue(metadata.signatureId);
  const scopeHash = stringValue(metadata.scopeHash);
  const expiresAt = stringValue(metadata.expiresAt);
  const scope = parsePlanApprovalScope(metadata.scope);
  if (!signatureId || !scopeHash || !expiresAt || !scope) return null;
  if (Date.parse(expiresAt) <= now.getTime()) return null;
  if (event.targetId !== scope.runId) return null;
  if (hashPlanApprovalScope(scope) !== scopeHash) return null;

  return {
    status: "signed",
    signedAt: event.occurredAt,
    expiresAt,
    signatureId,
    scopeHash,
    scope,
    flagEnabled: true
  };
}

function planApprovalMatchesParams(
  planApproval: PlanApprovalRecord,
  params: {
    domain?: unknown;
    provider?: unknown;
    budgetUsdMax?: unknown;
    testEmailRecipient?: unknown;
  }
): boolean {
  if (typeof params.domain === "string" && normalizeDomain(params.domain) !== planApproval.scope.domain) return false;
  if (typeof params.provider === "string" && params.provider.trim().toLowerCase() !== planApproval.scope.provider) return false;
  if (typeof params.budgetUsdMax === "number" && params.budgetUsdMax !== planApproval.scope.budgetUsdMax) return false;
  if (
    typeof params.testEmailRecipient === "string" &&
    params.testEmailRecipient.trim().toLowerCase() !== planApproval.scope.recipient
  ) return false;
  return true;
}

function parsePlanApprovalScope(value: unknown): PlanApprovalScope | null {
  if (!isRecord(value)) return null;
  const runId = stringValue(value.runId);
  const domain = normalizeDomain(stringValue(value.domain) ?? "");
  const provider = stringValue(value.provider)?.trim().toLowerCase();
  const requireExistingDomain = value.requireExistingDomain;
  const budgetUsdMax = value.budgetUsdMax;
  const recipient = stringValue(value.recipient)?.trim().toLowerCase();
  const plannedSkill = value.plannedSkill;
  const plannedSteps = value.plannedSteps;

  if (!runId || !domain || !provider || !recipient) return null;
  if (requireExistingDomain !== undefined && typeof requireExistingDomain !== "boolean") return null;
  if (!Number.isInteger(budgetUsdMax) || Number(budgetUsdMax) < 1 || Number(budgetUsdMax) > 10_000) return null;
  if (plannedSkill !== "configure_complete_smtp") return null;
  if (!Array.isArray(plannedSteps) || !plannedSteps.every((step) => typeof step === "string" && step.trim())) return null;

  return {
    runId,
    domain,
    provider,
    ...(requireExistingDomain === true ? { requireExistingDomain: true } : {}),
    budgetUsdMax: Number(budgetUsdMax),
    recipient,
    plannedSkill,
    plannedSteps: [...plannedSteps]
  };
}

function hashPlanApprovalScope(scope: PlanApprovalScope): string {
  return createHash("sha256").update(stableStringify(scope)).digest("hex");
}

function normalizeDomain(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

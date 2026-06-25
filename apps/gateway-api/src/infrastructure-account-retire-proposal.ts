import { randomUUID } from "node:crypto";
import type { InfrastructureAccountLifecycleRecord } from "../../../packages/local-store/src/index.ts";

export interface InfrastructureAccountRetireProposal {
  id: string;
  category: string;
  severity: "high";
  headline: string;
  body: string;
  evidenceRefs: string[];
  runbookRef: string;
  targetRef: string;
  targetType: "infrastructure_account";
  skillSlug: "retire_infrastructure_account";
  params: {
    providerId: "webdock";
    accountId: string;
    accountLabel: string;
    reason: string;
  };
  delivrix_actions_required: ["retire_infrastructure_account"];
}

export function isSustainedUnauthorizedWebdockRetireCandidate(
  record: InfrastructureAccountLifecycleRecord,
  threshold: number
): boolean {
  return record.providerId === "webdock" &&
    record.healthStatus === "unauthorized" &&
    record.lifecycleStatus !== "retired" &&
    record.lifecycleStatus !== "disabled" &&
    (record.consecutiveFailures ?? 0) >= threshold;
}

export function buildInfrastructureAccountRetireProposal(input: {
  record: InfrastructureAccountLifecycleRecord;
  threshold: number;
  observedAt: Date;
  id?: string;
}): InfrastructureAccountRetireProposal {
  const failureCount = input.record.consecutiveFailures ?? 0;
  const firstUnhealthyAt = input.record.firstUnhealthyAt ?? input.record.lastSeenAt ?? input.observedAt.toISOString();
  return {
    id: input.id ?? randomUUID(),
    category: "retire_infrastructure_account",
    severity: "high",
    headline: `Proponer baja de cuenta Webdock ${input.record.accountId}`,
    body:
      `Unauthorized sostenido durante ${failureCount} polls desde ${firstUnhealthyAt}. ` +
      "Propuesta gated; no ejecuta sin firma humana.",
    evidenceRefs: [
      `infrastructure-account-health:${input.observedAt.toISOString()}`,
      `webdock:${input.record.accountId}:unauthorized:${failureCount}`
    ],
    runbookRef: "retire_infrastructure_account",
    targetRef: `${input.record.providerId}:${input.record.accountId}`,
    targetType: "infrastructure_account",
    skillSlug: "retire_infrastructure_account",
    params: {
      providerId: "webdock",
      accountId: input.record.accountId,
      accountLabel: input.record.accountLabel,
      reason:
        `Unauthorized sostenido durante ${failureCount} polls; ` +
        "soft-retire local-only propuesto por healthcheck live."
    },
    delivrix_actions_required: ["retire_infrastructure_account"]
  };
}

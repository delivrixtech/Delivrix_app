import type { AuditEvent } from "./audit-log.ts";
import type { RateLimitCounter } from "./rate-limit.ts";
import type {
  SendJob,
  SendJobStatus,
  SendResult,
  SendResultStatus,
  SenderNode,
  SenderNodeStatus
} from "./types.ts";

export interface CountByKey {
  key: string;
  count: number;
}

export interface OperationalSummary {
  generatedAt: string;
  totals: {
    jobs: number;
    auditEvents: number;
    senderNodes: number;
    sendResults: number;
  };
  jobsByStatus: Record<SendJobStatus, number>;
  sendResultsByStatus: Record<SendResultStatus, number>;
  senderNodesByStatus: Record<SenderNodeStatus, number>;
  jobsByCampaign: CountByKey[];
  sendResultsByCampaign: CountByKey[];
  jobsBySenderNode: CountByKey[];
  sendResultsBySenderNode: CountByKey[];
  jobsBySenderDomain: CountByKey[];
  jobsByRecipientDomain: CountByKey[];
  auditActions: CountByKey[];
  rateLimitCounters: RateLimitCounter[];
}

export interface OperationalSummaryInput {
  jobs: SendJob[];
  sendResults: SendResult[];
  auditEvents: AuditEvent[];
  senderNodes: SenderNode[];
  rateLimitCounters: RateLimitCounter[];
  now?: Date;
}

const sendJobStatuses: SendJobStatus[] = ["queued", "processing", "completed", "failed", "blocked"];
const sendResultStatuses: SendResultStatus[] = ["sent", "bounce", "complaint", "deferred", "failed"];
const senderNodeStatuses: SenderNodeStatus[] = [
  "active",
  "warming",
  "paused",
  "quarantined",
  "degraded",
  "retired_pending_approval"
];

export function buildOperationalSummary(input: OperationalSummaryInput): OperationalSummary {
  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    totals: {
      jobs: input.jobs.length,
      auditEvents: input.auditEvents.length,
      senderNodes: input.senderNodes.length,
      sendResults: input.sendResults.length
    },
    jobsByStatus: countJobsByStatus(input.jobs),
    sendResultsByStatus: countSendResultsByStatus(input.sendResults),
    senderNodesByStatus: countSenderNodesByStatus(input.senderNodes),
    jobsByCampaign: countBy(input.jobs, (job) => job.request.campaignId),
    sendResultsByCampaign: countSendResultsByCampaign(input.sendResults, input.jobs),
    jobsBySenderNode: countBy(input.jobs, (job) => job.senderNodeId ?? "unassigned"),
    sendResultsBySenderNode: countBy(input.sendResults, (result) => result.senderNodeId ?? "unassigned"),
    jobsBySenderDomain: countBy(input.jobs, (job) => job.request.sender.domain.toLowerCase()),
    jobsByRecipientDomain: countBy(input.jobs, (job) => emailDomainOrUnknown(job.request.recipient.email)),
    auditActions: countBy(input.auditEvents, (event) => event.action),
    rateLimitCounters: [...input.rateLimitCounters]
  };
}

function countJobsByStatus(jobs: SendJob[]): Record<SendJobStatus, number> {
  const counts = zeroRecord(sendJobStatuses);

  for (const job of jobs) {
    counts[job.status] += 1;
  }

  return counts;
}

function countSenderNodesByStatus(nodes: SenderNode[]): Record<SenderNodeStatus, number> {
  const counts = zeroRecord(senderNodeStatuses);

  for (const node of nodes) {
    counts[node.status] += 1;
  }

  return counts;
}

function countSendResultsByStatus(results: SendResult[]): Record<SendResultStatus, number> {
  const counts = zeroRecord(sendResultStatuses);

  for (const result of results) {
    counts[result.status] += 1;
  }

  return counts;
}

function countSendResultsByCampaign(results: SendResult[], jobs: SendJob[]): CountByKey[] {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  return countBy(results, (result) => jobsById.get(result.sendJobId)?.request.campaignId ?? "unknown");
}

function countBy<T>(items: T[], keyFor: (item: T) => string): CountByKey[] {
  const counts = new Map<string, number>();

  for (const item of items) {
    const key = keyFor(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function zeroRecord<T extends string>(keys: T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function emailDomainOrUnknown(email: string): string {
  const parts = email.trim().toLowerCase().split("@");
  return parts.length === 2 && parts[1] ? parts[1] : "unknown";
}

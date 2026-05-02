import type { AuditEvent } from "./audit-log.ts";
import type { SendJob, SendRequest, SenderNode } from "./types.ts";
import type { SuppressionEntry } from "./suppression-list.ts";

export interface AuditEventRepository {
  append(event: Omit<AuditEvent, "id" | "occurredAt">): Promise<AuditEvent>;
  listRecent(limit: number): Promise<AuditEvent[]>;
}

export interface SuppressionEntryRepository {
  findByEmail(email: string): Promise<SuppressionEntry | null>;
  create(entry: Omit<SuppressionEntry, "createdAt">): Promise<SuppressionEntry>;
}

export interface SendJobRepository {
  createQueued(request: SendRequest, policyDecision: Record<string, unknown>): Promise<SendJob>;
  listByStatus(status: SendJob["status"], limit: number): Promise<SendJob[]>;
  markProcessing(jobId: string, senderNodeId: string): Promise<void>;
  markBlocked(jobId: string, reason: string): Promise<void>;
  markFailed(jobId: string, reason: string): Promise<void>;
  markCompleted(jobId: string): Promise<void>;
}

export interface SenderNodeRepository {
  findAvailableForRequest(request: SendRequest): Promise<SenderNode | null>;
  listByStatus(status: SenderNode["status"], limit: number): Promise<SenderNode[]>;
  pause(senderNodeId: string, reason: string): Promise<void>;
}

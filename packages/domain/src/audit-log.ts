import { createId } from "./ids.ts";

export type AuditActorType = "system" | "operator" | "openclaw" | "collector";
export type AuditRiskLevel = "low" | "medium" | "high" | "critical";
export type AuditDecision = "allow" | "reject" | "n/a";
export type AuditKillSwitchState = "armed" | "active" | "unknown";

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorType: AuditActorType;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  riskLevel: AuditRiskLevel;
  metadata: Record<string, unknown>;
  decision?: AuditDecision;
  rejectReason?: string | null;
  humanApproved?: boolean;
  approverIds?: string[];
  killSwitchState?: AuditKillSwitchState;
  rollbackToken?: string | null;
  schemaVersion?: "2026-05-18.v1";
  promptVersion?: string | null;
  modelVersion?: string | null;
  evidenceRefs?: string[];
  prevHash?: string;
  hash?: string;
}

export interface AuditLog {
  append(event: AuditEventInput): Promise<AuditEvent>;
  list(): Promise<AuditEvent[]>;
}

export type AuditEventInput = Partial<Pick<
  AuditEvent,
  | "id"
  | "occurredAt"
  | "decision"
  | "rejectReason"
  | "humanApproved"
  | "approverIds"
  | "killSwitchState"
  | "rollbackToken"
  | "schemaVersion"
  | "promptVersion"
  | "modelVersion"
  | "evidenceRefs"
  | "prevHash"
  | "hash"
>> & Omit<AuditEvent, "id" | "occurredAt" | "decision" | "rejectReason" | "humanApproved" | "approverIds" | "killSwitchState" | "rollbackToken" | "schemaVersion" | "promptVersion" | "modelVersion" | "evidenceRefs" | "prevHash" | "hash">;

export class InMemoryAuditLog implements AuditLog {
  private readonly events: AuditEvent[] = [];

  async append(event: AuditEventInput): Promise<AuditEvent> {
    const auditEvent: AuditEvent = {
      ...event,
      id: createId("audit"),
      occurredAt: new Date().toISOString(),
      decision: event.decision ?? "allow",
      rejectReason: event.rejectReason ?? null,
      humanApproved: event.humanApproved ?? false,
      approverIds: event.approverIds ?? [],
      killSwitchState: event.killSwitchState ?? "unknown",
      rollbackToken: event.rollbackToken ?? null,
      schemaVersion: event.schemaVersion ?? "2026-05-18.v1",
      promptVersion: event.promptVersion ?? null,
      modelVersion: event.modelVersion ?? null,
      evidenceRefs: event.evidenceRefs ?? [],
      prevHash: event.prevHash ?? "GENESIS",
      hash: event.hash ?? "unhashed"
    };

    this.events.push(Object.freeze(auditEvent));
    return auditEvent;
  }

  async list(): Promise<AuditEvent[]> {
    return [...this.events];
  }
}

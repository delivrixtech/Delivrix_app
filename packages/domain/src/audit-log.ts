import { createId } from "./ids.ts";

export type AuditActorType = "system" | "operator" | "openclaw";
export type AuditRiskLevel = "low" | "medium" | "high" | "critical";

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
}

export interface AuditLog {
  append(event: Omit<AuditEvent, "id" | "occurredAt">): Promise<AuditEvent>;
  list(): Promise<AuditEvent[]>;
}

export class InMemoryAuditLog implements AuditLog {
  private readonly events: AuditEvent[] = [];

  async append(event: Omit<AuditEvent, "id" | "occurredAt">): Promise<AuditEvent> {
    const auditEvent: AuditEvent = {
      ...event,
      id: createId("audit"),
      occurredAt: new Date().toISOString()
    };

    this.events.push(Object.freeze(auditEvent));
    return auditEvent;
  }

  async list(): Promise<AuditEvent[]> {
    return [...this.events];
  }
}

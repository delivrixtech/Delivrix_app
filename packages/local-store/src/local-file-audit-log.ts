import {
  createId,
  type AuditEvent,
  type AuditLog
} from "../../domain/src/index.ts";
import { JsonFileStore } from "./json-file-store.ts";

export class LocalFileAuditLog implements AuditLog {
  private readonly store: JsonFileStore<AuditEvent[]>;

  constructor(filePath = process.env.LOCAL_AUDIT_LOG_FILE ?? "runtime/audit-events.json") {
    this.store = new JsonFileStore<AuditEvent[]>(filePath);
  }

  async append(event: Omit<AuditEvent, "id" | "occurredAt">): Promise<AuditEvent> {
    const events = await this.store.read([]);
    const auditEvent: AuditEvent = {
      ...event,
      id: createId("audit"),
      occurredAt: new Date().toISOString()
    };

    events.push(auditEvent);
    await this.store.write(events);
    return auditEvent;
  }

  async list(): Promise<AuditEvent[]> {
    return this.store.read([]);
  }
}

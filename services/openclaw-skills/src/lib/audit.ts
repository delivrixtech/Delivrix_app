import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface AuditEventInput {
  actorType: "openclaw" | "operator" | "system";
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  metadata: Record<string, unknown>;
  evidenceRefs?: string[];
}

const auditPath = process.env.OPENCLAW_SKILLS_AUDIT_FILE ?? "/data/.openclaw/kb/audit/openclaw-skills.jsonl";

export const auditLog = {
  async append(input: AuditEventInput): Promise<void> {
    await mkdir(dirname(auditPath), { recursive: true });
    const event = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      schemaVersion: "2026-05-18.v1",
      ...input,
      evidenceRefs: input.evidenceRefs ?? []
    };
    await appendFile(auditPath, `${JSON.stringify(event)}\n`, "utf8");
  }
};

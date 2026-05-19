import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const sqlitePath = process.env.OPENCLAW_AUDIT_BUFFER_SQLITE ?? "/var/openclaw/audit-buffer.sqlite";
const gatewayBase = process.env.DELIVRIX_GATEWAY_URL ?? "http://host.docker.internal:3000";
const hmacSecret = process.env.OPENCLAW_HMAC_SECRET ?? "";
const flushIntervalMs = 10_000;
const flushThreshold = 50;
const retentionDays = 7;

mkdirSync(dirname(sqlitePath), { recursive: true });
const db = new DatabaseSync(sqlitePath);
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_audit (
    id TEXT PRIMARY KEY,
    event_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    retries INTEGER DEFAULT 0,
    next_retry_at TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pending_audit_created ON pending_audit(created_at);
`);

export function enqueueAuditEvent(event: Record<string, unknown>): void {
  const id = typeof event.id === "string" ? event.id : randomUUID();
  db.prepare(`
    INSERT OR IGNORE INTO pending_audit (id, event_json, created_at)
    VALUES (?, ?, ?)
  `).run(id, JSON.stringify({ ...event, id }), new Date().toISOString());

  const count = db.prepare("SELECT COUNT(*) AS count FROM pending_audit").get() as { count: number };
  if (count.count >= flushThreshold) {
    void flushAuditBuffer();
  }
}

export async function flushAuditBuffer(): Promise<void> {
  if (!hmacSecret) {
    return;
  }

  const rows = db.prepare(`
    SELECT id, event_json, retries
    FROM pending_audit
    WHERE next_retry_at IS NULL OR next_retry_at <= ?
    ORDER BY created_at ASC
    LIMIT 50
  `).all(new Date().toISOString()) as Array<{ id: string; event_json: string; retries: number }>;

  if (rows.length === 0) {
    return;
  }

  const events = rows.map((row) => JSON.parse(row.event_json));
  const raw = JSON.stringify({ batchId: randomUUID(), events });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", hmacSecret).update(`${timestamp}.${raw}`).digest("hex");

  try {
    const response = await fetch(`${gatewayBase}/v1/agent/audit/batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openclaw-signature": signature,
        "x-openclaw-timestamp": timestamp
      },
      body: raw
    });

    if (response.status === 200) {
      const body = await response.json() as {
        accepted: string[];
        rejected: Array<{ id: string; reason: string }>;
      };
      deleteRows([...body.accepted, ...body.rejected.map((item) => item.id)]);
      return;
    }

    if (response.status >= 500) {
      retryRows(rows);
      return;
    }

    deleteRows(rows.map((row) => row.id));
  } catch {
    retryRows(rows);
  }
}

export function startAuditBuffer(): NodeJS.Timeout {
  return setInterval(() => {
    void flushAuditBuffer();
    warnIfRetentionExceeded();
  }, flushIntervalMs);
}

function deleteRows(ids: string[]): void {
  const statement = db.prepare("DELETE FROM pending_audit WHERE id = ?");
  for (const id of ids) {
    statement.run(id);
  }
}

function retryRows(rows: Array<{ id: string; retries: number }>): void {
  const statement = db.prepare("UPDATE pending_audit SET retries = retries + 1, next_retry_at = ? WHERE id = ?");
  for (const row of rows) {
    const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(row.retries, 6));
    statement.run(new Date(Date.now() + delayMs).toISOString(), row.id);
  }
}

function warnIfRetentionExceeded(): void {
  const oldest = db.prepare("SELECT created_at AS createdAt FROM pending_audit ORDER BY created_at ASC LIMIT 1").get() as { createdAt: string } | undefined;
  if (!oldest) {
    return;
  }
  const ageDays = (Date.now() - Date.parse(oldest.createdAt)) / (1000 * 60 * 60 * 24);
  if (ageDays > retentionDays) {
    console.error("[CRITICAL] Audit buffer > 7d sin flush. Entrar modo read-only.");
  }
}

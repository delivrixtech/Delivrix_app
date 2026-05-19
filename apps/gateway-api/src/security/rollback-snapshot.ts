import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PersistRollbackSnapshotInput, RollbackSnapshot } from "../../../../packages/domain/src/index.ts";

const rollbackTtlMs = 7 * 24 * 60 * 60 * 1000;
const sqlitePath = process.env.GATEWAY_SQLITE_FILE ?? "runtime/gateway.sqlite";
const db = openRollbackDatabase(sqlitePath);

export interface PersistedRollbackSnapshot {
  rollbackToken: string;
  expiresAt: string;
}

interface RollbackSnapshotRow {
  rollbackToken: string;
  runbookId: string;
  targetType: string;
  targetId: string;
  prevStateJson: string;
  createdAt: string;
  expiresAt: string;
  status: "available" | "consumed" | "expired";
}

export function persistRollbackSnapshot(
  params: PersistRollbackSnapshotInput,
  now = new Date()
): PersistedRollbackSnapshot {
  const rollbackToken = randomUUID();
  const expiresAt = new Date(now.getTime() + rollbackTtlMs).toISOString();

  db.prepare(`
    INSERT INTO rollback_snapshots (
      rollback_token,
      runbook_id,
      target_type,
      target_id,
      prev_state_json,
      created_at,
      expires_at,
      status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'available')
  `).run(
    rollbackToken,
    params.runbookId,
    params.targetType,
    params.targetId,
    params.prevStateJson,
    now.toISOString(),
    expiresAt
  );

  return { rollbackToken, expiresAt };
}

export function getRollbackSnapshot(rollbackToken: string, now = new Date()): RollbackSnapshot | null {
  expireRollbackSnapshots(now);
  const row = db.prepare(`
    SELECT
      rollback_token AS rollbackToken,
      runbook_id AS runbookId,
      target_type AS targetType,
      target_id AS targetId,
      prev_state_json AS prevStateJson,
      created_at AS createdAt,
      expires_at AS expiresAt,
      status
    FROM rollback_snapshots
    WHERE rollback_token = ?
  `).get(rollbackToken) as RollbackSnapshotRow | undefined;

  return row ? toRollbackSnapshot(row) : null;
}

export function consumeRollbackSnapshot(rollbackToken: string): boolean {
  const result = db.prepare(`
    UPDATE rollback_snapshots
    SET status = 'consumed'
    WHERE rollback_token = ? AND status = 'available'
  `).run(rollbackToken);

  return result.changes === 1;
}

export function expireRollbackSnapshots(now = new Date()): number {
  const result = db.prepare(`
    UPDATE rollback_snapshots
    SET status = 'expired'
    WHERE status = 'available' AND expires_at < ?
  `).run(now.toISOString());

  return result.changes;
}

export function listRollbackSnapshots(): RollbackSnapshot[] {
  const rows = db.prepare(`
    SELECT
      rollback_token AS rollbackToken,
      runbook_id AS runbookId,
      target_type AS targetType,
      target_id AS targetId,
      prev_state_json AS prevStateJson,
      created_at AS createdAt,
      expires_at AS expiresAt,
      status
    FROM rollback_snapshots
    ORDER BY created_at ASC
  `).all() as RollbackSnapshotRow[];

  return rows.map(toRollbackSnapshot);
}

function openRollbackDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  const migration = readFileSync(
    new URL("../../migrations/0008_rollback_snapshots.sql", import.meta.url),
    "utf8"
  );
  database.exec(migration);
  return database;
}

function toRollbackSnapshot(row: RollbackSnapshotRow): RollbackSnapshot {
  return {
    rollbackToken: row.rollbackToken,
    runbookId: row.runbookId as RollbackSnapshot["runbookId"],
    targetType: row.targetType as RollbackSnapshot["targetType"],
    targetId: row.targetId,
    prevStateJson: row.prevStateJson,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    status: row.status
  };
}

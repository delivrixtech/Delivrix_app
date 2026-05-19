CREATE TABLE IF NOT EXISTS rollback_snapshots (
  rollback_token TEXT PRIMARY KEY,
  runbook_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  prev_state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available','consumed','expired'))
);

CREATE INDEX IF NOT EXISTS idx_rollback_snapshots_expires
  ON rollback_snapshots(expires_at);

CREATE INDEX IF NOT EXISTS idx_rollback_snapshots_target
  ON rollback_snapshots(target_type, target_id);

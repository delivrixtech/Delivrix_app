CREATE TABLE IF NOT EXISTS approval_nonces (
  nonce TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued','consumed','expired')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_nonces_expires
  ON approval_nonces(expires_at);

CREATE INDEX IF NOT EXISTS idx_approval_nonces_action_target
  ON approval_nonces(action_id, target_type, target_id);

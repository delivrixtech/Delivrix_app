-- Local runtime state tables used by demo/dev operations.

SET search_path TO delivrix, public;

CREATE TABLE IF NOT EXISTS canvas_live_snapshots (
  id TEXT PRIMARY KEY,
  snapshot JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'gateway-api',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS iam_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'local',
  location TEXT NOT NULL DEFAULT 'localhost',
  risk TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (actor_id, role_id, transport)
);

CREATE TABLE IF NOT EXISTS kill_switch_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL CHECK (state IN ('armed', 'activated', 'deactivated')),
  reason TEXT,
  actor_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS physical_servers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  location TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('onboarded', 'planned', 'offline', 'ready')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual-sender', 'proxmox-sender', 'webdock-sender')),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'warming', 'active', 'paused', 'blocked')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cluster_nodes (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL REFERENCES clusters(id),
  label TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'sender-node',
  status TEXT NOT NULL CHECK (status IN ('planned', 'warming', 'active', 'paused', 'blocked')),
  daily_limit INTEGER NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  cap_usd NUMERIC(12, 2) NOT NULL CHECK (cap_usd >= 0),
  balance_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  amount_usd NUMERIC(12, 2) NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  reason TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_canvas_live_snapshots_updated_at ON canvas_live_snapshots (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_iam_sessions_actor ON iam_sessions (actor_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_kill_switch_events_occurred_at ON kill_switch_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_clusters_kind ON clusters (kind, status);
CREATE INDEX IF NOT EXISTS idx_cluster_nodes_cluster ON cluster_nodes (cluster_id, status);

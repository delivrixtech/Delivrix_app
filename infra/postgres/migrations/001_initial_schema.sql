-- Delivrix MailOps initial schema.
-- Phase 1 focus: compliance gates, sender registry, queue tracking and append-only audit.

BEGIN;

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('commercial', 'transactional', 'operational')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  physical_address TEXT,
  unsubscribe_url TEXT,
  created_by TEXT REFERENCES operators(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recipients (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE consent_proofs (
  id TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  campaign_id TEXT REFERENCES campaigns(id),
  source TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE suppression_entries (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'complaint', 'hard_bounce', 'manual', 'legal')),
  source TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email)
);

CREATE TABLE ip_addresses (
  id TEXT PRIMARY KEY,
  address INET NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('ip_leasing', 'arin', 'webdock', 'racknerd', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('available', 'assigned', 'warming', 'quarantined', 'retired')),
  reputation_status TEXT NOT NULL CHECK (reputation_status IN ('unknown', 'healthy', 'warning', 'critical')),
  last_checked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sender_nodes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('webdock', 'proxmox', 'racknerd', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('active', 'warming', 'paused', 'quarantined', 'degraded', 'retired_pending_approval')),
  ip_address_id TEXT REFERENCES ip_addresses(id),
  hostname TEXT,
  daily_limit INTEGER NOT NULL CHECK (daily_limit >= 0),
  warmup_day INTEGER NOT NULL DEFAULT 0 CHECK (warmup_day >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE send_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  recipient_email TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('commercial', 'transactional', 'operational')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'blocked')),
  policy_decision JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_payload JSONB NOT NULL,
  sender_node_id TEXT REFERENCES sender_nodes(id),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failure_reason TEXT
);

CREATE TABLE send_results (
  id TEXT PRIMARY KEY,
  send_job_id TEXT NOT NULL REFERENCES send_jobs(id),
  status TEXT NOT NULL CHECK (status IN ('sent', 'bounce', 'complaint', 'deferred', 'failed')),
  smtp_response TEXT,
  bounce_code TEXT,
  complaint_source TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'operator', 'openclaw')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_suppression_entries_email ON suppression_entries (email);
CREATE INDEX idx_send_jobs_status ON send_jobs (status);
CREATE INDEX idx_send_jobs_campaign_id ON send_jobs (campaign_id);
CREATE INDEX idx_sender_nodes_status ON sender_nodes (status);
CREATE INDEX idx_ip_addresses_status ON ip_addresses (status);
CREATE INDEX idx_audit_events_occurred_at ON audit_events (occurred_at);
CREATE INDEX idx_audit_events_target ON audit_events (target_type, target_id);

CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

COMMIT;

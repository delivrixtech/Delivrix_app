SET search_path TO delivrix, public;

CREATE TABLE IF NOT EXISTS openclaw_episodic_scratch (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id       VARCHAR(64) NOT NULL,
  step            INTEGER NOT NULL CHECK (step > 0),
  tool            VARCHAR(128) NOT NULL,
  input_hash      VARCHAR(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{8,64}$'),
  outcome         VARCHAR(32) NOT NULL,
  outcome_data    JSONB,
  error_class     VARCHAR(128),
  error_message   TEXT,
  source          VARCHAR(32) NOT NULL,
  trust_score     SMALLINT NOT NULL DEFAULT 50,
  ttl_expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata        JSONB DEFAULT '{}'::jsonb,

  CONSTRAINT chk_openclaw_episodic_outcome CHECK (outcome IN (
    'success', 'failed', 'rolled_back', 'rollback_failed',
    'cancelled_by_operator', 'timeout', 'partial'
  )),
  CONSTRAINT chk_openclaw_episodic_source CHECK (source IN (
    'openclaw', 'operator', 'tool_output'
  )),
  CONSTRAINT chk_openclaw_episodic_trust CHECK (trust_score BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_scratch_intent
  ON openclaw_episodic_scratch (intent_id, step);
CREATE INDEX IF NOT EXISTS idx_scratch_ttl
  ON openclaw_episodic_scratch (ttl_expires_at);
CREATE INDEX IF NOT EXISTS idx_scratch_tool_outcome
  ON openclaw_episodic_scratch (tool, outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scratch_input_hash
  ON openclaw_episodic_scratch (input_hash);

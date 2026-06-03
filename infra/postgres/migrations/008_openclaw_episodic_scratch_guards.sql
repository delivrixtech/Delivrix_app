SET search_path TO delivrix, public;

ALTER TABLE openclaw_episodic_scratch
  ADD COLUMN IF NOT EXISTS plane VARCHAR(32) NOT NULL DEFAULT 'observation',
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reliability DOUBLE PRECISION NOT NULL DEFAULT 0.35,
  ADD COLUMN IF NOT EXISTS valid_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS invalid_at TIMESTAMP WITH TIME ZONE;

UPDATE openclaw_episodic_scratch
SET
  plane = CASE
    WHEN source IN ('operator', 'tool_output') THEN 'verified_fact'
    ELSE 'observation'
  END,
  provenance = CASE
    WHEN source = 'operator' THEN jsonb_build_object(
      'kind', 'operator_signature',
      'signatureId', COALESCE(metadata->>'operatorSignatureId', metadata->>'signatureId', 'legacy-operator')
    )
    WHEN source = 'tool_output' THEN jsonb_build_object(
      'kind', 'tool_evidence',
      'toolUseId', COALESCE(metadata->>'toolUseId', metadata->>'toolCallId', metadata->>'proposalId', metadata->>'auditEventId', 'legacy-tool-output')
    )
    ELSE COALESCE(provenance, '{}'::jsonb)
  END,
  reliability = CASE
    WHEN source = 'operator' THEN 0.95
    WHEN source = 'tool_output' THEN 0.70
    ELSE 0.35
  END,
  valid_at = COALESCE(valid_at, created_at, NOW())
WHERE provenance = '{}'::jsonb
   OR plane = 'observation'
   OR reliability = 0.35;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_openclaw_episodic_plane'
  ) THEN
    ALTER TABLE openclaw_episodic_scratch
      ADD CONSTRAINT chk_openclaw_episodic_plane
      CHECK (plane IN ('observation', 'verified_fact'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_openclaw_episodic_reliability'
  ) THEN
    ALTER TABLE openclaw_episodic_scratch
      ADD CONSTRAINT chk_openclaw_episodic_reliability
      CHECK (reliability >= 0 AND reliability <= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_openclaw_episodic_validity_window'
  ) THEN
    ALTER TABLE openclaw_episodic_scratch
      ADD CONSTRAINT chk_openclaw_episodic_validity_window
      CHECK (invalid_at IS NULL OR invalid_at >= valid_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_openclaw_episodic_verified_provenance'
  ) THEN
    ALTER TABLE openclaw_episodic_scratch
      ADD CONSTRAINT chk_openclaw_episodic_verified_provenance
      CHECK (plane <> 'verified_fact' OR provenance <> '{}'::jsonb);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_scratch_verified_fact_active
  ON openclaw_episodic_scratch (tool, reliability DESC, valid_at DESC)
  WHERE plane = 'verified_fact' AND invalid_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_scratch_invalid_at
  ON openclaw_episodic_scratch (invalid_at)
  WHERE invalid_at IS NOT NULL;

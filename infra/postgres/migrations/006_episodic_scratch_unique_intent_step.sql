SET search_path TO delivrix, public;

CREATE TABLE IF NOT EXISTS openclaw_episodic_scratch_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_id UUID NOT NULL UNIQUE,
  intent_id VARCHAR(64) NOT NULL,
  step INTEGER NOT NULL CHECK (step > 0),
  quarantine_reason TEXT NOT NULL,
  duplicate_row JSONB NOT NULL,
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH ranked AS (
  SELECT
    id,
    intent_id,
    step,
    ROW_NUMBER() OVER (
      PARTITION BY intent_id, step
      ORDER BY trust_score DESC, created_at DESC, id DESC
    ) AS rank
  FROM openclaw_episodic_scratch
),
duplicates AS (
  SELECT id, intent_id, step
  FROM ranked
  WHERE rank > 1
)
INSERT INTO openclaw_episodic_scratch_quarantine (
  original_id,
  intent_id,
  step,
  quarantine_reason,
  duplicate_row
)
SELECT
  scratch.id,
  scratch.intent_id,
  scratch.step,
  'duplicate_intent_step_before_unique_constraint',
  to_jsonb(scratch)
FROM openclaw_episodic_scratch scratch
JOIN duplicates ON duplicates.id = scratch.id
ON CONFLICT (original_id) DO NOTHING;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY intent_id, step
      ORDER BY trust_score DESC, created_at DESC, id DESC
    ) AS rank
  FROM openclaw_episodic_scratch
)
DELETE FROM openclaw_episodic_scratch scratch
USING ranked
WHERE scratch.id = ranked.id
  AND ranked.rank > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_openclaw_episodic_scratch_intent_step'
      AND conrelid = 'openclaw_episodic_scratch'::regclass
  ) THEN
    ALTER TABLE openclaw_episodic_scratch
      ADD CONSTRAINT uq_openclaw_episodic_scratch_intent_step UNIQUE (intent_id, step);
  END IF;
END $$;

DROP INDEX IF EXISTS idx_scratch_intent;

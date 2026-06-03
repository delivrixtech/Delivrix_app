-- Pgvector-backed memory table for OpenClaw semantic memory experiments.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET search_path TO delivrix, public;

CREATE TABLE IF NOT EXISTS openclaw_memory_vectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared_family', 'shared_global', 'human_authored')),
  source_path TEXT,
  content TEXT NOT NULL CHECK (length(content) > 0),
  embedding vector(1024),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  audit_hash TEXT NOT NULL DEFAULT '',
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('spanish', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_openclaw_memory_vectors_embedding
  ON openclaw_memory_vectors
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_openclaw_memory_vectors_agent_type
  ON openclaw_memory_vectors (agent_id, memory_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_openclaw_memory_vectors_metadata
  ON openclaw_memory_vectors USING GIN (metadata);

CREATE INDEX IF NOT EXISTS idx_openclaw_memory_vectors_task
  ON openclaw_memory_vectors (task_id)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_openclaw_memory_vectors_fts
  ON openclaw_memory_vectors USING GIN (content_tsv);

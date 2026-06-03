-- migrate:no-transaction
-- Rebuild the pgvector embedding index with HNSW. IVFFlat needs representative
-- data before index creation; HNSW avoids the empty-table recall trap.

SET search_path TO delivrix, public;

DROP INDEX CONCURRENTLY IF EXISTS delivrix.idx_openclaw_memory_vectors_embedding;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_openclaw_memory_vectors_embedding
  ON openclaw_memory_vectors
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

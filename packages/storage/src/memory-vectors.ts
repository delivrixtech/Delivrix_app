// Storage helpers for OpenClaw semantic memory (`openclaw_memory_vectors`).
//
// Mirrors the conventions of `episodic-scratch.ts`: a thin Queryable pool,
// parameterized SQL with `RETURNING`, a typed validation error, and row→entry
// mapping. No external deps, NodeNext relative imports only.
//
// This module is storage-only and side-effect free: it does NOT compute
// embeddings (that is the embedding service's job) and does NOT touch the live
// agent loop. Callers pass an already-computed 1024-dim embedding, or omit it
// for full-text-only memories.

import { createHash } from "node:crypto";
import { stableStringify } from "./stable-stringify.ts";

export const MEMORY_EMBEDDING_DIMENSIONS = 1024;

export type MemoryVisibility =
  | "private"
  | "shared_family"
  | "shared_global"
  | "human_authored";

const VISIBILITIES: readonly MemoryVisibility[] = [
  "private",
  "shared_family",
  "shared_global",
  "human_authored"
];

/** Scopes an agent may read when no explicit list is provided. */
const DEFAULT_VISIBLE_SCOPES: readonly MemoryVisibility[] = [
  "shared_family",
  "shared_global",
  "human_authored"
];

export interface MemoryVectorQueryablePool {
  query(text: string, params?: unknown[]): Promise<{ rows: MemoryVectorDbRow[] }>;
}

export interface MemoryVectorInput {
  agentId: string;
  memoryType: string;
  content: string;
  visibility?: MemoryVisibility;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  sourcePath?: string;
  taskId?: string;
  auditHash?: string;
}

export interface MemoryVectorEntry {
  id: string;
  agentId: string;
  memoryType: string;
  visibility: MemoryVisibility;
  content: string;
  metadata: Record<string, unknown>;
  sourcePath?: string;
  taskId?: string;
  hasEmbedding: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Relevance score, present only on search results (0..1 cosine, or FTS rank). */
  score?: number;
}

export interface SemanticSearchInput {
  agentId: string;
  embedding: number[];
  limit?: number;
  memoryType?: string;
  visibilities?: MemoryVisibility[];
  minScore?: number;
}

export interface KeywordSearchInput {
  agentId: string;
  queryText: string;
  limit?: number;
  memoryType?: string;
  visibilities?: MemoryVisibility[];
}

export interface HybridSearchInput {
  agentId: string;
  queryText: string;
  embedding?: number[];
  limit?: number;
  memoryType?: string;
  visibilities?: MemoryVisibility[];
}

export interface MemoryVectorDbRow {
  id: string;
  agent_id: string;
  memory_type: string;
  visibility: string;
  content: string;
  metadata: unknown;
  source_path: string | null;
  task_id: string | null;
  has_embedding?: boolean;
  created_at: string | Date;
  updated_at: string | Date;
  score?: number | string | null;
}

export class MemoryVectorValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryVectorValidationError";
    this.code = code;
  }
}

const SELECT_COLUMNS = `
  id,
  agent_id,
  memory_type,
  visibility,
  source_path,
  content,
  (embedding IS NOT NULL) AS has_embedding,
  metadata,
  task_id,
  created_at,
  updated_at
`;

export async function insertMemoryVector(
  pool: MemoryVectorQueryablePool,
  input: MemoryVectorInput
): Promise<MemoryVectorEntry> {
  const normalized = normalizeMemoryInput(input);
  const result = await pool.query(
    `
      INSERT INTO openclaw_memory_vectors (
        agent_id,
        memory_type,
        visibility,
        source_path,
        content,
        embedding,
        metadata,
        task_id,
        audit_hash
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::vector,
        $7::jsonb,
        $8,
        $9
      )
      RETURNING ${SELECT_COLUMNS}
    `,
    [
      normalized.agentId,
      normalized.memoryType,
      normalized.visibility,
      normalized.sourcePath ?? null,
      normalized.content,
      normalized.embedding === undefined ? null : toVectorLiteral(normalized.embedding),
      JSON.stringify(normalized.metadata),
      normalized.taskId ?? null,
      normalized.auditHash
    ]
  );
  const row = rows(result)[0];
  if (!row) {
    throw new MemoryVectorValidationError(
      "memory_insert_failed",
      "insertMemoryVector returned no row."
    );
  }
  return rowToEntry(row);
}

export async function semanticSearchMemoryVectors(
  pool: MemoryVectorQueryablePool,
  input: SemanticSearchInput
): Promise<MemoryVectorEntry[]> {
  const agentId = boundedText(input.agentId, "agentId", 1, 128);
  const embedding = validateEmbedding(input.embedding, "embedding");
  const limit = boundedLimit(input.limit);
  const visibilities = normalizeVisibilities(input.visibilities);

  const params: unknown[] = [toVectorLiteral(embedding), agentId, visibilities];
  const filters = ["embedding IS NOT NULL", "(agent_id = $2 OR visibility = ANY($3))"];
  if (input.memoryType !== undefined) {
    params.push(boundedText(input.memoryType, "memoryType", 1, 64));
    filters.push(`memory_type = $${params.length}`);
  }
  params.push(limit);
  const limitParam = params.length;

  const result = await pool.query(
    `
      SELECT ${SELECT_COLUMNS},
             1 - (embedding <=> $1::vector) AS score
      FROM openclaw_memory_vectors
      WHERE ${filters.join(" AND ")}
      ORDER BY embedding <=> $1::vector
      LIMIT $${limitParam}
    `,
    params
  );

  let entries = rows(result).map(rowToEntry);
  if (typeof input.minScore === "number") {
    const floor = input.minScore;
    entries = entries.filter((entry) => (entry.score ?? 0) >= floor);
  }
  return entries;
}

export async function keywordSearchMemoryVectors(
  pool: MemoryVectorQueryablePool,
  input: KeywordSearchInput
): Promise<MemoryVectorEntry[]> {
  const agentId = boundedText(input.agentId, "agentId", 1, 128);
  const queryText = boundedText(input.queryText, "queryText", 1, 1000);
  const limit = boundedLimit(input.limit);
  const visibilities = normalizeVisibilities(input.visibilities);

  const params: unknown[] = [queryText, agentId, visibilities];
  const filters = [
    "content_tsv @@ websearch_to_tsquery('spanish', $1)",
    "(agent_id = $2 OR visibility = ANY($3))"
  ];
  if (input.memoryType !== undefined) {
    params.push(boundedText(input.memoryType, "memoryType", 1, 64));
    filters.push(`memory_type = $${params.length}`);
  }
  params.push(limit);
  const limitParam = params.length;

  const result = await pool.query(
    `
      SELECT ${SELECT_COLUMNS},
             ts_rank(content_tsv, websearch_to_tsquery('spanish', $1)) AS score
      FROM openclaw_memory_vectors
      WHERE ${filters.join(" AND ")}
      ORDER BY score DESC
      LIMIT $${limitParam}
    `,
    params
  );
  return rows(result).map(rowToEntry);
}

/**
 * Hybrid retrieval: fuses semantic (vector) and keyword (FTS) results with
 * Reciprocal Rank Fusion. When no embedding is supplied it degrades gracefully
 * to keyword-only — so the agent still recalls even before embeddings exist.
 */
export async function hybridSearchMemoryVectors(
  pool: MemoryVectorQueryablePool,
  input: HybridSearchInput
): Promise<MemoryVectorEntry[]> {
  const limit = boundedLimit(input.limit);
  const poolSize = Math.min(limit * 3, 50);

  const [semantic, keyword] = await Promise.all([
    input.embedding === undefined
      ? Promise.resolve<MemoryVectorEntry[]>([])
      : semanticSearchMemoryVectors(pool, {
          agentId: input.agentId,
          embedding: input.embedding,
          limit: poolSize,
          ...(input.memoryType === undefined ? {} : { memoryType: input.memoryType }),
          ...(input.visibilities === undefined ? {} : { visibilities: input.visibilities })
        }),
    keywordSearchMemoryVectors(pool, {
      agentId: input.agentId,
      queryText: input.queryText,
      limit: poolSize,
      ...(input.memoryType === undefined ? {} : { memoryType: input.memoryType }),
      ...(input.visibilities === undefined ? {} : { visibilities: input.visibilities })
    })
  ]);

  return reciprocalRankFusion([semantic, keyword], limit);
}

// --- internals -------------------------------------------------------------

const RRF_K = 60;

function reciprocalRankFusion(
  rankings: MemoryVectorEntry[][],
  limit: number
): MemoryVectorEntry[] {
  const fused = new Map<string, { entry: MemoryVectorEntry; score: number }>();
  for (const ranking of rankings) {
    ranking.forEach((entry, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(entry.id);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(entry.id, { entry, score: contribution });
      }
    });
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ entry, score }) => ({ ...entry, score }));
}

interface NormalizedMemory {
  agentId: string;
  memoryType: string;
  visibility: MemoryVisibility;
  content: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  sourcePath?: string;
  taskId?: string;
  auditHash: string;
}

function normalizeMemoryInput(input: MemoryVectorInput): NormalizedMemory {
  const agentId = boundedText(input.agentId, "agentId", 1, 128);
  const memoryType = boundedText(input.memoryType, "memoryType", 1, 64);
  const content = boundedText(input.content, "content", 1, 8000);
  const visibility = normalizeVisibility(input.visibility);
  const metadata = normalizeMetadata(input.metadata);
  const normalized: NormalizedMemory = {
    agentId,
    memoryType,
    visibility,
    content,
    metadata,
    auditHash: "" // set below
  };
  if (input.embedding !== undefined) {
    normalized.embedding = validateEmbedding(input.embedding, "embedding");
  }
  if (input.sourcePath !== undefined && input.sourcePath !== null) {
    normalized.sourcePath = boundedText(input.sourcePath, "sourcePath", 1, 512);
  }
  if (input.taskId !== undefined && input.taskId !== null) {
    normalized.taskId = boundedText(input.taskId, "taskId", 1, 128);
  }
  normalized.auditHash =
    input.auditHash !== undefined && input.auditHash !== null
      ? boundedText(input.auditHash, "auditHash", 1, 128)
      : computeAuditHash(normalized);
  return normalized;
}

function computeAuditHash(memory: NormalizedMemory): string {
  return createHash("sha256")
    .update(
      stableStringify({
        agentId: memory.agentId,
        memoryType: memory.memoryType,
        visibility: memory.visibility,
        content: memory.content,
        metadata: memory.metadata,
        ...(memory.taskId ? { taskId: memory.taskId } : {})
      })
    )
    .digest("hex");
}

function validateEmbedding(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) {
    throw new MemoryVectorValidationError(`invalid_${field}`, `${field} must be an array of numbers.`);
  }
  if (value.length !== MEMORY_EMBEDDING_DIMENSIONS) {
    throw new MemoryVectorValidationError(
      `invalid_${field}`,
      `${field} must have exactly ${MEMORY_EMBEDDING_DIMENSIONS} dimensions (got ${value.length}).`
    );
  }
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new MemoryVectorValidationError(`invalid_${field}`, `${field} must contain only finite numbers.`);
    }
  }
  return value as number[];
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function normalizeVisibility(value: unknown): MemoryVisibility {
  if (value === undefined || value === null) return "private";
  if (typeof value === "string" && (VISIBILITIES as readonly string[]).includes(value)) {
    return value as MemoryVisibility;
  }
  throw new MemoryVectorValidationError(
    "invalid_visibility",
    `visibility must be one of ${VISIBILITIES.join(", ")}.`
  );
}

function normalizeVisibilities(value: MemoryVisibility[] | undefined): MemoryVisibility[] {
  if (value === undefined) return [...DEFAULT_VISIBLE_SCOPES];
  if (!Array.isArray(value) || value.length === 0) {
    throw new MemoryVectorValidationError("invalid_visibilities", "visibilities must be a non-empty array.");
  }
  return value.map((entry) => normalizeVisibility(entry));
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryVectorValidationError("invalid_metadata", "metadata must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new MemoryVectorValidationError(`invalid_${field}`, `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new MemoryVectorValidationError(`invalid_${field}`, `${field} length must be ${min}-${max} chars.`);
  }
  return trimmed;
}

function boundedLimit(value: number | undefined, fallback = 8): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new MemoryVectorValidationError("invalid_limit", "limit must be an integer between 1 and 100.");
  }
  return value;
}

function rows(result: { rows: MemoryVectorDbRow[] }): MemoryVectorDbRow[] {
  return result?.rows ?? [];
}

function rowToEntry(row: MemoryVectorDbRow): MemoryVectorEntry {
  const entry: MemoryVectorEntry = {
    id: row.id,
    agentId: row.agent_id,
    memoryType: row.memory_type,
    visibility: normalizeVisibility(row.visibility),
    content: row.content,
    metadata: normalizeMetadata(row.metadata),
    hasEmbedding: row.has_embedding === true,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at)
  };
  if (row.source_path !== null && row.source_path !== undefined) {
    entry.sourcePath = row.source_path;
  }
  if (row.task_id !== null && row.task_id !== undefined) {
    entry.taskId = row.task_id;
  }
  if (row.score !== null && row.score !== undefined) {
    const score = typeof row.score === "string" ? Number(row.score) : row.score;
    if (Number.isFinite(score)) entry.score = score;
  }
  return entry;
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

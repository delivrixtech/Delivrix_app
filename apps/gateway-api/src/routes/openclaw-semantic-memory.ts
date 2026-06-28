// Route handlers for OpenClaw semantic memory.
//
//   semantic_remember  -> store a finding/learning (vector + full-text)
//   semantic_recall    -> hybrid (vector + FTS, RRF) retrieval by meaning
//
// Mirrors the structure of `openclaw-compact-intent.ts`: a pure async core
// (testable without HTTP) plus a thin HMAC-guarded HTTP wrapper. Embeddings are
// best-effort — if the embedding service is disabled or errors, the memory is
// still written / recalled via full-text, so the path never hard-fails on a
// Bedrock hiccup.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  hybridSearchMemoryVectors,
  insertMemoryVector,
  MemoryVectorValidationError,
  type MemoryVectorEntry,
  type MemoryVectorQueryablePool,
  type MemoryVisibility
} from "../../../../packages/storage/src/index.ts";
import type { EmbeddingService } from "../openclaw-embedding-service.ts";
import { validateOpenClawHmac } from "../security/hmac.ts";
import { readRequestBody } from "../request-body.ts";

const VISIBILITIES: readonly MemoryVisibility[] = [
  "private",
  "shared_family",
  "shared_global",
  "human_authored"
];

export interface SemanticMemoryDeps {
  pool: MemoryVectorQueryablePool;
  embeddingService?: EmbeddingService;
  allowUnsignedLocal?: boolean;
  now?: () => Date;
}

export interface SemanticRememberInput {
  agentId: string;
  memoryType: string;
  content: string;
  visibility?: MemoryVisibility;
  metadata?: Record<string, unknown>;
  taskId?: string;
  sourcePath?: string;
}

export interface SemanticRememberOutput {
  id: string;
  embedded: boolean;
  visibility: MemoryVisibility;
}

export interface SemanticRecallInput {
  agentId: string;
  query: string;
  limit?: number;
  memoryType?: string;
  visibilities?: MemoryVisibility[];
}

export interface SemanticRecallResult {
  id: string;
  memoryType: string;
  visibility: MemoryVisibility;
  content: string;
  score?: number;
  taskId?: string;
}

export interface SemanticRecallOutput {
  results: SemanticRecallResult[];
  embeddingUsed: boolean;
}

export class SemanticMemoryValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SemanticMemoryValidationError";
    this.code = code;
  }
}

export async function semanticRemember(
  input: SemanticRememberInput,
  deps: SemanticMemoryDeps
): Promise<SemanticRememberOutput> {
  const normalized = parseRememberInput(input);
  const embedding = await safeEmbed(deps.embeddingService, normalized.content);

  try {
    const entry = await insertMemoryVector(deps.pool, {
      agentId: normalized.agentId,
      memoryType: normalized.memoryType,
      content: normalized.content,
      visibility: normalized.visibility,
      ...(embedding ? { embedding } : {}),
      ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
      ...(normalized.taskId ? { taskId: normalized.taskId } : {}),
      ...(normalized.sourcePath ? { sourcePath: normalized.sourcePath } : {})
    });
    return { id: entry.id, embedded: entry.hasEmbedding, visibility: entry.visibility };
  } catch (error) {
    throw wrapStorageError(error);
  }
}

export async function semanticRecall(
  input: SemanticRecallInput,
  deps: SemanticMemoryDeps
): Promise<SemanticRecallOutput> {
  const normalized = parseRecallInput(input);
  const embedding = await safeEmbed(deps.embeddingService, normalized.query);

  try {
    const entries = await hybridSearchMemoryVectors(deps.pool, {
      agentId: normalized.agentId,
      queryText: normalized.query,
      ...(embedding ? { embedding } : {}),
      limit: normalized.limit,
      ...(normalized.memoryType ? { memoryType: normalized.memoryType } : {}),
      ...(normalized.visibilities ? { visibilities: normalized.visibilities } : {})
    });
    return { results: entries.map(toRecallResult), embeddingUsed: embedding !== undefined };
  } catch (error) {
    throw wrapStorageError(error);
  }
}

// --- HTTP wrappers ---------------------------------------------------------

export async function handleSemanticRememberHttp(
  deps: SemanticMemoryDeps & { request: IncomingMessage; response: ServerResponse }
): Promise<void> {
  await handle(deps, (body) => semanticRemember(body as SemanticRememberInput, deps));
}

export async function handleSemanticRecallHttp(
  deps: SemanticMemoryDeps & { request: IncomingMessage; response: ServerResponse }
): Promise<void> {
  await handle(deps, (body) => semanticRecall(body as SemanticRecallInput, deps));
}

async function handle(
  deps: SemanticMemoryDeps & { request: IncomingMessage; response: ServerResponse },
  run: (body: unknown) => Promise<unknown>
): Promise<void> {
  const rawBody = await readRequestBody(deps.request, { trim: false });
  const hmac = isUnsignedLocalAllowed(deps)
    ? { ok: true as const }
    : validateOpenClawHmac(deps.request.headers, rawBody, deps.now?.().getTime() ?? Date.now());
  if (!hmac.ok) {
    return json(deps.response, 401, { error: hmac.rejectReason });
  }

  let body: unknown;
  try {
    body = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    return json(deps.response, 400, { error: "invalid_json", details: { _errors: ["Request body must be valid JSON."] } });
  }

  try {
    const output = await run(body);
    return json(deps.response, 200, output);
  } catch (error) {
    if (error instanceof SemanticMemoryValidationError) {
      return json(deps.response, 400, { error: error.code, details: { _errors: [error.message] } });
    }
    return json(deps.response, 503, { error: "semantic_memory_failed", details: { _errors: ["Semantic memory operation failed."] } });
  }
}

// --- internals -------------------------------------------------------------

async function safeEmbed(service: EmbeddingService | undefined, text: string): Promise<number[] | undefined> {
  if (!service?.enabled) return undefined;
  try {
    return await service.embed(text);
  } catch {
    // Degrade to full-text-only; an embedding outage must never break memory.
    return undefined;
  }
}

interface NormalizedRemember {
  agentId: string;
  memoryType: string;
  content: string;
  visibility: MemoryVisibility;
  metadata?: Record<string, unknown>;
  taskId?: string;
  sourcePath?: string;
}

function parseRememberInput(input: SemanticRememberInput): NormalizedRemember {
  const value = object(input, "params");
  const normalized: NormalizedRemember = {
    agentId:
      value.agentId === undefined || value.agentId === null || value.agentId === ""
        ? "openclaw"
        : boundedText(value.agentId, "agentId", 1, 128),
    memoryType: boundedText(value.memoryType, "memoryType", 1, 64),
    content: boundedText(value.content, "content", 1, 8000),
    visibility: parseVisibility(value.visibility)
  };
  if (value.metadata !== undefined && value.metadata !== null) {
    normalized.metadata = objectField(value.metadata, "metadata");
  }
  if (value.taskId !== undefined && value.taskId !== null) {
    normalized.taskId = boundedText(value.taskId, "taskId", 1, 128);
  }
  if (value.sourcePath !== undefined && value.sourcePath !== null) {
    normalized.sourcePath = boundedText(value.sourcePath, "sourcePath", 1, 512);
  }
  return normalized;
}

interface NormalizedRecall {
  agentId: string;
  query: string;
  limit: number;
  memoryType?: string;
  visibilities?: MemoryVisibility[];
}

function parseRecallInput(input: SemanticRecallInput): NormalizedRecall {
  const value = object(input, "params");
  const normalized: NormalizedRecall = {
    agentId:
      value.agentId === undefined || value.agentId === null || value.agentId === ""
        ? "openclaw"
        : boundedText(value.agentId, "agentId", 1, 128),
    query: boundedText(value.query, "query", 3, 1000),
    limit: parseLimit(value.limit)
  };
  if (value.memoryType !== undefined && value.memoryType !== null) {
    normalized.memoryType = boundedText(value.memoryType, "memoryType", 1, 64);
  }
  if (value.visibilities !== undefined && value.visibilities !== null) {
    if (!Array.isArray(value.visibilities) || value.visibilities.length === 0) {
      throw new SemanticMemoryValidationError("invalid_visibilities", "visibilities must be a non-empty array.");
    }
    normalized.visibilities = value.visibilities.map((entry) => parseVisibility(entry));
  }
  return normalized;
}

function toRecallResult(entry: MemoryVectorEntry): SemanticRecallResult {
  const result: SemanticRecallResult = {
    id: entry.id,
    memoryType: entry.memoryType,
    visibility: entry.visibility,
    content: entry.content
  };
  if (entry.score !== undefined) result.score = entry.score;
  if (entry.taskId !== undefined) result.taskId = entry.taskId;
  return result;
}

function wrapStorageError(error: unknown): Error {
  if (error instanceof MemoryVectorValidationError) {
    return new SemanticMemoryValidationError(error.code, error.message);
  }
  return error instanceof Error ? error : new Error("semantic_memory_failed");
}

function parseVisibility(value: unknown): MemoryVisibility {
  if (value === undefined || value === null) return "private";
  if (typeof value === "string" && (VISIBILITIES as readonly string[]).includes(value)) {
    return value as MemoryVisibility;
  }
  throw new SemanticMemoryValidationError("invalid_visibility", `visibility must be one of ${VISIBILITIES.join(", ")}.`);
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null) return 8;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 50) {
    throw new SemanticMemoryValidationError("invalid_limit", "limit must be an integer between 1 and 50.");
  }
  return value as number;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new SemanticMemoryValidationError(`invalid_${field}`, `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new SemanticMemoryValidationError(`invalid_${field}`, `${field} length must be ${min}-${max} chars.`);
  }
  return trimmed;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SemanticMemoryValidationError(`invalid_${field}`, `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  return object(value, field);
}

function isUnsignedLocalAllowed(deps: SemanticMemoryDeps): boolean {
  return deps.allowUnsignedLocal === true && process.env.NODE_ENV === "test";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

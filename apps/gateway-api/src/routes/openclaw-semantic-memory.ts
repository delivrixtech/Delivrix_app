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
  deleteMemoryVectors,
  hybridSearchMemoryVectors,
  insertMemoryVector,
  MemoryVectorValidationError,
  parseMemoryVisibility,
  type MemoryVectorEntry,
  type MemoryVectorQueryablePool,
  type MemoryVisibility
} from "../../../../packages/storage/src/index.ts";
import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}
import type { EmbeddingService } from "../openclaw-embedding-service.ts";
import { validateOpenClawHmac } from "../security/hmac.ts";
import { readRequestBody } from "../request-body.ts";

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
  /** Quien origino la escritura. Lo firma el tool-use-processor con el id de la sesion de chat. */
  actorId?: string;
}

/**
 * Clave RESERVADA dentro de `metadata`: identifica quien escribio la fila.
 *
 * Existe porque `openclaw_memory_vectors` no tiene ningun camino de baja — ni DELETE, ni TTL,
 * ni `expires_at` (verificado en todo el repo). Lo que entra, queda. Si el modelo guarda texto
 * de terceros que trae instrucciones, `semantic_recall` se lo devuelve como conocimiento propio
 * en cualquier sesion posterior, y sin procedencia esa fila es indistinguible de una legitima:
 * no hay forma de encontrarla para darla de baja cuando exista el camino.
 *
 * Se escribe SIEMPRE y se aplica al final, asi que pisa cualquier `provenance` que venga en el
 * metadata del modelo. Queda cubierta por `audit_hash`, que ya incluye `metadata`.
 */
export const PROVENANCE_METADATA_KEY = "provenance";

export interface MemoryProvenance {
  /** Id de la sesion de chat que origino la escritura, o null si la llamada no vino atribuida. */
  actorId: string | null;
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
      metadata: withProvenance(normalized.metadata, normalized.actorId),
      ...(embedding ? { embedding } : {}),
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

export interface SemanticForgetInput {
  /** Ids exactos. */
  ids?: string[];
  /** La sesión entera, vía la procedencia que sella `semantic_remember`. */
  actorId?: string;
  /** Devuelve qué se borraría sin borrar. */
  dryRun?: boolean;
  /** Por qué. Obligatorio: queda en el audit log. */
  reason: string;
  /** Quién pide la baja. */
  operatorId: string;
}

export interface SemanticForgetOutput {
  matched: { id: string; memoryType: string; visibility: MemoryVisibility; actorId: string | null }[];
  deleted: number;
  dryRun: boolean;
}

/**
 * Da de baja memoria semántica. **No es una tool del modelo y no debe serlo:** un agente que
 * puede borrar su propia memoria puede tapar lo que escribió. Es una acción de operador.
 *
 * Cierra el otro extremo de la procedencia: `semantic_remember` sella quién escribió cada fila,
 * y esto permite encontrar la sesión envenenada y llevarse todo lo que dejó.
 */
export async function semanticForget(
  input: SemanticForgetInput,
  deps: SemanticMemoryDeps & { auditLog: AuditSink }
): Promise<SemanticForgetOutput> {
  const normalized = parseForgetInput(input);

  let result;
  try {
    result = await deleteMemoryVectors(deps.pool, {
      ...(normalized.ids.length > 0 ? { ids: normalized.ids } : {}),
      ...(normalized.actorId ? { actorId: normalized.actorId } : {}),
      dryRun: normalized.dryRun
    });
  } catch (error) {
    throw wrapStorageError(error);
  }

  // Se audita SIEMPRE, incluido el dry-run: saber quién estuvo mirando qué borrar también importa.
  await deps.auditLog.append({
    actorType: "operator",
    actorId: normalized.operatorId,
    action: normalized.dryRun ? "oc.memory.forget_preview" : "oc.memory.forget",
    targetType: "memory",
    targetId: normalized.actorId ?? (normalized.ids.join(",").slice(0, 128) || "none"),
    riskLevel: "critical",
    decision: "allow",
    humanApproved: false,
    metadata: {
      reason: normalized.reason,
      dryRun: normalized.dryRun,
      byIds: normalized.ids.length,
      byActorId: normalized.actorId ?? null,
      // Los ids, no el contenido: el audit log no es lugar para el texto que se está sacando.
      matchedIds: result.matched.map((row) => row.id),
      deleted: result.deleted
    }
  });

  return {
    matched: result.matched.map((row) => ({
      id: row.id,
      memoryType: row.memoryType,
      visibility: row.visibility,
      actorId: row.actorId
    })),
    deleted: result.deleted,
    dryRun: result.dryRun
  };
}

function parseForgetInput(input: SemanticForgetInput): {
  ids: string[];
  actorId?: string;
  dryRun: boolean;
  reason: string;
  operatorId: string;
} {
  const value = object(input, "params");
  const ids: string[] = [];
  if (value.ids !== undefined && value.ids !== null) {
    if (!Array.isArray(value.ids)) {
      throw new SemanticMemoryValidationError("invalid_ids", "ids must be an array of strings.");
    }
    for (const id of value.ids) ids.push(boundedText(id, "id", 1, 128));
  }
  const actorId =
    value.actorId === undefined || value.actorId === null || value.actorId === ""
      ? undefined
      : boundedText(value.actorId, "actorId", 1, 128);

  if (ids.length === 0 && actorId === undefined) {
    throw new SemanticMemoryValidationError(
      "invalid_delete_filter",
      "Pass ids or actorId: a blanket delete is never allowed."
    );
  }

  return {
    ids,
    ...(actorId ? { actorId } : {}),
    dryRun: value.dryRun === true,
    reason: boundedText(value.reason, "reason", 3, 500),
    operatorId: boundedText(value.operatorId, "operatorId", 1, 128)
  };
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

export async function handleSemanticForgetHttp(
  deps: SemanticMemoryDeps & {
    request: IncomingMessage;
    response: ServerResponse;
    auditLog: AuditSink;
  }
): Promise<void> {
  await handle(deps, (body) => semanticForget(body as SemanticForgetInput, deps));
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
  actorId?: string;
}

/**
 * Sella la procedencia dentro del metadata. Se aplica DESPUES del metadata del modelo a
 * proposito: `provenance` es reservada y no se puede falsificar desde el input de la tool.
 */
function withProvenance(
  metadata: Record<string, unknown> | undefined,
  actorId: string | undefined
): Record<string, unknown> {
  const provenance: MemoryProvenance = { actorId: actorId ?? null };
  return { ...(metadata ?? {}), [PROVENANCE_METADATA_KEY]: provenance };
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
  if (value.actorId !== undefined && value.actorId !== null && value.actorId !== "") {
    normalized.actorId = boundedText(value.actorId, "actorId", 1, 128);
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
  try {
    return parseMemoryVisibility(value);
  } catch (error) {
    if (error instanceof MemoryVectorValidationError) {
      throw new SemanticMemoryValidationError(error.code, error.message);
    }
    throw error;
  }
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

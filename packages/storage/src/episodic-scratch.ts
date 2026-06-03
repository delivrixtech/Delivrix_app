import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export type ScratchOutcome =
  | "success"
  | "failed"
  | "rolled_back"
  | "rollback_failed"
  | "cancelled_by_operator"
  | "timeout"
  | "partial";

export type ScratchSource = "openclaw" | "operator" | "tool_output";

export interface EpisodicEntry {
  id: string;
  intentId: string;
  step: number;
  tool: string;
  inputHash: string;
  outcome: ScratchOutcome;
  outcomeData?: Record<string, unknown>;
  errorClass?: string;
  errorMessage?: string;
  source: ScratchSource;
  trustScore: number;
  ttlExpiresAt: Date;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface InsertEntryInput {
  intentId: string;
  step: number;
  tool: string;
  inputHash: string;
  outcome: ScratchOutcome;
  outcomeData?: Record<string, unknown>;
  errorClass?: string;
  errorMessage?: string;
  source: ScratchSource;
  trustScore?: number;
  ttlDays?: number;
  metadata?: Record<string, unknown>;
}

type QueryablePool = Pick<Pool, "query">;

const outcomes: ScratchOutcome[] = [
  "success",
  "failed",
  "rolled_back",
  "rollback_failed",
  "cancelled_by_operator",
  "timeout",
  "partial"
];
const sources: ScratchSource[] = ["openclaw", "operator", "tool_output"];
const dayMs = 24 * 60 * 60 * 1000;

export class EpisodicScratchValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EpisodicScratchValidationError";
    this.code = code;
  }
}

export async function insertEpisodicEntry(
  pool: QueryablePool,
  entry: InsertEntryInput
): Promise<EpisodicEntry> {
  const normalized = normalizeInsert(entry);
  const result = await pool.query(
    `
      INSERT INTO openclaw_episodic_scratch (
        intent_id,
        step,
        tool,
        input_hash,
        outcome,
        outcome_data,
        error_class,
        error_message,
        source,
        trust_score,
        ttl_expires_at,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, NOW() + ($11::integer * INTERVAL '1 day'), $12::jsonb)
      RETURNING *
    `,
    [
      normalized.intentId,
      normalized.step,
      normalized.tool,
      normalized.inputHash,
      normalized.outcome,
      normalized.outcomeData === undefined ? null : JSON.stringify(normalized.outcomeData),
      normalized.errorClass ?? null,
      normalized.errorMessage ?? null,
      normalized.source,
      normalized.trustScore,
      normalized.ttlDays,
      JSON.stringify(normalized.metadata ?? {})
    ]
  );

  return rowToEntry(firstRow(result));
}

export async function queryByIntent(
  pool: QueryablePool,
  intentId: string,
  opts: { includeExpired?: boolean } = {}
): Promise<EpisodicEntry[]> {
  const filters = ["intent_id = $1"];
  const params: unknown[] = [boundedString(intentId, "intentId", 1, 64)];
  if (!opts.includeExpired) {
    filters.push("ttl_expires_at > NOW()");
  }

  const result = await pool.query(
    `
      SELECT *
      FROM openclaw_episodic_scratch
      WHERE ${filters.join(" AND ")}
      ORDER BY step ASC, created_at ASC
    `,
    params
  );
  return rows(result).map(rowToEntry);
}

export async function queryByInputHash(
  pool: QueryablePool,
  inputHash: string,
  opts: { tool?: string; sinceDays?: number } = {}
): Promise<EpisodicEntry[]> {
  const params: unknown[] = [inputHashValue(inputHash)];
  const filters = ["input_hash = $1", "ttl_expires_at > NOW()"];
  addOptionalToolAndSinceFilters(filters, params, opts);

  const result = await pool.query(
    `
      SELECT *
      FROM openclaw_episodic_scratch
      WHERE ${filters.join(" AND ")}
      ORDER BY created_at DESC
    `,
    params
  );
  return rows(result).map(rowToEntry);
}

export async function queryByToolAndOutcome(
  pool: QueryablePool,
  tool: string,
  outcome: ScratchOutcome,
  opts: { limit?: number; sinceDays?: number } = {}
): Promise<EpisodicEntry[]> {
  const params: unknown[] = [
    boundedString(tool, "tool", 1, 128),
    outcomeValue(outcome)
  ];
  const filters = ["tool = $1", "outcome = $2", "ttl_expires_at > NOW()"];
  if (opts.sinceDays !== undefined) {
    params.push(sinceDate(opts.sinceDays));
    filters.push(`created_at >= $${params.length}`);
  }
  params.push(limitValue(opts.limit));

  const result = await pool.query(
    `
      SELECT *
      FROM openclaw_episodic_scratch
      WHERE ${filters.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `,
    params
  );
  return rows(result).map(rowToEntry);
}

export async function retrieveTrustWeighted(
  pool: QueryablePool,
  criteria: { tool?: string; outcome?: ScratchOutcome; inputHash?: string },
  limit = 10
): Promise<EpisodicEntry[]> {
  const params: unknown[] = [];
  const filters = ["ttl_expires_at > NOW()"];
  if (criteria.tool !== undefined) {
    params.push(boundedString(criteria.tool, "tool", 1, 128));
    filters.push(`tool = $${params.length}`);
  }
  if (criteria.outcome !== undefined) {
    params.push(outcomeValue(criteria.outcome));
    filters.push(`outcome = $${params.length}`);
  }
  if (criteria.inputHash !== undefined) {
    params.push(inputHashValue(criteria.inputHash));
    filters.push(`input_hash = $${params.length}`);
  }
  params.push(limitValue(limit));

  const result = await pool.query(
    `
      SELECT *
      FROM openclaw_episodic_scratch
      WHERE ${filters.join(" AND ")}
      ORDER BY (trust_score * 100 + EXTRACT(EPOCH FROM NOW() - created_at) / -86400) DESC
      LIMIT $${params.length}
    `,
    params
  );
  return rows(result).map(rowToEntry);
}

export async function expireOldEntries(
  pool: QueryablePool
): Promise<number> {
  const result = await pool.query(
    `
      DELETE FROM openclaw_episodic_scratch
      WHERE ttl_expires_at <= NOW()
      RETURNING id
    `
  );
  return typeof result.rowCount === "number" ? result.rowCount : rows(result).length;
}

function normalizeInsert(entry: InsertEntryInput): InsertEntryInput & {
  trustScore: number;
  ttlDays: number;
} {
  const source = sourceValue(entry.source);
  const trustScore = entry.trustScore ?? defaultTrustScore(source);
  const metadata = entry.metadata ?? {};
  const ttlDays = positiveInteger(entry.ttlDays ?? 30, "ttlDays", 1, 365);

  if (source === "operator" && !hasValidOperatorProvenance(metadata)) {
    throw new EpisodicScratchValidationError(
      "operator_provenance_invalid",
      "source=operator requires verified operator provenance."
    );
  }
  if (source === "tool_output" && !hasToolOutputProvenance(metadata)) {
    throw new EpisodicScratchValidationError(
      "tool_output_provenance_invalid",
      "source=tool_output requires tool output provenance."
    );
  }

  return {
    ...entry,
    intentId: boundedString(entry.intentId, "intentId", 1, 64),
    step: positiveInteger(entry.step, "step", 1, 10_000),
    tool: boundedString(entry.tool, "tool", 1, 128),
    inputHash: inputHashValue(entry.inputHash),
    outcome: outcomeValue(entry.outcome),
    source,
    trustScore: trustScoreValue(trustScore),
    ttlDays,
    metadata
  };
}

function rowToEntry(row: Record<string, unknown>): EpisodicEntry {
  return {
    id: stringField(row.id, "id"),
    intentId: stringField(row.intent_id, "intent_id"),
    step: numberField(row.step, "step"),
    tool: stringField(row.tool, "tool"),
    inputHash: stringField(row.input_hash, "input_hash"),
    outcome: outcomeValue(row.outcome),
    ...(isRecord(row.outcome_data) ? { outcomeData: row.outcome_data } : {}),
    ...(typeof row.error_class === "string" ? { errorClass: row.error_class } : {}),
    ...(typeof row.error_message === "string" ? { errorMessage: row.error_message } : {}),
    source: sourceValue(row.source),
    trustScore: numberField(row.trust_score, "trust_score"),
    ttlExpiresAt: dateField(row.ttl_expires_at, "ttl_expires_at"),
    createdAt: dateField(row.created_at, "created_at"),
    ...(isRecord(row.metadata) ? { metadata: row.metadata } : {})
  };
}

function addOptionalToolAndSinceFilters(
  filters: string[],
  params: unknown[],
  opts: { tool?: string; sinceDays?: number }
): void {
  if (opts.tool !== undefined) {
    params.push(boundedString(opts.tool, "tool", 1, 128));
    filters.push(`tool = $${params.length}`);
  }
  if (opts.sinceDays !== undefined) {
    params.push(sinceDate(opts.sinceDays));
    filters.push(`created_at >= $${params.length}`);
  }
}

function hasValidOperatorProvenance(metadata: Record<string, unknown>): boolean {
  const signatureId = metadata.operatorSignatureId ?? metadata.signatureId;
  if (typeof signatureId !== "string" || !signatureId.trim()) return false;
  const secret = process.env.OPENCLAW_OPERATOR_HMAC_SECRET?.trim();
  if (!secret) {
    return metadata.operatorSignatureVerified === true;
  }
  const provided = metadata.operatorSignatureHmac;
  if (typeof provided !== "string") return false;
  const expected = createHmac("sha256", secret).update(signatureId.trim()).digest("hex");
  return safeEqualHex(provided, expected);
}

function hasToolOutputProvenance(metadata: Record<string, unknown>): boolean {
  return ["toolCallId", "toolUseId", "proposalId", "auditEventId"].some((key) =>
    typeof metadata[key] === "string" && metadata[key].trim().length > 0
  );
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function defaultTrustScore(source: ScratchSource): number {
  if (source === "operator") return 95;
  if (source === "tool_output") return 70;
  return 50;
}

function outcomeValue(value: unknown): ScratchOutcome {
  if (typeof value === "string" && outcomes.includes(value as ScratchOutcome)) {
    return value as ScratchOutcome;
  }
  throw new EpisodicScratchValidationError("invalid_outcome", "Invalid scratch outcome.");
}

function sourceValue(value: unknown): ScratchSource {
  if (typeof value === "string" && sources.includes(value as ScratchSource)) {
    return value as ScratchSource;
  }
  throw new EpisodicScratchValidationError("invalid_source", "Invalid scratch source.");
}

function inputHashValue(value: unknown): string {
  const normalized = boundedString(value, "inputHash", 8, 64).toLowerCase();
  if (!/^[a-f0-9]{8,64}$/.test(normalized)) {
    throw new EpisodicScratchValidationError("invalid_input_hash", "inputHash must be 8-64 lowercase hex chars.");
  }
  return normalized;
}

function trustScoreValue(value: unknown): number {
  const score = positiveInteger(value, "trustScore", 0, 100);
  if (score < 0 || score > 100) {
    throw new EpisodicScratchValidationError("invalid_trust_score", "trustScore must be between 0 and 100.");
  }
  return score;
}

function limitValue(value: unknown): number {
  return positiveInteger(value ?? 10, "limit", 1, 100);
}

function sinceDate(days: number): Date {
  return new Date(Date.now() - positiveInteger(days, "sinceDays", 1, 3650) * dayMs);
}

function boundedString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new EpisodicScratchValidationError(`invalid_${field}`, `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new EpisodicScratchValidationError(`invalid_${field}`, `${field} length is invalid.`);
  }
  return trimmed;
}

function positiveInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new EpisodicScratchValidationError(`invalid_${field}`, `${field} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} missing in scratch row.`);
  }
  return value;
}

function numberField(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} missing in scratch row.`);
  }
  return parsed;
}

function dateField(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} missing in scratch row.`);
  }
  return date;
}

function firstRow(result: unknown): Record<string, unknown> {
  const row = rows(result)[0];
  if (!row) {
    throw new Error("scratch insert returned no row.");
  }
  return row;
}

function rows(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result) || !Array.isArray(result.rows)) {
    return [];
  }
  return result.rows.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { stableStringify } from "./stable-stringify.ts";

export type ScratchOutcome =
  | "success"
  | "failed"
  | "rolled_back"
  | "rollback_failed"
  | "cancelled_by_operator"
  | "timeout"
  | "partial";

export type ScratchSource = "openclaw" | "operator" | "tool_output";
export type ScratchPlane = "observation" | "verified_fact";

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
  plane: ScratchPlane;
  provenance: Record<string, unknown>;
  reliability: number;
  validAt: Date;
  invalidAt?: Date;
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
  plane?: ScratchPlane;
  provenance?: Record<string, unknown>;
  reliability?: number;
  validAt?: Date;
  invalidAt?: Date | null;
  ttlDays?: number;
  metadata?: Record<string, unknown>;
}

export interface InvalidateEpisodicFactsInput {
  tool?: string;
  inputHash?: string;
  reason: string;
  invalidatedBy: string;
  invalidAt?: Date;
}

export type GroundedMemoryAssessment = "correct" | "ambiguous" | "incorrect";
export type GroundedMemoryStatus = "grounded" | "ambiguous" | "abstain";
export type GroundedMemoryReason =
  | "verified_memory_relevant"
  | "verified_memory_ambiguous_search_more"
  | "no_verified_relevant_memory";

export interface GroundedDecisionMemory {
  id: string;
  intentId: string;
  step: number;
  tool: string;
  inputHash: string;
  outcome: ScratchOutcome;
  outcomeData?: Record<string, unknown>;
  errorClass?: string;
  source: Exclude<ScratchSource, "openclaw">;
  trustScore: number;
  plane: "verified_fact";
  provenance: Record<string, unknown>;
  reliability: number;
  validAt: Date;
  ttlExpiresAt: Date;
  createdAt: Date;
}

export interface GroundedMemorySignals {
  relevance: number;
  recency: number;
  reliability: number;
  trust: number;
  keywordOverlap: number;
}

export interface GroundedMemoryCandidate {
  memory: GroundedDecisionMemory;
  score: number;
  assessment: GroundedMemoryAssessment;
  signals: GroundedMemorySignals;
}

export interface GroundedMemoryRetrievalInput {
  tool?: string;
  outcome?: ScratchOutcome;
  inputHash?: string;
  query?: string;
  keywords?: string[];
  limit?: number;
  minScore?: number;
  ambiguousScore?: number;
  now?: Date;
}

export interface GroundedMemoryRetrievalOutput {
  status: GroundedMemoryStatus;
  reason: GroundedMemoryReason;
  memories: GroundedMemoryCandidate[];
  discarded: GroundedMemoryCandidate[];
}

type QueryablePool = Pick<Pool, "query">;
export type EpisodicScratchRejectionKind =
  | "unknown_outcome_key"
  | "forbidden_key_fragment"
  | "structured_value_invalid"
  | "zero_width_control_chars"
  | "instruction_like_text"
  | "payload_too_large";

export interface EpisodicScratchValidationDetails {
  rejectionStage: "storage_write_gate";
  rejectionKind: EpisodicScratchRejectionKind;
  fieldPath?: string;
  fieldKey?: string;
  fieldKeyHash?: string;
  normalizedFieldKey?: string;
  step?: number;
  tool?: string;
  inputHash?: string;
  outcome?: ScratchOutcome;
  valueType?: "string" | "array" | "object" | "number" | "boolean" | "null";
  valueLength?: number;
  arrayLength?: number;
  objectKeyCount?: number;
  redaction: {
    rawValueLogged: false;
    rawErrorMessageLogged: false;
    requestBodyLogged: false;
  };
}

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
const planes: ScratchPlane[] = ["observation", "verified_fact"];
const dayMs = 24 * 60 * 60 * 1000;
const maxStructuredPayloadBytes = 16 * 1024;
const injectionPattern =
  /\b(ignore|disregard|forget|bypass|override|discard|drop)\s+(all\s+)?(previous|prior|earlier|system|developer)?\s*(instructions?|directives?|messages?|prompt|rules?)\b|\b(system\s+prompt|developer\s+message|jailbreak|you\s+are\s+now|exfiltrate|set\s+reliability|raise\s+trust|promote\s+(this\s+)?memory|treat\s+this\s+as\s+verified|override\s+governance|act\s+as\s+system)\b/i;
const zeroWidthPattern = /[\u200B-\u200D\uFEFF]/g;
const zeroWidthPresencePattern = /[\u200B-\u200D\uFEFF]/;
const structuredOutcomeStringPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@/<>\-]{0,199}$/;
const forbiddenOutcomeKeyFragments = [
  "prompt",
  "instruction",
  "system",
  "developer",
  "assistant",
  "messages",
  "role",
  "tooluse",
  "token",
  "secret",
  "password",
  "private",
  "apikey",
  "credential",
  "authorization"
];
const outcomeStringAllowedKeys = new Set([
  "appliesto",
  "continuity",
  "changeid",
  "decisioncode",
  "deliverystatus",
  "dkimpublickeyhash",
  "domain",
  "error",
  "eventid",
  "expectedexpiry",
  "failurecode",
  "hostname",
  "invalidationreason",
  "ipv4",
  "lastseen",
  "maindomain",
  "messageid",
  "mode",
  "msgid",
  "name",
  "nameserver",
  "notecode",
  "nextbatchat",
  "operationid",
  "operatoraction",
  "previousmaindomain",
  "providerrequestid",
  "rampid",
  "recordname",
  "recordtype",
  "recordvalue",
  "registrar",
  "region",
  "requestid",
  "reservationoperationid",
  "rejectioncode",
  "retry",
  "rollbackcode",
  "rrsetid",
  "runid",
  "schedule",
  "scheduledat",
  "seeddomain",
  "serverip",
  "serverslug",
  "selector",
  "shelluserid",
  "skill",
  "sshusername",
  "state",
  "slug",
  "status",
  "tlsstatus",
  "type",
  "value",
  "zone",
  "zoneid"
]);
const outcomeStringArrayAllowedKeys = new Set([
  "blockedreasons",
  "blockers",
  "gates",
  "nameservers",
  "recordvalues",
  "rrsetids",
  "seeddomains",
  "values",
  "messageids",
  "reputationsignals"
]);

export class EpisodicScratchValidationError extends Error {
  readonly code: string;
  readonly details?: EpisodicScratchValidationDetails;

  constructor(code: string, message: string, details?: EpisodicScratchValidationDetails) {
    super(message);
    this.name = "EpisodicScratchValidationError";
    this.code = code;
    this.details = details;
  }
}

export async function insertEpisodicEntry(
  pool: QueryablePool,
  entry: InsertEntryInput
): Promise<EpisodicEntry> {
  const normalized = normalizeInsertWithContext(entry);
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
        plane,
        provenance,
        reliability,
        valid_at,
        invalid_at,
        ttl_expires_at,
        metadata
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12::jsonb,
        $13,
        $14,
        $15,
        NOW() + ($16::integer * INTERVAL '1 day'),
        $17::jsonb
      )
      ON CONFLICT (intent_id, step) DO UPDATE
      SET
        outcome = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.outcome
          ELSE openclaw_episodic_scratch.outcome
        END,
        outcome_data = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.outcome_data
          ELSE openclaw_episodic_scratch.outcome_data
        END,
        error_class = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.error_class
          ELSE openclaw_episodic_scratch.error_class
        END,
        error_message = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.error_message
          ELSE openclaw_episodic_scratch.error_message
        END,
        source = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.source
          ELSE openclaw_episodic_scratch.source
        END,
        plane = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.plane
          ELSE openclaw_episodic_scratch.plane
        END,
        provenance = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.provenance
          ELSE openclaw_episodic_scratch.provenance
        END,
        reliability = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.reliability
          ELSE openclaw_episodic_scratch.reliability
        END,
        valid_at = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.valid_at
          ELSE openclaw_episodic_scratch.valid_at
        END,
        invalid_at = COALESCE(openclaw_episodic_scratch.invalid_at, EXCLUDED.invalid_at),
        trust_score = GREATEST(openclaw_episodic_scratch.trust_score, EXCLUDED.trust_score),
        ttl_expires_at = GREATEST(openclaw_episodic_scratch.ttl_expires_at, EXCLUDED.ttl_expires_at),
        metadata = CASE
          WHEN EXCLUDED.trust_score >= openclaw_episodic_scratch.trust_score THEN EXCLUDED.metadata
          ELSE openclaw_episodic_scratch.metadata
        END
      WHERE
        openclaw_episodic_scratch.tool = EXCLUDED.tool
        AND openclaw_episodic_scratch.input_hash = EXCLUDED.input_hash
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
      normalized.plane,
      JSON.stringify(normalized.provenance),
      normalized.reliability,
      normalized.validAt,
      normalized.invalidAt ?? null,
      normalized.ttlDays,
      JSON.stringify(normalized.metadata ?? {})
    ]
  );

  const row = rows(result)[0];
  if (!row) {
    throw new EpisodicScratchValidationError(
      "scratch_step_conflict",
      "intentId + step already exists with a different tool or inputHash."
    );
  }
  return rowToEntry(row);
}

export function validateEpisodicEntryInput(entry: InsertEntryInput): void {
  normalizeInsertWithContext(entry);
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
    filters.push("invalid_at IS NULL");
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
  const filters = ["input_hash = $1", "ttl_expires_at > NOW()", "invalid_at IS NULL"];
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
  const filters = ["tool = $1", "outcome = $2", "ttl_expires_at > NOW()", "invalid_at IS NULL"];
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
  const entries = await queryVerifiedMemoryCandidates(pool, criteria, limit);
  const keywords = [
    ...(criteria.tool ? tokenize(criteria.tool) : []),
    ...(criteria.outcome ? tokenize(criteria.outcome) : [])
  ];
  return scoreGroundedEntries(entries, { ...criteria, keywords, limit })
    .filter((candidate) => candidate.assessment === "correct")
    .map((candidate) => candidate.entry);
}

export async function retrieveGroundedDecisionMemory(
  pool: QueryablePool,
  input: GroundedMemoryRetrievalInput = {}
): Promise<GroundedMemoryRetrievalOutput> {
  const limit = limitValue(input.limit);
  const entries = await queryVerifiedMemoryCandidates(pool, input, limit);
  const scored = scoreGroundedEntries(entries, input);
  const memories = scored
    .filter((candidate) => candidate.assessment === "correct")
    .slice(0, limit)
    .map(toGroundedCandidate);
  const ambiguous = scored
    .filter((candidate) => candidate.assessment === "ambiguous")
    .slice(0, limit)
    .map(toGroundedCandidate);
  const discarded = scored
    .filter((candidate) => candidate.assessment === "incorrect")
    .slice(0, limit)
    .map(toGroundedCandidate);

  if (memories.length > 0) {
    return {
      status: "grounded",
      reason: "verified_memory_relevant",
      memories,
      discarded: [...ambiguous, ...discarded]
    };
  }

  if (ambiguous.length > 0) {
    return {
      status: "ambiguous",
      reason: "verified_memory_ambiguous_search_more",
      memories: [],
      discarded: [...ambiguous, ...discarded]
    };
  }

  return {
    status: "abstain",
    reason: "no_verified_relevant_memory",
    memories: [],
    discarded
  };
}

async function queryVerifiedMemoryCandidates(
  pool: QueryablePool,
  criteria: { tool?: string; outcome?: ScratchOutcome; inputHash?: string },
  limit = 10
): Promise<EpisodicEntry[]> {
  const params: unknown[] = [];
  const filters = ["ttl_expires_at > NOW()", "invalid_at IS NULL", "plane = 'verified_fact'"];
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
  params.push(limitValue(limit) * 4);

  const result = await pool.query(
    `
      SELECT *
      FROM openclaw_episodic_scratch
      WHERE ${filters.join(" AND ")}
      ORDER BY reliability DESC, created_at DESC
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
      WITH invalidated AS (
        UPDATE openclaw_episodic_scratch
        SET invalid_at = COALESCE(invalid_at, NOW())
        WHERE ttl_expires_at <= NOW()
          AND invalid_at IS NULL
          AND (plane = 'verified_fact' OR source = 'operator')
        RETURNING id
      ),
      deleted AS (
        DELETE FROM openclaw_episodic_scratch
        WHERE ttl_expires_at <= NOW()
          AND invalid_at IS NULL
          AND plane <> 'verified_fact'
          AND source <> 'operator'
        RETURNING id
      )
      SELECT
        (SELECT COUNT(*) FROM invalidated)::integer +
        (SELECT COUNT(*) FROM deleted)::integer AS affected
    `
  );
  const affected = rows(result)[0]?.affected;
  return Number.isFinite(Number(affected)) ? Number(affected) : 0;
}

export async function invalidateEpisodicFacts(
  pool: QueryablePool,
  input: InvalidateEpisodicFactsInput
): Promise<number> {
  if (!input.tool && !input.inputHash) {
    throw new EpisodicScratchValidationError(
      "invalid_invalidation_target",
      "tool or inputHash is required to invalidate episodic facts."
    );
  }

  const params: unknown[] = [
    input.invalidAt ?? new Date(),
    boundedString(input.reason, "reason", 1, 240),
    boundedString(input.invalidatedBy, "invalidatedBy", 1, 128)
  ];
  const filters = ["plane = 'verified_fact'", "invalid_at IS NULL"];
  if (input.tool !== undefined) {
    params.push(boundedString(input.tool, "tool", 1, 128));
    filters.push(`tool = $${params.length}`);
  }
  if (input.inputHash !== undefined) {
    params.push(inputHashValue(input.inputHash));
    filters.push(`input_hash = $${params.length}`);
  }

  const result = await pool.query(
    `
      UPDATE openclaw_episodic_scratch
      SET
        invalid_at = $1,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'invalidationReason', $2,
          'invalidatedBy', $3
        )
      WHERE ${filters.join(" AND ")}
      RETURNING id
    `,
    params
  );
  return typeof result.rowCount === "number" ? result.rowCount : rows(result).length;
}

function normalizeInsertWithContext(entry: InsertEntryInput): InsertEntryInput & {
  trustScore: number;
  plane: ScratchPlane;
  provenance: Record<string, unknown>;
  reliability: number;
  validAt: Date;
  invalidAt: Date | null;
  ttlDays: number;
} {
  try {
    return normalizeInsert(entry);
  } catch (error) {
    if (error instanceof EpisodicScratchValidationError && error.details) {
      throw new EpisodicScratchValidationError(
        error.code,
        error.message,
        validationDetailsWithEntryContext(error.details, entry)
      );
    }
    throw error;
  }
}

function normalizeInsert(entry: InsertEntryInput): InsertEntryInput & {
  trustScore: number;
  plane: ScratchPlane;
  provenance: Record<string, unknown>;
  reliability: number;
  validAt: Date;
  invalidAt: Date | null;
  ttlDays: number;
} {
  const source = sourceValue(entry.source);
  const trustScore = entry.trustScore ?? defaultTrustScore(source);
  const metadata = entry.metadata ?? {};
  const ttlDays = positiveInteger(entry.ttlDays ?? 30, "ttlDays", 1, 365);
  const plane = planeValue(entry.plane ?? defaultPlane(source));
  const provenance = entry.provenance ?? provenanceFromMetadata(source, metadata);
  const reliability = entry.reliability ?? defaultReliability(source);
  const errorClass = entry.errorClass === undefined
    ? undefined
    : boundedString(entry.errorClass, "errorClass", 1, 128);
  const errorMessage = entry.errorMessage === undefined
    ? undefined
    : guardedText(entry.errorMessage, "errorMessage", 1, 2000);
  const intentId = boundedString(entry.intentId, "intentId", 1, 64);
  const step = positiveInteger(entry.step, "step", 1, 10_000);
  const tool = boundedString(entry.tool, "tool", 1, 128);
  const inputHash = inputHashValue(entry.inputHash);
  const outcome = outcomeValue(entry.outcome);

  assertStructuredOutcomeData(entry.outcomeData, "outcomeData");
  assertStructuredPayload(metadata, "metadata");
  assertStructuredPayload(provenance, "provenance");

  if (source === "operator" && !hasValidOperatorProvenance(metadata, {
    intentId,
    step,
    tool,
    inputHash,
    outcome,
    outcomeData: entry.outcomeData,
    errorClass,
    errorMessage
  })) {
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
  if (source === "openclaw" && (entry.reliability !== undefined || entry.trustScore !== undefined)) {
    throw new EpisodicScratchValidationError(
      "openclaw_reliability_forbidden",
      "OpenClaw observations cannot set or raise their own reliability."
    );
  }
  if (source === "openclaw" && plane !== "observation") {
    throw new EpisodicScratchValidationError(
      "openclaw_verified_fact_forbidden",
      "OpenClaw observations cannot promote themselves to verified facts."
    );
  }
  if (plane === "verified_fact" && Object.keys(provenance).length === 0) {
    throw new EpisodicScratchValidationError(
      "verified_fact_provenance_required",
      "verified_fact entries require immutable provenance."
    );
  }

  return {
    ...entry,
    intentId,
    step,
    tool,
    inputHash,
    outcome,
    ...(errorClass === undefined ? {} : { errorClass }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    source,
    trustScore: trustScoreValue(trustScore),
    plane,
    provenance,
    reliability: reliabilityValue(reliability),
    validAt: entry.validAt ?? new Date(),
    invalidAt: entry.invalidAt ?? null,
    ttlDays,
    metadata
  };
}

function validationDetailsWithEntryContext(
  details: EpisodicScratchValidationDetails,
  entry: InsertEntryInput
): EpisodicScratchValidationDetails {
  return {
    ...details,
    ...(Number.isInteger(entry.step) ? { step: Number(entry.step) } : {}),
    ...(typeof entry.tool === "string" ? { tool: entry.tool } : {}),
    ...(typeof entry.inputHash === "string" ? { inputHash: entry.inputHash } : {}),
    ...(typeof entry.outcome === "string" && outcomes.includes(entry.outcome as ScratchOutcome)
      ? { outcome: entry.outcome as ScratchOutcome }
      : {})
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
    plane: planeValue(row.plane ?? "observation"),
    provenance: isRecord(row.provenance) ? row.provenance : {},
    reliability: reliabilityValue(row.reliability ?? numberField(row.trust_score, "trust_score") / 100),
    validAt: dateField(row.valid_at ?? row.created_at, "valid_at"),
    ...(row.invalid_at === null || row.invalid_at === undefined ? {} : { invalidAt: dateField(row.invalid_at, "invalid_at") }),
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

interface OperatorMemoryHmacContext {
  intentId: string;
  step: number;
  tool: string;
  inputHash: string;
  outcome: ScratchOutcome;
  outcomeData?: Record<string, unknown>;
  errorClass?: string;
  errorMessage?: string;
}

function hasValidOperatorProvenance(
  metadata: Record<string, unknown>,
  context: OperatorMemoryHmacContext
): boolean {
  const secret = process.env.OPENCLAW_OPERATOR_HMAC_SECRET?.trim();
  if (!secret) return false;
  const provided = metadata.operatorSignatureHmac;
  if (typeof provided !== "string") return false;
  const payload = operatorHmacPayloadFromMetadata(metadata, context);
  if (!payload) return false;
  const expected = createHmac("sha256", secret).update(stableStringify(payload)).digest("hex");
  return safeEqualHex(provided, expected);
}

function operatorHmacPayloadFromMetadata(
  metadata: Record<string, unknown>,
  context: OperatorMemoryHmacContext
): Record<string, string> | null {
  const signatureId = metadata.operatorSignatureId ?? metadata.signatureId;
  const proposalId = metadata.operatorSignatureProposalId ?? metadata.proposalId;
  const actorId = metadata.operatorSignatureActorId;
  const auditEventId = metadata.operatorSignatureAuditEventId ?? metadata.auditEventId;
  const auditEventHash = metadata.operatorSignatureAuditEventHash;
  const signedAt = metadata.operatorSignatureSignedAt;
  if (
    typeof signatureId !== "string" ||
    typeof proposalId !== "string" ||
    typeof actorId !== "string" ||
    typeof auditEventId !== "string" ||
    typeof signedAt !== "string" ||
    !signatureId.trim() ||
    !proposalId.trim() ||
    !actorId.trim() ||
    !auditEventId.trim() ||
    !signedAt.trim()
  ) {
    return null;
  }
  return {
    actorId: actorId.trim(),
    auditEventId: auditEventId.trim(),
    ...(typeof auditEventHash === "string" && auditEventHash.trim() ? { auditEventHash: auditEventHash.trim() } : {}),
    ...(context.errorClass ? { memoryErrorClass: context.errorClass } : {}),
    ...(context.errorMessage ? { memoryErrorMessage: context.errorMessage } : {}),
    memoryInputHash: context.inputHash,
    memoryIntentId: context.intentId,
    memoryOutcome: context.outcome,
    memoryOutcomeHash: hashJson(context.outcomeData ?? null),
    memoryStep: String(context.step),
    memoryTool: context.tool,
    proposalId: proposalId.trim(),
    signatureId: signatureId.trim(),
    signedAt: signedAt.trim()
  };
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

function defaultReliability(source: ScratchSource): number {
  if (source === "operator") return 0.95;
  if (source === "tool_output") return 0.7;
  return 0.35;
}

function defaultPlane(source: ScratchSource): ScratchPlane {
  return source === "openclaw" ? "observation" : "verified_fact";
}

function provenanceFromMetadata(
  source: ScratchSource,
  metadata: Record<string, unknown>
): Record<string, unknown> {
  if (source === "operator") {
    const signatureId = metadata.operatorSignatureId ?? metadata.signatureId;
    return typeof signatureId === "string" && signatureId.trim()
      ? { kind: "operator_signature", signatureId: signatureId.trim() }
      : {};
  }
  if (source === "tool_output") {
    for (const key of ["toolCallId", "toolUseId", "proposalId", "auditEventId"]) {
      const value = metadata[key];
      if (typeof value === "string" && value.trim()) {
        return { kind: "tool_evidence", [key]: value.trim() };
      }
    }
  }
  return {};
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

function planeValue(value: unknown): ScratchPlane {
  if (typeof value === "string" && planes.includes(value as ScratchPlane)) {
    return value as ScratchPlane;
  }
  throw new EpisodicScratchValidationError("invalid_plane", "Invalid scratch plane.");
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

function reliabilityValue(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new EpisodicScratchValidationError("invalid_reliability", "reliability must be between 0 and 1.");
  }
  return parsed;
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

function guardedText(value: unknown, field: string, min: number, max: number): string {
  const trimmed = boundedString(value, field, min, max);
  assertStructuredText(trimmed, field);
  if (field === "errorMessage" && !/^[a-z0-9_.:-]+$/i.test(trimmed)) {
    throw new EpisodicScratchValidationError(
      "memory_payload_free_text_forbidden",
      "errorMessage must be a structured machine code, not free text."
    );
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

function assertStructuredPayload(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  const serialized = JSON.stringify(value);
  if (serialized.length > maxStructuredPayloadBytes) {
    throw new EpisodicScratchValidationError(
      `${field}_too_large`,
      `${field} exceeds the episodic scratch write-gate size limit.`
    );
  }
  walkPayload(value, field);
}

function assertStructuredOutcomeData(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  const serialized = JSON.stringify(value);
  if (serialized.length > maxStructuredPayloadBytes) {
    throw new EpisodicScratchValidationError(
      `${field}_too_large`,
      `${field} exceeds the episodic scratch write-gate size limit.`,
      validationDetails("payload_too_large", field, value)
    );
  }
  walkOutcomeData(value, field, undefined);
}

function walkPayload(value: unknown, path: string): void {
  if (typeof value === "string") {
    assertStructuredText(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkPayload(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(prompt|instruction|instructions|system|developer|assistant|user|messages)$/i.test(key)) {
      throw new EpisodicScratchValidationError(
        "memory_payload_free_text_forbidden",
        `${path}.${key} is not allowed in episodic scratch writes.`
      );
    }
    walkPayload(item, `${path}.${key}`);
  }
}

function walkOutcomeData(value: unknown, path: string, parentKey: string | undefined): void {
  if (typeof value === "string") {
    assertStructuredOutcomeString(value, path, parentKey);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkOutcomeData(item, `${path}[${index}]`, parentKey));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    assertStructuredOutcomeKey(key, `${path}.${key}`, item);
    walkOutcomeData(item, `${path}.${key}`, key);
  }
}

function assertStructuredOutcomeKey(key: string, path: string, value: unknown): void {
  const normalized = normalizeMemoryKey(key);
  if (forbiddenOutcomeKeyFragments.some((fragment) => normalized.includes(fragment))) {
    throw new EpisodicScratchValidationError(
      "memory_payload_free_text_forbidden",
      `${path} is not allowed in episodic outcomeData.`,
      validationDetails("forbidden_key_fragment", path, value, key)
    );
  }
}

function assertStructuredOutcomeString(value: string, path: string, parentKey: string | undefined): void {
  const normalizedKey = normalizeMemoryKey(parentKey ?? "");
  const allowed =
    outcomeStringAllowedKeys.has(normalizedKey) ||
    outcomeStringArrayAllowedKeys.has(normalizedKey) ||
    isHashOutcomeString(normalizedKey, value);
  if (zeroWidthPresencePattern.test(value)) {
    throw new EpisodicScratchValidationError(
      "memory_payload_instruction_injection",
      `${path} contains invisible control characters and was rejected by the write gate.`,
      validationDetails("zero_width_control_chars", path, value, parentKey)
    );
  }
  if (injectionPattern.test(normalizeGuardText(value))) {
    throw new EpisodicScratchValidationError(
      "memory_payload_instruction_injection",
      `${path} contains instruction-like text and was rejected by the write gate.`,
      validationDetails("instruction_like_text", path, value, parentKey)
    );
  }
  if (!allowed || !isStructuredOutcomeString(value, normalizedKey)) {
    throw new EpisodicScratchValidationError(
      "memory_payload_free_text_forbidden",
      `${path} must be structured machine data, not free text.`,
      validationDetails(allowed ? "structured_value_invalid" : "unknown_outcome_key", path, value, parentKey)
    );
  }
}

function assertStructuredText(value: string, path: string): void {
  if (zeroWidthPresencePattern.test(value)) {
    throw new EpisodicScratchValidationError(
      "memory_payload_instruction_injection",
      `${path} contains invisible control characters and was rejected by the write gate.`
    );
  }
  if (injectionPattern.test(normalizeGuardText(value))) {
    throw new EpisodicScratchValidationError(
      "memory_payload_instruction_injection",
      `${path} contains instruction-like text and was rejected by the write gate.`
    );
  }
}

function normalizeGuardText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(zeroWidthPattern, "")
    .replace(/[_\W]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeMemoryKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(zeroWidthPattern, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, "")
    .toLowerCase();
}

function isStructuredOutcomeString(value: string, normalizedKey: string): boolean {
  const trimmed = value.trim();
  if (zeroWidthPresencePattern.test(value)) return false;
  if (injectionPattern.test(normalizeGuardText(value))) return false;
  if (normalizedKey === "expectedexpiry" || normalizedKey === "lastseen" || normalizedKey === "nextbatchat" || normalizedKey === "scheduledat") {
    return isStructuredTimestampOrSentinel(trimmed, normalizedKey);
  }
  if (normalizedKey === "recordvalue" || normalizedKey === "recordvalues") return isStructuredDnsRecordValue(trimmed);
  if (normalizedKey === "value" || normalizedKey === "values") return isStructuredGenericValue(trimmed);
  if (isProviderIdKey(normalizedKey)) {
    return /^\/?[A-Za-z0-9][A-Za-z0-9_.:/<>\-]{0,199}$/.test(trimmed);
  }
  if (!structuredOutcomeStringPattern.test(trimmed)) return false;
  if (
    normalizedKey === "domain" ||
    normalizedKey === "hostname" ||
    normalizedKey === "maindomain" ||
    normalizedKey === "nameserver" ||
    normalizedKey === "nameservers" ||
    normalizedKey === "previousmaindomain" ||
    normalizedKey === "seeddomain" ||
    normalizedKey === "seeddomains" ||
    normalizedKey === "zone"
  ) {
    return isStructuredDnsName(trimmed);
  }
  if (normalizedKey === "name" || normalizedKey === "recordname") {
    return isStructuredDnsOwnerName(trimmed);
  }
  if (normalizedKey === "ipv4" || normalizedKey === "serverip") {
    return /^(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}$/.test(trimmed);
  }
  if (normalizedKey === "region") {
    return /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/i.test(trimmed);
  }
  if (normalizedKey === "recordtype" || normalizedKey === "type") {
    return /^(A|AAAA|CNAME|MX|TXT|NS|SOA|PTR|SRV|CAA)$/i.test(trimmed);
  }
  if (normalizedKey === "selector") {
    return /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(trimmed);
  }
  return true;
}

const conformOutcomeDataDrop = Symbol("conformOutcomeData.drop");

export function conformOutcomeData(value: unknown): unknown {
  const conformed = conformOutcomeDataValue(value, undefined);
  return conformed === conformOutcomeDataDrop ? undefined : conformed;
}

function conformOutcomeDataValue(value: unknown, parentKey: string | undefined): unknown | typeof conformOutcomeDataDrop {
  if (typeof value === "string") {
    return isConformableOutcomeString(value, parentKey) ? value : conformOutcomeDataDrop;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const conformed = conformOutcomeDataValue(item, parentKey);
      if (conformed !== conformOutcomeDataDrop) output.push(conformed);
    }
    return output;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (!isRecord(value)) {
    return conformOutcomeDataDrop;
  }

  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = normalizeMemoryKey(key);
    if (forbiddenOutcomeKeyFragments.some((fragment) => normalizedKey.includes(fragment))) {
      continue;
    }
    const conformed = conformOutcomeDataValue(item, key);
    if (conformed !== conformOutcomeDataDrop) entries.push([key, conformed]);
  }
  return Object.fromEntries(entries);
}

function isConformableOutcomeString(value: string, parentKey: string | undefined): boolean {
  const normalizedKey = normalizeMemoryKey(parentKey ?? "");
  const allowed =
    outcomeStringAllowedKeys.has(normalizedKey) ||
    outcomeStringArrayAllowedKeys.has(normalizedKey) ||
    isHashOutcomeString(normalizedKey, value);
  return allowed &&
    !zeroWidthPresencePattern.test(value) &&
    !injectionPattern.test(normalizeGuardText(value)) &&
    isStructuredOutcomeString(value, normalizedKey);
}

export function redactUnsafeOutcomeData(value: unknown): unknown {
  return redactOutcomeDataValue(value, undefined);
}

function redactOutcomeDataValue(value: unknown, parentKey: string | undefined): unknown {
  if (typeof value === "string") {
    const normalizedKey = normalizeMemoryKey(parentKey ?? "");
    const allowed =
      outcomeStringAllowedKeys.has(normalizedKey) ||
      outcomeStringArrayAllowedKeys.has(normalizedKey) ||
      isHashOutcomeString(normalizedKey, value);
    return allowed && isStructuredOutcomeString(value, normalizedKey) && !injectionPattern.test(normalizeGuardText(value))
      ? value
      : "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactOutcomeDataValue(item, parentKey));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const normalizedKey = normalizeMemoryKey(key);
      if (forbiddenOutcomeKeyFragments.some((fragment) => normalizedKey.includes(fragment))) {
        return [key, "[redacted]"];
      }
      return [key, redactOutcomeDataValue(item, key)];
    })
  );
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function isHashOutcomeString(normalizedKey: string, value: string): boolean {
  return normalizedKey.endsWith("hash") && /^[a-f0-9]{64}$/i.test(value.trim());
}

function validationDetails(
  rejectionKind: EpisodicScratchRejectionKind,
  fieldPath: string,
  value: unknown,
  fieldKey?: string
): EpisodicScratchValidationDetails {
  const safeKey = fieldKey && /^[A-Za-z0-9_.:-]{1,64}$/.test(fieldKey) ? fieldKey : undefined;
  const unsafeKeyHash = fieldKey && !safeKey ? createHash("sha256").update(fieldKey).digest("hex") : undefined;
  const valueShape = validationValueShape(value);
  return {
    rejectionStage: "storage_write_gate",
    rejectionKind,
    fieldPath,
    ...(safeKey ? { fieldKey: safeKey } : {}),
    ...(unsafeKeyHash ? { fieldKeyHash: unsafeKeyHash } : {}),
    ...(fieldKey ? { normalizedFieldKey: normalizeMemoryKey(fieldKey) } : {}),
    ...valueShape,
    redaction: {
      rawValueLogged: false,
      rawErrorMessageLogged: false,
      requestBodyLogged: false
    }
  };
}

function validationValueShape(value: unknown): Pick<
  EpisodicScratchValidationDetails,
  "valueType" | "valueLength" | "arrayLength" | "objectKeyCount"
> {
  if (value === null) return { valueType: "null" };
  if (typeof value === "string") return { valueType: "string", valueLength: value.length };
  if (Array.isArray(value)) return { valueType: "array", arrayLength: value.length };
  if (isRecord(value)) return { valueType: "object", objectKeyCount: Object.keys(value).length };
  if (typeof value === "number") return { valueType: "number" };
  if (typeof value === "boolean") return { valueType: "boolean" };
  return {};
}

function isStructuredDnsName(value: string): boolean {
  const trimmed = value.replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(trimmed);
}

function isStructuredDnsOwnerName(value: string): boolean {
  const trimmed = value.replace(/\.$/, "");
  return /^_?[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\._?[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?)+$/i.test(trimmed);
}

function isStructuredDnsRecordValue(value: string): boolean {
  if (/^(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}$/.test(value)) {
    return true;
  }
  if (isStructuredDnsName(value)) {
    return true;
  }
  if (/^\d{1,5}\s+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\.?$/i.test(value)) {
    return true;
  }
  return /^v=(SPF1|DKIM1|DMARC1)\b[ A-Za-z0-9_.:@/<>=;+~?-]{0,190}$/i.test(value);
}

function isStructuredGenericValue(value: string): boolean {
  return isStructuredDnsRecordValue(value) || structuredOutcomeStringPattern.test(value);
}

function isStructuredTimestampOrSentinel(value: string, normalizedKey: string): boolean {
  if (normalizedKey === "lastseen" && (value === "(nxdomain)" || value === "(resolver_error)")) {
    return true;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    return true;
  }
  return normalizedKey === "lastseen" && value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .every(isStructuredDnsRecordValue);
}

function isProviderIdKey(normalizedKey: string): boolean {
  return [
    "changeid",
    "eventid",
    "operationid",
    "providerrequestid",
    "rampid",
    "requestid",
    "reservationoperationid",
    "rrsetid",
    "rrsetids",
    "runid"
  ].includes(normalizedKey);
}

interface ScoredEntry {
  entry: EpisodicEntry;
  score: number;
  assessment: GroundedMemoryAssessment;
  signals: GroundedMemorySignals;
}

function scoreGroundedEntries(
  entries: EpisodicEntry[],
  input: GroundedMemoryRetrievalInput
): ScoredEntry[] {
  const now = input.now ?? new Date();
  const minScore = boundedScore(input.minScore ?? 0.52, "minScore");
  const ambiguousScore = boundedScore(input.ambiguousScore ?? 0.35, "ambiguousScore");
  return entries
    .map((entry) => scoreGroundedEntry(entry, input, now, minScore, ambiguousScore))
    .sort((left, right) =>
      right.score - left.score ||
      right.entry.reliability - left.entry.reliability ||
      right.entry.createdAt.getTime() - left.entry.createdAt.getTime()
    );
}

function scoreGroundedEntry(
  entry: EpisodicEntry,
  input: GroundedMemoryRetrievalInput,
  now: Date,
  minScore: number,
  ambiguousScore: number
): ScoredEntry {
  const keywords = retrievalKeywords(input);
  const keywordOverlap = keywordOverlapScore(keywords, entry);
  const relevance = keywords.length === 0 ? 0 : keywordOverlap;
  const ageDays = Math.max(0, (now.getTime() - entry.createdAt.getTime()) / dayMs);
  const recency = Math.exp(-ageDays / 30);
  const reliability = reliabilityValue(entry.reliability);
  const trust = trustScoreValue(entry.trustScore) / 100;
  const baseScore = (relevance * 0.7) + (recency * 0.2) + (trust * 0.1);
  const score = baseScore * (0.25 + reliability * 0.75);
  const assessment: GroundedMemoryAssessment =
    keywords.length > 0 && relevance >= 0.25 && reliability >= 0.5 && score >= minScore
      ? "correct"
      : keywords.length > 0 && score >= ambiguousScore ? "ambiguous" : "incorrect";
  return {
    entry,
    score,
    assessment,
    signals: {
      relevance,
      recency,
      reliability,
      trust,
      keywordOverlap
    }
  };
}

function retrievalKeywords(input: GroundedMemoryRetrievalInput): string[] {
  const values = [
    ...(input.keywords ?? []),
    ...(input.query ? tokenize(input.query) : [])
  ];
  return [...new Set(values.flatMap(tokenize))];
}

function keywordOverlapScore(keywords: string[], entry: EpisodicEntry): number {
  if (keywords.length === 0) return 0.5;
  const haystack = new Set(tokenize(JSON.stringify({
    tool: entry.tool,
    outcome: entry.outcome,
    outcomeData: entry.outcomeData ?? {},
    errorClass: entry.errorClass,
    provenance: entry.provenance,
    metadata: entry.metadata ?? {}
  })));
  const hits = keywords.filter((keyword) => haystack.has(keyword)).length;
  return hits / keywords.length;
}

function tokenize(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return normalizeGuardText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !stopWords.has(token));
}

function boundedScore(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new EpisodicScratchValidationError(`invalid_${field}`, `${field} must be between 0 and 1.`);
  }
  return parsed;
}

function toGroundedCandidate(scored: ScoredEntry): GroundedMemoryCandidate {
  return {
    memory: toGroundedDecisionMemory(scored.entry),
    score: Number(scored.score.toFixed(6)),
    assessment: scored.assessment,
    signals: {
      relevance: Number(scored.signals.relevance.toFixed(6)),
      recency: Number(scored.signals.recency.toFixed(6)),
      reliability: Number(scored.signals.reliability.toFixed(6)),
      trust: Number(scored.signals.trust.toFixed(6)),
      keywordOverlap: Number(scored.signals.keywordOverlap.toFixed(6))
    }
  };
}

function toGroundedDecisionMemory(entry: EpisodicEntry): GroundedDecisionMemory {
  if (entry.plane !== "verified_fact" || entry.source === "openclaw" || entry.invalidAt) {
    throw new EpisodicScratchValidationError(
      "invalid_grounded_memory",
      "Decision memory must be an active verified fact."
    );
  }
  return {
    id: entry.id,
    intentId: entry.intentId,
    step: entry.step,
    tool: entry.tool,
    inputHash: entry.inputHash,
    outcome: entry.outcome,
    ...(entry.outcomeData === undefined ? {} : { outcomeData: entry.outcomeData }),
    ...(entry.errorClass === undefined ? {} : { errorClass: entry.errorClass }),
    source: entry.source,
    trustScore: entry.trustScore,
    plane: entry.plane,
    provenance: entry.provenance,
    reliability: entry.reliability,
    validAt: entry.validAt,
    ttlExpiresAt: entry.ttlExpiresAt,
    createdAt: entry.createdAt
  };
}

const stopWords = new Set([
  "the",
  "and",
  "for",
  "con",
  "que",
  "para",
  "una",
  "uno",
  "los",
  "las",
  "del",
  "smtp",
  "openclaw"
]);

function rows(result: unknown): Record<string, unknown>[] {
  if (!isRecord(result) || !Array.isArray(result.rows)) {
    return [];
  }
  return result.rows.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

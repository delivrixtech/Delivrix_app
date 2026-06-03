import { createHash, createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveEvent
} from "../../../../packages/domain/src/index.ts";
import {
  EpisodicScratchValidationError,
  insertEpisodicEntry,
  stableStringify,
  type ScratchOutcome,
  type ScratchSource
} from "../../../../packages/storage/src/index.ts";
import { validateOpenClawHmac } from "../security/hmac.ts";
import { readRequestBody } from "../request-body.ts";

export interface CompactIntentStep {
  step: number;
  tool: string;
  inputHash: string;
  outcome: ScratchOutcome;
  outcomeData?: Record<string, unknown>;
  errorClass?: string;
  errorMessage?: string;
  durationMs?: number;
  proposalId?: string;
  signatureId?: string;
  toolUseId?: string;
  toolCallId?: string;
  auditEventId?: string;
}

export interface CompactIntentInput {
  intentId: string;
  finalStatus: "completed" | "failed" | "cancelled" | "rolled_back";
  decision: string;
  steps: CompactIntentStep[];
  ttlDays?: number;
  actorId?: string;
}

export interface CompactIntentOutput {
  entriesWritten: number;
  scratchIds: string[];
  ttlExpiresAt?: string;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<AuditEvent | unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

interface VerifiedOperatorSignature {
  signatureId: string;
  actorId: string;
  auditEventId: string;
  auditEventHash?: string;
  signedAt: string;
  proposalId: string;
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

export interface CompactIntentDeps {
  pool: Pick<Pool, "query">;
  auditLog: AuditSink;
  canvasLiveEvents?: CanvasEmitter;
  allowUnsignedLocal?: boolean;
  now?: () => Date;
}

export async function handleCompactIntentHttp(
  deps: CompactIntentDeps & { request: IncomingMessage; response: ServerResponse }
): Promise<void> {
  const rawBody = await readRawBody(deps.request);
  const hmac = isUnsignedLocalCompactionAllowed(deps)
    ? { ok: true as const }
    : validateOpenClawHmac(deps.request.headers, rawBody, deps.now?.().getTime() ?? Date.now());
  if (!hmac.ok) {
    return json(deps.response, 401, {
      error: hmac.rejectReason
    });
  }

  let body: unknown;
  try {
    body = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    return json(deps.response, 400, {
      error: "invalid_json",
      details: { _errors: ["Request body must be valid JSON."] }
    });
  }

  try {
    const output = await compactIntent(parseCompactIntentInput(body), deps);
    return json(deps.response, 200, output);
  } catch (error) {
    if (error instanceof CompactIntentValidationError || error instanceof EpisodicScratchValidationError) {
      return json(deps.response, 400, {
        error: error.code,
        details: error.message
      });
    }
    return json(deps.response, 503, {
      error: "compact_intent_failed",
      details: error instanceof Error ? error.message : "Intent compaction failed."
    });
  }
}

export async function compactIntent(
  input: CompactIntentInput,
  deps: CompactIntentDeps
): Promise<CompactIntentOutput> {
  if (!(await intentExists(deps.auditLog, input.intentId))) {
    throw new CompactIntentValidationError(
      "intent_id_not_found",
      "intentId must exist in audit chain as oc.skill.invoked before compaction."
    );
  }

  const scratchIds: string[] = [];
  let ttlExpiresAt: string | undefined;
  for (const step of input.steps) {
    const operatorSignature = await verifiedOperatorSignatureForStep(step, deps.auditLog);
    const source = memorySourceForStep(step, operatorSignature);
    const metadata = compactMetadataForStep(step, input, operatorSignature);
    const provenance = compactProvenanceForStep(step, source);
    const inserted = await insertEpisodicEntry(deps.pool, {
      intentId: input.intentId,
      step: step.step,
      tool: step.tool,
      inputHash: step.inputHash,
      outcome: step.outcome,
      outcomeData: step.outcomeData,
      errorClass: step.errorClass,
      errorMessage: step.errorMessage,
      source,
      plane: source === "openclaw" ? "observation" : "verified_fact",
      provenance,
      ttlDays: input.ttlDays ?? 30,
      metadata
    });
    scratchIds.push(inserted.id);
    ttlExpiresAt = inserted.ttlExpiresAt.toISOString();
  }

  const compactedAt = (deps.now?.() ?? new Date()).toISOString();
  await deps.auditLog.append({
    actorType: "openclaw",
    actorId: input.actorId ?? "compact_intent",
    action: "oc.episodic.intent_compacted",
    targetType: "openclaw_intent",
    targetId: input.intentId,
    riskLevel: "low",
    decision: "allow",
    metadata: {
      intentId: input.intentId,
      finalStatus: input.finalStatus,
      entriesWritten: scratchIds.length,
      entriesHash: hashJson(input.steps.map((step) => ({
        step: step.step,
        tool: step.tool,
        inputHash: step.inputHash,
        outcome: step.outcome
      }))),
      scratchIdsHash: hashJson(scratchIds),
      decisionHash: hashJson(input.decision),
      ttlDays: input.ttlDays ?? 30,
      compactedAt
    }
  });

  await safeEmit(deps, {
    type: "oc.action.now",
    kind: "audit",
    action: "oc.episodic.intent_compacted",
    targetType: "openclaw_intent",
    targetId: input.intentId,
    riskLevel: "low",
    occurredAt: compactedAt
  } as CanvasLiveEvent);

  return {
    entriesWritten: scratchIds.length,
    scratchIds,
    ...(ttlExpiresAt ? { ttlExpiresAt } : {})
  };
}

export class CompactIntentValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompactIntentValidationError";
    this.code = code;
  }
}

function parseCompactIntentInput(value: unknown): CompactIntentInput {
  const input = object(value, "params");
  const steps = array(input.steps, "steps", 1, 50).map((step, index) => {
    const item = object(step, `steps[${index}]`);
    const outcomeData = optionalRecord(item.outcomeData, `steps[${index}].outcomeData`);
    return {
      step: integer(item.step, `steps[${index}].step`, 1, 10_000),
      tool: string(item.tool, `steps[${index}].tool`, 1, 128),
      inputHash: inputHash(item.inputHash, `steps[${index}].inputHash`),
      outcome: outcome(item.outcome, `steps[${index}].outcome`),
      ...(outcomeData === undefined ? {} : { outcomeData }),
      ...(item.errorClass === undefined || item.errorClass === null ? {} : { errorClass: string(item.errorClass, `steps[${index}].errorClass`, 1, 128) }),
      ...(item.errorMessage === undefined || item.errorMessage === null ? {} : { errorMessage: string(item.errorMessage, `steps[${index}].errorMessage`, 1, 2000) }),
      ...(item.durationMs === undefined || item.durationMs === null ? {} : { durationMs: integer(item.durationMs, `steps[${index}].durationMs`, 0, 86_400_000) }),
      ...(item.proposalId === undefined || item.proposalId === null ? {} : { proposalId: string(item.proposalId, `steps[${index}].proposalId`, 1, 128) }),
      ...(item.signatureId === undefined || item.signatureId === null ? {} : { signatureId: string(item.signatureId, `steps[${index}].signatureId`, 1, 128) }),
      ...(item.toolUseId === undefined || item.toolUseId === null ? {} : { toolUseId: string(item.toolUseId, `steps[${index}].toolUseId`, 1, 128) }),
      ...(item.toolCallId === undefined || item.toolCallId === null ? {} : { toolCallId: string(item.toolCallId, `steps[${index}].toolCallId`, 1, 128) }),
      ...(item.auditEventId === undefined || item.auditEventId === null ? {} : { auditEventId: string(item.auditEventId, `steps[${index}].auditEventId`, 1, 128) })
    } satisfies CompactIntentStep;
  });

  return {
    intentId: string(input.intentId, "intentId", 1, 64),
    finalStatus: oneOf(input.finalStatus, "finalStatus", ["completed", "failed", "cancelled", "rolled_back"] as const),
    decision: string(input.decision, "decision", 1, 280),
    steps,
    ...(input.ttlDays === undefined || input.ttlDays === null ? {} : { ttlDays: integer(input.ttlDays, "ttlDays", 1, 365) }),
    ...(input.actorId === undefined || input.actorId === null ? {} : { actorId: string(input.actorId, "actorId", 1, 128) })
  };
}

async function intentExists(auditLog: AuditSink, intentId: string): Promise<boolean> {
  if (!auditLog.list) return false;
  const events = await auditLog.list();
  return events.some((event) =>
    event.action === "oc.skill.invoked" &&
    (event.targetId === intentId ||
      event.metadata?.intentId === intentId ||
      event.metadata?.runId === intentId)
  );
}

function isUnsignedLocalCompactionAllowed(deps: CompactIntentDeps): boolean {
  return deps.allowUnsignedLocal === true && process.env.NODE_ENV === "test";
}

async function verifiedOperatorSignatureForStep(
  step: CompactIntentStep,
  auditLog: AuditSink
): Promise<VerifiedOperatorSignature | undefined> {
  if (!step.signatureId) return undefined;
  if (!step.proposalId) {
    throw new CompactIntentValidationError(
      "signature_id_not_verified",
      "signatureId must be tied to a proposalId before it can be trusted as operator memory."
    );
  }
  if (!auditLog.list) {
    throw new CompactIntentValidationError(
      "signature_id_not_verified",
      "signatureId cannot be verified because the audit chain is unavailable."
    );
  }

  const events = await auditLog.list();
  const signed = events.find((event) =>
    event.action === "oc.proposal.signed" &&
    event.actorType === "operator" &&
    event.decision === "allow" &&
    event.humanApproved === true &&
    event.metadata?.signatureId === step.signatureId &&
    event.targetId === step.proposalId
  );

  if (!signed) {
    throw new CompactIntentValidationError(
      "signature_id_not_verified",
      "signatureId must match a verified operator signature in the audit chain."
    );
  }

  return {
    signatureId: step.signatureId,
    actorId: signed.actorId,
    auditEventId: signed.id,
    ...(typeof signed.hash === "string" ? { auditEventHash: signed.hash } : {}),
    signedAt: signed.occurredAt,
    proposalId: signed.targetId
  };
}

function memorySourceForStep(
  step: CompactIntentStep,
  operatorSignature?: VerifiedOperatorSignature
): ScratchSource {
  if (operatorSignature) return "operator";
  if (step.toolUseId || step.toolCallId || step.proposalId || step.auditEventId) return "tool_output";
  return "openclaw";
}

function compactMetadataForStep(
  step: CompactIntentStep,
  input: CompactIntentInput,
  operatorSignature?: VerifiedOperatorSignature
): Record<string, unknown> {
  const operatorSecret = operatorSignature
    ? process.env.OPENCLAW_OPERATOR_HMAC_SECRET?.trim()
    : undefined;
  if (operatorSignature && !operatorSecret) {
    throw new CompactIntentValidationError(
      "operator_hmac_secret_required",
      "OPENCLAW_OPERATOR_HMAC_SECRET is required before operator memory can be persisted."
    );
  }
  const operatorContext = operatorSignature ? operatorMemoryContext(input, step) : undefined;
  const operatorPayload = operatorSignature && operatorContext
    ? operatorHmacPayload(operatorSignature, operatorContext)
    : undefined;
  return {
    intentFinalStatus: input.finalStatus,
    decisionHash: hashJson(input.decision),
    ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
    ...(step.proposalId ? { proposalId: step.proposalId } : {}),
    ...(operatorSignature ? {
      signatureId: operatorSignature.signatureId,
      operatorSignatureId: operatorSignature.signatureId,
      operatorSignatureVerified: true,
      operatorSignatureHmac: createHmac("sha256", operatorSecret).update(stableStringify(operatorPayload)).digest("hex"),
      operatorSignatureActorId: operatorSignature.actorId,
      operatorSignatureAuditEventId: operatorSignature.auditEventId,
      ...(operatorSignature.auditEventHash ? { operatorSignatureAuditEventHash: operatorSignature.auditEventHash } : {}),
      operatorSignatureSignedAt: operatorSignature.signedAt,
      operatorSignatureProposalId: operatorSignature.proposalId
    } : {}),
    ...(step.toolUseId ? { toolUseId: step.toolUseId } : {}),
    ...(step.toolCallId ? { toolCallId: step.toolCallId } : {}),
    ...(step.auditEventId ? { auditEventId: step.auditEventId } : {})
  };
}

function operatorMemoryContext(
  input: CompactIntentInput,
  step: CompactIntentStep
): OperatorMemoryHmacContext {
  return {
    intentId: input.intentId,
    step: step.step,
    tool: step.tool,
    inputHash: step.inputHash,
    outcome: step.outcome,
    ...(step.outcomeData === undefined ? {} : { outcomeData: step.outcomeData }),
    ...(step.errorClass === undefined ? {} : { errorClass: step.errorClass }),
    ...(step.errorMessage === undefined ? {} : { errorMessage: step.errorMessage })
  };
}

function operatorHmacPayload(
  signature: VerifiedOperatorSignature,
  context: OperatorMemoryHmacContext
): Record<string, string> {
  return {
    actorId: signature.actorId,
    auditEventId: signature.auditEventId,
    ...(signature.auditEventHash ? { auditEventHash: signature.auditEventHash } : {}),
    ...(context.errorClass ? { memoryErrorClass: context.errorClass } : {}),
    ...(context.errorMessage ? { memoryErrorMessage: context.errorMessage } : {}),
    memoryInputHash: context.inputHash,
    memoryIntentId: context.intentId,
    memoryOutcome: context.outcome,
    memoryOutcomeHash: hashJson(context.outcomeData ?? null),
    memoryStep: String(context.step),
    memoryTool: context.tool,
    proposalId: signature.proposalId,
    signatureId: signature.signatureId,
    signedAt: signature.signedAt
  };
}

function compactProvenanceForStep(
  step: CompactIntentStep,
  source: ScratchSource
): Record<string, unknown> {
  if (source === "operator" && step.signatureId) {
    return {
      kind: "operator_signature",
      signatureId: step.signatureId,
      ...(step.proposalId ? { proposalId: step.proposalId } : {}),
      ...(step.auditEventId ? { auditEventId: step.auditEventId } : {})
    };
  }
  if (source === "tool_output") {
    return {
      kind: "tool_evidence",
      ...(step.toolUseId ? { toolUseId: step.toolUseId } : {}),
      ...(step.toolCallId ? { toolCallId: step.toolCallId } : {}),
      ...(step.proposalId ? { proposalId: step.proposalId } : {}),
      ...(step.auditEventId ? { auditEventId: step.auditEventId } : {})
    };
  }
  return {};
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

async function safeEmit(deps: CompactIntentDeps, event: CanvasLiveEvent): Promise<void> {
  if (!deps.canvasLiveEvents) return;
  try {
    await deps.canvasLiveEvents.emit(event);
  } catch {
    // Memory compaction must not fail the operational run because Canvas missed an event.
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CompactIntentValidationError(`invalid_${field}`, `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return object(value, field);
}

function array(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new CompactIntentValidationError(`invalid_${field}`, `${field} must be an array with ${min}-${max} item(s).`);
  }
  return value;
}

function string(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new CompactIntentValidationError(`invalid_${field}`, `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new CompactIntentValidationError(`invalid_${field}`, `${field} length is invalid.`);
  }
  return trimmed;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CompactIntentValidationError(`invalid_${field}`, `${field} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function oneOf<const T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw new CompactIntentValidationError(`invalid_${field}`, `${field} must be one of ${allowed.join(", ")}.`);
}

function outcome(value: unknown, field: string): ScratchOutcome {
  return oneOf(value, field, [
    "success",
    "failed",
    "rolled_back",
    "rollback_failed",
    "cancelled_by_operator",
    "timeout",
    "partial"
  ] as const);
}

function inputHash(value: unknown, field: string): string {
  const normalized = string(value, field, 8, 64).toLowerCase();
  if (!/^[a-f0-9]{8,64}$/.test(normalized)) {
    throw new CompactIntentValidationError(`invalid_${field}`, `${field} must be 8-64 hex chars.`);
  }
  return normalized;
}

async function readRawBody(request: IncomingMessage): Promise<string> {
  return readRequestBody(request, { trim: false });
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

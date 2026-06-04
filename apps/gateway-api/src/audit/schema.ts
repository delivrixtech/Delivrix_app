import type { AuditEvent } from "../../../../packages/domain/src/index.ts";

const schemaVersion = "2026-05-18.v1";
const actorTypes = new Set(["openclaw", "operator", "system", "collector"]);
const decisions = new Set(["allow", "reject", "n/a"]);
const rejectReasons = new Set([
  "unknown_action",
  "prohibited_action",
  "live_blocked_hito_5_11_b",
  "human_approval_missing",
  "kill_switch_armed",
  "approval_token_expired",
  "approval_replay_detected",
  "race_condition_detected",
  "schema_mismatch",
  "rate_limit_exceeded",
  "duplicate_proposal",
  "gateway_internal_error",
  "gateway_timeout",
  "memory_compaction_rejected"
]);
const killSwitchStates = new Set(["armed", "active", "unknown"]);
const riskLevels = new Set(["low", "medium", "high", "critical"]);

export class InvalidAuditEventError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.join("; "));
    this.errors = errors;
    this.name = "InvalidAuditEventError";
  }
}

export function validateAuditEvent(event: AuditEvent): void {
  const errors: string[] = [];

  if (!isUuid(event.id)) errors.push("id must be uuid");
  if (!isDateTime(event.occurredAt)) errors.push("occurredAt must be date-time");
  if (!actorTypes.has(event.actorType)) errors.push("actorType schema_mismatch");
  if (!isNonEmptyString(event.actorId, 128)) errors.push("actorId required");
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(event.action)) errors.push("action schema_mismatch");
  if (!isNonEmptyString(event.targetType, 64)) errors.push("targetType required");
  if (!isNonEmptyString(event.targetId, 256)) errors.push("targetId required");
  if (!riskLevels.has(event.riskLevel)) errors.push("riskLevel schema_mismatch");
  if (!decisions.has(event.decision)) errors.push("decision schema_mismatch");
  if (event.rejectReason !== null && !rejectReasons.has(event.rejectReason)) errors.push("rejectReason schema_mismatch");
  if (typeof event.humanApproved !== "boolean") errors.push("humanApproved required");
  if (!Array.isArray(event.approverIds) || event.approverIds.some((item) => typeof item !== "string")) {
    errors.push("approverIds schema_mismatch");
  }
  if (!killSwitchStates.has(event.killSwitchState)) errors.push("killSwitchState schema_mismatch");
  if (event.rollbackToken !== null && !isUuid(event.rollbackToken)) errors.push("rollbackToken schema_mismatch");
  if (event.schemaVersion !== schemaVersion) errors.push("schemaVersion schema_mismatch");
  if (event.promptVersion !== null && typeof event.promptVersion !== "string") errors.push("promptVersion schema_mismatch");
  if (event.modelVersion !== null && typeof event.modelVersion !== "string") errors.push("modelVersion schema_mismatch");
  if (!Array.isArray(event.evidenceRefs) || event.evidenceRefs.some((item) => typeof item !== "string")) {
    errors.push("evidenceRefs schema_mismatch");
  }
  if (!event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata)) {
    errors.push("metadata schema_mismatch");
  }
  if (!/^([a-f0-9]{64}|GENESIS)$/.test(event.prevHash)) errors.push("prevHash schema_mismatch");
  if (!/^[a-f0-9]{64}$/.test(event.hash)) errors.push("hash schema_mismatch");

  if (errors.length > 0) {
    throw new InvalidAuditEventError(errors);
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

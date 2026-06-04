import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AuditActorType,
  AuditDecision,
  AuditEvent,
  AuditEventInput,
  AuditKillSwitchState
} from "../../domain/src/index.ts";
import {
  computeAuditHash,
  GENESIS_PREV_HASH
} from "../../../apps/gateway-api/src/audit/hash-chain.ts";
import {
  InvalidAuditEventError,
  validateAuditEvent
} from "../../../apps/gateway-api/src/audit/schema.ts";
import { withFileLock } from "./json-file-store.ts";

export { InvalidAuditEventError };

export class LocalFileAuditLog {
  private readonly filePath: string;

  constructor(filePath = process.env.LOCAL_AUDIT_LOG_FILE ?? ".audit/audit-events.jsonl") {
    this.filePath = resolve(filePath);
  }

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const [event] = await this.appendMany([input]);
    if (!event) {
      throw new Error("audit append produced no event");
    }
    return event;
  }

  async appendMany(inputs: AuditEventInput[] | ((prevHash: string) => AuditEventInput[])): Promise<AuditEvent[]> {
    return withFileLock(this.filePath, async () => {
      let prevHash = await this.readLastHashFromDisk();
      const resolvedInputs = typeof inputs === "function" ? inputs(prevHash) : inputs;
      const events: AuditEvent[] = [];

      for (const input of resolvedInputs) {
        const event = this.fillDefaults(input, prevHash);
        event.hash = computeAuditHash(event as unknown as Record<string, unknown>, prevHash);
        validateAuditEvent(event);
        events.push(event);
        prevHash = event.hash;
      }

      if (events.length > 0) {
        await this.appendLines(events.map((event) => JSON.stringify(event)));
      }

      return events;
    });
  }

  async list(): Promise<AuditEvent[]> {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const raw = await readFile(this.filePath, "utf8");
    if (!raw.trim()) {
      return [];
    }

    if (raw.trimStart().startsWith("[")) {
      return JSON.parse(raw) as AuditEvent[];
    }

    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent);
  }

  getLastHashSync(): string {
    if (!existsSync(this.filePath)) {
      return GENESIS_PREV_HASH;
    }

    const raw = readFileSync(this.filePath, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const last = lines.at(-1);
    if (!last) {
      return GENESIS_PREV_HASH;
    }
    return (JSON.parse(last) as { hash?: string }).hash ?? GENESIS_PREV_HASH;
  }

  private fillDefaults(input: AuditEventInput, prevHash: string): AuditEvent {
    const metadata = isRecord(input.metadata) ? input.metadata : {};
    const rejectReason = normalizeRejectReason(input.rejectReason ?? metadata.rejectReason);
    const decision = normalizeDecision(input.decision ?? (rejectReason ? "reject" : "allow"));
    const evidenceRefs = Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.filter((item): item is string => typeof item === "string")
      : [];

    return {
      id: isUuid(input.id) ? input.id : randomUUID(),
      occurredAt: typeof input.occurredAt === "string" && !Number.isNaN(Date.parse(input.occurredAt))
        ? input.occurredAt
        : new Date().toISOString(),
      actorType: normalizeActorType(input.actorType),
      actorId: nonEmpty(input.actorId, "unknown-actor"),
      action: nonEmpty(input.action, "oc.audit.unknown_action"),
      targetType: nonEmpty(input.targetType, "unknown"),
      targetId: nonEmpty(input.targetId, "unknown"),
      riskLevel: input.riskLevel,
      metadata,
      decision,
      rejectReason,
      humanApproved: input.humanApproved ?? metadata.humanApproved === true,
      approverIds: Array.isArray(input.approverIds)
        ? input.approverIds.filter((item): item is string => typeof item === "string")
        : [],
      killSwitchState: normalizeKillSwitchState(input.killSwitchState),
      rollbackToken: isUuid(input.rollbackToken) ? input.rollbackToken : null,
      schemaVersion: "2026-05-18.v1",
      promptVersion: typeof input.promptVersion === "string"
        ? input.promptVersion
        : typeof metadata.promptVersion === "string" ? metadata.promptVersion : null,
      modelVersion: typeof input.modelVersion === "string"
        ? input.modelVersion
        : typeof metadata.modelVersion === "string" ? metadata.modelVersion : null,
      evidenceRefs,
      prevHash,
      hash: ""
    };
  }

  private async appendLines(lines: string[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
  }

  private async readLastHashFromDisk(): Promise<string> {
    if (!existsSync(this.filePath)) {
      return GENESIS_PREV_HASH;
    }

    const raw = await readFile(this.filePath, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const last = lines.at(-1);
    if (!last) {
      return GENESIS_PREV_HASH;
    }

    const event = JSON.parse(last) as { hash?: string };
    return event.hash ?? GENESIS_PREV_HASH;
  }
}

function normalizeActorType(value: unknown): AuditActorType {
  if (value === "system" || value === "operator" || value === "openclaw" || value === "collector") {
    return value;
  }
  if (value === "agent") {
    return "openclaw";
  }
  return "system";
}

function normalizeDecision(value: unknown): AuditDecision {
  if (value === "allow" || value === "reject" || value === "n/a") {
    return value;
  }
  return "allow";
}

function normalizeKillSwitchState(value: unknown): AuditKillSwitchState {
  if (value === "armed" || value === "active" || value === "unknown") {
    return value;
  }
  return "unknown";
}

function normalizeRejectReason(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const allowed = new Set([
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
  return allowed.has(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

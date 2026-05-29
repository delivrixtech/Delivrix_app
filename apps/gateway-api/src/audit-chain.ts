import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { AuditEvent } from "../../../packages/domain/src/index.ts";
import { computeAuditHash, GENESIS_PREV_HASH } from "./audit/hash-chain.ts";

export type AuditChainBreakReason =
  | "malformed_json"
  | "invalid_event"
  | "prev_hash_mismatch"
  | "hash_mismatch";

export interface AuditChainBrokenAt {
  /** One-based event position in the log. */
  seq: number;
  /** One-based JSONL line when the source is line-delimited. */
  line?: number;
  id?: string;
  reason: AuditChainBreakReason;
  expectedHash: string;
  actualHash: string;
  expectedPrevHash?: string;
  actualPrevHash?: string;
}

export interface AuditChainVerifyResult {
  ok: boolean;
  totalEvents: number;
  brokenAt?: AuditChainBrokenAt;
  emptyChain: boolean;
  lastHash: string;
  sourcePath: string;
}

export interface AuditChainBackupResult {
  sourcePath: string;
  backupPath: string;
  backupExists: boolean;
}

export interface AuditChainStoreOptions {
  filePath?: string;
  backupDir?: string;
}

export class AuditChainStore {
  private readonly filePath: string;
  private readonly backupDir: string;

  constructor(options: AuditChainStoreOptions = {}) {
    this.filePath = resolve(
      options.filePath ?? process.env.LOCAL_AUDIT_LOG_FILE ?? ".audit/audit-events.jsonl"
    );
    this.backupDir = resolve(options.backupDir ?? "runtime/audit-chain-backups");
  }

  async verify(): Promise<AuditChainVerifyResult> {
    return verifyAuditChainFile(this.filePath);
  }

  async backup(): Promise<AuditChainBackupResult> {
    return backupAuditChainFile({ sourcePath: this.filePath, backupDir: this.backupDir });
  }

  async backfillFromLocalFileAuditLog(
    sourcePath: string
  ): Promise<{ backfilled: number; backupPath: string; alreadyChained: true }> {
    const sourceStore = new AuditChainStore({ filePath: sourcePath, backupDir: this.backupDir });
    const [verify, backup] = await Promise.all([sourceStore.verify(), sourceStore.backup()]);
    if (!verify.ok) {
      throw new Error(`cannot backfill an invalid audit chain at seq ${verify.brokenAt?.seq ?? "unknown"}`);
    }
    return { backfilled: verify.totalEvents, backupPath: backup.backupPath, alreadyChained: true };
  }
}

export function createAuditChainStoreFromEnv(env: NodeJS.ProcessEnv = process.env): AuditChainStore {
  return new AuditChainStore({
    filePath: env.LOCAL_AUDIT_LOG_FILE,
    backupDir: env.AUDIT_CHAIN_BACKUP_DIR
  });
}

export async function verifyAuditChainFile(
  filePath = process.env.LOCAL_AUDIT_LOG_FILE ?? ".audit/audit-events.jsonl"
): Promise<AuditChainVerifyResult> {
  const resolved = resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(resolved, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyResult(resolved);
    }
    throw error;
  }

  if (!raw.trim()) {
    return emptyResult(resolved);
  }

  const parsed = parseAuditEvents(raw, resolved);
  if (!parsed.ok) {
    return parsed.result;
  }

  return verifyAuditChainEvents(parsed.events, resolved);
}

export function verifyAuditChainEvents(
  events: AuditEvent[],
  sourcePath = process.env.LOCAL_AUDIT_LOG_FILE ?? ".audit/audit-events.jsonl"
): AuditChainVerifyResult {
  const resolved = resolve(sourcePath);
  if (events.length === 0) {
    return emptyResult(resolved);
  }

  let expectedPrevHash = GENESIS_PREV_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const seq = index + 1;
    if (!isRecord(event)) {
      return {
        ok: false,
        totalEvents: events.length,
        brokenAt: {
          seq,
          line: seq,
          reason: "invalid_event",
          expectedHash: "object",
          actualHash: typeof event,
          expectedPrevHash,
          actualPrevHash: undefined
        },
        emptyChain: false,
        lastHash: expectedPrevHash,
        sourcePath: resolved
      };
    }

    const actualPrevHash = typeof event.prevHash === "string" ? event.prevHash : "";
    if (actualPrevHash !== expectedPrevHash) {
      return {
        ok: false,
        totalEvents: events.length,
        brokenAt: {
          seq,
          line: seq,
          id: typeof event.id === "string" ? event.id : undefined,
          reason: "prev_hash_mismatch",
          expectedHash: expectedPrevHash,
          actualHash: actualPrevHash,
          expectedPrevHash,
          actualPrevHash
        },
        emptyChain: false,
        lastHash: expectedPrevHash,
        sourcePath: resolved
      };
    }

    const expectedHash = computeAuditHash(event as unknown as Record<string, unknown>, expectedPrevHash);
    const actualHash = typeof event.hash === "string" ? event.hash : "";
    if (actualHash !== expectedHash) {
      return {
        ok: false,
        totalEvents: events.length,
        brokenAt: {
          seq,
          line: seq,
          id: typeof event.id === "string" ? event.id : undefined,
          reason: "hash_mismatch",
          expectedHash,
          actualHash,
          expectedPrevHash,
          actualPrevHash
        },
        emptyChain: false,
        lastHash: expectedPrevHash,
        sourcePath: resolved
      };
    }

    expectedPrevHash = actualHash;
  }

  return {
    ok: true,
    totalEvents: events.length,
    emptyChain: false,
    lastHash: expectedPrevHash,
    sourcePath: resolved
  };
}

export async function backupAuditChainFile(options: {
  sourcePath?: string;
  backupDir?: string;
  nowMs?: number;
} = {}): Promise<AuditChainBackupResult> {
  const sourcePath = resolve(options.sourcePath ?? process.env.LOCAL_AUDIT_LOG_FILE ?? ".audit/audit-events.jsonl");
  const backupDir = resolve(options.backupDir ?? "runtime/audit-chain-backups");
  const backupPath = resolve(
    backupDir,
    `${basename(sourcePath)}.backup-${options.nowMs ?? Date.now()}`
  );

  await mkdir(dirname(backupPath), { recursive: true });
  try {
    await copyFile(sourcePath, backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await writeFile(backupPath, "", { encoding: "utf-8", flag: "wx" });
  }

  return { sourcePath, backupPath, backupExists: true };
}

function parseAuditEvents(
  raw: string,
  sourcePath: string
): { ok: true; events: AuditEvent[] } | { ok: false; result: AuditChainVerifyResult } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return parseFailure(sourcePath, 1, "invalid_event", "array", typeof parsed);
      }
      return { ok: true, events: parsed as AuditEvent[] };
    } catch (error) {
      return parseFailure(sourcePath, 1, "malformed_json", "valid JSON array", errorMessage(error));
    }
  }

  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const events: AuditEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      events.push(JSON.parse(lines[index]!) as AuditEvent);
    } catch (error) {
      return {
        ok: false,
        result: {
          ok: false,
          totalEvents: lines.length,
          brokenAt: {
            seq: index + 1,
            line: index + 1,
            reason: "malformed_json",
            expectedHash: "valid JSON object",
            actualHash: errorMessage(error)
          },
          emptyChain: false,
          lastHash: GENESIS_PREV_HASH,
          sourcePath
        }
      };
    }
  }
  return { ok: true, events };
}

function parseFailure(
  sourcePath: string,
  seq: number,
  reason: AuditChainBreakReason,
  expectedHash: string,
  actualHash: string
): { ok: false; result: AuditChainVerifyResult } {
  return {
    ok: false,
    result: {
      ok: false,
      totalEvents: 0,
      brokenAt: { seq, line: seq, reason, expectedHash, actualHash },
      emptyChain: false,
      lastHash: GENESIS_PREV_HASH,
      sourcePath
    }
  };
}

function emptyResult(sourcePath: string): AuditChainVerifyResult {
  return {
    ok: true,
    totalEvents: 0,
    emptyChain: true,
    lastHash: GENESIS_PREV_HASH,
    sourcePath
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

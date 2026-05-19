import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const approvalTokenTtlMs = 5 * 60 * 1000;
const sqlitePath = process.env.GATEWAY_SQLITE_FILE ?? "runtime/gateway.sqlite";
const db = openApprovalDatabase(sqlitePath);

export type TokenRejectReason =
  | "token_signature_invalid"
  | "token_expired"
  | "token_nonce_unknown"
  | "token_replay_detected"
  | "token_target_mismatch";

export interface ApprovalToken {
  tokenId: string;
  actionId: string;
  targetType: string;
  targetId: string;
  approverId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

export interface ApprovalNonceRow {
  nonce: string;
  tokenId: string;
  actionId: string;
  targetType: string;
  targetId: string;
  approverId: string;
  status: string;
  issuedAt: string;
  expiresAt: string;
}

export function issueApprovalToken(params: {
  actionId: string;
  targetType: string;
  targetId: string;
  approverId: string;
}, now = new Date()): ApprovalToken {
  const secret = approvalSecret();
  const issuedAt = now;
  const expiresAt = new Date(issuedAt.getTime() + approvalTokenTtlMs);
  const base = {
    tokenId: randomUUID(),
    actionId: params.actionId,
    targetType: params.targetType,
    targetId: params.targetId,
    approverId: params.approverId,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    nonce: randomBytes(32).toString("hex")
  };
  const signature = createHmac("sha256", secret)
    .update(canonicalize(base))
    .digest("hex");

  db.prepare(`
    INSERT INTO approval_nonces (
      nonce,
      token_id,
      action_id,
      target_type,
      target_id,
      approver_id,
      status,
      issued_at,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?)
  `).run(
    base.nonce,
    base.tokenId,
    base.actionId,
    base.targetType,
    base.targetId,
    base.approverId,
    base.issuedAt,
    base.expiresAt
  );

  return { ...base, signature };
}

export function validateApprovalToken(
  token: ApprovalToken,
  ctx: { actionId: string; targetType: string; targetId: string },
  now = new Date()
): { ok: true } | { ok: false; rejectReason: TokenRejectReason } {
  const expected = createHmac("sha256", approvalSecret())
    .update(canonicalize(token))
    .digest("hex");

  if (!signaturesEqual(token.signature, expected)) {
    return { ok: false, rejectReason: "token_signature_invalid" };
  }

  if (
    token.actionId !== ctx.actionId ||
    token.targetType !== ctx.targetType ||
    token.targetId !== ctx.targetId
  ) {
    return { ok: false, rejectReason: "token_target_mismatch" };
  }

  if (Date.parse(token.expiresAt) <= now.getTime()) {
    expireApprovalNonce(token.nonce);
    return { ok: false, rejectReason: "token_expired" };
  }

  const row = db.prepare(`
    SELECT status
    FROM approval_nonces
    WHERE nonce = ?
  `).get(token.nonce) as { status: string } | undefined;

  if (!row) {
    return { ok: false, rejectReason: "token_nonce_unknown" };
  }

  if (row.status === "consumed") {
    return { ok: false, rejectReason: "token_replay_detected" };
  }

  if (row.status === "expired") {
    return { ok: false, rejectReason: "token_expired" };
  }

  const result = db.prepare(`
    UPDATE approval_nonces
    SET status = 'consumed'
    WHERE nonce = ? AND status = 'issued'
  `).run(token.nonce);

  if (result.changes === 0) {
    return { ok: false, rejectReason: "token_replay_detected" };
  }

  return { ok: true };
}

export function cleanupApprovalNonces(now = new Date()): void {
  db.prepare(`
    UPDATE approval_nonces
    SET status = 'expired'
    WHERE status = 'issued' AND expires_at < ?
  `).run(now.toISOString());

  db.prepare(`
    DELETE FROM approval_nonces
    WHERE status != 'consumed' AND expires_at < ?
  `).run(now.toISOString());

  db.prepare(`
    DELETE FROM approval_nonces
    WHERE status = 'consumed' AND expires_at < ?
  `).run(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString());
}

export function getApprovalNonceForToken(tokenId: string): ApprovalNonceRow | undefined {
  const row = db.prepare(`
    SELECT
      nonce,
      token_id AS tokenId,
      action_id AS actionId,
      target_type AS targetType,
      target_id AS targetId,
      approver_id AS approverId,
      status,
      issued_at AS issuedAt,
      expires_at AS expiresAt
    FROM approval_nonces
    WHERE token_id = ?
  `).get(tokenId) as ApprovalNonceRow | undefined;

  return row;
}

export function listApprovalNoncesForTarget(params: {
  targetType: string;
  targetId: string;
  actionId?: string;
  status?: string;
}): ApprovalNonceRow[] {
  const rows = db.prepare(`
    SELECT
      nonce,
      token_id AS tokenId,
      action_id AS actionId,
      target_type AS targetType,
      target_id AS targetId,
      approver_id AS approverId,
      status,
      issued_at AS issuedAt,
      expires_at AS expiresAt
    FROM approval_nonces
    WHERE target_type = ?
      AND target_id = ?
      AND (? IS NULL OR action_id = ?)
      AND (? IS NULL OR status = ?)
    ORDER BY issued_at ASC
  `).all(
    params.targetType,
    params.targetId,
    params.actionId ?? null,
    params.actionId ?? null,
    params.status ?? null,
    params.status ?? null
  ) as ApprovalNonceRow[];

  return rows;
}

export function reconstructApprovalToken(row: ApprovalNonceRow): ApprovalToken {
  const base = {
    tokenId: row.tokenId,
    actionId: row.actionId,
    targetType: row.targetType,
    targetId: row.targetId,
    approverId: row.approverId,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    nonce: row.nonce
  };
  const signature = createHmac("sha256", approvalSecret())
    .update(canonicalize(base))
    .digest("hex");

  return {
    ...base,
    signature
  };
}

function canonicalize(token: Omit<ApprovalToken, "signature">): string {
  return JSON.stringify({
    actionId: token.actionId,
    approverId: token.approverId,
    expiresAt: token.expiresAt,
    issuedAt: token.issuedAt,
    nonce: token.nonce,
    targetId: token.targetId,
    targetType: token.targetType,
    tokenId: token.tokenId
  });
}

function openApprovalDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  const migration = readFileSync(
    new URL("../../migrations/0007_approval_nonces.sql", import.meta.url),
    "utf8"
  );
  database.exec(migration);
  return database;
}

function expireApprovalNonce(nonce: string): void {
  db.prepare(`
    UPDATE approval_nonces
    SET status = 'expired'
    WHERE nonce = ? AND status = 'issued'
  `).run(nonce);
}

function approvalSecret(): string {
  const secret = process.env.OPENCLAW_HMAC_SECRET ?? "";

  if (!secret) {
    throw new Error("OPENCLAW_HMAC_SECRET is not configured.");
  }

  return secret;
}

function signaturesEqual(signature: string, expected: string): boolean {
  if (!/^[a-f0-9]+$/i.test(signature)) {
    return false;
  }

  const actualBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

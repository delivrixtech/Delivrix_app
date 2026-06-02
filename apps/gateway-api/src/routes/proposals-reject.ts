import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEvent,
  AuditEventInput,
  AuditRiskLevel,
  CanvasLiveArtifactSnapshot
} from "../../../../packages/domain/src/index.ts";
import { validateOpenClawHmac } from "../security/hmac.ts";
import type { AuditChainVerifyResult } from "../audit-chain.ts";
import type { ProposalSignStoredProposal } from "./proposals-sign.ts";
import { readRequestBody } from "../request-body.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<AuditEvent>;
  list?(): Promise<AuditEvent[]>;
}

interface AuditChainVerifier {
  verify(): Promise<AuditChainVerifyResult>;
}

interface CanvasStateWriter {
  upsertArtifact(input: CanvasLiveArtifactSnapshot): Promise<unknown>;
}

interface WebhookBroadcaster {
  broadcast(event: AuditEventInput): Promise<unknown>;
}

interface KillSwitchState {
  enabled: boolean;
}

export interface HandleProposalRejectDeps {
  request: IncomingMessage;
  response: ServerResponse;
  proposalId: string;
  auditLog: AuditSink;
  auditChain: AuditChainVerifier;
  proposalsStore: ProposalSignStoredProposal[];
  canvasState: CanvasStateWriter;
  webhookBroadcaster?: WebhookBroadcaster;
  readKillSwitch: () => Promise<KillSwitchState> | KillSwitchState;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface RejectBody {
  actorId?: unknown;
  reason?: unknown;
}

export async function handleProposalReject(deps: HandleProposalRejectDeps): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const killSwitch = await deps.readKillSwitch();
  if (killSwitch.enabled) {
    return json(deps.response, 423, {
      ok: false,
      rejectReason: "kill_switch_armed"
    });
  }

  if (!isUuidV4(deps.proposalId)) {
    return json(deps.response, 400, {
      ok: false,
      rejectReason: "schema_mismatch",
      details: "proposalId must be a UUID v4."
    });
  }

  const { raw, body } = await readRawBodyAndJson<RejectBody>(deps.request);
  const parsed = parseRejectBody(body);
  if (!parsed.ok) {
    return json(deps.response, 400, {
      ok: false,
      rejectReason: "schema_mismatch",
      details: parsed.details
    });
  }

  const auth = validateRequestAuth({
    request: deps.request,
    raw,
    env: deps.env
  });
  if (!auth.ok) {
    return json(deps.response, 401, {
      ok: false,
      rejectReason: auth.rejectReason,
      details: auth.details
    });
  }

  const proposal = deps.proposalsStore.find((candidate) => candidate.id === deps.proposalId);
  if (!proposal) {
    return json(deps.response, 404, {
      ok: false,
      rejectReason: "proposal_not_found"
    });
  }

  if (proposal.status !== "pending") {
    return json(deps.response, 409, {
      ok: false,
      rejectReason: "proposal_not_pending",
      currentStatus: proposal.status
    });
  }

  const chain = await deps.auditChain.verify();
  if (!chain.ok) {
    return json(deps.response, 503, {
      ok: false,
      rejectReason: "audit_chain_broken",
      lastValidSeq: chain.brokenAt ? chain.brokenAt.seq - 1 : chain.totalEvents
    });
  }

  const rejectedInput: AuditEventInput = {
    actorType: "operator",
    actorId: parsed.actorId,
    action: "oc.proposal.rejected",
    targetType: "proposal",
    targetId: proposal.id,
    riskLevel: riskLevelFromProposalSeverity(proposal.severity),
    decision: "reject",
    humanApproved: false,
    metadata: {
      reason: parsed.reason,
      skillSlug: proposal.skillSlug ?? proposal.category,
      authMode: auth.authMode,
      chainPrevHash: chain.lastHash
    }
  };
  await deps.auditLog.append(rejectedInput);

  proposal.status = "rejected";
  proposal.rejectedAt = now.toISOString();
  proposal.rejectionReason = parsed.reason;

  await deps.canvasState.upsertArtifact(rejectedArtifactSnapshot({
    proposal,
    actorId: parsed.actorId,
    reason: parsed.reason,
    now
  }));

  const webhookBroadcast = await deps.webhookBroadcaster?.broadcast(rejectedInput).catch((error) => ({
    delivered: false,
    buffered: false,
    error: errorMessage(error)
  }));

  return json(deps.response, 200, {
    ok: true,
    status: "rejected",
    proposalId: proposal.id,
    rejectedAt: proposal.rejectedAt,
    webhookBroadcast: webhookBroadcast ?? null
  });
}

function parseRejectBody(body: RejectBody | null): { ok: true; actorId: string; reason: string } | { ok: false; details: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, details: "Request body must be a JSON object." };
  }
  const actorId = normalizeActorId(body.actorId);
  if (!actorId) {
    return { ok: false, details: "actorId must be 3-64 chars and use operator-safe characters." };
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10 || reason.length > 500) {
    return { ok: false, details: "reason must be 10-500 chars." };
  }
  return { ok: true, actorId, reason };
}

function validateRequestAuth(input: {
  request: IncomingMessage;
  raw: string;
  env?: Record<string, string | undefined>;
}): { ok: true; authMode: "hmac" | "local_unsigned_panel" } | {
  ok: false;
  rejectReason: "signature_invalid" | "signature_required";
  details: string;
} {
  if (hasOpenClawSignature(input.request)) {
    const hmac = validateOpenClawHmac(input.request.headers, input.raw);
    return hmac.ok
      ? { ok: true, authMode: "hmac" }
      : { ok: false, rejectReason: "signature_invalid", details: hmac.rejectReason };
  }

  if (allowsUnsignedLocalPanel(input.request, input.env)) {
    return { ok: true, authMode: "local_unsigned_panel" };
  }

  return {
    ok: false,
    rejectReason: "signature_required",
    details: "Missing x-openclaw-signature for proposal rejection."
  };
}

function allowsUnsignedLocalPanel(request: IncomingMessage, env?: Record<string, string | undefined>): boolean {
  if (env?.OPENCLAW_SIGN_ALLOW_UNSIGNED_LOCAL_PANEL !== "true") return false;
  if (env?.NODE_ENV === "production") return false;
  if (!isLoopbackRemoteAddress(request.socket?.remoteAddress)) return false;
  const origin = headerString(request.headers.origin);
  return !!origin && /^https?:\/\/(127\.0\.0\.1|localhost):5173$/i.test(origin);
}

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1";
}

function normalizeActorId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\//g, "-");
  if (!/^[a-z0-9._-]{3,64}$/.test(normalized)) return null;
  return normalized;
}

function rejectedArtifactSnapshot(input: {
  proposal: ProposalSignStoredProposal;
  actorId: string;
  reason: string;
  now: Date;
}): CanvasLiveArtifactSnapshot {
  const base = input.proposal.artifactSnapshot;
  const nowIso = input.now.toISOString();
  return {
    artifactId: base?.artifactId ?? `proposal-${input.proposal.id}`,
    taskId: base?.taskId ?? `proposal-${input.proposal.id}`,
    kind: base?.kind ?? "proposal",
    title: base?.title ?? input.proposal.headline ?? `Proposal ${input.proposal.id}`,
    editable: base?.editable ?? true,
    createdAt: base?.createdAt ?? nowIso,
    updatedAt: nowIso,
    approvalStatus: "rejected",
    rejectedBy: input.actorId,
    rejectedAt: nowIso,
    rejectionReason: input.reason,
    blocks: base?.blocks?.length
      ? base.blocks
      : [{
          blockId: "summary",
          order: 1,
          kind: "paragraph",
          content: input.proposal.body ?? input.proposal.category,
          editable: true,
          status: "complete",
          updatedAt: nowIso
        }]
  };
}

function riskLevelFromProposalSeverity(severity: ProposalSignStoredProposal["severity"]): AuditRiskLevel {
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

function hasOpenClawSignature(request: IncomingMessage): boolean {
  return typeof request.headers["x-openclaw-signature"] === "string" ||
    Array.isArray(request.headers["x-openclaw-signature"]);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readRawBodyAndJson<T>(request: IncomingMessage): Promise<{ raw: string; body: T | null }> {
  const raw = await readRequestBody(request, { trim: false });
  if (!raw.trim()) return { raw, body: null };
  try {
    return { raw, body: JSON.parse(raw) as T };
  } catch {
    return { raw, body: null };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown proposal reject error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

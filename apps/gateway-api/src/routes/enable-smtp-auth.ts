import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { readRequestBody } from "../request-body.ts";
import {
  findSmtpCredentialRecord,
  smtpCredentialFingerprint
} from "../smtp-credentials.ts";
import {
  listSmtpSaslRetrofitCandidates,
  runSmtpSaslRetrofitBatch
} from "./smtp-sasl-retrofit.ts";
import type { SmtpSshRunner } from "./smtp-provisioning.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface EnableSmtpAuthRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  auditLog: AuditSink;
  sshRunner: SmtpSshRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface EnableSmtpAuthBody {
  actorId?: unknown;
  domain?: unknown;
}

type EnableSmtpAuthStatus =
  | "configured"
  | "already_configured"
  | "no_candidate"
  | "ambiguous_domain"
  | "pending_ssh"
  | "credential_encryption_key_missing"
  | "install_failed"
  | "failed";

export async function handleEnableSmtpAuthHttp(deps: EnableSmtpAuthRouteDeps): Promise<void> {
  if (deps.request.method !== "POST") {
    json(deps.response, 405, { error: "method_not_allowed" });
    return;
  }

  let body: EnableSmtpAuthBody;
  try {
    body = await readJson<EnableSmtpAuthBody>(deps.request);
  } catch (error) {
    json(deps.response, 400, {
      error: "invalid_json",
      message: error instanceof Error ? error.message : "Request body must be valid JSON."
    });
    return;
  }

  const domain = normalizeDomain(body.domain);
  if (!domain) {
    json(deps.response, 422, {
      ok: false,
      error: "invalid_enable_smtp_auth_request",
      message: "domain must be a valid DNS domain."
    });
    return;
  }

  const actorId = typeof body.actorId === "string" && body.actorId.trim()
    ? body.actorId.trim()
    : "openclaw/enable_smtp_auth";
  const target = { domain };
  const candidates = await listSmtpSaslRetrofitCandidates(deps.workspace, target);
  if (candidates.length > 1) {
    await appendEnableAudit(deps, {
      actorId,
      domain,
      status: "ambiguous_domain",
      hasCredential: false,
      candidateCount: candidates.length
    });
    json(deps.response, 409, {
      ok: false,
      domain,
      status: "ambiguous_domain",
      hasCredential: false
    });
    return;
  }

  const result = candidates.length === 1
    ? await runSmtpSaslRetrofitBatch({
      workspace: deps.workspace,
      auditLog: deps.auditLog,
      sshRunner: deps.sshRunner,
      env: deps.env,
      actorId,
      target,
      now: deps.now
    })
    : { candidates: 0, results: [] };
  const outcome = result.results[0];
  const record = await findSmtpCredentialRecord(deps.workspace, domain);
  const hasCredential = record?.status === "configured";
  const credentialFingerprint = hasCredential && record
    ? smtpCredentialFingerprint(record)
    : undefined;
  const status = enableSmtpAuthStatus({ outcome, hasCredential });
  const ok = status === "configured" || status === "already_configured";

  await appendEnableAudit(deps, {
    actorId,
    domain,
    status,
    hasCredential,
    credentialFingerprint,
    candidateCount: result.candidates
  });

  json(deps.response, ok ? 200 : 409, {
    ok,
    domain,
    status,
    hasCredential
  });
}

function enableSmtpAuthStatus(input: {
  outcome?: { status: "configured" | "pending_ssh" | "failed"; error?: string; failedStep?: string };
  hasCredential: boolean;
}): EnableSmtpAuthStatus {
  if (input.outcome?.status === "configured" && input.hasCredential) return "configured";
  if (input.outcome?.status === "pending_ssh") return "pending_ssh";
  if (input.outcome?.status === "failed") {
    if (input.outcome.error === "credential_encryption_key_missing") {
      return "credential_encryption_key_missing";
    }
    return input.outcome.failedStep ? "install_failed" : "failed";
  }
  return input.hasCredential ? "already_configured" : "no_candidate";
}

async function appendEnableAudit(
  deps: EnableSmtpAuthRouteDeps,
  input: {
    actorId: string;
    domain: string;
    status: EnableSmtpAuthStatus;
    hasCredential: boolean;
    credentialFingerprint?: string;
    candidateCount: number;
  }
): Promise<void> {
  await deps.auditLog.append({
    actorType: "operator",
    actorId: input.actorId,
    action: "oc.smtp_auth.enabled",
    targetType: "domain",
    targetId: input.domain,
    riskLevel: "critical",
    decision: input.hasCredential ? "allow" : "reject",
    humanApproved: true,
    approverIds: [input.actorId],
    metadata: {
      domain: input.domain,
      status: input.status,
      hasCredential: input.hasCredential,
      candidateCount: input.candidateCount,
      ...(input.credentialFingerprint ? { credentialFingerprint: input.credentialFingerprint } : {})
    }
  });
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request, { maxBytes: 16_384 });
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(domain)
    ? domain
    : null;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

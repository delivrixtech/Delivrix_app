import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  decryptSmtpCredentialForDownload,
  listSmtpCredentialPublicMetadata,
  renderSmtpCredentialMarkdown,
  SmtpCredentialError,
  smtpCredentialFingerprint
} from "../smtp-credentials.ts";
import { operatorIdFromHeaders } from "../security/gateway-mutation-auth.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface SmtpCredentialRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  auditLog: AuditSink;
  readBoundaryToken?: string;
  rateLimitPerMinute?: number;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export async function handleSmtpCredentialDownloadHttp(
  deps: SmtpCredentialRouteDeps
): Promise<void> {
  if (deps.request.method !== "GET") {
    json(deps.response, 405, { error: "method_not_allowed" });
    return;
  }

  const domain = domainFromDownloadPath(deps.request.url ?? "");
  if (!domain) {
    json(deps.response, 400, { error: "invalid_smtp_credential_domain" });
    return;
  }

  const auth = authorizeSensitiveRead(
    deps.request,
    {
      readBoundaryToken: deps.readBoundaryToken,
      rateLimitPerMinute: deps.rateLimitPerMinute,
      now: deps.now
    },
    `smtp_credential_download:${domain}`
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  try {
    const material = await decryptSmtpCredentialForDownload({
      workspace: deps.workspace,
      env: deps.env,
      domain
    });
    const markdown = renderSmtpCredentialMarkdown({
      record: material.record,
      password: material.password,
      generatedAt: (deps.now?.() ?? new Date()).toISOString()
    });
    const actorId = operatorIdFromHeaders(deps.request.headers) ?? "operator/read-boundary";
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.smtp_credential.downloaded",
      targetType: "domain",
      targetId: material.record.domain,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        domain: material.record.domain,
        serverSlug: material.record.serverSlug ?? null,
        host: material.record.host,
        username: material.record.username,
        ports: material.record.ports,
        credentialFingerprint: smtpCredentialFingerprint(material.record)
      }
    });

    deps.response.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${credentialFileName(material.record.domain)}"`,
      "cache-control": "no-store"
    });
    deps.response.end(markdown);
  } catch (error) {
    if (error instanceof SmtpCredentialError) {
      json(deps.response, statusForCredentialError(error.code), { error: error.code });
      return;
    }
    json(deps.response, 500, {
      error: "smtp_credential_download_failed",
      message: error instanceof Error ? error.message : "unknown error"
    });
  }
}

export async function handleSmtpCredentialInventoryExportHttp(
  deps: SmtpCredentialRouteDeps
): Promise<void> {
  if (deps.request.method !== "GET") {
    json(deps.response, 405, { error: "method_not_allowed" });
    return;
  }

  const auth = authorizeSensitiveRead(
    deps.request,
    {
      readBoundaryToken: deps.readBoundaryToken,
      rateLimitPerMinute: deps.rateLimitPerMinute,
      now: deps.now
    },
    "smtp_credential_inventory_export"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  const credentials = await listSmtpCredentialPublicMetadata(deps.workspace);
  const actorId = operatorIdFromHeaders(deps.request.headers) ?? "operator/read-boundary";
  await deps.auditLog.append({
    actorType: "operator",
    actorId,
    action: "oc.smtp_credential.inventory_exported",
    targetType: "sender_pool",
    targetId: "smtp_credentials",
    riskLevel: "medium",
    decision: "allow",
    humanApproved: true,
    approverIds: [actorId],
    metadata: {
      credentialCount: credentials.length,
      configuredCount: credentials.filter((credential) => credential.hasCredential).length,
      domains: credentials.map((credential) => credential.domain)
    }
  });

  json(deps.response, 200, {
    credentials,
    generatedAt: (deps.now?.() ?? new Date()).toISOString()
  });
}

function domainFromDownloadPath(rawUrl: string): string | null {
  const url = new URL(rawUrl || "/", "http://localhost");
  const match = url.pathname.match(/^\/v1\/sender-pool\/credentials\/([^/]+)\/download$/);
  if (!match) return null;
  try {
    const domain = decodeURIComponent(match[1] ?? "").trim().toLowerCase().replace(/\.$/, "");
    return isValidDomain(domain) ? domain : null;
  } catch {
    return null;
  }
}

function isValidDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(value);
}

function credentialFileName(domain: string): string {
  return `smtp-credentials-${domain.replace(/[^a-z0-9.-]/gi, "_")}.md`;
}

function statusForCredentialError(code: string): number {
  if (code === "smtp_credential_not_found") return 404;
  if (code === "smtp_credential_not_ready") return 409;
  if (code === "smtp_credential_domain_invalid") return 400;
  if (code === "credential_encryption_key_missing" || code === "credential_encryption_key_invalid") return 503;
  return 500;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

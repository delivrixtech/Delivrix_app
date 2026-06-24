import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import {
  approvalTokenHash,
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken
} from "../approval-guard.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { readRequestBody } from "../request-body.ts";
import { operatorIdFromHeaders } from "../security/gateway-mutation-auth.ts";
import {
  renderDovecotAuthConf,
  renderDovecotLoggingConf,
  renderDovecotMasterConf,
  renderDovecotPasswdConf,
  renderPostfixMasterServiceCommands
} from "../smtp-sasl-config.ts";
import { smtpHostForDomain } from "../smtp-naming.ts";
import {
  findSmtpCredentialRecord,
  markSmtpCredentialInstallFailed,
  markSmtpCredentialConfigured,
  prepareSmtpCredential,
  publicSmtpCredentialMetadata,
  saveSmtpCredentialRecord,
  smtpCredentialFingerprint,
  type SmtpCredentialPublicMetadata
} from "../smtp-credentials.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";
import type { SmtpSshRunner } from "./smtp-provisioning.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface SmtpProvisioningInventory {
  servers?: Array<{
    serverSlug: string;
    domain: string;
    serverIp: string;
    selector: string;
    status: "configured";
    tlsStatus: "attempted_or_pending_dns";
    smtpAuthStatus?: "configured";
    smtpCredential?: SmtpCredentialPublicMetadata;
    configuredAt: string;
    updatedAt: string;
  }>;
}

export interface SmtpSaslRetrofitCandidate {
  serverSlug: string;
  domain: string;
  serverIp: string;
  selector: string;
  reason: "missing_smtp_auth" | "missing_credential" | "rotate";
}

export interface SmtpSaslRetrofitStep {
  label: string;
  command: string;
  auditCommand: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface SmtpSaslRetrofitResult {
  serverSlug: string;
  domain: string;
  status: "configured" | "pending_ssh" | "failed";
  stepCount: number;
  failedStep?: string;
  error?: string;
}

export interface SmtpSaslRetrofitBatchResult {
  candidates: number;
  results: SmtpSaslRetrofitResult[];
}

export interface SmtpProvisioningCredentialFlagReconciliationResult {
  scanned: number;
  staleDowngraded: number;
}

export interface SmtpSaslRetrofitRouteDeps {
  request: IncomingMessage;
  response: ServerResponse;
  workspace: OpenClawWorkspace;
  auditLog: AuditSink;
  sshRunner: SmtpSshRunner;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  readBoundaryToken?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface SmtpSaslRetrofitBody {
  actorId?: unknown;
  approvalToken?: unknown;
  domain?: unknown;
  serverSlug?: unknown;
  mode?: unknown;
}

export type SmtpSaslRetrofitMode = "enable" | "recover" | "rotate";

const approvalMaxAgeMs = 15 * 60 * 1000;

export async function handleSmtpSaslRetrofitBatchHttp(
  deps: SmtpSaslRetrofitRouteDeps
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  if (deps.request.method !== "POST") {
    json(deps.response, 405, { error: "method_not_allowed" });
    return;
  }

  const auth = authorizeSensitiveRead(
    deps.request,
    { readBoundaryToken: deps.readBoundaryToken, now: deps.now },
    "smtp_sasl_retrofit_batch"
  );
  if (!auth.ok) {
    json(deps.response, auth.statusCode, { error: auth.error });
    return;
  }

  let body: SmtpSaslRetrofitBody;
  try {
    body = await readJson<SmtpSaslRetrofitBody>(deps.request);
  } catch (error) {
    json(deps.response, 400, {
      error: "invalid_json",
      message: error instanceof Error ? error.message : "Request body must be valid JSON."
    });
    return;
  }

  const actorId = stringOrDefault(body.actorId, operatorIdFromHeaders(deps.request.headers) ?? "operator/read-boundary");
  const approvalToken = stringOrDefault(body.approvalToken, "");
  const targetParse = retrofitTargetFromBody(body);
  if (!targetParse.ok) {
    json(deps.response, 422, { error: "invalid_smtp_sasl_retrofit_request", message: targetParse.error });
    return;
  }
  const mode = smtpSaslRetrofitModeFromBody(body);
  if (mode === "rotate" && !targetParse.target.domain && !targetParse.target.serverSlug) {
    json(deps.response, 422, {
      error: "invalid_smtp_sasl_retrofit_request",
      message: "mode=rotate requires domain or serverSlug."
    });
    return;
  }
  const target = targetParse.target;
  if (!approvalToken) {
    json(deps.response, 422, { error: "invalid_smtp_sasl_retrofit_request", message: "approvalToken is required." });
    return;
  }
  const approval = await findRecentRetrofitApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  if (!approval) {
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.smtp_sasl.retrofit_batch_blocked",
      targetType: "sender_pool",
      targetId: "smtp_sasl_retrofit",
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        reason: "approval_not_found_or_expired",
        approvalTokenHash: approvalTokenHash(approvalToken)
      }
    });
    json(deps.response, 403, { error: "approval_not_found_or_expired" });
    return;
  }

  await deps.auditLog.append({
    actorType: "operator",
    actorId,
    action: "oc.smtp_sasl.retrofit_batch_requested",
    targetType: "sender_pool",
    targetId: "smtp_sasl_retrofit",
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: [actorId],
    metadata: {
      approvalArtifactId: approval.artifactId,
      approvalTokenHash: approvalTokenHash(approvalToken),
      mode,
      ...(target.domain ? { domain: target.domain } : {}),
      ...(target.serverSlug ? { serverSlug: target.serverSlug } : {})
    }
  });

  const result = await runSmtpSaslRetrofitBatch({
    workspace: deps.workspace,
    auditLog: deps.auditLog,
    sshRunner: deps.sshRunner,
    env: deps.env,
    actorId,
    target,
    mode,
    now: deps.now
  });

  await deps.auditLog.append({
    actorType: "operator",
    actorId,
    action: "oc.smtp_sasl.retrofit_batch_completed",
    targetType: "sender_pool",
    targetId: "smtp_sasl_retrofit",
    riskLevel: "critical",
    decision: result.results.some((entry) => entry.status === "failed") ? "reject" : "allow",
    humanApproved: true,
    approverIds: [actorId],
    metadata: {
      approvalArtifactId: approval.artifactId,
      approvalTokenHash: approvalTokenHash(approvalToken),
      mode,
      ...(target.domain ? { domain: target.domain } : {}),
      ...(target.serverSlug ? { serverSlug: target.serverSlug } : {}),
      candidates: result.candidates,
      configured: result.results.filter((entry) => entry.status === "configured").length,
      pendingSsh: result.results.filter((entry) => entry.status === "pending_ssh").length,
      failed: result.results.filter((entry) => entry.status === "failed").length
    }
  });

  json(deps.response, 200, {
    ok: true,
    status: "completed",
    mode,
    ...result
  });
}

export async function listSmtpSaslRetrofitCandidates(
  workspace: OpenClawWorkspace,
  target: SmtpSaslRetrofitTarget = {},
  mode: SmtpSaslRetrofitMode = "enable"
): Promise<SmtpSaslRetrofitCandidate[]> {
  const inventory = await workspace.readInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json").catch(() => null);
  const servers = (inventory?.servers ?? [])
    .filter((server) => server.status === "configured")
    .filter((server) => target.domain ? server.domain.toLowerCase() === target.domain : true)
    .filter((server) => target.serverSlug ? server.serverSlug === target.serverSlug : true);

  const candidates = await Promise.all(servers.map(async (server) => {
    const hasCredential = await hasConfiguredSmtpCredential(workspace, server);
    if (!shouldRetrofitServer(server, mode, hasCredential)) {
      return null;
    }
    return {
      serverSlug: server.serverSlug,
      domain: server.domain,
      serverIp: server.serverIp,
      selector: server.selector,
      reason: retrofitReason(server, mode)
    };
  }));

  return candidates.filter((candidate): candidate is SmtpSaslRetrofitCandidate => candidate !== null);
}

type SmtpProvisioningServer = NonNullable<SmtpProvisioningInventory["servers"]>[number];

function shouldRetrofitServer(
  server: SmtpProvisioningServer,
  mode: SmtpSaslRetrofitMode,
  hasCredential: boolean
): boolean {
  const hasConfiguredAuth = server.smtpAuthStatus === "configured";
  if (mode === "rotate") return hasConfiguredAuth;
  if (mode === "recover") return hasConfiguredAuth && !hasCredential;
  return !hasConfiguredAuth || !hasCredential;
}

async function hasConfiguredSmtpCredential(
  workspace: OpenClawWorkspace,
  server: SmtpProvisioningServer
): Promise<boolean> {
  const record = await findSmtpCredentialRecord(workspace, server.domain, server.serverSlug);
  return record?.status === "configured";
}

export async function reconcileSmtpProvisioningCredentialFlags(
  workspace: OpenClawWorkspace,
  now: () => Date = () => new Date()
): Promise<SmtpProvisioningCredentialFlagReconciliationResult> {
  const inventory = await workspace.readInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json").catch(() => null);
  const servers = inventory?.servers ?? [];
  let staleDowngraded = 0;
  const staleServerKeys = new Set<string>();

  for (const server of servers) {
    if (server.status !== "configured" || !server.smtpCredential || server.smtpCredential.hasCredential === false) {
      continue;
    }
    const hasCredential = await hasConfiguredSmtpCredential(workspace, server);
    if (!hasCredential) {
      staleServerKeys.add(smtpProvisioningServerKey(server));
    }
  }

  if (staleServerKeys.size === 0) {
    return { scanned: servers.length, staleDowngraded: 0 };
  }

  const updatedAt = now().toISOString();
  await workspace.updateInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json", (current) => {
    const currentServers = current?.servers ?? [];
    return {
      ...(current ?? {}),
      servers: currentServers.map((server) => {
        if (!staleServerKeys.has(smtpProvisioningServerKey(server))) {
          return server;
        }
        staleDowngraded += 1;
        return {
          ...server,
          smtpCredential: {
            ...server.smtpCredential,
            hasCredential: false
          },
          updatedAt
        };
      })
    };
  });

  return { scanned: servers.length, staleDowngraded };
}

function smtpProvisioningServerKey(server: Pick<SmtpProvisioningServer, "serverSlug" | "domain">): string {
  return `${server.serverSlug}\0${server.domain.toLowerCase()}`;
}

function retrofitReason(
  server: SmtpProvisioningServer,
  mode: SmtpSaslRetrofitMode
): SmtpSaslRetrofitCandidate["reason"] {
  if (mode === "rotate") return "rotate";
  return server.smtpAuthStatus !== "configured" ? "missing_smtp_auth" : "missing_credential";
}

export async function runSmtpSaslRetrofitBatch(input: {
  workspace: OpenClawWorkspace;
  auditLog: AuditSink;
  sshRunner: SmtpSshRunner;
  env?: Record<string, string | undefined>;
  actorId: string;
  target?: SmtpSaslRetrofitTarget;
  mode?: SmtpSaslRetrofitMode;
  now?: () => Date;
}): Promise<SmtpSaslRetrofitBatchResult> {
  const mode = input.mode ?? "enable";
  const candidates = await listSmtpSaslRetrofitCandidates(input.workspace, input.target, mode);
  const results: SmtpSaslRetrofitResult[] = [];

  for (const candidate of candidates) {
    if (!input.sshRunner.isConfigured()) {
      results.push({
        serverSlug: candidate.serverSlug,
        domain: candidate.domain,
        status: "pending_ssh",
        stepCount: 0,
        error: "smtp_ssh_runner_missing"
      });
      await appendRetrofitAudit(input.auditLog, input.actorId, candidate, "pending_ssh", 0, "smtp_ssh_runner_missing");
      continue;
    }

    try {
      const credential = await prepareSmtpCredential({
        workspace: input.workspace,
        env: input.env,
        domain: candidate.domain,
        serverSlug: candidate.serverSlug,
        host: smtpHostForDomain(candidate.domain),
        now: input.now,
        forceRotate: mode === "rotate"
      });
      await saveSmtpCredentialRecord(input.workspace, credential.record);
      const plan = buildSmtpSaslRetrofitPlan({
        domain: candidate.domain,
        username: credential.record.username,
        password: credential.password
      });

      let completedSteps = 0;
      let failedStep: string | undefined;
      try {
        for (const step of plan) {
          try {
            await input.sshRunner.run({
              serverSlug: candidate.serverSlug,
              serverIp: candidate.serverIp,
              command: step.command,
              stdin: step.stdin,
              timeoutMs: step.timeoutMs
            });
            completedSteps += 1;
          } catch (error) {
            failedStep = step.label;
            throw error;
          }
        }
      } catch (error) {
        await saveSmtpCredentialRecord(
          input.workspace,
          markSmtpCredentialInstallFailed(credential.record, input.now?.() ?? new Date())
        );
        const message = redactSmtpCredentialSecret(errorMessage(error), credential.password);
        results.push({
          serverSlug: candidate.serverSlug,
          domain: candidate.domain,
          status: "failed",
          stepCount: completedSteps,
          failedStep,
          error: message
        });
        await appendRetrofitAudit(input.auditLog, input.actorId, candidate, "failed", completedSteps, message, undefined, failedStep);
        continue;
      }

      const configuredRecord = markSmtpCredentialConfigured(credential.record, input.now?.() ?? new Date());
      await saveSmtpCredentialRecord(input.workspace, configuredRecord);
      await markSmtpProvisioningAuthConfigured(input.workspace, candidate, {
        smtpCredential: publicSmtpCredentialMetadata(configuredRecord),
        updatedAt: (input.now?.() ?? new Date()).toISOString()
      });
      results.push({
        serverSlug: candidate.serverSlug,
        domain: candidate.domain,
        status: "configured",
        stepCount: plan.length
      });
      await appendRetrofitAudit(
        input.auditLog,
        input.actorId,
        candidate,
        "configured",
        plan.length,
        undefined,
        smtpCredentialFingerprint(configuredRecord)
      );
    } catch (error) {
      const message = errorMessage(error);
      results.push({
        serverSlug: candidate.serverSlug,
        domain: candidate.domain,
        status: "failed",
        stepCount: 0,
        error: message
      });
      await appendRetrofitAudit(input.auditLog, input.actorId, candidate, "failed", 0, message);
    }
  }

  return {
    candidates: candidates.length,
    results
  };
}

export function buildSmtpSaslRetrofitPlan(input: {
  domain: string;
  username: string;
  password: string;
}): SmtpSaslRetrofitStep[] {
  return [
    {
      label: "install-dovecot",
      command: "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y dovecot-core",
      auditCommand: "apt-get update -qq && apt-get install dovecot-core",
      timeoutMs: 300_000
    },
    {
      label: "write-dovecot-auth-conf",
      command: "install -m 0644 /dev/stdin /etc/dovecot/conf.d/10-auth.conf",
      auditCommand: "write /etc/dovecot/conf.d/10-auth.conf",
      stdin: renderDovecotAuthConf()
    },
    {
      label: "write-dovecot-logging-conf",
      command: "install -m 0644 /dev/stdin /etc/dovecot/conf.d/10-logging.conf",
      auditCommand: "write /etc/dovecot/conf.d/10-logging.conf",
      stdin: renderDovecotLoggingConf()
    },
    {
      label: "write-dovecot-master-conf",
      command: "install -m 0644 /dev/stdin /etc/dovecot/conf.d/10-master.conf",
      auditCommand: "write /etc/dovecot/conf.d/10-master.conf",
      stdin: renderDovecotMasterConf()
    },
    {
      label: "write-dovecot-passwd-conf",
      command: "install -m 0644 /dev/stdin /etc/dovecot/conf.d/auth-passwdfile.conf.ext",
      auditCommand: "write /etc/dovecot/conf.d/auth-passwdfile.conf.ext",
      stdin: renderDovecotPasswdConf()
    },
    {
      label: "write-sasl-passdb",
      command: [
        "set -euo pipefail",
        "install -d -m 0750 -o root -g dovecot /etc/dovecot/passwd.d",
        "IFS= read -r SMTP_AUTH_PASSWORD",
        "SMTP_AUTH_HASH=$(doveadm pw -s SHA512-CRYPT -p \"$SMTP_AUTH_PASSWORD\")",
        `printf '%s:%s::::::\\n' ${shellQuote(input.username)} "$SMTP_AUTH_HASH" > /etc/dovecot/passwd.d/delivrix-smtp-users`,
        "chown root:dovecot /etc/dovecot/passwd.d/delivrix-smtp-users",
        "chmod 0640 /etc/dovecot/passwd.d/delivrix-smtp-users"
      ].join("\n"),
      auditCommand: `write /etc/dovecot/passwd.d/delivrix-smtp-users for ${input.username} <password redacted>`,
      stdin: `${input.password}\n`
    },
    {
      label: "patch-postfix-main-cf-sasl",
      command: [
        "postconf -e smtpd_sasl_type=dovecot",
        "postconf -e smtpd_sasl_path=private/auth",
        "postconf -e smtpd_sasl_auth_enable=no",
        "postconf -e 'smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination'"
      ].join(" && "),
      auditCommand: "postconf -e add SASL while preserving permit_mynetworks"
    },
    {
      label: "enable-postfix-submission-smtps",
      command: renderPostfixMasterServiceCommands(),
      auditCommand: "postconf -M/-P enable submission/smtps with SASL"
    },
    {
      label: "restart-services",
      command: "systemctl enable dovecot postfix && systemctl restart dovecot postfix",
      auditCommand: "systemctl enable/restart dovecot postfix"
    },
    {
      label: "validate-local-smtp-and-submission",
      command: "ss -ltn | grep -E ':(25|587|465)\\s' && (command -v swaks >/dev/null && swaks --server localhost --port 25 --from postmaster@localhost --to postmaster@localhost --quit-after RCPT || nc -z 127.0.0.1 25)",
      auditCommand: "validate ports 25/587/465 and legacy localhost:25 relay"
    }
  ];
}

async function markSmtpProvisioningAuthConfigured(
  workspace: OpenClawWorkspace,
  candidate: SmtpSaslRetrofitCandidate,
  patch: {
    smtpCredential: NonNullable<NonNullable<SmtpProvisioningInventory["servers"]>[number]["smtpCredential"]>;
    updatedAt: string;
  }
): Promise<void> {
  await workspace.updateInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json", (current) => {
    const servers = (current?.servers ?? []).map((server) => {
      if (server.serverSlug !== candidate.serverSlug || server.domain !== candidate.domain) {
        return server;
      }
      return {
        ...server,
        smtpAuthStatus: "configured" as const,
        smtpCredential: patch.smtpCredential,
        updatedAt: patch.updatedAt
      };
    });
    return { ...(current ?? {}), servers };
  });
}

async function appendRetrofitAudit(
  auditLog: AuditSink,
  actorId: string,
  candidate: SmtpSaslRetrofitCandidate,
  status: SmtpSaslRetrofitResult["status"],
  stepCount: number,
  error?: string,
  credentialFingerprint?: string,
  failedStep?: string
): Promise<void> {
  await auditLog.append({
    actorType: "operator",
    actorId,
    action: status === "configured" ? "oc.smtp_sasl.retrofit_configured" : "oc.smtp_sasl.retrofit_pending",
    targetType: "webdock_server",
    targetId: candidate.serverSlug,
    riskLevel: "critical",
    decision: status === "configured" ? "allow" : "reject",
    humanApproved: true,
    approverIds: [actorId],
    metadata: {
      domain: candidate.domain,
      serverIp: candidate.serverIp,
      selector: candidate.selector,
      status,
      stepCount,
      reason: candidate.reason,
      ...(failedStep ? { failedStep } : {}),
      ...(error ? { error } : {}),
      ...(credentialFingerprint ? { credentialFingerprint } : {})
    }
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactSmtpCredentialSecret(message: string, password: string): string {
  return password ? message.split(password).join("[REDACTED_SMTP_PASSWORD]") : message;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request, { maxBytes: 16_384 });
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

interface SmtpSaslRetrofitTarget {
  domain?: string;
  serverSlug?: string;
}

function retrofitTargetFromBody(body: SmtpSaslRetrofitBody): { ok: true; target: SmtpSaslRetrofitTarget } | { ok: false; error: string } {
  const domain = typeof body.domain === "string" ? normalizeDomainFilter(body.domain) : undefined;
  if (typeof body.domain === "string" && body.domain.trim().length > 0 && !domain) {
    return { ok: false, error: "domain must be a valid DNS domain when provided." };
  }
  const serverSlug = typeof body.serverSlug === "string" && body.serverSlug.trim().length > 0
    ? body.serverSlug.trim()
    : undefined;
  return {
    ok: true,
    target: {
      ...(domain ? { domain } : {}),
      ...(serverSlug ? { serverSlug } : {})
    }
  };
}

function smtpSaslRetrofitModeFromBody(body: SmtpSaslRetrofitBody): SmtpSaslRetrofitMode {
  if (body.mode === "recover" || body.mode === "rotate" || body.mode === "enable") {
    return body.mode;
  }
  return "enable";
}

function normalizeDomainFilter(value: string): string | undefined {
  const domain = value.trim().toLowerCase().replace(/\.$/, "");
  return isValidDomainFilter(domain) ? domain : undefined;
}

function isValidDomainFilter(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(value);
}

async function findRecentRetrofitApproval(input: {
  auditLog: AuditSink;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  approvalToken: string;
  now: Date;
  maxAgeMs: number;
}) {
  if (!input.auditLog.list) return null;
  const events = await input.auditLog.list();
  const auditEvent = events.toReversed().find((event) => {
    if (!auditApprovalMatchesToken(event, input.approvalToken)) {
      return false;
    }
    const approvedAt = Date.parse(event.occurredAt);
    return Number.isFinite(approvedAt) &&
      input.now.getTime() - approvedAt >= 0 &&
      input.now.getTime() - approvedAt <= input.maxAgeMs;
  });
  if (!auditEvent) return null;

  const state = await input.readCanvasState();
  return state.artifacts.find((artifact) => artifactMatchesAuditApproval({
    artifact,
    approvalEvent: auditEvent,
    approvalToken: input.approvalToken,
    now: input.now,
    maxAgeMs: input.maxAgeMs
  })) ?? null;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

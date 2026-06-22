import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  AuditEvent,
  AuditEventInput,
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import type {
  OpenClawWorkspace,
  OpenClawWorkspaceFileRef
} from "../openclaw-workspace.ts";
import {
  artifactMatchesAuditApproval,
  auditApprovalMatchesToken
} from "../approval-guard.ts";
import {
  entityFailureMetadata,
  entityNotResolvedBlocker,
  resolveWorkspaceServer,
  resolveWorkspaceServerIp,
  tryNormalizeStrictDomainName,
  type EntityResolutionFailure
} from "../entity-guard.ts";
import { readRequestBody } from "../request-body.ts";
import { ensureDkimKeyPair, findExistingDkimPrivateKeyPath } from "../dkim-keypair.ts";
import { smtpHostForDomain } from "../smtp-naming.ts";
import { getProviderFromServerSlug } from "../server-provider.ts";
import { runWithTransientSshRetry } from "../ssh-retry.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

export interface SmtpSshCommandInput {
  serverSlug?: string | null;
  serverIp: string;
  command: string;
  stdin?: string;
  timeoutMs?: number;
}

export interface SmtpSshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface SmtpSshRunner {
  isConfigured(): boolean;
  run(input: SmtpSshCommandInput): Promise<SmtpSshCommandResult>;
}

export interface SmtpProvisionDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  serverSlug: string;
  auditLog: AuditSink;
  sshRunner: SmtpSshRunner;
  workspace: OpenClawWorkspace;
  canvasLiveEvents?: CanvasEmitter;
  readCanvasState: () => Promise<CanvasLiveStateSnapshot> | CanvasLiveStateSnapshot;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface SmtpProvisionBody {
  domain?: unknown;
  serverIp?: unknown;
  dkimPrivateKeyPath?: unknown;
  selector?: unknown;
  actorId?: unknown;
  approvalToken?: unknown;
  taskId?: unknown;
}

interface SmtpInventory {
  servers?: Array<{
    serverSlug: string;
    domain: string;
    serverIp: string;
    selector: string;
    status: "configured";
    tlsStatus: "attempted_or_pending_dns";
    configuredAt: string;
    updatedAt: string;
  }>;
}

interface SmtpProvisionStep {
  label: string;
  command: string;
  auditCommand: string;
  stdin?: string;
  timeoutMs?: number;
}

interface SmtpProvisionStepResult {
  label: string;
  exitCode: number | null;
  attempts: number;
  cloudInitSettleSeconds?: number;
  progressDetail?: string;
}

const skillName = "install_smtp_stack";
const approvalMaxAgeMs = 15 * 60 * 1000;

export async function handleSmtpProvisionHttp(
  deps: SmtpProvisionDependencies
): Promise<void> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const body = await readJson<SmtpProvisionBody>(deps.request);
  const serverSlug = normalizeSlug(deps.serverSlug, "serverSlug");
  const rawDomain = requiredString(body.domain, "domain");
  const domainResolution = tryNormalizeStrictDomainName(rawDomain);
  const domain = domainResolution.ok ? domainResolution.value : rawDomain.trim().toLowerCase().replace(/\.$/, "");
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const taskId = normalizeTaskId(body.taskId) ?? `smtp-provision-${randomUUID()}`;
  const selector = normalizeSelector(body.selector);
  const entityFailures: EntityResolutionFailure[] = [];
  if (!domainResolution.ok) {
    entityFailures.push(domainResolution.failure);
  }
  const serverResolution = await resolveWorkspaceServer(deps.workspace, serverSlug);
  if (!serverResolution.ok) {
    entityFailures.push(serverResolution.failure);
  }
  const explicitServerIp = typeof body.serverIp === "string" && body.serverIp.trim()
    ? await resolveWorkspaceServerIp(deps.workspace, body.serverIp, serverSlug)
    : null;
  if (explicitServerIp && !explicitServerIp.ok) {
    entityFailures.push(explicitServerIp.failure);
  }
  const serverIp = explicitServerIp
    ? explicitServerIp.ok ? explicitServerIp.value : null
    : serverResolution.ok ? serverResolution.value.serverIp : null;
  let dkimPrivateKeyPath =
    !domainResolution.ok
      ? null
      : typeof body.dkimPrivateKeyPath === "string" && body.dkimPrivateKeyPath.trim()
      ? normalizeWorkspacePrivateKeyPath(body.dkimPrivateKeyPath)
      : await findExistingDkimPrivateKeyPath(deps.workspace, domain, selector);

  await emitTaskDeclare(deps.canvasLiveEvents, taskId, `SMTP stack · ${domain}`, actorId, now);
  const learnings = await safeReadLearnings(deps.workspace);
  await emitFileAction(deps.canvasLiveEvents, taskId, "read", "learnings/", `learnings:${learnings.length}`, now);

  const approval = await findRecentApproval({
    auditLog: deps.auditLog,
    readCanvasState: deps.readCanvasState,
    approvalToken,
    now,
    maxAgeMs: approvalMaxAgeMs
  });
  const blockers: string[] = [];
  if (env.SMTP_PROVISIONING_ENABLE_SSH !== "true") blockers.push("smtp_ssh_flag_disabled");
  if (!deps.sshRunner.isConfigured()) blockers.push("smtp_ssh_runner_missing");
  if (!approval) blockers.push("approval_not_found_or_expired");
  if (entityFailures.length > 0) blockers.push(entityNotResolvedBlocker);
  if (!serverIp) blockers.push("server_ip_missing");
  let dkimPublicKey: string | undefined;
  let dkimPublicKeyHash: string | undefined;
  let dkimKeyGenerated = false;
  let dkimKeyGenerationError: string | undefined;
  if (blockers.length === 0 && !dkimPrivateKeyPath) {
    try {
      const keyPair = await ensureDkimKeyPair({
        workspace: deps.workspace,
        domain,
        selector,
        now: deps.now
      });
      dkimPrivateKeyPath = keyPair.privateKeyPath;
      dkimPublicKey = keyPair.publicKeyB64;
      dkimPublicKeyHash = keyPair.publicKeyHash;
      dkimKeyGenerated = keyPair.generated;
      await emitFileAction(
        deps.canvasLiveEvents,
        taskId,
        keyPair.generated ? "write" : "read",
        keyPair.privateKeyPath,
        keyPair.generated ? "DKIM private key generated for SMTP provisioning" : "DKIM private key reused for SMTP provisioning",
        now
      );
    } catch (error) {
      blockers.push("dkim_key_generation_failed");
      dkimKeyGenerationError = errorMessage(error);
    }
  }
  if (!dkimPrivateKeyPath) blockers.push("dkim_private_key_missing");

  if (blockers.length > 0) {
    if (entityFailures.length > 0) {
      await appendEntityGuardAudits({
        auditLog: deps.auditLog,
        canvasLiveEvents: deps.canvasLiveEvents,
        taskId,
        actorId,
        failures: entityFailures,
        now
      });
    }
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, actorId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers,
        serverIpKnown: Boolean(serverIp),
        dkimPrivateKeyKnown: Boolean(dkimPrivateKeyPath),
        ...(dkimPublicKeyHash ? { dkimPublicKeyHash } : {}),
        ...(dkimKeyGenerationError ? { dkimKeyGenerationError } : {}),
        learningCount: learnings.length,
        ...(entityFailures.length > 0 ? { entityResolution: entityFailureMetadata(entityFailures) } : {})
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.smtp.provision_blocked",
      targetType: "webdock_server",
      targetId: serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        blockers,
        domain,
        ...(entityFailures.length > 0 ? { entityResolution: entityFailureMetadata(entityFailures) } : {}),
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.smtp.provision_blocked", "webdock_server", serverSlug, "critical", now);
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", now);
    json(deps.response, 409, {
      ok: false,
      status: "blocked",
      serverSlug,
      domain,
      blockers,
      ...(entityFailures.length > 0 ? { entityResolution: entityFailureMetadata(entityFailures) } : {}),
      workspace
    });
    return;
  }

  const configured = await findConfiguredSmtpInventory(deps.workspace, {
    serverSlug,
    domain,
    selector
  });
  if (configured) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, serverIp, selector, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        status: "idempotent_already_configured",
        serverIp: configured.serverIp,
        selector,
        commandCount: 0,
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.smtp.provision_idempotent",
      targetType: "webdock_server",
      targetId: serverSlug,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        domain,
        serverIp: configured.serverIp,
        selector,
        status: "idempotent_already_configured",
        commandCount: 0,
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.smtp.provision_idempotent", "webdock_server", serverSlug, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", deps.now?.() ?? new Date());
    json(deps.response, 200, {
      ok: true,
      status: "idempotent_already_configured",
      serverSlug,
      domain,
      serverIp: configured.serverIp,
      selector,
      commandCount: 0,
      tlsStatus: configured.tlsStatus,
      workspace
    });
    return;
  }

  const dkimPrivateKey = await deps.workspace.readWorkspaceFile(dkimPrivateKeyPath!);
  if (!dkimPublicKey) {
    const keyPair = await ensureDkimKeyPair({
      workspace: deps.workspace,
      domain,
      selector,
      now: deps.now
    });
    dkimPublicKey = keyPair.publicKeyB64;
    dkimPublicKeyHash = keyPair.publicKeyHash;
    dkimKeyGenerated = keyPair.generated;
  }
  const plan = buildSmtpProvisionPlan({
    domain,
    serverIp: serverIp!,
    selector,
    dkimPrivateKey
  });

  try {
    const commandResults: SmtpProvisionStepResult[] = [];
    let sshConnectAttempts = 1;
    let cloudInitSettleSeconds = 0;

    for (const [index, step] of plan.entries()) {
      const execution = index === 0
        ? await runSmtpStepWithCloudInitRetry({
            runner: deps.sshRunner,
            step,
            serverSlug,
            serverIp: serverIp!,
            sleep: deps.sleep ?? sleep
          })
        : {
            result: await deps.sshRunner.run({
              serverSlug,
              serverIp: serverIp!,
              command: step.command,
              stdin: step.stdin,
              timeoutMs: step.timeoutMs
            }),
            attempts: 1,
            cloudInitSettleMs: 0,
            progressDetail: undefined
          };

      sshConnectAttempts = Math.max(sshConnectAttempts, execution.attempts);
      cloudInitSettleSeconds += Math.round(execution.cloudInitSettleMs / 1000);
      commandResults.push({
        label: step.label,
        exitCode: execution.result.exitCode,
        attempts: execution.attempts,
        ...(execution.cloudInitSettleMs > 0 ? { cloudInitSettleSeconds: Math.round(execution.cloudInitSettleMs / 1000) } : {}),
        ...(execution.progressDetail ? { progressDetail: execution.progressDetail } : {})
      });
      await emitCommandAction(
        deps.canvasLiveEvents,
        taskId,
        step.auditCommand,
        execution.result.exitCode ?? 0,
        truncate(execution.result.stdout),
        truncate(execution.result.stderr),
        deps.now?.() ?? new Date(),
        execution.progressDetail
      );
    }

    await updateSmtpInventory(deps.workspace, {
      serverSlug,
      domain,
      serverIp: serverIp!,
      selector,
      status: "configured",
      tlsStatus: "attempted_or_pending_dns",
      configuredAt: now.toISOString(),
      updatedAt: (deps.now?.() ?? new Date()).toISOString()
    });

    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, serverIp, selector, actorId },
      outcome: "success",
      durationMs: Date.now() - startedAt,
      evidence: {
        commandCount: commandResults.length,
        commandResults,
        sshConnectAttempts,
        cloudInitSettleSeconds,
        tlsStatus: "attempted_or_pending_dns",
        dkimPrivateKeyPath,
        dkimPublicKeyHash,
        dkimKeyGenerated,
        learningCount: learnings.length
      }
    });
    await emitFileAction(deps.canvasLiveEvents, taskId, "write", workspace?.path ?? "executions/", "SMTP provisioning execution record", deps.now?.() ?? new Date());

    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.smtp.provisioned",
      targetType: "webdock_server",
      targetId: serverSlug,
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        domain,
        serverIp,
        selector,
        commandCount: commandResults.length,
        sshConnectAttempts,
        cloudInitSettleSeconds,
        tlsStatus: "attempted_or_pending_dns",
        dkimPrivateKeyPath,
        dkimPublicKeyHash,
        dkimKeyGenerated,
        approvalToken,
        approvalArtifactId: approval?.artifactId,
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.smtp.provisioned", "webdock_server", serverSlug, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "completed", deps.now?.() ?? new Date());

    json(deps.response, 200, {
      ok: true,
      status: "configured",
      serverSlug,
      domain,
      serverIp,
      selector,
      commandCount: commandResults.length,
      sshConnectAttempts,
      cloudInitSettleSeconds,
      tlsStatus: "attempted_or_pending_dns",
      dkimPrivateKeyPath,
      dkimPublicKey,
      dkimPublicKeyHash,
      dkimKeyGenerated,
      workspace
    });
  } catch (error) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, serverIp, selector, actorId },
      outcome: "failed",
      durationMs: Date.now() - startedAt,
      evidence: {
        error: errorMessage(error),
        learningCount: learnings.length
      }
    });
    await deps.auditLog.append({
      actorType: "operator",
      actorId,
      action: "oc.smtp.provision_failed",
      targetType: "webdock_server",
      targetId: serverSlug,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: true,
      approverIds: [actorId],
      metadata: {
        domain,
        serverIp,
        errorMessage: errorMessage(error),
        workspacePath: workspace?.path
      }
    });
    await emitAuditAction(deps.canvasLiveEvents, taskId, "oc.smtp.provision_failed", "webdock_server", serverSlug, "critical", deps.now?.() ?? new Date());
    await emitTaskUpdate(deps.canvasLiveEvents, taskId, "failed", deps.now?.() ?? new Date());
    json(deps.response, 502, {
      ok: false,
      status: "failed",
      serverSlug,
      domain,
      error: "smtp_provision_failed",
      message: errorMessage(error),
      workspace
    });
  }
}

export class SmtpProvisionInputError extends Error {
  readonly statusCode = 422;

  constructor(message: string) {
    super(message);
    this.name = "SmtpProvisionInputError";
  }
}

export function handleSmtpProvisionError(error: unknown, response: ServerResponse): boolean {
  if (error instanceof SmtpProvisionInputError) {
    json(response, error.statusCode, {
      error: "invalid_smtp_provision_request",
      message: error.message
    });
    return true;
  }
  if (error instanceof SyntaxError) {
    json(response, 400, {
      error: "invalid_json",
      message: "Request body must be valid JSON."
    });
    return true;
  }
  return false;
}

export function createSmtpSshRunnerFromEnv(
  env: Record<string, string | undefined> =
    typeof process !== "undefined" ? process.env : {}
): SmtpSshRunner {
  const defaultUser = normalizeEnvValue(env.SMTP_PROVISION_SSH_USER) ?? "root";
  const keyPath = expandHome(normalizeEnvValue(env.SMTP_PROVISION_SSH_KEY_PATH));
  const port = parsePositiveInt(env.SMTP_PROVISION_SSH_PORT) ?? 22;
  const timeoutMs = parsePositiveInt(env.SMTP_PROVISION_SSH_TIMEOUT_MS) ?? 180_000;
  const sudoEnabled = env.SMTP_PROVISION_SSH_USE_SUDO !== "false";

  return {
    isConfigured: () => Boolean(keyPath),
    run: async (input) => {
      const target = resolveSmtpSshTarget({
        serverSlug: input.serverSlug,
        defaultUser,
        sudoEnabled
      });
      return runSshCommand({
        ...input,
        user: target.user,
        keyPath,
        port,
        timeoutMs: input.timeoutMs ?? timeoutMs,
        useSudo: target.useSudo
      });
    }
  };
}

export function resolveSmtpSshTarget(input: {
  serverSlug?: string | null;
  defaultUser: string;
  sudoEnabled: boolean;
}): {
  user: string;
  useSudo: boolean;
} {
  const provider = getProviderFromServerSlug(input.serverSlug);
  if (provider === "contabo") {
    return { user: "root", useSudo: false };
  }
  return {
    user: input.defaultUser,
    useSudo: input.defaultUser !== "root" && input.sudoEnabled
  };
}

export function buildSmtpProvisionPlan(input: {
  domain: string;
  serverIp: string;
  selector: string;
  dkimPrivateKey: string;
}): SmtpProvisionStep[] {
  const mailHost = smtpHostForDomain(input.domain);
  const keyDir = `/etc/opendkim/keys/${input.domain}`;
  const mainCf = renderPostfixMainCf(input.domain, mailHost);
  const opendkimConf = renderOpenDkimConf();
  const keyTable = `${input.selector}._domainkey.${input.domain} ${input.domain}:${input.selector}:${keyDir}/${input.selector}.private\n`;
  const signingTable = `*@${input.domain} ${input.selector}._domainkey.${input.domain}\n`;
  const trustedHosts = `127.0.0.1\nlocalhost\n*.${input.domain}\n${input.domain}\n`;

  return [
    {
      label: "wait-cloud-init",
      command: "cloud-init status --wait || true",
      auditCommand: "cloud-init status --wait || true",
      timeoutMs: 240_000
    },
    {
      label: "install-packages",
      command: "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y postfix opendkim opendkim-tools certbot",
      auditCommand: "apt-get update -qq && apt-get install postfix opendkim opendkim-tools certbot",
      timeoutMs: 300_000
    },
    {
      label: "write-mailname",
      command: "install -m 0644 /dev/stdin /etc/mailname",
      auditCommand: "write /etc/mailname",
      stdin: `${mailHost}\n`
    },
    {
      label: "write-postfix-main-cf",
      command: "install -m 0644 /dev/stdin /etc/postfix/main.cf",
      auditCommand: "write /etc/postfix/main.cf",
      stdin: mainCf
    },
    {
      label: "write-opendkim-conf",
      command: "install -m 0644 /dev/stdin /etc/opendkim.conf",
      auditCommand: "write /etc/opendkim.conf",
      stdin: opendkimConf
    },
    {
      label: "create-dkim-dir",
      command: `install -d -m 0750 -o opendkim -g opendkim ${shellQuote(keyDir)}`,
      auditCommand: `install -d ${keyDir}`
    },
    {
      label: "write-dkim-private-key",
      command: `install -m 0600 -o opendkim -g opendkim /dev/stdin ${shellQuote(`${keyDir}/${input.selector}.private`)}`,
      auditCommand: `write ${keyDir}/${input.selector}.private <redacted>`,
      stdin: input.dkimPrivateKey
    },
    {
      label: "write-key-table",
      command: "install -m 0644 /dev/stdin /etc/opendkim/key.table",
      auditCommand: "write /etc/opendkim/key.table",
      stdin: keyTable
    },
    {
      label: "write-signing-table",
      command: "install -m 0644 /dev/stdin /etc/opendkim/signing.table",
      auditCommand: "write /etc/opendkim/signing.table",
      stdin: signingTable
    },
    {
      label: "write-trusted-hosts",
      command: "install -m 0644 /dev/stdin /etc/opendkim/trusted.hosts",
      auditCommand: "write /etc/opendkim/trusted.hosts",
      stdin: trustedHosts
    },
    {
      label: "attempt-certbot",
      command: `[ -d ${shellQuote(`/etc/letsencrypt/live/${mailHost}`)} ] && echo delivrix_certbot_existing || certbot certonly --standalone -d ${shellQuote(mailHost)} --non-interactive --agree-tos -m dmarc-reports@delivrix.com || echo delivrix_certbot_pending_dns`,
      auditCommand: `skip-if-existing certbot certonly --standalone -d ${mailHost} || echo pending_dns`,
      timeoutMs: 180_000
    },
    {
      label: "restart-services",
      command: "install -d -m 0755 -o opendkim -g opendkim /run/opendkim && systemctl enable opendkim postfix && systemctl restart opendkim postfix",
      auditCommand: "systemctl enable/restart opendkim postfix"
    },
    {
      label: "validate-local-smtp",
      command: "ss -ltn | grep -E ':(25|587)\\s' || systemctl status postfix --no-pager",
      auditCommand: "validate local SMTP listener"
    }
  ];
}

async function updateSmtpInventory(
  workspace: OpenClawWorkspace,
  input: NonNullable<SmtpInventory["servers"]>[number]
): Promise<void> {
  await workspace.updateInventoryJson<SmtpInventory>("smtp-provisioning.json", (current) => {
    const servers = (current?.servers ?? []).filter((server) => server.serverSlug !== input.serverSlug || server.domain !== input.domain);
    servers.push(input);
    return { servers };
  });
}

async function findConfiguredSmtpInventory(
  workspace: OpenClawWorkspace,
  input: { serverSlug: string; domain: string; selector: string }
): Promise<NonNullable<SmtpInventory["servers"]>[number] | null> {
  const inventory = await workspace.readInventoryJson<SmtpInventory>("smtp-provisioning.json").catch(() => null);
  return inventory?.servers?.find((entry) =>
    entry.serverSlug === input.serverSlug &&
    entry.domain === input.domain &&
    entry.selector === input.selector &&
    entry.status === "configured"
  ) ?? null;
}

async function appendEntityGuardAudits(input: {
  auditLog: AuditSink;
  canvasLiveEvents?: CanvasEmitter;
  taskId: string;
  actorId: string;
  failures: EntityResolutionFailure[];
  now: Date;
}): Promise<void> {
  for (const failure of input.failures) {
    await input.auditLog.append({
      actorType: "operator",
      actorId: input.actorId,
      action: "oc.guard.entity_not_resolved",
      targetType: failure.valueClass,
      targetId: failure.normalized ?? failure.value,
      riskLevel: "critical",
      decision: "reject",
      humanApproved: false,
      metadata: {
        taskId: input.taskId,
        entityResolution: entityFailureMetadata([failure])
      }
    });
  }
  const first = input.failures[0];
  if (first) {
    await emitAuditAction(
      input.canvasLiveEvents,
      input.taskId,
      "oc.guard.entity_not_resolved",
      first.valueClass,
      first.normalized ?? first.value,
      "critical",
      input.now
    );
  }
}

async function findRecentApproval(input: {
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
    return Number.isFinite(approvedAt) && input.now.getTime() - approvedAt >= 0 && input.now.getTime() - approvedAt <= input.maxAgeMs;
  });
  if (!auditEvent) return null;

  const state = await input.readCanvasState();
  return state.artifacts.find((artifact) => {
    return artifactMatchesAuditApproval({
      artifact,
      approvalEvent: auditEvent,
      approvalToken: input.approvalToken,
      now: input.now,
      maxAgeMs: input.maxAgeMs
    });
  }) ?? null;
}

async function safeReadLearnings(workspace: OpenClawWorkspace) {
  try {
    return await workspace.readLearnings(skillName);
  } catch {
    return [];
  }
}

async function safeWriteExecution(
  workspace: OpenClawWorkspace,
  input: Parameters<OpenClawWorkspace["writeExecutionRecord"]>[0]
): Promise<OpenClawWorkspaceFileRef | null> {
  try {
    return await workspace.writeExecutionRecord(input);
  } catch {
    return null;
  }
}

async function emitTaskDeclare(service: CanvasEmitter | undefined, taskId: string, title: string, actorId: string, now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.task.declare", taskId, title, status: "running", createdAt: now.toISOString(), actorId });
}

async function emitTaskUpdate(service: CanvasEmitter | undefined, taskId: string, status: "completed" | "failed", now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.task.update", taskId, status, updatedAt: now.toISOString() });
}

async function emitFileAction(service: CanvasEmitter | undefined, taskId: string, operation: "read" | "write", path: string, preview: string, now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.action.now", taskId, kind: "file", operation, path, preview, occurredAt: now.toISOString() });
}

async function emitCommandAction(service: CanvasEmitter | undefined, taskId: string, cmd: string, exitCode: number, stdout: string, stderr: string, now: Date, progressDetail?: string): Promise<void> {
  await safeEmit(service, {
    type: "oc.action.now",
    taskId,
    kind: "command",
    cmd,
    exitCode,
    stdout,
    stderr,
    durationMs: 1,
    ...(progressDetail ? { progressDetail } : {}),
    occurredAt: now.toISOString()
  });
}

async function emitAuditAction(service: CanvasEmitter | undefined, taskId: string, action: string, targetType: string, targetId: string, riskLevel: "critical", now: Date): Promise<void> {
  await safeEmit(service, { type: "oc.action.now", taskId, kind: "audit", action, targetType, targetId, riskLevel, occurredAt: now.toISOString() });
}

async function safeEmit(service: CanvasEmitter | undefined, event: CanvasLiveEvent): Promise<void> {
  if (!service) return;
  try {
    await service.emit(event);
  } catch {
    return;
  }
}

function renderPostfixMainCf(domain: string, mailHost: string): string {
  return [
    `myhostname = ${mailHost}`,
    `mydomain = ${domain}`,
    `smtp_helo_name = ${mailHost}`,
    "myorigin = /etc/mailname",
    "mydestination = $myhostname, localhost.$mydomain, localhost",
    "inet_interfaces = all",
    "inet_protocols = ipv4",
    "smtpd_banner = $myhostname ESMTP",
    "smtpd_tls_security_level = may",
    `smtpd_tls_cert_file = /etc/letsencrypt/live/${mailHost}/fullchain.pem`,
    `smtpd_tls_key_file = /etc/letsencrypt/live/${mailHost}/privkey.pem`,
    "smtpd_milters = inet:localhost:8891",
    "non_smtpd_milters = inet:localhost:8891",
    "milter_default_action = accept",
    "milter_protocol = 6",
    "smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination",
    ""
  ].join("\n");
}

function renderOpenDkimConf(): string {
  return [
    "Syslog yes",
    "UMask 002",
    "UserID opendkim",
    "PidFile /run/opendkim/opendkim.pid",
    "Mode sv",
    "Canonicalization relaxed/simple",
    "Socket inet:8891@localhost",
    "KeyTable /etc/opendkim/key.table",
    "SigningTable refile:/etc/opendkim/signing.table",
    "ExternalIgnoreList /etc/opendkim/trusted.hosts",
    "InternalHosts /etc/opendkim/trusted.hosts",
    ""
  ].join("\n");
}

async function runSshCommand(input: SmtpSshCommandInput & {
  user: string;
  keyPath: string | undefined;
  port: number;
  timeoutMs: number;
  useSudo: boolean;
}): Promise<SmtpSshCommandResult> {
  if (!input.keyPath) {
    throw new Error("SMTP_PROVISION_SSH_KEY_PATH is required.");
  }
  const command = input.useSudo
    ? `sudo -n bash -lc ${shellQuote(input.command)}`
    : input.command;
  return new Promise((resolvePromise, reject) => {
    const args = [
      "-i",
      input.keyPath,
      "-p",
      String(input.port),
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "StrictHostKeyChecking=accept-new",
      `${input.user}@${input.serverIp}`,
      command
    ];
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, new Error("SSH command timed out."));
    }, input.timeoutMs);
    timeout.unref();

    function cleanup(): void {
      clearTimeout(timeout);
    }

    function finish(fn: typeof resolvePromise | typeof reject, value: SmtpSshCommandResult | Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value as never);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        finish(resolvePromise, { stdout, stderr, exitCode });
        return;
      }
      finish(reject, new Error(`SSH command failed with exit ${exitCode ?? "unknown"}.`));
    });
    child.stdin?.end(input.stdin ?? "");
  });
}

async function runSmtpStepWithCloudInitRetry(input: {
  runner: SmtpSshRunner;
  step: SmtpProvisionStep;
  serverSlug?: string | null;
  serverIp: string;
  sleep: (ms: number) => Promise<void>;
}): Promise<{
  result: SmtpSshCommandResult;
  attempts: number;
  cloudInitSettleMs: number;
  progressDetail?: string;
}> {
  const execution = await runWithTransientSshRetry({
    sleep: input.sleep,
    operation: async () => {
      const result = await input.runner.run({
        serverSlug: input.serverSlug,
        serverIp: input.serverIp,
        command: input.step.command,
        stdin: input.step.stdin,
        timeoutMs: input.step.timeoutMs
      });
      if (result.exitCode === 255) {
        throw new Error("SSH command failed with exit 255.");
      }
      return result;
    }
  });

  return {
    result: execution.result,
    attempts: execution.attempts,
    cloudInitSettleMs: execution.settleMs,
    progressDetail: execution.attempts > 1
      ? `esperando cloud-init... intento ${execution.attempts} de 3; espera interna ${Math.round(execution.settleMs / 1000)}s`
      : undefined
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSlug(value: string, field: string): string {
  const normalized = decodeURIComponent(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) {
    throw new SmtpProvisionInputError(`${field} is invalid.`);
  }
  return normalized;
}

function normalizeSelector(value: unknown): string {
  const selector = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "default";
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(selector)) {
    throw new SmtpProvisionInputError("selector must be a DNS-safe DKIM selector.");
  }
  return selector;
}

function normalizeWorkspacePrivateKeyPath(value: string): string {
  const normalized = value.trim().replace(/^\/+/, "");
  if (!/^inventory\/dkim-keys\/[a-z0-9.-]+\/[a-z0-9_-]+\.private$/.test(normalized)) {
    throw new SmtpProvisionInputError("dkimPrivateKeyPath must point to inventory/dkim-keys/<domain>/<selector>.private.");
  }
  return normalized;
}

function normalizeTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(trimmed) ? trimmed : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SmtpProvisionInputError(`${field} is required.`);
  }
  return value.trim();
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expandHome(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncate(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}...<truncated>`;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new SmtpProvisionInputError("Request body is required.");
  }
  return JSON.parse(raw) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown SMTP provisioning error";
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

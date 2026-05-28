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

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
  list?(): Promise<AuditEvent[]>;
}

interface CanvasEmitter {
  emit(event: CanvasLiveEvent): Promise<CanvasLiveEvent>;
}

export interface SmtpSshCommandInput {
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

interface DomainsInventory {
  emailAuth?: Array<{
    domain: string;
    selector: string;
    dkimPrivateKeyPath: string;
  }>;
}

interface WebdockServersInventory {
  servers?: Array<{
    slug: string;
    hostname: string;
    ipv4: string | null;
    status: string;
  }>;
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
  const domain = normalizeDomainName(requiredString(body.domain, "domain"));
  const actorId = requiredString(body.actorId, "actorId");
  const approvalToken = requiredString(body.approvalToken, "approvalToken");
  const taskId = normalizeTaskId(body.taskId) ?? `smtp-provision-${randomUUID()}`;
  const selector = normalizeSelector(body.selector);
  const serverIp = typeof body.serverIp === "string" && body.serverIp.trim()
    ? normalizeIpv4(body.serverIp)
    : await findServerIp(deps.workspace, serverSlug);
  const dkimPrivateKeyPath =
    typeof body.dkimPrivateKeyPath === "string" && body.dkimPrivateKeyPath.trim()
      ? normalizeWorkspacePrivateKeyPath(body.dkimPrivateKeyPath)
      : await findDkimPrivateKeyPath(deps.workspace, domain, selector);

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
  if (!serverIp) blockers.push("server_ip_missing");
  if (!dkimPrivateKeyPath) blockers.push("dkim_private_key_missing");

  if (blockers.length > 0) {
    const workspace = await safeWriteExecution(deps.workspace, {
      skill: skillName,
      params: { domain, serverSlug, actorId },
      outcome: "blocked",
      durationMs: Date.now() - startedAt,
      evidence: {
        blockers,
        serverIpKnown: Boolean(serverIp),
        dkimPrivateKeyKnown: Boolean(dkimPrivateKeyPath),
        learningCount: learnings.length
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
      workspace
    });
    return;
  }

  const dkimPrivateKey = await deps.workspace.readWorkspaceFile(dkimPrivateKeyPath!);
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
            serverIp: serverIp!,
            sleep: deps.sleep ?? sleep
          })
        : {
            result: await deps.sshRunner.run({
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
  const user = normalizeEnvValue(env.SMTP_PROVISION_SSH_USER) ?? "root";
  const keyPath = expandHome(normalizeEnvValue(env.SMTP_PROVISION_SSH_KEY_PATH));
  const port = parsePositiveInt(env.SMTP_PROVISION_SSH_PORT) ?? 22;
  const timeoutMs = parsePositiveInt(env.SMTP_PROVISION_SSH_TIMEOUT_MS) ?? 180_000;

  return {
    isConfigured: () => Boolean(keyPath),
    run: async (input) => runSshCommand({
      ...input,
      user,
      keyPath,
      port,
      timeoutMs: input.timeoutMs ?? timeoutMs,
      useSudo: user !== "root" && env.SMTP_PROVISION_SSH_USE_SUDO !== "false"
    })
  };
}

export function buildSmtpProvisionPlan(input: {
  domain: string;
  serverIp: string;
  selector: string;
  dkimPrivateKey: string;
}): SmtpProvisionStep[] {
  const mailHost = `mail.${input.domain}`;
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
      command: `certbot certonly --standalone -d ${shellQuote(mailHost)} --non-interactive --agree-tos -m dmarc-reports@delivrix.com || echo delivrix_certbot_pending_dns`,
      auditCommand: `certbot certonly --standalone -d ${mailHost} || echo pending_dns`,
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

async function findServerIp(workspace: OpenClawWorkspace, serverSlug: string): Promise<string | null> {
  const inventory = await workspace.readInventoryJson<WebdockServersInventory>("webdock-servers.json").catch(() => null);
  const server = inventory?.servers?.find((item) => item.slug === serverSlug);
  return server?.ipv4 ? normalizeIpv4(server.ipv4) : null;
}

async function findDkimPrivateKeyPath(workspace: OpenClawWorkspace, domain: string, selector: string): Promise<string | null> {
  const inventory = await workspace.readInventoryJson<DomainsInventory>("domains.json").catch(() => null);
  const match = inventory?.emailAuth?.find((entry) => entry.domain === domain && entry.selector === selector);
  return match?.dkimPrivateKeyPath ? normalizeWorkspacePrivateKeyPath(match.dkimPrivateKeyPath) : null;
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
    if (event.action !== "oc.artifact.approved" || event.metadata.executionId !== input.approvalToken) {
      return false;
    }
    const approvedAt = Date.parse(event.occurredAt);
    return Number.isFinite(approvedAt) && input.now.getTime() - approvedAt >= 0 && input.now.getTime() - approvedAt <= input.maxAgeMs;
  });
  if (!auditEvent) return null;

  const state = await input.readCanvasState();
  return state.artifacts.find((artifact) => {
    if (artifact.approvalStatus !== "approved" || artifact.executionId !== input.approvalToken || !artifact.approvedAt) {
      return false;
    }
    const approvedAt = Date.parse(artifact.approvedAt);
    return Number.isFinite(approvedAt) && input.now.getTime() - approvedAt >= 0 && input.now.getTime() - approvedAt <= input.maxAgeMs;
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
  serverIp: string;
  sleep: (ms: number) => Promise<void>;
}): Promise<{
  result: SmtpSshCommandResult;
  attempts: number;
  cloudInitSettleMs: number;
  progressDetail?: string;
}> {
  const retryDelays = [30_000, 60_000];
  const errors: string[] = [];
  let cloudInitSettleMs = 0;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await input.runner.run({
        serverIp: input.serverIp,
        command: input.step.command,
        stdin: input.step.stdin,
        timeoutMs: input.step.timeoutMs
      });
      if (result.exitCode === 255) {
        throw new Error("SSH command failed with exit 255.");
      }
      return {
        result,
        attempts: attempt,
        cloudInitSettleMs,
        progressDetail: attempt > 1
          ? `esperando cloud-init... intento ${attempt} de 3; espera interna ${Math.round(cloudInitSettleMs / 1000)}s`
          : undefined
      };
    } catch (error) {
      errors.push(errorMessage(error));
      if (!isTransientSshConnectError(error) || attempt === 3) {
        throw new Error(`SSH connect failed after ${attempt} attempt(s): ${errors.join(" | ")}`);
      }

      const delay = retryDelays[attempt - 1] ?? 0;
      cloudInitSettleMs += delay;
      await input.sleep(delay);
    }
  }

  throw new Error(`SSH connect failed after 3 attempts: ${errors.join(" | ")}`);
}

function isTransientSshConnectError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("timed out") ||
    message.includes("exit 255") ||
    message.includes("connection refused") ||
    message.includes("connection reset") ||
    message.includes("no route to host");
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

function normalizeIpv4(value: string): string {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) < 0 || Number(part) > 255)) {
    throw new SmtpProvisionInputError(`Invalid IPv4 address: ${value}`);
  }
  return parts.map((part) => String(Number(part))).join(".");
}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) {
    throw new SmtpProvisionInputError(`Invalid domain name: ${value}`);
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
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
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

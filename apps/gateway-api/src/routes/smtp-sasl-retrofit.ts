import type { AuditEventInput } from "../../../../packages/domain/src/index.ts";
import type { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { smtpHostForDomain } from "../smtp-naming.ts";
import {
  markSmtpCredentialConfigured,
  prepareSmtpCredential,
  publicSmtpCredentialMetadata,
  saveSmtpCredentialRecord,
  smtpCredentialFingerprint
} from "../smtp-credentials.ts";
import type { SmtpSshRunner } from "./smtp-provisioning.ts";

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
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
    smtpCredential?: {
      hasCredential?: boolean;
      [key: string]: unknown;
    };
    configuredAt: string;
    updatedAt: string;
  }>;
}

export interface SmtpSaslRetrofitCandidate {
  serverSlug: string;
  domain: string;
  serverIp: string;
  selector: string;
  reason: "missing_smtp_auth" | "missing_credential";
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
  error?: string;
}

export interface SmtpSaslRetrofitBatchResult {
  candidates: number;
  results: SmtpSaslRetrofitResult[];
}

export async function listSmtpSaslRetrofitCandidates(
  workspace: OpenClawWorkspace
): Promise<SmtpSaslRetrofitCandidate[]> {
  const inventory = await workspace.readInventoryJson<SmtpProvisioningInventory>("smtp-provisioning.json").catch(() => null);
  return (inventory?.servers ?? [])
    .filter((server) => server.status === "configured")
    .filter((server) => server.smtpAuthStatus !== "configured" || server.smtpCredential?.hasCredential !== true)
    .map((server) => ({
      serverSlug: server.serverSlug,
      domain: server.domain,
      serverIp: server.serverIp,
      selector: server.selector,
      reason: server.smtpAuthStatus !== "configured" ? "missing_smtp_auth" : "missing_credential"
    }));
}

export async function runSmtpSaslRetrofitBatch(input: {
  workspace: OpenClawWorkspace;
  auditLog: AuditSink;
  sshRunner: SmtpSshRunner;
  env?: Record<string, string | undefined>;
  actorId: string;
  now?: () => Date;
}): Promise<SmtpSaslRetrofitBatchResult> {
  const candidates = await listSmtpSaslRetrofitCandidates(input.workspace);
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
        now: input.now
      });
      await saveSmtpCredentialRecord(input.workspace, credential.record);
      const plan = buildSmtpSaslRetrofitPlan({
        domain: candidate.domain,
        username: credential.record.username,
        password: credential.password
      });

      for (const step of plan) {
        await input.sshRunner.run({
          serverSlug: candidate.serverSlug,
          serverIp: candidate.serverIp,
          command: step.command,
          stdin: step.stdin,
          timeoutMs: step.timeoutMs
        });
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
      const message = error instanceof Error ? error.message : String(error);
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
  credentialFingerprint?: string
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
      ...(error ? { error } : {}),
      ...(credentialFingerprint ? { credentialFingerprint } : {})
    }
  });
}

function renderDovecotAuthConf(): string {
  return [
    "disable_plaintext_auth = no",
    "auth_mechanisms = plain login",
    "!include auth-passwdfile.conf.ext",
    ""
  ].join("\n");
}

function renderDovecotMasterConf(): string {
  return [
    "service auth {",
    "  unix_listener /var/spool/postfix/private/auth {",
    "    mode = 0660",
    "    user = postfix",
    "    group = postfix",
    "  }",
    "}",
    ""
  ].join("\n");
}

function renderDovecotPasswdConf(): string {
  return [
    "passdb {",
    "  driver = passwd-file",
    "  args = scheme=CRYPT username_format=%u /etc/dovecot/passwd.d/delivrix-smtp-users",
    "}",
    "userdb {",
    "  driver = static",
    "  args = uid=nobody gid=nogroup home=/var/empty",
    "}",
    ""
  ].join("\n");
}

function renderPostfixMasterServiceCommands(): string {
  return [
    "postconf -M submission/inet='submission inet n - y - - smtpd'",
    "postconf -P submission/inet/syslog_name=postfix/submission",
    "postconf -P submission/inet/smtpd_tls_security_level=encrypt",
    "postconf -P submission/inet/smtpd_sasl_auth_enable=yes",
    "postconf -P submission/inet/smtpd_recipient_restrictions=permit_sasl_authenticated,reject",
    "postconf -M smtps/inet='smtps inet n - y - - smtpd'",
    "postconf -P smtps/inet/syslog_name=postfix/smtps",
    "postconf -P smtps/inet/smtpd_tls_wrappermode=yes",
    "postconf -P smtps/inet/smtpd_sasl_auth_enable=yes",
    "postconf -P smtps/inet/smtpd_recipient_restrictions=permit_sasl_authenticated,reject"
  ].join(" && ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

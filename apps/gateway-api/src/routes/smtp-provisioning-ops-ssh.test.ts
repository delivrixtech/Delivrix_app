import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasLiveStateSnapshot } from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import {
  backfillOpsSshForFleet,
  buildOpsUserProvisionStep,
  buildOpsUserRevokeStep,
  handleProvisionOpsSshHttp,
  type SmtpSshCommandInput,
  type SmtpSshRunner
} from "./smtp-provisioning.ts";
import {
  attachSshAccessToRecord,
  decryptSmtpCredentialForDownload,
  markSmtpCredentialConfigured,
  prepareSmtpCredential,
  renderSmtpCredentialMarkdown,
  saveSmtpCredentialRecord
} from "../smtp-credentials.ts";
import { generateOpsSshKeyPair } from "../ssh-ops-key.ts";

const fixedNow = new Date("2026-07-24T18:00:00.000Z");
const credentialEncryptionKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const serverSlug = "contabo-9001";
const domain = "corpfiling-ops.com";
const approvalToken = "exec-ops-ssh-1";

test("provision-ops-ssh: gate off ⇒ bloqueado sin correr SSH", async () => {
  const { commands, route } = await opsHarness();
  const response = await route({ SMTP_OPS_SSH_ENABLE: undefined });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.status, "blocked");
  assert.equal(response.body.blockers.includes("ops_ssh_flag_disabled"), true);
  assert.equal(commands.length, 0);
});

test("provision-ops-ssh: sin approval ⇒ 403 sin correr SSH", async () => {
  const { commands, route } = await opsHarness({ withApproval: false });
  const response = await route();
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.blockers.includes("approval_not_found_or_expired"), true);
  assert.equal(commands.length, 0);
});

test("provision-ops-ssh: crea el usuario ops, cifra la clave y la entrega en el download", async () => {
  const { commands, route, workspace, auditLog } = await opsHarness();
  const response = await route();

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "provisioned");
  assert.equal(response.body.sshUser, "delivrix-ops");
  assert.equal(response.body.host, "203.0.113.9");
  assert.equal(response.body.downloadPath, `/v1/sender-pool/credentials/${domain}/download`);

  // Corrió exactamente el paso create-ops-user, con la pública por stdin (no en el comando).
  assert.equal(commands.length, 1);
  const step = commands[0]!;
  assert.match(step.command, /useradd -m -s \/bin\/bash/);
  assert.match(step.command, /sudoers\.d/);
  assert.match(step.command, /IFS= read -r OPS_PUBKEY/);
  assert.match(step.stdin ?? "", /^ssh-rsa /);
  assert.equal(step.command.includes("ssh-rsa"), false); // la pública no se interpola en el comando
  assert.equal(step.command.includes("BEGIN PRIVATE KEY"), false);

  // La clave privada nunca aparece en el audit.
  const events = await auditLog.list();
  const provisioned = events.at(-1);
  assert.equal(provisioned?.action, "oc.smtp.ops_ssh_provisioned");
  assert.equal(JSON.stringify(events).includes("BEGIN PRIVATE KEY"), false);
  assert.equal(JSON.stringify(events).includes("ssh-rsa AAAA"), false);
  // El token de aprobación va hasheado, no crudo.
  assert.equal(JSON.stringify(provisioned?.metadata).includes(approvalToken), false);
  assert.match(JSON.stringify(provisioned?.metadata), /approvalTokenHash/);

  // El download ahora entrega la sección SSH con una clave privada válida.
  const download = await decryptSmtpCredentialForDownload({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain
  });
  assert.ok(download.sshPrivateKey);
  assert.match(download.sshPrivateKey!, /BEGIN PRIVATE KEY/);
  const markdown = renderSmtpCredentialMarkdown({
    record: download.record,
    password: download.password,
    sshPrivateKey: download.sshPrivateKey,
    generatedAt: fixedNow.toISOString()
  });
  assert.match(markdown, /## Acceso SSH \(operaciones\)/);
  assert.match(markdown, /Usuario: delivrix-ops/);
});

test("buildOpsUserProvisionStep: instala pública desde stdin, no en el comando", () => {
  const keyPair = generateOpsSshKeyPair("delivrix-ops@x.com");
  const step = buildOpsUserProvisionStep({ opsUser: "delivrix-ops", authorizedKeysLine: keyPair.authorizedKeysLine });
  assert.equal(step.command.includes(keyPair.authorizedKeysLine), false);
  assert.equal(step.stdin, `${keyPair.authorizedKeysLine}\n`);
  assert.match(step.auditCommand, /public key redacted/);
});

test("buildOpsUserRevokeStep: borra sudoers y el usuario", () => {
  const step = buildOpsUserRevokeStep("delivrix-ops");
  assert.match(step.command, /rm -f \/etc\/sudoers\.d/);
  assert.match(step.command, /userdel/);
});

test("backfillOpsSshForFleet: provisiona los que no tienen SSH y saltea los que ya", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ops-ssh-backfill-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({ rootDir: join(dir, "workspace"), now: () => fixedNow });
  const env = { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey };
  const commands: SmtpSshCommandInput[] = [];

  // dominio A: sin SSH. dominio B: ya con SSH.
  const a = await prepareSmtpCredential({ workspace, env, domain: "alpha-ops.com", serverSlug: "contabo-1", host: "smtp.alpha-ops.com", now: () => fixedNow, passwordFactory: () => "pw" });
  await saveSmtpCredentialRecord(workspace, markSmtpCredentialConfigured(a.record, fixedNow));
  const b = await prepareSmtpCredential({ workspace, env, domain: "beta-ops.com", serverSlug: "contabo-2", host: "smtp.beta-ops.com", now: () => fixedNow, passwordFactory: () => "pw" });
  const bConfigured = markSmtpCredentialConfigured(b.record, fixedNow);
  await saveSmtpCredentialRecord(workspace, attachSshAccessToRecord({ record: bConfigured, env, user: "delivrix-ops", host: "10.0.0.2", privateKeyPem: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n", now: () => fixedNow }));

  const sshRunner: SmtpSshRunner = {
    isConfigured: () => true,
    run: async (c) => { commands.push(c); return { stdout: "", stderr: "", exitCode: 0 }; }
  };

  const summary = await backfillOpsSshForFleet({
    workspace, sshRunner, auditLog, env, now: () => fixedNow,
    actorId: "operator/juanes", opsUser: "delivrix-ops",
    nodes: [
      { domain: "alpha-ops.com", serverSlug: "contabo-1", serverIp: "10.0.0.1" },
      { domain: "beta-ops.com", serverSlug: "contabo-2", serverIp: "10.0.0.2" }
    ]
  });

  assert.deepEqual(summary.provisioned, ["alpha-ops.com"]);
  assert.deepEqual(summary.skippedAlready, ["beta-ops.com"]);
  assert.deepEqual(summary.failed, []);
  // Solo corrió el create-ops-user para alpha (beta se salteó).
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.serverIp, "10.0.0.1");
});

async function opsHarness(input: { withApproval?: boolean } = {}): Promise<{
  commands: SmtpSshCommandInput[];
  auditLog: LocalFileAuditLog;
  workspace: OpenClawWorkspace;
  route: (env?: Record<string, string | undefined>) => Promise<{ statusCode: number; body: any }>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "ops-ssh-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({ rootDir: join(dir, "workspace"), now: () => fixedNow });
  const commands: SmtpSshCommandInput[] = [];

  // Credencial SMTP configurada para el dominio.
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain,
    serverSlug,
    host: `smtp.${domain}`,
    now: () => fixedNow,
    passwordFactory: () => "smtp-secret"
  });
  await saveSmtpCredentialRecord(workspace, markSmtpCredentialConfigured(material.record, fixedNow));

  // Servidor con IP en el inventario.
  await workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{ slug: serverSlug, hostname: `smtp.${domain}`, ipv4: "203.0.113.9", status: "running" }]
  }));

  const canvasState: CanvasLiveStateSnapshot = {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: fixedNow.toISOString(),
    tasks: [],
    artifacts: input.withApproval === false ? [] : [{
      artifactId: "artifact-ops-ssh",
      taskId: "task-ops-ssh",
      kind: "proposal",
      title: "Provisionar acceso ops SSH",
      editable: true,
      createdAt: "2026-07-24T17:58:00.000Z",
      updatedAt: fixedNow.toISOString(),
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: fixedNow.toISOString(),
      executionId: approvalToken,
      blocks: []
    }]
  };

  if (input.withApproval !== false) {
    await auditLog.append({
      occurredAt: fixedNow.toISOString(),
      actorType: "operator",
      actorId: "operator/juanes",
      action: "oc.artifact.approved",
      targetType: "canvas_artifact",
      targetId: "artifact-ops-ssh",
      riskLevel: "critical",
      decision: "allow",
      humanApproved: true,
      approverIds: ["operator/juanes"],
      metadata: {
        executionId: approvalToken,
        approvalTokenHash: approvalTokenHash(approvalToken),
        blockCount: 1
      }
    });
  }

  const sshRunner: SmtpSshRunner = {
    isConfigured: () => true,
    run: async (command) => {
      commands.push(command);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
  };

  const route = async (
    env: Record<string, string | undefined> = { SMTP_OPS_SSH_ENABLE: "true" }
  ): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    await handleProvisionOpsSshHttp({
      request: requestWithJson({ domain, actorId: "operator/juanes", approvalToken }),
      response: response as unknown as ServerResponse,
      serverSlug,
      auditLog,
      sshRunner,
      workspace,
      readCanvasState: () => canvasState,
      env: {
        CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
        SMTP_OPS_SSH_ENABLE: "true",
        ...env
      },
      now: () => fixedNow
    });
    return { statusCode: response.statusCode, body: JSON.parse(response.body) };
  };

  return { commands, auditLog, workspace, route };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: `/v1/servers/${serverSlug}/provision-ops-ssh`,
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): { statusCode: number; body: string; writeHead: (s: number) => void; end: (p: string) => void } {
  return {
    statusCode: 0,
    body: "",
    writeHead(statusCode: number): void {
      this.statusCode = statusCode;
    },
    end(payload: string): void {
      this.body = payload;
    }
  };
}

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  CanvasLiveEvent,
  CanvasLiveStateSnapshot
} from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { approvalTokenHash } from "../approval-guard.ts";
import {
  buildSmtpProvisionPlan,
  handleSmtpProvisionError,
  handleSmtpProvisionHttp,
  resolveSmtpSshTarget,
  type SmtpSshCommandInput,
  type SmtpSshRunner
} from "./smtp-provisioning.ts";

const fixedNow = new Date("2026-05-27T17:00:00.000Z");
const dkimPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
}).privateKey;

test("buildSmtpProvisionPlan writes DKIM key through stdin and keeps audit command redacted", () => {
  const plan = buildSmtpProvisionPlan({
    domain: "delivrix-mail.com",
    serverIp: "192.0.2.44",
    selector: "default",
    dkimPrivateKey
  });

  const dkimStep = plan.find((step) => step.label === "write-dkim-private-key");
  assert.equal(dkimStep?.stdin, dkimPrivateKey);
  assert.equal(dkimStep?.auditCommand.includes("PRIVATE"), false);
  assert.equal(plan.some((step) => step.label === "attempt-certbot"), true);
});

test("buildSmtpProvisionPlan uses smtp host for mailname, HELO, hostname and TLS", () => {
  const plan = buildSmtpProvisionPlan({
    domain: "delivrix-mail.com",
    serverIp: "192.0.2.44",
    selector: "default",
    dkimPrivateKey
  });

  const mailname = plan.find((step) => step.label === "write-mailname");
  const mainCf = plan.find((step) => step.label === "write-postfix-main-cf");
  const certbot = plan.find((step) => step.label === "attempt-certbot");

  assert.equal(mailname?.stdin, "smtp.delivrix-mail.com\n");
  assert.match(mainCf?.stdin ?? "", /myhostname = smtp\.delivrix-mail\.com/);
  assert.match(mainCf?.stdin ?? "", /smtp_helo_name = smtp\.delivrix-mail\.com/);
  assert.doesNotMatch(mainCf?.stdin ?? "", /mail\.delivrix-mail\.com/);
  assert.match(certbot?.command ?? "", /smtp\.delivrix-mail\.com/);
});

test("resolveSmtpSshTarget uses root without sudo only for canonical Contabo slugs", () => {
  assert.deepEqual(resolveSmtpSshTarget({
    serverSlug: "contabo-203386827",
    defaultUser: "delivrixops",
    sudoEnabled: true
  }), { user: "root", useSudo: false });
  assert.deepEqual(resolveSmtpSshTarget({
    serverSlug: "mail-delivrix-test",
    defaultUser: "delivrixops",
    sudoEnabled: true
  }), { user: "delivrixops", useSudo: true });
  assert.deepEqual(resolveSmtpSshTarget({
    serverSlug: null,
    defaultUser: "delivrixops",
    sudoEnabled: false
  }), { user: "delivrixops", useSudo: false });
  assert.deepEqual(resolveSmtpSshTarget({
    serverSlug: "Contabo-203386827",
    defaultUser: "delivrixops",
    sudoEnabled: true
  }), { user: "delivrixops", useSudo: true });
  assert.deepEqual(resolveSmtpSshTarget({
    serverSlug: " contabo-203386827 ",
    defaultUser: "delivrixops",
    sudoEnabled: true
  }), { user: "delivrixops", useSudo: true });
});

test("POST /v1/servers/:slug/provision-smtp blocks without SSH flag, runner, approval, server IP, and DKIM key", async () => {
  const route = await routeHarness({
    sshRunner: mockRunner({ isConfigured: () => false }),
    canvasState: canvasState([])
  });

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-missing",
    taskId: "task-smtp-blocked"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "false" });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body.blockers.sort(), [
    "approval_not_found_or_expired",
    "dkim_private_key_missing",
    "entity_not_resolved",
    "server_ip_missing",
    "smtp_ssh_flag_disabled",
    "smtp_ssh_runner_missing"
  ].sort());
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.smtp.provision_blocked");
});

test("POST /v1/servers/:slug/provision-smtp rejects timestamp fragments as unresolved domains", async () => {
  const commands: SmtpSshCommandInput[] = [];
  const route = await routeHarness({
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-smtp-plan",
      executionId: "exec-smtp-bad-domain",
      approvedAt: "2026-05-27T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-smtp-plan", "exec-smtp-bad-domain");
  await route.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-delivrix-test",
      hostname: "mail.delivrix-mail.com",
      ipv4: "192.0.2.44",
      status: "running"
    }]
  }));

  const response = await route({
    domain: "37.842Z",
    actorId: "operator/juanes",
    approvalToken: "exec-smtp-bad-domain",
    taskId: "task-smtp-bad-domain"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "true" });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.blockers.includes("entity_not_resolved"), true);
  assert.equal(response.body.entityResolution.failures[0].reason, "timestamp_fragment_is_not_domain");
  assert.equal(commands.length, 0);
  const events = await route.auditLog.list();
  assert.equal(events.some((event) => event.action === "oc.guard.entity_not_resolved"), true);
  assert.equal(events.at(-1)?.action, "oc.smtp.provision_blocked");
});

test("POST /v1/servers/:slug/provision-smtp blocks serverSlug that is absent from inventory", async () => {
  const route = await routeHarness({
    serverSlug: "missing-server",
    sshRunner: mockRunner(),
    canvasState: canvasState([{
      artifactId: "artifact-smtp-plan",
      executionId: "exec-smtp-missing-server",
      approvedAt: "2026-05-27T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-smtp-plan", "exec-smtp-missing-server");
  await route.workspace.writeWorkspaceFile("inventory/dkim-keys/delivrix-mail.com/default.private", dkimPrivateKey);
  await route.workspace.updateInventoryJson("domains.json", () => ({
    emailAuth: [{
      domain: "delivrix-mail.com",
      selector: "default",
      dkimPrivateKeyPath: "inventory/dkim-keys/delivrix-mail.com/default.private"
    }]
  }));

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-smtp-missing-server",
    taskId: "task-smtp-missing-server"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "true" });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.blockers.includes("entity_not_resolved"), true);
  assert.equal(response.body.blockers.includes("server_ip_missing"), true);
  assert.equal(response.body.entityResolution.failures[0].reason, "server_slug_not_in_inventory");
});

test("POST /v1/servers/:slug/provision-smtp runs idempotent SSH plan and records workspace inventory", async () => {
  const commands: SmtpSshCommandInput[] = [];
  const route = await routeHarness({
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-smtp-plan",
      executionId: "exec-smtp-123",
      approvedAt: "2026-05-27T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-smtp-plan", "exec-smtp-123");
  await route.workspace.writeWorkspaceFile("inventory/dkim-keys/delivrix-mail.com/default.private", dkimPrivateKey);
  await route.workspace.updateInventoryJson("domains.json", () => ({
    emailAuth: [{
      domain: "delivrix-mail.com",
      selector: "default",
      dkimPrivateKeyPath: "inventory/dkim-keys/delivrix-mail.com/default.private"
    }]
  }));
  await route.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-delivrix-test",
      hostname: "mail.delivrix-mail.com",
      ipv4: "192.0.2.44",
      status: "running"
    }]
  }));

  const response = await route({
    domain: "Delivrix-Mail.COM.",
    actorId: "operator/juanes",
    approvalToken: "exec-smtp-123",
    taskId: "task-smtp-provision"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "configured");
  assert.equal(response.body.serverIp, "192.0.2.44");
  assert.equal(commands.length, 13);
  assert.equal(commands.every((command) => command.serverSlug === "mail-delivrix-test"), true);
  assert.equal(commands.some((command) => command.stdin === dkimPrivateKey), true);
  assert.equal(commands.every((command) => !command.command.includes("PRIVATE")), true);

  const events = await route.auditLog.list();
  const provisioned = events.at(-1);
  assert.equal(provisioned?.action, "oc.smtp.provisioned");
  assert.equal(JSON.stringify(provisioned?.metadata).includes("PRIVATE"), false);

  const inventory = await route.workspace.readInventoryJson<{
    servers: Array<{ serverSlug: string; domain: string; status: string }>;
  }>("smtp-provisioning.json");
  assert.equal(inventory?.servers[0].serverSlug, "mail-delivrix-test");
  assert.equal(inventory?.servers[0].domain, "delivrix-mail.com");
  assert.equal(inventory?.servers[0].status, "configured");
  assert.ok(route.canvasEvents.some((event) => event.type === "oc.action.now" && event.kind === "command"));
});

test("POST /v1/servers/:slug/provision-smtp skips SSH when inventory is already configured", async () => {
  const commands: SmtpSshCommandInput[] = [];
  const route = await routeHarness({
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-smtp-plan",
      executionId: "exec-smtp-idem",
      approvedAt: "2026-05-27T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-smtp-plan", "exec-smtp-idem");
  await route.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-delivrix-test",
      hostname: "mail.delivrix-mail.com",
      ipv4: "192.0.2.44",
      status: "running"
    }]
  }));
  await route.workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [{
      serverSlug: "mail-delivrix-test",
      domain: "delivrix-mail.com",
      serverIp: "192.0.2.44",
      selector: "default",
      status: "configured",
      tlsStatus: "attempted_or_pending_dns",
      configuredAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString()
    }]
  }));

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-smtp-idem",
    taskId: "task-smtp-idem"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "idempotent_already_configured");
  assert.equal(response.body.commandCount, 0);
  assert.equal(commands.length, 0);
  assert.equal((await route.auditLog.list()).at(-1)?.action, "oc.smtp.provision_idempotent");
});

test("POST /v1/servers/:slug/provision-smtp generates DKIM keypair when missing", async () => {
  const commands: SmtpSshCommandInput[] = [];
  const route = await routeHarness({
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-smtp-plan",
      executionId: "exec-smtp-keygen",
      approvedAt: "2026-05-27T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-smtp-plan", "exec-smtp-keygen");
  await route.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-delivrix-test",
      hostname: "mail.delivrix-mail.com",
      ipv4: "192.0.2.44",
      status: "running"
    }]
  }));

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-smtp-keygen",
    taskId: "task-smtp-keygen"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "configured");
  assert.match(response.body.dkimPublicKey, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(response.body.dkimKeyGenerated, true);
  assert.equal(commands.some((command) => typeof command.stdin === "string" && command.stdin.includes("BEGIN PRIVATE KEY")), true);
  const privateKeyStat = await stat(join(route.workspace.getRootDir(), response.body.dkimPrivateKeyPath));
  assert.equal(privateKeyStat.mode & 0o777, 0o600);
  const events = await route.auditLog.list();
  assert.equal(JSON.stringify(events).includes("BEGIN PRIVATE KEY"), false);
});

test("POST /v1/servers/:slug/provision-smtp retries transient first SSH failure internally", async () => {
  const commands: SmtpSshCommandInput[] = [];
  const sleepDelays: number[] = [];
  let firstStepAttempts = 0;
  const route = await routeHarness({
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        if (input.command === "cloud-init status --wait || true") {
          firstStepAttempts += 1;
          if (firstStepAttempts < 3) {
            throw new Error(firstStepAttempts === 1 ? "SSH command timed out." : "SSH command failed with exit 255.");
          }
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-smtp-plan",
      executionId: "exec-smtp-retry",
      approvedAt: "2026-05-27T16:59:00.000Z"
    }]),
    sleep: async (ms) => {
      sleepDelays.push(ms);
    }
  });
  await appendApproval(route.auditLog, "artifact-smtp-plan", "exec-smtp-retry");
  await route.workspace.writeWorkspaceFile("inventory/dkim-keys/delivrix-mail.com/default.private", dkimPrivateKey);
  await route.workspace.updateInventoryJson("domains.json", () => ({
    emailAuth: [{
      domain: "delivrix-mail.com",
      selector: "default",
      dkimPrivateKeyPath: "inventory/dkim-keys/delivrix-mail.com/default.private"
    }]
  }));
  await route.workspace.updateInventoryJson("webdock-servers.json", () => ({
    servers: [{
      slug: "mail-delivrix-test",
      hostname: "mail.delivrix-mail.com",
      ipv4: "192.0.2.44",
      status: "running"
    }]
  }));

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-smtp-retry",
    taskId: "task-smtp-retry"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.sshConnectAttempts, 3);
  assert.equal(response.body.cloudInitSettleSeconds, 90);
  assert.deepEqual(sleepDelays, [30_000, 60_000]);
  assert.equal(commands.filter((command) => command.command === "cloud-init status --wait || true").length, 3);
  assert.equal(route.canvasEvents.filter((event) => event.type === "oc.action.now" && event.kind === "command").length, 13);
  const firstCommandEvent = route.canvasEvents.find((event) => event.type === "oc.action.now" && event.kind === "command");
  assert.equal(firstCommandEvent?.kind === "command" ? firstCommandEvent.progressDetail : undefined, "esperando cloud-init... intento 3 de 3; espera interna 90s");

  const provisioned = (await route.auditLog.list()).at(-1);
  assert.equal(provisioned?.metadata.sshConnectAttempts, 3);
  assert.equal(provisioned?.metadata.cloudInitSettleSeconds, 90);
});

async function routeHarness(input: {
  sshRunner: SmtpSshRunner;
  canvasState: CanvasLiveStateSnapshot;
  serverSlug?: string;
  sleep?: (ms: number) => Promise<void>;
}) {
  const dir = await mkdtemp(join(tmpdir(), "smtp-provision-route-"));
  const auditLog = new LocalFileAuditLog(join(dir, "audit-events.jsonl"));
  const workspace = new OpenClawWorkspace({
    rootDir: join(dir, "workspace"),
    now: () => fixedNow
  });
  const canvasEvents: CanvasLiveEvent[] = [];

  const route = async (
    body: unknown,
    env: Record<string, string | undefined> = { SMTP_PROVISIONING_ENABLE_SSH: "true" }
  ): Promise<{ statusCode: number; body: any }> => {
    const response = captureResponse();
    try {
      await handleSmtpProvisionHttp({
        request: requestWithJson(body),
        response: response as unknown as ServerResponse,
        serverSlug: input.serverSlug ?? "mail-delivrix-test",
        auditLog,
        sshRunner: input.sshRunner,
        workspace,
        canvasLiveEvents: {
          emit: async (event) => {
            canvasEvents.push(event);
            return event;
          }
        },
        readCanvasState: () => input.canvasState,
        env,
        sleep: input.sleep,
        now: () => fixedNow
      });
    } catch (error) {
      if (!handleSmtpProvisionError(error, response as unknown as ServerResponse)) {
        throw error;
      }
    }
    return {
      statusCode: response.statusCode,
      body: JSON.parse(response.body)
    };
  };
  return Object.assign(route, { auditLog, workspace, canvasEvents });
}

function mockRunner(overrides: Partial<SmtpSshRunner> = {}): SmtpSshRunner {
  return {
    isConfigured: () => true,
    run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    ...overrides
  };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: "2026-05-27T16:59:00.000Z",
    actorType: "operator",
    actorId: "operator/juanes",
    action: "oc.artifact.approved",
    targetType: "canvas_artifact",
    targetId: artifactId,
    riskLevel: "critical",
    decision: "allow",
    humanApproved: true,
    approverIds: ["operator/juanes"],
    metadata: {
      executionId,
      approvalTokenHash: approvalTokenHash(executionId),
      blockCount: 1
    }
  });
}

function canvasState(approvals: Array<{
  artifactId: string;
  executionId: string;
  approvedAt: string;
}>): CanvasLiveStateSnapshot {
  return {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: fixedNow.toISOString(),
    tasks: [],
    artifacts: approvals.map((approval) => ({
      artifactId: approval.artifactId,
      taskId: "task-smtp-plan",
      kind: "proposal",
      title: "Provisionar SMTP",
      editable: true,
      createdAt: "2026-05-27T16:58:00.000Z",
      updatedAt: approval.approvedAt,
      approvalStatus: "approved",
      approvedBy: "operator/juanes",
      approvedAt: approval.approvedAt,
      executionId: approval.executionId,
      blocks: []
    }))
  };
}

function requestWithJson(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/servers/mail-delivrix-test/provision-smtp",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  body: string;
  writeHead: (statusCode: number) => void;
  end: (payload: string) => void;
} {
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

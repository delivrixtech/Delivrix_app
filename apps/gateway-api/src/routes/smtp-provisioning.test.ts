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
const credentialEncryptionKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const smtpCredential = {
  username: "mailer@delivrix-mail.com",
  password: "smtp-password-for-tests"
};
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
    dkimPrivateKey,
    smtpCredential
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
    dkimPrivateKey,
    smtpCredential
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

test("buildSmtpProvisionPlan enables SASL only for submission/smtps and preserves IP relay", () => {
  const plan = buildSmtpProvisionPlan({
    domain: "delivrix-mail.com",
    serverIp: "192.0.2.44",
    selector: "default",
    dkimPrivateKey,
    smtpCredential
  });

  const mainCf = plan.find((step) => step.label === "write-postfix-main-cf");
  const master = plan.find((step) => step.label === "enable-postfix-submission-smtps");
  const passdb = plan.find((step) => step.label === "write-sasl-passdb");
  const dovecotAuth = plan.find((step) => step.label === "write-dovecot-auth-conf");
  const dovecotLogging = plan.find((step) => step.label === "write-dovecot-logging-conf");

  assert.match(mainCf?.stdin ?? "", /smtpd_sasl_auth_enable = no/);
  assert.match(mainCf?.stdin ?? "", /permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination/);
  assert.match(master?.command ?? "", /submission\/inet\/smtpd_sasl_auth_enable=yes/);
  assert.match(master?.command ?? "", /smtps\/inet\/smtpd_sasl_auth_enable=yes/);
  assert.match(dovecotAuth?.stdin ?? "", /disable_plaintext_auth = yes/);
  assert.match(dovecotLogging?.stdin ?? "", /auth_debug_passwords = no/);
  assert.equal(passdb?.stdin, `${smtpCredential.password}\n`);
  assert.equal(passdb?.command.includes(smtpCredential.password), false);
  assert.equal(passdb?.auditCommand.includes(smtpCredential.password), false);
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
  assert.equal(commands.length, 19);
  assert.equal(commands.every((command) => command.serverSlug === "mail-delivrix-test"), true);
  assert.equal(commands.some((command) => command.stdin === dkimPrivateKey), true);
  assert.equal(commands.every((command) => !command.command.includes("PRIVATE")), true);
  assert.equal(commands.some((command) => command.stdin?.includes("BEGIN PRIVATE KEY")), true);

  const events = await route.auditLog.list();
  const provisioned = events.at(-1);
  assert.equal(provisioned?.action, "oc.smtp.provisioned");
  assert.equal(JSON.stringify(provisioned?.metadata).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(events).includes(response.body.smtpCredential?.username), true);
  assert.equal(JSON.stringify(events).includes("smtp-password-for-tests"), false);

  const inventory = await route.workspace.readInventoryJson<{
    servers: Array<{ serverSlug: string; domain: string; status: string; smtpAuthStatus?: string; smtpCredential?: { hasCredential: boolean } }>;
  }>("smtp-provisioning.json");
  assert.equal(inventory?.servers[0].serverSlug, "mail-delivrix-test");
  assert.equal(inventory?.servers[0].domain, "delivrix-mail.com");
  assert.equal(inventory?.servers[0].status, "configured");
  assert.equal(inventory?.servers[0].smtpAuthStatus, "configured");
  assert.equal(inventory?.servers[0].smtpCredential?.hasCredential, true);
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
      smtpAuthStatus: "configured",
      smtpCredential: {
        domain: "delivrix-mail.com",
        serverSlug: "mail-delivrix-test",
        host: "smtp.delivrix-mail.com",
        username: "mailer@delivrix-mail.com",
        status: "configured",
        ports: { submission: 587, smtps: 465 },
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
        hasCredential: true
      },
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

test("POST /v1/servers/:slug/provision-smtp blocks configured SMTP AUTH without credential metadata", async () => {
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
      executionId: "exec-smtp-missing-credential",
      approvedAt: "2026-05-27T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-smtp-plan", "exec-smtp-missing-credential");
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
      smtpAuthStatus: "configured",
      configuredAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString()
    }]
  }));

  const response = await route({
    domain: "delivrix-mail.com",
    actorId: "operator/juanes",
    approvalToken: "exec-smtp-missing-credential",
    taskId: "task-smtp-missing-credential"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "true" });

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, "smtp_auth_configured_but_credential_missing");
  assert.equal(commands.length, 0);
  assert.equal((await route.auditLog.list()).at(-1)?.metadata.remediation, "run_smtp_sasl_retrofit_or_rotate_explicitly");
});

test("POST /v1/servers/:slug/provision-smtp retrofits legacy configured inventory without SMTP AUTH", async () => {
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
      executionId: "exec-smtp-retrofit",
      approvedAt: "2026-05-27T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-smtp-plan", "exec-smtp-retrofit");
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
    approvalToken: "exec-smtp-retrofit",
    taskId: "task-smtp-retrofit"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "true" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "configured");
  assert.equal(commands.length, 19);
  assert.equal(commands.some((command) => command.command.includes("dovecot")), true);
});

test("POST /v1/servers/:slug/provision-smtp marks credential install_failed on SSH failure", async () => {
  const commands: SmtpSshCommandInput[] = [];
  const route = await routeHarness({
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        if (input.command.includes("doveadm pw")) {
          throw new Error("dovecot passdb failed");
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    canvasState: canvasState([{
      artifactId: "artifact-smtp-plan",
      executionId: "exec-smtp-fail",
      approvedAt: "2026-05-27T16:59:00.000Z"
    }])
  });
  await appendApproval(route.auditLog, "artifact-smtp-plan", "exec-smtp-fail");
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
    approvalToken: "exec-smtp-fail",
    taskId: "task-smtp-fail"
  }, { SMTP_PROVISIONING_ENABLE_SSH: "true" });

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.status, "failed");
  const domains = await route.workspace.readInventoryJson<{ smtpCredentials: Array<{ status: string }> }>("domains.json");
  assert.equal(domains?.smtpCredentials[0]?.status, "install_failed");
  const events = await route.auditLog.list();
  const failed = events.at(-1);
  assert.equal(failed?.action, "oc.smtp.provision_failed");
  assert.equal(failed?.metadata.failedStep, "write-sasl-passdb");
  assert.equal(JSON.stringify(events).includes("smtp-password-for-tests"), false);
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
  assert.equal(route.canvasEvents.filter((event) => event.type === "oc.action.now" && event.kind === "command").length, 19);
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
    env: Record<string, string | undefined> = {}
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
        env: {
          SMTP_PROVISIONING_ENABLE_SSH: "true",
          CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey,
          ...env
        },
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

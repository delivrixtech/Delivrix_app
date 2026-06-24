import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { approvalTokenHash } from "../approval-guard.ts";
import type { CanvasLiveStateSnapshot } from "../../../../packages/domain/src/index.ts";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  markSmtpCredentialConfigured,
  prepareSmtpCredential,
  saveSmtpCredentialRecord
} from "../smtp-credentials.ts";
import {
  buildSmtpSaslRetrofitPlan,
  handleSmtpSaslRetrofitBatchHttp,
  listSmtpSaslRetrofitCandidates,
  reconcileSmtpProvisioningCredentialFlags,
  runSmtpSaslRetrofitBatch
} from "./smtp-sasl-retrofit.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";
import type { SmtpSshCommandInput, SmtpSshRunner } from "./smtp-provisioning.ts";

const fixedNow = new Date("2026-06-22T14:00:00.000Z");
const credentialEncryptionKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

test("listSmtpSaslRetrofitCandidates only returns configured SMTPs missing auth credentials", async () => {
  const workspace = await setupWorkspace();
  await saveConfiguredCredential(workspace, "ready-one.com", "server88");
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      {
        ...legacyServer("server88", "ready-one.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: true }
      }
    ]
  }));

  const candidates = await listSmtpSaslRetrofitCandidates(workspace);
  assert.deepEqual(candidates.map((candidate) => candidate.serverSlug), ["server85"]);
  assert.equal(candidates[0]?.reason, "missing_smtp_auth");
});

test("listSmtpSaslRetrofitCandidates cross-checks real credential store when provisioning flag is stale", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      {
        ...legacyServer("server85", "controlnational.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: true }
      }
    ]
  }));

  const enableCandidates = await listSmtpSaslRetrofitCandidates(workspace, { domain: "controlnational.com" }, "enable");
  assert.deepEqual(enableCandidates.map((candidate) => ({
    serverSlug: candidate.serverSlug,
    reason: candidate.reason
  })), [{
    serverSlug: "server85",
    reason: "missing_credential"
  }]);

  const recoverCandidates = await listSmtpSaslRetrofitCandidates(workspace, { domain: "controlnational.com" }, "recover");
  assert.deepEqual(recoverCandidates.map((candidate) => ({
    serverSlug: candidate.serverSlug,
    reason: candidate.reason
  })), [{
    serverSlug: "server85",
    reason: "missing_credential"
  }]);
});

test("listSmtpSaslRetrofitCandidates does not regenerate when real credential exists despite stale false flag", async () => {
  const workspace = await setupWorkspace();
  await saveConfiguredCredential(workspace, "ready-one.com", "server85");
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      {
        ...legacyServer("server85", "ready-one.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: false }
      }
    ]
  }));

  const enableCandidates = await listSmtpSaslRetrofitCandidates(workspace, { domain: "ready-one.com" }, "enable");
  assert.deepEqual(enableCandidates, []);
});

test("listSmtpSaslRetrofitCandidates rotate mode still ignores credential presence", async () => {
  const workspace = await setupWorkspace();
  await saveConfiguredCredential(workspace, "ready-one.com", "server85");
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      {
        ...legacyServer("server85", "ready-one.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: true }
      }
    ]
  }));

  const rotateCandidates = await listSmtpSaslRetrofitCandidates(workspace, { domain: "ready-one.com" }, "rotate");
  assert.deepEqual(rotateCandidates.map((candidate) => ({
    serverSlug: candidate.serverSlug,
    reason: candidate.reason
  })), [{
    serverSlug: "server85",
    reason: "rotate"
  }]);
});

test("listSmtpSaslRetrofitCandidates can scope retrofit to one domain or server", async () => {
  const workspace = await setupWorkspace();
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      legacyServer("server88", "legacy-two.com")
    ]
  }));

  const byDomain = await listSmtpSaslRetrofitCandidates(workspace, { domain: "legacy-two.com" });
  assert.deepEqual(byDomain.map((candidate) => candidate.serverSlug), ["server88"]);

  const byServer = await listSmtpSaslRetrofitCandidates(workspace, { serverSlug: "server85" });
  assert.deepEqual(byServer.map((candidate) => candidate.domain), ["legacy-one.com"]);
});

test("listSmtpSaslRetrofitCandidates recover mode targets configured SMTP auth missing credential", async () => {
  const workspace = await setupWorkspace();
  await saveConfiguredCredential(workspace, "ready-one.com", "server88");
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      { ...legacyServer("server85", "legacy-one.com"), smtpAuthStatus: "configured" },
      {
        ...legacyServer("server88", "ready-one.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: true }
      }
    ]
  }));

  const candidates = await listSmtpSaslRetrofitCandidates(workspace, {}, "recover");
  assert.deepEqual(candidates.map((candidate) => ({
    serverSlug: candidate.serverSlug,
    reason: candidate.reason
  })), [{
    serverSlug: "server85",
    reason: "missing_credential"
  }]);
});

test("reconcileSmtpProvisioningCredentialFlags downgrades stale true flags only once", async () => {
  const workspace = await setupWorkspace();
  await saveConfiguredCredential(workspace, "ready-one.com", "server88");
  await saveConfiguredCredential(workspace, "store-configured-flag-false.com", "server91");
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      {
        ...legacyServer("server85", "missing-material.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: true }
      },
      {
        ...legacyServer("server88", "ready-one.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: true }
      },
      {
        ...legacyServer("server89", "do-not-upgrade.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: false }
      },
      {
        ...legacyServer("server91", "store-configured-flag-false.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { hasCredential: false }
      },
      {
        ...legacyServer("server90", "metadata-without-flag.com"),
        smtpAuthStatus: "configured",
        smtpCredential: { status: "configured" }
      }
    ]
  }));

  const first = await reconcileSmtpProvisioningCredentialFlags(
    workspace,
    () => new Date("2026-06-22T15:00:00.000Z")
  );
  assert.deepEqual(first, { scanned: 5, staleDowngraded: 2 });
  const second = await reconcileSmtpProvisioningCredentialFlags(
    workspace,
    () => new Date("2026-06-22T16:00:00.000Z")
  );
  assert.deepEqual(second, { scanned: 5, staleDowngraded: 0 });

  const provisioning = await workspace.readInventoryJson<{
    servers: Array<{ domain: string; smtpCredential?: { hasCredential?: boolean }; updatedAt: string }>;
  }>("smtp-provisioning.json");
  assert.equal(
    provisioning?.servers.find((server) => server.domain === "missing-material.com")?.smtpCredential?.hasCredential,
    false
  );
  assert.equal(
    provisioning?.servers.find((server) => server.domain === "missing-material.com")?.updatedAt,
    "2026-06-22T15:00:00.000Z"
  );
  assert.equal(
    provisioning?.servers.find((server) => server.domain === "ready-one.com")?.smtpCredential?.hasCredential,
    true
  );
  assert.equal(
    provisioning?.servers.find((server) => server.domain === "do-not-upgrade.com")?.smtpCredential?.hasCredential,
    false
  );
  assert.equal(
    provisioning?.servers.find((server) => server.domain === "store-configured-flag-false.com")?.smtpCredential?.hasCredential,
    false
  );
  assert.equal(
    provisioning?.servers.find((server) => server.domain === "metadata-without-flag.com")?.smtpCredential?.hasCredential,
    false
  );
});

test("buildSmtpSaslRetrofitPlan is additive, keeps permit_mynetworks, and redacts password from commands", () => {
  const plan = buildSmtpSaslRetrofitPlan({
    domain: "legacy-one.com",
    username: "mailer@legacy-one.com",
    password: "smtp-secret-password"
  });

  assert.equal(plan.some((step) => step.label === "install-dovecot"), true);
  assert.equal(plan.some((step) => step.label === "write-sasl-passdb"), true);
  assert.equal(plan.some((step) => step.label === "patch-postfix-main-cf-sasl"), true);
  assert.equal(plan.some((step) => step.label === "validate-local-smtp-and-submission"), true);
  assert.deepEqual(
    plan.map((step) => step.label),
    [
      "install-dovecot",
      "write-dovecot-auth-conf",
      "write-dovecot-logging-conf",
      "write-dovecot-master-conf",
      "write-dovecot-passwd-conf",
      "write-sasl-passdb",
      "patch-postfix-main-cf-sasl",
      "enable-postfix-submission-smtps",
      "restart-services",
      "validate-local-smtp-and-submission"
    ]
  );
  const postfixPatch = plan.find((step) => step.label === "patch-postfix-main-cf-sasl");
  assert.match(postfixPatch?.command ?? "", /permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination/);
  const auth = plan.find((step) => step.label === "write-dovecot-auth-conf");
  const logging = plan.find((step) => step.label === "write-dovecot-logging-conf");
  assert.match(auth?.stdin ?? "", /disable_plaintext_auth = yes/);
  assert.match(logging?.stdin ?? "", /auth_debug = no/);
  assert.match(logging?.stdin ?? "", /auth_debug_passwords = no/);
  const passdb = plan.find((step) => step.label === "write-sasl-passdb");
  assert.equal(passdb?.stdin, "smtp-secret-password\n");
  assert.equal(plan.some((step) => step.command.includes("smtp-secret-password")), false);
  assert.equal(plan.some((step) => step.auditCommand.includes("smtp-secret-password")), false);
});

test("runSmtpSaslRetrofitBatch persists configured credentials and continues after per-server failure", async () => {
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      legacyServer("server88", "legacy-two.com")
    ]
  }));
  const commands: SmtpSshCommandInput[] = [];
  const runner: SmtpSshRunner = {
    isConfigured: () => true,
    run: async (input) => {
      commands.push(input);
      if (input.serverSlug === "server88") {
        throw new Error("ssh unavailable");
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    }
  };

  const result = await runSmtpSaslRetrofitBatch({
    workspace,
    auditLog,
    sshRunner: runner,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    actorId: "operator/juanes",
    now: () => fixedNow
  });

  assert.equal(result.candidates, 2);
  assert.equal(result.results.find((entry) => entry.serverSlug === "server85")?.status, "configured");
  assert.equal(result.results.find((entry) => entry.serverSlug === "server88")?.status, "failed");
  assert.equal(result.results.find((entry) => entry.serverSlug === "server88")?.stepCount, 0);
  assert.equal(result.results.find((entry) => entry.serverSlug === "server88")?.failedStep, "install-dovecot");
  assert.equal(commands.some((command) => command.serverSlug === "server85"), true);
  assert.equal(commands.some((command) => command.serverSlug === "server88"), true);

  const provisioning = await workspace.readInventoryJson<{
    servers: Array<{ serverSlug: string; smtpAuthStatus?: string; smtpCredential?: { hasCredential?: boolean } }>;
  }>("smtp-provisioning.json");
  const server85 = provisioning?.servers.find((server) => server.serverSlug === "server85");
  assert.equal(server85?.smtpAuthStatus, "configured");
  assert.equal(server85?.smtpCredential?.hasCredential, true);

  const domains = await workspace.readInventoryJson<unknown>("domains.json");
  const serializedDomains = JSON.stringify(domains);
  assert.match(serializedDomains, /smtpCredentialEncrypted/);
  assert.equal(serializedDomains.includes("smtp-secret-password"), false);
  const audits = await auditLog.list();
  assert.equal(audits.length, 2);
  assert.equal(JSON.stringify(audits).includes("smtp-secret-password"), false);
  const domainsAfterFailure = await workspace.readInventoryJson<{
    smtpCredentials: Array<{ domain: string; status: string }>;
  }>("domains.json");
  assert.equal(
    domainsAfterFailure?.smtpCredentials.find((entry) => entry.domain === "legacy-two.com")?.status,
    "install_failed"
  );
});

test("runSmtpSaslRetrofitBatch with domain only mutates that SMTP", async () => {
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      legacyServer("server88", "legacy-two.com")
    ]
  }));
  const commands: SmtpSshCommandInput[] = [];

  const result = await runSmtpSaslRetrofitBatch({
    workspace,
    auditLog,
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    actorId: "operator/juanes",
    target: { domain: "legacy-one.com" },
    now: () => fixedNow
  });

  assert.equal(result.candidates, 1);
  assert.deepEqual(result.results.map((entry) => entry.serverSlug), ["server85"]);
  assert.equal(commands.every((command) => command.serverSlug === "server85"), true);
  const provisioning = await workspace.readInventoryJson<{
    servers: Array<{ serverSlug: string; smtpAuthStatus?: string; smtpCredential?: { hasCredential?: boolean } }>;
  }>("smtp-provisioning.json");
  assert.equal(provisioning?.servers.find((server) => server.serverSlug === "server85")?.smtpAuthStatus, "configured");
  assert.equal(provisioning?.servers.find((server) => server.serverSlug === "server88")?.smtpAuthStatus, undefined);
});

test("POST /v1/smtp/retrofit-sasl-batch requires read-boundary token and approval", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  const response = captureResponse();
  await handleSmtpSaslRetrofitBatchHttp({
    request: request("POST", "/v1/smtp/retrofit-sasl-batch", { approvalToken: "exec-retrofit" }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner(),
    readCanvasState: () => canvasState([]),
    readBoundaryToken: "read-token",
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });
  assert.equal(response.statusCode, 401);
  assert.equal((await auditLog.list()).length, 0);
});

test("POST /v1/smtp/retrofit-sasl-batch runs approved batch and audits without secrets", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await appendApproval(auditLog, "artifact-retrofit", "exec-retrofit");
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [legacyServer("server85", "legacy-one.com")]
  }));
  const commands: SmtpSshCommandInput[] = [];
  const response = captureResponse();

  await handleSmtpSaslRetrofitBatchHttp({
    request: request("POST", "/v1/smtp/retrofit-sasl-batch", {
      actorId: "operator/juanes",
      approvalToken: "exec-retrofit"
    }, {
      "x-delivrix-token": "read-token",
      "x-operator-id": "operator/juanes"
    }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    readCanvasState: () => canvasState([{ artifactId: "artifact-retrofit", executionId: "exec-retrofit" }]),
    readBoundaryToken: "read-token",
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as { candidates: number; results: Array<{ status: string }> };
  assert.equal(payload.candidates, 1);
  assert.equal(payload.results[0]?.status, "configured");
  assert.equal(commands.length, 10);
  const audits = await auditLog.list();
  assert.equal(audits.some((event) => event.action === "oc.smtp_sasl.retrofit_batch_requested"), true);
  assert.equal(audits.at(-1)?.action, "oc.smtp_sasl.retrofit_batch_completed");
  assert.equal(JSON.stringify(audits).includes("smtp-secret-password"), false);
});

test("POST /v1/smtp/retrofit-sasl-batch accepts a single-target domain", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await appendApproval(auditLog, "artifact-retrofit", "exec-retrofit");
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      legacyServer("server88", "legacy-two.com")
    ]
  }));
  const commands: SmtpSshCommandInput[] = [];
  const response = captureResponse();

  await handleSmtpSaslRetrofitBatchHttp({
    request: request("POST", "/v1/smtp/retrofit-sasl-batch", {
      actorId: "operator/juanes",
      approvalToken: "exec-retrofit",
      domain: "legacy-two.com"
    }, {
      "x-delivrix-token": "read-token",
      "x-operator-id": "operator/juanes"
    }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    readCanvasState: () => canvasState([{ artifactId: "artifact-retrofit", executionId: "exec-retrofit" }]),
    readBoundaryToken: "read-token",
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as { candidates: number; results: Array<{ domain: string; status: string }> };
  assert.equal(payload.candidates, 1);
  assert.deepEqual(payload.results.map((entry) => entry.domain), ["legacy-two.com"]);
  assert.equal(commands.every((command) => command.serverSlug === "server88"), true);
  const audits = await auditLog.list();
  assert.equal(audits.at(-1)?.metadata.domain, "legacy-two.com");
});

test("POST /v1/smtp/retrofit-sasl-batch accepts a single-target serverSlug", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await appendApproval(auditLog, "artifact-retrofit", "exec-retrofit");
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      legacyServer("server88", "legacy-two.com")
    ]
  }));
  const commands: SmtpSshCommandInput[] = [];
  const response = captureResponse();

  await handleSmtpSaslRetrofitBatchHttp({
    request: request("POST", "/v1/smtp/retrofit-sasl-batch", {
      actorId: "operator/juanes",
      approvalToken: "exec-retrofit",
      serverSlug: "server85"
    }, {
      "x-delivrix-token": "read-token",
      "x-operator-id": "operator/juanes"
    }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    readCanvasState: () => canvasState([{ artifactId: "artifact-retrofit", executionId: "exec-retrofit" }]),
    readBoundaryToken: "read-token",
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as { candidates: number; results: Array<{ serverSlug: string; status: string }> };
  assert.equal(payload.candidates, 1);
  assert.deepEqual(payload.results.map((entry) => entry.serverSlug), ["server85"]);
  assert.equal(commands.every((command) => command.serverSlug === "server85"), true);
  const audits = await auditLog.list();
  assert.equal(audits.at(-1)?.metadata.serverSlug, "server85");
});

test("POST /v1/smtp/retrofit-sasl-batch rejects invalid target domain before SSH", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  const commands: SmtpSshCommandInput[] = [];
  const response = captureResponse();

  await handleSmtpSaslRetrofitBatchHttp({
    request: request("POST", "/v1/smtp/retrofit-sasl-batch", {
      actorId: "operator/juanes",
      approvalToken: "exec-retrofit",
      domain: "../legacy-one.com"
    }, {
      "x-delivrix-token": "read-token",
      "x-operator-id": "operator/juanes"
    }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    readCanvasState: () => canvasState([]),
    readBoundaryToken: "read-token",
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 422);
  assert.equal(commands.length, 0);
  assert.equal((await auditLog.list()).length, 0);
});

async function setupWorkspace(): Promise<OpenClawWorkspace> {
  const rootDir = await mkdtemp(join(tmpdir(), "smtp-sasl-retrofit-"));
  return new OpenClawWorkspace({ rootDir, now: () => fixedNow });
}

function legacyServer(serverSlug: string, domain: string) {
  return {
    serverSlug,
    domain,
    serverIp: serverSlug === "server85" ? "192.0.2.85" : "192.0.2.88",
    selector: "default",
    status: "configured" as const,
    tlsStatus: "attempted_or_pending_dns" as const,
    configuredAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString()
  };
}

async function saveConfiguredCredential(
  workspace: OpenClawWorkspace,
  domain: string,
  serverSlug: string
): Promise<void> {
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain,
    serverSlug,
    now: () => fixedNow,
    passwordFactory: () => "smtp-secret-password"
  });
  await saveSmtpCredentialRecord(workspace, markSmtpCredentialConfigured(material.record, fixedNow));
}

function mockRunner(overrides: Partial<SmtpSshRunner> = {}): SmtpSshRunner {
  return {
    isConfigured: () => true,
    run: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
    ...overrides
  };
}

function request(
  method: string,
  url: string,
  body: unknown = {},
  headers: Record<string, string> = {}
): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method,
    url,
    headers
  }) as IncomingMessage;
}

function captureResponse(): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  writeHead: (statusCode: number, headers?: Record<string, string>) => void;
  end: (payload?: string) => void;
} {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(statusCode: number, headers: Record<string, string> = {}): void {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(payload = ""): void {
      this.body = payload;
    }
  };
}

async function appendApproval(
  auditLog: LocalFileAuditLog,
  artifactId: string,
  executionId: string
): Promise<void> {
  await auditLog.append({
    occurredAt: fixedNow.toISOString(),
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

function canvasState(approvals: Array<{ artifactId: string; executionId: string }>): CanvasLiveStateSnapshot {
  return {
    schemaVersion: "2026-05-25.canvas-live.v1",
    generatedAt: fixedNow.toISOString(),
    tasks: [],
    artifacts: approvals.map((approval) => ({
      artifactId: approval.artifactId,
      taskId: "task-retrofit",
      kind: "proposal",
      title: "Retrofit SMTP AUTH",
      editable: true,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      blocks: [],
      approvalStatus: "approved",
      executionId: approval.executionId,
      approvedAt: fixedNow.toISOString()
    }))
  };
}

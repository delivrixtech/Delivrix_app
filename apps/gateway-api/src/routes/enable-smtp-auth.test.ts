import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import { handleEnableSmtpAuthHttp } from "./enable-smtp-auth.ts";
import type { SmtpSshCommandInput, SmtpSshRunner } from "./smtp-provisioning.ts";

const fixedNow = new Date("2026-06-23T14:00:00.000Z");
const credentialEncryptionKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

test("enable_smtp_auth configures exactly one domain and returns status only", async () => {
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      legacyServer("server88", "legacy-two.com")
    ]
  }));
  const commands: SmtpSshCommandInput[] = [];
  const response = captureResponse();

  await handleEnableSmtpAuthHttp({
    request: request({ actorId: "operator/juanes", domain: "legacy-one.com" }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as Record<string, unknown>;
  assert.deepEqual(payload, {
    ok: true,
    domain: "legacy-one.com",
    mode: "enable",
    status: "configured",
    hasCredential: true
  });
  assert.equal(commands.length, 10);
  assert.equal(commands.every((command) => command.serverSlug === "server85"), true);

  const provisioning = await workspace.readInventoryJson<{
    servers: Array<{ serverSlug: string; smtpAuthStatus?: string; smtpCredential?: { hasCredential?: boolean } }>;
  }>("smtp-provisioning.json");
  assert.equal(provisioning?.servers.find((server) => server.serverSlug === "server85")?.smtpAuthStatus, "configured");
  assert.equal(provisioning?.servers.find((server) => server.serverSlug === "server85")?.smtpCredential?.hasCredential, true);
  assert.equal(provisioning?.servers.find((server) => server.serverSlug === "server88")?.smtpAuthStatus, undefined);

  const serializedResponse = JSON.stringify(payload);
  const serializedAudit = JSON.stringify(await auditLog.list());
  for (const forbidden of ["Password:", "smtpCredentialEncrypted", "ciphertext", "authTag", "smtp-secret-password"]) {
    assert.equal(serializedResponse.includes(forbidden), false, `response leaked ${forbidden}`);
    assert.equal(serializedAudit.includes(forbidden), false, `audit leaked ${forbidden}`);
  }
  assert.match(serializedAudit, /credentialFingerprint/);
  assert.match(serializedAudit, /oc\.smtp_auth\.enabled/);
});

test("enable_smtp_auth fails closed without encryption key before SSH or partial credential", async () => {
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [legacyServer("server85", "legacy-one.com")]
  }));
  const commands: SmtpSshCommandInput[] = [];
  const response = captureResponse();

  await handleEnableSmtpAuthHttp({
    request: request({ actorId: "operator/juanes", domain: "legacy-one.com" }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    env: {},
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 409);
  assert.equal(commands.length, 0);
  const payload = JSON.parse(response.body) as Record<string, unknown>;
  assert.equal(payload.ok, false);
  assert.deepEqual(payload, {
    ok: false,
    domain: "legacy-one.com",
    mode: "enable",
    status: "credential_encryption_key_missing",
    hasCredential: false
  });
  const domains = await workspace.readInventoryJson<{ smtpCredentials?: unknown[] }>("domains.json").catch(() => null);
  assert.equal((domains?.smtpCredentials ?? []).length, 0);
  const provisioning = await workspace.readInventoryJson<{
    servers: Array<{ serverSlug: string; smtpAuthStatus?: string }>;
  }>("smtp-provisioning.json");
  assert.equal(provisioning?.servers[0]?.smtpAuthStatus, undefined);
});

test("enable_smtp_auth redacts SSH error messages that include the generated password", async () => {
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [legacyServer("server85", "legacy-one.com")]
  }));
  let leakedPassword = "";
  const response = captureResponse();

  await handleEnableSmtpAuthHttp({
    request: request({ actorId: "operator/juanes", domain: "legacy-one.com" }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner({
      run: async (input) => {
        if (input.stdin && input.command.includes("SMTP_AUTH_PASSWORD")) {
          leakedPassword = input.stdin.trim();
          throw new Error(`runner leaked stdin ${leakedPassword}`);
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 409);
  assert.ok(leakedPassword.length > 10);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    domain: "legacy-one.com",
    mode: "enable",
    status: "install_failed",
    hasCredential: false
  });
  const serialized = `${response.body}\n${JSON.stringify(await auditLog.list())}`;
  assert.equal(serialized.includes(leakedPassword), false);
  assert.match(serialized, /\[REDACTED_SMTP_PASSWORD\]/);
});

test("enable_smtp_auth rejects ambiguous same-domain candidates before SSH", async () => {
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [
      legacyServer("server85", "legacy-one.com"),
      { ...legacyServer("server88", "legacy-one.com"), serverIp: "192.0.2.88" }
    ]
  }));
  const commands: SmtpSshCommandInput[] = [];
  const response = captureResponse();

  await handleEnableSmtpAuthHttp({
    request: request({ actorId: "operator/juanes", domain: "legacy-one.com" }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner({
      run: async (input) => {
        commands.push(input);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
    }),
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 409);
  assert.equal(commands.length, 0);
  assert.equal(JSON.parse(response.body).status, "ambiguous_domain");
  assert.equal((await auditLog.list()).at(-1)?.metadata.candidateCount, 2);
});

test("enable_smtp_auth rotate mode regenerates configured credential without leaking material", async () => {
  const workspace = await setupWorkspace();
  const auditLog = new LocalFileAuditLog(join(workspace.getRootDir(), "audit-events.jsonl"));
  await workspace.updateInventoryJson("smtp-provisioning.json", () => ({
    servers: [legacyServer("server85", "legacy-one.com")]
  }));
  await handleEnableSmtpAuthHttp({
    request: request({ actorId: "operator/juanes", domain: "legacy-one.com" }),
    response: captureResponse() as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner(),
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });
  const before = await workspace.readInventoryJson<{ smtpCredentials: Array<{ smtpCredentialEncrypted: { ciphertext: string } }> }>("smtp-credentials.json");
  const beforeCiphertext = before?.smtpCredentials[0]?.smtpCredentialEncrypted.ciphertext;

  const response = captureResponse();
  await handleEnableSmtpAuthHttp({
    request: request({ actorId: "operator/juanes", domain: "legacy-one.com", mode: "rotate" }),
    response: response as unknown as ServerResponse,
    workspace,
    auditLog,
    sshRunner: mockRunner(),
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => new Date("2026-06-23T15:00:00.000Z")
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as Record<string, unknown>;
  assert.equal(payload.mode, "rotate");
  assert.equal(payload.status, "configured");
  assert.equal(payload.hasCredential, true);
  const after = await workspace.readInventoryJson<{ smtpCredentials: Array<{ smtpCredentialEncrypted: { ciphertext: string } }> }>("smtp-credentials.json");
  assert.notEqual(after?.smtpCredentials[0]?.smtpCredentialEncrypted.ciphertext, beforeCiphertext);
  const serialized = `${response.body}\n${JSON.stringify(await auditLog.list())}`;
  for (const forbidden of ["Password:", "smtpCredentialEncrypted", "ciphertext", "authTag"]) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
  assert.match(serialized, /"mode":"rotate"/);
});

async function setupWorkspace(): Promise<OpenClawWorkspace> {
  const rootDir = await mkdtemp(join(tmpdir(), "enable-smtp-auth-"));
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

function mockRunner(overrides: Partial<SmtpSshRunner> = {}): SmtpSshRunner {
  return {
    isConfigured: () => true,
    run: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
    ...overrides
  };
}

function request(body: unknown): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    method: "POST",
    url: "/v1/smtp/enable-auth",
    headers: {}
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

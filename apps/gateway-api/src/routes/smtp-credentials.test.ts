import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalFileAuditLog } from "../../../../packages/local-store/src/index.ts";
import { OpenClawWorkspace } from "../openclaw-workspace.ts";
import {
  markSmtpCredentialConfigured,
  prepareSmtpCredential,
  saveSmtpCredentialRecord
} from "../smtp-credentials.ts";
import {
  handleSmtpCredentialDownloadHttp,
  handleSmtpCredentialInventoryExportHttp
} from "./smtp-credentials.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const fixedNow = new Date("2026-06-22T14:00:00.000Z");
const credentialEncryptionKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

test("GET /v1/sender-pool/credentials/:domain/download returns markdown and audits without secrets", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const harness = await routeHarness();
  await writeConfiguredCredential(harness.workspace);
  const response = captureResponse();

  await handleSmtpCredentialDownloadHttp({
    request: request("GET", "/v1/sender-pool/credentials/delivrix-mail.com/download", {
      "x-delivrix-token": "read-token",
      "x-operator-id": "operator/juanes"
    }),
    response: response as unknown as ServerResponse,
    workspace: harness.workspace,
    auditLog: harness.auditLog,
    readBoundaryToken: "read-token",
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["content-disposition"], 'attachment; filename="smtp-credentials-delivrix-mail.com.md"');
  assert.match(response.body, /Password: smtp-secret-password/);
  assert.match(response.body, /Usuario: mailer@delivrix-mail\.com/);

  const events = await harness.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.smtp_credential.downloaded");
  const serializedAudit = JSON.stringify(events);
  assert.equal(serializedAudit.includes("smtp-secret-password"), false);
  assert.equal(serializedAudit.includes("ciphertext"), false);
  assert.equal(serializedAudit.includes("authTag"), false);
});

test("GET /v1/sender-pool/credentials/:domain/download requires read boundary token", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const harness = await routeHarness();
  await writeConfiguredCredential(harness.workspace);
  const response = captureResponse();

  await handleSmtpCredentialDownloadHttp({
    request: request("GET", "/v1/sender-pool/credentials/delivrix-mail.com/download"),
    response: response as unknown as ServerResponse,
    workspace: harness.workspace,
    auditLog: harness.auditLog,
    readBoundaryToken: "read-token",
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 401);
  assert.equal((await harness.auditLog.list()).length, 0);
});

test("GET /v1/sender-pool/credentials/export returns public metadata only", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const harness = await routeHarness();
  await writeConfiguredCredential(harness.workspace);
  const response = captureResponse();

  await handleSmtpCredentialInventoryExportHttp({
    request: request("GET", "/v1/sender-pool/credentials/export", {
      "x-delivrix-token": "read-token",
      "x-operator-id": "operator/juanes"
    }),
    response: response as unknown as ServerResponse,
    workspace: harness.workspace,
    auditLog: harness.auditLog,
    readBoundaryToken: "read-token",
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    now: () => fixedNow
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as { credentials: Array<{ domain: string; hasCredential: boolean; username: string }> };
  assert.equal(payload.credentials[0]?.domain, "delivrix-mail.com");
  assert.equal(payload.credentials[0]?.hasCredential, true);
  assert.equal(payload.credentials[0]?.username, "mailer@delivrix-mail.com");
  assert.equal(response.body.includes("smtp-secret-password"), false);
  assert.equal(response.body.includes("ciphertext"), false);
  const events = await harness.auditLog.list();
  assert.equal(events.at(-1)?.action, "oc.smtp_credential.inventory_exported");
  assert.equal(JSON.stringify(events).includes("smtp-secret-password"), false);
});

async function routeHarness(): Promise<{
  workspace: OpenClawWorkspace;
  auditLog: LocalFileAuditLog;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "smtp-credential-route-"));
  return {
    workspace: new OpenClawWorkspace({ rootDir: join(rootDir, "workspace"), now: () => fixedNow }),
    auditLog: new LocalFileAuditLog(join(rootDir, "audit-events.jsonl"))
  };
}

async function writeConfiguredCredential(workspace: OpenClawWorkspace): Promise<void> {
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "delivrix-mail.com",
    serverSlug: "mail-prod-1",
    host: "smtp.delivrix-mail.com",
    now: () => fixedNow,
    passwordFactory: () => "smtp-secret-password"
  });
  await saveSmtpCredentialRecord(workspace, markSmtpCredentialConfigured(material.record, fixedNow));
}

function request(
  method: string,
  url: string,
  headers: Record<string, string> = {}
): IncomingMessage {
  const stream = Readable.from([]);
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

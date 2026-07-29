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
  attachSshAccessToRecord,
  markSmtpCredentialConfigured,
  prepareSmtpCredential,
  saveSmtpCredentialRecord
} from "../smtp-credentials.ts";
import {
  handleSmtpCredentialBulkDownloadHttp,
  handleSmtpCredentialDownloadHttp,
  handleSmtpCredentialInventoryExportHttp
} from "./smtp-credentials.ts";
import { readZipEntries } from "../zip-archive.test-helpers.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const fixedNow = new Date("2026-06-22T14:00:00.000Z");
const credentialEncryptionKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const sshPrivateKeyFixture = "-----BEGIN PRIVATE KEY-----\nFIXTURE-OPS-KEY\n-----END PRIVATE KEY-----\n";

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
  assert.match(response.body, /Cliente de correo/);
  assert.match(response.body, /Nodemailer con puerto 587 STARTTLS/);
  assert.match(response.body, /secure: false/);
  assert.match(response.body, /Nodemailer con puerto 465 TLS implicito/);
  assert.match(response.body, /swaks --server 'smtp\.delivrix-mail\.com'.*--auth LOGIN/);
  assert.match(response.body, /solo a contactos opt-in/);
  assert.match(response.body, /No contiene claves DKIM privadas ni acceso SSH/);

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

test("GET /v1/sender-pool/credentials/download-all empaqueta un .md por dominio configurado", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const harness = await routeHarness();
  await writeConfiguredCredential(harness.workspace);
  await writeConfiguredCredential(harness.workspace, {
    domain: "delivrix-send.com",
    host: "smtp.delivrix-send.com",
    password: "otra-password-secreta"
  });
  const response = captureBinaryResponse();

  await handleSmtpCredentialBulkDownloadHttp({
    request: request("GET", "/v1/sender-pool/credentials/download-all", {
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
  assert.equal(response.headers["content-type"], "application/zip");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["content-disposition"], 'attachment; filename="smtp-credentials-2026-06-22.zip"');
  assert.equal(response.headers["content-length"], String(response.body.length));

  const entries = readZipEntries(response.body);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    "_INVENTARIO.md",
    "smtp-credentials-delivrix-mail.com.md",
    "smtp-credentials-delivrix-send.com.md"
  ]);

  const mailEntry = entries.find((entry) => entry.name === "smtp-credentials-delivrix-mail.com.md");
  assert.match(mailEntry?.content ?? "", /Password: smtp-secret-password/);
  assert.match(mailEntry?.content ?? "", /Usuario: mailer@delivrix-mail\.com/);
  const sendEntry = entries.find((entry) => entry.name === "smtp-credentials-delivrix-send.com.md");
  assert.match(sendEntry?.content ?? "", /Password: otra-password-secreta/);

  const inventory = entries.find((entry) => entry.name === "_INVENTARIO.md");
  assert.match(inventory?.content ?? "", /Dominios incluidos: 2/);
  assert.match(inventory?.content ?? "", /Dominios omitidos: 0/);
  // El índice no debe filtrar passwords.
  assert.equal(inventory?.content.includes("smtp-secret-password"), false);
  assert.equal(entries.some((entry) => entry.name === "_ERRORES.md"), false);
});

test("GET /v1/sender-pool/credentials/download-all incluye el acceso SSH: seccion en el .md y .pem aparte", async () => {
  // Este test pineaba lo CONTRARIO ("nunca incluye la clave SSH privada"). Esa exclusion era
  // una decision de seguridad razonada, pero rompio el flujo real: el operador de bounces
  // recibio el ZIP, no encontro acceso por puerto 22 en ningun dominio y asumio que el
  // documento salio mal generado — el aviso vivia solo en _INVENTARIO.md, no en cada .md.
  // Decision del owner 2026-07-29: el paquete masivo va completo.
  resetSensitiveReadAuthBucketsForTests();
  const harness = await routeHarness();
  await writeConfiguredCredential(harness.workspace, { sshPrivateKey: sshPrivateKeyFixture });
  const response = captureBinaryResponse();

  await handleSmtpCredentialBulkDownloadHttp({
    request: request("GET", "/v1/sender-pool/credentials/download-all", {
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
  const entries = readZipEntries(response.body);

  // La seccion SSH viaja dentro del .md del dominio, con puerto y clave.
  const credential = entries.find((entry) => entry.name === "smtp-credentials-delivrix-mail.com.md");
  assert.match(credential?.content ?? "", /Password: smtp-secret-password/);
  assert.match(credential?.content ?? "", /## Acceso SSH \(operaciones\)/);
  assert.match(credential?.content ?? "", /Puerto: 22/);
  assert.match(credential?.content ?? "", /Usuario: delivrix-ops/);
  assert.equal(credential?.content.includes("BEGIN PRIVATE KEY"), true);
  // Y el .md apunta al .pem que viaja al lado, listo para chmod 600 + ssh -i.
  assert.match(credential?.content ?? "", /delivrix-ops-delivrix-mail\.com\.pem/);

  const pem = entries.find((entry) => entry.name === "delivrix-ops-delivrix-mail.com.pem");
  assert.equal(pem?.content.includes("BEGIN"), true);

  // El inventario declara cuantos accesos viajan.
  const inventory = entries.find((entry) => entry.name === "_INVENTARIO.md");
  assert.match(inventory?.content ?? "", /Accesos SSH ops incluidos: 1 de 1/);

  const events = await harness.auditLog.list();
  const audit = events.at(-1);
  assert.equal(audit?.action, "oc.smtp_credential.bulk_downloaded");
  assert.equal(audit?.metadata?.includedSshAccess, true);
  assert.equal(audit?.metadata?.sshKeyCount, 1);
  // La clave viaja en el ZIP, jamas en el log de auditoria.
  assert.equal(JSON.stringify(audit).includes("BEGIN PRIVATE KEY"), false);
});

test("download-all: un nodo SIN acceso ops lo DICE en su .md en vez de omitir la seccion", async () => {
  // La omision silenciosa fue exactamente lo que hizo fracasar la primera entrega: un faltante
  // sin declarar es indistinguible de un documento mal generado.
  resetSensitiveReadAuthBucketsForTests();
  const harness = await routeHarness();
  await writeConfiguredCredential(harness.workspace, { sshPrivateKey: sshPrivateKeyFixture });
  await writeConfiguredCredential(harness.workspace, {
    domain: "sin-ssh.com",
    serverSlug: "mail-prod-9",
    host: "smtp.sin-ssh.com"
  });
  const response = captureBinaryResponse();

  await handleSmtpCredentialBulkDownloadHttp({
    request: request("GET", "/v1/sender-pool/credentials/download-all", {
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
  const entries = readZipEntries(response.body);

  const sinSsh = entries.find((entry) => entry.name === "smtp-credentials-sin-ssh.com.md");
  assert.match(sinSsh?.content ?? "", /## Acceso SSH \(operaciones\)/);
  assert.match(sinSsh?.content ?? "", /NO tiene acceso SSH ops aprovisionado/);
  assert.equal(sinSsh?.content.includes("BEGIN PRIVATE KEY"), false);
  // Sin acceso no hay .pem para ese dominio.
  assert.equal(entries.some((entry) => entry.name === "delivrix-ops-sin-ssh.com.pem"), false);

  // El inventario distingue el estado por dominio y el total es veraz.
  const inventory = entries.find((entry) => entry.name === "_INVENTARIO.md");
  assert.match(inventory?.content ?? "", /Accesos SSH ops incluidos: 1 de 2/);
  assert.match(inventory?.content ?? "", /NO APROVISIONADO/);

  const audit = (await harness.auditLog.list()).at(-1);
  assert.deepEqual(audit?.metadata?.sshUnavailable, [{ domain: "sin-ssh.com", reason: "not_provisioned" }]);
});

test("GET /v1/sender-pool/credentials/download-all reporta los dominios no listos sin romper el zip", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const harness = await routeHarness();
  await writeConfiguredCredential(harness.workspace);
  await writePendingCredential(harness.workspace, "delivrix-pending.com");
  const response = captureBinaryResponse();

  await handleSmtpCredentialBulkDownloadHttp({
    request: request("GET", "/v1/sender-pool/credentials/download-all", {
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
  const entries = readZipEntries(response.body);
  assert.equal(entries.some((entry) => entry.name === "smtp-credentials-delivrix-mail.com.md"), true);
  assert.equal(entries.some((entry) => entry.name === "smtp-credentials-delivrix-pending.com.md"), false);
  const errores = entries.find((entry) => entry.name === "_ERRORES.md");
  assert.match(errores?.content ?? "", /delivrix-pending\.com \| .* \| smtp_credential_not_ready/);

  const events = await harness.auditLog.list();
  const audit = events.at(-1);
  assert.equal(audit?.action, "oc.smtp_credential.bulk_downloaded");
  assert.equal(audit?.metadata?.credentialCount, 1);
  assert.equal(audit?.metadata?.failureCount, 1);
  assert.equal(JSON.stringify(events).includes("smtp-secret-password"), false);
});

test("GET /v1/sender-pool/credentials/download-all responde 409 si ningún dominio está listo", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const harness = await routeHarness();
  await writePendingCredential(harness.workspace, "delivrix-pending.com");
  const response = captureBinaryResponse();

  await handleSmtpCredentialBulkDownloadHttp({
    request: request("GET", "/v1/sender-pool/credentials/download-all", {
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

  assert.equal(response.statusCode, 409);
  assert.equal(JSON.parse(response.body.toString("utf8")).error, "smtp_credential_none_ready");
  assert.equal((await harness.auditLog.list()).length, 0);
});

test("GET /v1/sender-pool/credentials/download-all requiere read boundary token", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const harness = await routeHarness();
  await writeConfiguredCredential(harness.workspace);
  const response = captureBinaryResponse();

  await handleSmtpCredentialBulkDownloadHttp({
    request: request("GET", "/v1/sender-pool/credentials/download-all"),
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

async function writeConfiguredCredential(
  workspace: OpenClawWorkspace,
  options: {
    domain?: string;
    serverSlug?: string;
    host?: string;
    password?: string;
    sshPrivateKey?: string;
  } = {}
): Promise<void> {
  const domain = options.domain ?? "delivrix-mail.com";
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain,
    serverSlug: options.serverSlug ?? "mail-prod-1",
    host: options.host ?? "smtp.delivrix-mail.com",
    now: () => fixedNow,
    passwordFactory: () => options.password ?? "smtp-secret-password"
  });
  const configured = markSmtpCredentialConfigured(material.record, fixedNow);
  const withSsh = options.sshPrivateKey
    ? attachSshAccessToRecord({
        record: configured,
        env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
        user: "delivrix-ops",
        host: "203.0.113.10",
        privateKeyPem: options.sshPrivateKey,
        now: () => fixedNow
      })
    : configured;
  await saveSmtpCredentialRecord(workspace, withSsh);
}

/** Credencial existente pero todavía sin instalar en el box (status pending_install). */
async function writePendingCredential(workspace: OpenClawWorkspace, domain: string): Promise<void> {
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain,
    serverSlug: "mail-prod-2",
    host: `smtp.${domain}`,
    now: () => fixedNow,
    passwordFactory: () => "pending-password"
  });
  await saveSmtpCredentialRecord(workspace, material.record);
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

/** Igual que captureResponse pero conserva el body binario (zip) sin pasarlo por string. */
function captureBinaryResponse(): {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  writeHead: (statusCode: number, headers?: Record<string, string>) => void;
  end: (payload?: string | Buffer) => void;
} {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(statusCode: number, headers: Record<string, string> = {}): void {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(payload: string | Buffer = Buffer.alloc(0)): void {
      this.body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    }
  };
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

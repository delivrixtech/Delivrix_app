import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import {
  decryptSmtpCredentialForDownload,
  listSmtpCredentialPublicMetadata,
  markSmtpCredentialConfigured,
  markSmtpCredentialInstallFailed,
  prepareSmtpCredential,
  renderSmtpCredentialMarkdown,
  saveSmtpCredentialRecord,
  smtpCredentialFingerprint,
  SmtpCredentialError
} from "./smtp-credentials.ts";

const fixedNow = new Date("2026-06-22T14:00:00.000Z");
const credentialEncryptionKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

test("SMTP credentials are encrypted at rest and downloadable only after configured", async () => {
  const workspace = await setupWorkspace();
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "Delivrix-Mail.COM.",
    serverSlug: "mail-prod-1",
    host: "smtp.delivrix-mail.com",
    now: () => fixedNow,
    passwordFactory: () => "smtp-secret-password"
  });
  await saveSmtpCredentialRecord(workspace, material.record);

  const inventoryBefore = await workspace.readInventoryJson<unknown>("domains.json");
  const serializedBefore = JSON.stringify(inventoryBefore);
  assert.equal(serializedBefore.includes("smtp-secret-password"), false);
  assert.match(serializedBefore, /smtpCredentialEncrypted/);
  await assert.rejects(
    () => decryptSmtpCredentialForDownload({
      workspace,
      env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
      domain: "delivrix-mail.com"
    }),
    (error) => error instanceof SmtpCredentialError && error.code === "smtp_credential_not_ready"
  );

  const configuredRecord = markSmtpCredentialConfigured(material.record, fixedNow);
  await saveSmtpCredentialRecord(workspace, configuredRecord);
  const download = await decryptSmtpCredentialForDownload({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "delivrix-mail.com"
  });
  assert.equal(download.password, "smtp-secret-password");

  const markdown = renderSmtpCredentialMarkdown({
    record: download.record,
    password: download.password,
    generatedAt: fixedNow.toISOString()
  });
  assert.match(markdown, /Host: smtp\.delivrix-mail\.com/);
  assert.match(markdown, /Usuario: mailer@delivrix-mail\.com/);
  assert.match(markdown, /Password: smtp-secret-password/);
  assert.match(markdown, /Cliente de correo/);
  assert.match(markdown, /STARTTLS/);
  assert.match(markdown, /secure: false/);
  assert.match(markdown, /secure: true/);
  assert.match(markdown, /swaks --server 'smtp\.delivrix-mail\.com'.*--auth LOGIN/);
  assert.match(markdown, /quejas y rebotes combinados por debajo de 5%/);
  assert.match(markdown, /solo a contactos opt-in/);
  assert.match(markdown, /no expira automaticamente/i);
  assert.doesNotMatch(markdown, /BEGIN PRIVATE KEY|dkimPrivateKey/);
});

test("SMTP credential install failure keeps encrypted material non-downloadable", async () => {
  const workspace = await setupWorkspace();
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "delivrix-mail.com",
    serverSlug: "mail-prod-1",
    now: () => fixedNow,
    passwordFactory: () => "smtp-secret-password"
  });
  await saveSmtpCredentialRecord(workspace, markSmtpCredentialInstallFailed(material.record, fixedNow));
  await assert.rejects(
    () => decryptSmtpCredentialForDownload({
      workspace,
      env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
      domain: "delivrix-mail.com"
    }),
    (error) => error instanceof SmtpCredentialError && error.code === "smtp_credential_not_ready"
  );
});

test("SMTP credentials survive restart even if legacy domains inventory loses smtpCredentials", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "smtp-credentials-restart-"));
  const workspace = new OpenClawWorkspace({ rootDir, now: () => fixedNow });
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "durable-mail.com",
    serverSlug: "mail-prod-1",
    now: () => fixedNow,
    passwordFactory: () => "smtp-secret-password"
  });
  await saveSmtpCredentialRecord(workspace, markSmtpCredentialConfigured(material.record, fixedNow));

  await workspace.updateInventoryJson("domains.json", () => ({
    domains: [{ domain: "durable-mail.com", status: "owned" }]
  }));

  const restartedWorkspace = new OpenClawWorkspace({ rootDir, now: () => fixedNow });
  const download = await decryptSmtpCredentialForDownload({
    workspace: restartedWorkspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "durable-mail.com"
  });
  assert.equal(download.password, "smtp-secret-password");

  const metadata = await listSmtpCredentialPublicMetadata(restartedWorkspace);
  assert.deepEqual(metadata.map((entry) => ({
    domain: entry.domain,
    status: entry.status,
    hasCredential: entry.hasCredential
  })), [{
    domain: "durable-mail.com",
    status: "configured",
    hasCredential: true
  }]);
});

test("SMTP credential save does not depend on writable legacy domains mirror", async () => {
  const workspace = await setupWorkspace();
  const material = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "mirror-corrupt.com",
    serverSlug: "mail-prod-1",
    now: () => fixedNow,
    passwordFactory: () => "smtp-secret-password"
  });
  await workspace.ensureBase();
  await writeFile(join(workspace.getRootDir(), "inventory", "domains.json"), "{\"domains\":[", "utf8");

  await saveSmtpCredentialRecord(workspace, markSmtpCredentialConfigured(material.record, fixedNow));

  const download = await decryptSmtpCredentialForDownload({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "mirror-corrupt.com"
  });
  assert.equal(download.password, "smtp-secret-password");
});

test("forceRotate generates a new credential without exposing plaintext in inventory", async () => {
  const workspace = await setupWorkspace();
  const first = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "rotate-mail.com",
    serverSlug: "mail-prod-1",
    now: () => fixedNow,
    passwordFactory: () => "old-smtp-secret"
  });
  const configuredFirst = markSmtpCredentialConfigured(first.record, fixedNow);
  await saveSmtpCredentialRecord(workspace, configuredFirst);

  const rotated = await prepareSmtpCredential({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "rotate-mail.com",
    serverSlug: "mail-prod-1",
    now: () => new Date("2026-06-22T15:00:00.000Z"),
    passwordFactory: () => "new-smtp-secret",
    forceRotate: true
  });
  const configuredRotated = markSmtpCredentialConfigured(rotated.record, new Date("2026-06-22T15:00:00.000Z"));
  await saveSmtpCredentialRecord(workspace, configuredRotated);

  assert.notEqual(smtpCredentialFingerprint(configuredFirst), smtpCredentialFingerprint(configuredRotated));
  const download = await decryptSmtpCredentialForDownload({
    workspace,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    domain: "rotate-mail.com"
  });
  assert.equal(download.password, "new-smtp-secret");
  const serialized = JSON.stringify(await workspace.readInventoryJson("smtp-credentials.json"));
  assert.equal(serialized.includes("old-smtp-secret"), false);
  assert.equal(serialized.includes("new-smtp-secret"), false);
});

test("SMTP credential encryption key fails closed when missing or invalid", async () => {
  const workspace = await setupWorkspace();
  await assert.rejects(
    () => prepareSmtpCredential({
      workspace,
      env: {},
      domain: "delivrix-mail.com",
      serverSlug: "mail-prod-1"
    }),
    (error) => error instanceof SmtpCredentialError && error.code === "credential_encryption_key_missing"
  );
  await assert.rejects(
    () => prepareSmtpCredential({
      workspace,
      env: { CREDENTIAL_ENCRYPTION_KEY: "too-short" },
      domain: "delivrix-mail.com",
      serverSlug: "mail-prod-1"
    }),
    (error) => error instanceof SmtpCredentialError && error.code === "credential_encryption_key_invalid"
  );
});

async function setupWorkspace(): Promise<OpenClawWorkspace> {
  const rootDir = await mkdtemp(join(tmpdir(), "smtp-credentials-"));
  return new OpenClawWorkspace({ rootDir, now: () => fixedNow });
}

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import {
  decryptSmtpCredentialForDownload,
  markSmtpCredentialConfigured,
  markSmtpCredentialInstallFailed,
  prepareSmtpCredential,
  renderSmtpCredentialMarkdown,
  saveSmtpCredentialRecord,
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

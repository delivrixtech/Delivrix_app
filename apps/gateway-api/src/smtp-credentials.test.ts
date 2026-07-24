import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenClawWorkspace } from "./openclaw-workspace.ts";
import {
  attachSshAccessToRecord,
  decryptSmtpCredentialForDownload,
  decryptSshPrivateKey,
  listSmtpCredentialPublicMetadata,
  markSmtpCredentialConfigured,
  markSmtpCredentialInstallFailed,
  prepareSmtpCredential,
  removeSshAccessFromRecord,
  renderSmtpCredentialMarkdown,
  saveSmtpCredentialRecord,
  smtpCredentialFingerprint,
  SmtpCredentialError
} from "./smtp-credentials.ts";
import { generateOpsSshKeyPair } from "./ssh-ops-key.ts";

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

test("SSH ops access: cifrado en reposo, round-trip y render de la seccion SSH", async () => {
  const workspace = await setupWorkspace();
  const env = { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey };
  const material = await prepareSmtpCredential({
    workspace,
    env,
    domain: "corpfiling-ops.com",
    serverSlug: "contabo-9001",
    host: "smtp.corpfiling-ops.com",
    now: () => fixedNow,
    passwordFactory: () => "smtp-secret-password"
  });
  const configured = markSmtpCredentialConfigured(material.record, fixedNow);

  const keyPair = generateOpsSshKeyPair("delivrix-ops@corpfiling-ops.com");
  const withSsh = attachSshAccessToRecord({
    record: configured,
    env,
    user: "delivrix-ops",
    host: "203.0.113.9",
    privateKeyPem: keyPair.privateKeyPem,
    now: () => fixedNow
  });
  await saveSmtpCredentialRecord(workspace, withSsh);

  // La clave privada NO queda en claro en el inventario persistido.
  const inventory = await workspace.readInventoryJson<unknown>("smtp-credentials.json");
  const serialized = JSON.stringify(inventory);
  assert.equal(serialized.includes("BEGIN PRIVATE KEY"), false);
  assert.match(serialized, /privateKeyEncrypted/);

  // Round-trip: descifra a la misma PEM.
  assert.equal(decryptSshPrivateKey(withSsh, env), keyPair.privateKeyPem);

  // Download trae la clave SSH y el render incluye la seccion.
  const download = await decryptSmtpCredentialForDownload({
    workspace,
    env,
    domain: "corpfiling-ops.com"
  });
  assert.equal(download.sshPrivateKey, keyPair.privateKeyPem);
  const markdown = renderSmtpCredentialMarkdown({
    record: download.record,
    password: download.password,
    sshPrivateKey: download.sshPrivateKey,
    generatedAt: fixedNow.toISOString()
  });
  assert.match(markdown, /## Acceso SSH \(operaciones\)/);
  assert.match(markdown, /Usuario: delivrix-ops/);
  assert.match(markdown, /ssh -i delivrix-ops\.pem/);
  assert.ok(markdown.includes(keyPair.privateKeyPem.trimEnd()));
  assert.equal(markdown.includes("No contiene claves DKIM privadas ni acceso SSH"), false);

  // La metadata publica expone que hay SSH pero nunca la clave.
  const metadata = await listSmtpCredentialPublicMetadata(workspace);
  const entry = metadata.find((m) => m.domain === "corpfiling-ops.com");
  assert.equal(entry?.hasSshAccess, true);
  assert.equal(entry?.sshUser, "delivrix-ops");
  assert.equal(JSON.stringify(metadata).includes("BEGIN PRIVATE KEY"), false);
});

test("SSH ops access: sin acceso SSH el render lo omite y conserva la nota original", () => {
  const record = {
    domain: "no-ssh.com",
    serverSlug: null,
    host: "smtp.no-ssh.com",
    username: "mailer@no-ssh.com",
    status: "configured" as const,
    ports: { submission: 587 as const, smtps: 465 as const },
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    smtpCredentialEncrypted: {
      algorithm: "aes-256-gcm" as const,
      iv: "x",
      authTag: "y",
      ciphertext: "z"
    }
  };
  const markdown = renderSmtpCredentialMarkdown({
    record,
    password: "pw",
    generatedAt: fixedNow.toISOString()
  });
  assert.equal(markdown.includes("## Acceso SSH"), false);
  assert.match(markdown, /No contiene claves DKIM privadas ni acceso SSH/);
});

test("SSH ops access: removeSshAccessFromRecord limpia el acceso (revocacion)", () => {
  const keyPair = generateOpsSshKeyPair("delivrix-ops@x.com");
  const base = {
    domain: "x.com",
    serverSlug: null,
    host: "smtp.x.com",
    username: "mailer@x.com",
    status: "configured" as const,
    ports: { submission: 587 as const, smtps: 465 as const },
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    smtpCredentialEncrypted: {
      algorithm: "aes-256-gcm" as const,
      iv: "x",
      authTag: "y",
      ciphertext: "z"
    }
  };
  const withSsh = attachSshAccessToRecord({
    record: base,
    env: { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey },
    user: "delivrix-ops",
    host: "198.51.100.7",
    privateKeyPem: keyPair.privateKeyPem,
    now: () => fixedNow
  });
  assert.ok(withSsh.sshAccess);
  const revoked = removeSshAccessFromRecord(withSsh, fixedNow);
  assert.equal(revoked.sshAccess, null);
  assert.equal(decryptSshPrivateKey(revoked, { CREDENTIAL_ENCRYPTION_KEY: credentialEncryptionKey }), null);
});

async function setupWorkspace(): Promise<OpenClawWorkspace> {
  const rootDir = await mkdtemp(join(tmpdir(), "smtp-credentials-"));
  return new OpenClawWorkspace({ rootDir, now: () => fixedNow });
}

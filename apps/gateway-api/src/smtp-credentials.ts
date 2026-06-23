import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import type { OpenClawWorkspace } from "./openclaw-workspace.ts";
import { smtpHostForDomain } from "./smtp-naming.ts";

export interface SmtpCredentialEncryptedPayload {
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface SmtpCredentialRecord {
  domain: string;
  serverSlug?: string | null;
  host: string;
  username: string;
  status: SmtpCredentialStatus;
  ports: {
    submission: 587;
    smtps: 465;
  };
  createdAt: string;
  updatedAt: string;
  smtpCredentialEncrypted: SmtpCredentialEncryptedPayload;
}

export interface SmtpCredentialPublicMetadata {
  domain: string;
  serverSlug?: string | null;
  host: string;
  username: string;
  status: SmtpCredentialStatus;
  ports: {
    submission: 587;
    smtps: 465;
  };
  createdAt: string;
  updatedAt: string;
  hasCredential: boolean;
}

export interface SmtpCredentialMaterial {
  record: SmtpCredentialRecord;
  password: string;
  generated: boolean;
}

export type SmtpCredentialStatus = "pending_install" | "configured" | "install_failed";

interface DomainsInventory {
  smtpCredentials?: SmtpCredentialRecord[];
}

const algorithm = "aes-256-gcm";
const keyEnvName = "CREDENTIAL_ENCRYPTION_KEY";
const passwordBytes = 27;

export function smtpCredentialUsername(domain: string): string {
  return `mailer@${normalizeDomain(domain)}`;
}

export function generateSmtpPassword(): string {
  return randomBytes(passwordBytes).toString("base64url");
}

export async function ensureSmtpCredential(input: {
  workspace: OpenClawWorkspace;
  env?: Record<string, string | undefined>;
  domain: string;
  serverSlug?: string | null;
  host?: string;
  now?: () => Date;
  passwordFactory?: () => string;
}): Promise<SmtpCredentialMaterial> {
  const material = await prepareSmtpCredential(input);
  if (material.generated) {
    await saveSmtpCredentialRecord(input.workspace, material.record);
  }
  return material;
}

export async function prepareSmtpCredential(input: {
  workspace: OpenClawWorkspace;
  env?: Record<string, string | undefined>;
  domain: string;
  serverSlug?: string | null;
  host?: string;
  now?: () => Date;
  passwordFactory?: () => string;
}): Promise<SmtpCredentialMaterial> {
  const domain = normalizeDomain(input.domain);
  const host = normalizeHost(input.host ?? smtpHostForDomain(domain));
  const username = smtpCredentialUsername(domain);
  const existing = await findSmtpCredentialRecord(input.workspace, domain, input.serverSlug);
  const key = credentialEncryptionKey(input.env);
  if (existing) {
    return {
      record: existing,
      password: decryptSmtpCredentialPassword(existing, key),
      generated: false
    };
  }

  const now = (input.now?.() ?? new Date()).toISOString();
  const password = input.passwordFactory?.() ?? generateSmtpPassword();
  const record: SmtpCredentialRecord = {
    domain,
    serverSlug: normalizeOptionalServerSlug(input.serverSlug),
    host,
    username,
    status: "pending_install",
    ports: { submission: 587, smtps: 465 },
    createdAt: now,
    updatedAt: now,
    smtpCredentialEncrypted: encryptSmtpCredentialPassword(password, key, {
      domain,
      host,
      username
    })
  };

  return { record, password, generated: true };
}

export async function saveSmtpCredentialRecord(
  workspace: OpenClawWorkspace,
  record: SmtpCredentialRecord
): Promise<void> {
  await upsertSmtpCredentialRecord(workspace, record);
}

export function markSmtpCredentialConfigured(
  record: SmtpCredentialRecord,
  now: Date = new Date()
): SmtpCredentialRecord {
  return {
    ...record,
    status: "configured",
    updatedAt: now.toISOString()
  };
}

export function markSmtpCredentialInstallFailed(
  record: SmtpCredentialRecord,
  now: Date = new Date()
): SmtpCredentialRecord {
  return {
    ...record,
    status: "install_failed",
    updatedAt: now.toISOString()
  };
}

export async function findSmtpCredentialRecord(
  workspace: OpenClawWorkspace,
  domainInput: string,
  serverSlugInput?: string | null
): Promise<SmtpCredentialRecord | null> {
  const domain = normalizeDomain(domainInput);
  const serverSlug = normalizeOptionalServerSlug(serverSlugInput);
  const inventory = await workspace.readInventoryJson<DomainsInventory>("domains.json").catch(() => null);
  const records = inventory?.smtpCredentials ?? [];
  const exact = records.find((record) =>
    record.domain === domain &&
    (serverSlug ? record.serverSlug === serverSlug : true) &&
    isSmtpCredentialRecord(record)
  );
  if (exact) return exact;
  return records.find((record) => record.domain === domain && isSmtpCredentialRecord(record)) ?? null;
}

export async function listSmtpCredentialPublicMetadata(
  workspace: OpenClawWorkspace
): Promise<SmtpCredentialPublicMetadata[]> {
  const inventory = await workspace.readInventoryJson<DomainsInventory>("domains.json").catch(() => null);
  return (inventory?.smtpCredentials ?? [])
    .filter(isSmtpCredentialRecord)
    .map(publicSmtpCredentialMetadata);
}

export async function decryptSmtpCredentialForDownload(input: {
  workspace: OpenClawWorkspace;
  env?: Record<string, string | undefined>;
  domain: string;
}): Promise<{ record: SmtpCredentialRecord; password: string }> {
  const record = await findSmtpCredentialRecord(input.workspace, input.domain);
  if (!record) {
    throw new SmtpCredentialError("smtp_credential_not_found");
  }
  if (record.status !== "configured") {
    throw new SmtpCredentialError("smtp_credential_not_ready");
  }
  return {
    record,
    password: decryptSmtpCredentialPassword(record, credentialEncryptionKey(input.env))
  };
}

export function renderSmtpCredentialMarkdown(input: {
  record: SmtpCredentialRecord;
  password: string;
  generatedAt?: string;
}): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return [
    `# Credenciales SMTP - ${input.record.domain}`,
    "",
    `Generado: ${generatedAt}`,
    "",
    "## SMTP",
    "",
    `- Host: ${input.record.host}`,
    "- Puerto STARTTLS: 587",
    "- Puerto SSL/TLS: 465",
    `- Usuario: ${input.record.username}`,
    `- Password: ${input.password}`,
    "",
    "## Integracion",
    "",
    "Usa autenticacion SMTP AUTH con mecanismo PLAIN o LOGIN.",
    "Para clientes modernos, preferir puerto 587 con STARTTLS. Si el cliente requiere TLS implicito, usar 465.",
    "",
    "## Seguridad",
    "",
    "Esta credencial no expira automaticamente. Rotala si sale del circuito aprobado o si hay sospecha de exposicion.",
    "No compartas este archivo por chat. No contiene claves DKIM privadas ni acceso SSH.",
    "Si sospechas exposicion, rota la credencial desde el panel operativo antes de seguir enviando.",
    ""
  ].join("\n");
}

export function publicSmtpCredentialMetadata(record: SmtpCredentialRecord): SmtpCredentialPublicMetadata {
  return {
    domain: record.domain,
    serverSlug: record.serverSlug ?? null,
    host: record.host,
    username: record.username,
    status: record.status,
    ports: record.ports,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hasCredential: record.status === "configured"
  };
}

export function smtpCredentialFingerprint(record: SmtpCredentialRecord): string {
  return createHash("sha256")
    .update(`${record.domain}\0${record.username}\0${record.smtpCredentialEncrypted.ciphertext}`)
    .digest("hex")
    .slice(0, 16);
}

export class SmtpCredentialError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "SmtpCredentialError";
    this.code = code;
  }
}

async function upsertSmtpCredentialRecord(
  workspace: OpenClawWorkspace,
  record: SmtpCredentialRecord
): Promise<void> {
  await workspace.updateInventoryJson<DomainsInventory>("domains.json", (current) => {
    const smtpCredentials = [...(current?.smtpCredentials ?? [])];
    const index = smtpCredentials.findIndex((entry) =>
      entry.domain === record.domain &&
      (record.serverSlug ? entry.serverSlug === record.serverSlug : true)
    );
    if (index >= 0) {
      smtpCredentials[index] = {
        ...smtpCredentials[index],
        ...record,
        createdAt: smtpCredentials[index]?.createdAt ?? record.createdAt
      };
    } else {
      smtpCredentials.push(record);
    }
    return {
      ...(current ?? {}),
      smtpCredentials
    };
  });
}

function encryptSmtpCredentialPassword(
  password: string,
  key: Buffer,
  aad: { domain: string; host: string; username: string }
): SmtpCredentialEncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return {
    algorithm,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

function decryptSmtpCredentialPassword(record: SmtpCredentialRecord, key: Buffer): string {
  const payload = record.smtpCredentialEncrypted;
  if (payload.algorithm !== algorithm) {
    throw new SmtpCredentialError("smtp_credential_unsupported_algorithm");
  }
  const decipher = createDecipheriv(algorithm, key, Buffer.from(payload.iv, "base64url"));
  decipher.setAAD(Buffer.from(JSON.stringify({
    domain: record.domain,
    host: record.host,
    username: record.username
  })));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function credentialEncryptionKey(env: Record<string, string | undefined> | undefined): Buffer {
  const raw = env?.[keyEnvName] ?? process.env[keyEnvName];
  if (!raw || raw.trim().length === 0) {
    throw new SmtpCredentialError("credential_encryption_key_missing");
  }
  const trimmed = raw.trim();
  const candidates = [
    Buffer.from(trimmed, "base64url"),
    Buffer.from(trimmed, "base64"),
    /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.alloc(0),
    Buffer.from(trimmed, "utf8")
  ];
  const key = candidates.find((candidate) => candidate.length === 32);
  if (!key) {
    throw new SmtpCredentialError("credential_encryption_key_invalid");
  }
  return key;
}

function isSmtpCredentialRecord(value: unknown): value is SmtpCredentialRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SmtpCredentialRecord>;
  return typeof record.domain === "string" &&
    typeof record.host === "string" &&
    typeof record.username === "string" &&
    (record.status === "pending_install" || record.status === "configured" || record.status === "install_failed") &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    record.ports?.submission === 587 &&
    record.ports?.smtps === 465 &&
    Boolean(record.smtpCredentialEncrypted) &&
    record.smtpCredentialEncrypted?.algorithm === algorithm;
}

function normalizeDomain(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(normalized)) {
    throw new SmtpCredentialError("smtp_credential_domain_invalid");
  }
  return normalized;
}

function normalizeHost(value: string): string {
  return normalizeDomain(value);
}

function normalizeOptionalServerSlug(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

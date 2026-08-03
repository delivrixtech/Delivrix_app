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

export interface SmtpCredentialSshAccess {
  /** Usuario SSH dedicado creado en el box (distinto del root de la automatización). */
  user: string;
  /** Host al que el operador hace SSH (IP o hostname del box). */
  host: string;
  /** Puerto SSH (por defecto 22). */
  port: number;
  /** Clave privada PKCS#8 PEM, cifrada en reposo (AES-256-GCM). */
  privateKeyEncrypted: SmtpCredentialEncryptedPayload;
  createdAt: string;
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
  /** Acceso SSH "ops" complementario (opcional, provisionado aparte y revocable). */
  sshAccess?: SmtpCredentialSshAccess | null;
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
  hasSshAccess: boolean;
  sshUser?: string | null;
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

interface SmtpCredentialsInventory {
  smtpCredentials?: SmtpCredentialRecord[];
}

const algorithm = "aes-256-gcm";
const keyEnvName = "CREDENTIAL_ENCRYPTION_KEY";
const passwordBytes = 27;
const durableCredentialsInventory = "smtp-credentials.json";
const legacyDomainsInventory = "domains.json";

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
  forceRotate?: boolean;
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
  forceRotate?: boolean;
}): Promise<SmtpCredentialMaterial> {
  const domain = normalizeDomain(input.domain);
  const host = normalizeHost(input.host ?? smtpHostForDomain(domain));
  const username = smtpCredentialUsername(domain);
  const existing = await findSmtpCredentialRecord(input.workspace, domain, input.serverSlug);
  const key = credentialEncryptionKey(input.env);
  if (existing && input.forceRotate !== true) {
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
    createdAt: existing?.createdAt ?? now,
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
  const records = await readSmtpCredentialRecords(workspace);
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
  return (await readSmtpCredentialRecords(workspace))
    .filter(isSmtpCredentialRecord)
    .map(publicSmtpCredentialMetadata);
}

export async function decryptSmtpCredentialForDownload(input: {
  workspace: OpenClawWorkspace;
  env?: Record<string, string | undefined>;
  domain: string;
}): Promise<{ record: SmtpCredentialRecord; password: string; sshPrivateKey: string | null }> {
  const record = await findSmtpCredentialRecord(input.workspace, input.domain);
  if (!record) {
    throw new SmtpCredentialError("smtp_credential_not_found");
  }
  if (record.status !== "configured") {
    throw new SmtpCredentialError("smtp_credential_not_ready");
  }
  const key = credentialEncryptionKey(input.env);
  return {
    record,
    password: decryptSmtpCredentialPassword(record, key),
    sshPrivateKey: record.sshAccess
      ? decryptSecret(record.sshAccess.privateKeyEncrypted, key, sshPrivateKeyAad(record.domain, record.sshAccess.user))
      : null
  };
}

export interface SmtpCredentialBulkEntry {
  record: SmtpCredentialRecord;
  password: string;
  /** null cuando el nodo no tiene acceso ops o su clave no se pudo descifrar. */
  sshPrivateKey: string | null;
  /** Por que falta la clave SSH. El paquete lo DICE en vez de omitir la seccion en silencio. */
  sshUnavailableReason?: "not_provisioned" | "ssh_decrypt_failed";
}

export interface SmtpCredentialBulkFailure {
  domain: string;
  serverSlug: string | null;
  code: string;
}

/**
 * Descifra todas las credenciales SMTP listas para descarga masiva, INCLUIDO el acceso SSH ops.
 *
 * La version anterior excluia las claves SSH a proposito ("demasiado material sensible en un
 * solo archivo") y mandaba a bajar el acceso ops dominio por dominio. Eso rompio el flujo real:
 * el operador de bounces necesita entrar a los ~70 nodos, el bulk existe justamente para no
 * bajar 70 archivos uno por uno, y la omision era silenciosa por dominio — el .md ni mencionaba
 * SSH. Resultado: el operador asumio que el documento salio mal generado. Decision del owner
 * 2026-07-29: el paquete masivo lleva el acceso completo, con la advertencia de manejo a la
 * altura de lo que contiene.
 *
 * Un fallo al descifrar la clave SSH NO tumba la entrada: la credencial SMTP que si funciona
 * se entrega igual, y el motivo queda en `sshUnavailableReason` para que el paquete lo diga.
 *
 * Los dominios que no se pueden descifrar no rompen el lote: salen en
 * `failures` para que el caller los reporte junto al resto.
 */
export async function decryptAllSmtpCredentialsForDownload(input: {
  workspace: OpenClawWorkspace;
  env?: Record<string, string | undefined>;
}): Promise<{ entries: SmtpCredentialBulkEntry[]; failures: SmtpCredentialBulkFailure[]; total: number }> {
  // Si falta la llave de cifrado falla el request completo, no dominio por dominio.
  const key = credentialEncryptionKey(input.env);
  const records = (await readSmtpCredentialRecords(input.workspace))
    .filter(isSmtpCredentialRecord)
    .sort((left, right) => left.domain.localeCompare(right.domain));
  const entries: SmtpCredentialBulkEntry[] = [];
  const failures: SmtpCredentialBulkFailure[] = [];

  for (const record of records) {
    if (record.status !== "configured") {
      failures.push({
        domain: record.domain,
        serverSlug: record.serverSlug ?? null,
        code: "smtp_credential_not_ready"
      });
      continue;
    }
    try {
      const password = decryptSmtpCredentialPassword(record, key);
      if (!record.sshAccess) {
        entries.push({ record, password, sshPrivateKey: null, sshUnavailableReason: "not_provisioned" });
        continue;
      }
      try {
        entries.push({
          record,
          password,
          sshPrivateKey: decryptSecret(
            record.sshAccess.privateKeyEncrypted,
            key,
            sshPrivateKeyAad(record.domain, record.sshAccess.user)
          )
        });
      } catch {
        // La clave SSH ilegible no puede costarle al operador la credencial SMTP que si
        // funciona. Se entrega el SMTP y el paquete declara por que falta el acceso ops.
        entries.push({ record, password, sshPrivateKey: null, sshUnavailableReason: "ssh_decrypt_failed" });
      }
    } catch (error) {
      failures.push({
        domain: record.domain,
        serverSlug: record.serverSlug ?? null,
        code: error instanceof SmtpCredentialError ? error.code : "smtp_credential_decrypt_failed"
      });
    }
  }

  return { entries, failures, total: records.length };
}

/**
 * Cifra la clave privada SSH generada y la adjunta al record (sin persistir).
 * El caller guarda con saveSmtpCredentialRecord. La AAD ata el ciphertext al
 * dominio + usuario + propósito, así un ciphertext no se puede mover de slot.
 */
export function attachSshAccessToRecord(input: {
  record: SmtpCredentialRecord;
  env?: Record<string, string | undefined>;
  user: string;
  host: string;
  port?: number;
  privateKeyPem: string;
  now?: () => Date;
}): SmtpCredentialRecord {
  const key = credentialEncryptionKey(input.env);
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  return {
    ...input.record,
    updatedAt: createdAt,
    sshAccess: {
      user: input.user,
      host: input.host,
      port: input.port ?? 22,
      privateKeyEncrypted: encryptSecret(
        input.privateKeyPem,
        key,
        sshPrivateKeyAad(input.record.domain, input.user)
      ),
      createdAt
    }
  };
}

/** Descifra la clave privada SSH del record, o null si no tiene acceso SSH. */
export function decryptSshPrivateKey(
  record: SmtpCredentialRecord,
  env?: Record<string, string | undefined>
): string | null {
  if (!record.sshAccess) return null;
  return decryptSecret(
    record.sshAccess.privateKeyEncrypted,
    credentialEncryptionKey(env),
    sshPrivateKeyAad(record.domain, record.sshAccess.user)
  );
}

/** Quita el acceso SSH del record (para revocación). No borra el usuario del box. */
export function removeSshAccessFromRecord(
  record: SmtpCredentialRecord,
  now: Date = new Date()
): SmtpCredentialRecord {
  const { sshAccess: _dropped, ...rest } = record;
  return { ...rest, sshAccess: null, updatedAt: now.toISOString() };
}

export function renderSmtpCredentialMarkdown(input: {
  record: SmtpCredentialRecord;
  password: string;
  generatedAt?: string;
  sshPrivateKey?: string | null;
  /** Por que falta la clave SSH, para DECIRLO. La seccion nunca desaparece en silencio. */
  sshUnavailableReason?: "not_provisioned" | "ssh_decrypt_failed";
  /** Nombre del .pem que viaja junto a este .md (paquete masivo). */
  sshKeyFileName?: string;
}): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const sshAccess = input.record.sshAccess;
  const includeSsh = Boolean(sshAccess && input.sshPrivateKey);
  const lines: string[] = [
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
    "## Cliente de correo",
    "",
    "Configuracion de salida para Thunderbird, Outlook, Apple Mail o clientes equivalentes:",
    "",
    `- Servidor de salida: ${input.record.host}`,
    "- Puerto recomendado: 587",
    "- Seguridad: STARTTLS",
    "- Metodo de autenticacion: password normal / SMTP AUTH LOGIN o PLAIN",
    `- Nombre de usuario: ${input.record.username}`,
    "",
    "Si el cliente requiere TLS implicito, usa:",
    "",
    `- Servidor de salida: ${input.record.host}`,
    "- Puerto: 465",
    "- Seguridad: SSL/TLS",
    "- Metodo de autenticacion: password normal / SMTP AUTH LOGIN o PLAIN",
    "",
    "## Codigo",
    "",
    "Ejemplo Nodemailer con puerto 587 STARTTLS:",
    "",
    "```js",
    "import nodemailer from \"nodemailer\";",
    "",
    "const transporter = nodemailer.createTransport({",
    `  host: \"${input.record.host}\",`,
    "  port: 587,",
    "  secure: false,",
    "  requireTLS: true,",
    "  auth: {",
    `    user: \"${input.record.username}\",`,
    `    pass: \"${input.password}\"`,
    "  }",
    "});",
    "```",
    "",
    "Ejemplo Nodemailer con puerto 465 TLS implicito:",
    "",
    "```js",
    "import nodemailer from \"nodemailer\";",
    "",
    "const transporter = nodemailer.createTransport({",
    `  host: \"${input.record.host}\",`,
    "  port: 465,",
    "  secure: true,",
    "  auth: {",
    `    user: \"${input.record.username}\",`,
    `    pass: \"${input.password}\"`,
    "  }",
    "});",
    "```",
    "",
    "## Prueba rapida",
    "",
    "```bash",
    `swaks --server ${shellArg(input.record.host)} --port 587 --tls --auth LOGIN --auth-user ${shellArg(input.record.username)} --auth-password ${shellArg(input.password)} --from ${shellArg(input.record.username)} --to postmaster@${shellArg(input.record.domain)} --quit-after AUTH`,
    "```",
    "",
    "## Buenas practicas",
    "",
    "- Usa From/Return-Path alineados con este dominio y manten TLS activo.",
    "- Calienta el dominio gradualmente antes de subir volumen.",
    "- Respeta rate limits del sender y del dominio durante warmup.",
    "- Mantener quejas y rebotes combinados por debajo de 5%.",
    "- Enviar solo a contactos opt-in y respetar opt-out/suppression lists.",
    "- Guarda este archivo en un vault aprobado; no lo pegues en chat, tickets ni logs.",
    "- Rota esta credencial si sale del circuito aprobado o si hay sospecha de exposicion.",
    "",
    "## Seguridad",
    "",
    "Esta credencial no expira automaticamente. Rotala si sale del circuito aprobado o si hay sospecha de exposicion.",
    includeSsh
      ? "No compartas este archivo por chat. Ademas del SMTP incluye una clave SSH privada (acceso ops); tratalo como material sensible."
      : "No compartas este archivo por chat. No contiene claves DKIM privadas ni acceso SSH.",
    "Si sospechas exposicion, rota la credencial desde el panel operativo antes de seguir enviando.",
    ""
  ];

  // La seccion SSH SIEMPRE existe, en uno de tres estados. La version que la omitia sin aviso
  // le costo horas a un operador real: recibio el paquete masivo, no encontro "puerto 22" en
  // ningun dominio, y concluyo que el documento salio mal generado. Un dato que falta se
  // declara; no se borra la seccion.
  if (includeSsh && sshAccess && input.sshPrivateKey) {
    lines.push(...renderSshAccessSection(sshAccess, input.sshPrivateKey, input.sshKeyFileName));
  } else if (sshAccess) {
    lines.push(
      "## Acceso SSH (operaciones)",
      "",
      "Este nodo TIENE acceso ops aprovisionado, pero la clave privada no pudo incluirse en este",
      "documento" + (input.sshUnavailableReason === "ssh_decrypt_failed"
        ? " (fallo el descifrado de la clave; reporta esto al operador del panel para re-aprovisionar el acceso)."
        : "."),
      "",
      `- Usuario: ${sshAccess.user}`,
      `- Host: ${sshAccess.host}`,
      `- Puerto: ${sshAccess.port}`,
      "",
      "Descarga la credencial individual de este dominio desde el panel para obtener la clave.",
      ""
    );
  } else {
    lines.push(
      "## Acceso SSH (operaciones)",
      "",
      "Este nodo NO tiene acceso SSH ops aprovisionado todavia. Sin esto no se puede entrar al",
      "VPS (por ejemplo para instalar el colector de bounces). Pedile al operador del panel que",
      "lo aprovisione (POST /v1/servers/:slug/provision-ops-ssh) y volve a bajar el documento.",
      ""
    );
  }

  return lines.join("\n");
}

function renderSshAccessSection(
  sshAccess: SmtpCredentialSshAccess,
  privateKeyPem: string,
  keyFileName?: string
): string[] {
  const keyFile = keyFileName ?? "delivrix-ops.pem";
  const trimmedKey = privateKeyPem.endsWith("\n") ? privateKeyPem.slice(0, -1) : privateKeyPem;
  return [
    "## Acceso SSH (operaciones)",
    "",
    "Acceso administrativo dedicado a este nodo para monitoreo/operacion (por ejemplo instalar",
    "un script que reporte bounces). Es un usuario propio con sudo, con clave separada de la",
    "automatizacion, y es revocable/rotable por nodo sin afectar el envio.",
    "",
    `- Usuario: ${sshAccess.user}`,
    `- Host: ${sshAccess.host}`,
    `- Puerto: ${sshAccess.port}`,
    `- Sudo: si (NOPASSWD)`,
    "",
    keyFileName
      ? `La clave ya viene en este paquete como \`${keyFile}\`, junto a este documento. Dale permisos 600 y conecta:`
      : `Guarda la clave privada como \`${keyFile}\` con permisos 600 y conecta:`,
    "",
    "```bash",
    `chmod 600 ${keyFile}`,
    `ssh -i ${keyFile} -o IdentitiesOnly=yes -p ${sshAccess.port} ${sshAccess.user}@${sshAccess.host}`,
    "```",
    "",
    "Clave privada (PEM):",
    "",
    "```",
    trimmedKey,
    "```",
    "",
    "- Esta NO es la clave root de la automatizacion; es exclusiva de este nodo.",
    "- Si sale del circuito aprobado, pedi que se revoque/rote el acceso ops de este nodo.",
    ""
  ];
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
    hasCredential: record.status === "configured",
    hasSshAccess: Boolean(record.sshAccess),
    sshUser: record.sshAccess?.user ?? null
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
  await upsertCredentialInventoryRecord<SmtpCredentialsInventory>(
    workspace,
    durableCredentialsInventory,
    record
  );
  await mirrorSmtpCredentialRecordToDomains(workspace, record);
}

async function mirrorSmtpCredentialRecordToDomains(
  workspace: OpenClawWorkspace,
  record: SmtpCredentialRecord
): Promise<void> {
  try {
    await upsertCredentialInventoryRecord<DomainsInventory>(
      workspace,
      legacyDomainsInventory,
      record
    );
  } catch (error) {
    console.warn(
      `SMTP credential stored in ${durableCredentialsInventory}; ${legacyDomainsInventory} mirror skipped: ${safeErrorName(error)}`
    );
  }
}

async function upsertCredentialInventoryRecord<T extends { smtpCredentials?: SmtpCredentialRecord[] }>(
  workspace: OpenClawWorkspace,
  inventoryName: string,
  record: SmtpCredentialRecord
): Promise<void> {
  await workspace.updateInventoryJson<T>(inventoryName, (current) => {
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
    } as T;
  });
}

async function readSmtpCredentialRecords(workspace: OpenClawWorkspace): Promise<SmtpCredentialRecord[]> {
  const [legacy, durable] = await Promise.all([
    workspace.readInventoryJson<DomainsInventory>(legacyDomainsInventory).catch(() => null),
    workspace.readInventoryJson<SmtpCredentialsInventory>(durableCredentialsInventory).catch(() => null)
  ]);
  const recordsByKey = new Map<string, SmtpCredentialRecord>();
  for (const record of [
    ...(legacy?.smtpCredentials ?? []),
    ...(durable?.smtpCredentials ?? [])
  ]) {
    if (!isSmtpCredentialRecord(record)) continue;
    recordsByKey.set(smtpCredentialRecordKey(record), record);
  }
  return [...recordsByKey.values()];
}

function smtpCredentialRecordKey(record: SmtpCredentialRecord): string {
  return `${record.domain}\0${record.serverSlug ?? ""}`;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
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

export function encryptSecret(
  plaintext: string,
  key: Buffer,
  aad: Record<string, string>
): SmtpCredentialEncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aad)));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    algorithm,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url")
  };
}

export function decryptSecret(
  payload: SmtpCredentialEncryptedPayload,
  key: Buffer,
  aad: Record<string, string>
): string {
  if (payload.algorithm !== algorithm) {
    throw new SmtpCredentialError("smtp_credential_unsupported_algorithm");
  }
  const decipher = createDecipheriv(algorithm, key, Buffer.from(payload.iv, "base64url"));
  decipher.setAAD(Buffer.from(JSON.stringify(aad)));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function sshPrivateKeyAad(domain: string, user: string): Record<string, string> {
  return { domain, user, kind: "ssh_private_key" };
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

export function credentialEncryptionKey(env: Record<string, string | undefined> | undefined): Buffer {
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

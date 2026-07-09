// Adapters REALES de correo (Fase 1b / §8-§9) — SMTP con nodemailer, IMAP con imapflow.
// Implementan las interfaces INYECTABLES ya definidas en el resto del engine:
//   - SmtpAuthProbe / ImapAuthProbe (checks/liveness-checks.ts) → probes de auth (pass/fail/throw).
//   - ImapClient (reader/imap-placement-reader.ts) → búsqueda por cabecera para el placement reader.
//   - SmtpClient (runtime/transport.ts) → cliente de envío que consume PostfixTransport.
//
// Este archivo es el ÚNICO que acopla nodemailer/imapflow; el resto del engine sigue PURO respecto a
// la red. El ensamblador (index/composición) los enchufa detrás del feature flag (WARMUP_ENGINE_ENABLE).
//
// Reglas duras que materializa (idénticas al §seguridad y a liveness-checks.ts):
//   - CREDENCIALES POR REFERENCIA: los probes/clients reciben un `secretRef` OPACO ("vault://...").
//     JAMÁS el password/token. El `SecretResolver` inyectado canjea la referencia contra el secret
//     store JUSTO antes de conectar; el resultado NUNCA se loguea ni se filtra a `detail`.
//   - Semántica de probe (§8): ok:true ⇒ auth aceptada; ok:false ⇒ auth rechazada (credencial mala);
//     THROW ⇒ error de red/conexión/TLS ⇒ el checker aguas arriba lo trata como `unknown` (fail-closed).
//   - Node 22 strip-types: sin parameter properties, sin enums, sin clases; factories que devuelven
//     object literals. La dependencia de red (createTransport / ImapFlow) entra por DI para que los
//     tests corran SIN abrir un solo socket.

import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";

import type {
  AuthProbeOptions,
  AuthProbeResult,
  ImapAuthProbe,
  SmtpAuthProbe
} from "../checks/liveness-checks.ts";
import type {
  ImapClient,
  ImapMessage,
  ImapSearchOptions
} from "../reader/imap-placement-reader.ts";
import type { SmtpClient, SmtpSendInfo } from "../runtime/transport.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Credenciales por REFERENCIA — el resolver inyectado canjea el secretRef opaco.
// ─────────────────────────────────────────────────────────────────────────────

/** Credencial resuelta con password (SMTP/IMAP AUTH LOGIN/PLAIN). */
export interface ResolvedPasswordSecret {
  user?: string;
  pass: string;
}

/** Credencial resuelta con access token (XOAUTH2 / OAuth2). */
export interface ResolvedTokenSecret {
  user?: string;
  accessToken: string;
}

/** El valor crudo de una credencial. NUNCA se loguea ni se mete en `detail`. */
export type ResolvedSecret = ResolvedPasswordSecret | ResolvedTokenSecret;

/**
 * Resuelve un `secretRef` opaco ("vault://...") contra el secret store. Lo inyecta el ensamblador; los
 * tests usan un fake. El adapter lo llama justo antes de conectar y descarta el valor apenas conecta.
 */
export interface SecretResolver {
  resolve(secretRef: string): Promise<ResolvedSecret>;
}

function isTokenSecret(secret: ResolvedSecret): secret is ResolvedTokenSecret {
  return typeof (secret as ResolvedTokenSecret).accessToken === "string";
}

// ─────────────────────────────────────────────────────────────────────────────
// Costuras de red inyectables (DI) — default = paquete real, override = fake en tests.
// ─────────────────────────────────────────────────────────────────────────────

/** Subconjunto del transporter de nodemailer que usamos (verify para probe, sendMail para envío). */
export interface NodemailerTransportLike {
  verify(): Promise<boolean>;
  sendMail(mail: unknown): Promise<SmtpSendInfo>;
}

/** Fábrica de transporter compatible con `nodemailer.createTransport`. */
export type CreateTransportFn = (config: unknown) => NodemailerTransportLike;

/** DI del probe/client SMTP: inyecta el createTransport (default = nodemailer). */
export interface SmtpDeps {
  createTransport?: CreateTransportFn;
}

/** Bandeja devuelta por `getMailboxLock`: hay que liberarla siempre (finally). */
export interface MailboxLockLike {
  release(): void;
}

/** Un mensaje tal cual lo devuelve `fetchAll` de imapflow (subconjunto usado). */
export interface ImapFetchLike {
  /** Bloque de cabeceras crudo (Buffer con headers:true). */
  headers?: Buffer | string;
  /** Labels de Gmail (Set) si se pidió labels:true y el server soporta X-GM-EXT-1. */
  labels?: Set<string> | string[];
}

/** Subconjunto de la instancia ImapFlow que usan estos adapters. */
export interface ImapFlowLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  capabilities?: { has(cap: string): boolean };
  list(): Promise<Array<{ path: string }>>;
  getMailboxLock(path: string): Promise<MailboxLockLike>;
  search(query: unknown, options?: unknown): Promise<number[] | false>;
  fetchAll(range: unknown, query: unknown, options?: unknown): Promise<ImapFetchLike[]>;
}

/** Constructor de ImapFlow (compatible con `new ImapFlow(config)`). */
export type ImapFlowCtor = new (config: unknown) => ImapFlowLike;

/** DI del probe/client IMAP: inyecta el constructor de ImapFlow (default = imapflow). */
export interface ImapDeps {
  ImapFlow?: ImapFlowCtor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constantes de red / clasificación (§8-§9).
// ─────────────────────────────────────────────────────────────────────────────

const SMTP_SUBMISSION_PORT = 587; // STARTTLS + AUTH.
const SMTPS_PORT = 465; // TLS implícito.
const IMAPS_PORT = 993; // IMAP sobre TLS.

/** Extensión de Gmail: habilita X-GM-RAW / X-GM-LABELS. */
const GMAIL_CAPABILITY = "X-GM-EXT-1";

/** Carpetas relevantes por defecto para el reader (INBOX + spam-like) cuando no se pasan explícitas. */
const RELEVANT_FOLDER_MARKERS: readonly string[] = ["spam", "junk", "bulk"];
/** En Gmail, "All Mail" contiene todo lo etiquetado; se combina con Spam (fuera de All Mail). */
const GMAIL_ALL_MAIL_MARKERS: readonly string[] = ["all mail", "todos", "all"];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de scrubbing — defensa en profundidad para que el secreto JAMÁS aparezca.
// ─────────────────────────────────────────────────────────────────────────────

/** Extrae los valores crudos (pass / accessToken) de una credencial para poder scrubbearlos. */
function secretValues(secret: ResolvedSecret): string[] {
  const out: string[] = [];
  if (isTokenSecret(secret)) {
    if (secret.accessToken) out.push(secret.accessToken);
  } else if (secret.pass) {
    out.push(secret.pass);
  }
  return out;
}

/** Elimina cualquier aparición de los secretos del texto (por si el server los eco-devuelve). */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("[redacted]");
  }
  return out;
}

/** Mensaje de error corto (sin secretos tras scrub). */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// Construcción de config / auth (compartida entre probe y client).
// ─────────────────────────────────────────────────────────────────────────────

/** Construye el bloque `auth` de nodemailer/imapflow desde la credencial resuelta. */
function buildAuth(defaultUser: string, secret: ResolvedSecret): Record<string, unknown> {
  const user = secret.user ?? defaultUser;
  if (isTokenSecret(secret)) {
    return { type: "OAuth2", user, accessToken: secret.accessToken };
  }
  return { user, pass: secret.pass };
}

/** Config SMTP: 465 ⇒ TLS implícito; cualquier otro (587) ⇒ STARTTLS obligatorio. */
function buildSmtpConfig(
  host: string,
  port: number,
  defaultUser: string,
  secret: ResolvedSecret
): Record<string, unknown> {
  const secure = port === SMTPS_PORT;
  return {
    host,
    port,
    secure,
    requireTLS: !secure,
    auth: buildAuth(defaultUser, secret),
    logger: false
  };
}

/** Config IMAP: TLS implícito (993) por defecto. `logger:false` ⇒ nada a stdout. */
function buildImapConfig(
  host: string,
  port: number,
  secure: boolean,
  defaultUser: string,
  secret: ResolvedSecret
): Record<string, unknown> {
  return {
    host,
    port,
    secure,
    auth: buildAuth(defaultUser, secret),
    logger: false
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Detección de errores de AUTH vs errores de RED (frontera pass|fail ↔ throw).
// ─────────────────────────────────────────────────────────────────────────────

/** Códigos de respuesta SMTP que significan "auth rechazada" (credencial mala), no error de red. */
const SMTP_AUTH_RESPONSE_CODES: ReadonlySet<number> = new Set<number>([454, 530, 534, 535]);

/**
 * true si el error de nodemailer es una AUTH rechazada (⇒ ok:false), no un fallo de conexión/red.
 * nodemailer marca `code:'EAUTH'` en el fallo de autenticación; el resto (ECONNECTION/ETIMEDOUT/
 * ESOCKET/ EDNS…) es red ⇒ debe propagar (throw) para que el checker lo cuente como `unknown`.
 */
function isSmtpAuthError(err: unknown): boolean {
  const e = err as { code?: unknown; responseCode?: unknown };
  if (e?.code === "EAUTH") return true;
  if (typeof e?.responseCode === "number" && SMTP_AUTH_RESPONSE_CODES.has(e.responseCode)) return true;
  return false;
}

/**
 * true si el error de imapflow es una AUTH rechazada. imapflow lanza `AuthenticationFailure` con
 * `authenticationFailed === true`; algunos servidores devuelven `serverResponseCode:'AUTHENTICATIONFAILED'`.
 */
function isImapAuthError(err: unknown): boolean {
  const e = err as { authenticationFailed?: unknown; serverResponseCode?: unknown };
  if (e?.authenticationFailed === true) return true;
  if (e?.serverResponseCode === "AUTHENTICATIONFAILED") return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe SMTP (SmtpAuthProbe) — verify() sobre 587 STARTTLS.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SmtpAuthProbe real con nodemailer: resuelve el secret por referencia, hace `transporter.verify()`
 * (STARTTLS 587 + AUTH). verify OK ⇒ ok:true; EAUTH/5xx-auth ⇒ ok:false (detail SIN secreto);
 * error de red ⇒ THROW (⇒ el checker lo trata como unknown). `createTransport` inyectable (DI).
 */
export function createNodemailerSmtpAuthProbe(
  secretResolver: SecretResolver,
  deps: SmtpDeps = {}
): SmtpAuthProbe {
  const createTransport: CreateTransportFn = deps.createTransport ?? nodemailer.createTransport;
  return {
    async probe(opts: AuthProbeOptions): Promise<AuthProbeResult> {
      const secret = await secretResolver.resolve(opts.secretRef);
      const secrets = secretValues(secret);
      const transporter = createTransport(
        buildSmtpConfig(opts.host, opts.port || SMTP_SUBMISSION_PORT, opts.user, secret)
      );
      try {
        await transporter.verify();
      } catch (err) {
        if (isSmtpAuthError(err)) {
          // Auth rechazada ⇒ fail. El detail se scrubbea por si el server eco-devolvió el secreto.
          return { ok: false, detail: scrub(`smtp auth rechazada: ${errText(err)}`, secrets) };
        }
        // Red/conexión/TLS ⇒ propagar (fail-closed aguas arriba lo vuelve `unknown`).
        throw err;
      }
      return { ok: true, detail: `smtp auth aceptada en ${opts.host}:${opts.port || SMTP_SUBMISSION_PORT}` };
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe IMAP (ImapAuthProbe) — connect+login (993 TLS) y logout.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ImapAuthProbe real con imapflow: connect+login sobre IMAPS 993, luego logout. connect OK ⇒ ok:true;
 * AuthenticationFailure ⇒ ok:false (detail SIN secreto); error de red ⇒ THROW. Constructor ImapFlow
 * inyectable (DI).
 */
export function createImapflowAuthProbe(
  secretResolver: SecretResolver,
  deps: ImapDeps = {}
): ImapAuthProbe {
  const Ctor: ImapFlowCtor = deps.ImapFlow ?? (ImapFlow as unknown as ImapFlowCtor);
  return {
    async probe(opts: AuthProbeOptions): Promise<AuthProbeResult> {
      const secret = await secretResolver.resolve(opts.secretRef);
      const secrets = secretValues(secret);
      const client = new Ctor(
        buildImapConfig(opts.host, opts.port || IMAPS_PORT, true, opts.user, secret)
      );
      let connected = false;
      try {
        await client.connect();
        connected = true;
      } catch (err) {
        if (isImapAuthError(err)) {
          return { ok: false, detail: scrub(`imap auth rechazada: ${errText(err)}`, secrets) };
        }
        throw err;
      } finally {
        if (connected) {
          try {
            await client.logout();
          } catch {
            // logout best-effort: un fallo al cerrar no cambia el veredicto de auth.
          }
        }
      }
      return { ok: true, detail: `imap auth aceptada en ${opts.host}:${opts.port || IMAPS_PORT}` };
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cliente IMAP para el placement reader (ImapClient) — búsqueda por cabecera.
// ─────────────────────────────────────────────────────────────────────────────

/** Opciones de conexión/búsqueda del cliente IMAP del reader. */
export interface ImapflowClientOptions {
  host: string;
  port?: number;
  /** Usuario del seed inbox (fallback si el secret no trae user). NO es secreto. */
  user: string;
  /** Referencia opaca a la credencial. NUNCA el valor crudo. */
  secretRef: string;
  secure?: boolean;
  /** Carpetas a recorrer. Si se omite, se derivan de `list()` (INBOX + spam-like [+ All Mail en Gmail]). */
  folders?: string[];
}

/** Parsea un bloque de cabeceras crudo (RFC 5322, con folding) a Record<name,value>. */
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const unfolded: string[] = [];
  for (const line of lines) {
    if (line === "") continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[name] = value;
  }
  return out;
}

function bufToString(v: Buffer | string | undefined): string {
  if (v === undefined) return "";
  return typeof v === "string" ? v : v.toString("utf8");
}

function hasGmail(client: ImapFlowLike): boolean {
  return client.capabilities?.has(GMAIL_CAPABILITY) === true;
}

function isRelevantFolder(path: string, gmail: boolean): boolean {
  const p = path.toLowerCase();
  if (p === "inbox") return true;
  if (RELEVANT_FOLDER_MARKERS.some((m) => p.includes(m))) return true;
  if (gmail && GMAIL_ALL_MAIL_MARKERS.some((m) => p.includes(m))) return true;
  return false;
}

async function resolveFolders(
  client: ImapFlowLike,
  opts: ImapflowClientOptions,
  gmail: boolean
): Promise<string[]> {
  // Carpetas explícitas ⇒ se confía en el caller (evita depender de list()).
  if (opts.folders && opts.folders.length > 0) return opts.folders;
  let boxes: Array<{ path: string }> = [];
  try {
    boxes = await client.list();
  } catch {
    boxes = [];
  }
  const relevant = boxes.map((b) => b.path).filter((p) => isRelevantFolder(p, gmail));
  return relevant.length > 0 ? relevant : ["INBOX"];
}

/** Mapea un resultado de fetch a ImapMessage; en Gmail marca gmailRaw y extrae X-GM-LABELS. */
function toImapMessage(folder: string, fetched: ImapFetchLike, gmail: boolean): ImapMessage {
  const headers = parseHeaders(bufToString(fetched.headers));
  if (gmail) {
    const labels = fetched.labels
      ? Array.isArray(fetched.labels)
        ? [...fetched.labels]
        : [...fetched.labels.values()]
      : [];
    return { folder, headers, gmailRaw: true, gmailLabels: labels };
  }
  return { folder, headers };
}

/**
 * ImapClient real (imapflow) para el placement reader (§9): connect+login, recorre las carpetas
 * relevantes buscando por cabecera (`search({header:{[name]:value}})`), y mapea cada mensaje a
 * ImapMessage. En Gmail (CAPABILITY X-GM-EXT-1) pide labels:true (X-GM-LABELS) y marca gmailRaw ⇒ el
 * reader clasifica por labels; el resto se clasifica por carpeta. Constructor ImapFlow inyectable (DI).
 *
 * La credencial va por REFERENCIA: se resuelve por cada `search`, justo antes de connect, y nunca se
 * loguea. NO abre sockets en tests: los fakes implementan connect/list/search/fetchAll/logout.
 */
export function createImapflowClient(
  secretResolver: SecretResolver,
  opts: ImapflowClientOptions,
  deps: ImapDeps = {}
): ImapClient {
  const Ctor: ImapFlowCtor = deps.ImapFlow ?? (ImapFlow as unknown as ImapFlowCtor);
  return {
    async search(searchOpts: ImapSearchOptions): Promise<ImapMessage[]> {
      const secret = await secretResolver.resolve(opts.secretRef);
      const client = new Ctor(
        buildImapConfig(
          opts.host,
          opts.port || IMAPS_PORT,
          opts.secure ?? true,
          opts.user,
          secret
        )
      );
      const results: ImapMessage[] = [];
      await client.connect();
      try {
        const gmail = hasGmail(client);
        const folders = await resolveFolders(client, opts, gmail);
        const query = { header: { [searchOpts.headerName]: searchOpts.headerValue } };
        for (const folder of folders) {
          const lock = await client.getMailboxLock(folder);
          try {
            const uids = await client.search(query, { uid: true });
            if (!uids || uids.length === 0) continue;
            const fetched = await client.fetchAll(
              uids,
              { headers: true, labels: gmail },
              { uid: true }
            );
            for (const f of fetched) {
              results.push(toImapMessage(folder, f, gmail));
            }
          } finally {
            lock.release();
          }
        }
      } finally {
        try {
          await client.logout();
        } catch {
          // best-effort.
        }
      }
      return results;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cliente SMTP de envío (SmtpClient) — consumido por PostfixTransport.
// ─────────────────────────────────────────────────────────────────────────────

/** Opciones de conexión del cliente SMTP de envío. */
export interface SmtpClientOptions {
  host: string;
  port?: number;
  /** Usuario de submission (fallback si el secret no trae user). NO es secreto. */
  user: string;
  /** Referencia opaca a la credencial. NUNCA el valor crudo. */
  secretRef: string;
}

/**
 * SmtpClient real (nodemailer) compatible con la firma `sendMail` que consume PostfixTransport.
 * Resuelve el secret por referencia y crea el transporter de forma perezosa (una sola vez), luego
 * delega cada `sendMail`. `createTransport` inyectable (DI) ⇒ tests sin red.
 */
export function createNodemailerSmtpClient(
  secretResolver: SecretResolver,
  opts: SmtpClientOptions,
  deps: SmtpDeps = {}
): SmtpClient {
  const createTransport: CreateTransportFn = deps.createTransport ?? nodemailer.createTransport;
  let transporterPromise: Promise<NodemailerTransportLike> | null = null;

  function getTransporter(): Promise<NodemailerTransportLike> {
    if (transporterPromise === null) {
      transporterPromise = (async () => {
        const secret = await secretResolver.resolve(opts.secretRef);
        return createTransport(
          buildSmtpConfig(opts.host, opts.port || SMTP_SUBMISSION_PORT, opts.user, secret)
        );
      })();
    }
    return transporterPromise;
  }

  return {
    async sendMail(mail): Promise<SmtpSendInfo> {
      const transporter = await getTransporter();
      return transporter.sendMail(mail);
    }
  };
}

// Inbox Reader de placement (§9 "Clasificación IMAP") — PURO respecto a I/O.
// Lee los SEED INBOXES externos (Gmail/Outlook/Yahoo/…) a través de un cliente IMAP INYECTABLE y
// clasifica dónde cayó cada seed marcado, produciendo el PlacementResultRow[] que consume el rollup
// de placement (domain/placement.ts, NO se toca). Este módulo NO abre sockets: el cliente real usará
// imapflow (X-GM-RAW/X-GM-LABELS para Gmail, carpetas estándar para el resto); aquí solo se define la
// interface + la clasificación y los tests la mockean.
//
// Reglas duras del §9 que materializa este lector:
//  - Detección del seed por el header oculto `X-Delivrix-Test-Id` (== PlacementTest.testId), con el
//    token en el body como fallback (lo resuelve el cliente real vía search; aquí se acepta la fila
//    que la búsqueda devolvió).
//  - Gmail: labels/raw ⇒ Primary vs pestañas (Promotions/Social/Updates/Forums) vs Spam. Las
//    PESTAÑAS cuentan como `tabs` (aguas arriba es inbox); Primary ⇒ `primary`; Spam/Junk ⇒ `spam`.
//  - Resto: carpeta estándar ⇒ INBOX = `primary`; Junk/Bulk/Spam = `spam`; "otros"/tabs = `tabs`.
//  - No encontrado tras CERRAR el grace window ⇒ `missing` (bucket propio, MISSING ≠ SPAM).
//  - No encontrado DENTRO del grace window ⇒ `null` (pendiente, se reintenta).
//  - Fallo del cliente ⇒ `null` (pendiente); NUNCA inventa un resultado ni lanza.

import type { LandedIn, PlacementResultRow, PlacementTest } from "../domain/types.ts";

// ── Cliente IMAP inyectable (los tests lo mockean; el real usa imapflow) ─────────────────────────

/** Un mensaje ya materializado por el cliente IMAP. Sin body: el token va contra la búsqueda. */
export interface ImapMessage {
  /** Carpeta donde se encontró el mensaje (p.ej. "INBOX", "Junk", "[Gmail]/Spam"). */
  folder: string;
  /** Labels de Gmail (X-GM-LABELS) si el buzón es Gmail/Workspace; ausente en el resto. */
  gmailLabels?: string[];
  /** true si la fila proviene de una búsqueda Gmail (X-GM-RAW): clasificar por labels. */
  gmailRaw?: boolean;
  /** Cabeceras del mensaje (case-insensitive por nombre). Incluye X-Delivrix-Test-Id. */
  headers: Record<string, string>;
}

/** Opciones de búsqueda por cabecera (el cliente real las traduce a HEADER/X-GM-RAW). */
export interface ImapSearchOptions {
  headerName: string;
  headerValue: string;
}

/** Contrato mínimo del cliente IMAP: buscar por cabecera. Inyectable ⇒ tests sin red. */
export interface ImapClient {
  search(opts: ImapSearchOptions): Promise<ImapMessage[]>;
}

// ── Constantes de detección y clasificación (§9) ─────────────────────────────────────────────────

/** Cabecera oculta que marca un seed de placement (== PlacementTest.testId). */
export const TEST_ID_HEADER = "X-Delivrix-Test-Id";

/** Labels/carpetas de Gmail que significan spam. */
const GMAIL_SPAM_LABELS: ReadonlySet<string> = new Set<string>(["spam", "junk"]);

/** Categorías de pestaña de Gmail: cuentan como `tabs` (§9). */
const GMAIL_TAB_CATEGORIES: ReadonlySet<string> = new Set<string>([
  "promotions",
  "social",
  "updates",
  "forums"
]);

/** Substrings que marcan una carpeta como spam/junk/bulk en proveedores no-Gmail. */
const SPAM_FOLDER_MARKERS: readonly string[] = ["spam", "junk", "bulk"];

// ── Grace window (§9): poll t+2m/10m/30m/2h, finaliza t+6h ────────────────────────────────────────

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Offsets de sondeo desde `sentAt` (§9): t+2m, t+10m, t+30m, t+2h. */
export const POLL_SCHEDULE_MS: readonly number[] = [2 * MINUTE_MS, 10 * MINUTE_MS, 30 * MINUTE_MS, 2 * HOUR_MS];

/** El grace window finaliza a t+6h (§9). A partir de ahí, no-encontrado ⇒ `missing`. */
export const GRACE_WINDOW_MS = 6 * HOUR_MS;

function ageMs(sentAt: Date, now: Date): number {
  return now.getTime() - sentAt.getTime();
}

/** true si el grace window ya cerró (edad ≥ 6h): no-encontrado pasa a ser definitivo (`missing`). */
export function isGraceWindowClosed(sentAt: Date, now: Date): boolean {
  return ageMs(sentAt, now) >= GRACE_WINDOW_MS;
}

/** true mientras el grace window siga abierto (edad < 6h): merece seguir sondeando. */
export function shouldKeepPolling(sentAt: Date, now: Date): boolean {
  return !isGraceWindowClosed(sentAt, now);
}

/**
 * Próximo instante de sondeo según la agenda del §9, o `null` si el grace window ya cerró.
 * Devuelve el primer offset programado estrictamente posterior a `now`; si `now` ya pasó el último
 * offset (t+2h) pero el window sigue abierto, sondea al cierre (t+6h).
 */
export function nextPollAt(sentAt: Date, now: Date): Date | null {
  if (isGraceWindowClosed(sentAt, now)) return null;
  const age = ageMs(sentAt, now);
  for (const offset of POLL_SCHEDULE_MS) {
    if (offset > age) return new Date(sentAt.getTime() + offset);
  }
  return new Date(sentAt.getTime() + GRACE_WINDOW_MS);
}

// ── Clasificación → LandedIn (§9) ─────────────────────────────────────────────────────────────────

/** Normaliza un label de Gmail: minúsculas, sin `\` inicial ni prefijo `category_`, solo alfanum. */
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/^\\+/, "")
    .replace(/^category_/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Normaliza el nombre de carpeta: minúsculas y sin espacios/relleno. */
function normalizeFolder(folder: string): string {
  return folder.toLowerCase().trim();
}

function isSpamFolder(folderNorm: string): boolean {
  return SPAM_FOLDER_MARKERS.some((m) => folderNorm.includes(m));
}

/** Clasifica un mensaje Gmail por sus labels: Spam ⇒ spam, categoría de pestaña ⇒ tabs, resto ⇒ primary. */
function classifyGmailLabels(labels: readonly string[]): LandedIn {
  const norm = labels.map(normalizeLabel);
  if (norm.some((l) => GMAIL_SPAM_LABELS.has(l))) return "spam";
  if (norm.some((l) => GMAIL_TAB_CATEGORIES.has(l))) return "tabs";
  // \\Inbox / CATEGORY_PERSONAL / \\Important… ⇒ Primary.
  return "primary";
}

/** Clasifica por carpeta estándar (no-Gmail o Gmail sin labels): spam ⇒ spam, INBOX ⇒ primary, otros ⇒ tabs. */
function classifyByFolder(folder: string): LandedIn {
  const f = normalizeFolder(folder);
  if (isSpamFolder(f)) return "spam";
  if (f === "inbox") return "primary";
  // Cualquier otra carpeta ("otros"/pestaña del proveedor) ⇒ tabs (§9: tabs = inbox aguas arriba).
  return "tabs";
}

function isGmailMessage(msg: ImapMessage): boolean {
  return msg.gmailRaw === true || msg.gmailLabels !== undefined;
}

/**
 * Helper PURO testeable: dónde cayó un mensaje ya localizado (§9). Nunca devuelve `missing` — eso lo
 * decide `readPlacement` cuando el seed NO aparece y el grace window cerró.
 */
export function classifyLanded(msg: ImapMessage): LandedIn {
  // Gmail con labels ⇒ clasificar por labels (X-GM-LABELS). Sin labels útiles ⇒ caer a carpeta.
  if (isGmailMessage(msg) && msg.gmailLabels !== undefined && msg.gmailLabels.length > 0) {
    return classifyGmailLabels(msg.gmailLabels);
  }
  return classifyByFolder(msg.folder);
}

// ── Lectura principal ──────────────────────────────────────────────────────────────────────────────

/** Lookup case-insensitive de una cabecera. */
function getHeader(msg: ImapMessage, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(msg.headers)) {
    if (key.toLowerCase() === target) return msg.headers[key];
  }
  return undefined;
}

/** Un mensaje pertenece a este test si su header X-Delivrix-Test-Id coincide con el testId. */
function matchesTest(msg: ImapMessage, test: PlacementTest): boolean {
  return getHeader(msg, TEST_ID_HEADER) === test.testId;
}

function pending(test: PlacementTest): PlacementResultRow {
  return {
    testId: test.testId,
    nodeId: test.nodeId,
    seedProvider: test.seedProvider,
    landedIn: null
  };
}

function resolved(test: PlacementTest, landedIn: LandedIn, readAt: Date): PlacementResultRow {
  return {
    testId: test.testId,
    nodeId: test.nodeId,
    seedProvider: test.seedProvider,
    landedIn,
    readAt
  };
}

/**
 * Lee el placement de un seed (§9): busca por el header oculto, clasifica dónde cayó, y decide missing
 * vs pendiente según el grace window.
 *
 *  - Encontrado           ⇒ landedIn = classifyLanded(msg), readAt = now.
 *  - No encontrado + window CERRADO (≥6h) ⇒ landedIn = "missing", readAt = now (definitivo, ≠ spam).
 *  - No encontrado + window ABIERTO       ⇒ landedIn = null (pendiente, se reintenta).
 *  - El cliente IMAP falla                ⇒ landedIn = null (pendiente); NUNCA lanza ni inventa.
 */
export async function readPlacement(
  client: ImapClient,
  test: PlacementTest,
  now: Date
): Promise<PlacementResultRow> {
  let messages: ImapMessage[];
  try {
    messages = await client.search({ headerName: TEST_ID_HEADER, headerValue: test.testId });
  } catch {
    // Fallo de red/cliente ⇒ pendiente (se reintenta). No inventamos un resultado.
    return pending(test);
  }

  // Preferimos la coincidencia exacta por cabecera; si ninguna la trae pero la búsqueda devolvió algo
  // (match por token de body), aceptamos esa fila como fallback.
  const msg = messages.find((m) => matchesTest(m, test)) ?? messages[0];
  if (msg !== undefined) {
    return resolved(test, classifyLanded(msg), now);
  }

  // No apareció en ninguna carpeta.
  if (isGraceWindowClosed(test.sentAt, now)) {
    return resolved(test, "missing", now);
  }
  return pending(test);
}

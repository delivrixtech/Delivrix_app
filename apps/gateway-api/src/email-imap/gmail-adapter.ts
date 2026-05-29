/**
 * Gmail IMAP Adapter — usa imapflow v1.x para clasificar los emails
 * recientes de Gmail por carpeta (INBOX / Spam / Promotions / Other).
 *
 * Estrategia (validada en plan Hito 5.12 sub-agente D):
 *  - una sola conexión por consulta (no 3)
 *  - abrir `[Gmail]/All Mail` en readOnly
 *  - search por gmraw (subject:"..." newer_than:<minutes>m)
 *  - fetch labels (X-GM-LABELS) + envelope + internalDate por uid
 *  - clasificar por labels: \\Junk/\\Spam -> spam, CATEGORY_PROMOTIONS ->
 *    promotions, \\Inbox -> inbox, resto -> other
 *  - cap a 50 samples; siempre logout en finally; el password nunca se loggea.
 */

import { ImapFlow, type FetchMessageObject, type FetchQueryObject } from "imapflow";

export type PlacementMatchBy = "subject" | "from" | "messageId";
export type PlacementFolder = "inbox" | "spam" | "promotions" | "other";

export interface GmailImapAdapterConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Inyectable para tests; en runtime usa la fábrica default. */
  imapFactory?: ImapFlowFactory;
  /** Reloj inyectable para tests. */
  now?: () => Date;
  /** Cap de muestras devueltas. Default 50. */
  sampleCap?: number;
  /** Mailbox de Gmail con todos los mensajes. Override para tests. */
  allMailMailbox?: string;
}

export interface ClassifySample {
  uid: number;
  subject: string;
  from: string;
  messageId: string | null;
  receivedAt: string;
  folder: PlacementFolder;
  labels: string[];
}

export interface ClassifyResult {
  matched: number;
  inbox: number;
  spam: number;
  promotions: number;
  other: number;
  /** matched > 0 ? inbox/matched : 0 (rango 0..1, redondeado a 4 decimales). */
  placementRate: number;
  samples: ClassifySample[];
  /** Tiempo total de la operación IMAP en ms. */
  elapsedMs: number;
}

/* ============================================================
 * Errors
 * ============================================================ */

export type GmailImapAdapterErrorCode =
  | "imap_connect_failed"
  | "imap_disabled"
  | "imap_auth_failed"
  | "imap_search_failed"
  | "imap_mailbox_unavailable"
  | "imap_internal_error";

export class GmailImapAdapterError extends Error {
  readonly code: GmailImapAdapterErrorCode;
  readonly cause: unknown;

  constructor(code: GmailImapAdapterErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "GmailImapAdapterError";
    this.code = code;
    this.cause = cause;
  }
}

/* ============================================================
 * Test seam — abstrae el constructor de ImapFlow
 * ============================================================ */

/** Subset mínimo de la API de ImapFlow que usamos — permite mockear en tests. */
export interface ImapFlowClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(
    mailbox: string,
    options?: { readOnly?: boolean }
  ): Promise<ImapFlowMailboxLock>;
  search(
    criteria: Record<string, unknown>,
    options?: { uid?: boolean }
  ): Promise<number[] | false>;
  fetchOne(
    seq: string | number,
    query: FetchQueryObject,
    options?: { uid?: boolean }
  ): Promise<FetchMessageObject | undefined>;
}

export interface ImapFlowMailboxLock {
  release(): void;
}

export type ImapFlowFactory = (config: {
  host: string;
  port: number;
  user: string;
  pass: string;
}) => ImapFlowClient;

const defaultImapFactory: ImapFlowFactory = (config) =>
  new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    emitLogs: false
  }) as unknown as ImapFlowClient;

/* ============================================================
 * Adapter
 * ============================================================ */

const DEFAULT_ALL_MAIL = "[Gmail]/All Mail";

export class GmailImapAdapter {
  private readonly host: string;
  private readonly port: number;
  private readonly user: string;
  private readonly pass: string;
  private readonly factory: ImapFlowFactory;
  private readonly now: () => Date;
  private readonly sampleCap: number;
  private readonly allMailMailbox: string;

  constructor(config: GmailImapAdapterConfig) {
    this.host = config.host;
    this.port = config.port;
    this.user = config.user;
    this.pass = config.pass;
    this.factory = config.imapFactory ?? defaultImapFactory;
    this.now = config.now ?? (() => new Date());
    this.sampleCap = config.sampleCap ?? 50;
    this.allMailMailbox = config.allMailMailbox ?? DEFAULT_ALL_MAIL;
  }

  isConfigured(): boolean {
    return Boolean(this.host && this.port > 0 && this.user && this.pass);
  }

  async classify(
    matcher: string,
    windowMinutes: number,
    matchBy: PlacementMatchBy
  ): Promise<ClassifyResult> {
    if (!this.isConfigured()) {
      throw new GmailImapAdapterError("imap_disabled", "Gmail IMAP adapter is not fully configured.");
    }
    if (!matcher || matcher.trim().length === 0) {
      throw new GmailImapAdapterError("imap_internal_error", "matcher cannot be empty.");
    }
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      throw new GmailImapAdapterError("imap_internal_error", "windowMinutes must be > 0.");
    }

    const startedAt = Date.now();
    let client: ImapFlowClient;
    try {
      client = this.factory({
        host: this.host,
        port: this.port,
        user: this.user,
        pass: this.pass
      });
    } catch (error) {
      throw new GmailImapAdapterError(
        "imap_internal_error",
        "Could not instantiate IMAP client.",
        error
      );
    }

    try {
      await client.connect();
    } catch (error) {
      throw new GmailImapAdapterError(
        classifyConnectError(error),
        "Could not connect to Gmail IMAP.",
        error
      );
    }

    let lock: ImapFlowMailboxLock | null = null;
    try {
      try {
        lock = await client.getMailboxLock(this.allMailMailbox, { readOnly: true });
      } catch (error) {
        throw new GmailImapAdapterError(
          "imap_mailbox_unavailable",
          `Could not open mailbox ${this.allMailMailbox}.`,
          error
        );
      }

      const since = new Date(this.now().getTime() - windowMinutes * 60_000);
      const gmraw = buildGmraw(matchBy, matcher, since, windowMinutes);

      let uids: number[];
      try {
        const result = await client.search({ gmraw }, { uid: true });
        uids = Array.isArray(result) ? result : [];
      } catch (error) {
        throw new GmailImapAdapterError(
          "imap_search_failed",
          "Gmail IMAP search failed.",
          error
        );
      }

      // Tomamos los más recientes — uids ascendentes en Gmail
      const sortedDescending = [...uids].sort((a, b) => b - a);
      const limited = sortedDescending.slice(0, this.sampleCap);

      const samples: ClassifySample[] = [];
      let inbox = 0;
      let spam = 0;
      let promotions = 0;
      let other = 0;

      for (const uid of limited) {
        let message: FetchMessageObject | undefined;
        try {
          message = await client.fetchOne(
            uid,
            { envelope: true, labels: true, internalDate: true },
            { uid: true }
          );
        } catch (error) {
          throw new GmailImapAdapterError(
            "imap_search_failed",
            `Gmail IMAP fetch failed for uid ${uid}.`,
            error
          );
        }
        if (!message) continue;

        const labels = normalizeLabels(message.labels);
        const folder = classifyByLabels(labels);

        switch (folder) {
          case "inbox":
            inbox += 1;
            break;
          case "spam":
            spam += 1;
            break;
          case "promotions":
            promotions += 1;
            break;
          case "other":
            other += 1;
            break;
        }

        const envelope = message.envelope;
        const from = envelope?.from?.[0];
        const fromAddress = from
          ? from.address ?? (from.name ? from.name : "")
          : "";
        const subject = envelope?.subject ?? "";
        const messageId = envelope?.messageId ?? null;
        const internalDate = message.internalDate ?? envelope?.date ?? null;

        samples.push({
          uid,
          subject,
          from: fromAddress,
          messageId,
          receivedAt: toIso(internalDate),
          folder,
          labels
        });
      }

      const matched = samples.length;
      const placementRate = matched > 0 ? round4(inbox / matched) : 0;

      return {
        matched,
        inbox,
        spam,
        promotions,
        other,
        placementRate,
        samples,
        elapsedMs: Date.now() - startedAt
      };
    } finally {
      if (lock) {
        try {
          lock.release();
        } catch {
          /* ignore — lock release best-effort */
        }
      }
      try {
        await client.logout();
      } catch {
        /* ignore — logout best-effort, conexión se cierra de todos modos */
      }
    }
  }
}

/* ============================================================
 * Helpers exportados (testables)
 * ============================================================ */

/**
 * Construye un gmraw query equivalente al search bar de Gmail. Soporta:
 *   - subject:"<matcher>" newer_than:<minutes>m
 *   - from:<matcher> newer_than:<minutes>m
 *   - rfc822msgid:<matcher>
 *
 * Para subject envolvemos en comillas. `since` es opcional pero loggea fecha
 * exacta. Usamos `newer_than:Xm` que Gmail entiende nativo.
 */
export function buildGmraw(
  matchBy: PlacementMatchBy,
  matcher: string,
  _since: Date,
  windowMinutes: number
): string {
  const minutes = Math.max(1, Math.floor(windowMinutes));
  const window = `newer_than:${minutes}m`;
  switch (matchBy) {
    case "subject":
      return `subject:${quoteGmraw(matcher)} ${window}`;
    case "from":
      return `from:${quoteGmraw(matcher)} ${window}`;
    case "messageId":
      // rfc822msgid no acepta comillas en gmraw; se pasa pelado
      return `rfc822msgid:${stripAngleBrackets(matcher)}`;
  }
}

function quoteGmraw(value: string): string {
  // Gmail acepta literal entre comillas; escapamos comillas dobles
  return `"${value.replaceAll('"', '\\"')}"`;
}

function stripAngleBrackets(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}

function normalizeLabels(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((label) => (typeof label === "string" ? label : ""))
      .filter((label) => label.length > 0);
  }
  if (raw instanceof Set) {
    const out: string[] = [];
    for (const label of raw) {
      if (typeof label === "string" && label.length > 0) {
        out.push(label);
      }
    }
    return out;
  }
  return [];
}

export function classifyByLabels(labels: string[]): PlacementFolder {
  const lowered = labels.map((label) => label.toLowerCase());
  if (lowered.includes("\\junk") || lowered.includes("\\spam")) {
    return "spam";
  }
  if (lowered.includes("category_promotions") || lowered.includes("\\promotions")) {
    return "promotions";
  }
  if (lowered.includes("\\inbox")) {
    return "inbox";
  }
  return "other";
}

function classifyConnectError(error: unknown): GmailImapAdapterErrorCode {
  if (error && typeof error === "object") {
    const errObj = error as { code?: unknown; authenticationFailed?: unknown; responseStatus?: unknown };
    if (
      errObj.authenticationFailed === true ||
      errObj.responseStatus === "NO" ||
      String(errObj.code ?? "").toUpperCase().includes("AUTH")
    ) {
      return "imap_auth_failed";
    }
  }
  return "imap_connect_failed";
}

function toIso(value: Date | string | number | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

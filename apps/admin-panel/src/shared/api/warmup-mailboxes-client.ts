/**
 * Cliente del panel para la Warmup API (carril B) — endpoints que VIVEN como rutas del gateway
 * (`apps/gateway-api`), NO como servicio HTTP separado (decisión del operador).
 *
 * Cubre lo que la vista de warmup necesita para la carga manual y los logs por buzón:
 *   - POST /v1/mailboxes            → meter un buzón al warmup a mano (email, domain). La ref SMTP la
 *                                     deriva el backend del id del nodo (vault); no se carga a mano.
 *   - GET  /v1/mailboxes/:id/events → historial por buzón (envíos, recepción, placement, cambios de
 *                                     estado) + surface del DLQ real (sends dead_lettered/failed).
 *
 * Contrato asumido del roadmap §5.5 (anotado como supuesto: si el carril B lo materializa distinto,
 * solo hay que ajustar el shape acá — la UI consume estos tipos, no el wire directo).
 *
 * AUTH: la Warmup API se autentica con `WARMUP_API_KEY` (header), pero esa clave NO se embebe en el
 * browser. Igual que `placement-check` (App Password server-side), el gateway inyecta la API key desde
 * su entorno al proxear estas rutas. El panel solo hace la llamada same-origin. NO va por el
 * read-boundary del panel (que es solo-lectura); estas rutas son de la Warmup API.
 *
 * Estos endpoints NO están en READ_ENDPOINTS a propósito: usan `fetch` crudo (patrón de
 * `postPlacementCheck` / `startWarmupRamp` en client.ts). Tolerancia a estado vacío/error con gracia.
 */

/* ============================================================
 * Tipos del contrato (mirror local — carril B).
 * ============================================================ */

/** Estado del buzón (FSM del engine). Mismo dominio que WarmupNodeState del status. */
export type WarmupMailboxState = "blocked" | "fresh" | "warm" | "paused" | "quarantined" | string;

/** Estado de un envío de warmup (warmup_sends.status). Incluye los terminales de DLQ. */
export type WarmupSendStatus =
  | "queued"
  | "sent"
  | "bounced"
  | "failed"
  | "dead_lettered"
  | string;

/** Tipo de evento en el historial por buzón. */
export type WarmupMailboxEventType =
  | "send"
  | "signal"
  | "receive"
  | "placement"
  | "state_change"
  | "auth"
  | string;

/** Un evento del historial por buzón. Shape permisivo: campos opcionales según `type`. */
export interface WarmupMailboxEvent {
  /** id estable del evento (fallback sintético si el backend no lo trae). */
  id: string;
  type: WarmupMailboxEventType;
  occurredAt: string;
  /** send: estado del envío (sent/failed/bounced/dead_lettered/queued). signal: kind (bounce/complaint/deferral). */
  status?: WarmupSendStatus;
  /** placement/receive: proveedor del seed (gmail/outlook/yahoo/…). */
  provider?: string;
  /** placement: dónde cayó (inbox/tabs/spam/missing). */
  landedIn?: string;
  /** state_change: transición de la FSM. */
  fromState?: WarmupMailboxState;
  toState?: WarmupMailboxState;
  /** send/signal: destinatario del envío (warmup_sends.to_address). */
  toAddress?: string;
  /** send: último error del transporte (warmup_sends.last_error). */
  lastError?: string;
  /** motivo/detalle libre (razón del gate, error del transporte, etc.). */
  detail?: string;
  /** ancla idempotente del envío (X-Delivrix-Slot). */
  slotKey?: string;
}

export interface WarmupMailboxEventsResult {
  mailboxId: string;
  events: WarmupMailboxEvent[];
  /** aviso del backend cuando Postgres/tablas no están disponibles. */
  note?: string;
}

/* ============================================================
 * Normalizador de eventos — tolerante a shape (para tests + UI).
 * ============================================================ */

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normaliza la respuesta cruda de GET /v1/mailboxes/:id/events a un shape estable. Tolera:
 *   - envelope `{ mailboxId, events, note }`
 *   - envelope `{ events }`
 *   - array pelado `[ ...eventos ]`
 * Cada evento recibe un `id` sintético estable si no vino uno. Nunca lanza; entrada basura ⇒ vacío.
 */
export function normalizeMailboxEvents(raw: unknown, fallbackMailboxId = ""): WarmupMailboxEventsResult {
  const envelope = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawList = Array.isArray(raw)
    ? raw
    : Array.isArray(envelope.events)
    ? (envelope.events as unknown[])
    : [];

  const events: WarmupMailboxEvent[] = rawList
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
    .map((e, index) => ({
      id: asString(e.id) ?? `evt-${index}`,
      // El backend emite `kind` ('send'|'signal'); toleramos también `type` directo (tests/legacy).
      // 'send' queda 'send'; 'signal' se preserva como tipo distinto (bounce/complaint/deferral en status).
      type: asString(e.type) ?? asString(e.kind) ?? "send",
      occurredAt: asString(e.occurredAt) ?? asString(e.at) ?? "",
      status: asString(e.status),
      provider: asString(e.provider),
      landedIn: asString(e.landedIn) ?? asString(e.landed_in),
      fromState: asString(e.fromState) ?? asString(e.from_state),
      toState: asString(e.toState) ?? asString(e.to_state),
      toAddress: asString(e.toAddress) ?? asString(e.to_address),
      lastError: asString(e.lastError) ?? asString(e.last_error),
      detail: asString(e.detail) ?? asString(e.reason) ?? asString(e.message),
      slotKey: asString(e.slotKey) ?? asString(e.slot_key)
    }));

  return {
    mailboxId: asString(envelope.mailboxId) ?? asString(envelope.mailbox_id) ?? fallbackMailboxId,
    events,
    note: asString(envelope.note)
  };
}

/** Estados terminales de fallo que constituyen el DLQ real (warmup_sends). */
const DLQ_STATUSES: ReadonlySet<string> = new Set(["dead_lettered", "failed"]);

/**
 * Deriva las entradas de DLQ desde el feed de eventos: envíos con status dead_lettered/failed. Es el
 * surface del DLQ real que el dashboard agregado hoy no muestra. Pura y testeable.
 */
export function deriveDlqEntries(events: WarmupMailboxEvent[]): WarmupMailboxEvent[] {
  return events.filter(
    (e) => e.type === "send" && typeof e.status === "string" && DLQ_STATUSES.has(e.status)
  );
}

/* ============================================================
 * GET /v1/mailboxes/:id/events — historial por buzón.
 * ============================================================ */

export async function getWarmupMailboxEvents(mailboxId: string): Promise<WarmupMailboxEventsResult> {
  const url = `/v1/mailboxes/${encodeURIComponent(mailboxId)}/events`;
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  // 404 = buzón sin historial todavía: estado vacío con gracia, no error.
  if (response.status === 404) {
    return { mailboxId, events: [] };
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string"
        ? (payload as { message: string }).message
        : `GET ${url} failed (${response.status}).`;
    throw new Error(message);
  }
  return normalizeMailboxEvents(payload, mailboxId);
}

/* ============================================================
 * POST /v1/mailboxes — carga manual de un buzón al warmup.
 * ============================================================ */

export interface WarmupMailboxCreateInput {
  /** dirección completa del buzón (ej. warm@delivrix.io). */
  email: string;
  /** dominio del buzón (ej. delivrix.io). Se infiere del email si se omite. */
  domain?: string;
  /** operador que dispara la carga (para auditoría). */
  actorId?: string;
}

export interface WarmupMailboxCreateResult {
  ok: boolean;
  id?: string;
  state?: WarmupMailboxState;
  /** created = nuevo (201); exists = idempotente, ya estaba (200, created:false). */
  status?: "created" | "exists" | string;
  message?: string;
}

/**
 * Mete un buzón al warmup a mano. Idempotente del lado del backend (carril B): reintentar el mismo
 * email NO duplica ni resetea el estado del nodo vivo.
 *
 * Contrato REAL del carril B (warmup-mailboxes.ts): responde `{ created, source, mailbox:{ id, state } }`
 * con HTTP 201 (creado) o 200 (ya existía, created:false). Mapeamos `created` → status created/exists y
 * leemos id/state desde `mailbox`. La credencial SMTP NO se envía: `smtpRef` es una referencia de vault
 * DERIVADA del id del nodo por el backend (determinista), no un dato del operador.
 */
export async function postWarmupMailbox(
  input: WarmupMailboxCreateInput
): Promise<WarmupMailboxCreateResult> {
  const url = "/v1/mailboxes";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(input)
  });
  const payload = (await response.json().catch(() => ({}))) as {
    created?: boolean;
    source?: string;
    mailbox?: { id?: string; state?: WarmupMailboxState };
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    const message =
      asString(payload.error) ?? asString(payload.message) ?? `POST ${url} failed (${response.status}).`;
    throw new Error(message);
  }
  return {
    ok: true,
    id: payload.mailbox?.id,
    state: payload.mailbox?.state,
    // created:false ⇒ ya existía (reintento idempotente). Cualquier otro caso ⇒ creado.
    status: payload.created === false ? "exists" : "created"
  };
}

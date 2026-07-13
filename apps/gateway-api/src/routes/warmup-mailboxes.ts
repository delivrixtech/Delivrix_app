// Warmup API — rutas HTTP montadas EN EL GATEWAY (no un servicio separado), Track B del roadmap.
// Es lo que Delivrix consume para saber qué buzones están calientes (state=warm) y para onboardearlos.
//
// Contrato (roadmap §2 Track B / §5.5):
//   POST /v1/mailboxes:onboard            → onboarding idempotente (handoff desde fábricas)
//   POST /v1/mailboxes                    → carga manual (un endpoint)
//   GET  /v1/mailboxes/warm               → SÓLO buzones WARM (lo que consume Delivrix)
//   GET  /v1/mailboxes                    → listado con filtros (state, domain, limit, offset)
//   GET  /v1/mailboxes/:id                → un buzón
//   GET  /v1/mailboxes/:id/events         → historial (sends + signals)
//   GET  /v1/warmup/mailboxes-health      → salud + conteos (NO colisiona con /v1/warmup/status)
//
// Auth: WARMUP_API_KEY por header `x-warmup-api-key`.
//   - LECTURAS (warm/list/get/events/health): si WARMUP_API_KEY NO está seteada, se caen al read-boundary
//     (mismo gate que /v1/warmup/status) — así el panel sigue leyendo en local sin una llave aparte.
//   - ESCRITURAS (onboard/create): FAIL-CLOSED. SIEMPRE exigen WARMUP_API_KEY; NUNCA caen al read-boundary.
//     Sin la llave seteada → 503 `warmup_api_key_not_configured`. Así un portador del token de sólo-lectura
//     del panel no puede onboardear buzones (crear nodos emisores) si en prod se olvida la llave dedicada.
//
// Import discipline: se importa el store desde su archivo específico (pg-stores.ts), NO desde el barrel
// index.ts del engine, para no arrastrar nodemailer/imapflow al proceso del gateway (igual que warmup-status).
//
// NUNCA se expone la credencial SMTP: `smtpRef` es una referencia de vault derivada del id del nodo.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NodeState } from "../../../warmup-engine/src/domain/types.ts";
import {
  createWarmupMailboxStore,
  WARM_PLACEMENT_DEFAULT_MIN,
  type PgClient
} from "../../../warmup-engine/src/store/pg-stores.ts";
import type { GatewayRuntimeLogger } from "../gateway-runtime-log.ts";
import { readRequestBody } from "../request-body.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

const VALID_STATES: readonly NodeState[] = ["blocked", "fresh", "warm", "paused", "quarantined"];

/** Tope duro de items por request de onboard masivo. Se clampa (no se rechaza) para no perder el resto. */
const MAX_ONBOARD_BATCH = 200;

export interface WarmupMailboxesDeps {
  pgClient: PgClient | null;
  /** Llave de la Warmup API. Si falta, se usa el read-boundary como fallback de dev. */
  warmupApiKey?: string;
  /** Token del read-boundary (fallback de auth cuando no hay WARMUP_API_KEY). */
  readBoundaryToken?: string;
  /** Umbral de placement para /warm (default 0.80, con piso duro 0.80). */
  placementMin?: number;
  now?: () => Date;
  logger?: Pick<GatewayRuntimeLogger, "warn">;
}

type AuthOutcome = { ok: true } | { ok: false; statusCode: number; error: string };

/**
 * Auth de la Warmup API. Con WARMUP_API_KEY seteada exige el header `x-warmup-api-key` (comparación
 * timing-safe). Sin ella: las LECTURAS caen al read-boundary del panel (dev); las ESCRITURAS
 * (`requireApiKey=true`) son fail-closed → 503, NUNCA usan el read-boundary. Ver header del archivo.
 */
function authorizeWarmupApi(
  request: IncomingMessage,
  deps: WarmupMailboxesDeps,
  scope: string,
  requireApiKey = false
): AuthOutcome {
  const expected = deps.warmupApiKey?.trim();
  if (expected) {
    const supplied = headerValue(request, "x-warmup-api-key");
    if (!supplied || !safeEqual(supplied, expected)) {
      return { ok: false, statusCode: 401, error: "warmup_api_key_invalid" };
    }
    return { ok: true };
  }
  // Escrituras: sin llave dedicada NO hay fallback. Se protege la creación de nodos emisores.
  if (requireApiKey) {
    return { ok: false, statusCode: 503, error: "warmup_api_key_not_configured" };
  }
  const fallback = authorizeSensitiveRead(request, { readBoundaryToken: deps.readBoundaryToken }, scope);
  return fallback.ok ? { ok: true } : { ok: false, statusCode: fallback.statusCode, error: fallback.error };
}

/** Piso duro del umbral: nunca por debajo de 0.80 (§9), aunque el env lo baje. */
function resolvePlacementMin(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return WARM_PLACEMENT_DEFAULT_MIN;
  return Math.max(WARM_PLACEMENT_DEFAULT_MIN, value);
}

// ── POST /v1/mailboxes:onboard  y  POST /v1/mailboxes ────────────────────────────────────────────
// Ambos onboardean de forma idempotente (create-only por email). El :onboard es el handoff de fábricas;
// el plano es la carga manual. Mismo store, misma idempotencia; se diferencian sólo por `source` en la
// respuesta para trazabilidad.

export async function handleWarmupMailboxOnboard(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupMailboxesDeps
): Promise<void> {
  return onboard(request, response, deps, "handoff");
}

export async function handleWarmupMailboxCreate(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupMailboxesDeps
): Promise<void> {
  return onboard(request, response, deps, "manual");
}

async function onboard(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupMailboxesDeps,
  source: "handoff" | "manual"
): Promise<void> {
  const auth = authorizeWarmupApi(request, deps, "warmup_mailboxes_write", true);
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }
  if (!deps.pgClient) {
    json(response, 503, { error: "warmup_db_unavailable" });
    return;
  }

  let body: unknown;
  try {
    const raw = await readRequestBody(request);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    json(response, 400, { error: "invalid_json_body" });
    return;
  }

  const parsed = parseOnboardBody(body);
  if (!parsed.ok) {
    json(response, 422, { error: parsed.error });
    return;
  }

  try {
    const store = createWarmupMailboxStore(deps.pgClient);
    const result = await store.onboardMailbox(parsed.input);
    // 201 si se creó; 200 si ya existía (idempotente). El estado del nodo vivo se preserva.
    json(response, result.created ? 201 : 200, {
      created: result.created,
      source,
      mailbox: result.mailbox
    });
  } catch (error) {
    void deps.logger?.warn("warmup.mailbox_onboard_failed", "Warmup mailbox onboard failed.", {
      message: errorMessage(error)
    });
    json(response, 503, { error: "warmup_db_write_failed" });
  }
}

interface ParsedOnboard {
  email: string;
  domain: string;
  infraType?: "postfix" | "m365";
  dailyLimit?: number;
  increaseByDay?: number;
  weekdaysOnly?: boolean;
  sendingIp?: string;
  heloFqdn?: string;
}

function parseOnboardBody(body: unknown): { ok: true; input: ParsedOnboard } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body_must_be_object" };
  }
  const record = body as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim() : "";
  if (!email || !email.includes("@")) {
    return { ok: false, error: "email_required" };
  }
  // domain: explícito o derivado del email.
  const domain =
    typeof record.domain === "string" && record.domain.trim()
      ? record.domain.trim()
      : email.slice(email.indexOf("@") + 1);
  if (!domain) {
    return { ok: false, error: "domain_required" };
  }
  const input: ParsedOnboard = { email, domain };
  if (record.infraType === "postfix" || record.infraType === "m365") {
    input.infraType = record.infraType;
  }
  const dailyLimit = positiveIntOrUndefined(record.dailyLimit);
  if (dailyLimit !== undefined) input.dailyLimit = dailyLimit;
  const increaseByDay = positiveIntOrUndefined(record.increaseByDay);
  if (increaseByDay !== undefined) input.increaseByDay = increaseByDay;
  if (typeof record.weekdaysOnly === "boolean") input.weekdaysOnly = record.weekdaysOnly;
  if (typeof record.sendingIp === "string" && record.sendingIp.trim()) input.sendingIp = record.sendingIp.trim();
  if (typeof record.heloFqdn === "string" && record.heloFqdn.trim()) input.heloFqdn = record.heloFqdn.trim();
  return { ok: true, input };
}

// ── POST /v1/mailboxes:onboard-batch  (onboard MASIVO idempotente) ─────────────────────────────────
// Toma el checklist del Sender Pool ("Calentar seleccionados") y onboardea VARIOS buzones de una.
// Cada item se onboardea con la MISMA lógica create-only idempotente (reintento NO duplica; el nodo
// nace 'blocked'). Un item inválido/fallido NO tumba el batch: se marca `failed` en su result y sigue.
// Auth: misma x-warmup-api-key fail-closed que el onboard single (crear nodos emisores es escritura).
//
// Body:    { mailboxes: Array<{ email, domain?, infraType?, dailyLimit?, increaseByDay?,
//                               weekdaysOnly?, sendingIp?, heloFqdn? }> }   (máx 200; se clampa)
// Respuesta 200: { summary: { requested, created, existing, failed },
//                  results: Array<{ email, created:boolean, state?, error? }> }
//   - created  = insertado ahora (nodo nuevo, state 'blocked')
//   - existing = ya existía (idempotente, estado preservado; created=false, sin error)
//   - failed   = item con `error` (inválido o write DB); no cuenta como created ni existing

export async function handleWarmupMailboxOnboardBatch(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupMailboxesDeps
): Promise<void> {
  const auth = authorizeWarmupApi(request, deps, "warmup_mailboxes_write", true);
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }
  if (!deps.pgClient) {
    json(response, 503, { error: "warmup_db_unavailable" });
    return;
  }

  let body: unknown;
  try {
    const raw = await readRequestBody(request);
    body = raw ? JSON.parse(raw) : {};
  } catch {
    json(response, 400, { error: "invalid_json_body" });
    return;
  }

  if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).mailboxes)) {
    json(response, 422, { error: "mailboxes_required" });
    return;
  }
  // Clamp de tamaño: nos quedamos con los primeros MAX (no rechazamos todo el batch).
  const rawItems = ((body as { mailboxes: unknown[] }).mailboxes).slice(0, MAX_ONBOARD_BATCH);
  const requested = rawItems.length;

  // Validación por item: los válidos van al store; los inválidos ya quedan resueltos como failed.
  type ItemResult = { email: string; created: boolean; state?: string; error?: string };
  const results: ItemResult[] = new Array(requested);
  const validInputs: ParsedOnboard[] = [];
  const validIndex: number[] = [];
  rawItems.forEach((item, idx) => {
    const parsed = parseOnboardBody(item);
    if (parsed.ok) {
      validInputs.push(parsed.input);
      validIndex.push(idx);
    } else {
      results[idx] = { email: itemEmail(item), created: false, error: parsed.error };
    }
  });

  if (validInputs.length > 0) {
    try {
      const store = createWarmupMailboxStore(deps.pgClient);
      const onboarded = await store.onboardMany(validInputs);
      onboarded.forEach((r, k) => {
        const idx = validIndex[k];
        results[idx] =
          r.error !== undefined
            ? { email: r.email, created: false, error: r.error }
            : { email: r.email, created: r.created, ...(r.state ? { state: r.state } : {}) };
      });
    } catch (error) {
      // Falla dura del store (no debería ocurrir: onboardMany aísla por item). Marcamos los válidos
      // como failed para que el batch devuelva un reporte coherente en vez de 503 todo-o-nada.
      void deps.logger?.warn("warmup.mailbox_onboard_batch_failed", "Warmup mailbox onboard batch failed.", {
        message: errorMessage(error)
      });
      validIndex.forEach((idx, k) => {
        results[idx] = { email: validInputs[k].email, created: false, error: "warmup_db_write_failed" };
      });
    }
  }

  let created = 0;
  let existing = 0;
  let failed = 0;
  for (const r of results) {
    if (r.error !== undefined) failed++;
    else if (r.created) created++;
    else existing++;
  }

  json(response, 200, { summary: { requested, created, existing, failed }, results });
}

/** Best-effort del email de un item crudo para el result de un item inválido (sin romper). */
function itemEmail(item: unknown): string {
  if (typeof item === "object" && item !== null) {
    const raw = (item as Record<string, unknown>).email;
    if (typeof raw === "string") return raw.trim();
  }
  return "";
}

// ── GET /v1/mailboxes/warm ───────────────────────────────────────────────────────────────────────
// REGLA DURA: sólo state=warm AND placement_score>=umbral. Nunca fríos.

export async function handleWarmupMailboxesWarm(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupMailboxesDeps
): Promise<void> {
  const auth = authorizeWarmupApi(request, deps, "warmup_mailboxes_warm");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  const placementMin = resolvePlacementMin(deps.placementMin);
  if (!deps.pgClient) {
    json(response, 200, { generatedAt: now.toISOString(), placementMin, mailboxes: [], note: "warmup_db_unavailable" });
    return;
  }
  try {
    const store = createWarmupMailboxStore(deps.pgClient);
    const mailboxes = await store.listWarmMailboxes(placementMin);
    json(response, 200, { generatedAt: now.toISOString(), placementMin, mailboxes });
  } catch (error) {
    void deps.logger?.warn("warmup.mailboxes_warm_read_failed", "Warmup warm-mailboxes read failed.", {
      message: errorMessage(error)
    });
    json(response, 200, {
      generatedAt: now.toISOString(),
      placementMin,
      mailboxes: [],
      note: "warmup_tables_unavailable"
    });
  }
}

// ── GET /v1/mailboxes  (listado con filtros) ───────────────────────────────────────────────────────

export async function handleWarmupMailboxesList(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupMailboxesDeps,
  query: URLSearchParams
): Promise<void> {
  const auth = authorizeWarmupApi(request, deps, "warmup_mailboxes_list");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  if (!deps.pgClient) {
    json(response, 200, { generatedAt: now.toISOString(), mailboxes: [], note: "warmup_db_unavailable" });
    return;
  }
  const filters: { state?: NodeState; domain?: string; limit?: number; offset?: number } = {};
  const stateParam = query.get("state");
  if (stateParam && (VALID_STATES as readonly string[]).includes(stateParam)) {
    filters.state = stateParam as NodeState;
  }
  const domainParam = query.get("domain");
  if (domainParam) filters.domain = domainParam;
  const limitParam = numberOrUndefined(query.get("limit"));
  if (limitParam !== undefined) filters.limit = limitParam;
  const offsetParam = numberOrUndefined(query.get("offset"));
  if (offsetParam !== undefined) filters.offset = offsetParam;

  try {
    const store = createWarmupMailboxStore(deps.pgClient);
    const mailboxes = await store.listMailboxes(filters);
    json(response, 200, { generatedAt: now.toISOString(), mailboxes });
  } catch (error) {
    void deps.logger?.warn("warmup.mailboxes_list_read_failed", "Warmup mailboxes list read failed.", {
      message: errorMessage(error)
    });
    json(response, 200, { generatedAt: now.toISOString(), mailboxes: [], note: "warmup_tables_unavailable" });
  }
}

// ── GET /v1/mailboxes/:id ──────────────────────────────────────────────────────────────────────────

export async function handleWarmupMailboxGet(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupMailboxesDeps,
  id: string
): Promise<void> {
  const auth = authorizeWarmupApi(request, deps, "warmup_mailbox_get");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }
  if (!deps.pgClient) {
    json(response, 503, { error: "warmup_db_unavailable" });
    return;
  }
  try {
    const store = createWarmupMailboxStore(deps.pgClient);
    const mailbox = await store.getMailbox(id);
    if (!mailbox) {
      json(response, 404, { error: "mailbox_not_found" });
      return;
    }
    json(response, 200, { mailbox });
  } catch (error) {
    void deps.logger?.warn("warmup.mailbox_get_failed", "Warmup mailbox get failed.", {
      message: errorMessage(error)
    });
    json(response, 503, { error: "warmup_db_read_failed" });
  }
}

// ── GET /v1/mailboxes/:id/events ─────────────────────────────────────────────────────────────────

export async function handleWarmupMailboxEvents(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupMailboxesDeps,
  id: string,
  query: URLSearchParams
): Promise<void> {
  const auth = authorizeWarmupApi(request, deps, "warmup_mailbox_events");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  if (!deps.pgClient) {
    json(response, 200, { generatedAt: now.toISOString(), id, events: [], note: "warmup_db_unavailable" });
    return;
  }
  const limit = numberOrUndefined(query.get("limit"));
  try {
    const store = createWarmupMailboxStore(deps.pgClient);
    const events = await store.listMailboxEvents(id, limit);
    json(response, 200, { generatedAt: now.toISOString(), id, events });
  } catch (error) {
    void deps.logger?.warn("warmup.mailbox_events_failed", "Warmup mailbox events read failed.", {
      message: errorMessage(error)
    });
    json(response, 200, { generatedAt: now.toISOString(), id, events: [], note: "warmup_tables_unavailable" });
  }
}

// ── GET /v1/warmup/mailboxes-health ──────────────────────────────────────────────────────────────

export async function handleWarmupMailboxesHealth(
  request: IncomingMessage,
  response: ServerResponse,
  deps: WarmupMailboxesDeps
): Promise<void> {
  const auth = authorizeWarmupApi(request, deps, "warmup_mailboxes_health");
  if (!auth.ok) {
    json(response, auth.statusCode, { error: auth.error });
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  if (!deps.pgClient) {
    json(response, 200, {
      generatedAt: now.toISOString(),
      totals: { nodes: 0, warm: 0, queuedSends: 0, deadLetteredSends: 0, failedSends: 0 },
      byState: {},
      bySendStatus: {},
      note: "warmup_db_unavailable"
    });
    return;
  }
  try {
    const store = createWarmupMailboxStore(deps.pgClient);
    const health = await store.warmupHealth(now);
    json(response, 200, health);
  } catch (error) {
    void deps.logger?.warn("warmup.mailboxes_health_failed", "Warmup mailboxes health read failed.", {
      message: errorMessage(error)
    });
    json(response, 200, {
      generatedAt: now.toISOString(),
      totals: { nodes: 0, warm: 0, queuedSends: 0, deadLetteredSends: 0, failedSends: 0 },
      byState: {},
      bySendStatus: {},
      note: "warmup_tables_unavailable"
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return typeof value === "string" ? value.trim() : "";
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function positiveIntOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function numberOrUndefined(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

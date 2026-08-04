// Daemon AUTÓNOMO del warmup LIVE (opción B). Corre solo, en rampa, las vueltas reales
// (send→measure→engage→reply) y las persiste en warmup_activity (el panel las muestra en vivo).
//
// SEGURO POR DISEÑO — barreras duras, todas verificadas en cada vuelta:
//   1. WARMUP_LIVE_ENABLE=true  · master switch (default OFF ⇒ el daemon es INERTE, cero correo).
//   2. Kill-file  · si existe runtime/warmup-live.kill ⇒ pausa (no manda). `touch`/`rm` para on/off.
//   3. Tope diario  · WARMUP_LIVE_MAX_PER_DAY (default 3) ⇒ nunca más de N vueltas por día UTC.
//   4. Gate de placement  · si la tasa de inbox reciente < WARMUP_LIVE_PLACEMENT_FLOOR ⇒ auto-pausa.
//   5. Intervalo  · WARMUP_LIVE_INTERVAL_MS entre vueltas (default 4h) — cadencia baja, sin ráfagas.
// Rota boxes y conversaciones. NUNCA loguea secretos. --once corre una sola vuelta (respeta las barreras).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Pool } from "pg";
import { elegirSemilla, semillasMedibles, type SeedBase } from "../domain/seeds.ts";
import { elegirSemillaRotada, type UsoPrevio } from "../domain/rotacion.ts";
import { opsDesdeImap, type ImapClienteMinimo } from "../live/imap-placement-ops.ts";
import { leerHiloWarmup, type ImapLector } from "../live/imap-thread-reader.ts";
import { pedirSiguienteTurno, tocaResponder, type TurnoHilo } from "../live/continuar-conversacion.ts";
import { SMTP_POR_PROVEEDOR } from "../domain/seeds.ts";
import { createPgWarmupStores, type PgClient } from "../store/pg-stores.ts";
import { runWarmupMigrations } from "../store/warmup-migrate.ts";
import { pickConversation, conversationCount, makeTestId } from "../live/warmup-content-bank.ts";
import { createGoogleOAuthTokenProvider, type AccessTokenProvider } from "../live/google-oauth-token-provider.ts";
import { resolveCredentialKey, findAndDecryptBox, decryptWithAad, type EncryptedPayload, type InventoryCredentialStore } from "../live/smtp-credential-decrypt.ts";
import {
  runLiveCycle,
  classifyPlacement,
  type Placement,
  type WarmupMailer,
  type GmailOps,
  type ActivityRecorder,
  type ActivityEvent
} from "../live/warmup-live-cycle.ts";

const require = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_BOXES = [
  "infranationalcorp.com",
  "bizfiling-infra.com",
  "corpledger-control.com",
  "corpregistry-control.com",
  "docfiling-ops.com",
  "controlstatecorp.com"
];

export interface LiveDaemonConfig {
  enabled: boolean;
  maxPerDay: number;
  intervalMs: number;
  placementFloor: number;
  /** Ventana (nº de mediciones recientes) sobre la que se evalúa el gate de placement. */
  placementWindow: number;
  boxes: string[];
  seedInbox: string;
  seedsPath: string;
  killFile: string;
  pollAttempts: number;
  pollDelayMs: number;
}

function intEnv(raw: string | undefined, fallback: number, min: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

function floatEnv(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Resuelve la config del daemon desde el entorno. Puro (no toca disco). */
export function resolveLiveDaemonConfig(env: NodeJS.ProcessEnv): LiveDaemonConfig {
  const boxesRaw = (env.WARMUP_LIVE_BOXES ?? "").trim();
  const boxes = boxesRaw.length > 0 ? boxesRaw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_BOXES;
  return {
    enabled: (env.WARMUP_LIVE_ENABLE ?? "").trim().toLowerCase() === "true",
    maxPerDay: intEnv(env.WARMUP_LIVE_MAX_PER_DAY, 3, 1),
    intervalMs: intEnv(env.WARMUP_LIVE_INTERVAL_MS, 4 * 60 * 60 * 1000, 1000),
    placementFloor: floatEnv(env.WARMUP_LIVE_PLACEMENT_FLOOR, 0.5),
    placementWindow: intEnv(env.WARMUP_LIVE_PLACEMENT_WINDOW, 6, 1),
    boxes,
    // Semilla de respaldo. La fuente real es el REGISTRO (warmup-seeds.json): esta env var queda
    // solo para el caso en que el registro no exista todavía, y para saber cuál es la que MIDE
    // (la que tiene el refresh token OAuth de config/warmup-oauth.local.json).
    seedInbox: (env.WARMUP_GMAIL_SEED_USER ?? "infradelivrixdemo@gmail.com").trim(),
    seedsPath: (env.WARMUP_SEEDS_FILE ?? resolve(process.cwd(), "runtime/openclaw-workspace/inventory/warmup-seeds.json")).trim(),
    killFile: (env.WARMUP_LIVE_KILL_FILE ?? resolve(process.cwd(), "runtime/warmup-live.kill")).trim(),
    // Ventana de medición amplia: Gmail puede tardar >60s en indexar el mensaje recién enviado.
    // 30 intentos × 6s = ~3min inline. (Mejora futura: medir en un pase posterior, no bloqueante.)
    pollAttempts: intEnv(env.WARMUP_LIVE_POLL_ATTEMPTS, 30, 1),
    pollDelayMs: intEnv(env.WARMUP_LIVE_POLL_DELAY_MS, 6000, 100)
  };
}

// ── Decisión de gate (pura, testeable) ──────────────────────────────────────────────────────────────

// ── Semillas: el registro manda ─────────────────────────────────────────────────────────────────────

/**
 * La forma mínima que el daemon necesita. Las REGLAS (a quién se le manda, quién mide) viven en
 * `domain/seeds.ts`: acá se importan, no se reescriben. Estaban duplicadas y era cuestión de tiempo
 * que un arreglo llegara a una mitad y no a la otra.
 */
export type SeedDelDaemon = SeedBase & {
  /** Presentes en el registro; el daemon los necesita para abrir IMAP con esa semilla. */
  imap?: { host: string; port: number };
  secretEncrypted?: EncryptedPayload;
};

/** Abre el cliente IMAP de una semilla con app password. Devuelve null si le falta algo. */
async function opsImapDeSemilla(seed: SeedDelDaemon, key: Buffer): Promise<{ cliente: ImapClienteMinimo; ops: ReturnType<typeof opsDesdeImap>; cerrar: () => Promise<void> } | null> {
  if (seed.auth !== "imap_password" || !seed.secretEncrypted || !seed.imap) return null;
  const pass = decryptWithAad(seed.secretEncrypted, key, {
    address: seed.address,
    provider: seed.provider,
    kind: "warmup_seed_secret"
  });
  const { ImapFlow } = require("imapflow") as { ImapFlow: new (o: Record<string, unknown>) => ImapClienteMinimo };
  const cliente = new ImapFlow({
    host: seed.imap.host,
    port: seed.imap.port,
    secure: true,
    auth: { user: seed.address, pass },
    logger: false
  });
  await cliente.connect();

  // La RESPUESTA desde la semilla: mismo app password, SMTP del proveedor. Es la senal
  // bidireccional — el receptor no solo recibio, contesto.
  const smtp = SMTP_POR_PROVEEDOR[seed.provider as keyof typeof SMTP_POR_PROVEEDOR];
  const nodemailer = require("nodemailer");
  const transporte = smtp
    ? nodemailer.createTransport({
        host: smtp.host, port: smtp.port, secure: false, requireTLS: true,
        auth: { user: seed.address, pass }
      })
    : null;
  const enviador = transporte
    ? {
        async send(input: { from: string; to: string; subject: string; inReplyTo: string; references: string; body: string }) {
          const info = await transporte.sendMail({
            from: input.from, to: input.to, subject: input.subject, text: input.body,
            inReplyTo: input.inReplyTo, references: input.references
          });
          return { id: String(info.messageId ?? "") };
        }
      }
    : undefined;

  return {
    cliente,
    ops: opsDesdeImap(cliente, enviador),
    cerrar: async () => {
      try { await cliente.logout(); } catch { /* ya cerrado */ }
    }
  };
}

export const elegirSemillaDelRegistro = elegirSemilla;

/**
 * ¿Podemos MEDIR dónde cayó este envío?
 *
 * Las Gmail ops del daemon están atadas a UNA cuenta (la del refresh token OAuth). Si el correo fue
 * a otra semilla, buscar ahí devolvería "no encontrado" sobre un mensaje que sí llegó — un dato
 * falso peor que ninguno. Así que se mide SOLO cuando la semilla elegida es la de OAuth; en las
 * demás el envío se registra como enviado-sin-medir, que es la verdad.
 */
export function puedeMedir(seed: SeedDelDaemon, cuentaDeMedicion: string): boolean {
  // IMAP: cualquier semilla con app password mide, sea Gmail, Outlook o Yahoo — y su credencial no
  // caduca sola. Es el camino que manda el diseno v1 (SMTP+IMAP, no la API del proveedor).
  if (seed.auth === "imap_password") return true;
  // OAuth: las Gmail ops estan atadas a UNA cuenta (la del refresh token). Si el correo fue a otra
  // semilla, buscar ahi devolveria "no encontrado" sobre un mensaje que si llego.
  return seed.auth === "gmail_oauth" && seed.address.toLowerCase() === cuentaDeMedicion.toLowerCase();
}

export type DaemonAction = "inert" | "killed" | "cap-reached" | "placement-pause" | "send";

export interface GateInput {
  enabled: boolean;
  killed: boolean;
  cyclesToday: number;
  maxPerDay: number;
  recentPlacements: Placement[];
  placementFloor: number;
}

/** Tasa de inbox reciente (INBOX / total). null si no hay mediciones. */
export function recentInboxRate(placements: readonly Placement[]): number | null {
  if (placements.length === 0) return null;
  const inbox = placements.filter((p) => p === "INBOX").length;
  return inbox / placements.length;
}

/** Decide qué hacer esta vuelta. Orden de barreras: flag → kill → tope → placement → send. */
export function decideDaemonAction(input: GateInput): { action: DaemonAction; reason: string } {
  if (!input.enabled) return { action: "inert", reason: "WARMUP_LIVE_ENABLE!=true" };
  if (input.killed) return { action: "killed", reason: "kill-file presente" };
  if (input.cyclesToday >= input.maxPerDay) {
    return { action: "cap-reached", reason: `tope diario ${input.cyclesToday}/${input.maxPerDay}` };
  }
  const rate = recentInboxRate(input.recentPlacements);
  if (rate !== null && rate < input.placementFloor) {
    return { action: "placement-pause", reason: `inbox ${(rate * 100).toFixed(0)}% < piso ${(input.placementFloor * 100).toFixed(0)}%` };
  }
  return { action: "send", reason: "ok" };
}

/** Rotación estable de boxes por índice de vuelta. */
export function pickBox(boxes: readonly string[], cycleIndex: number): string {
  if (boxes.length === 0) throw new Error("no boxes configured");
  const i = ((cycleIndex % boxes.length) + boxes.length) % boxes.length;
  return boxes[i] as string;
}

// ── Lecturas del estado (Postgres) ──────────────────────────────────────────────────────────────────

/**
 * Los boxes que HOY no pueden mandar, según lo que el propio nodo respondió.
 *
 * Por qué existe: el pool tiene 6 dominios pero el freno físico (cap 0 en Postfix) deja a casi
 * todos sin poder enviar. El daemon los seguía eligiendo por turno y quemaba 5 de cada 6 vueltas
 * contra nodos que responden `450 4.7.1 daily send cap reached`. Eso no es solo desperdicio: cada
 * intento fallido queda como error en el feed y ensucia la lectura del operador.
 *
 * La señal sale de la RESPUESTA REAL del nodo, no de un archivo de configuración aparte: si
 * mañana el cupo cambia, el daemon se entera solo, sin que nadie sincronice nada.
 */
async function boxesSinCupoHoy(pg: PgClient): Promise<Set<string>> {
  const { rows } = await pg.query<{ node_domain: string }>(
    `SELECT DISTINCT node_domain FROM warmup_activity
      WHERE kind = 'error'
        AND occurred_at >= date_trunc('day', now() at time zone 'utc')
        AND detail->>'note' ILIKE '%daily send cap reached%'`
  );
  return new Set(rows.map((r) => r.node_domain));
}

/** Un hilo de una vuelta anterior, candidato a que le sigamos la conversación. */
interface HiloPrevio {
  cycleId: string;
  testId: string;
  nodeDomain: string;
  subject: string;
}

/**
 * Los hilos recientes de ESTA semilla, del más nuevo al más viejo, sin el de la vuelta actual.
 *
 * Se limita a 7 días: un hilo más viejo que eso ya no es una conversación, es un desentierro — y
 * un "Re:" sobre algo de hace dos semanas se lee raro, que es lo contrario de lo que buscamos.
 */
async function hilosParaContinuar(pg: PgClient, seed: string, cycleActual: string): Promise<HiloPrevio[]> {
  // El SELECT interno se queda con el PRIMER 'sent' de cada ciclo: ahí está el asunto original,
  // sin los "Re:" que fueron acumulando los turnos siguientes.
  // El ORDER BY externo es por FECHA. Ordenar por cycle_id sería alfabético — parece cronológico
  // porque el id lleva timestamp, pero deja de serlo en cuanto cambie el formato del id.
  const { rows } = await pg.query<{ cycle_id: string; test_id: string; node_domain: string; subject: string | null; primero: Date }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (cycle_id) cycle_id, test_id, node_domain, subject, occurred_at AS primero
         FROM warmup_activity
        WHERE kind = 'sent'
          AND seed_inbox = $1
          AND cycle_id <> $2
          AND test_id IS NOT NULL
          AND occurred_at > now() - interval '7 days'
        ORDER BY cycle_id, occurred_at ASC
     ) h ORDER BY h.primero DESC`,
    [seed, cycleActual]
  );
  return rows
    .filter((x) => x.test_id && x.subject)
    .map((x) => ({ cycleId: x.cycle_id, testId: x.test_id, nodeDomain: x.node_domain, subject: x.subject! }));
}

/**
 * Cuántas vueltas ENVIARON hoy (UTC).
 *
 * Cuenta solo los ciclos con un evento `sent`, no todos los ciclos. El tope diario existe para
 * limitar el correo REAL que sale — un intento que el nodo rechazó no gastó reputación ni llegó a
 * nadie, y contarlo mata el día por nada.
 *
 * El caso concreto que lo rompía: con 5 de 6 boxes frenados en cap 0, las 3 vueltas permitidas se
 * consumían en rechazos y el daemon nunca llegaba al box que sí podía enviar. El calentamiento se
 * detenía solo, en silencio, y desde afuera parecía que el tope funcionaba bien.
 */
async function countCyclesToday(pg: PgClient): Promise<number> {
  const { rows } = await pg.query<{ n: string | number }>(
    `SELECT COUNT(DISTINCT cycle_id)::int AS n FROM warmup_activity
      WHERE occurred_at >= date_trunc('day', now())
        AND kind = 'sent'`
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * El historial de (dominio, semilla) que usa la rotación. Sale de los envíos REALES: la rotación
 * decide mirando lo que efectivamente pasó, no un contador en memoria que se pierde al reiniciar.
 */
async function historialDeEnvios(pg: PgClient, limite = 400): Promise<UsoPrevio[]> {
  const { rows } = await pg.query<{ node_domain: string; seed_inbox: string; occurred_at: Date }>(
    "SELECT node_domain, seed_inbox, occurred_at FROM warmup_activity WHERE kind = 'sent' ORDER BY occurred_at DESC LIMIT $1",
    [limite]
  );
  return rows.map((r) => ({ domain: r.node_domain, seed: r.seed_inbox, cuando: new Date(r.occurred_at).toISOString() }));
}

/** Últimos placements medidos (para el gate). */
async function recentPlacements(pg: PgClient, window: number): Promise<Placement[]> {
  const { rows } = await pg.query<{ placement: string | null }>(
    "SELECT placement FROM warmup_activity WHERE kind = 'measured' AND placement IS NOT NULL ORDER BY occurred_at DESC LIMIT $1",
    [window]
  );
  return rows
    .map((r) => (r.placement ?? "").toUpperCase())
    .filter((p): p is Placement => p === "INBOX" || p === "SPAM" || p === "PROMOTIONS" || p === "OTHER");
}

// ── Composition root del I/O real ────────────────────────────────────────────────────────────────────

function resolvePool(env: NodeJS.ProcessEnv): Pool {
  const connectionString = env.POSTGRES_URL?.trim();
  return new Pool({
    ...(connectionString ? { connectionString } : {}),
    application_name: "delivrix-warmup-live-daemon"
  });
}

/** Recorder que persiste en warmup_activity (mismo shape que la migración 003). */
function createPgRecorder(pg: PgClient): ActivityRecorder {
  return {
    async record(e: ActivityEvent): Promise<void> {
      await pg.query(
        "INSERT INTO warmup_activity (cycle_id, node_domain, seed_inbox, kind, placement, subject, detail, test_id)" +
          " VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [e.cycleId, e.boxDomain, e.seedInbox, e.kind, e.placement ?? null, e.subject ?? null, JSON.stringify(e.detail ?? {}), e.testId ?? null]
      );
    }
  };
}

/** Mailer real por box (SMTP 587/STARTTLS). Desencripta el pass del inventario en runtime. */
function createBoxMailer(boxDomain: string, store: InventoryCredentialStore, key: Buffer): WarmupMailer {
  const { record, password } = findAndDecryptBox(store, boxDomain, key);
  const nodemailer = require("nodemailer");
  const transport = nodemailer.createTransport({
    host: record.host, port: 587, secure: false, requireTLS: true,
    auth: { user: record.username, pass: password }, tls: { rejectUnauthorized: false }
  });
  return {
    async send(input) {
      const info = await transport.sendMail({
        from: input.from, to: input.to, subject: input.subject, text: input.text,
        headers: { "X-Delivrix-Test-Id": input.testId }
      });
      return { messageId: info.messageId, response: info.response };
    }
  };
}

/** Gmail REST ops sobre el seed inbox, autenticadas con el access token OAuth (auto-renovable). */
function createGmailOps(tokenProvider: AccessTokenProvider): GmailOps {
  async function gapi(path: string, init: RequestInit = {}): Promise<any> {
    const token = await tokenProvider.getAccessToken();
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
      ...init,
      headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(init.headers ?? {}) }
    });
    const text = await r.text();
    let j: any;
    try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (!r.ok) throw new Error("gmail_api_" + r.status + "_" + path.split("?")[0]);
    return j;
  }
  return {
    async findMessage({ rfc822MessageId, subject }) {
      let id: string | null = null;
      const byId = await gapi("messages?maxResults=1&q=" + encodeURIComponent(`rfc822msgid:"${rfc822MessageId}"`));
      if (byId.messages?.length) id = byId.messages[0].id;
      if (!id) {
        const bySubject = await gapi("messages?maxResults=1&q=" + encodeURIComponent(`subject:"${subject}"`));
        if (bySubject.messages?.length) id = bySubject.messages[0].id;
      }
      if (!id) return null;
      const msg = await gapi("messages/" + id + "?format=metadata&metadataHeaders=Subject");
      return { gmailId: id, threadId: msg.threadId, labelIds: msg.labelIds ?? [] };
    },
    async modifyLabels(gmailId, change) {
      await gapi("messages/" + gmailId + "/modify", {
        method: "POST",
        body: JSON.stringify({ addLabelIds: change.add, removeLabelIds: change.remove })
      });
    },
    async sendReply(input) {
      const raw = [
        "From: " + input.from, "To: " + input.to, "Subject: " + input.subject,
        "In-Reply-To: " + input.inReplyTo, "References: " + input.references,
        "Content-Type: text/plain; charset=utf-8", "", input.body
      ].join("\r\n");
      const sent = await gapi("messages/send", {
        method: "POST",
        body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), threadId: input.threadId })
      });
      return { id: sent.id ?? "" };
    }
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface StartLiveDaemonOptions {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  /** Override del "ahora" para tests. */
  nowSeed?: number;
}

/**
 * Composition-root del daemon LIVE. INERTE si WARMUP_LIVE_ENABLE!=true. --once corre una vuelta.
 * Devuelve al terminar (once) o corre indefinidamente (loop).
 */
export async function startLiveWarmupDaemon(opts: StartLiveDaemonOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const argv = opts.argv ?? process.argv;
  const once = argv.includes("--once") || (env.WARMUP_LIVE_ONCE ?? "").trim() === "1";
  const cfg = resolveLiveDaemonConfig(env);
  const log = (m: string): void => console.log(`[warmup-live] ${m}`);

  if (!cfg.enabled) {
    log("INERTE — WARMUP_LIVE_ENABLE!=true. Cero correo. (Prendé el flag para calentar autónomo.)");
    return;
  }

  const pool = resolvePool(env);
  const pg = pool as unknown as PgClient;
  const stores = createPgWarmupStores(pg);
  void stores; // reservado para futuras métricas; el daemon usa lecturas directas + recorder

  // Asegura la tabla de actividad (idempotente).
  await runWarmupMigrations(pg);

  // Credenciales SMTP del inventario (archivo) + clave.
  const inventoryPath = (env.WARMUP_SMTP_INVENTORY ?? resolve(process.cwd(), "runtime/openclaw-workspace/inventory/smtp-credentials.json")).trim();
  const store = JSON.parse(await readFile(inventoryPath, "utf8")) as InventoryCredentialStore;
  const key = resolveCredentialKey(env.CREDENTIAL_ENCRYPTION_KEY);

  // El REGISTRO de semillas (se agregan a mano con scripts/ops/semillas.ts). Si todavía no existe,
  // se cae a la env var de siempre para no romper — pero se DICE, porque una sola semilla no es
  // warmup y el operador tiene que saber que está corriendo así.
  let semillas: SeedDelDaemon[] = [];
  try {
    const registro = JSON.parse(await readFile(cfg.seedsPath, "utf8")) as { seeds?: SeedDelDaemon[] };
    semillas = Array.isArray(registro.seeds) ? registro.seeds.filter((s) => s.enabled) : [];
  } catch {
    semillas = [];
  }
  if (semillas.length === 0) {
    semillas = [{ address: cfg.seedInbox, provider: "gmail", enabled: true, auth: "gmail_oauth" }];
    log(`SIN REGISTRO de semillas (${cfg.seedsPath}) — uso solo ${cfg.seedInbox}. Cargá semillas con scripts/ops/semillas.ts`);
  } else {
    const miden = semillasMedibles(semillas).length;
    log(`semillas: ${semillas.length} activas · ${miden} pueden medir placement · destinos ${semillas.map((s) => s.address).join(", ")}`);
  }

  const tokenProvider = createGoogleOAuthTokenProvider({});
  const gmail = createGmailOps(tokenProvider);
  const recorder = createPgRecorder(pg);

  let seq = await countCyclesToday(pg); // arranca la rotación donde quedó el día
  log(`ARRANCA — box pool ${cfg.boxes.length}, tope ${cfg.maxPerDay}/día, intervalo ${Math.round(cfg.intervalMs / 60000)}min, piso placement ${(cfg.placementFloor * 100).toFixed(0)}%, seed ${cfg.seedInbox}`);

  try {
    for (;;) {
      const killed = existsSync(cfg.killFile);
      const cyclesToday = await countCyclesToday(pg);
      const placements = await recentPlacements(pg, cfg.placementWindow);
      const { action, reason } = decideDaemonAction({
        enabled: cfg.enabled, killed, cyclesToday, maxPerDay: cfg.maxPerDay, recentPlacements: placements, placementFloor: cfg.placementFloor
      });

      if (action === "send") {
        // Se saltean los boxes que hoy ya rebotaron por cupo: reintentarlos es garantía de error.
        const frenados = await boxesSinCupoHoy(pg).catch(() => new Set<string>());
        const disponibles = cfg.boxes.filter((b) => !frenados.has(b));
        if (disponibles.length === 0) {
          log(`PAUSA — los ${cfg.boxes.length} boxes del pool ya agotaron su cupo diario. Nada que enviar hoy.`);
          if (once) break;
          await sleep(cfg.intervalMs);
          continue;
        }
        if (frenados.size > 0) {
          log(`${frenados.size} box(es) sin cupo hoy, salteados: ${[...frenados].join(", ")}`);
        }
        const box = pickBox(disponibles, seq);
        const conversation = pickConversation(seq);
        const stamp = `${Date.now()}-${seq}`;
        const testId = makeTestId(stamp);
        const cycleId = "cyc-" + stamp;
        const subject = `${conversation.subject} [${testId.slice(-6)}]`;
        // ROTACIÓN sobre el historial REAL: no repite el par (dominio, semilla) mientras haya
        // alternativa, reparte entre proveedores y desempata por la menos usada. Un hash de
        // (dominio, vuelta) dejaba siempre la misma coreografía, que es la huella a evitar.
        const historial = await historialDeEnvios(pg).catch(() => [] as UsoPrevio[]);
        const decision = elegirSemillaRotada(semillas, box, historial);
        const semilla = decision?.semilla ?? {
          address: cfg.seedInbox,
          provider: "gmail",
          enabled: true,
          auth: "gmail_oauth" as const
        };
        const medible = puedeMedir(semilla, cfg.seedInbox);
        log(
          `vuelta #${seq + 1} · ${box} → ${semilla.address} · tema ${conversation.topic}` +
            (decision ? ` · rotación: ${decision.motivo}` : "") +
            (medible ? "" : " · SIN MEDICIÓN (esta semilla no tiene con qué leer dónde cayó)")
        );
        let mailer: WarmupMailer;
        try {
          mailer = createBoxMailer(box, store, key);
        } catch (err) {
          log(`box ${box} sin credencial usable (${err instanceof Error ? err.message : String(err)}) — salto`);
          seq += 1;
          if (once) break;
          await sleep(Math.min(cfg.intervalMs, 60_000));
          continue;
        }
        // Las ops de medición dependen de CÓMO mide esta semilla: por IMAP (cualquier proveedor,
        // el camino del diseño v1) o por la API de Gmail (solo la cuenta del refresh token).
        // Sin capacidad de medir NO se pasan ops: buscar en la cuenta equivocada devolvería "no
        // encontrado" sobre un mensaje que sí llegó, y ese dato falso alimentaría el gate de
        // placement. Mejor enviado-sin-medir que medido-mal.
        let opsMedicion: typeof gmail | null = medible ? gmail : null;
        let cerrarImap: (() => Promise<void>) | null = null;
        let clienteImap: ImapClienteMinimo | null = null;
        if (medible && semilla.auth === "imap_password") {
          try {
            const imap = await opsImapDeSemilla(semilla, key);
            if (imap) {
              opsMedicion = imap.ops as unknown as typeof gmail;
              cerrarImap = imap.cerrar;
              clienteImap = imap.cliente;
            }
          } catch (err) {
            log(`WARN no pude abrir IMAP de ${semilla.address} (${err instanceof Error ? err.message : String(err)}) — la vuelta va sin medición`);
            opsMedicion = null;
          }
        }

        const result = await runLiveCycle({
          cycleId, testId, boxDomain: box, fromAddress: "mailer@" + box, seedInbox: semilla.address,
          conversation, subject, mailer,
          gmail: opsMedicion,
          recorder, sleep,
          pollAttempts: cfg.pollAttempts, pollDelayMs: cfg.pollDelayMs,
          logger: { info: (m) => log(m), warn: (m) => log("WARN " + m) }
        });
        // ── Continuar la conversación: el turno que faltaba ───────────────────────────────────
        //
        // OJO con el hilo que elige: NO el de esta vuelta. El que se acaba de crear tiene la
        // respuesta de hace segundos, y contestar al instante es justamente el patrón que no
        // queremos. Se continúan los hilos de vueltas ANTERIORES de esta misma semilla — a los
        // que ya les pasó el tiempo humano. Reusa la conexión IMAP que ya está abierta.
        if (medible && semilla.auth === "imap_password" && clienteImap) {
          try {
            const abiertos = await hilosParaContinuar(pg, semilla.address, cycleId);
            if (abiertos.length === 0) {
              log("continuación: no hay hilos anteriores de esta semilla todavía");
            }
            for (const hiloPrevio of abiertos) {
              // El turno sale por EL NODO DEL HILO, no por el box de esta vuelta. Reusar el mailer
              // de la vuelta mandaría un correo con `From: mailer@dominio-A` a través del SMTP del
              // dominio B: rompe la alineación SPF/DKIM (que es exactamente lo que estamos
              // construyendo) y encima rebota si ese nodo está frenado.
              if (frenados.has(hiloPrevio.nodeDomain)) {
                log(`hilo ${hiloPrevio.testId.slice(-6)}: su nodo ${hiloPrevio.nodeDomain} no tiene cupo hoy`);
                continue;
              }
              let mailerHilo: WarmupMailer;
              try {
                mailerHilo = createBoxMailer(hiloPrevio.nodeDomain, store, key);
              } catch (err) {
                log(`hilo ${hiloPrevio.testId.slice(-6)}: sin credencial de ${hiloPrevio.nodeDomain} — ${err instanceof Error ? err.message : String(err)}`);
                continue;
              }
              const hilo = await leerHiloWarmup(clienteImap as unknown as ImapLector, hiloPrevio.testId);
              const turnos: TurnoHilo[] = hilo.mensajes
                .filter((m) => m.texto)
                .map((m) => ({
                  quien: m.papel === "recibido" ? ("nosotros" as const) : ("ellos" as const),
                  texto: m.texto!
                }));
              const ultimo = hilo.mensajes.at(-1)?.fecha ?? "";
              const marca = hiloPrevio.testId.slice(-6);
              const decision = tocaResponder({ hiloId: hiloPrevio.cycleId, turnos, ultimoMensajeEn: ultimo });
              if (!decision.si) {
                log(`hilo ${marca}: no toca — ${decision.motivo}`);
                continue;
              }

              const turno = await pedirSiguienteTurno({
                turnos,
                asunto: hiloPrevio.subject,
                baseUrl: (process.env.LOCAL_INFERENCE_BASE_URL ?? "").trim(),
                modelo: (process.env.LOCAL_INFERENCE_MODEL ?? "").trim(),
                maxTokens: 3500
              });
              if (!turno.texto) {
                log(`hilo ${marca}: sin turno nuevo — ${turno.motivo}`);
                continue;
              }

              const asuntoRe = hiloPrevio.subject.startsWith("Re:") ? hiloPrevio.subject : `Re: ${hiloPrevio.subject}`;
              await mailerHilo.send({
                from: `mailer@${hiloPrevio.nodeDomain}`,
                to: semilla.address,
                subject: asuntoRe,
                text: turno.texto,
                testId: hiloPrevio.testId
              });
              await recorder.record({
                cycleId: hiloPrevio.cycleId,
                boxDomain: hiloPrevio.nodeDomain,
                seedInbox: semilla.address,
                kind: "sent",
                subject: asuntoRe,
                testId: hiloPrevio.testId,
                detail: { turno: turnos.length + 1, motivo: turno.motivo, generado: "modelo local" }
              });
              log(`hilo ${marca}: turno ${turnos.length + 1} enviado — "${turno.texto.slice(0, 60)}…"`);
              // Un turno por vuelta. Mandar varios de golpe sería la ráfaga que el daemon evita.
              break;
            }
          } catch (err) {
            // Continuar es un EXTRA: si falla, la vuelta principal ya está hecha y contada.
            log(`WARN no pude continuar hilos: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (cerrarImap) await cerrarImap();
        log(`vuelta #${seq + 1} ${result.completed ? "COMPLETA" : "cortó en " + result.brokeAt} · placement ${result.placement ?? "-"}`);
        seq += 1;
      } else {
        log(`pausa (${action}: ${reason})`);
      }

      if (once) break;
      await sleep(cfg.intervalMs);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLiveWarmupDaemon().catch((err) => {
    console.error("[warmup-live] fatal:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

// re-export para tests/consumidores.
export { classifyPlacement, conversationCount };

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
import { Pool, Client as PgClientDirecto } from "pg";
import { elegirSemilla, semillasMedibles, type SeedBase } from "../domain/seeds.ts";
import { elegirSemillaRotada, progresoDeCalentamiento, type UsoPrevio } from "../domain/rotacion.ts";
import { decidirCupoDeHoy, esInbox, puedeMandarTurno, type DecisionDiaria } from "../domain/decision-diaria.ts";
import {
  boxesSinCupoHoy,
  elegirPool,
  enviosDeHoy,
  historialDeEnvios,
  leerCuposFisicos,
  primerEnvioPorDominio,
  rutaInventario,
  leerSalud,
  VENTANA_PLACEMENT_DIAS,
  placementsDeDominio
} from "./plan-diario.ts";
import { opsDesdeImap, type ImapClienteMinimo } from "../live/imap-placement-ops.ts";
import { leerHiloWarmup, type ImapLector } from "../live/imap-thread-reader.ts";
import { pedirSiguienteTurno, tocaResponder, type TurnoHilo } from "../live/continuar-conversacion.ts";
import { SMTP_POR_PROVEEDOR } from "../domain/seeds.ts";
import { createPgWarmupStores, type PgClient } from "../store/pg-stores.ts";
import { runWarmupMigrations } from "../store/warmup-migrate.ts";
import { pickConversation, conversationCount, makeTestId } from "../live/warmup-content-bank.ts";
import { abrirConversacion } from "../live/continuar-conversacion.ts";
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

/**
 * Pool de respaldo. Se usa SOLO si no hay una medición vigente del cupo de la flota.
 *
 * Una lista fija de dominios es exactamente lo que rompió el warmup: los 6 de acá estaban todos
 * frenados en cap 0, el único con cupo real (`corpfiling-infra.com`) no figuraba, y el daemon
 * pasaba el día rebotando contra nodos muertos sin que nada lo dijera. El pool de verdad sale de
 * `elegirPool()`: los nodos que HOY pueden enviar.
 */
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
  /** Dónde vive la medición del cupo físico de la flota (la persiste `limite-fisico --status`). */
  capFile: string;
  /** Medición de salud de la flota: saca del pool lo que no se puede calentar. */
  saludFile: string;
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
    seedsPath: (env.WARMUP_SEEDS_FILE ?? rutaInventario("warmup-seeds.json")).trim(),
    killFile: (env.WARMUP_LIVE_KILL_FILE ?? resolve(process.cwd(), "runtime/warmup-live.kill")).trim(),
    capFile: (env.WARMUP_CAP_FILE ?? rutaInventario("sender-cap.json")).trim(),
    saludFile: (env.WARMUP_SALUD_FILE ?? rutaInventario("sender-measurement.json")).trim(),
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
  // Mismo criterio que la decisión por dominio: PROMOTIONS cuenta como bandeja (§9). Parchear un
  // contador y dejar el otro con la regla vieja produce dos verdades sobre el mismo dato.
  return placements.filter(esInbox).length / placements.length;
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
       -- DISTINCT ON (test_id), no (cycle_id): el HILO es el test_id. El turno de continuación se
       -- graba con el cycleId de la vuelta actual pero el testId del hilo viejo, así que un ciclo
       -- cuyo envío principal FALLÓ (450 de cupo, 550 de Gmail — el caso normal de esta flota)
       -- dejaba como único 'sent' a la continuación, y el hilo volvía a aparecer como si fuera
       -- nuevo. Verificado contra Postgres real.
       SELECT DISTINCT ON (test_id) cycle_id, test_id, node_domain, subject, occurred_at AS primero
         FROM warmup_activity
        WHERE kind = 'sent'
          AND seed_inbox = $1
          AND cycle_id <> $2
          AND test_id IS NOT NULL
          AND occurred_at > now() - interval '7 days'
        ORDER BY test_id, occurred_at ASC
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
export async function countCyclesToday(pg: PgClient): Promise<number> {
  const { rows } = await pg.query<{ n: string | number }>(
    `SELECT COUNT(DISTINCT cycle_id)::int AS n FROM warmup_activity
      -- Zona EXPLÍCITA: sin ella se trunca en la TZ de la sesión y el "día" del tope no es el
      -- mismo día que el de los contadores por dominio. Dos ventanas distintas para la misma
      -- palabra son dos verdades sobre cuánto se mandó hoy.
      WHERE occurred_at >= date_trunc('day', now(), 'UTC')
        AND kind = 'sent'`
  );
  return Number(rows[0]?.n ?? 0);
}




/**
 * Últimos placements medidos, para el gate GLOBAL del daemon.
 *
 * La ventana temporal es lo que impide que la auto-pausa sea eterna. Sin ella:
 *   un mal día deja las últimas 6 mediciones bajo el piso → el gate pausa → no sale correo →
 *   nadie escribe una medición nueva (el daemon es el ÚNICO escritor de warmup_activity) → esas
 *   mismas 6 filas siguen siendo "las últimas 6" para siempre.
 * Es el mismo estado absorbente que ya se arregló en la decisión por dominio, un piso más arriba.
 */
export async function recentPlacements(pg: PgClient, window: number): Promise<Placement[]> {
  const { rows } = await pg.query<{ placement: string | null }>(
    `SELECT placement FROM warmup_activity
      WHERE kind = 'measured' AND placement IS NOT NULL
        AND occurred_at > now() - interval '${VENTANA_PLACEMENT_DIAS} days'
      ORDER BY occurred_at DESC LIMIT $1`,
    [window]
  );
  return rows
    .map((r) => (r.placement ?? "").toUpperCase())
    .filter((p): p is Placement => p === "INBOX" || p === "SPAM" || p === "PROMOTIONS" || p === "OTHER" || p === "MISSING");
}

// ── Composition root del I/O real ────────────────────────────────────────────────────────────────────

function resolvePool(env: NodeJS.ProcessEnv): Pool {
  const connectionString = env.POSTGRES_URL?.trim();
  // pg-pool emite `error` en clientes OCIOSOS (un socket que el servidor cierra durante una espera
  // larga). Sin listener, EventEmitter LANZA fuera de todo `await`, así que ningún try/catch lo ve y
  // el proceso se muere entero. Es el caso normal: Postgres se reinicia mientras el daemon duerme
  // sus 4 horas. Con listener, pg-pool descarta ese cliente y la próxima consulta abre uno nuevo.
  const pool = new Pool({
    ...(connectionString ? { connectionString } : {}),
    application_name: "delivrix-warmup-live-daemon"
  });
  // console.log y NO el `log` del daemon: ése se declara dentro de `startLiveWarmupDaemon` y acá no
  // está en scope. Usarlo tiraba ReferenceError justo en el momento en que este listener tiene que
  // salvar al proceso — peor que no tenerlo.
  pool.on("error", (e) => console.log(`[warmup-live] WARN cliente pg ocioso descartado: ${e.message} — sigo`));
  return pool;
}

/** Recorder que persiste en warmup_activity (mismo shape que la migración 003). */
/**
 * Persiste los eventos del ciclo. NO LANZA — y eso arregla tres cosas de una:
 *
 *  1. El daemon se moría por un hipo de Postgres. `runLiveCycle` documenta "nunca lanza", pero la
 *     excepción salía de acá, atravesaba el ciclo entero y terminaba el proceso.
 *  2. Peor: `warmup-live-cycle.ts` envolvía el envío en try/catch, así que un fallo al GRABAR se
 *     reportaba como fallo al ENVIAR — se fabricaba una fila `kind:'error', stage:'sent'` sobre un
 *     correo que el nodo sí había entregado. El registro mentía en la dirección más confusa.
 *  3. El bloque de continuación logueaba "no pude continuar hilos" sobre un turno ya enviado.
 *
 * Un correo REAL que sale y no queda registrado es grave, así que se grita fuerte y con todos los
 * datos para poder reconstruirlo a mano. Pero abortar no lo des-envía: solo agrega un daemon caído.
 */
function createPgRecorder(pg: PgClient): ActivityRecorder {
  return {
    async record(e: ActivityEvent): Promise<void> {
      try {
        await pg.query(
          "INSERT INTO warmup_activity (cycle_id, node_domain, seed_inbox, kind, placement, subject, detail, test_id)" +
            " VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [e.cycleId, e.boxDomain, e.seedInbox, e.kind, e.placement ?? null, e.subject ?? null, JSON.stringify(e.detail ?? {}), e.testId ?? null]
        );
      } catch (err) {
        const que = e.kind === "sent" ? "CORREO ENVIADO SIN REGISTRAR" : `evento '${e.kind}' sin registrar`;
        console.log(
          `[warmup-live] ERROR ${que} — ${e.boxDomain} → ${e.seedInbox}` +
            ` · testId ${e.testId ?? "-"} · ciclo ${e.cycleId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
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
        headers: { "X-Delivrix-Test-Id": input.testId },
        // Enhebrado real. Un "Re:" sin estas cabeceras es un primer contacto disfrazado de
        // respuesta, que es una heurística de spam vieja y conocida — y se la estábamos aplicando
        // justo al correo que existe para construir reputación.
        ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
        ...(input.references ? { references: input.references } : {})
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
  /**
   * COSTURA DE INYECCIÓN. Sin esto el daemon no tenía por dónde testearse: creaba su propio Pool,
   * sus mailers y su cliente IMAP adentro, así que cualquier test tocaba Postgres, SMTP y el modelo
   * local de verdad. Por eso el cuerpo del loop —donde vive el correo real— nunca tuvo un test.
   *
   * Solo se usa en tests: en producción todo esto queda `undefined` y el daemon arma lo real.
   */
  dobles?: {
    pg?: PgClient & { end(): Promise<void> };
    mailerDe?: (dominio: string) => WarmupMailer;
    /** Migraciones: en test no hay esquema que migrar. */
    saltearMigraciones?: boolean;
  };
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
  const dobles = opts.dobles ?? {};

  if (!cfg.enabled) {
    log("INERTE — WARMUP_LIVE_ENABLE!=true. Cero correo. (Prendé el flag para calentar autónomo.)");
    return;
  }

  const pool = (dobles.pg as unknown as Pool | undefined) ?? resolvePool(env);
  const pg = pool as unknown as PgClient;
  const stores = createPgWarmupStores(pg);
  void stores; // reservado para futuras métricas; el daemon usa lecturas directas + recorder

  // Asegura la tabla de actividad (idempotente).
  if (!dobles.saltearMigraciones) await runWarmupMigrations(pg);

  // UN SOLO DAEMON. Hay dos lanzadores que no se ven entre sí (uno usa nohup+pgrep, el otro screen
  // +pidfile), así que arrancar por el segundo con el primero vivo dejaba DOS daemons: el tope
  // diario, el kill-file y el cupo por dominio se evalúan por separado en cada uno, o sea que todas
  // las barreras se duplican y sale el doble de correo.
  //
  // El lock es de la BASE, que es lo único que los dos ven, y se libera solo al cerrar la SESIÓN.
  //
  // Por eso NO puede tomarse sobre el pool: `pool.query()` presta un cliente, corre y lo devuelve;
  // pg-pool cierra los clientes ociosos a los 10 s (idleTimeoutMillis por defecto) y al cerrarse
  // esa conexión el lock se evapora. Como el daemon duerme minutos entre vueltas, el lock duraba
  // ~10 s y después NO protegía nada. Va sobre un cliente DEDICADO que vive lo que vive el daemon.
  //
  // Con dobles inyectados (tests) NO se abre una conexión propia: hacerlo iba contra la Postgres
  // REAL, encontraba el lock del daemon de verdad y hacía fallar tests que no hablan de locks.
  // Un test que toca la base de producción no está probando lo que dice probar.
  const conDobles = Boolean(dobles.pg);
  const lockClient = conDobles
    ? null
    : new PgClientDirecto(
        (env.POSTGRES_URL?.trim() ? { connectionString: env.POSTGRES_URL.trim() } : {}) as never
      );
  let lockVivo = false;
  const tomarLock = async (): Promise<boolean> => {
    const consulta = lockClient ?? pg;
    const { rows } = await consulta.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
      ["delivrix-warmup-live"]
    );
    return rows[0]?.ok !== false;
  };
  try {
    await lockClient?.connect();
    // Un error del socket deja la sesión (y el lock) muerta sin que nadie se entere: el daemon
    // seguiría enviando creyéndose único. Se marca y la revalidación de la próxima vuelta frena.
    lockClient?.on("error", (e: Error) => {
      lockVivo = false;
      console.log(`[warmup-live] WARN se cayó la conexión del lock: ${e.message}`);
    });
    if (!(await tomarLock())) {
      log("ya hay otro daemon LIVE corriendo (lock de la base) — salgo para no duplicar las barreras");
      await lockClient?.end().catch(() => {});
      await pool.end();
      return;
    }
    lockVivo = true;
  } catch (err) {
    // FAIL-CLOSED, al revés que antes. El comentario viejo decía que perder el warmup era peor que
    // el riesgo del lock; los hechos dicen lo contrario: pausar no cuesta reputación (solo deja de
    // avanzar) y duplicar el volumen puede cruzar el umbral de "bulk sender" de Gmail, que es
    // PERMANENTE. Ante la duda, no enviar. Además, sin base el daemon no puede trabajar igual.
    log(`FATAL no pude tomar el lock de instancia (${err instanceof Error ? err.message : String(err)}) — salgo`);
    await lockClient?.end().catch(() => {});
    await pool.end();
    return;
  }

  // Credenciales SMTP del inventario (archivo) + clave.
  const inventoryPath = (env.WARMUP_SMTP_INVENTORY ?? rutaInventario("smtp-credentials.json")).trim();
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
  // El pool sale de la MEDICIÓN, no de una lista escrita a mano. Con la lista fija el daemon pasó
  // el día rebotando contra 6 nodos frenados en cap 0 mientras el único con cupo real ni figuraba.
  // El pool CONFIGURADO se preserva: es el respaldo, y pisarlo con el pool elegido lo perdía para
  // siempre. Se recalcula en cada vuelta (más abajo) porque el cupo de la flota cambia: si ops
  // corre `limite-fisico` a media semana y libera otros nodos, un pool congelado al arrancar deja
  // al daemon girando días sin calentar nada — mientras `/v1/warmup/plan` ya muestra los nuevos.
  const poolConfigurado = [...cfg.boxes];
  let poolAnterior = "";
  log(`ARRANCA — intervalo ${Math.round(cfg.intervalMs / 60000)}min, piso placement ${(cfg.placementFloor * 100).toFixed(0)}%, seed ${cfg.seedInbox} (el pool se decide en cada vuelta)`);

  try {
    for (;;) {
      // UNA VUELTA FALLIDA NO MATA EL DAEMON. Sin este try, cualquier excepción —un hipo de
      // Postgres, un IMAP que corta, un JSON corrupto— terminaba el proceso 24/7 para siempre y
      // ningún lanzador lo levantaba. El correo dejaba de salir sin que nadie se enterara.
      //
      // `cerrarImap` se iza acá porque el `finally` lo necesita en scope: los `continue` de más
      // abajo saltaban por encima del cierre y dejaban conexiones IMAP colgadas cada vuelta.
      let cerrarImap: (() => Promise<void>) | null = null;
      try {
      // REVALIDACIÓN DEL LOCK, ANTES DE DECIDIR NADA. Tomarlo al arrancar no alcanza: si la sesión
      // se cayó (red, reinicio de Postgres, sleep de la Mac), el lock ya no existe y otro daemon
      // pudo tomarlo. Un daemon que perdió el lock DEBE callarse, no seguir enviando.
      if (!lockVivo || !(await tomarLock().catch(() => false))) {
        log("perdí el lock de instancia (otro daemon lo tiene o se cayó la sesión) — salgo");
        break;
      }
      lockVivo = true;

      const killed = existsSync(cfg.killFile);
      const cyclesToday = await countCyclesToday(pg);
      const placements = await recentPlacements(pg, cfg.placementWindow);
      const { action, reason } = decideDaemonAction({
        enabled: cfg.enabled, killed, cyclesToday, maxPerDay: cfg.maxPerDay, recentPlacements: placements, placementFloor: cfg.placementFloor
      });

      if (action === "send") {
        // El pool se recalcula acá, no al arrancar: la medición del cupo se relee en cada vuelta y
        // el pool tiene que seguirla. Solo se loguea cuando CAMBIA, para no repetir la misma línea
        // cada vuelta durante días.
        const capsFisicos = await leerCuposFisicos(cfg.capFile);
        // La salud saca del pool lo que no se puede calentar: cruzado el umbral, cerrado por el
        // receptor, o con la cola atascada. Tener cupo no es lo mismo que valer la pena.
        const saludFlota = await leerSalud(cfg.saludFile);
        const poolElegido = elegirPool(capsFisicos, poolConfigurado, saludFlota);
        if (poolElegido.boxes.join(",") !== poolAnterior) {
          poolAnterior = poolElegido.boxes.join(",");
          log(`pool: ${poolElegido.motivo}${poolElegido.boxes.length > 0 ? ` → ${poolElegido.boxes.join(", ")}` : ""}`);
        }
        if (poolElegido.boxes.length === 0) {
          // ESPERA, no `return`. Salir mataba el proceso sin supervisor que lo levante, y el caso
          // que lo dispara es transitorio: alguien frenó la flota entera y la va a soltar. El
          // daemon tiene que seguir vivo para enterarse.
          log("nada que calentar: ningún nodo con cupo. Espero la próxima medición.");
          if (once) break;
          await sleep(cfg.intervalMs);
          continue;
        }

        // ── EL ESTADO DEL DÍA ────────────────────────────────────────────────────────────────
        //
        // Las tres lecturas van juntas y un fallo ABORTA LA VUELTA. Antes cada una tenía su
        // `.catch` devolviendo un valor vacío, y eso es fail-OPEN sobre el volumen:
        //
        //   · boxesSinCupoHoy falla → Set vacío → ningún box aparece frenado → se le manda a un
        //     nodo que hoy ya rebotó.
        //   · enviosDeHoy falla     → Map vacío → "van 0" para TODOS los dominios → el cupo diario
        //     deja de existir y se manda hasta el tope global.
        //   · historialDeEnvios falla → sin historial → día 0 → arranca de nuevo la rampa.
        //
        // Los tres convierten un error de lectura en permiso de enviar, que es exactamente lo que
        // el comentario del bloque de continuación decía que NO podía pasar. Un error de lectura
        // solo puede terminar en "no mando", nunca en "mando lo que pueda".
        //
        // El disparador real no es "postgres caído" (eso revienta antes, en countCyclesToday):
        // es un fallo POR CONSULTA — un ECONNRESET de una conexión del pool, un statement_timeout,
        // o un cambio de esquema que rompe una sola query. Ese último es silencioso y permanente.
        let frenados: ReadonlySet<string>;
        let enviadosPorDominio: Map<string, number>;
        let historial: UsoPrevio[];
        // El día de rampa sale del PRIMER ENVÍO REAL, no del historial recortado a 400 filas: ese
        // recorte hace que el día dependa del volumen de TODA la flota, y que RETROCEDA cuando
        // otros dominios mandan más.
        let primerEnvio: Map<string, string>;
        try {
          [frenados, enviadosPorDominio, historial, primerEnvio] = await Promise.all([
            boxesSinCupoHoy(pg),
            enviosDeHoy(pg),
            historialDeEnvios(pg),
            primerEnvioPorDominio(pg)
          ]);
        } catch (err) {
          log(`no pude leer el estado del día (${err instanceof Error ? err.message : String(err)}) — NO mando esta vuelta`);
          if (once) break;
          await sleep(cfg.intervalMs);
          continue;
        }

        const disponibles = poolElegido.boxes.filter((b) => !frenados.has(b));
        if (disponibles.length === 0) {
          log(`PAUSA — los ${poolElegido.boxes.length} boxes del pool ya agotaron su cupo diario. Nada que enviar hoy.`);
          if (once) break;
          await sleep(cfg.intervalMs);
          continue;
        }
        // Solo los del POOL: listar dominios que ni siquiera se están calentando es ruido que
        // hace parecer que el daemon intentó algo con ellos.
        const salteados = poolElegido.boxes.filter((b) => frenados.has(b));
        if (salteados.length > 0) {
          log(`${salteados.length} box(es) sin cupo hoy, salteados: ${salteados.join(", ")}`);
        }
        const box = pickBox(disponibles, seq);

        // ── La decisión del día para ESTE dominio ─────────────────────────────────────────────
        // Antes el tope era un número fijo e igual para todos (3/día, siempre). Eso no es un
        // warmup profesional, es un temporizador. Acá el volumen sale de la evidencia de este
        // dominio: qué día de rampa lleva y cómo viene su placement. Sube si puede, baja si debe,
        // frena si hace falta — y todo queda dicho en el log.
        // ISO weekday del receptor: 1 = lunes … 7 = domingo. `getUTCDay()` da 0 = domingo.
        const isoWeekday = (((new Date().getUTCDay() + 6) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
        // El placement TAMBIÉN aborta si falla, y por la razón más fina de las cuatro: con `[]`
        // la tasa queda `null`, que la decisión lee como "sin muestra" y responde "sostener 2" —
        // cuando el estado real podía ser "frenar 0". Un error de lectura no puede transformar un
        // dominio frenado en uno que manda.
        let delDia: DecisionDiaria;
        try {
          delDia = decidirCupoDeHoy({
            diaN:
              progresoDeCalentamiento(
                primerEnvio.has(box)
                  ? [{ domain: box, seed: "", cuando: primerEnvio.get(box)! }, ...historial.filter((h) => h.domain === box)]
                  : historial,
                box,
                null
              )?.diasCorridos ?? 0,
            placements: await placementsDeDominio(pg, box, cfg.placementWindow),
            cupoFisico: capsFisicos.vencida ? null : capsFisicos.porDominio.get(box) ?? null,
            isoWeekday
          });
        } catch (err) {
          log(`no pude leer el placement de ${box} (${err instanceof Error ? err.message : String(err)}) — NO mando esta vuelta`);
          if (once) break;
          await sleep(cfg.intervalMs);
          continue;
        }
        const enviadosHoyBox = enviadosPorDominio.get(box) ?? 0;
        log(`${box}: ${delDia.accion} · cupo ${delDia.cupo}/día (van ${enviadosHoyBox}) — ${delDia.motivo}`);
        if (enviadosHoyBox >= delDia.cupo) {
          seq += 1;
          if (once) break;
          // Si NINGÚN box del pool tiene cupo, se duerme el intervalo entero. Antes eran 60s
          // siempre: con el cupo por dominio (2) menor que el tope de vueltas (3) —el caso normal
          // del arranque de la rampa— el daemon giraba ~1400 veces al día haciendo consultas y
          // enterrando los WARN reales bajo miles de líneas de log.
          // El cupo de ESTE box no dice nada de los otros. Con `a.com` frenado (cupo 0) y `b.com`
          // sano con 35 de margen, la comparación `5 < 0` daba false y el daemon dormía 4 HORAS
          // con la flota libre. Acá solo se pregunta si queda otro candidato al que intentarle; su
          // cupo lo decide su propia vuelta.
          const quedaAlguno = disponibles.some((b) => b !== box && !frenados.has(b));
          log(`${box} ya cumplió su cupo de hoy — se salta${quedaAlguno ? "" : " (ningún box con cupo: espero el intervalo)"}`);
          await sleep(quedaAlguno ? Math.min(cfg.intervalMs, 60_000) : cfg.intervalMs);
          continue;
        }
        // La conversación la escribe el MODELO. El banco de 14 textos fijos repartidos entre 58
        // dominios era, literalmente, la huella que el warmup existe para no dejar: un receptor que
        // mira varios de nuestros dominios ve el mismo texto palabra por palabra. Queda como
        // respaldo —si el modelo no está, mejor mandar algo conocido que no mandar— y se registra
        // cuál de los dos se usó, porque un texto generado y uno enlatado no valen lo mismo.
        const enlatada = pickConversation(seq);
        const generada = await abrirConversacion({
          baseUrl: (env.LOCAL_INFERENCE_BASE_URL ?? "").trim(),
          modelo: (env.LOCAL_INFERENCE_MODEL ?? "").trim(),
          semilla: `${box}-${seq}`
        }).catch(() => null);
        const conversation = generada
          ? { topic: "generado", subject: generada.asunto, body: generada.cuerpo, reply: enlatada.reply }
          : enlatada;
        const origenTexto: "modelo" | "banco" = generada ? "modelo" : "banco";
        if (!generada) log("conversación del banco: el modelo local no pudo escribir una nueva");
        const stamp = `${Date.now()}-${seq}`;
        const testId = makeTestId(stamp);
        const cycleId = "cyc-" + stamp;
        const subject = `${conversation.subject} [${testId.slice(-6)}]`;
        // ROTACIÓN sobre el historial REAL: no repite el par (dominio, semilla) mientras haya
        // alternativa, reparte entre proveedores y desempata por la menos usada. Un hash de
        // (dominio, vuelta) dejaba siempre la misma coreografía, que es la huella a evitar.
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
          mailer = dobles.mailerDe ? dobles.mailerDe(box) : createBoxMailer(box, store, key);
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

        // EL ENVÍO QUE ACABA DE SALIR GASTÓ CUPO, y el Map se leyó ANTES. Sin esta línea, la
        // continuación de más abajo decide con la cuenta vieja y manda uno de más: con cupo 2
        // salían 3, todos los días. Es exactamente el sobrepaso que `puedeMandarTurno` se escribió
        // para cerrar — el guarda se movió a una función testeada, pero el DATO que le entraba
        // seguía siendo la foto anterior al envío.
        //
        // `brokeAt === "sent"` es el único retorno donde `mailer.send` falló; en todos los demás
        // caminos el envío salió y quedó grabado.
        if (result.brokeAt !== "sent") {
          enviadosPorDominio.set(box, enviadosHoyBox + 1);
        }

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
              const marca = hiloPrevio.testId.slice(-6);
              // El guarda vive en `puedeMandarTurno` (decision-diaria.ts) y está testeado ahí.
              // Inline y sin test fue exactamente donde se coló el agujero: la continuación
              // mandaba correo real esquivando la decisión del día.
              //
              // Sin `.catch` permisivo: si no se puede leer el estado del dominio, NO se manda. Un
              // error de lectura jamás se convierte en permiso de enviar.
              let cupoDelHilo: DecisionDiaria;
              try {
                cupoDelHilo = decidirCupoDeHoy({
                  diaN:
                    progresoDeCalentamiento(
                      primerEnvio.has(hiloPrevio.nodeDomain)
                        ? [{ domain: hiloPrevio.nodeDomain, seed: "", cuando: primerEnvio.get(hiloPrevio.nodeDomain)! }, ...historial.filter((h) => h.domain === hiloPrevio.nodeDomain)]
                        : historial,
                      hiloPrevio.nodeDomain,
                      null
                    )?.diasCorridos ?? 0,
                  placements: await placementsDeDominio(pg, hiloPrevio.nodeDomain, cfg.placementWindow),
                  cupoFisico: capsFisicos.vencida ? null : capsFisicos.porDominio.get(hiloPrevio.nodeDomain) ?? null,
                  isoWeekday
                });
              } catch (err) {
                log(`hilo ${marca}: no pude leer el estado de ${hiloPrevio.nodeDomain}, no mando — ${err instanceof Error ? err.message : String(err)}`);
                continue;
              }
              const permiso = puedeMandarTurno({
                dominio: hiloPrevio.nodeDomain,
                rebotadosHoy: frenados,
                decision: cupoDelHilo,
                enviadosHoy: enviadosPorDominio.get(hiloPrevio.nodeDomain) ?? 0
              });
              if (!permiso.si) {
                log(`hilo ${marca}: no toca — ${permiso.motivo}`);
                continue;
              }

              // El turno sale por EL NODO DEL HILO, no por el box de esta vuelta: `From:` de un
              // dominio con el SMTP de otro rompe la alineación SPF/DKIM, que es justo lo que
              // estamos construyendo.
              let mailerHilo: WarmupMailer;
              try {
                mailerHilo = dobles.mailerDe ? dobles.mailerDe(hiloPrevio.nodeDomain) : createBoxMailer(hiloPrevio.nodeDomain, store, key);
              } catch (err) {
                log(`hilo ${marca}: sin credencial de ${hiloPrevio.nodeDomain} — ${err instanceof Error ? err.message : String(err)}`);
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
              const decision = tocaResponder({ hiloId: hiloPrevio.cycleId, turnos, ultimoMensajeEn: ultimo });
              if (!decision.si) {
                log(`hilo ${marca}: no toca — ${decision.motivo}`);
                continue;
              }

              const turno = await pedirSiguienteTurno({
                turnos,
                asunto: hiloPrevio.subject,
                baseUrl: (env.LOCAL_INFERENCE_BASE_URL ?? "").trim(),
                modelo: (env.LOCAL_INFERENCE_MODEL ?? "").trim(),
                maxTokens: 3500
              });
              if (!turno.texto) {
                log(`hilo ${marca}: sin turno nuevo — ${turno.motivo}`);
                continue;
              }

              const asuntoRe = hiloPrevio.subject.startsWith("Re:") ? hiloPrevio.subject : `Re: ${hiloPrevio.subject}`;
              // Se enhebra contra el ÚLTIMO mensaje del hilo, y `references` lleva la cadena
              // entera: así lo agrupan los clientes de correo y así lo verifica el receptor.
              const idsDelHilo = hilo.mensajes.map((m) => m.messageId).filter((x): x is string => Boolean(x));
              const ultimoId = idsDelHilo.at(-1);
              if (!ultimoId) {
                // Sin Message-ID no se puede enhebrar, y mandar un "Re:" huérfano es peor que no
                // mandar: se ve como respuesta falsa justo en el correo que construye reputación.
                log(`hilo ${marca}: no pude leer el Message-ID del hilo — no mando un "Re:" huérfano`);
                continue;
              }
              // El envío va con su propio try: sin él, un 450 de cupo agotado subía al catch
              // externo como un WARN genérico y NUNCA se grababa la fila `kind:'error'` que
              // `boxesSinCupoHoy` necesita para saltear ese nodo el resto del día. El nodo seguía
              // recibiendo intentos que ya sabíamos que iban a rebotar.
              try {
              await mailerHilo.send({
                from: `mailer@${hiloPrevio.nodeDomain}`,
                inReplyTo: ultimoId,
                references: idsDelHilo.join(" "),
                to: semilla.address,
                subject: asuntoRe,
                text: turno.texto,
                testId: hiloPrevio.testId
              });
              await recorder.record({
                // El cycleId es el de ESTA vuelta, no el del hilo viejo. Con el viejo, el conteo
                // del tope diario (COUNT DISTINCT cycle_id) fallaba en las DOS direcciones: un
                // hilo del mismo día no gastaba presupuesto (salía correo real gratis), y uno de
                // un día anterior contaba como una vuelta entera (tres continuaciones agotaban el
                // día sin arrancar una sola conversación). El hilo se sigue juntando por testId,
                // que es lo que usa el lector IMAP.
                cycleId,
                boxDomain: hiloPrevio.nodeDomain,
                seedInbox: semilla.address,
                kind: "sent",
                subject: asuntoRe,
                testId: hiloPrevio.testId,
                detail: { turno: turnos.length + 1, motivo: turno.motivo, generado: "modelo local" }
              });
              } catch (err) {
                const nota = err instanceof Error ? err.message : String(err);
                await recorder.record({
                  cycleId,
                  boxDomain: hiloPrevio.nodeDomain,
                  seedInbox: semilla.address,
                  kind: "error",
                  subject: asuntoRe,
                  testId: hiloPrevio.testId,
                  detail: { stage: "sent", note: nota, origen: "continuación de hilo" }
                });
                log(`hilo ${marca}: el turno rebotó — ${nota.slice(0, 120)}`);
                break;
              }
              log(`hilo ${marca}: turno ${turnos.length + 1} enviado — "${turno.texto.slice(0, 60)}…"`);
              // Un turno por vuelta. Mandar varios de golpe sería la ráfaga que el daemon evita.
              break;
            }
          } catch (err) {
            // Continuar es un EXTRA: si falla, la vuelta principal ya está hecha y contada.
            log(`WARN no pude continuar hilos: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Se reporta lo MEDIDO, y aparte lo que hizo la señal. Antes se logueaba solo el valor
        // post-señal, así que un correo que cayó en SPAM y que nosotros movimos a INBOX aparecía
        // como "placement INBOX" — la lectura opuesta a la verdad en la línea que más se mira.
        const medido = result.placementMedido ?? result.placement;
        const movido = result.placementMedido && result.placement && result.placementMedido !== result.placement;
        log(
          `vuelta #${seq + 1} ${result.completed ? "COMPLETA" : "cortó en " + result.brokeAt}` +
            ` · cayó en ${medido ?? "-"}${movido ? ` → lo movimos a ${result.placement}` : ""}`
        );
        seq += 1;
      } else {
        log(`pausa (${action}: ${reason})`);
      }

      } catch (err) {
        log(`WARN vuelta fallida, sigo: ${err instanceof Error ? err.message : String(err)}`);
        if (once) break;
        // INTERVALO COMPLETO, nunca un reintento rápido. Con Postgres aceptando lecturas y
        // rechazando escrituras (disco lleno, failover parcial), el correo SALE y la fila `sent` no
        // se escribe: el contador del día no avanza y reintentar cada minuto convertiría un
        // parpadeo en cientos de envíos. Una barrera degradada no puede enviar más rápido que la sana.
        await sleep(cfg.intervalMs);
        continue;
      } finally {
        // El cierre del IMAP vive acá y no en el camino feliz: antes, cualquier `continue` del
        // cuerpo se lo saltaba y la conexión quedaba abierta hasta que el proveedor la cortara.
        if (cerrarImap) {
          try {
            await cerrarImap();
          } catch {
            // Cerrar es best-effort: si ya se cayó, insistir no aporta.
          }
        }
      }

      if (once) break;
      await sleep(cfg.intervalMs);
    }
  } finally {
    // El cliente del lock vive fuera del pool, así que hay que cerrarlo aparte o el proceso no
    // termina nunca (una conexión abierta mantiene vivo el event loop).
    await lockClient?.end().catch(() => {});
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

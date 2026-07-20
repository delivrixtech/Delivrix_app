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
import { createPgWarmupStores, type PgClient } from "../store/pg-stores.ts";
import { runWarmupMigrations } from "../store/warmup-migrate.ts";
import { pickConversation, conversationCount, makeTestId } from "../live/warmup-content-bank.ts";
import { createGoogleOAuthTokenProvider, type AccessTokenProvider } from "../live/google-oauth-token-provider.ts";
import { resolveCredentialKey, findAndDecryptBox, type InventoryCredentialStore } from "../live/smtp-credential-decrypt.ts";
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
    seedInbox: (env.WARMUP_GMAIL_SEED_USER ?? "infradelivrixdemo@gmail.com").trim(),
    killFile: (env.WARMUP_LIVE_KILL_FILE ?? resolve(process.cwd(), "runtime/warmup-live.kill")).trim(),
    // Ventana de medición amplia: Gmail puede tardar >60s en indexar el mensaje recién enviado.
    // 30 intentos × 6s = ~3min inline. (Mejora futura: medir en un pase posterior, no bloqueante.)
    pollAttempts: intEnv(env.WARMUP_LIVE_POLL_ATTEMPTS, 30, 1),
    pollDelayMs: intEnv(env.WARMUP_LIVE_POLL_DELAY_MS, 6000, 100)
  };
}

// ── Decisión de gate (pura, testeable) ──────────────────────────────────────────────────────────────

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

/** Cuántas vueltas (cycle_id distintos) hubo hoy (UTC). */
async function countCyclesToday(pg: PgClient): Promise<number> {
  const { rows } = await pg.query<{ n: string | number }>(
    "SELECT COUNT(DISTINCT cycle_id)::int AS n FROM warmup_activity WHERE occurred_at >= date_trunc('day', now())"
  );
  return Number(rows[0]?.n ?? 0);
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
        const box = pickBox(cfg.boxes, seq);
        const conversation = pickConversation(seq);
        const stamp = `${Date.now()}-${seq}`;
        const testId = makeTestId(stamp);
        const cycleId = "cyc-" + stamp;
        const subject = `${conversation.subject} [${testId.slice(-6)}]`;
        log(`vuelta #${seq + 1} · ${box} → ${cfg.seedInbox} · tema ${conversation.topic}`);
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
        const result = await runLiveCycle({
          cycleId, testId, boxDomain: box, fromAddress: "mailer@" + box, seedInbox: cfg.seedInbox,
          conversation, subject, mailer, gmail, recorder, sleep,
          pollAttempts: cfg.pollAttempts, pollDelayMs: cfg.pollDelayMs,
          logger: { info: (m) => log(m), warn: (m) => log("WARN " + m) }
        });
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

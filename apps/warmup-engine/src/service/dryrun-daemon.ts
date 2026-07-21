// COMPOSITION ROOT — DRY-RUN del warmup-engine (DEPLOYMENT WIRING, no lógica de dominio).
//
// Qué hace: compone las deps REALES del tick (Postgres via pg.Pool) con un transporte y un cliente
// IMAP INOFENSIVOS, y corre el daemon. El objetivo de este entrypoint es PROBAR que el engine compone,
// migra, y TICKEA — enviando CERO correo real. No fabrica secretos, no abre SMTP, no abre IMAP.
//
// SEGURIDAD (no negociable, ver runtime/config.ts y runtime/transport.ts):
//   - Transporte = MockTransport SIEMPRE. Además se ASERTA que WARMUP_TRANSPORT no sea "postfix":
//     si alguien pidió transporte real, este entry se NIEGA a arrancar (fail-closed). Cero red de envío.
//   - ImapClient = no-op que devuelve [] (ninguna lectura de placement abre un socket IMAP). readPlacement
//     interpreta "no encontrado" como pendiente/missing según el grace window — nunca inventa ni conecta.
//   - runWarmupTick sigue exigiendo WARMUP_ENGINE_ENABLE=true (assertWarmupEngineEnabled); el daemon
//     (startWarmupDaemon) es INERTE si el flag está off. Dry-run = WARMUP_ENGINE_ENABLE=true + mock.
//
// AUTH-GATE EN DRY-RUN (razonamiento): los nodos recién onboardeados nacen state='blocked'/auth_ready=false
// (§8 fail-closed). listActiveNodes EXCLUYE 'blocked', así que en el primer dry-run el tick planifica 0
// envíos: es honesto y esperado. Los chequeos de auth read-only (DNS/PTR) son seguros, pero SMTP_AUTH/
// IMAP_AUTH necesitan credenciales y viven en live/compose.ts (que NO se cablea aquí). Promover un nodo a
// 'fresh' requiere ese contrato de auth verificado con secretos reales — trabajo posterior, no este entry.
//
// Este archivo es WIRING de deployment: NO modifica domain/scheduler/service. Sólo los compone.

import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import {
  warmupTransportKind,
  warmupGmailOAuthEnabled,
  readWarmupGmailSeedConfig,
  type WarmupEnv
} from "../runtime/config.ts";
import { MockTransport } from "../runtime/transport.ts";
import type { ImapClient } from "../reader/imap-placement-reader.ts";
import {
  createGoogleOAuthTokenProvider,
  loadGoogleOAuthConfig
} from "../live/google-oauth-token-provider.ts";
import { createGmailOAuthImapClient } from "../live/mail-adapters.ts";
import { verifyGmailRead } from "./verify-gmail-read.ts";
import type { WarmupNode } from "../domain/types.ts";
import { createPgWarmupStores, type PgClient } from "../store/pg-stores.ts";
import { runWarmupMigrations } from "../store/warmup-migrate.ts";
import type { WarmupStores } from "../store/ports.ts";
import { runWarmupTick, type WarmupTickDeps, type WarmupTickResult } from "./service.ts";
import { startWarmupDaemon } from "./main.ts";

/** Intervalo por defecto entre ticks del daemon (60s). Override: WARMUP_DRYRUN_INTERVAL_MS. */
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Cliente IMAP INOFENSIVO para dry-run: nunca abre un socket, siempre devuelve []. Con esto,
 * reconcilePlacement corre su lógica (leer tests pendientes, clasificar, rollup/FSM) pero toda lectura
 * de seed resuelve a "no encontrado" ⇒ pendiente o missing según el grace window. Cero I/O de red.
 */
export const noopImapClient: ImapClient = {
  async search() {
    return [];
  }
};

/** Logger mínimo del selector de IMAP (info/warn). Inyectable ⇒ tests silenciosos y aseverables. */
export interface DryRunImapLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const defaultDryRunImapLogger: DryRunImapLogger = {
  info: (m) => console.log(`[warmup-dryrun] ${m}`),
  warn: (m) => console.warn(`[warmup-dryrun] ${m}`)
};

/** Seams inyectables del selector de IMAP (para testear el gating sin tocar red ni el config real). */
export interface ResolveImapDeps {
  logger?: DryRunImapLogger;
  /**
   * Construye el ImapClient OAuth real: valida el OAuth config (fail-closed) y arma el cliente XOAUTH2.
   * Inyectable en tests (para simular config OK ⇒ cliente, o config inválida ⇒ throw).
   */
  buildOAuthImapClient?: (env: WarmupEnv) => Promise<ImapClient>;
}

/**
 * Construye el ImapClient OAuth REAL para leer el seed inbox: valida el OAuth config de forma temprana
 * (fail-closed; lanza si falta/está mal SIN exponer valores) y arma el cliente XOAUTH2 (el access token
 * se mintea perezosamente en el primer `search`, nunca aquí). Cero envío de correo.
 */
async function buildRealOAuthImapClient(env: WarmupEnv): Promise<ImapClient> {
  const seed = readWarmupGmailSeedConfig(env);
  // Validación temprana del config: si falta o está inválido, esto lanza (fail-closed) antes de cablear.
  await loadGoogleOAuthConfig(seed.configPath);
  const tokenProvider = createGoogleOAuthTokenProvider(
    seed.configPath ? { configPath: seed.configPath } : {}
  );
  return createGmailOAuthImapClient(tokenProvider, { host: seed.host, user: seed.user });
}

/**
 * Selecciona el ImapClient del dry-run según WARMUP_GMAIL_OAUTH_ENABLE (default OFF).
 *   - Flag OFF ⇒ noopImapClient (no se lee ningún seed real; cero I/O IMAP).
 *   - Flag ON + config OK ⇒ cliente OAuth XOAUTH2 real (LECTURA del seed inbox; el ENVÍO sigue mock).
 *   - Flag ON + config ausente/inválida ⇒ log claro (SIN secretos) + fallback al no-op. NUNCA crashea
 *     el daemon (fail-closed a "no leer" en vez de a "romper").
 *
 * IMPORTANTE: esto SOLO decide la LECTURA. El transporte de ENVÍO es MockTransport SIEMPRE en dry-run
 * (ver createDryRunTransport); este selector no lo toca.
 */
export async function resolveDryRunImapClient(
  env: WarmupEnv = process.env,
  deps: ResolveImapDeps = {}
): Promise<ImapClient> {
  if (!warmupGmailOAuthEnabled(env)) {
    return noopImapClient;
  }
  const logger = deps.logger ?? defaultDryRunImapLogger;
  const build = deps.buildOAuthImapClient ?? buildRealOAuthImapClient;
  try {
    const client = await build(env);
    logger.info(
      "WARMUP_GMAIL_OAUTH_ENABLE=on ⇒ LECTURA real del seed inbox por OAuth (XOAUTH2). " +
        "El ENVÍO sigue MockTransport (cero correo real)."
    );
    return client;
  } catch (err) {
    // El .message de nuestros errores lleva un CÓDIGO snake_case (+ a lo sumo el path), nunca secretos.
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      `WARMUP_GMAIL_OAUTH_ENABLE=on pero no se pudo armar la lectura OAuth: ${detail}. ` +
        "Usando IMAP no-op (el dry-run sigue sin leer el seed real). El ENVÍO sigue MockTransport."
    );
    return noopImapClient;
  }
}

/**
 * Destinatario sintético determinista para dry-run. `.invalid` es un TLD reservado (RFC 2606) que NUNCA
 * resuelve ni entrega: aunque el transporte fuese real, no habría destino. Como el transporte es
 * MockTransport, ADEMÁS ningún mensaje sale de este proceso. No representa a una persona real.
 */
export function dryRunRecipient(node: WarmupNode, index: number): string {
  return `dryrun+${node.id}-${index}@warmup.invalid`;
}

/** testId determinista por (nodo, seed) — estable entre corridas para trazar el placement en dry-run. */
export function dryRunTestId(node: WarmupNode, seedId: string): string {
  return `dryrun-${node.id}-${seedId}`;
}

/**
 * Construye el transporte de dry-run. SIEMPRE MockTransport (cero red). Además ASERTA que
 * WARMUP_TRANSPORT no pida "postfix": si lo pide, este entry se niega a arrancar (fail-closed), para que
 * nadie confunda este proceso con un emisor real. Devuelve el mock para poder aseverar `.sent` en tests.
 */
export function createDryRunTransport(env: WarmupEnv = process.env): MockTransport {
  const kind = warmupTransportKind(env);
  if (kind !== "mock") {
    throw new Error(
      `warmup_dryrun_requires_mock_transport: WARMUP_TRANSPORT="${kind}" pero este entrypoint es DRY-RUN ` +
        "(envía CERO correo real). Dejá WARMUP_TRANSPORT sin setear o en 'mock' para arrancarlo."
    );
  }
  return new MockTransport();
}

export interface BuildDryRunDepsOptions {
  now: Date;
  env?: WarmupEnv;
  /** Transporte a usar; default = MockTransport nuevo (createDryRunTransport). Inyectable para tests. */
  transport?: MockTransport;
  /** Cliente IMAP; default = noopImapClient. Inyectable para tests. */
  imapClient?: ImapClient;
}

/**
 * Ensambla las WarmupTickDeps de dry-run sobre stores reales (pg). PURA respecto a I/O: no toca red ni
 * DB por sí misma (sólo referencia stores/transport/imap ya construidos). Testeable sin Postgres.
 */
export function buildDryRunDeps(
  stores: WarmupStores,
  opts: BuildDryRunDepsOptions
): { deps: WarmupTickDeps; transport: MockTransport } {
  const env = opts.env ?? process.env;
  const transport = opts.transport ?? createDryRunTransport(env);
  const deps: WarmupTickDeps = {
    stores,
    transport,
    imapClient: opts.imapClient ?? noopImapClient,
    now: opts.now,
    pickRecipient: dryRunRecipient,
    newTestId: dryRunTestId
  };
  return { deps, transport };
}

/**
 * Corre UNA iteración del engine en dry-run contra la DB del pool (tras migrar). Devuelve el resultado del
 * tick + el mock, para aseverar que `transport.sent` quedó vacío (prueba de que NO se envió correo).
 */
export async function runDryRunOnce(
  pool: PgClient,
  env: WarmupEnv = process.env
): Promise<{ result: WarmupTickResult; transport: MockTransport }> {
  await runWarmupMigrations(pool, { logger: { info: (m) => console.log(`[warmup-dryrun] ${m}`) } });
  const stores = createPgWarmupStores(pool);
  const imapClient = await resolveDryRunImapClient(env);
  const { deps, transport } = buildDryRunDeps(stores, { now: new Date(), env, imapClient });
  const result = await runWarmupTick(deps, env);
  return { result, transport };
}

/** Resuelve el pool de Postgres desde POSTGRES_URL. Fail-closed: sin URL, no se inventa una conexión. */
function resolvePool(env: NodeJS.ProcessEnv): Pool {
  const connectionString = env.POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error("warmup_dryrun_postgres_url_missing: set POSTGRES_URL para el dry-run del warmup-engine.");
  }
  return new Pool({ connectionString, application_name: "delivrix-warmup-dryrun" });
}

function resolveIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.WARMUP_DRYRUN_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

function onceModeRequested(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  const raw = env.WARMUP_DRYRUN_ONCE?.trim().toLowerCase();
  return raw === "true" || raw === "1" || argv.includes("--once");
}

/**
 * Composition-root del daemon dry-run. --once (o WARMUP_DRYRUN_ONCE=1): migra, corre un tick, imprime el
 * resultado y sale (para verificación). Sin --once: migra y entra al loop de startWarmupDaemon (inerte si
 * WARMUP_ENGINE_ENABLE no está activo). En ambos casos el transporte es MockTransport: CERO correo real.
 */
export async function startWarmupDryRunDaemon(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv
): Promise<void> {
  // Asertar el transporte ANTES de tocar la DB: si pidieron postfix, ni siquiera conectamos.
  createDryRunTransport(env);

  const pool = resolvePool(env);
  const once = onceModeRequested(env, argv);

  try {
    if (once) {
      const { result, transport } = await runDryRunOnce(pool, env);
      console.log(`[warmup-dryrun] tick único OK. transporte=mock, mensajes_enviados=${transport.sent.length}`);
      console.log(`[warmup-dryrun] result=${JSON.stringify(result)}`);
      if (transport.sent.length > 0) {
        // Salvaguarda dura: en dry-run el mock NO debería haber recibido nada más allá de lo esperado;
        // lo reportamos explícito para que quede en el log que fueron mensajes MOCK (no salieron a la red).
        console.warn(`[warmup-dryrun] NOTA: el mock registró ${transport.sent.length} mensaje(s) — NINGUNO tocó la red (transporte mock).`);
      }
      return;
    }

    // Migración una sola vez al arrancar; luego el loop rearma deps con `now` fresco por tick.
    await runWarmupMigrations(pool, { logger: { info: (m) => console.log(`[warmup-dryrun] ${m}`) } });
    const stores = createPgWarmupStores(pool);
    const transport = createDryRunTransport(env); // uno estable para toda la vida del daemon.
    // Selección de IMAP una sola vez al arrancar (valida el OAuth config si el flag está on; fail-closed
    // al no-op si falta/está mal). El ENVÍO sigue MockTransport SIEMPRE.
    const imapClient = await resolveDryRunImapClient(env);
    const runTick = async (): Promise<WarmupTickResult> => {
      const { deps } = buildDryRunDeps(stores, { now: new Date(), env, transport, imapClient });
      return runWarmupTick(deps, env);
    };
    await startWarmupDaemon(runTick, { intervalMs: resolveIntervalMs(env), env });
  } finally {
    await pool.end().catch(() => {});
  }
}

// Entrypoint directo (node apps/warmup-engine/src/service/dryrun-daemon.ts). Importarlo NO arranca nada.
// pathToFileURL resuelve la ruta relativa contra cwd y codifica espacios (el repo vive en "delivrix app"),
// así la comparación con import.meta.url es robusta — una comparación `file://${argv[1]}` fallaría aquí.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // --verify-gmail-read: conecta al seed inbox real vía OAuth y muestra SOLO un resumen seguro (conteos
  // por carpeta). NO migra, NO toca el transporte, NO envía correo. Cualquier otro modo ⇒ dry-run daemon.
  const main = process.argv.includes("--verify-gmail-read")
    ? verifyGmailRead().then(() => undefined)
    : startWarmupDryRunDaemon();
  main.catch((error) => {
    console.error("[warmup-dryrun] fallo fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

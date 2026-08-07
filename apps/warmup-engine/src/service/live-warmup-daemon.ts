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
import {
  decidirCupoDeHoy,
  esInbox,
  evaluarGate,
  medirPorProveedor,
  puedeMandarTurno,
  rampaDesdeEnv,
  TECHO_DURO_POR_DOMINIO,
  textoPlacement,
  type DecisionDiaria,
  type FilaPlacement
} from "../domain/decision-diaria.ts";
import {
  boxesSinCupoHoy,
  cupoAutorizadoVigente,
  elegirPool,
  enviosDeHoy,
  enviosDelDia,
  filasDePlacement,
  historialDeEnvios,
  leerCuposFisicos,
  leerReputacion,
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
  type SentMail,
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
  /** Foto de autenticación de la flota (la escribe el barrido diario). Saca del pool lo que tiene
   *  DKIM/PTR/cert rotos: calentar así construye la reputación al revés. */
  reputacionFile: string;
  pollAttempts: number;
  pollDelayMs: number;
  /**
   * Las dos palancas de la RAMPA por dominio. Existían en `EntradaDecision` desde el primer día y
   * NINGÚN llamador las pasaba: vivían como `?? 40` y `?? 2` dentro de la función, o sea que mover
   * el techo de un dominio exigía tocar código y desplegar. Ahora salen del entorno con el mismo
   * fail-closed que el resto — y con las env vars ausentes, que es el estado de hoy, el
   * comportamiento no cambia en un solo correo (los defaults son exactamente esos 40 y 2).
   */
  limiteDiario: number;
  pasoPorDia: number;
  /** ¿La rampa da 0 el fin de semana? Sale de `rampaDesdeEnv` para no divergir del panel. */
  soloDiasHabiles: boolean;
  /**
   * Franja horaria UTC en la que se permite enviar (`"08-22"`). `null` = las 24 h, que es lo de hoy.
   *
   * §3 del doc lista "spread horario" entre los levers y "cadencia de máquina" entre los errores que
   * queman. Medido en producción: el 25% del volumen histórico cae entre las 00:00 y las 06:00 UTC,
   * o sea de madrugada en el huso del receptor.
   *
   * OJO CON LA DIRECCIÓN: la ventana sólo puede BAJAR el volumen (si el día no alcanza, salen menos
   * vueltas), nunca subirlo. Por eso puede venir configurada sin pasar por el operador; el jitter de
   * abajo tampoco cambia cuántas salen, sólo cuándo.
   */
  ventanaUtc: { desde: number; hasta: number } | null;
}

/**
 * Entero del entorno, FAIL-CLOSED: basura (vacío, texto, negativo, por debajo del mínimo) cae al
 * default conservador en vez de propagar un NaN que después se compara con `>=` y da false siempre.
 *
 * OJO con una lectura equivocada que ya vi hacer: `WARMUP_LIVE_MAX_PER_DAY=0` NO frena el daemon.
 * Cero está por debajo del mínimo, así que cae al default (3) y el daemon manda MÁS que lo escrito.
 * Para frenar existen el kill-file y WARMUP_LIVE_ENABLE=false, que son las dos barreras que sí
 * están hechas para eso.
 */
function intEnv(raw: string | undefined, fallback: number, min: number): number {
  const t = (raw ?? "").trim();
  // AUSENTE Y VACÍO SON LO MISMO, y hay que decirlo explícito: `Number("")` es 0. Mientras todos los
  // mínimos fueron 1 eso no se notaba (el 0 quedaba por debajo y caía al default igual), pero apenas
  // una palanca acepta 0 como orden legítima —las dos de la rampa— un `WARMUP_RAMPA_LIMITE_DIARIO=`
  // sin valor pasaba a congelar la rampa como si alguien lo hubiera pedido.
  if (t.length === 0) return fallback;
  const n = Number(t);
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
    reputacionFile: (env.WARMUP_REPUTACION_FILE ?? rutaInventario("warmup-reputacion.json")).trim(),
    // Ventana de medición amplia: Gmail puede tardar >60s en indexar el mensaje recién enviado.
    // 30 intentos × 6s = ~3min inline. (Mejora futura: medir en un pase posterior, no bloqueante.)
    pollAttempts: intEnv(env.WARMUP_LIVE_POLL_ATTEMPTS, 30, 1),
    pollDelayMs: intEnv(env.WARMUP_LIVE_POLL_DELAY_MS, 6000, 100),
    // Los defaults son los que hoy están hardcodeados dentro de `decidirCupoDeHoy` (`?? 40`, `?? 2`):
    // con las env vars ausentes el número que sale es idéntico al de antes de este cambio.
    //
    // MÍNIMO 0, no 1, y es la diferencia entre respetar al operador y contradecirlo. Con min=1, un
    // `WARMUP_RAMPA_LIMITE_DIARIO=0` escrito a propósito para congelar la rampa caía al default y el
    // dominio mandaba 40/día: el número escrito por el operador se descartaba en silencio y salía
    // MÁS que lo pedido. En `WARMUP_LIVE_MAX_PER_DAY` eso es tolerable —para frenar están el
    // kill-file y el flag— pero estas dos gobiernan el volumen POR DOMINIO, que es el eje donde vive
    // el umbral irreversible de Google. La basura no numérica sigue cayendo al default.
    // Resueltas por `rampaDesdeEnv` (domain/decision-diaria.ts) y NO acá con `intEnv`: son las
    // únicas dos palancas que también necesita `planDelDia` —el panel y lo que el agente le reporta
    // al jefe— y tenerlas en dos lados es justo cómo se abrió la divergencia que esto cierra.
    ...rampaDesdeEnv(env),
    ventanaUtc: ventanaDesdeEnv(env.WARMUP_LIVE_VENTANA_UTC)
  };
}

/**
 * La franja horaria UTC de envío, de `"08-22"`. Pura y FAIL-OPEN a las 24 h.
 *
 * Fail-open y no fail-closed a propósito, al revés que el resto de la config: una ventana ilegible
 * que se interpretara como "no enviar nunca" apagaría el warmup entero por un typo, y sin ruido —
 * el daemon seguiría vivo, girando y sin mandar. La consecuencia de caer a 24 h es exactamente el
 * comportamiento de hoy.
 */
export function ventanaDesdeEnv(raw: string | undefined): { desde: number; hasta: number } | null {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(raw ?? "");
  if (!m) return null;
  const desde = Number(m[1]);
  const hasta = Number(m[2]);
  if (!Number.isInteger(desde) || !Number.isInteger(hasta) || desde < 0 || hasta > 24 || desde >= hasta) return null;
  return { desde, hasta };
}

/** ¿Esta hora UTC cae dentro de la ventana? Sin ventana, siempre sí. */
export function dentroDeVentana(horaUtc: number, v: { desde: number; hasta: number } | null): boolean {
  return v === null || (horaUtc >= v.desde && horaUtc < v.hasta);
}

/**
 * El intervalo REAL de esta vuelta: el configurado ±35%. Puro — el azar entra por parámetro.
 *
 * El correo salía con metrónomo de 91 minutos EXACTOS, 24 h/día, todos los días: los deltas medidos
 * en el log de producción el 2026-08-07 son 91, 91, 91, 95, 92, 91, 92, 91. §3 del doc lista
 * "cadencia de máquina" entre los errores que queman, y es la firma más barata de borrar que tiene
 * el sistema: una línea.
 *
 * NO CAMBIA EL VOLUMEN. La media de `0,65 + azar·0,7` es 1,0, así que con las mismas vueltas sólo
 * cambia CUÁNDO salen. El piso de 1 s es el mismo mínimo que ya exige `intEnv` para el intervalo.
 */
export function intervaloConJitter(baseMs: number, azar: number): number {
  return Math.max(1000, Math.round(baseMs * (0.65 + azar * 0.7)));
}

/**
 * La semilla INSTRUMENTO: la que mide y a la que NUNCA se le aplica señal.
 *
 * Determinista (la primera por dirección, ordenada) para que no dependa del orden del archivo: si
 * cambiara de vuelta en vuelta, todas las semillas terminarían entrenadas y no se ganaría nada.
 *
 * ponytail: con UNA sola semilla capaz de medir, esto degrada a NO ENGAGEAR NUNCA — la medición
 * queda limpia y se pierde el lift entero. Hoy producción tiene dos (trazosvercel@gmail.com y
 * flomia33193@gmail.com, verificado en warmup-seeds.json), así que una mide limpio y la otra
 * conserva la señal. El techo real es que la segunda SÍ se entrena y sus filas siguen entrando a la
 * ventana de placement: separarlas exigiría excluir sus mediciones, y eso parte la muestra al medio
 * — un dominio nuevo necesita 4 mediciones para avanzar la rampa, así que es una decisión de
 * VOLUMEN y va al operador, no acá. Upgrade: una tercera semilla de sólo-medición.
 */
export function instrumentoDeMedicion(semillas: readonly SeedBase[]): string | null {
  const miden = semillasMedibles([...semillas])
    .map((s) => s.address.trim().toLowerCase())
    .sort();
  return miden[0] ?? null;
}

/**
 * La línea ARRANCA — dice la ARITMÉTICA del sobre de volumen, no tres números sueltos.
 *
 * La trampa que cierra: el tope diario y el intervalo están ACOPLADOS y eso no estaba escrito en
 * ningún lado. Con el intervalo de 90 min de producción entran 16 ciclos en un día UTC, así que
 * subir WARMUP_LIVE_MAX_PER_DAY de 14 a 50 no agrega un solo correo. El que lo sube mira el log,
 * no ve nada distinto, y se queda creyendo que aumentó el volumen. Pura: se testea sin arrancar nada.
 */
export function lineaDeArranque(
  cfg: Pick<LiveDaemonConfig, "maxPerDay" | "intervalMs" | "placementFloor" | "seedInbox" | "limiteDiario" | "pasoPorDia"> &
    Partial<Pick<LiveDaemonConfig, "ventanaUtc" | "soloDiasHabiles">>
): string {
  const ciclosPosibles = Math.floor(86_400_000 / cfg.intervalMs);
  const aviso =
    cfg.maxPerDay > ciclosPosibles
      ? ` — OJO: el tope de ${cfg.maxPerDay} NO se puede alcanzar, el intervalo solo permite ${ciclosPosibles}:` +
        " subirlo sin bajar el intervalo no agrega un correo"
      : "";
  // El intervalo lleva jitter ±35%, y hay que DECIRLO acá: sin esta frase, el operador que mire dos
  // vueltas separadas por 62 min y otras dos por 118 va a creer que el daemon se colgó.
  const franja = cfg.ventanaUtc ? ` · sólo entre las ${cfg.ventanaUtc.desde}:00 y las ${cfg.ventanaUtc.hasta}:00 UTC` : " · las 24h";
  const habiles = cfg.soloDiasHabiles ? " · sólo días hábiles (fin de semana en 0)" : "";
  return (
    `ARRANCA — tope ${cfg.maxPerDay} vueltas/día · intervalo ${Math.round(cfg.intervalMs / 60000)}min ±35% (jitter) ⇒ ` +
    `${ciclosPosibles} ciclos/día posibles${aviso}${franja}${habiles}` +
    ` · rampa por dominio hasta ${cfg.limiteDiario}/día (+${cfg.pasoPorDia}/día), techo duro ${TECHO_DURO_POR_DOMINIO}/día` +
    ` · piso placement ${(cfg.placementFloor * 100).toFixed(0)}% · seed ${cfg.seedInbox} (el pool se decide en cada vuelta)`
  );
}

/**
 * La línea de semillas — dice en QUÉ PROVEEDORES se mide, no solo cuántas semillas miden.
 *
 * "2 pueden medir" suena a cobertura y hoy las dos son Gmail: el placement de toda la flota se lee
 * en UN solo receptor, y el criterio "repartir entre proveedores" de `elegirSemillaRotada` no puede
 * ejecutarse nunca. Outlook y Yahoo —que son justamente los que más nos bloquean— son punto ciego,
 * y con el conteo pelado eso no se ve.
 */
export function lineaDeSemillas(semillas: readonly SeedBase[]): string {
  const miden = semillasMedibles([...semillas]);
  const proveedores = [...new Set(miden.map((s) => s.provider))].sort();
  const alerta =
    proveedores.length <= 1
      ? ` — se mide en UN SOLO receptor (${proveedores[0] ?? "ninguno"}): lo que pase en los otros es punto ciego`
      : "";
  return (
    `semillas: ${semillas.length} activas · ${miden.length} miden placement en ` +
    `${proveedores.length > 0 ? proveedores.join("+") : "ningún proveedor"}${alerta}` +
    ` · destinos ${semillas.map((s) => s.address).join(", ")}`
  );
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

/** Una medición con su dueño. Sin el dominio no se puede saber de quién es la culpa. */
export interface PlacementDeDominio {
  dominio: string;
  placement: Placement;
}

/**
 * Cuántas mediciones necesita la FLOTA para que el freno global pueda dispararse.
 *
 * El 2026-08-06 el warmup llevaba horas parado con este motivo: "inbox 33% < piso 50%". Las seis
 * mediciones de la ventana eran estas —
 *
 *   corpfiling-infra.com      INBOX      annualfilings-ops.com      SPAM
 *   corpfiling-infra.com      INBOX      annualfilings-control.com  SPAM
 *   nationalfiling-infra.com  MISSING    annualcorp-infra.com       SPAM
 *
 * — o sea: el único dominio que venía calentando bien (2/2 en la ventana, 5/6 en la semana) estaba
 * frenado por CUATRO muestras sueltas, una por dominio, de dominios que recién arrancaban. Que un
 * dominio nuevo caiga en spam el primer día no es una señal de que la flota se degradó: es lo que
 * pasa siempre, y es justo lo que el calentamiento existe para revertir.
 *
 * Peor: el freno era un candado. Parado no se mide, sin medir la tasa no cambia, y sin que la tasa
 * cambie no se destraba. Solo salía si un humano lo sacaba a mano — exactamente la dependencia que
 * el agente vino a eliminar.
 *
 * El freno POR DOMINIO (`decidirCupoDeHoy`) ya hace el trabajo fino con las mediciones de cada
 * dominio, y ese sí es el estadístico correcto. Este freno global queda para lo que debería haber
 * sido siempre: el corte de catástrofe. Y un corte de catástrofe con seis filas no mide nada, así
 * que ahora exige muestra suficiente antes de poder apagar la fábrica entera.
 */
export const MIN_MUESTRA_FLOTA = 10;

/**
 * Cuántas mediciones propias necesita UN dominio para que sus resultados entren en el promedio de
 * la flota.
 *
 * Sin esto, subir la muestra mínima solo compraba una vuelta. Los números reales, medidos a las
 * 02:00 del 2026-08-06 justo después de que el warmup volviera a arrancar:
 *
 *   corpfiling-infra.com        5 de 6  → 83%
 *   annualcorp-infra.com        0 de 2
 *   nationalfiling-infra.com    0 de 1
 *   annualfilings-ops.com       0 de 1
 *   annualfilings-control.com   0 de 1
 *                              ─────────
 *   flota                       5 de 11 → 45%  ⇒ pausa
 *
 * Cuatro dominios recién arrancados aportan cinco muestras de día 0 y hunden a uno que va al 83%.
 * Promediar dominios en etapas distintas de la rampa no mide nada: un dominio nuevo cae en spam
 * porque es nuevo, no porque la flota se esté degradando, y esa es justamente la condición que el
 * calentamiento existe para revertir.
 *
 * Con este umbral, el promedio de la flota se calcula solo sobre los dominios que YA tienen
 * historia. Los nuevos calientan bajo el freno FINO —`decidirCupoDeHoy`, que les da 2/día hasta
 * juntar 4 mediciones— y recién entran al promedio general cuando lo que midieron significa algo.
 *
 * Es el mismo número que `MUESTRA_PARA_JUZGAR` en las acciones del agente, y por la misma razón:
 * abajo de cuatro mediciones no hay con qué juzgar a un dominio.
 */
export const MIN_MUESTRAS_POR_DOMINIO = 4;

/**
 * Cuántos DOMINIOS distintos tienen que aportar antes de que el freno global pueda apagar la flota.
 *
 * `MIN_MUESTRA_FLOTA` arregló la mitad del problema y dejó la otra en pie: exige 10 mediciones pero
 * no exige que vengan de más de un dominio. Hoy, en producción, las 10 que cuentan son las 10 de
 * corpfiling-infra.com — el único con historia suficiente. O sea que si ESE dominio saca seis SPAM
 * seguidos, la tasa cae bajo el piso y se apaga el warmup de los 58 nodos por la evidencia de uno.
 *
 * Es el mismo error de forma que el comentario de MIN_MUESTRA_FLOTA dice haber arreglado, corrido
 * de eje: de "pocas muestras" a "muchas muestras de un solo dueño". Un corte de CATÁSTROFE afirma
 * algo sobre la flota, y un dominio no es la flota — para eso ya está el freno fino
 * (`decidirCupoDeHoy`), que con sus propias mediciones lo baja o lo frena a él solo.
 *
 * `recentInboxRate` ya venía calculando `dominios` desde el arreglo anterior y nadie lo miraba.
 */
export const MIN_DOMINIOS_FLOTA = 2;

export interface GateInput {
  enabled: boolean;
  killed: boolean;
  cyclesToday: number;
  maxPerDay: number;
  recentPlacements: readonly PlacementDeDominio[];
  placementFloor: number;
  /**
   * Los dominios que HOY pueden enviar (el pool ya elegido). Lo que midió un dominio frenado no es
   * evidencia sobre lo que va a pasar si mandamos ahora: si el dominio está fuera, su historia sale
   * del cálculo. Sin esto, frenar el dominio culpable no destrababa la flota, porque sus muestras
   * seguían pesando en el promedio.
   *
   * `undefined` = no filtrar (tests y compatibilidad).
   */
  elegibles?: ReadonlySet<string>;
}

/**
 * Tasa de inbox reciente (INBOX / total) de los dominios que hoy pueden enviar.
 * `null` si no hay mediciones que cuenten.
 */
export function recentInboxRate(
  placements: readonly PlacementDeDominio[],
  elegibles?: ReadonlySet<string>
): { tasa: number; muestra: number; dominios: number } | null {
  const delPool = elegibles ? placements.filter((p) => elegibles.has(p.dominio)) : [...placements];

  // Solo entran al promedio los dominios CON HISTORIA. Un dominio en sus primeras mediciones no es
  // evidencia sobre el estado de la flota — es evidencia de que acaba de empezar.
  const porDominio = new Map<string, PlacementDeDominio[]>();
  for (const p of delPool) {
    const ya = porDominio.get(p.dominio);
    if (ya) ya.push(p);
    else porDominio.set(p.dominio, [p]);
  }
  const cuentan = [...porDominio.values()].filter((ps) => ps.length >= MIN_MUESTRAS_POR_DOMINIO).flat();
  if (cuentan.length === 0) return null;

  // Mismo criterio que la decisión por dominio: PROMOTIONS cuenta como bandeja (§9). Parchear un
  // contador y dejar el otro con la regla vieja produce dos verdades sobre el mismo dato.
  return {
    tasa: cuentan.filter((p) => esInbox(p.placement)).length / cuentan.length,
    muestra: cuentan.length,
    dominios: new Set(cuentan.map((p) => p.dominio)).size
  };
}

/** Decide qué hacer esta vuelta. Orden de barreras: flag → kill → tope → placement → send. */
export function decideDaemonAction(input: GateInput): { action: DaemonAction; reason: string } {
  if (!input.enabled) return { action: "inert", reason: "WARMUP_LIVE_ENABLE!=true" };
  if (input.killed) return { action: "killed", reason: "kill-file presente" };
  if (input.cyclesToday >= input.maxPerDay) {
    return { action: "cap-reached", reason: `tope diario ${input.cyclesToday}/${input.maxPerDay}` };
  }
  const r = recentInboxRate(input.recentPlacements, input.elegibles);
  // Sin muestra suficiente NO se apaga la fábrica. El freno fino por dominio sigue gobernando el
  // volumen de cada uno; este solo existe para cortar una degradación de toda la flota, y para
  // afirmar eso hacen falta datos, no seis filas.
  if (
    r !== null &&
    r.muestra >= MIN_MUESTRA_FLOTA &&
    r.dominios >= MIN_DOMINIOS_FLOTA &&
    r.tasa < input.placementFloor
  ) {
    return {
      action: "placement-pause",
      reason:
        `inbox ${(r.tasa * 100).toFixed(0)}% < piso ${(input.placementFloor * 100).toFixed(0)}% ` +
        `sobre ${r.muestra} mediciones de ${r.dominios} dominio(s) con historia`
    };
  }
  // EL MOTIVO DEL "send" DEJA DE SER "ok", Y ESO ES EL ARREGLO.
  //
  // Con `MIN_DOMINIOS_FLOTA` puesto, hoy en producción el freno global NO PUEDE dispararse: hace
  // falta que DOS dominios junten 4 mediciones propias cada uno, y las 10 que cuentan son las 10 de
  // corpfiling-infra.com. Verificado: 100 mediciones TODAS en SPAM de un solo dominio devuelven
  // "send". La condición es correcta —un dominio no es la flota, y el freno fino ya lo baja a él
  // solo— pero un gate que no puede evaluarse tiene que DECIRLO: si no, "no se disparó" se lee como
  // "se evaluó y dio bien", que es la confusión más cara de este sistema. El daemon lo imprime.
  const cobertura =
    r === null
      ? "freno global INACTIVO: ningún dominio con 4+ mediciones propias todavía"
      : r.dominios < MIN_DOMINIOS_FLOTA
        ? `freno global INACTIVO: solo ${r.dominios} dominio(s) con historia (hacen falta ${MIN_DOMINIOS_FLOTA})`
        : r.muestra < MIN_MUESTRA_FLOTA
          ? `freno global INACTIVO: ${r.muestra} mediciones (hacen falta ${MIN_MUESTRA_FLOTA})`
          : `freno global evaluado: inbox ${(r.tasa * 100).toFixed(0)}% sobre ${r.muestra} mediciones de ${r.dominios} dominios`;
  return { action: "send", reason: cobertura };
}

/** Rotación estable de boxes por índice de vuelta. */
export function pickBox(boxes: readonly string[], cycleIndex: number): string {
  if (boxes.length === 0) throw new Error("no boxes configured");
  const i = ((cycleIndex % boxes.length) + boxes.length) % boxes.length;
  return boxes[i] as string;
}

/**
 * A QUÉ BOX le toca esta vuelta, y quiénes quedan como candidatos.
 *
 * `agotados` es lo que faltaba. El daemon preguntaba `disponibles.some(b => b !== box &&
 * !frenados.has(b))` para decidir si dormir 60 s o el intervalo entero — pero `disponibles` se
 * había construido tres líneas antes como `poolElegido.boxes.filter(b => !frenados.has(b))`, así
 * que el `!frenados.has(b)` era siempre true y la expresión era, literalmente,
 * `disponibles.length > 1`. Preguntaba si queda OTRO box, no si queda otro box CON CUPO.
 *
 * Con los 6 del pool agotados desde media tarde —el caso normal, porque el cupo por dominio (2) es
 * menor que el tope de vueltas— la respuesta era siempre "sí, quedan otros", el daemon dormía 60 s,
 * volvía a elegir a otro agotado, y así ~1.400 vueltas por día × 7 consultas contra Postgres. Es
 * exactamente la patología que el comentario de esa misma línea decía haber arreglado. De rebote
 * mantenía el watchdog en verde solo, porque el giro en caliente fabricaba la frescura del log.
 *
 * Efecto secundario buscado: sacar a los agotados de la rotación hace que `pickBox` deje de
 * repartir plano por índice. Con los chicos ya agotados, las vueltas que quedan van al que todavía
 * tiene cupo en vez de gastarse en saltear a los que no.
 *
 * Pura: el daemon la usa para elegir Y para preguntar si queda alguien. Que sean la MISMA función
 * es el punto — la pregunta y la elección tienen que responder con el mismo criterio, y el bug de
 * arriba fue exactamente que no lo hacían.
 */
export function elegirBoxDeLaVuelta(e: {
  pool: readonly string[];
  /** Los que hoy rebotaron con 450 contra el cap físico del nodo. */
  rebotadosHoy: ReadonlySet<string>;
  /** Los que ya cumplieron su cupo del día (foto del día UTC en curso). */
  agotados: ReadonlySet<string>;
  seq: number;
}): { box: string | null; disponibles: string[] } {
  const disponibles = e.pool.filter((b) => !e.rebotadosHoy.has(b) && !e.agotados.has(b));
  return { box: disponibles.length > 0 ? pickBox(disponibles, e.seq) : null, disponibles };
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
 * MIDE DÓNDE CAYÓ UN TURNO DE CONTINUACIÓN, con el lector que ya está abierto.
 *
 * El agujero que cierra, medido el 2026-08-06: de 18 envíos de la vuelta, 7 eran continuaciones y
 * NINGUNA producía una fila `measured`. O sea que el 45% del correo de corpfiling-infra.com gastaba
 * cupo del día y no aportaba una sola muestra de la evidencia que gobierna su propia rampa. La
 * consecuencia fue un parche encima del agujero: `puedeMandarTurno` tuvo que prohibirle el "Re:" a
 * todo dominio que todavía no juntó muestra, porque el turno le comía la oportunidad de medir.
 * Con esto el turno mide igual que el ciclo principal y esa prohibición pasa a ser conservadora en
 * vez de necesaria.
 *
 * Réplica exacta de la etapa ② de `runLiveCycle`, incluido el `MISSING`: un correo que el proveedor
 * aceptó y que no aparece en ninguna carpeta es una MEDICIÓN (la peor de todas), no un error.
 * Grabarlo como `error` lo dejaría fuera de las ventanas de placement, que filtran `kind='measured'`
 * — el único camino del sistema hacia más volumen sobre evidencia falsa, ya cerrado una vez.
 *
 * Nunca lanza: el correo YA salió y ya quedó grabado como `sent`. Un fallo de medición no puede
 * tumbar la vuelta ni desaparecer el envío del contador del día.
 */
export async function medirTurnoDeHilo(input: {
  ops: GmailOps | null;
  enviado: SentMail;
  subject: string;
  recorder: ActivityRecorder;
  base: { cycleId: string; boxDomain: string; seedInbox: string };
  testId: string;
  pollAttempts: number;
  pollDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (m: string) => void;
}): Promise<void> {
  // Sin lector no se inventa un veredicto: no medido y "no llegó" no son lo mismo, y MISSING es una
  // afirmación fuerte sobre la reputación del dominio.
  if (!input.ops) {
    input.log("el turno salió pero esta semilla no tiene con qué medir dónde cayó");
    return;
  }
  const rfc822 = input.enviado.messageId.replace(/[<>]/g, "");
  let encontrado: Awaited<ReturnType<GmailOps["findMessage"]>> = null;
  try {
    for (let i = 0; i < input.pollAttempts && !encontrado; i += 1) {
      await input.sleep(input.pollDelayMs);
      encontrado = await input.ops.findMessage({ rfc822MessageId: rfc822, subject: input.subject });
    }
  } catch (err) {
    // Un IMAP que corta a mitad del polling es "no sé", no "no llegó". Se registra como error de la
    // ETAPA de medición, que es lo que fue, y no como un MISSING que castigaría al dominio.
    await input.recorder.record({
      ...input.base, kind: "error", subject: input.subject, testId: input.testId,
      detail: { stage: "measured", note: err instanceof Error ? err.message : String(err), origen: "continuación de hilo" }
    });
    input.log(`no pude medir el turno — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const placement = encontrado ? classifyPlacement(encontrado.labelIds) : "MISSING";
  await input.recorder.record({
    ...input.base, kind: "measured", placement, subject: input.subject, testId: input.testId,
    detail: encontrado
      ? { labels: encontrado.labelIds, origen: "continuación de hilo" }
      : { note: "no_indexado_en_ventana: el proveedor lo aceptó y no apareció en ninguna carpeta", origen: "continuación de hilo" }
  });
  input.log(`el turno cayó en ${placement}`);
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
export async function recentPlacements(pg: PgClient, window: number): Promise<PlacementDeDominio[]> {
  // La ventana que se pasa es la POR DOMINIO (6). Usarla como límite de filas de toda la flota era
  // el error de fondo: con 58 dominios, "las últimas 6 filas" no es una ventana, es una lotería —
  // un solo dominio que mide cinco veces la llena entera. El corte real es TEMPORAL (los mismos 10
  // días del resto del sistema); el límite de filas queda solo como tope de memoria.
  // LA MISMA CLÁUSULA QUE `placementsDeDominio`, Y POR LA MISMA RAZÓN — pero acá pesa más, porque
  // lo que alimenta este lector es `placement-pause`, el ÚNICO corte que apaga los 58 nodos de
  // golpe. Desde que `medirTurnoDeHilo` graba `kind:'measured'` para las continuaciones, un "Re:"
  // dentro de un hilo ya establecido (que entrega mucho mejor que el arranque en frío) entraba en
  // la ventana GLOBAL y sesgaba la tasa hacia ARRIBA: medido con `decideDaemonAction` real y el
  // piso por defecto (0,5), 3 dominios × 4 mediciones frías al 25% dan `placement-pause`; sumando
  // 3 continuaciones en INBOX por dominio la misma llamada devuelve `send` ("inbox 57%"). O sea:
  // el freno de catástrofe se abría solo. La regla vivía duplicada en dos SQL y sólo una la cumplía.
  //
  // `IS DISTINCT FROM` y no `<>`: las filas del ciclo principal no tienen `origen`, y `NULL <> 'x'`
  // es NULL — descartaría TODAS y dejaría al gate global sin evidencia. Ver plan-diario.ts.
  const { rows } = await pg.query<{ node_domain: string; placement: string | null }>(
    `SELECT node_domain, placement FROM warmup_activity
      WHERE kind = 'measured' AND placement IS NOT NULL
        AND (detail->>'origen') IS DISTINCT FROM 'continuación de hilo'
        AND occurred_at > now() - interval '${VENTANA_PLACEMENT_DIAS} days'
      ORDER BY occurred_at DESC LIMIT $1`,
    [Math.max(window, 200)]
  );
  const valido = (p: string): p is Placement =>
    p === "INBOX" || p === "SPAM" || p === "PROMOTIONS" || p === "OTHER" || p === "MISSING";
  return rows.flatMap((r) => {
    const p = (r.placement ?? "").toUpperCase();
    return valido(p) ? [{ dominio: (r.node_domain ?? "").toLowerCase(), placement: p }] : [];
  });
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
    // EL RESPALDO ES UNA TRAMPA SILENCIOSA, y hay que decirlo cuando se usa.
    //
    // Esta semilla se declara `gmail_oauth`, así que `puedeMedir` la da por buena y el daemon cree
    // que puede medir dónde cayó cada correo. Pero el refresh token de esa cuenta lleva días
    // muerto (verificado el 2026-08-06): cada vuelta mandaría el correo y la medición fallaría, y
    // el sistema quedaría enviando A CIEGAS creyendo que mide — que es peor que no medir, porque
    // el freno por placement necesita mediciones para existir y sin ellas nunca frena.
    //
    // No se cambia el comportamiento (seguir mandando es mejor que no arrancar) pero se GRITA:
    // este camino solo se toma si warmup-seeds.json desapareció o quedó ilegible, o sea que ya
    // hay algo roto que mirar.
    semillas = [{ address: cfg.seedInbox, provider: "gmail", enabled: true, auth: "gmail_oauth" }];
    log(
      `SIN REGISTRO de semillas (${cfg.seedsPath}) — caigo a ${cfg.seedInbox} por OAuth. ` +
        `OJO: si ese refresh token está caducado la medición de placement va a fallar en silencio y ` +
        `el freno por placement deja de existir. Cargá semillas con scripts/ops/semillas.ts.`
    );
  } else {
    log(lineaDeSemillas(semillas));
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
  log(lineaDeArranque(cfg));

  // LOS QUE YA CUMPLIERON SU CUPO HOY. Sin esta memoria el daemon volvía a elegirlos vuelta tras
  // vuelta, cada 60 s, hasta el cambio de día (ver `elegirBoxDeLaVuelta`). Es una FOTO del día UTC
  // en curso y se descarta en dos casos, los dos reales:
  //   · cambia el día UTC ⇒ todos vuelven a la rotación con su cupo nuevo;
  //   · cambia el pool ⇒ hubo medición nueva del cupo físico o de la salud. El 2026-08-04, 46 nodos
  //     pasaron de cap 0 a valores reales a las 19:01 UTC: un nodo marcado agotado con cap 0 a la
  //     mañana tiene que poder volver a trabajar esa misma tarde, no al otro día.
  //
  // POR QUÉ ES SEGURO recordarlo el resto del día, que es la pregunta obvia: el cupo de un dominio
  // sale de su día de rampa, de SUS mediciones y de su cap físico. El día no cambia dentro del día;
  // el cap está cubierto por el clear de arriba; y las mediciones propias solo crecen cuando ESE
  // dominio manda — cosa que no va a pasar, porque está agotado. Además la marca se pone DESPUÉS de
  // recalcular su cupo con los datos frescos de esa vuelta, así que el salto de "sostener 2" a la
  // rampa completa (el que ocurre al juntar la cuarta medición) ya quedó contemplado antes de
  // marcarlo. Lo único que queda afuera es una medición vieja que caduque de la ventana de 10 días
  // a media tarde: eso espera al cambio de día, y son diez días de espera contra unas horas más.
  const agotados = new Set<string>();
  let diaDeAgotados = "";

  // EL METRÓNOMO SE ROMPE ACÁ. Todas las esperas del intervalo pasan por esta función: dejar una
  // sola con `sleep(cfg.intervalMs)` alcanzaría para que el patrón vuelva a aparecer en el log, que
  // es justo el modo en que este bug se conservó tanto tiempo (el intervalo estaba escrito seis
  // veces). Ver `intervaloConJitter`: no cambia el volumen, sólo cuándo sale.
  const dormirIntervalo = async (): Promise<void> => sleep(intervaloConJitter(cfg.intervalMs, Math.random()));

  // EL PROVEEDOR DE CADA SEMILLA, del mismo registro que ya está cargado. Es todo lo que hace falta
  // para que ninguna cifra de placement salga sin decir en qué receptor se midió.
  const proveedorDeSemilla = new Map(semillas.map((s) => [s.address.trim().toLowerCase(), s.provider]));
  // LA SEMILLA QUE MIDE Y NO SE ENTRENA. Ver `instrumentoDeMedicion`.
  const instrumento = instrumentoDeMedicion(semillas);
  log(
    instrumento
      ? `instrumento de medición: ${instrumento} — a esa semilla NO se le aplica señal (no se entrena la que mide)`
      : "sin semilla que mida: no hay instrumento y no hay placement"
  );

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

      // El cupo es POR DÍA UTC, así que la foto de agotados también. Misma zona explícita que
      // `countCyclesToday` y `enviosDeHoy`: dos ventanas distintas para la palabra "hoy" son dos
      // verdades sobre cuánto se mandó.
      const hoyUtc = new Date().toISOString().slice(0, 10);
      if (hoyUtc !== diaDeAgotados) {
        agotados.clear();
        diaDeAgotados = hoyUtc;
      }

      const killed = existsSync(cfg.killFile);
      const cyclesToday = await countCyclesToday(pg);
      const placements = await recentPlacements(pg, cfg.placementWindow);

      // El pool se calcula ANTES de decidir, no adentro del `send`. Dos razones, y las dos se
      // pagaron caro:
      //  · el freno global necesita saber quién puede enviar hoy — si no, las muestras de un
      //    dominio ya frenado siguen pesando y frenar al culpable no destraba a los sanos;
      //  · con el pool adentro del `send`, durante una pausa el log no decía NADA del pool, así
      //    que el operador no podía ver qué correría si se destrabara.
      // Se recalcula cada vuelta porque la medición del cupo se relee cada vuelta, y solo se loguea
      // cuando CAMBIA, para no repetir la misma línea durante días.
      const capsFisicos = await leerCuposFisicos(cfg.capFile);
      // La salud saca del pool lo que no se puede calentar: cruzado el umbral, cerrado por el
      // receptor, o con la cola atascada. Tener cupo no es lo mismo que valer la pena.
      const saludFlota = await leerSalud(cfg.saludFile);
      // Y la AUTENTICACIÓN, que es la exclusión que faltaba: hasta hoy el warmup mandaba sin
      // verificar que DKIM/PTR/cert siguieran vivos. Lo escribe el barrido diario de reputación;
      // si el archivo no está, no excluye a nadie y el pool sale igual que antes.
      const authFlota = await leerReputacion(cfg.reputacionFile);
      const poolElegido = elegirPool(capsFisicos, poolConfigurado, saludFlota, authFlota);
      if (poolElegido.boxes.join(",") !== poolAnterior) {
        poolAnterior = poolElegido.boxes.join(",");
        // El pool cambió ⇒ hay medición nueva del cupo o de la salud, así que la foto de agotados
        // es vieja: un nodo que marcamos agotado con cap 0 puede tener cupo real ahora mismo.
        agotados.clear();
        log(`pool: ${poolElegido.motivo}${poolElegido.boxes.length > 0 ? ` → ${poolElegido.boxes.join(", ")}` : ""}`);
      }

      const { action, reason } = decideDaemonAction({
        enabled: cfg.enabled,
        killed,
        cyclesToday,
        maxPerDay: cfg.maxPerDay,
        recentPlacements: placements,
        placementFloor: cfg.placementFloor,
        elegibles: new Set(poolElegido.boxes.map((b) => b.toLowerCase()))
      });

      if (action === "send") {
        // El motivo del `send` se IMPRIME. Es la única forma de distinguir "el corte de catástrofe
        // se evaluó y la flota está bien" de "el corte de catástrofe no se puede evaluar" — y hasta
        // acá las dos se veían igual: silencio. Ver decideDaemonAction.
        log(`gate: ${reason}`);
        // LA FRANJA HORARIA. Con `WARMUP_LIVE_VENTANA_UTC` vacío —el estado de hoy— esto no aparta
        // una sola vuelta. Con franja, el correo deja de salir de madrugada en el huso del receptor:
        // medido, el 25% del volumen histórico caía entre las 00:00 y las 06:00 UTC. Sólo puede
        // BAJAR el volumen del día, nunca subirlo, y por eso no necesita autorización.
        if (!dentroDeVentana(new Date().getUTCHours(), cfg.ventanaUtc)) {
          log(`fuera de la franja de envío (${cfg.ventanaUtc!.desde}:00-${cfg.ventanaUtc!.hasta}:00 UTC) — espero`);
          if (once) break;
          await dormirIntervalo();
          continue;
        }
        if (poolElegido.boxes.length === 0) {
          // ESPERA, no `return`. Salir mataba el proceso sin supervisor que lo levante, y el caso
          // que lo dispara es transitorio: alguien frenó la flota entera y la va a soltar. El
          // daemon tiene que seguir vivo para enterarse.
          log("nada que calentar: ningún nodo con cupo. Espero la próxima medición.");
          if (once) break;
          await dormirIntervalo();
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
        // El piso del "sostener": lo que el dominio REALMENTE mandó hace dos días. Va topado por la
        // rampa, así que no puede inflar nada.
        let mandadoHace2Dias: Map<string, number>;
        // LA ENTRADA DEL CLAMP 3×/48h, que hasta este cambio NO EXISTÍA. `dailyQuota` lo implementa
        // desde el diseño v1 (§10) y nunca recibió el dato que pide —el cupo AUTORIZADO de hace dos
        // días— porque no se persistía en ningún lado. El proxy que se usó (los envíos reales) mide
        // otra cosa: está aplastado por el tope GLOBAL del daemon, así que frenaba a los sanos y
        // soltaba a los que no mandaron. Ahora el `sent` graba `detail.cupoDelDia` y esto lo lee.
        //
        // Va en el MISMO Promise.all que las otras, pero por la razón opuesta: las otras abortan la
        // vuelta porque su fallo es fail-OPEN sobre el volumen. Ésta sólo puede BAJAR el cupo, así
        // que su fallo no abre ninguna puerta — igual aborta, porque decidir volumen con media foto
        // es cómo se cuelan estos bugs.
        let cupoAutorizadoHace2Dias: Map<string, number>;
        let historial: UsoPrevio[];
        // El día de rampa sale del PRIMER ENVÍO REAL, no del historial recortado a 400 filas: ese
        // recorte hace que el día dependa del volumen de TODA la flota, y que RETROCEDA cuando
        // otros dominios mandan más.
        let primerEnvio: Map<string, string>;
        try {
          [frenados, enviadosPorDominio, historial, primerEnvio, mandadoHace2Dias, cupoAutorizadoHace2Dias] = await Promise.all([
            boxesSinCupoHoy(pg),
            enviosDeHoy(pg),
            historialDeEnvios(pg),
            primerEnvioPorDominio(pg),
            enviosDelDia(pg, 2),
            cupoAutorizadoVigente(pg, 2)
          ]);
        } catch (err) {
          log(`no pude leer el estado del día (${err instanceof Error ? err.message : String(err)}) — NO mando esta vuelta`);
          if (once) break;
          await dormirIntervalo();
          continue;
        }

        const elegido = elegirBoxDeLaVuelta({
          pool: poolElegido.boxes,
          rebotadosHoy: frenados,
          agotados,
          seq
        });
        if (elegido.box === null) {
          log(`PAUSA — los ${poolElegido.boxes.length} boxes del pool ya agotaron su cupo diario. Nada que enviar hoy.`);
          if (once) break;
          await dormirIntervalo();
          continue;
        }
        // Solo los del POOL: listar dominios que ni siquiera se están calentando es ruido que
        // hace parecer que el daemon intentó algo con ellos.
        const salteados = poolElegido.boxes.filter((b) => frenados.has(b));
        if (salteados.length > 0) {
          log(`${salteados.length} box(es) sin cupo hoy, salteados: ${salteados.join(", ")}`);
        }
        const box = elegido.box;

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
        let filasDelBox: FilaPlacement[];
        try {
          filasDelBox = await filasDePlacement(pg, box, cfg.placementWindow);
          delDia = decidirCupoDeHoy({
            diaN:
              progresoDeCalentamiento(
                primerEnvio.has(box)
                  ? [{ domain: box, seed: "", cuando: primerEnvio.get(box)! }, ...historial.filter((h) => h.domain === box)]
                  : historial,
                box,
                null
              )?.diasCorridos ?? 0,
            placements: filasDelBox.map((f) => f.placement),
            cupoFisico: capsFisicos.vencida ? null : capsFisicos.porDominio.get(box) ?? null,
            ...(mandadoHace2Dias.has(box) ? { cupoHace2Dias: mandadoHace2Dias.get(box)! } : {}),
            ...(cupoAutorizadoHace2Dias.has(box) ? { cupoAutorizadoHace2Dias: cupoAutorizadoHace2Dias.get(box)! } : {}),
            isoWeekday,
            limiteDiario: cfg.limiteDiario,
            pasoPorDia: cfg.pasoPorDia,
            soloDiasHabiles: cfg.soloDiasHabiles
          });
        } catch (err) {
          log(`no pude leer el placement de ${box} (${err instanceof Error ? err.message : String(err)}) — NO mando esta vuelta`);
          if (once) break;
          await dormirIntervalo();
          continue;
        }
        const enviadosHoyBox = enviadosPorDominio.get(box) ?? 0;
        // LA CIFRA DE PLACEMENT SALE CON SU RECEPTOR, y el veredicto de §3 al lado. El log del
        // daemon es lo que el jefe lee: sin el proveedor, "83% inbox" es 83%-EN-GMAIL presentado
        // como placement a secas, con Outlook y Yahoo en punto ciego.
        //
        // EL GATE SOLO INFORMA. No entra a `decidirCupoDeHoy` ni cambia un cupo: el motor vigente
        // sigue decidiendo con `PISO_SANO`/`PISO_CRITICO`, y esta línea es la que hace visible la
        // distancia entre las dos varas.
        const evidencia = medirPorProveedor(filasDelBox, (s) => proveedorDeSemilla.get(s) ?? null);
        // `cruzoUmbralPermanente` NO ES OPCIONAL ACÁ, y el dato ya estaba en scope 170 líneas arriba
        // (`saludFlota`). Sin él, `evaluarGate` se salteaba su PRIMERA condición —la irreversible— y
        // este log imprimía "gate §3: pasa" sobre un dominio que ya cruzó el umbral permanente de
        // bulk sender de Gmail. `planDelDia` sí se lo pasa (plan-diario.ts), así que el mismo
        // dominio el mismo día tenía DOS veredictos opuestos en los dos lugares que el jefe lee, y
        // el que se equivocaba era éste. Reproducido con las funciones reales: 6 filas INBOX de
        // semilla Gmail dan "pasa" por este camino y "NO pasa (cruzó el umbral permanente…)" por el
        // del plan.
        const veredicto = evaluarGate({
          placement: evidencia,
          cruzoUmbralPermanente: (saludFlota?.get(box)?.cruzados ?? []).length > 0
        });
        // Y "pasa" SE DICE CON LO QUE NO SE MIRÓ. `sinInstrumento` son las condiciones de §3 que el
        // motor no puede evaluar (complaint rate, sostenido 2-3 días, listas negras, y los rebotes
        // cuando el MTA no reporta al receptor). Un "pasa" a secas habiendo dejado cuatro sin mirar
        // es exactamente "ausencia de dato = está bien", la confusión que este repo dice haber
        // cerrado. Sigue siendo informativo —no cambia un cupo— pero se lee como veredicto.
        log(
          `${box}: ${delDia.accion} · cupo ${delDia.cupo}/día (van ${enviadosHoyBox}) — ${delDia.motivo}` +
            ` · ${textoPlacement(evidencia)} · gate §3: ${veredicto.pasa ? "pasa" : `NO pasa (${veredicto.condicionQueFalla})`}` +
            (veredicto.sinInstrumento.length > 0 ? ` · ${veredicto.sinInstrumento.length} condiciones de §3 sin instrumento` : "")
        );
        if (enviadosHoyBox >= delDia.cupo) {
          seq += 1;
          // SE RECUERDA. Sin esto la rotación lo volvía a elegir cada 60 s hasta el cambio de día.
          agotados.add(box);
          if (once) break;
          // Si NINGÚN box del pool tiene cupo, se duerme el intervalo entero. Antes eran 60s
          // siempre: con el cupo por dominio (2) menor que el tope de vueltas (3) —el caso normal
          // del arranque de la rampa— el daemon giraba ~1400 veces al día haciendo consultas y
          // enterrando los WARN reales bajo miles de líneas de log.
          // El cupo de ESTE box no dice nada de los otros. Con `a.com` frenado (cupo 0) y `b.com`
          // sano con 35 de margen, la comparación `5 < 0` daba false y el daemon dormía 4 HORAS
          // con la flota libre. Se pregunta con la MISMA función que elige, y sobre `agotados` ya
          // actualizado: la pregunta anterior era `disponibles.length > 1`, o sea "¿queda otro
          // box?" en vez de "¿queda otro box con cupo?", y con el pool agotado siempre decía sí.
          const siguiente = elegirBoxDeLaVuelta({
            pool: poolElegido.boxes,
            rebotadosHoy: frenados,
            agotados,
            seq
          });
          log(`${box} ya cumplió su cupo de hoy — se salta${siguiente.box ? "" : " (ningún box con cupo: espero el intervalo)"}`);
          // LAS DOS RAMAS CON JITTER. La de la derecha dormía `cfg.intervalMs` PELADO —90 min
          // clavados, sin el ±35%— y encima es la rama que DOMINA en producción: en el log hay 317
          // líneas "ya cumplió su cupo de hoy — se salta" contra 46 "vuelta #". O sea que el
          // metrónomo que `dormirIntervalo` existe para romper marcaba el compás justo antes de cada
          // ventana de envío, y §3 lista la cadencia de máquina entre los errores que queman.
          await sleep(Math.min(intervaloConJitter(cfg.intervalMs, Math.random()), siguiente.box ? 60_000 : Infinity));
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
          await sleep(Math.min(intervaloConJitter(cfg.intervalMs, Math.random()), 60_000));
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
          // La ENTRADA del clamp anti-firma: se graba en el `detail` del `sent` y la lee
          // `cupoAutorizadoVigente`. Sin esta línea el clamp del §10 sigue sin dato de entrada.
          cupoDelDia: delDia.cupo,
          // EL INSTRUMENTO NO SE ENTRENA. Con las dos semillas de producción, una mide limpio y la
          // otra conserva la señal; con una sola, esto degrada a no engagear (ver
          // `instrumentoDeMedicion`).
          engagear: semilla.address.trim().toLowerCase() !== instrumento,
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
              // Se IZA la lectura que ya se hacía adentro de `decidirCupoDeHoy`: son las mediciones
              // PROPIAS de este dominio, y `puedeMandarTurno` las necesita para no gastarle su
              // último envío del día en un "Re:" que no mide nada. Misma consulta, una sola vez.
              let propias: Placement[];
              try {
                propias = await placementsDeDominio(pg, hiloPrevio.nodeDomain, cfg.placementWindow);
                cupoDelHilo = decidirCupoDeHoy({
                  diaN:
                    progresoDeCalentamiento(
                      primerEnvio.has(hiloPrevio.nodeDomain)
                        ? [{ domain: hiloPrevio.nodeDomain, seed: "", cuando: primerEnvio.get(hiloPrevio.nodeDomain)! }, ...historial.filter((h) => h.domain === hiloPrevio.nodeDomain)]
                        : historial,
                      hiloPrevio.nodeDomain,
                      null
                    )?.diasCorridos ?? 0,
                  placements: propias,
                  cupoFisico: capsFisicos.vencida ? null : capsFisicos.porDominio.get(hiloPrevio.nodeDomain) ?? null,
                  ...(mandadoHace2Dias.has(hiloPrevio.nodeDomain)
                    ? { cupoHace2Dias: mandadoHace2Dias.get(hiloPrevio.nodeDomain)! }
                    : {}),
                  // El MISMO clamp que el ciclo principal. Omitirlo acá dejaría un camino de envío
                  // con una barrera menos, que es exactamente la forma del agujero que este bloque
                  // ya tuvo dos veces (la decisión del día y la exclusión por salud).
                  ...(cupoAutorizadoHace2Dias.has(hiloPrevio.nodeDomain)
                    ? { cupoAutorizadoHace2Dias: cupoAutorizadoHace2Dias.get(hiloPrevio.nodeDomain)! }
                    : {}),
                  isoWeekday,
                  limiteDiario: cfg.limiteDiario,
                  pasoPorDia: cfg.pasoPorDia,
                  soloDiasHabiles: cfg.soloDiasHabiles
                });
              } catch (err) {
                log(`hilo ${marca}: no pude leer el estado de ${hiloPrevio.nodeDomain}, no mando — ${err instanceof Error ? err.message : String(err)}`);
                continue;
              }
              const permiso = puedeMandarTurno({
                dominio: hiloPrevio.nodeDomain,
                rebotadosHoy: frenados,
                decision: cupoDelHilo,
                enviadosHoy: enviadosPorDominio.get(hiloPrevio.nodeDomain) ?? 0,
                medicionesPropias: propias.length,
                // El hilo sale de una consulta por SEMILLA, no del pool: sin esta línea, un dominio
                // que la salud excluyó (umbral cruzado, receptor cerrado, cola atascada) seguía
                // mandando un "Re:" real por vuelta.
                enElPool: poolElegido.boxes.includes(hiloPrevio.nodeDomain)
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
              // Se IZA fuera del try: la medición de abajo necesita su Message-ID, y adentro
              // del bloque el `const` moría antes de llegar.
              let enviado: SentMail;
              try {
              enviado = await mailerHilo.send({
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
                // `smtp` NO es decorado: es lo que nos hace visibles en nuestro propio libro.
                // `leerLibroPropio` busca los envíos por `detail->>'smtp' ILIKE '%queued as %'`, así
                // que un turno grabado sin la respuesta de Postfix no deja queue-id y la medición lo
                // atribuye al OTRO inquilino. Medido el 2026-08-06 contra la Postgres de producción:
                // de 36 filas `kind='sent'` en 7 días, 12 no tenían `smtp` — las 12 continuaciones,
                // el 33% de nuestro correo — y se concentran en los dominios que de verdad calientan
                // (corpfiling-infra.com, 6 de 19). Mismo bug de forma que ya pasó dos veces en este
                // loop: un segundo camino de envío que no replica lo que hace el primero
                // (warmup-live-cycle.ts, ① SEND).
                // `cupoDelDia` también acá: `cupoAutorizadoVigente` toma el MAX del día, así que con
                // el campo sólo en el ciclo principal un día que arrancara por una continuación
                // dejaría al clamp sin dato — y sin dato no clampea. Un camino de envío que no
                // replica lo que hace el otro es el mismo bug de forma que ya pasó tres veces acá.
                detail: { smtp: enviado.response, turno: turnos.length + 1, motivo: turno.motivo, generado: "modelo local", cupoDelDia: cupoDelHilo.cupo }
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
              // ESTE TURNO TAMBIÉN GASTÓ CUPO — y la pata que faltaba era continuación→continuación.
              //
              // El comentario de arriba (el del `set` del ciclo principal) declara cerrado el
              // sobrepaso "con cupo 2 salían 3, todos los días", pero solo cerró ciclo→continuación:
              // adentro de este `for` el Map se LEÍA (`enviadosPorDominio.get(...)` en la llamada a
              // `puedeMandarTurno`) y nunca se escribía. Con N hilos abiertos del MISMO dominio, los
              // N decidían contra la misma foto vieja y salían N correos reales por encima del cupo
              // del día. Reproducido con la función real: cupo 6, `enviadosHoy` 5 y 4 hilos ⇒ los 4
              // dan permiso ("tiene 1 de cupo libre hoy" cuatro veces) ⇒ 9 envíos contra cupo 6.
              // Y era alcanzable hoy: en la Postgres de producción hay una semilla con 8 hilos
              // abiertos del mismo dominio (trazosvercel@gmail.com / corpfiling-infra.com).
              //
              // VA DESPUÉS DEL SEND y antes de medir, con el mismo criterio que el ciclo principal:
              // solo cuenta lo que de verdad salió. El camino de error de arriba hace `break`, así
              // que acá el envío ya está grabado.
              enviadosPorDominio.set(hiloPrevio.nodeDomain, (enviadosPorDominio.get(hiloPrevio.nodeDomain) ?? 0) + 1);
              log(`hilo ${marca}: turno ${turnos.length + 1} enviado — "${turno.texto.slice(0, 60)}…"`);
              // ── Y SE MIDE, con el mismo lector que ya está abierto tres líneas más arriba ─────
              //
              // Hasta acá la continuación GASTABA cupo y no aportaba una sola fila `measured`: el
              // 45% de los envíos de corpfiling-infra.com no producía nada de la evidencia que
              // gobierna su propia rampa. Por eso `puedeMandarTurno` tuvo que prohibirle el turno a
              // todo dominio sin muestra — un parche sobre el agujero, no el agujero.
              //
              // La conexión IMAP es la misma de esta vuelta (`opsMedicion`), así que medir no
              // cuesta una conexión más: cuesta el polling, que es tiempo de espera del daemon y no
              // recurso de nadie.
              //
              // FALLA SUAVE, y a propósito: el correo YA salió y ya está grabado como `sent`. Si la
              // medición no llega, se graba MISSING igual que en el ciclo principal — el proveedor
              // lo aceptó y no apareció, que es un dato, no un error. Lo que no puede pasar es que
              // el turno se pierda del contador porque la medición falló.
              await medirTurnoDeHilo({
                ops: opsMedicion,
                enviado,
                subject: asuntoRe,
                recorder,
                base: { cycleId, boxDomain: hiloPrevio.nodeDomain, seedInbox: semilla.address },
                testId: hiloPrevio.testId,
                pollAttempts: cfg.pollAttempts,
                pollDelayMs: cfg.pollDelayMs,
                sleep,
                log: (m) => log(`hilo ${marca}: ${m}`)
              });
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
        await dormirIntervalo();
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
      await dormirIntervalo();
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

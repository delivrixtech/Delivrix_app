#!/usr/bin/env node
// EL AGENTE que mira el warmup 24/7, sobre el modelo local de la Mac mini.
//
//   node --env-file=config/gateway.env scripts/ops/warmup-monitor.ts            (una lectura)
//   node --env-file=config/gateway.env scripts/ops/warmup-monitor.ts --loop     (cada 10 min)
//
// Junta los HECHOS de la infraestructura real (semillas, vueltas con su placement, consumo del
// límite físico, estado de la flota), se los da al modelo, y guarda la lectura con su fecha y el
// modelo que la produjo. El panel lee ese JSON — nunca llama al modelo en el camino caliente.
//
// Corre local: costo cero, así que puede mirar siempre.

import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Pool } from "pg";

import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import { MONITOR_FILE, pedirLectura, type HechosWarmup } from "../../apps/gateway-api/src/agents/warmup-monitor.ts";
import { resumirRechazos } from "../../apps/gateway-api/src/agents/clasificar-rechazo.ts";
import { ejecutarAcciones, extraerAcciones, type Pendiente } from "../../apps/gateway-api/src/agents/acciones-agente.ts";
import {
  idDe,
  juzgar,
  lineasParaPrompt,
  registrar,
  type Bitacora
} from "../../apps/gateway-api/src/agents/bitacora-acciones.ts";
import {
  camposObservables,
  decidirSiHablar,
  mandarASlack,
  novedades,
  presupuestoDeAvances,
  recordarAviso,
  type MemoriaSlack
} from "../../apps/gateway-api/src/agents/slack.ts";
import { anotarPromesa, revisarPromesas, type Promesa } from "../../apps/gateway-api/src/agents/promesas.ts";
import { acusarRecibo, agruparParaContestar, avanzar, dondeResponder, estadoVacio, leerHilo, leerNuevos, miUserId, type EstadoLectura } from "../../apps/gateway-api/src/agents/slack-lectura.ts";
import { extraerRecordar, limpiarMaquinaria, limpiarParaSlack, responder } from "../../apps/gateway-api/src/agents/sentinel-chat.ts";
import {
  anotar as anotarConversacion,
  anotarReaccion,
  fallosSeguidos,
  lineasParaPrompt as memoriaParaPrompt,
  type MemoriaConversacion
} from "../../apps/gateway-api/src/agents/memoria-conversacion.ts";
import {
  lineasParaPrompt as decisionesParaPrompt,
  recordar as recordarDecision,
  type Decisiones
} from "../../apps/gateway-api/src/agents/decisiones-del-jefe.ts";
import { lineasParaPrompt as accionesParaPrompt } from "../../apps/gateway-api/src/agents/bitacora-acciones.ts";
import { flotaAtribuida, placementsDeDominio, planDelDia, rutaInventario } from "../../apps/warmup-engine/src/service/plan-diario.ts";
import { esInbox } from "../../apps/warmup-engine/src/domain/decision-diaria.ts";
import {
  ordenDelBarrido,
  REPUTACION_FILE,
  revisarReputacionDe,
  type ArchivoReputacion
} from "../../apps/gateway-api/src/agents/reputacion.ts";
import { createMxtoolboxAdapterFromEnv } from "../../packages/adapters/src/mxtoolbox-adapter.ts";
import {
  countCyclesToday,
  decideDaemonAction,
  recentPlacements,
  resolveLiveDaemonConfig
} from "../../apps/warmup-engine/src/service/live-warmup-daemon.ts";
import { CAP_MEASUREMENT_FILE, porEncimaDelTecho, type CapFlota } from "../../apps/gateway-api/src/node-daily-cap.ts";
import { leerSemillas, semillasActivas, semillasMedibles, puntoCiego } from "../../apps/gateway-api/src/warmup-seeds.ts";
import { MEASUREMENT_FILE, type MedicionFlota } from "../../apps/gateway-api/src/sender-measurement.ts";
import { leerInventarioFabrica } from "../../apps/gateway-api/src/sender-inventory.ts";

const PENDIENTES_FILE = "warmup-pendientes.json";
/**
 * LAS PROMESAS, en su propio archivo y no dentro de warmup-pendientes.json.
 *
 * No es prolijidad: los pendientes se escriben con `() => p` desde los DOS carriles —o sea,
 * pisando el archivo entero con la lista que cada uno tenía en memoria— así que meter las promesas
 * ahí garantiza perder escrituras cuando la guardia y el chat coinciden. Archivo aparte, dueño
 * aparte.
 */
const PROMESAS_FILE = "warmup-promesas.json";
/** Dónde vive la memoria de lo que HIZO (no de lo que dijo). Separada de MONITOR_FILE a propósito:
 *  ese se reescribe entero en cada vuelta y ya pesa 27 KB, y el panel lo sirve completo. */
const BITACORA_FILE = "warmup-acciones.json";
/** La memoria de lo que YA le dijo a Juanes: sin esto repetiría el mismo aviso cada 10 minutos. */
const SLACK_FILE = "warmup-slack.json";
/** Hasta dónde leyó el chat. El cursor ES el dedupe: sin él, al reiniciar re-contesta todo. */
const CHAT_FILE = "warmup-chat.json";
/**
 * Cada cuánto lee Slack el carril de chat.
 *
 * Eran 20s y era TIEMPO MUERTO PURO: el jefe escribía y en el peor caso pasaban 20 segundos antes
 * de que el agente siquiera leyera. Medido de punta a punta, una respuesta tarda 35-55s y de eso
 * ~10 de promedio era esta espera.
 *
 * Es una CONSTANTE y el log la imprime, en vez de un número escrito a mano en el mensaje: ese
 * texto decía "cada 20s" después de bajarlo a 6 — un log que miente sobre su propia configuración
 * es la forma más barata de perder una hora persiguiendo un fantasma.
 */
const MS_ENTRE_LECTURAS_DE_CHAT = 6_000;

/**
 * LA MEMORIA DE LO QUE SE HABLÓ. Hasta hoy warmup-chat.json guardaba SOLO un cursor: cada
 * conversación se olvidaba apenas se contestaba, y por eso el agente contestó cuatro veces casi lo
 * mismo en el hilo ...393 entre las 03:28 y las 03:31 — no tenía forma de saber qué acababa de
 * decir. Techo estructural de ~25 KB (40 intercambios FIFO + 12 temas), no una promesa.
 */
const CONVERSACION_FILE = "warmup-conversacion.json";

/** Lo que el jefe YA decidió. Gana sobre cualquier hecho que lo contradiga. */
const DECISIONES_FILE = "decisiones-del-jefe.json";
/**
 * ¿Este mensaje lo escribió JUANES, o solo alguien del canal?
 *
 * La diferencia importa porque `ordenadoPorElJefe` relaja el alcance del freno: con él, el agente
 * puede frenar un dominio SANO —algo que por su cuenta no puede hacer— y pausar el warmup entero.
 * Estaba fijo en `true` para cualquiera que escribiera. Que hoy el canal tenga una sola persona no
 * es un control de acceso, es una coincidencia: el día que entre Esaú o Estefanía heredan la
 * autoridad del dueño sin que nadie lo haya decidido.
 *
 * Sin la variable configurada devuelve `false`: alcance acotado para todos. Es la dirección
 * correcta de fallo — una variable mal puesta deja al agente con MENOS permiso, nunca con más.
 */
function esElJefe(usuario: string | undefined): boolean {
  const jefe = process.env.SLACK_JUANES_USER_ID?.trim();
  return Boolean(jefe && usuario && usuario.trim() === jefe);
}

/** El MISMO kill-file que mira el daemon en cada vuelta. Se revierte con `rm`. */
const KILL_FILE = (process.env.WARMUP_LIVE_KILL_FILE ?? resolve(process.cwd(), "runtime/warmup-live.kill")).trim();

/**
 * ¿El agente puede frenar nodos por sí solo?
 *
 * Apagado por defecto, y a propósito: frenar toca la flota de producción por SSH. Con el flag en
 * off el agente igual DECIDE y queda registrado qué habría hecho — que es exactamente cómo se mira
 * una semana si decide bien antes de darle la llave. Mismo patrón de dry-run que `limite-fisico`.
 */
const puedeFrenar = (process.env.WARMUP_AGENT_PUEDE_FRENAR ?? "").trim().toLowerCase() === "true";

/** El cupo instalado hoy en el nodo de un dominio, según el ARCHIVO de medición. Puede tener horas. */
async function capActual(workspace: OpenClawWorkspace, dominio: string): Promise<number | null> {
  const cap = await workspace.readInventoryJson<CapFlota>(CAP_MEASUREMENT_FILE).catch(() => null);
  return cap?.nodos.find((n) => n.domain === dominio)?.cap ?? null;
}

/**
 * El cupo REAL del nodo, leído por SSH, justo antes de tocarlo.
 *
 * Es el "antes" que se usa para decidir si la acción hizo algo (`antes === 0` ⇒ ya estaba frenado,
 * no se reporta como acción nueva). Leerlo del archivo era un bug con consecuencia visible: el
 * archivo se refresca cada 6h, así que el agente frenó bizreport-control.com una y otra vez toda
 * la noche del 2026-08-06 —el nodo ya estaba en 0 desde la primera— y cada intento le mandaba a
 * Juanes un "el freno no pegó, mirá el nodo". El nodo estaba perfecto; la foto era vieja.
 *
 * Si el SSH falla se cae al archivo: un "antes" impreciso es peor que uno bueno, pero mucho mejor
 * que no poder frenar un dominio porque no se pudo leer su cupo.
 */
async function capAntesDeTocar(workspace: OpenClawWorkspace, dominio: string): Promise<number | null> {
  try {
    const vivo = await leerCupoDelNodo(dominio);
    if (vivo.cap !== null) return vivo.cap;
  } catch {
    /* el SSH puede fallar; abajo se cae al archivo */
  }
  return capActual(workspace, dominio);
}

/**
 * Pone cap 0 en el nodo de un dominio, por el MISMO camino que usa el operador a mano
 * (`limite-fisico.ts --frenar --apply`). Reusar el script y no reimplementar el plan SSH es
 * deliberado: si el plan cambia, cambia para los dos, y no hay una segunda versión del freno que
 * se quede vieja sin que nadie lo note.
 */
async function frenarNodo(dominio: string, motivo: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(
    process.execPath,
    ["--env-file=config/gateway.env", "--experimental-strip-types", "scripts/ops/limite-fisico.ts", `--domain=${dominio}`, "--frenar", "--apply"],
    { cwd: process.cwd(), timeout: 120_000 }
  );
  console.log(`[agente] frenó ${dominio}: ${motivo}`);
}

/**
 * ¿El agente puede SOLTAR nodos por sí solo?
 *
 * Separado de `PUEDE_FRENAR` a propósito, y no por simetría: frenar solo REDUCE, soltar AUMENTA
 * volumen. Son riesgos de naturaleza distinta y el operador tiene que poder darle uno sin el otro.
 */
const puedeSoltar = (process.env.WARMUP_AGENT_PUEDE_SOLTAR ?? "").trim().toLowerCase() === "true";

/**
 * SUELTA un nodo frenado instalando un cupo chico, por el MISMO camino del operador a mano
 * (`limite-fisico.ts --domain=X --cap=N --apply`).
 *
 * El cupo llega como parámetro pero NO lo elige el modelo: viene de `CAP_AL_SOLTAR`, una constante.
 * Las condiciones que habilitan la llamada se verificaron antes en `acciones-agente.ts`, contra la
 * infraestructura viva y no contra lo que el agente cree.
 */
async function soltarNodo(dominio: string, cap: number, motivo: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(
    process.execPath,
    ["--env-file=config/gateway.env", "--experimental-strip-types", "scripts/ops/limite-fisico.ts", `--domain=${dominio}`, `--cap=${cap}`, "--apply"],
    { cwd: process.cwd(), timeout: 120_000 }
  );
  console.log(`[agente] soltó ${dominio} con cupo ${cap}: ${motivo}`);
}

/**
 * VA A MIRAR el cupo real de un nodo, ahora, por SSH. No escribe nada.
 *
 * Es lo que le faltaba para dejar de afirmar sobre una foto vieja: el agente dijo
 * "bizreport-control.com sigue con cupo 255" leyendo sender-cap.json de horas, cuando el nodo
 * real ya estaba en 0 porque él mismo lo había frenado.
 *
 * Se reusa `limite-fisico.ts --status`, el MISMO camino que usa el operador a mano: si el plan
 * SSH cambia, cambia para los dos y no hay una segunda versión que se quede vieja.
 */
async function leerCupoDelNodo(dominio: string): Promise<{ cap: number | null; consumidoHoy: number | null; motivo?: string | null }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--env-file=config/gateway.env", "--experimental-strip-types", "scripts/ops/limite-fisico.ts", `--domain=${dominio}`, "--status"],
    { cwd: process.cwd(), timeout: 90_000 }
  );
  // La línea del status trae "FRENADO (cap 0)" o "cap N/día". Se parsea de la salida real y no se
  // reimplementa el comando: una segunda implementación del parseo es una segunda verdad.
  const linea = stdout.split("\n").find((l) => l.includes(dominio)) ?? "";
  const frenado = /FRENADO \(cap 0\)/.test(linea);
  const mCap = linea.match(/cap (\d+)\/día/);
  const mUso = linea.match(/(\d+)\/(\d+|\?)/);
  return {
    cap: frenado ? 0 : mCap ? Number(mCap[1]) : null,
    consumidoHoy: /sin contador hoy/.test(linea) ? null : mUso ? Number(mUso[1]) : null,
    motivo: /no se pudo|error/i.test(linea) ? linea.trim().slice(0, 120) : null
  };
}

/**
 * LA MANO DE REPUTACIÓN, cableada de verdad.
 *
 * Existía el módulo (`reputacion.ts`), existía la acción en la lista blanca, y NO estaba enganchada:
 * o sea, el prompt le prometía al modelo una palanca que respondía "no está habilitado". Es la
 * falla que este repo ya pagó dos veces —pausar_warmup fue un no-op durante semanas— y la que el
 * brief del equipo prohibía explícitamente. La dejo cableada acá.
 *
 * Los cuatro insumos van desde AFUERA porque el módulo no lee un solo archivo ni abre una sola
 * conexión por su cuenta: así se puede testear entero sin red. DNS sale de node:dns, y las listas
 * negras del adaptador de MXToolbox que el gateway ya usa para la pestaña Reputación.
 *
 * LO QUE NO SE HACE, Y ES LO IMPORTANTE: si MXToolbox no está configurado, la consulta devuelve
 * `estado: "error"`, nunca `"clean"`. El 2026-07-25 este sistema tenía 38 nodos cerrados en Gmail
 * mientras el chequeo de blacklists decía "0" — y alguien leyó ese cero como "está limpio". Una
 * lista negra que no se pudo consultar es un "no sé"; disfrazarlo de limpio es fabricar evidencia
 * sobre lo único que puede quemar una IP sin aviso.
 */
function revisarReputacionDelDominio(inventario: { bandejas?: Array<{ domain?: string; serverIp?: string | null }> } | null) {
  const mx = createMxtoolboxAdapterFromEnv(process.env);
  return async (dominio: string) => {
    const dns = await import("node:dns/promises");
    const b = (inventario?.bandejas ?? []).find((x) => (x.domain ?? "").toLowerCase() === dominio.toLowerCase());
    return revisarReputacionDe({
      dominio,
      // Sin binding no hay IP, y eso NO es un caso raro: hay dominios con credencial y sin nodo.
      // Sale como "no sé" desde el módulo, que ya lo distingue de "limpio".
      ip: b?.serverIp ?? null,
      resolveTxt: (fqdn) => dns.resolveTxt(fqdn),
      reverse: (ip) => dns.reverse(ip),
      resolve4: (host) => dns.resolve4(host),
      blacklist: async (ip) => {
        if (!mx) return { estado: "error" as const, listas: [] };
        const r = await mx.lookup({ target: ip, command: "blacklist" });
        const est = r.summary?.status;
        return {
          estado: est === "clean" || est === "warning" || est === "listed" ? est : ("error" as const),
          listas: [...(r.summary?.failedChecks ?? []), ...(r.summary?.warningChecks ?? [])]
        };
      }
    });
  };
}

/**
 * MIDE un dominio contra la base: dónde viene cayendo su correo y en qué día de rampa está.
 *
 * Existe por un agujero preciso: los hechos ya traen el placement de cada dominio, pero SOLO de los
 * que están en el pool. Un dominio frenado o excluido no aparece en ninguna parte del contexto — y
 * son exactamente los que hay que evaluar para decidir si vuelven. El agente quedaba a ciegas justo
 * en los casos que importaban.
 *
 * Reusa `placementsDeDominio`, la MISMA lectura que usa el motor para decidir volumen: si el
 * criterio cambia, cambia para los dos.
 */
function medirUnDominio(pg: Pool) {
  return async (dominio: string): Promise<{ tasaInbox: number | null; muestra: number; diaN: number | null; ultimaMedicion: string | null }> => {
    const placements = await placementsDeDominio(pg, dominio, VENTANA_MEDIDA_DOMINIO);
    const { rows } = await pg.query<{ ultima: Date | null; primera: Date | null }>(
      `SELECT max(occurred_at) FILTER (WHERE kind = 'measured' AND placement IS NOT NULL) AS ultima,
              min(occurred_at) FILTER (WHERE kind = 'sent')                               AS primera
         FROM warmup_activity WHERE lower(node_domain) = lower($1)`,
      [dominio]
    );
    const primera = rows[0]?.primera ?? null;
    return {
      tasaInbox: placements.length > 0 ? placements.filter(esInbox).length / placements.length : null,
      muestra: placements.length,
      // El día de rampa sale del PRIMER ENVÍO REAL de este dominio. `null` cuando nunca mandó, que
      // no es lo mismo que "día 0": uno nunca arrancó, el otro arrancó hoy.
      diaN: primera ? Math.floor((Date.now() - primera.getTime()) / 86_400_000) : null,
      ultimaMedicion: rows[0]?.ultima ? (rows[0].ultima as Date).toISOString().slice(0, 16).replace("T", " ") : null
    };
  };
}

/** Ventana de mediciones para juzgar UN dominio. Más ancha que la del gate: acá se busca historia. */
const VENTANA_MEDIDA_DOMINIO = 10;

/**
 * DIAGNOSTICA un dominio: lee el mail.log de su nodo y devuelve quién lo rechaza y por qué.
 * Pasivo — no manda un solo correo. Reusa deliverability-health.ts, el mismo camino del operador.
 */
async function diagnosticarUnDominio(dominio: string): Promise<{
  estado: string;
  bloqueanPor: string[];
  degradadoEn: string[];
  entregados: number;
  rechazados: number;
  detalle: string;
}> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--env-file=config/gateway.env", "--experimental-strip-types", "scripts/ops/deliverability-health.ts", `--domain=${dominio}`, "--json"],
    { cwd: process.cwd(), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
  );
  const filas = JSON.parse(stdout) as Array<{
    node?: { domain?: string };
    verdict?: {
      status?: string;
      blockedProviders?: string[];
      degradedProviders?: string[];
      detail?: string;
      stats?: { total?: { delivered?: number; blocked?: number } };
    };
  }>;
  const f = filas.find((x) => x.node?.domain?.toLowerCase() === dominio.toLowerCase()) ?? filas[0];
  if (!f?.verdict) throw new Error(`sin datos de ${dominio} (¿está en el inventario con nodo asignado?)`);
  const v = f.verdict;
  return {
    estado: v.status ?? "desconocido",
    bloqueanPor: v.blockedProviders ?? [],
    degradadoEn: v.degradedProviders ?? [],
    entregados: v.stats?.total?.delivered ?? 0,
    rechazados: v.stats?.total?.blocked ?? 0,
    detalle: (v.detail ?? "").slice(0, 200)
  };
}

/**
 * ¿Hay un daemon emisor vivo en esta máquina? Es el único modo honesto de saberlo desde acá: el
 * flag que lo habilita vive en el entorno de ESE proceso, no en gateway.env. Y un daemon que
 * arranca sin el flag sale de inmediato, así que estar vivo equivale a estar habilitado.
 */
async function daemonVivo(): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("pgrep", ["-f", "live-warmup-daemon"], { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false; // pgrep sale 1 cuando no encuentra nada: no hay daemon
  }
}

const LOOP = process.argv.includes("--loop");
const INTERVALO_MS = Number.parseInt(process.env.WARMUP_MONITOR_INTERVAL_MS ?? "", 10) || 10 * 60_000;

/** Junta los hechos. Todo de fuentes reales; lo que no se puede leer queda en null, no en cero. */
async function reunirHechos(workspace: OpenClawWorkspace, pg: Pool): Promise<HechosWarmup> {
  const { seeds } = await leerSemillas(workspace);

  const cap = await workspace.readInventoryJson<CapFlota>(CAP_MEASUREMENT_FILE).catch(() => null);
  const med = await workspace.readInventoryJson<MedicionFlota>(MEASUREMENT_FILE).catch(() => null);

  // ¿EL EMISOR ESTÁ MANDANDO O NO? Era el hecho que más le faltaba: el agente reportó
  // "RIESGO: ninguno" mientras el daemon llevaba horas en placement-pause. Un vigilante que no ve
  // el interruptor de lo que vigila no puede ni vigilar ni prevenir.
  // Se REUSA `decideDaemonAction`, la misma función que decide de verdad en el daemon: si esto se
  // recalculara acá, el día que cambie una barrera el agente informaría un estado que no existe.
  const emisor = await (async () => {
    try {
      const cfg = resolveLiveDaemonConfig(process.env);
      // `enabled` NO sale del entorno de ESTE proceso. WARMUP_LIVE_ENABLE se le inyecta solo al
      // daemon (servicio.sh warmup-daemon), no vive en gateway.env: el monitor leyendo su propio
      // entorno siempre veía false y el agente afirmaba "el emisor está inerte" con el emisor
      // mandando. Lo detecté porque la primera corrida con este cambio dijo exactamente eso.
      // El hecho verificable es EXTERNO: ¿hay un daemon vivo? Si arrancó sin el flag habría
      // salido en el acto (INERTE → return), así que estar vivo ES estar habilitado.
      const vivo = await daemonVivo();
      const [ciclosHoy, placements] = await Promise.all([
        countCyclesToday(pg as never),
        recentPlacements(pg as never, cfg.placementWindow)
      ]);
      const { action, reason } = decideDaemonAction({
        enabled: vivo,
        killed: existsSync(cfg.killFile),
        cyclesToday: ciclosHoy,
        maxPerDay: cfg.maxPerDay,
        recentPlacements: placements,
        placementFloor: cfg.placementFloor
      });
      return { estado: action, motivo: reason, vueltasHoy: ciclosHoy, topeDiario: cfg.maxPerDay };
    } catch {
      return null; // sin este dato el agente sigue, pero sabiendo que no lo tiene
    }
  })();

  // Las vueltas salen de warmup_activity, que es lo único vivo y real que hay en Postgres.
  let vueltas: HechosWarmup["vueltas"] = [];
  try {
    const { rows } = await pg.query<{
      cycle_id: string;
      node_domain: string;
      seed_inbox: string;
      occurred_at: Date;
      kinds: string[];
      placement: string | null;
      detail: unknown;
    }>(
      `SELECT cycle_id, max(node_domain) AS node_domain, max(seed_inbox) AS seed_inbox,
              max(occurred_at) AS occurred_at,
              array_agg(kind) AS kinds,
              max(placement) FILTER (WHERE placement IS NOT NULL) AS placement,
              max(detail::text) FILTER (WHERE kind = 'error') AS detail
       FROM warmup_activity
       GROUP BY cycle_id
       ORDER BY max(occurred_at) DESC
       LIMIT 8`
    );
    vueltas = rows.map((r) => {
      let error: string | null = null;
      if (r.detail) {
        try {
          const d = JSON.parse(String(r.detail)) as { stage?: string; note?: string };
          error = [d.stage, d.note].filter(Boolean).join(": ") || "error";
        } catch {
          error = "error";
        }
      }
      return {
        dominio: r.node_domain,
        semilla: r.seed_inbox,
        cuando: new Date(r.occurred_at).toISOString(),
        placement: r.placement,
        completa: (r.kinds ?? []).includes("replied"),
        error
      };
    });
  } catch {
    vueltas = [];
  }

  return {
    generadoEn: new Date().toISOString(),
    emisor,
    semillas: {
      destinos: semillasActivas(seeds).length,
      midiendo: semillasMedibles(seeds).length,
      puntoCiego: puntoCiego(seeds)
    },
    // NO se suman los caps de los 58 nodos. El cap de Postfix es POR NODO: un nodo en su tope no
    // frena a los otros 57, así que "154998 vueltas de la flota" era un número que no existe en
    // ninguna parte — y fue la conclusión central del agente en 8 de 11 corridas. Peor: 44 de los
    // 58 nodos tienen consumidoHoy=null (sin medir) y el `?? 0` los contaba como cero, o sea que
    // el numerador mezclaba el consumo de 14 nodos contra el tope de 58.
    cap: cap
      ? {
          nodosMedidos: cap.nodos.filter((n) => n.consumidoHoy !== null).length,
          nodosSinMedir: cap.nodos.filter((n) => n.consumidoHoy === null).length,
          enElTope: cap.nodos.filter((n) => n.cap && n.consumidoHoy !== null && n.consumidoHoy >= n.cap).map((n) => n.domain),
          // LOS FRENADOS: cap 0. Faltaban por completo, y sin ellos la mano de soltar era decorativa
          // — los dominios frenados no están en el plan (el pool excluye cap 0) ni en las vueltas
          // (no mandan), así que NINGUNO llegaba a `dominiosConocidos` y `soltar_dominio` los
          // rechazaba a todos con "no está en el inventario". El agente tenía la palanca y no tenía
          // a quién aplicársela.
          frenados: cap.nodos.filter((n) => n.cap === 0).map((n) => n.domain),
          sinLimite: cap.nodos.filter((n) => !n.cableado).length,
          // LOS QUE ESTÁN CERCA DEL UMBRAL Y ADEMÁS TIENEN EL NODO CABLEADO POR ENCIMA DEL TECHO.
          // Sale con el cap AL LADO del nombre, y no es cosmético: con la lista de nombres sola el
          // aviso decía "tiene el cupo del nodo por encima del techo que aguanta el dominio" y la
          // respuesta textual del jefe fue "No entiendo, es decir ?". Los dos números —15.000
          // cableado contra 2.000 de techo— son lo único que convierte ese mensaje en una acción.
          porEncimaDelTecho: med
            ? porEncimaDelTecho({
                cerca: med.bandejas
                  .filter((b) => (b.cerca ?? []).length > 0 && (b.cruzados ?? []).length === 0)
                  .map((b) => b.domain),
                nodos: cap.nodos
              })
            : [],
          // La FECHA viaja con el dato: sin ella el agente reportaba un cap de ayer como si fuera
          // de hoy, y la regla "si un dato está viejo, decilo" no tenía con qué cumplirse.
          medidoEn: cap.medidoEn ?? null
        }
      : null,
    // LA REPUTACIÓN, si el barrido ya la escribió. AUSENTE si el archivo no está — no `{}` ni `[]`:
    // las reglas que la miran tienen que dar SILENCIO, jamás "está limpio". Es la confusión más
    // cara del sistema y ya costó 38 nodos cerrados en Gmail leídos como sanos porque el chequeo de
    // listas negras decía cero.
    ...(await workspace
      .readInventoryJson<ArchivoReputacion>(REPUTACION_FILE)
      .then((r) => (r && Array.isArray(r.dominios) ? { reputacion: r.dominios as never } : {}))
      .catch(() => ({}))),
    flota: med
      ? {
          sanas: med.bandejas.filter((b) => b.estado === "healthy").length,
          bloqueadas: med.bandejas.filter((b) => b.estado === "blocked_by_provider").length,
          atascadas: med.bandejas.filter((b) => b.estado === "stalled").length,
          cruzados: med.bandejas.filter((b) => (b.cruzados ?? []).length > 0).map((b) => b.domain),
          // `cerca` EXCLUYE a los que ya cruzaron: estaban en las dos listas y el agente los
          // contaba dos veces ("cinco más están cerca" y después listaba cuatro).
          cerca: med.bandejas
            .filter((b) => (b.cerca ?? []).length > 0 && (b.cruzados ?? []).length === 0)
            .map((b) => b.domain),
          // ¿La salud se juzgó con correo NUESTRO? Hoy no: el 99,9% del log es de NFC. Entra como
          // dato para que el agente lo pueda decir, nunca como gate que lo deje sin manos.
          // El Map se arma acá y no se importa de otro lado: `flotaAtribuida` es puro sobre él.
          atribuido: flotaAtribuida(new Map(med.bandejas.map((b) => [b.domain, b as never]))),
          // La FECHA viaja con el dato, igual que en el cap. Sin esto el agente reportaba un
          // retrato de hace 23 h como si fuera de ahora, 11 de 11 veces.
          medidoEn: med.medidoEn ?? null
        }
      : null,
    vueltas,
    // EL PLAN: la decisión que el motor ya tomó. Sin esto el agente opinaba sobre el volumen sin
    // saber qué se había decidido, y proponía cosas que el sistema ya estaba haciendo.
    // saludFile es la línea de más valor de todo el bloque: sin ella el plan traía los 51
    // dominios del registro y el agente opinaba sobre 43 que el daemon EXCLUYE (cerrados por el
    // receptor, con la cola atascada o ya cruzados). Esas 43 líneas eran idénticas salvo el
    // nombre —"arrancar, cupo 2/día, día ?, SIN MEDIR"— y ahogaron la única con señal real
    // (corpfiling-infra.com, 83% de inbox sobre 6 muestras, listo para subir): el agente no la
    // mencionó ni una vez en 11 corridas. Con esto mira el MISMO pool que ejecuta el daemon.
    plan: await planDelDia({
      pg,
      capFile: rutaInventario("sender-cap.json"),
      saludFile: rutaInventario("sender-measurement.json"),
      poolConfigurado: [],
      ventanaPlacement: 6
    })
      .then((p) =>
        p.dominios.map((d) => ({
          dominio: d.dominio,
          diaN: d.diaN,
          placementTasa: d.placement.tasa,
          placementMuestra: d.placement.muestra,
          cupo: d.decision.cupo,
          accion: d.decision.accion,
          motivo: d.decision.motivo,
          enviadosHoy: d.enviadosHoy
        }))
      )
      .catch(() => undefined),
    // Rechazos YA clasificados: de quién es cada freno. Pasarle la cadena cruda fue lo que llevó
    // al agente a decir "los límites diarios de Gmail" sobre nuestro propio cap de Postfix.
    rechazos: resumirRechazos(vueltas.map((v) => v.error)),
    // EL VECINDARIO de cada dominio del pool. Se calcula acá, del inventario real + la medición:
    // agrupar por /24 y contar cuántos vecinos NO están sanos. Es el criterio que descartó a
    // corpregistry-ops.com (11 de 13 vecinos cerrados por el receptor) aunque él estuviera sano.
    vecindarios: await (async () => {
      try {
        const inv = await leerInventarioFabrica({ workspace });
        const estado = new Map((med?.bandejas ?? []).map((b) => [b.domain, b.estado]));
        const por24 = new Map<string, Array<{ dominio: string; sano: boolean }>>();
        for (const b of inv.bandejas) {
          if (!b.serverIp) continue;
          const s24 = b.serverIp.split(".").slice(0, 3).join(".");
          const lista = por24.get(s24) ?? [];
          lista.push({ dominio: b.domain, sano: estado.get(b.domain) === "healthy" });
          por24.set(s24, lista);
        }
        // Solo los dominios que están calentando: el vecindario de los otros 51 es ruido.
        const delPool = new Set((cap?.nodos ?? []).filter((n) => (n.cap ?? 0) > 0).map((n) => n.domain));
        const out: Array<{ dominio: string; subred: string; nodos: number; noSanos: number }> = [];
        for (const [s24, vecinos] of por24) {
          for (const v of vecinos) {
            if (!delPool.has(v.dominio)) continue;
            out.push({ dominio: v.dominio, subred: s24, nodos: vecinos.length, noSanos: vecinos.filter((x) => !x.sano).length });
          }
        }
        return out;
      } catch {
        return undefined;
      }
    })(),
    // Dónde el canal de volumen no leyó. `picos` vacío = NO MEDIDO, que no es lo mismo que cero:
    // en los 12 nodos Webdock nunca lee, y ahí la cercanía al umbral es desconocida.
    sinMedirVolumen: (med?.bandejas ?? []).filter((b) => (b.picos ?? []).length === 0).map((b) => b.domain),
    // Los pendientes CON su id: sin esto el agente no podía cerrarlos nunca (la acción existía,
    // pero él no veía ningún id que pasarle) y la lista solo crecía.
    pendientesAbiertos: (
      (await workspace.readInventoryJson<Pendiente[]>(PENDIENTES_FILE).catch(() => [])) ?? []
    )
      .filter((p) => !p.resueltoEn)
      .map((p) => ({ id: p.id, que: p.que }))
  };
}

async function unaVuelta(workspace: OpenClawWorkspace, pg: Pool): Promise<void> {
  const baseUrl = process.env.LOCAL_INFERENCE_BASE_URL?.trim();
  const modelo = process.env.LOCAL_INFERENCE_MODEL?.trim();
  if (!baseUrl || !modelo) {
    console.error("faltan LOCAL_INFERENCE_BASE_URL / LOCAL_INFERENCE_MODEL en el entorno.");
    process.exit(1);
  }

  const hechos = await reunirHechos(workspace, pg);

  // MEMORIA DEL AGENTE: los reparos que la verificación le encontró la vez pasada entran al
  // prompt de esta vez. No se puede reentrenar el modelo, pero mostrarle su propio error es la
  // forma barata y honesta de que no lo repita — y sin esto lo repetiría cada 10 minutos, para
  // siempre, que es exactamente lo que pasó con "los límites diarios de Gmail".
  const previa = await workspace
    .readInventoryJson<{
      generadoEn?: string;
      verificacion?: { reparos?: string[] };
      memoria?: string[];
      /**
       * EL RETRATO de la vuelta anterior, no sus hechos. Es lo que permite decir "esto cambió".
       *
       * Se persiste el retrato y NO se reconstruye desde `previa.hechos` por una razón medida: los
       * hechos traen las vueltas con LIMIT 8, así que un dominio que no entró en esa ventana
       * aparecería "sin medir" y el diff lo leería como "sin medir → INBOX". Fabricaría avances.
       */
      campos?: Record<string, string | number | null>;
    }>(MONITOR_FILE)
    .catch(() => null);
  // ACUMULA, no reemplaza. Antes la memoria era la lectura anterior y nada más: si el agente
  // acertaba una vuelta, los reparos quedaban en [] y el recuerdo del error se BORRABA — el mismo
  // error volvía cada dos vueltas, para siempre. Tope de 5 (lo que el prompt muestra) y sin
  // duplicados.
  const erroresPrevios = [...new Set([...(previa?.memoria ?? []), ...(previa?.verificacion?.reparos ?? [])])].slice(-5);

  // LO QUE PIDIÓ ANTES Y QUÉ PASÓ. Sin esto repitió la misma acción 10 veces en 2 horas: cada
  // vuelta arrancaba sin saber que ya la había pedido ni que se la habían negado.
  const bitacoraPrevia = await workspace.readInventoryJson<Bitacora>(BITACORA_FILE).catch(() => null);
  const loQueHiciste = lineasParaPrompt(bitacoraPrevia, 8);

  const decisionesJefe = await workspace.readInventoryJson<Decisiones>(DECISIONES_FILE).catch(() => null);
  const lectura = await pedirLectura({
    hechos,
    baseUrl,
    modelo,
    erroresPrevios,
    loQueHiciste,
    // Lo que el jefe ya zanjó. Sin esto, el agente le vuelve a pedir cada 10 minutos lo mismo que
    // ya le dijo que no va a tener.
    decisiones: decisionesParaPrompt(decisionesJefe)
  });

  // ── LAS ACCIONES ─────────────────────────────────────────────────────────────────────────────
  // Un agente que solo informa es un termómetro caro. Acá ejecuta lo que decidió, dentro de una
  // lista blanca cerrada de acciones que únicamente REDUCEN (frenar, pausar) o ANOTAN.
  //
  // Y una barrera que no está en el módulo de acciones a propósito: si la verificación le encontró
  // reparos —dijo algo que no se sostiene contra los datos— NO se le ejecuta nada. Actuar sobre un
  // razonamiento que ya sabemos que tiene una afirmación falsa es la peor combinación posible.
  let acciones: Awaited<ReturnType<typeof ejecutarAcciones>> = [];
  const reparos = lectura.verificacion?.reparos ?? [];
  if (lectura.lectura && reparos.length === 0) {
    const pedidas = extraerAcciones(lectura.lectura);
    if (pedidas.length > 0) {
      // EJECUTAR NO PUEDE COSTAR LA VUELTA. El carril del chat ya tenía este guard; la guardia no.
      // Sin él, una acción que revienta —un SSH caído al armar el contexto, el workspace sin
      // permisos— sube y se lleva puestos el snapshot del panel, la decisión de hablar y la memoria
      // de reparos. El fallo se CUENTA como una acción más y NO va marcado reintentable: un disco
      // lleno o un permiso faltante no se arreglan solos en diez minutos.
      try {
      acciones = await ejecutarAcciones(pedidas, {
        // Solo los dominios que aparecen en los hechos: un nombre alucinado no llega a ejecutarse.
        // TODOS los dominios que aparecen en los hechos, no solo los del plan. Con la lista angosta
        // el agente decidió correctamente frenar `bizreport-control.com` (cruzó el umbral) y se lo
        // rechazamos por "no está en el inventario" — un rechazo FALSO, porque el dominio venía de
        // los propios hechos que le dimos. Una barrera que bloquea decisiones correctas entrena a
        // desconfiar de la barrera.
        dominiosConocidos: [
          ...new Set([
            ...(hechos.plan ?? []).map((p) => p.dominio),
            ...hechos.vueltas.map((v) => v.dominio),
            ...(hechos.flota?.cruzados ?? []),
            ...(hechos.flota?.cerca ?? []),
            ...(hechos.cap?.enElTope ?? []),
            // LOS FRENADOS son el sujeto entero de soltar_dominio. Sin esta línea la acción existía
            // y no alcanzaba a nadie: ninguno de ellos aparece en el plan ni en las vueltas.
            ...(hechos.cap?.frenados ?? [])
          ])
        ],
        // EL ALCANCE DEL FRENO: solo donde el daño YA está hecho. Un dominio que cruzó el umbral
        // permanente no tiene nada más que perder, y uno al que el receptor ya le cerró la puerta
        // tampoco está calentando. Frenar ahí solo puede ayudar. Frenar un dominio SANO cuesta
        // calentamiento real y es una decisión del operador — para eso está anotar_pendiente.
        frenablesConDanio: [
          ...new Set([...(hechos.flota?.cruzados ?? []), ...(hechos.cap?.enElTope ?? [])])
        ],
        // Leer el nodo NO muta nada: va habilitado siempre, sin flag. Es la mano que le permite
        // dejar de opinar sobre una foto y pasar a mirar.
        leerCupoNodo: leerCupoDelNodo,
        diagnosticarDominio: diagnosticarUnDominio,
        medirDominio: medirUnDominio(pg),
        // REPUTACIÓN: la mano que el operador pidió "sin excusas". Es pasiva —DNS + una consulta de
        // listas negras— así que no lleva flag. El inventario se lee acá y no adentro del módulo:
        // sin la IP del nodo no hay listas negras ni PTR que mirar, y eso sale como "no sé".
        revisarReputacion: revisarReputacionDelDominio(
          await leerInventarioFabrica({ workspace }).catch(() => null)
        ),
        // SOLTAR: la única acción que aumenta volumen, detrás de su PROPIO flag —
        //
        //   WARMUP_AGENT_PUEDE_SOLTAR=true   en config/gateway.env
        //
        // separado de PUEDE_FRENAR y no por simetría: frenar solo reduce, soltar aumenta. El
        // operador tiene que poder dar uno sin el otro. Las condiciones (nodo realmente en cap 0,
        // nadie bloqueándolo, historia propia que no lo desaconseje) se verifican en
        // `acciones-agente.ts` contra la infraestructura viva, y el cupo es una constante.
        ...(puedeSoltar
          ? {
              soltarDominio: async (dominio: string, cap: number, motivo: string) => {
                const antes = await capAntesDeTocar(workspace, dominio);
                await soltarNodo(dominio, cap, motivo);
                return { antes, despues: cap };
              }
            }
          : {}),
        // FRENAR toca la flota de producción por SSH (pone cap 0 en Postfix). Es reversible y solo
        // reduce, pero sigue siendo una mutación de infraestructura, así que va detrás de un flag
        // que el OPERADOR prende — no yo, y no por inferencia de que "quería que el agente actúe".
        //
        //   WARMUP_AGENT_PUEDE_FRENAR=true   en config/gateway.env
        //
        // Apagado, el agente igual DECIDE y lo deja registrado ("habría frenado X porque Y"), que
        // es la forma de mirar una semana cómo decide antes de darle la llave. Es el mismo patrón
        // de dry-run que usa `limite-fisico.ts`, por la misma razón.
        ...(puedeFrenar
          ? {
              frenarDominio: async (dominio: string, motivo: string) => {
                const antes = await capAntesDeTocar(workspace, dominio);
                await frenarNodo(dominio, motivo);
                return { antes, despues: 0 };
              }
            }
          : {}),
        // PAUSAR: el freno general. Estaba PROMETIDO en el prompt del agente y no cableado acá, o
        // sea que era un no-op: ante un cruce masivo del umbral el modelo pedía pausar, el módulo
        // respondía "no está habilitado en este entorno" y el warmup seguía andando. Prometerle una
        // palanca que no existe es peor que no dársela.
        //
        // Va al kill-file que el daemon YA respeta en cada vuelta, y se revierte con `rm`. Por eso
        // no necesita el flag de SSH: no toca ningún nodo.
        pausarWarmup: async (m: string) => {
          await writeFile(KILL_FILE, `${new Date().toISOString()} pausado por el agente: ${m}\n`, "utf8");
        },
        warmupPausado: async () => existsSync(KILL_FILE),
        pendientes: {
          listar: async () => (await workspace.readInventoryJson<Pendiente[]>(PENDIENTES_FILE).catch(() => [])) ?? [],
          guardar: async (p) => {
            await workspace.updateInventoryJson(PENDIENTES_FILE, () => p);
          }
        }
      });
      } catch (e) {
        const motivo = e instanceof Error ? e.message : String(e);
        acciones = [{ accion: "(ninguna)", ejecutada: false, detalle: `no pude ejecutar lo que decidí: ${motivo}` }];
        console.error(`[agente] ejecutar acciones falló (sigo la vuelta): ${motivo}`);
      }
    }
  } else if (lectura.lectura && reparos.length > 0) {
    acciones = [{ accion: "(ninguna)", ejecutada: false, detalle: `no se ejecutó nada: la lectura tiene reparos (${reparos.join(" · ")})` }];
  }

  // LA BITÁCORA: cada acción decidida queda registrada, se haya ejecutado o no. Las rechazadas son
  // las que más importan — son las que el agente estaba repitiendo a ciegas.
  if (acciones.length > 0) {
    const cuando = lectura.generadoEn;
    await workspace.updateInventoryJson<Bitacora>(BITACORA_FILE, (actual) => {
      let bit = actual;
      for (const a of acciones) {
        if (a.accion === "(ninguna)") continue;
        const objetivo = a.objetivo ?? null;
        bit = registrar(bit, {
          accion: a.accion,
          objetivo,
          motivo: a.detalle ?? "",
          estado: a.ejecutada ? "ejecutada" : "rechazada",
          detalle: a.ejecutada ? null : (a.detalle ?? null),
          // El cap de HOY es contra lo que se juzga después si el freno sirvió.
          antes: typeof a.antes === "number" ? { cap: a.antes } : null,
          cuando
        });
      }
      return bit ?? { version: 1, entradas: [] };
    });
  }

  // Y se JUZGA lo que se ejecutó antes: comparar el estado de entonces contra el de ahora es lo
  // único que convierte "hice algo" en "aprendí algo".
  if (bitacoraPrevia) {
    // EL VEREDICTO SE PREGUNTA AL NODO, no al archivo. sender-cap.json puede tener horas, y juzgar
    // un freno contra una foto vieja produce el veredicto falso "no sirvió" sobre un freno que sí
    // quedó puesto — o peor, el agente repitiéndole al jefe un cupo que ya no existe.
    const pendientesDeJuicio = bitacoraPrevia.entradas.filter(
      (e) => e.estado === "ejecutada" && !e.veredicto && e.accion === "frenar_dominio" && e.objetivo
    );
    const capAhora = new Map<string, number | null>();
    for (const e of pendientesDeJuicio.slice(0, 3)) {
      try {
        const r = await leerCupoDelNodo(e.objetivo as string);
        capAhora.set(e.objetivo as string, r.cap);
      } catch {
        // Nodo incomunicado: NO se inventa un veredicto. Queda sin juzgar para la próxima vuelta.
      }
    }
    await workspace.updateInventoryJson<Bitacora>(BITACORA_FILE, (actual) => {
      let bit = actual ?? bitacoraPrevia;
      for (const e of bitacoraPrevia.entradas) {
        if (e.estado !== "ejecutada" || e.veredicto || e.accion !== "frenar_dominio" || !e.objetivo) continue;
        const cap = capAhora.get(e.objetivo);
        bit = juzgar(bit, idDe(e.accion, e.objetivo), { cuando: lectura.generadoEn, datos: { cap } }, (_antes, despues) => {
          const c = despues.cap;
          if (c === undefined) return null; // sin medición nueva no se inventa un veredicto
          return c === 0
            ? { cuando: "", resultado: "sirvio", medido: `${e.objetivo} quedó con cupo 0 en el nodo` }
            : { cuando: "", resultado: "no_sirvio", medido: `${e.objetivo} sigue con cupo ${String(c)}: el freno no quedó puesto` };
        });
      }
      return bit;
    });
  }

  // Se guarda SIEMPRE, con lectura o con motivo, y DESPUÉS de ejecutar: el panel tiene que poder
  // decir "el agente no pudo mirar" en vez de mostrar una lectura vieja, y tiene que ver qué hizo.
  // EL RETRATO Y EL DIFF. Orden crítico: `previa` se leyó ARRIBA y acá se pisa MONITOR_FILE. Si
  // alguna vez la escritura se mueve por encima de la lectura, el diff se compara contra sí mismo
  // y el agente no vuelve a contar un avance nunca — mudo otra vez, sin que ningún test lo note.
  const camposAntes = previa?.campos ?? {};
  const camposAhora = camposObservables(hechos, camposAntes);

  await workspace.updateInventoryJson(MONITOR_FILE, () => ({
    ...lectura,
    acciones,
    campos: camposAhora,
    // La memoria se persiste con la lectura: es lo que va a leer la próxima vuelta.
    memoria: [...new Set([...erroresPrevios, ...(lectura.verificacion?.reparos ?? [])])].slice(-5)
  }));

  // ── CUMPLIR LO PROMETIDO ─────────────────────────────────────────────────────────────────────
  //
  // LA QUEJA MÁS GRAVE DEL JEFE, y la única que rompe confianza: "me dice que ahora me busca, o me
  // va a decir algo, y no actúa, se queda mudo". Medido: 7 de 42 respuestas del chat prometen
  // volver —"Apenas caiga la lectura te traigo el estado real", "Apenas se mueva algo te escribo de
  // una"— y ninguna se cumplió. Ninguna PODÍA: el chat contestaba y no persistía la promesa, y esta
  // guardia, que sí corre cada 10 minutos, no tenía forma de enterarse. Dos cerebros que no se
  // hablaban.
  //
  // Va ANTES del bloque de Slack y con su PROPIA llamada, no pegado al aviso de la guardia. Pegado
  // perdía el hilo donde se prometió —el cumplimiento aparecía suelto en el canal como pie de
  // página de otra cosa— y no consultaba el presupuesto. Cumplir es contestar, no avisar: va sin
  // mención y sin pedir respuesta, para que no le suene el móvil a las 4am.
  let avisoPromesa: { texto: string; motivo: string; hilo?: string | null } | null = null;
  try {
    await workspace.updateInventoryJson<Promesa[]>(PROMESAS_FILE, (actual) => {
      const r = revisarPromesas(actual ?? [], camposAntes, camposAhora, lectura.generadoEn, previa?.generadoEn ?? null);
      avisoPromesa = r.aviso;
      return r.lista;
    });
    if (avisoPromesa) {
      const env = await mandarASlack(
        { texto: avisoPromesa.texto, motivo: avisoPromesa.motivo, pideRespuesta: false },
        {
          token: process.env.SLACK_BOT_TOKEN,
          canal: process.env.SLACK_CANAL,
          ...(avisoPromesa.hilo ? { threadTs: avisoPromesa.hilo } : {})
        }
      );
      console.log(`[promesa] motivo=${avisoPromesa.motivo} ok=${env.ok} · ${avisoPromesa.texto}`);
    }
  } catch (e) {
    // Una promesa que no se pudo cerrar no puede tumbar la vuelta ni tapar el aviso de la guardia.
    console.error(`[promesa] no pude revisar promesas: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── SLACK ────────────────────────────────────────────────────────────────────────────────────
  // Corre SIEMPRE, aunque no haya token: así se ve en el log qué habría dicho y cuándo se habría
  // callado, que es la única forma de calibrar el criterio antes de conectarlo de verdad.
  try {
    const memPrevia = await workspace.readInventoryJson<MemoriaSlack>(SLACK_FILE).catch(() => null);
    const estadoSlack = {
      emisor: hechos.emisor?.estado ?? null,
      // `reintentable` viaja: es lo que distingue "necesito que decidas algo" de "se cayó el SSH y
      // lo reintento en diez minutos". Sin él, cada parpadeo de infraestructura le sonaba el móvil.
      acciones: acciones.map((a) => ({
        accion: a.accion,
        objetivo: a.objetivo ?? null,
        ejecutada: a.ejecutada,
        ...(a.reintentable ? { reintentable: true } : {}),
        detalle: a.detalle
      })),
      reparos,
      sinLectura: lectura.lectura ? null : lectura.motivo,
      voz: lectura.verificacion?.voz ?? null,
      ahora: lectura.verificacion?.ahora ?? null,
      riesgo: lectura.verificacion?.riesgo ?? null,
      // LO QUE CAMBIÓ EN LA FÁBRICA. Las seis razones viejas miran el estado del AGENTE —qué hizo,
      // qué no pudo, si pudo ver— y ninguna mira el de la FÁBRICA. Por eso se lo pudo dejar mudo
      // sin violar ninguna regla: en 8 horas habló 3 veces (dos rellenos y un error) mientras la
      // base registraba 14 eventos reales, dos de ellos INBOX. Y a la 1:10 el jefe escribió "no me
      // has dicho nada en toda la tarde".
      novedades: novedades(camposAntes, camposAhora),
      // LOS HECHOS, y es UNA línea que habilita SEIS reglas. Sin esto, las reglas que miran la
      // fábrica —el cap por encima del techo, la reputación cruzada, la fábrica que no da vueltas—
      // evalúan sobre `undefined` y dan false. El resultado sería silencio, nunca una afirmación
      // falsa (fail-closed), pero silencio es exactamente la queja que vinimos a resolver.
      hechos
    };
    const aviso = decidirSiHablar(estadoSlack, memPrevia, lectura.generadoEn);
    let hablo = false;
    if (aviso) {
      // LA MENCIÓN, en el carril que de verdad la necesita.
      //
      // `pideRespuesta` se venía calculando —es el "esto no lo puedo resolver yo, te necesito"— y
      // no se usaba en ninguna parte: el aviso salía como texto plano, que para Slack es una
      // palabra más y no notifica nada. O sea que el único mensaje capaz de despertar a Juanes era
      // justamente el que no sonaba.
      //
      // Ahora que el canal se calla para todo lo demás (mirar ya no avisa, y las condiciones que
      // persisten se repiten cada 6h), la mención vuelve a significar algo: si suena, es porque el
      // agente se quedó sin herramientas.
      const jefeId = process.env.SLACK_JUANES_USER_ID?.trim();
      const conMencion =
        aviso.pideRespuesta && jefeId ? { ...aviso, texto: `<@${jefeId}> ${aviso.texto}` } : aviso;
      const r = await mandarASlack(conMencion, { token: process.env.SLACK_BOT_TOKEN, canal: process.env.SLACK_CANAL });
      hablo = r.ok;
      // EL MOTIVO EN EL LOG, en las dos ramas. Es la única auditoría posible del canal: sin él no
      // se puede contar cuántos mensajes salieron por avance y cuántos por problema, que es
      // exactamente el número que dice si el péndulo quedó centrado.
      console.log(
        r.ok
          ? `[slack] motivo=${aviso.motivo} · ${aviso.texto}`
          : `[slack] NO enviado (${r.motivo}) · motivo=${aviso.motivo} — habría dicho: ${aviso.texto}`
      );
    } else {
      // "No salió" NUNCA puede ser indistinguible de "se perdió". Si el tope diario tapó avances
      // reales, el log lo dice: es el único modo de saber que el presupuesto quedó corto antes de
      // que el jefe lo note por ausencia.
      const presupuesto = presupuestoDeAvances(estadoSlack.novedades, memPrevia, lectura.generadoEn);
      console.log(
        presupuesto.tapados > 0
          ? `[slack] silencio: ${presupuesto.tapados} avance(s) tapados por el tope diario`
          : "[slack] silencio: nada cambió y no hay nada que pedir"
      );
    }
    await workspace.updateInventoryJson<MemoriaSlack>(SLACK_FILE, (m) => recordarAviso(estadoSlack, hablo, lectura.generadoEn, m, aviso));
  } catch (e) {
    // Slack NUNCA puede tumbar al agente que vigila la fábrica.
    console.log(`[slack] error al decidir/enviar: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (lectura.lectura) {
    console.log(`[${lectura.generadoEn}] ${lectura.modelo} · ${lectura.tokens?.completion ?? 0} tokens\n`);
    console.log(lectura.lectura);
    if (reparos.length > 0) console.log(`\nREPAROS de la verificación: ${reparos.join(" · ")}`);
    for (const a of acciones) console.log(`${a.ejecutada ? "✓ HIZO" : "· no hizo"}: ${a.detalle}`);
  } else {
    console.log(`[${lectura.generadoEn}] SIN LECTURA: ${lectura.motivo}`);
  }
}

/**
 * EL CARRIL DE LA CONVERSACIÓN. Corre cada 20 s dentro del mismo proceso residente: no hace falta
 * un segundo servicio, y la separación que importa no es de proceso sino de CAMINO DE CÓDIGO — acá
 * no se importa ejecutarAcciones ni se le pasan herramientas al modelo, así que el techo de daño de
 * una inyección por Slack es "dijo una tontería", no "frenó un nodo".
 */
/**
 * Lanza al maestro como proceso aparte. Aparte y no en línea: hablar con una API paga tarda
 * minutos, y el vigilante no puede quedarse esperando ni morirse si esa llamada falla.
 */
function ejecutarMaestro(): void {
  if (!process.env.KIMI_API_KEY?.trim()) return;
  void (async () => {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--env-file=config/gateway.env", "--experimental-strip-types", "scripts/ops/maestro-destilacion.ts"],
        { cwd: process.cwd(), timeout: 600_000 }
      );
      const linea = stdout.split("\n").filter((l) => l.includes("[maestro")).join(" | ");
      if (linea) console.log(linea);
    } catch (e) {
      console.log(`[maestro] no pudo correr: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}

let chatCorriendo = false;
// `pg` viaja como parámetro y no se toma del alcance de main(): esa fue exactamente la falla.
// Al cablear medir_dominio en este carril escribí `medirUnDominio(pg)` con un `pg` que no existe
// acá, y el typecheck que corrí apuntaba a un tsconfig.json inexistente, así que nadie lo vio.
// En producción el efecto era mudo y caro: apenas el modelo decidía ejecutar UNA acción, el objeto
// de contexto se armaba, `pg` tiraba ReferenceError, la excepción subía hasta el catch del tick —
// y la respuesta ya generada nunca se publicaba. El cursor de Slack, en cambio, SÍ había avanzado.
// O sea: el jefe preguntaba, el agente pensaba 40 segundos, y del otro lado no aparecía nada.
async function tickChat(workspace: OpenClawWorkspace, pg: Pool, botUserId: string | null): Promise<void> {
  // NO SE SOLAPAN. El tick es cada 20 s pero el modelo tarda 30-60 s en contestar: sin este
  // candado, el siguiente tick lee los MISMOS mensajes (el cursor todavía no avanzó) y el jefe
  // recibe la misma respuesta dos veces. Pasó en la primera corrida real, verificado en el hilo.
  if (chatCorriendo) return;
  chatCorriendo = true;
  try {
    await tickChatInterno(workspace, pg, botUserId);
  } finally {
    chatCorriendo = false;
  }
}

async function tickChatInterno(workspace: OpenClawWorkspace, pg: Pool, botUserId: string | null): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  const canal = process.env.SLACK_CANAL?.trim();
  // EL CEREBRO DEL CHAT: si hay Kimi, se usa Kimi. Conversar es esporádico —solo cuando el jefe
  // escribe— así que el costo es trivial, y la diferencia con el 35B local es enorme en entender
  // el hilo y no divagar. El modelo local sigue siendo el de la GUARDIA, que corre 144 veces por
  // día y ahí sí el costo mandaría.
  const kimiKey = process.env.KIMI_API_KEY?.trim();
  const baseUrl = kimiKey ? (process.env.KIMI_BASE_URL?.trim() || "https://api.moonshot.ai/v1") : process.env.LOCAL_INFERENCE_BASE_URL?.trim();
  const modelo = kimiKey ? (process.env.KIMI_MODEL?.trim() || "kimi-k3") : process.env.LOCAL_INFERENCE_MODEL?.trim();
  if (!token || !canal || !baseUrl || !modelo) return;

  const estado = (await workspace.readInventoryJson<EstadoLectura>(CHAT_FILE).catch(() => null)) ?? estadoVacio();
  const { mensajes, error, ultimoVisto } = await leerNuevos({ token, canal, botUserId }, estado);
  if (error) {
    console.log(`[chat] no pude leer Slack: ${error}`);
    return;
  }
  if (mensajes.length === 0) {
    // EL CURSOR AVANZA IGUAL. Si esta pasada leyó mensajes pero ninguno era contestable —los del
    // propio bot, por ejemplo— y el cursor se quedara quieto, la vuelta siguiente relee exactamente
    // los mismos y no sale nunca de ahí. Es el candado que dejó sordo al agente el 2026-08-06: sus
    // ~25 avisos nocturnos llenaron la ventana de 20 y los seis mensajes del jefe quedaron del otro
    // lado, sin ser vistos jamás.
    if (ultimoVisto && (!estado.cursorTs || ultimoVisto > estado.cursorTs)) {
      await workspace.updateInventoryJson<EstadoLectura>(CHAT_FILE, () => avanzar(estado, [], new Date().toISOString(), ultimoVisto));
      console.log(`[chat] nada que contestar; el cursor salta a ${ultimoVisto} (leí solo mensajes míos o de sistema)`);
    }
    return;
  }

  // El cursor avanza ANTES de contestar. Si la respuesta falla se pierde ese turno, y está bien:
  // en una conversación, repetir lo mismo dos veces es peor que quedarse callado una.
  await workspace.updateInventoryJson<EstadoLectura>(CHAT_FILE, () => avanzar(estado, mensajes, new Date().toISOString(), ultimoVisto));

  const snapshot = await workspace.readInventoryJson<Awaited<ReturnType<typeof pedirLectura>>>(MONITOR_FILE).catch(() => null);
  const bitacora = await workspace.readInventoryJson<Bitacora>(BITACORA_FILE).catch(() => null);
  const decisiones = await workspace.readInventoryJson<Decisiones>(DECISIONES_FILE).catch(() => null);
  // LA REACCIÓN DEL JEFE la escribe él, no el agente: su próximo mensaje es la etiqueta de si la
  // respuesta anterior sirvió ("dale" = conforme, volver a preguntar = insiste, "como que no" =
  // corrige). Se anota ANTES de contestar, con lo que acaba de llegar.
  let memoria = await workspace.readInventoryJson<MemoriaConversacion>(CONVERSACION_FILE).catch(() => null);
  for (const p of mensajes) {
    memoria = anotarReaccion(memoria, { texto: p.texto, cuando: new Date(Number(p.ts) * 1000).toISOString() });
  }
  await workspace.updateInventoryJson<MemoriaConversacion>(CONVERSACION_FILE, () => memoria as MemoriaConversacion);

  // UNA RESPUESTA POR CONVERSACIÓN, no una por mensaje.
  //
  // Antes esto era `for (const m of mensajes)`, y el 2026-08-06 mostró por qué está mal: el agente
  // volvió de unas horas sordo con SEIS mensajes encima —"Hey", "como vamos?", "respondeme",
  // "necesito el informe"— y contestó los seis por separado, con seis variantes de la misma frase.
  // La queja del jefe fue exacta: "se volvió repetitivo e imbécil". Nadie contesta seis veces a
  // "¿estás ahí?" preguntado de seis formas.
  const tandas = agruparParaContestar(mensajes);
  if (tandas.length < mensajes.length) {
    console.log(`[chat] ${mensajes.length} mensajes → ${tandas.length} respuesta(s): los junté para no repetirme`);
  }

  for (const tanda of tandas) {
    const m = tanda.mensajes[tanda.mensajes.length - 1]!;
    // 👀 ANTES DE PENSAR, y en TODOS los de la tanda: cada uno de esos mensajes espera señal de que
    // llegó. El modelo tarda ~34s y el 87% de eso lo pasa razonando; "no pasó nada" es
    // indistinguible de "el agente está caído". Cuesta 200ms y no gasta un turno del modelo.
    // No se espera (`void`): un acuse que demore la respuesta es peor que no tenerlo.
    for (const p of tanda.mensajes) void acusarRecibo({ token, canal, botUserId }, p.ts).catch(() => undefined);

    // EL HILO COMPLETO. Sin esto le llegaba UN mensaje suelto y arrancaba de cero cada turno: por
    // eso "no entendía". No era el modelo — era que no tenía la conversación delante.
    const delHilo = await leerHilo({ token, canal, botUserId }, dondeResponder(m));
    // Y ADEMÁS los otros mensajes de la tanda, que son mensajes SUELTOS del canal y por lo tanto no
    // están en ningún hilo: sin esto el modelo vería el último ("Respondeme,") sin las cuatro veces
    // que preguntó antes, y contestaría un saludo en vez del informe que le venían pidiendo.
    const otros = tanda.mensajes
      .slice(0, -1)
      .filter((p) => dondeResponder(p) !== dondeResponder(m))
      .map((p) => ({ quien: "jefe" as const, texto: p.texto }));
    const hilo = [...otros, ...delHilo];
    const r = await responder({
      contexto: {
        // Slack ES el almacén del hilo. Si por lo que sea no se pudo leer, al menos va este turno.
        hilo: hilo.length > 0 ? hilo : [{ quien: "jefe", texto: m.texto }],
        snapshot: snapshot ?? null,
        loQueHiciste: accionesParaPrompt(bitacora, 6),
        decisiones: decisionesParaPrompt(decisiones),
        // LO QUE YA DIJO EN ESTE HILO y lo que el jefe pregunta seguido. Entra como HECHO CITADO,
        // nunca como consejo: un criterio en prosa el modelo lo devuelve como hallazgo propio, y
        // este proyecto ya se quemó dos veces con eso.
        memoria: memoriaParaPrompt(memoria, dondeResponder(m), new Date().toISOString())
      },
      baseUrl,
      modelo,
      // `reasoningEffort: "low"` SOLO con Kimi: es un modelo de razonamiento y el 87% de su
      // generación se iba en pensar. El modelo local no está probado con ese parámetro, así que no
      // se le manda — una palanca sin medir en el carril que corre 144 veces por día es cara.
      ...(kimiKey ? { apiKey: kimiKey, temperatura: 1, reasoningEffort: "low" } : {})
    });
    if (!r.texto) {
      console.log(
        `[${new Date().toISOString()}] [chat] sin respuesta para "${m.texto.slice(0, 40)}": ${r.motivo} ` +
          `tardoMs=${r.tardoMs} modelo=${r.modelo} intentos=${r.intentos} finish=${r.finishReason ?? "-"}`
      );
      // EL TURNO MUERTO SE ANOTA. El campo `fallo` existía en el módulo de memoria, el informe lo
      // contaba, y este camino hacía `continue` antes de escribirlo: dos de cada tres turnos eran
      // invisibles para la memoria y el informe los daba como cero. Un contador que solo cuenta los
      // éxitos no es un contador.
      const masEsp = tanda.mensajes.reduce((a, b) => (b.texto.length > a.texto.length ? b : a), tanda.mensajes[0]!);
      const yaSeDisculpo = fallosSeguidos(memoria, dondeResponder(m)) > 0;
      memoria = anotarConversacion(memoria, {
        ts: m.ts,
        hilo: dondeResponder(m),
        quien: m.usuario,
        cuando: new Date(Number(m.ts) * 1000).toISOString(),
        pregunta: masEsp.texto,
        respuesta: "",
        tardoSeg: Math.max(0, Math.round(Date.now() / 1000 - Number(m.ts))),
        fallo: r.motivo,
        inventadas: 0
      });
      await workspace.updateInventoryJson<MemoriaConversacion>(CONVERSACION_FILE, () => memoria as MemoriaConversacion);
      if (yaSeDisculpo) {
        // UNA disculpa por racha. En la ventana mala fueron 23 idénticas en el mismo hilo por UNA
        // sola pregunta: el mensaje que existe para no dejarlo colgado se volvió el ruido.
        console.log("[chat] ya me disculpé en este hilo y sigo sin poder: no lo repito");
        continue;
      }
      // NO SE PUEDE CALLAR ACÁ. El cursor ya avanzó (a propósito: repetir una respuesta es peor
      // que perder un turno), así que sin este aviso el mensaje del jefe se evapora y él no ve
      // nada — ni una respuesta, ni un error. Le queda la impresión de que lo ignoró, que es
      // exactamente el problema que este carril vino a resolver.
      //
      // El aviso va al MISMO hilo donde escribió, y falla suave: si Slack también está caído, se
      // pierde igual, pero eso ya es la máquina entera incomunicada, no un silencio elegido.
      await mandarASlack(
        {
          texto: `Te leí pero no pude contestarte: ${r.motivo ?? "el modelo no respondió"}. Volvé a escribirme y lo intento de nuevo.`,
          motivo: "el modelo del chat no respondió",
          pideRespuesta: false
        },
        { token, canal, threadTs: dondeResponder(m) }
      ).catch(() => undefined);
      continue;
    }
    if (r.observaciones.length > 0) console.log(`[chat] observaciones: ${r.observaciones.join(" · ")}`);

    // ¿EL JEFE DECIDIÓ ALGO? Se guarda y a partir del turno siguiente entra en los DOS carriles.
    // Es lo que corta el "ya te lo dije y no entendés": una decisión no es un dato que se
    // redescubre cada 10 minutos, es algo que ya quedó zanjado.
    const decision = extraerRecordar(r.texto);
    if (decision) {
      await workspace.updateInventoryJson<Decisiones>(DECISIONES_FILE, (actual) =>
        recordarDecision(actual, { que: decision, origen: m.texto.slice(0, 160), cuando: new Date().toISOString() })
      );
      console.log(`[chat] anoté una decisión del jefe: ${decision}`);
    }

    // LO QUE EL JEFE ORDENÓ. El chat no decide actuar por su cuenta —para eso está el otro carril,
    // que mira con los datos verificados delante— pero si se lo pidieron en este turno, lo hace.
    // Es su canal privado y él es el dueño de la fábrica: negarse sería tratarlo como al modelo.
    const pedidas = extraerAcciones(r.texto);
    let hechas: string[] = [];
    // EJECUTAR NO PUEDE COSTAR LA RESPUESTA. Sin este try, cualquier excepción de acá abajo —una
    // referencia rota al armar el contexto, un SSH que revienta, el workspace sin permisos— sube
    // hasta el catch del tick y se lleva puesta la contestación YA GENERADA, mientras el cursor de
    // Slack ya avanzó. El jefe pregunta, el agente piensa cuarenta segundos, y del otro lado no
    // aparece nada: el fallo más caro es el que no se ve.
    //
    // Pasó exactamente así el 2026-08-06 con un `pg` fuera de alcance en este mismo bloque.
    // Contestar es lo primero; ejecutar es lo segundo. Si lo segundo falla, se dice y se sigue.
    try {
    if (pedidas.length > 0) {
      const res = await ejecutarAcciones(pedidas, {
        dominiosConocidos: [
          ...new Set([
            ...(snapshot?.hechos?.plan ?? []).map((p) => p.dominio),
            ...(snapshot?.hechos?.vueltas ?? []).map((v) => v.dominio),
            ...(snapshot?.hechos?.flota?.cruzados ?? []),
            ...(snapshot?.hechos?.flota?.cerca ?? []),
            ...(snapshot?.hechos?.cap?.enElTope ?? []),
            ...(snapshot?.hechos?.cap?.frenados ?? [])
          ])
        ],
        // La orden vino de un humano: se relaja el alcance del freno, que existe para acotar al
        // MODELO. Todo lo demás —dominio real, motivo, idempotencia— sigue igual de duro.
        //
        // SOLTAR NO SE RELAJA, y es a propósito: sus tres condiciones no protegen del modelo, que
        // sería lo que la orden del jefe podría levantar. Protegen de la realidad — que el nodo esté
        // realmente frenado, que haya alguien del otro lado, que su historia no lo desaconseje.
        // Ninguna autoridad cambia si Yahoo le tiene la puerta cerrada, así que soltarlo ahí sería
        // igual de inútil viniendo de él. Si quiere forzarlo, el camino es la consola, no el agente.
        //
        // Y "el jefe" es JUANES, no cualquiera que escriba en el canal. Esto estaba fijo en `true`:
        // el día que entre Esaú o Estefanía —o cualquiera con acceso al workspace— tendrían el
        // alcance de freno relajado y podrían pausar el warmup entero pidiéndoselo por chat. Que
        // hoy el canal tenga una sola persona no es un control, es una coincidencia.
        //
        // Sin SLACK_JUANES_USER_ID configurado se cae a `false`: alcance acotado para todos. Es la
        // dirección correcta de fallo — con la variable mal puesta el agente decide con MENOS
        // permiso, no con más.
        ordenadoPorElJefe: esElJefe(m.usuario),
        // LOS QUEMADOS, también acá. `ordenadoPorElJefe` relaja el alcance del FRENO —que existe
        // para acotar al modelo— pero esta lista se usa además en la otra dirección: un dominio que
        // cruzó el umbral permanente no se suelta, y eso no lo levanta ninguna autoridad porque no
        // es una regla, es un hecho del mundo. Sin esta línea, el mismo dominio que el carril
        // automático rechaza se podría soltar pidiéndoselo por Slack.
        frenablesConDanio: [
          ...new Set([...(snapshot?.hechos?.flota?.cruzados ?? []), ...(snapshot?.hechos?.cap?.enElTope ?? [])])
        ],
        // IR A MIRAR: ninguna muta nada, así que van siempre disponibles.
        leerCupoNodo: leerCupoDelNodo,
        diagnosticarDominio: diagnosticarUnDominio,
        medirDominio: medirUnDominio(pg),
        // Misma mano en el carril del chat: si Juanes pregunta "¿cómo está la reputación de X?",
        // tiene que poder ir a mirarla en vez de contestar de memoria.
        revisarReputacion: revisarReputacionDelDominio(
          await leerInventarioFabrica({ workspace }).catch(() => null)
        ),
        ...(puedeSoltar
          ? {
              soltarDominio: async (dominio: string, cap: number, motivo: string) => {
                const antes = await capAntesDeTocar(workspace, dominio);
                await soltarNodo(dominio, cap, motivo);
                return { antes, despues: cap };
              }
            }
          : {}),
        ...(puedeFrenar
          ? {
              frenarDominio: async (dominio: string, motivo: string) => {
                const antes = await capAntesDeTocar(workspace, dominio);
                await frenarNodo(dominio, motivo);
                return { antes, despues: 0 };
              }
            }
          : {}),
        pausarWarmup: async (m: string) => {
          await writeFile(KILL_FILE, `${new Date().toISOString()} pausado por orden del jefe: ${m}\n`, "utf8");
        },
        warmupPausado: async () => existsSync(KILL_FILE),
        pendientes: {
          listar: async () => (await workspace.readInventoryJson<Pendiente[]>(PENDIENTES_FILE).catch(() => [])) ?? [],
          guardar: async (p) => {
            await workspace.updateInventoryJson(PENDIENTES_FILE, () => p);
          }
        }
      });
      hechas = res.map((a) => `${a.ejecutada ? "hecho" : "no pude"}: ${a.detalle}`);
      for (const a of res) console.log(`[chat] ${a.ejecutada ? "✓ EJECUTÓ" : "· no ejecutó"}: ${a.detalle}`);
      // Queda en la MISMA bitácora que el otro carril: una acción es una acción, no importa quién
      // la pidió, y el veredicto de si sirvió se juzga igual.
      await workspace.updateInventoryJson<Bitacora>(BITACORA_FILE, (actual) => {
        let bit = actual;
        for (const a of res) {
          if (a.accion === "(ninguna)" || a.accion === "(tope)") continue;
          bit = registrar(bit, {
            accion: a.accion,
            objetivo: a.objetivo ?? null,
            motivo: `pedido por el jefe: ${m.texto.slice(0, 80)}`,
            estado: a.ejecutada ? "ejecutada" : "rechazada",
            detalle: a.ejecutada ? null : a.detalle,
            antes: typeof a.antes === "number" ? { cap: a.antes } : null,
            cuando: new Date().toISOString()
          });
        }
        return bit ?? { version: 1, entradas: [] };
      });
    }
    } catch (e) {
      // El fallo se CUENTA, no se traga: va como una línea más de resultado, junto a la respuesta
      // que sí se generó. Que el jefe lea "no pude ejecutar X: <motivo>" es infinitamente mejor
      // que un silencio, y además es la señal que hace visible un bug como el del `pg`.
      const motivo = e instanceof Error ? e.message : String(e);
      hechas.push(`no pude ejecutar lo que decidí: ${motivo}`);
      console.error(`[chat] ejecutar acciones falló (contesto igual): ${motivo}`);
    }

    // La línea ACCION es maquinaria, no conversación: se saca del texto que ve el jefe y en su
    // lugar va el RESULTADO. Mostrarle la sintaxis interna sería ruido.
    // LA MENCIÓN. "Juanes," en texto plano es una palabra más para Slack: no genera notificación.
    // Con <@U...> sí suena en el móvil. Se usa solo cuando pide una decisión o hay algo urgente —
    // si notificara todo, en dos días el jefe silencia el canal y volvemos al principio.
    const jefeId = process.env.SLACK_JUANES_USER_ID?.trim();
    // EL SANEADOR, y es el que mata el "bot del 2000". `limpiarParaSlack` saca la maquinaria
    // (ACCION:, RECORDAR:) y además el markdown que el modelo mete solo: negritas con asteriscos,
    // viñetas, títulos con almohadilla, y el "Juanes," de vocativo pegado al principio. El jefe lo
    // dijo con nombre propio: "recuerdo que openclaw me respondía con asteriscos, muy horrible
    // genéricamente, y luego arreglamos eso". Era el mismo vicio, en otro agente.
    //
    // Va acá y no en el prompt a propósito: pedirle a un modelo que no use markdown funciona el 90%
    // de las veces, y el 10% restante le llega al jefe. Un saneador funciona siempre.
    let cuerpo = limpiarParaSlack(r.texto);
    if (jefeId) {
      const urgente = /\bJUANES\b/.test(cuerpo) || /necesito (que|tu)|no puedo|confirm|decid|ayuda/i.test(cuerpo);
      cuerpo = cuerpo.replace(/^\s*JUANES[,!\s]*/i, "").replace(/^\s*Juanes[,]\s*/, "");
      cuerpo = urgente ? `<@${jefeId}> ${cuerpo}` : cuerpo;
    }
    const paraSlack = [cuerpo, ...hechas].filter(Boolean).join("\n");
    // thread_ts: contesta DENTRO del hilo. Sin esto la conversación se parte en pedazos.
    const env = await mandarASlack(
      { texto: paraSlack, motivo: "respuesta al jefe", pideRespuesta: false },
      { token, canal, threadTs: dondeResponder(m) }
    );
    console.log(
      (env.ok
        ? `[${new Date().toISOString()}] [chat] respondí en el hilo ${dondeResponder(m)}: ${r.texto.slice(0, 70)}`
        : `[${new Date().toISOString()}] [chat] NO enviado (${env.motivo}) en el hilo ${dondeResponder(m)}`) +
        ` tardoMs=${r.tardoMs} modelo=${r.modelo} intentos=${r.intentos} finish=${r.finishReason ?? "-"}`
    );

    // LA PROMESA QUEDA ANOTADA. Es la mitad que faltaba de la queja más grave: el agente prometía
    // volver y no había dónde apuntarlo, así que la guardia —que sí corre cada 10 min— no podía
    // cumplir algo de lo que nunca se enteraba. `responder()` ya extrae el marcador; acá se
    // persiste, con el HILO donde se prometió para poder contestar ahí y no suelto en el canal.
    if (r.promesa) {
      await workspace.updateInventoryJson<Promesa[]>(PROMESAS_FILE, (actual) =>
        anotarPromesa(actual ?? [], { que: r.promesa!.que, hilo: dondeResponder(m), esperando: r.promesa!.esperando }, new Date().toISOString())
      );
      console.log(`[chat] anoté una promesa: "${r.promesa.que}" esperando ${r.promesa.esperando ?? "(sin disparador)"}`);
    }

    // QUEDA REGISTRADO. Es la diferencia entre un agente que acumula y uno que redescubre: sin
    // esto, en el turno siguiente no sabe qué acaba de decir —y por eso contestó cuatro veces casi
    // lo mismo en el hilo ...393— ni cuántas veces le preguntaron ya la misma cosa.
    //
    // La PREGUNTA que se guarda es la más específica de la tanda, no la última: cuando el jefe
    // escribe "Hey / respondeme / necesito el informe / Respondeme,", lo que quería está en la
    // tercera. Guardar la última enseñaría que le interesa el tema "Respondeme".
    // Y `observaciones` es el campo que más se gana el lugar: `revisarRespuesta` ya detecta cada
    // número y dominio que el modelo afirmó sin tenerlo en el contexto, y hasta hoy se imprimía en
    // el log y se tiraba. Es señal de invención, gratis, ya calculada.
    const masEspecifica = tanda.mensajes.reduce((a, b) => (b.texto.length > a.texto.length ? b : a), tanda.mensajes[0]!);
    memoria = anotarConversacion(memoria, {
      ts: m.ts,
      hilo: dondeResponder(m),
      quien: m.usuario,
      cuando: new Date(Number(m.ts) * 1000).toISOString(),
      pregunta: masEspecifica.texto,
      respuesta: cuerpo,
      tardoSeg: Math.max(0, Math.round(Date.now() / 1000 - Number(m.ts))),
      fallo: null,
      inventadas: r.observaciones.length,
      // Los números del turno, para que el informe pueda sacar p50/p95 sobre lo que tardó el
      // MODELO (tardoMs) y no sobre lo que el mensaje esperó en la cola (tardoSeg). Mezclarlos
      // contamina la medición justo en la dirección que hace parecer que el modelo es el problema.
      tardoMs: r.tardoMs,
      intentos: r.intentos,
      finishReason: r.finishReason
      // `acciones` estaba en el diseño y el módulo no lo implementó. No lo agrego acá: la bitácora
      // (warmup-acciones.json) ya registra QUÉ hizo con su veredicto, y duplicar el dato en dos
      // memorias es la forma más segura de que algún día se contradigan.
    });
    await workspace.updateInventoryJson<MemoriaConversacion>(CONVERSACION_FILE, () => memoria as MemoriaConversacion);
  }
}

async function main(): Promise<void> {
  const workspace = new OpenClawWorkspace();
  // Sin este listener, un socket ocioso que el servidor cierra durante los 10 min de espera mata
  // el proceso entero: pg-pool emite `error` fuera de todo `await` y ningún try/catch lo ve.
  const pg = new Pool({
    ...(process.env.POSTGRES_URL ? { connectionString: process.env.POSTGRES_URL } : {}),
    application_name: "delivrix-warmup-monitor"
  });
  pg.on("error", (e) => console.error(`[monitor] WARN cliente pg ocioso descartado: ${e.message} — sigo`));

  try {
    // La PRIMERA vuelta no puede tumbar el proceso. El bucle en régimen ya tenía su catch, pero
    // esta no, y ahí está la diferencia entre "se perdió una ronda" y "el vigilante no vuelve":
    // si falla acá, `main().catch(→ process.exit(1))` mata el proceso, launchd lo relanza a los
    // 10s con exactamente el mismo estado de entrada, y vuelve a fallar. Bucle de crash con el
    // agente mudo toda la noche.
    //
    // En modo `--once` sí importa que se note el fallo: ahí el código de salida ES el resultado.
    await (LOOP
      ? unaVuelta(workspace, pg).catch((e: unknown) =>
          console.error(`[monitor] primera vuelta fallida: ${e instanceof Error ? e.message : String(e)} — sigo vivo, reintento en el ciclo`)
        )
      : unaVuelta(workspace, pg));
    if (!LOOP) return;

    // EL CHAT arranca acá, en el MISMO proceso: ya vive 24/7 bajo launchd con KeepAlive. Un
    // segundo servicio sería otro plist, otro log, otro lock y otro modo de falla, para nada. La
    // separación que importa es de camino de código, no de proceso: `tickChat` no importa
    // ejecutarAcciones ni le pasa herramientas al modelo.
    const botUserId = await miUserId({ token: process.env.SLACK_BOT_TOKEN ?? "" });
    if (botUserId) {
      console.log(`escuchando Slack cada ${MS_ENTRE_LECTURAS_DE_CHAT / 1000}s (soy ${botUserId}).`);
      setInterval(() => {
        // Una vuelta de chat que falla NO puede tumbar al vigilante: es lo accesorio, no lo central.
        void tickChat(workspace, pg, botUserId).catch((e) =>
          console.error(`[chat] vuelta fallida: ${e instanceof Error ? e.message : String(e)}`)
        );
        // 6s y no 20s. Los 20 eran TIEMPO MUERTO PURO: el jefe escribía y en el peor caso pasaban
        // 20 segundos antes de que el agente siquiera leyera. Medido de punta a punta, una
        // respuesta tardaba 35-55s, y de eso ~10 de promedio era esta espera — un tercio de la
        // demora sin ninguna contrapartida.
        //
        // El costo es despreciable: `conversations.history` con `oldest` es de los endpoints más
        // baratos de Slack (tier 3, 50+/min) y acá quedan 10/min. Lo caro es el modelo, y eso no
        // cambia con el intervalo porque solo se llama cuando HAY un mensaje nuevo.
      }, MS_ENTRE_LECTURAS_DE_CHAT);
    } else {
      console.log("sin token de Slack o sin poder identificarme: el chat queda apagado.");
    }

    // EL MAESTRO, enganchado a la guardia. Corre DESPUÉS de cada vuelta del agente, sobre los
    // MISMOS hechos que el agente acaba de mirar — que es la única forma de que la comparación
    // signifique algo. Sin esto el corpus solo crecía cuando alguien lo corría a mano, o sea nunca.
    // Es un proceso aparte a propósito: una llamada a una API paga que tarda minutos no puede
    // demorar ni tumbar al vigilante.
    const MAESTRO_CADA = Number.parseInt(process.env.MAESTRO_CADA_VUELTAS ?? "3", 10) || 3;
    let vueltasDesdeMaestro = 0;

    console.log(`\nmirando cada ${Math.round(INTERVALO_MS / 60000)} min. Ctrl-C para parar.`);
    for (;;) {
      await new Promise((r) => setTimeout(r, INTERVALO_MS));
      try {
        await unaVuelta(workspace, pg);
      } catch (error) {
        // Una vuelta que falla no puede matar el monitor: se reporta y se sigue mirando.
        console.error("vuelta fallida:", error instanceof Error ? error.message : String(error));
      }

      // Cada N vueltas, los maestros miran lo mismo y su respuesta se guarda SI pasa la
      // verificación. No en cada vuelta: costaría tokens de API 144 veces por día para material
      // que se repite (los hechos cambian poco entre vueltas de 10 min).
      if (++vueltasDesdeMaestro >= MAESTRO_CADA) {
        vueltasDesdeMaestro = 0;
        void ejecutarMaestro();
      }
    }
  } finally {
    if (!LOOP) await pg.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

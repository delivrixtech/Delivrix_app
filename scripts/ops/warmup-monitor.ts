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
import { decidirSiHablar, mandarASlack, recordarAviso, type MemoriaSlack } from "../../apps/gateway-api/src/agents/slack.ts";
import { avanzar, dondeResponder, estadoVacio, leerHilo, leerNuevos, miUserId, type EstadoLectura } from "../../apps/gateway-api/src/agents/slack-lectura.ts";
import { extraerRecordar, responder } from "../../apps/gateway-api/src/agents/sentinel-chat.ts";
import {
  lineasParaPrompt as decisionesParaPrompt,
  recordar as recordarDecision,
  type Decisiones
} from "../../apps/gateway-api/src/agents/decisiones-del-jefe.ts";
import { lineasParaPrompt as accionesParaPrompt } from "../../apps/gateway-api/src/agents/bitacora-acciones.ts";
import { planDelDia, rutaInventario } from "../../apps/warmup-engine/src/service/plan-diario.ts";
import {
  countCyclesToday,
  decideDaemonAction,
  recentPlacements,
  resolveLiveDaemonConfig
} from "../../apps/warmup-engine/src/service/live-warmup-daemon.ts";
import { CAP_MEASUREMENT_FILE, type CapFlota } from "../../apps/gateway-api/src/node-daily-cap.ts";
import { leerSemillas, semillasActivas, semillasMedibles, puntoCiego } from "../../apps/gateway-api/src/warmup-seeds.ts";
import { MEASUREMENT_FILE, type MedicionFlota } from "../../apps/gateway-api/src/sender-measurement.ts";
import { leerInventarioFabrica } from "../../apps/gateway-api/src/sender-inventory.ts";

const PENDIENTES_FILE = "warmup-pendientes.json";
/** Dónde vive la memoria de lo que HIZO (no de lo que dijo). Separada de MONITOR_FILE a propósito:
 *  ese se reescribe entero en cada vuelta y ya pesa 27 KB, y el panel lo sirve completo. */
const BITACORA_FILE = "warmup-acciones.json";
/** La memoria de lo que YA le dijo a Juanes: sin esto repetiría el mismo aviso cada 10 minutos. */
const SLACK_FILE = "warmup-slack.json";
/** Hasta dónde leyó el chat. El cursor ES el dedupe: sin él, al reiniciar re-contesta todo. */
const CHAT_FILE = "warmup-chat.json";
/** Lo que el jefe YA decidió. Gana sobre cualquier hecho que lo contradiga. */
const DECISIONES_FILE = "decisiones-del-jefe.json";
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

/** El cupo instalado hoy en el nodo de un dominio. `null` si no se pudo leer. */
async function capActual(workspace: OpenClawWorkspace, dominio: string): Promise<number | null> {
  const cap = await workspace.readInventoryJson<CapFlota>(CAP_MEASUREMENT_FILE).catch(() => null);
  return cap?.nodos.find((n) => n.domain === dominio)?.cap ?? null;
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
          sinLimite: cap.nodos.filter((n) => !n.cableado).length,
          // La FECHA viaja con el dato: sin ella el agente reportaba un cap de ayer como si fuera
          // de hoy, y la regla "si un dato está viejo, decilo" no tenía con qué cumplirse.
          medidoEn: cap.medidoEn ?? null
        }
      : null,
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
    .readInventoryJson<{ verificacion?: { reparos?: string[] }; memoria?: string[] }>(MONITOR_FILE)
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
            ...(hechos.cap?.enElTope ?? [])
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
                const antes = await capActual(workspace, dominio);
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
  await workspace.updateInventoryJson(MONITOR_FILE, () => ({
    ...lectura,
    acciones,
    // La memoria se persiste con la lectura: es lo que va a leer la próxima vuelta.
    memoria: [...new Set([...erroresPrevios, ...(lectura.verificacion?.reparos ?? [])])].slice(-5)
  }));

  // ── SLACK ────────────────────────────────────────────────────────────────────────────────────
  // Corre SIEMPRE, aunque no haya token: así se ve en el log qué habría dicho y cuándo se habría
  // callado, que es la única forma de calibrar el criterio antes de conectarlo de verdad.
  try {
    const memPrevia = await workspace.readInventoryJson<MemoriaSlack>(SLACK_FILE).catch(() => null);
    const estadoSlack = {
      emisor: hechos.emisor?.estado ?? null,
      acciones: acciones.map((a) => ({ accion: a.accion, objetivo: a.objetivo ?? null, ejecutada: a.ejecutada, detalle: a.detalle })),
      reparos,
      sinLectura: lectura.lectura ? null : lectura.motivo,
      voz: lectura.verificacion?.voz ?? null,
      ahora: lectura.verificacion?.ahora ?? null,
      riesgo: lectura.verificacion?.riesgo ?? null
    };
    const aviso = decidirSiHablar(estadoSlack, memPrevia, lectura.generadoEn);
    let hablo = false;
    if (aviso) {
      const r = await mandarASlack(aviso, { token: process.env.SLACK_BOT_TOKEN, canal: process.env.SLACK_CANAL });
      hablo = r.ok;
      console.log(r.ok ? `[slack] ${aviso.texto}` : `[slack] NO enviado (${r.motivo}) — habría dicho: ${aviso.texto}`);
    } else {
      console.log("[slack] silencio: nada cambió y no hay nada que pedir");
    }
    await workspace.updateInventoryJson<MemoriaSlack>(SLACK_FILE, (m) => recordarAviso(estadoSlack, hablo, lectura.generadoEn, m));
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
async function tickChat(workspace: OpenClawWorkspace, botUserId: string | null): Promise<void> {
  // NO SE SOLAPAN. El tick es cada 20 s pero el modelo tarda 30-60 s en contestar: sin este
  // candado, el siguiente tick lee los MISMOS mensajes (el cursor todavía no avanzó) y el jefe
  // recibe la misma respuesta dos veces. Pasó en la primera corrida real, verificado en el hilo.
  if (chatCorriendo) return;
  chatCorriendo = true;
  try {
    await tickChatInterno(workspace, botUserId);
  } finally {
    chatCorriendo = false;
  }
}

async function tickChatInterno(workspace: OpenClawWorkspace, botUserId: string | null): Promise<void> {
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
  const { mensajes, error } = await leerNuevos({ token, canal, botUserId }, estado);
  if (error) {
    console.log(`[chat] no pude leer Slack: ${error}`);
    return;
  }
  if (mensajes.length === 0) return;

  // El cursor avanza ANTES de contestar. Si la respuesta falla se pierde ese turno, y está bien:
  // en una conversación, repetir lo mismo dos veces es peor que quedarse callado una.
  await workspace.updateInventoryJson<EstadoLectura>(CHAT_FILE, () => avanzar(estado, mensajes, new Date().toISOString()));

  const snapshot = await workspace.readInventoryJson<Awaited<ReturnType<typeof pedirLectura>>>(MONITOR_FILE).catch(() => null);
  const bitacora = await workspace.readInventoryJson<Bitacora>(BITACORA_FILE).catch(() => null);
  const decisiones = await workspace.readInventoryJson<Decisiones>(DECISIONES_FILE).catch(() => null);

  for (const m of mensajes) {
    // EL HILO COMPLETO. Sin esto le llegaba UN mensaje suelto y arrancaba de cero cada turno: por
    // eso "no entendía". No era el modelo — era que no tenía la conversación delante.
    const hilo = await leerHilo({ token, canal, botUserId }, dondeResponder(m));
    const r = await responder({
      contexto: {
        // Slack ES el almacén del hilo. Si por lo que sea no se pudo leer, al menos va este turno.
        hilo: hilo.length > 0 ? hilo : [{ quien: "jefe", texto: m.texto }],
        snapshot: snapshot ?? null,
        loQueHiciste: accionesParaPrompt(bitacora, 6),
        decisiones: decisionesParaPrompt(decisiones)
      },
      baseUrl,
      modelo,
      ...(kimiKey ? { apiKey: kimiKey, temperatura: 1 } : {})
    });
    if (!r.texto) {
      console.log(`[chat] sin respuesta para "${m.texto.slice(0, 40)}": ${r.motivo}`);
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
    if (pedidas.length > 0) {
      const res = await ejecutarAcciones(pedidas, {
        dominiosConocidos: [
          ...new Set([
            ...(snapshot?.hechos?.plan ?? []).map((p) => p.dominio),
            ...(snapshot?.hechos?.vueltas ?? []).map((v) => v.dominio),
            ...(snapshot?.hechos?.flota?.cruzados ?? []),
            ...(snapshot?.hechos?.flota?.cerca ?? []),
            ...(snapshot?.hechos?.cap?.enElTope ?? [])
          ])
        ],
        // La orden vino de un humano: se relaja el alcance del freno, que existe para acotar al
        // MODELO. Todo lo demás —dominio real, motivo, idempotencia, nada que aumente el envío—
        // sigue igual de duro.
        ordenadoPorElJefe: true,
        // IR A MIRAR: no muta nada, así que va siempre disponible.
        leerCupoNodo: leerCupoDelNodo,
        ...(puedeFrenar
          ? {
              frenarDominio: async (dominio: string, motivo: string) => {
                const antes = await capActual(workspace, dominio);
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

    // La línea ACCION es maquinaria, no conversación: se saca del texto que ve el jefe y en su
    // lugar va el RESULTADO. Mostrarle la sintaxis interna sería ruido.
    // LA MENCIÓN. "Juanes," en texto plano es una palabra más para Slack: no genera notificación.
    // Con <@U...> sí suena en el móvil. Se usa solo cuando pide una decisión o hay algo urgente —
    // si notificara todo, en dos días el jefe silencia el canal y volvemos al principio.
    const jefeId = process.env.SLACK_JUANES_USER_ID?.trim();
    let cuerpo = r.texto.replace(/^ACCION:.*$/gim, "").replace(/^RECORDAR:.*$/gim, "").trim();
    if (jefeId) {
      const urgente = /\bJUANES\b/.test(cuerpo) || /necesito (que|tu)|no puedo|confirm|decid|ayuda/i.test(cuerpo);
      cuerpo = cuerpo.replace(/^\s*JUANES[,!\s]*/i, "").replace(/^\s*Juanes[,]\s*/, "");
      cuerpo = urgente ? `<@${jefeId}> ${cuerpo}` : cuerpo;
    }
    const paraSlack = [cuerpo, ...hechas].filter(Boolean).join("\n");
    // thread_ts: contesta DENTRO del hilo. Sin esto la conversación se parte en pedazos.
    await mandarASlack({ texto: paraSlack, motivo: "respuesta al jefe", pideRespuesta: false }, { token, canal, threadTs: dondeResponder(m) });
    console.log(`[chat] respondí en el hilo ${dondeResponder(m)}: ${r.texto.slice(0, 70)}`);
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
    await unaVuelta(workspace, pg);
    if (!LOOP) return;

    // EL CHAT arranca acá, en el MISMO proceso: ya vive 24/7 bajo launchd con KeepAlive. Un
    // segundo servicio sería otro plist, otro log, otro lock y otro modo de falla, para nada. La
    // separación que importa es de camino de código, no de proceso: `tickChat` no importa
    // ejecutarAcciones ni le pasa herramientas al modelo.
    const botUserId = await miUserId({ token: process.env.SLACK_BOT_TOKEN ?? "" });
    if (botUserId) {
      console.log(`escuchando Slack cada 20s (soy ${botUserId}).`);
      setInterval(() => {
        // Una vuelta de chat que falla NO puede tumbar al vigilante: es lo accesorio, no lo central.
        void tickChat(workspace, botUserId).catch((e) =>
          console.error(`[chat] vuelta fallida: ${e instanceof Error ? e.message : String(e)}`)
        );
      }, 20_000);
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

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

  const lectura = await pedirLectura({ hechos, baseUrl, modelo, erroresPrevios });

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

  // Se guarda SIEMPRE, con lectura o con motivo, y DESPUÉS de ejecutar: el panel tiene que poder
  // decir "el agente no pudo mirar" en vez de mostrar una lectura vieja, y tiene que ver qué hizo.
  await workspace.updateInventoryJson(MONITOR_FILE, () => ({
    ...lectura,
    acciones,
    // La memoria se persiste con la lectura: es lo que va a leer la próxima vuelta.
    memoria: [...new Set([...erroresPrevios, ...(lectura.verificacion?.reparos ?? [])])].slice(-5)
  }));

  if (lectura.lectura) {
    console.log(`[${lectura.generadoEn}] ${lectura.modelo} · ${lectura.tokens?.completion ?? 0} tokens\n`);
    console.log(lectura.lectura);
    if (reparos.length > 0) console.log(`\nREPAROS de la verificación: ${reparos.join(" · ")}`);
    for (const a of acciones) console.log(`${a.ejecutada ? "✓ HIZO" : "· no hizo"}: ${a.detalle}`);
  } else {
    console.log(`[${lectura.generadoEn}] SIN LECTURA: ${lectura.motivo}`);
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

    console.log(`\nmirando cada ${Math.round(INTERVALO_MS / 60000)} min. Ctrl-C para parar.`);
    for (;;) {
      await new Promise((r) => setTimeout(r, INTERVALO_MS));
      try {
        await unaVuelta(workspace, pg);
      } catch (error) {
        // Una vuelta que falla no puede matar el monitor: se reporta y se sigue mirando.
        console.error("vuelta fallida:", error instanceof Error ? error.message : String(error));
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

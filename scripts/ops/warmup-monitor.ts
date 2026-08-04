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
import { Pool } from "pg";

import { OpenClawWorkspace } from "../../apps/gateway-api/src/openclaw-workspace.ts";
import { MONITOR_FILE, pedirLectura, type HechosWarmup } from "../../apps/gateway-api/src/agents/warmup-monitor.ts";
import { resumirRechazos } from "../../apps/gateway-api/src/agents/clasificar-rechazo.ts";
import { ejecutarAcciones, extraerAcciones, type Pendiente } from "../../apps/gateway-api/src/agents/acciones-agente.ts";
import { planDelDia } from "../../apps/warmup-engine/src/service/plan-diario.ts";
import { CAP_MEASUREMENT_FILE, type CapFlota } from "../../apps/gateway-api/src/node-daily-cap.ts";
import { leerSemillas, semillasActivas, semillasMedibles, puntoCiego } from "../../apps/gateway-api/src/warmup-seeds.ts";
import { MEASUREMENT_FILE, type MedicionFlota } from "../../apps/gateway-api/src/sender-measurement.ts";

const PENDIENTES_FILE = "warmup-pendientes.json";

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

const LOOP = process.argv.includes("--loop");
const INTERVALO_MS = Number.parseInt(process.env.WARMUP_MONITOR_INTERVAL_MS ?? "", 10) || 10 * 60_000;

/** Junta los hechos. Todo de fuentes reales; lo que no se puede leer queda en null, no en cero. */
async function reunirHechos(workspace: OpenClawWorkspace, pg: Pool): Promise<HechosWarmup> {
  const { seeds } = await leerSemillas(workspace);

  const cap = await workspace.readInventoryJson<CapFlota>(CAP_MEASUREMENT_FILE).catch(() => null);
  const med = await workspace.readInventoryJson<MedicionFlota>(MEASUREMENT_FILE).catch(() => null);

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
    semillas: {
      destinos: semillasActivas(seeds).length,
      midiendo: semillasMedibles(seeds).length,
      puntoCiego: puntoCiego(seeds)
    },
    cap: cap
      ? {
          consumidoHoy: cap.nodos.reduce((s, n) => s + (n.consumidoHoy ?? 0), 0),
          tope: cap.nodos.reduce((s, n) => s + (n.cap ?? 0), 0),
          enElTope: cap.nodos.filter((n) => n.cap && n.consumidoHoy !== null && n.consumidoHoy >= n.cap).map((n) => n.domain),
          sinLimite: cap.nodos.filter((n) => !n.cableado).length
        }
      : null,
    flota: med
      ? {
          sanas: med.bandejas.filter((b) => b.estado === "healthy").length,
          bloqueadas: med.bandejas.filter((b) => b.estado === "blocked_by_provider").length,
          atascadas: med.bandejas.filter((b) => b.estado === "stalled").length,
          cruzados: med.bandejas.filter((b) => (b.cruzados ?? []).length > 0).map((b) => b.domain),
          cerca: med.bandejas.filter((b) => (b.cerca ?? []).length > 0).map((b) => b.domain)
        }
      : null,
    vueltas,
    // EL PLAN: la decisión que el motor ya tomó. Sin esto el agente opinaba sobre el volumen sin
    // saber qué se había decidido, y proponía cosas que el sistema ya estaba haciendo.
    plan: await planDelDia({
      pg,
      capFile: resolve(process.cwd(), "runtime/openclaw-workspace/inventory/sender-cap.json"),
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
    rechazos: resumirRechazos(vueltas.map((v) => v.error))
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
    .readInventoryJson<{ verificacion?: { reparos?: string[] } }>(MONITOR_FILE)
    .catch(() => null);
  const erroresPrevios = previa?.verificacion?.reparos ?? [];

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
  await workspace.updateInventoryJson(MONITOR_FILE, () => ({ ...lectura, acciones }));

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

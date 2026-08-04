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
import { planDelDia } from "../../apps/warmup-engine/src/service/plan-diario.ts";
import { CAP_MEASUREMENT_FILE, type CapFlota } from "../../apps/gateway-api/src/node-daily-cap.ts";
import { leerSemillas, semillasActivas, semillasMedibles, puntoCiego } from "../../apps/gateway-api/src/warmup-seeds.ts";
import { MEASUREMENT_FILE, type MedicionFlota } from "../../apps/gateway-api/src/sender-measurement.ts";

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

  // Se guarda SIEMPRE, con lectura o con motivo: el panel tiene que poder decir "el agente no pudo
  // mirar" en vez de mostrar una lectura vieja como si fuera de ahora.
  await workspace.updateInventoryJson(MONITOR_FILE, () => lectura);

  if (lectura.lectura) {
    console.log(`[${lectura.generadoEn}] ${lectura.modelo} · ${lectura.tokens?.completion ?? 0} tokens\n`);
    console.log(lectura.lectura);
    const reparos = lectura.verificacion?.reparos ?? [];
    if (reparos.length > 0) console.log(`\nREPAROS de la verificación: ${reparos.join(" · ")}`);
  } else {
    console.log(`[${lectura.generadoEn}] SIN LECTURA: ${lectura.motivo}`);
  }
}

async function main(): Promise<void> {
  const workspace = new OpenClawWorkspace();
  const pg = new Pool({
    ...(process.env.POSTGRES_URL ? { connectionString: process.env.POSTGRES_URL } : {}),
    application_name: "delivrix-warmup-monitor"
  });

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

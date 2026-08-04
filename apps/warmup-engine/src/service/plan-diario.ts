// EL PLAN DEL DÍA — qué va a hacer hoy el warmup con cada dominio, y por qué.
//
// Existe para que haya UNA sola implementación de esa pregunta. El daemon la necesita para actuar
// y el panel para mostrar; si cada uno la calculara por su lado, tarde o temprano un arreglo llega
// a una mitad y no a la otra, y el operador termina viendo en pantalla una decisión distinta de la
// que el daemon toma. Ese desfase es peor que no mostrar nada: parece verificado y no lo está.
//
// Todo lo de acá es LECTURA. No manda correo, no escribe en la base, no toca los nodos.

import { readFile } from "node:fs/promises";

import { decidirCupoDeHoy, esInbox, type DecisionDiaria } from "../domain/decision-diaria.ts";
import { progresoDeCalentamiento, type UsoPrevio } from "../domain/rotacion.ts";
import type { IsoWeekday } from "../domain/ramp.ts";
import type { PgClient } from "../store/pg-stores.ts";
import type { Placement } from "../live/warmup-live-cycle.ts";

/** Cuánto vale una medición del cupo antes de considerarse vencida. */
export const CUPO_VENCE_MS = 12 * 60 * 60 * 1000;

export interface MedicionCupos {
  /** Lo último que se leyó de cada nodo. Se devuelve AUNQUE esté vencida — ver `vencida`. */
  porDominio: Map<string, number>;
  /** `true` = no hay medición, o la que hay ya no sirve para decidir VOLUMEN. */
  vencida: boolean;
  medidoEn: string | null;
  /** Horas desde la medición. `null` si no hay ninguna. Va al log y al panel. */
  edadHoras: number | null;
}

/**
 * El cupo físico instalado en cada nodo, si la medición sigue vigente.
 *
 * VENCE a propósito. El archivo lo escribe `limite-fisico --status`, y entre una corrida y otra el
 * cupo puede cambiar: el 2026-08-04 el archivo decía 2000 en 58 nodos que en vivo estaban en 0 y en
 * 20, porque el freno se aplicó después de medir. Una medición vieja usada como verdad es peor que
 * ninguna — con `vencida` la rampa decide y la barrera física del nodo hace lo suyo; con un 2000
 * fantasma se decide sobre algo que no existe.
 */
export async function leerCuposFisicos(ruta: string, ahora: Date = new Date()): Promise<MedicionCupos> {
  try {
    const j = JSON.parse(await readFile(ruta, "utf8")) as {
      medidoEn?: string;
      nodos?: Array<{ domain?: string; cap?: number | null }>;
    };
    const medidoEn = typeof j.medidoEn === "string" ? j.medidoEn : null;
    const edad = ahora.getTime() - Date.parse(medidoEn ?? "");
    const conocida = Number.isFinite(edad);
    const porDominio = new Map<string, number>();
    for (const n of j.nodos ?? []) {
      if (n.domain && typeof n.cap === "number") porDominio.set(n.domain, n.cap);
    }
    // La medición se devuelve SIEMPRE, con su edad al lado. Vaciarla al vencer perdía información
    // que sí sirve: para elegir A QUÉ NODOS intentarle, un dato viejo es mucho mejor que ninguno —
    // si cambió, el propio nodo rebota y el daemon lo saltea. Lo que NO se puede hacer con un dato
    // viejo es decidir CUÁNTO mandar, y de eso se encarga `vencida`.
    return {
      porDominio,
      vencida: !conocida || edad > CUPO_VENCE_MS,
      medidoEn,
      edadHoras: conocida ? Math.round((edad / 3_600_000) * 10) / 10 : null
    };
  } catch {
    return { porDominio: new Map(), vencida: true, medidoEn: null, edadHoras: null };
  }
}

/**
 * Qué dominios se calientan: los que tienen cupo físico > 0 en la última medición.
 *
 * Usa la medición AUNQUE esté vencida, y lo dice. La asimetría es deliberada: para elegir a qué
 * nodos intentarle, un dato viejo es mucho mejor que ninguno — si el cupo cambió, el propio nodo
 * responde `450 daily send cap reached`, el daemon lo saltea y no sale un solo correo de más. Lo
 * que NO se puede hacer con un dato viejo es decidir CUÁNTO mandar; de eso se ocupa `vencida` en
 * `planDelDia`, que en ese caso pasa `cupoFisico: null`.
 *
 * Sin NINGUNA medición cae al pool configurado, y se declara: "calentando los que pueden" y
 * "calentando una lista que nadie verificó" no son lo mismo, y confundirlos fue exactamente el bug
 * — el pool eran 6 dominios escritos a mano, los 6 frenados en cap 0, y el único con cupo real ni
 * figuraba en la lista.
 */
export function elegirPool(cupos: MedicionCupos, configurado: readonly string[]): { boxes: string[]; motivo: string } {
  if (cupos.porDominio.size === 0) {
    return {
      boxes: [...configurado],
      motivo: "sin ninguna medición del cupo: se usa el pool configurado (nadie verificó que puedan enviar)"
    };
  }
  const conCupo = [...cupos.porDominio.entries()].filter(([, cap]) => cap > 0).map(([d]) => d).sort();
  const antiguedad = cupos.vencida
    ? ` — medición de hace ${cupos.edadHoras ?? "?"}h, VENCIDA: sirve para saber a quién intentarle, no para decidir volumen`
    : "";
  if (conCupo.length === 0) {
    return {
      boxes: [],
      motivo: `los ${cupos.porDominio.size} nodos medidos están en cap 0: no hay nada que calentar${antiguedad}`
    };
  }
  return { boxes: conCupo, motivo: `${conCupo.length} de ${cupos.porDominio.size} nodos con cupo > 0${antiguedad}` };
}

// ── Lecturas de la base ──────────────────────────────────────────────────────────────────────────

/** Los placements medidos de UN dominio, del más nuevo al más viejo. */
export const VENTANA_PLACEMENT_DIAS = 10;

export async function placementsDeDominio(pg: PgClient, domain: string, ventana: number): Promise<Placement[]> {
  // La ventana TEMPORAL es lo que le da salida al estado "frenar", y sin ella el freno era eterno:
  //
  //   cupo 0 → no se manda → nadie escribe un `measured` nuevo (el único escritor es el ciclo, que
  //   ese gate acaba de saltear) → las mismas 6 filas viejas siguen siendo "las últimas 6" para
  //   siempre → cupo 0 para siempre.
  //
  // Un dominio frenado un martes seguía frenado tres semanas después con la misma evidencia, y el
  // panel mostraba "12% sobre 6 mediciones" como si fuera de hoy. Agrava que el disparo es el caso
  // NORMAL de un dominio nuevo en Gmail, no un borde raro.
  //
  // Con la ventana, la evidencia vieja caduca: sin mediciones recientes la tasa es null, la
  // decisión pasa a "sostener" con el cupo de arranque, y el dominio se vuelve a medir solo.
  const { rows } = await pg.query<{ placement: string | null }>(
    `SELECT placement FROM warmup_activity
      WHERE kind = 'measured' AND placement IS NOT NULL AND node_domain = $1
        AND occurred_at > now() - interval '${VENTANA_PLACEMENT_DIAS} days'
      ORDER BY occurred_at DESC LIMIT $2`,
    [domain, ventana]
  );
  return rows
    .map((r) => (r.placement ?? "").toUpperCase())
    .filter((p): p is Placement => p === "INBOX" || p === "SPAM" || p === "PROMOTIONS" || p === "OTHER");
}

/** Cuántos correos de warmup ya mandó HOY cada dominio. Una consulta para todos. */
export async function enviosDeHoy(pg: PgClient): Promise<Map<string, number>> {
  const { rows } = await pg.query<{ node_domain: string; n: string | number }>(
    `SELECT node_domain, COUNT(*)::int AS n FROM warmup_activity
      WHERE kind = 'sent' AND occurred_at >= date_trunc('day', now() at time zone 'utc')
      GROUP BY node_domain`
  );
  return new Map(rows.map((r) => [r.node_domain, Number(r.n)]));
}

/**
 * Los dominios que HOY rebotaron por cupo agotado, según lo que respondió el propio nodo.
 *
 * La señal sale de la RESPUESTA REAL, no de un archivo de configuración: si el cupo cambia, esto se
 * entera solo, sin que nadie sincronice nada.
 */
export async function boxesSinCupoHoy(pg: PgClient): Promise<Set<string>> {
  const { rows } = await pg.query<{ node_domain: string }>(
    `SELECT DISTINCT node_domain FROM warmup_activity
      WHERE kind = 'error'
        AND occurred_at >= date_trunc('day', now() at time zone 'utc')
        AND detail->>'note' ILIKE '%daily send cap reached%'`
  );
  return new Set(rows.map((r) => r.node_domain));
}

/** El historial de envíos, que alimenta el día de rampa y la rotación de semillas. */
export async function historialDeEnvios(pg: PgClient, limite = 400): Promise<UsoPrevio[]> {
  const { rows } = await pg.query<{ node_domain: string; seed_inbox: string; occurred_at: Date }>(
    "SELECT node_domain, seed_inbox, occurred_at FROM warmup_activity WHERE kind = 'sent' ORDER BY occurred_at DESC LIMIT $1",
    [limite]
  );
  return rows.map((r) => ({ domain: r.node_domain, seed: r.seed_inbox, cuando: new Date(r.occurred_at).toISOString() }));
}

// ── El plan ──────────────────────────────────────────────────────────────────────────────────────

export interface PlanDeDominio {
  dominio: string;
  /** Día de calentamiento (1 = el día del primer envío). `null` = nunca mandó. */
  diaN: number | null;
  desde: string | null;
  vueltas: number;
  placement: {
    /** Tasa de inbox. `null` = sin muestra, que NO es 0%. */
    tasa: number | null;
    muestra: number;
    /**
     * Por qué no hay muestra. `null` cuando la lectura salió bien (haya o no mediciones).
     * Sin esto, "medí y todavía no hay nada" y "no pude medir" se ven idénticos en pantalla, y el
     * operador toma por bueno un dato que nunca existió.
     */
    error: string | null;
  };
  cupoFisico: number | null;
  enviadosHoy: number;
  /** `true` si el nodo ya rebotó hoy por cupo: el daemon lo saltea. */
  rebotoHoy: boolean;
  decision: DecisionDiaria;
}

export interface PlanDelDia {
  generadoEn: string;
  medicionCupo: { medidoEn: string | null; vencida: boolean; edadHoras: number | null };
  pool: { boxes: string[]; motivo: string };
  dominios: PlanDeDominio[];
  /**
   * Lecturas que fallaron al armar el plan. Vacío = el plan está completo.
   *
   * Degradar en silencio es la trampa: cada lectura tiene su `.catch` para que una consulta rota no
   * tumbe la pantalla, pero si además nadie se entera, el plan se muestra como completo estando a
   * medias. Acá se declara qué faltó.
   */
  lecturasFallidas: string[];
}

export interface PlanInput {
  pg: PgClient;
  capFile: string;
  /** Pool configurado, usado solo si la medición del cupo está vencida. */
  poolConfigurado: readonly string[];
  ventanaPlacement: number;
  ahora?: Date;
}

/**
 * El plan completo: para cada dominio del pool, qué día lleva, cómo viene su placement, cuánto
 * puede mandar hoy y qué decidió el agente.
 *
 * Es la MISMA función que consulta el daemon antes de actuar. Por eso lo que muestra el panel es
 * literalmente la decisión que se va a ejecutar, no una reconstrucción parecida.
 */
export async function planDelDia(input: PlanInput): Promise<PlanDelDia> {
  const ahora = input.ahora ?? new Date();
  const cupos = await leerCuposFisicos(input.capFile, ahora);
  const pool = elegirPool(cupos, input.poolConfigurado);

  const lecturasFallidas: string[] = [];
  const anotar = (que: string) => (e: unknown) => {
    lecturasFallidas.push(`${que}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  };

  const [historial, enviados, rebotados] = await Promise.all([
    historialDeEnvios(input.pg).catch(anotar("historial de envíos")),
    enviosDeHoy(input.pg).catch(anotar("envíos de hoy")),
    boxesSinCupoHoy(input.pg).catch(anotar("nodos que rebotaron hoy"))
  ]);

  // ISO weekday del receptor: 1 = lunes … 7 = domingo. `getUTCDay()` da 0 = domingo.
  const isoWeekday = (((ahora.getUTCDay() + 6) % 7) + 1) as IsoWeekday;

  const dominios: PlanDeDominio[] = [];
  for (const dominio of pool.boxes) {
    let errorPlacement: string | null = null;
    const placements = await placementsDeDominio(input.pg, dominio, input.ventanaPlacement).catch((e: unknown) => {
      errorPlacement = e instanceof Error ? e.message : String(e);
      lecturasFallidas.push(`placement de ${dominio}: ${errorPlacement}`);
      return [] as Placement[];
    });
    const progreso = progresoDeCalentamiento(historial ?? [], dominio, null, ahora);
    // Para el VOLUMEN solo vale una medición fresca. Un cupo de hace 14h puede ser un 2000 que ya
    // no existe, y decidir sobre eso es decidir sobre nada.
    const cupoFisico = cupos.vencida ? null : cupos.porDominio.get(dominio) ?? null;
    const decision = decidirCupoDeHoy({
      diaN: progreso?.diasCorridos ?? 0,
      placements,
      cupoFisico,
      isoWeekday
    });
    dominios.push({
      dominio,
      diaN: progreso?.diasCorridos ?? null,
      desde: progreso?.desde ?? null,
      vueltas: progreso?.vueltas ?? 0,
      placement: {
        tasa: placements.length > 0 ? placements.filter(esInbox).length / placements.length : null,
        muestra: placements.length,
        error: errorPlacement
      },
      cupoFisico,
      enviadosHoy: enviados?.get(dominio) ?? 0,
      rebotoHoy: rebotados?.has(dominio) ?? false,
      decision
    });
  }

  return {
    generadoEn: ahora.toISOString(),
    medicionCupo: { medidoEn: cupos.medidoEn, vencida: cupos.vencida, edadHoras: cupos.edadHoras },
    pool,
    dominios,
    lecturasFallidas
  };
}

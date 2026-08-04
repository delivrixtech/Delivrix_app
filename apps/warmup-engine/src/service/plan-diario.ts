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
/**
 * La salud medida de un dominio, en lo que le importa al pool.
 *
 * `null` = sin medición. NO se excluye por falta de dato: excluir a ciegas apagaría el warmup
 * entero el día que la medición falte, y el efecto de incluir un dominio de más ya está acotado
 * (rebota y el daemon lo saltea).
 */
export interface SaludDominio {
  estado?: string;
  cruzados?: readonly string[];
}

export function elegirPool(
  cupos: MedicionCupos,
  configurado: readonly string[],
  /**
   * Salud por dominio (de sender-measurement.json). Sirve para SACAR del pool lo que no tiene
   * sentido calentar. Omitirla no rompe nada: el pool sale solo del cupo, como antes.
   */
  salud?: ReadonlyMap<string, SaludDominio>
): { boxes: string[]; motivo: string } {
  if (cupos.porDominio.size === 0) {
    return {
      boxes: [...configurado],
      motivo: "sin ninguna medición del cupo: se usa el pool configurado (nadie verificó que puedan enviar)"
    };
  }
  let conCupo = [...cupos.porDominio.entries()].filter(([, cap]) => cap > 0).map(([d]) => d).sort();

  // ── Sacar lo que no tiene sentido calentar ────────────────────────────────────────────────────
  //
  // Tener cupo NO es lo mismo que valer la pena. El 2026-08-04, cuando 46 nodos pasaron de cap 0 a
  // tener cupo, la medición decía que 22 estaban CERRADOS POR EL RECEPTOR, 22 con la COLA ATASCADA
  // y uno había CRUZADO el umbral permanente. Calentar 44 de esos 46 no habría calentado nada:
  // habría producido rebotes, ensuciado el feed y gastado el presupuesto diario del daemon en
  // dominios que no pueden entregar.
  //
  // Los tres motivos, y por qué cada uno:
  //  · cruzó el umbral permanente → es irreversible. Calentarlo no lo recupera, solo gasta cupo.
  //  · cerrado por el receptor    → el correo no ENTRA. No se puede calentar lo que no llega.
  //  · cola atascada              → el correo no SALE. Hay que destrabar el nodo primero.
  //
  // Con la medición vencida se excluye igual: el peor caso de excluir de más es calentar un dominio
  // menos (recuperable), y el de incluir de más es quemar presupuesto en algo que no entrega.
  const excluidos: string[] = [];
  if (salud && salud.size > 0) {
    const motivoDeExclusion = (d: string): string | null => {
      const s = salud.get(d);
      if (!s) return null; // sin medición NO se excluye: apagaría el warmup el día que falte el dato
      if ((s.cruzados ?? []).length > 0) return "cruzó el umbral permanente";
      if (s.estado === "blocked_by_provider") return "cerrado por el receptor";
      if (s.estado === "stalled") return "cola atascada";
      return null;
    };
    const sobreviven: string[] = [];
    for (const d of conCupo) {
      const motivo = motivoDeExclusion(d);
      if (motivo) excluidos.push(`${d} (${motivo})`);
      else sobreviven.push(d);
    }
    conCupo = sobreviven;
  }
  const antiguedad = cupos.vencida
    ? ` — medición de hace ${cupos.edadHoras ?? "?"}h, VENCIDA: sirve para saber a quién intentarle, no para decidir volumen`
    : "";
  // Los excluidos se DECLARAN, siempre. Un pool que se achica en silencio hace creer al operador
  // que hay menos nodos con cupo de los que hay, y esconde justo el problema que hay que resolver.
  const sacados = excluidos.length > 0 ? ` · ${excluidos.length} fuera: ${excluidos.slice(0, 4).join(", ")}${excluidos.length > 4 ? ` y ${excluidos.length - 4} más` : ""}` : "";
  if (conCupo.length === 0) {
    return {
      boxes: [],
      motivo: `ninguno de los ${cupos.porDominio.size} nodos medidos sirve para calentar${sacados || ": están todos en cap 0"}${antiguedad}`
    };
  }
  return { boxes: conCupo, motivo: `${conCupo.length} de ${cupos.porDominio.size} nodos aptos${sacados}${antiguedad}` };
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
    .filter((p): p is Placement => p === "INBOX" || p === "SPAM" || p === "PROMOTIONS" || p === "OTHER" || p === "MISSING");
}

/**
 * Cuántos correos de warmup ya mandó HOY cada dominio. Una consulta para todos.
 *
 * LA VENTANA LLEVA LA ZONA EXPLÍCITA — `date_trunc('day', now(), 'UTC')` — y eso no es cosmético.
 * Las dos formas anteriores estaban mal de maneras distintas, y ninguna se veía porque el servidor
 * hoy corre en Etc/UTC:
 *
 *   · `date_trunc('day', now())`                   trunca en la TZ de la SESIÓN.
 *   · `date_trunc('day', now() at time zone 'utc')` devuelve un timestamp SIN zona, que Postgres
 *      reinterpreta en la TZ de sesión al compararlo contra un timestamptz.
 *
 * Medido contra Postgres real, con tres filas de hoy (02:00, 07:00 y 20:00 UTC):
 *
 *   TZ=Etc/UTC          vieja(sesión)=3   vieja(sin zona)=3   NUEVA=3
 *   TZ=America/Bogota   vieja(sesión)=2   vieja(sin zona)=2   NUEVA=3
 *   TZ=Europe/Madrid    vieja(sesión)=3   vieja(sin zona)=3   NUEVA=3
 *
 * Bajo Bogotá se PIERDEN los envíos de entre 00:00 y 05:00 UTC. Contar de menos es la dirección
 * peligrosa: el daemon cree que mandó menos de lo que mandó y se autoriza a mandar de más. Un
 * cambio de TZ del contenedor despierta el bug sin tocar una línea de código.
 */
export async function enviosDeHoy(pg: PgClient): Promise<Map<string, number>> {
  const { rows } = await pg.query<{ node_domain: string; n: string | number }>(
    `SELECT node_domain, COUNT(*)::int AS n FROM warmup_activity
      WHERE kind = 'sent' AND occurred_at >= date_trunc('day', now(), 'UTC')
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
        AND occurred_at >= date_trunc('day', now(), 'UTC')
        AND detail->>'note' ILIKE '%daily send cap reached%'`
  );
  return new Set(rows.map((r) => r.node_domain));
}

/**
 * El PRIMER envío de cada dominio, agregado en la base.
 *
 * El día de rampa se calculaba del historial recortado a 400 filas de TODA la flota, y de ahí se
 * tomaba el `occurred_at` mínimo como "el primer envío". Pero es el mínimo de lo que ENTRÓ EN EL
 * RECORTE, no el primero real: con la flota escribiendo ~60 envíos por día, 400 filas cubren una
 * semana, así que un dominio que calienta hace dos meses aparecía en "día 7". Y es peor que un
 * error fijo — el día RETROCEDE cuando sube el volumen de OTROS dominios, porque el recorte se
 * acorta. Un dominio que ayer estaba en día 12 hoy dice día 7, y la rampa baja el cupo sola.
 *
 * Un `MIN()` agregado no tiene recorte y no depende de nadie más.
 */
export async function primerEnvioPorDominio(pg: PgClient): Promise<Map<string, string>> {
  const { rows } = await pg.query<{ node_domain: string; desde: Date }>(
    `SELECT node_domain, MIN(occurred_at) AS desde FROM warmup_activity
      WHERE kind = 'sent' GROUP BY node_domain`
  );
  return new Map(rows.map((r) => [r.node_domain, new Date(r.desde).toISOString()]));
}

/**
 * El historial de envíos RECIENTES. Alimenta la ROTACIÓN de semillas, que necesita justamente
 * recencia (a quién le escribió este dominio últimamente). NO sirve para el día de rampa: para eso
 * está `primerEnvioPorDominio`, porque el recorte de 400 filas falsea el primer envío.
 */
export async function historialDeEnvios(pg: PgClient, limite = 400): Promise<UsoPrevio[]> {
  const { rows } = await pg.query<{ node_domain: string; seed_inbox: string; occurred_at: Date }>(
    "SELECT node_domain, seed_inbox, occurred_at FROM warmup_activity WHERE kind = 'sent' ORDER BY occurred_at DESC LIMIT $1",
    [limite]
  );
  return rows.map((r) => ({ domain: r.node_domain, seed: r.seed_inbox, cuando: new Date(r.occurred_at).toISOString() }));
}

/**
 * Lee la salud medida de la flota. Si no se puede leer devuelve `undefined` y el pool sale solo del
 * cupo — degradar a "sin filtro" es preferible a apagar el warmup por no poder leer un archivo.
 */
export async function leerSalud(ruta: string): Promise<Map<string, SaludDominio> | undefined> {
  try {
    const j = JSON.parse(await readFile(ruta, "utf8")) as {
      bandejas?: Array<{ domain?: string; estado?: string; cruzados?: string[] }>;
    };
    const m = new Map<string, SaludDominio>();
    for (const b of j.bandejas ?? []) {
      if (b.domain) m.set(b.domain, { estado: b.estado, cruzados: b.cruzados });
    }
    return m.size > 0 ? m : undefined;
  } catch {
    return undefined;
  }
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
  /** Medición de salud de la flota (sender-measurement.json). Sirve para sacar del pool lo que no
   *  se puede calentar. Opcional: sin ella el pool sale solo del cupo. */
  saludFile?: string;
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
  const salud = input.saludFile ? await leerSalud(input.saludFile) : undefined;
  const pool = elegirPool(cupos, input.poolConfigurado, salud);

  const lecturasFallidas: string[] = [];
  const anotar = (que: string) => (e: unknown) => {
    lecturasFallidas.push(`${que}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  };

  const [historial, enviados, rebotados, primerEnvio] = await Promise.all([
    historialDeEnvios(input.pg).catch(anotar("historial de envíos")),
    enviosDeHoy(input.pg).catch(anotar("envíos de hoy")),
    boxesSinCupoHoy(input.pg).catch(anotar("nodos que rebotaron hoy")),
    primerEnvioPorDominio(input.pg).catch(anotar("primer envío por dominio"))
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
    // El día sale del PRIMER ENVÍO REAL (agregado en la base), no del historial recortado. Si esa
    // lectura falló, se cae al historial: peor, pero mejor que perder el día entero.
    const desdeReal = primerEnvio?.get(dominio);
    const progreso = progresoDeCalentamiento(
      desdeReal ? [{ domain: dominio, seed: "", cuando: desdeReal }, ...(historial ?? []).filter((h) => h.domain === dominio)] : (historial ?? []),
      dominio,
      null,
      ahora
    );
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

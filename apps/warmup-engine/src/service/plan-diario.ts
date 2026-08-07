// EL PLAN DEL DÍA — qué va a hacer hoy el warmup con cada dominio, y por qué.
//
// Existe para que haya UNA sola implementación de esa pregunta. El daemon la necesita para actuar
// y el panel para mostrar; si cada uno la calculara por su lado, tarde o temprano un arreglo llega
// a una mitad y no a la otra, y el operador termina viendo en pantalla una decisión distinta de la
// que el daemon toma. Ese desfase es peor que no mostrar nada: parece verificado y no lo está.
//
// Todo lo de acá es LECTURA. No manda correo, no escribe en la base, no toca los nodos.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  cruzarEntregaConPlacement,
  decidirCupoDeHoy,
  evaluarGate,
  medirPlacement,
  medirPorProveedor,
  rampaDesdeEnv,
  type CruceEntregaPlacement,
  type DecisionDiaria,
  type EntregaPorReceptor,
  type FilaPlacement,
  type GateDelDoc,
  type PlacementDeProveedor
} from "../domain/decision-diaria.ts";
import { progresoDeCalentamiento, type UsoPrevio } from "../domain/rotacion.ts";
import type { IsoWeekday } from "../domain/ramp.ts";
import type { PgClient } from "../store/pg-stores.ts";
import type { Placement } from "../live/warmup-live-cycle.ts";

/**
 * La ruta de un archivo del inventario del workspace de OpenClaw.
 *
 * NO se puede hardcodear `runtime/openclaw-workspace` relativo al cwd, y ese era el bug: el
 * ESCRITOR (`limite-fisico --status`) resuelve la raíz con `OpenClawWorkspace`, que en cualquier
 * plataforma que no sea darwin apunta a `/data/.openclaw/workspace`. Los tres LECTORES del cupo
 * apuntaban a `runtime/`. En la Mac coinciden por casualidad; en el servidor real serían archivos
 * DISTINTOS, y el plan diría "sin ninguna medición del cupo" para siempre sin que nada falle.
 *
 * Misma precedencia que el workspace: la env var manda, después el default por plataforma.
 */
export function rutaInventario(nombre: string): string {
  const raiz =
    process.env.OPENCLAW_WORKSPACE_DIR ??
    (process.platform === "darwin" ? "runtime/openclaw-workspace" : "/data/.openclaw/workspace");
  return resolve(raiz, "inventory", nombre);
}

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
 */
export interface SaludDominio {
  estado?: string;
  cruzados?: readonly string[];
  /**
   * De quién es el correo que produjo este veredicto. `"todo"` = el nodo entero, incluido el del
   * otro inquilino; `"nuestro"` = sólo nuestros queue-ids.
   *
   * Se lee y se DECLARA, pero NO excluye a nadie: las 58 bandejas están en modo `"todo"` hoy, así
   * que usarlo como gate dejaría al agente sin manos de un plumazo. Entra como dato para que el
   * canal pueda decir "no sé de quién es este veredicto", que es la verdad.
   */
  modo?: "nuestro" | "todo";
  /**
   * Entregas reales (`status=sent`) dentro de la ventana medida. `null` = no se pudo leer el log,
   * que NO es cero. Ausente = el archivo es de una medición vieja que todavía no traía el campo.
   */
  entregados?: number | null;
  /**
   * Entregados/rechazados/diferidos POR RECEPTOR, tal como los dejó el barrido del mail.log. Es la
   * mitad "lo que dijo NUESTRO MTA" del cruce de `cruzarEntregaConPlacement`.
   *
   * Ausente o vacío es lo NORMAL hoy, no un error: el escritor filtra los receptores con menos de 20
   * intentos en la ventana, y nuestro warmup manda ~2/día por dominio. Medido el 2026-08-07: de los
   * 6 dominios que calientan, sólo corpfiling-infra.com tiene una fila (gmail.com, 20 entregados).
   */
  porReceptor?: readonly EntregaPorReceptor[];
}

/**
 * Entregas reales dentro de la ventana que hacen falta para entrar al pool.
 *
 * Es constante y no un `> 0` escrito a mano porque es CALIBRACIÓN, no una verdad: los 6 nodos del
 * pool de hoy mandaron entre 4 y 39 correos en 7 días, y casi todo ese tráfico lo generó el propio
 * warmup — o sea que el sensor se confirma con nuestros propios envíos. Hoy está en su valor más
 * permisivo; si resulta que una sola entrega no alcanza para creerle a un nodo, se sube acá.
 */
export const MIN_ENTREGAS_EN_VENTANA = 1;

/**
 * El veredicto de AUTENTICACIÓN de un dominio, tal como lo dejó el barrido de reputación.
 * Sólo interesan las tres señales que, rotas, hacen que el correo no se pueda entregar bien.
 */
export interface AuthDominio {
  spf?: { estado: string };
  dkim?: { estado: string };
  ptr?: { estado: string };
  tls?: { estado: string };
}

/**
 * ¿Este dominio tiene la autenticación rota de forma COMPROBADA?
 *
 * La asimetría es deliberada y es lo que hace que esto se pueda encender sin apagar la fábrica:
 * excluye sólo el `"mal"`, que es una medición positiva de que está roto. Un `"no-se"` —el DNS no
 * contestó, el barrido no llegó a este dominio por la cuota, el archivo todavía no existe— NO
 * excluye. Al revés sería el peor de los dos errores: un hipo del resolver dejaría a la flota
 * entera fuera del pool, y la consecuencia física de mandar con una auth desconocida-pero-sana es
 * exactamente cero, mientras que la de no mandar es un día de warmup perdido para todos.
 *
 * Es la misma forma de las tres exclusiones que ya funcionan (cerrado por el receptor, cola
 * atascada, cruzó el umbral): un motivo en castellano o `null`.
 */
export function authRota(a: AuthDominio | undefined): string | null {
  if (!a) return null;
  const roto = [
    a.spf?.estado === "mal" ? "SPF" : null,
    a.dkim?.estado === "mal" ? "DKIM" : null,
    a.ptr?.estado === "mal" ? "PTR" : null,
    a.tls?.estado === "mal" ? "el certificado TLS" : null
  ].filter((x): x is string => x !== null);
  return roto.length > 0 ? `${roto.join(" y ")} en mal estado: calentar así quema el dominio` : null;
}

/**
 * ¿Los veredictos de salud de la flota hablan de NUESTRO correo?
 *
 * `false` = al menos una bandeja se midió con el libro entero del nodo, o sea que su estado incluye
 * el correo del otro inquilino. Hoy son las 58. No cambia ninguna decisión: existe para que el
 * canal pueda decir "no sé de quién es este veredicto" en vez de afirmarlo como propio.
 */
export function flotaAtribuida(salud: ReadonlyMap<string, SaludDominio> | undefined): boolean {
  if (!salud || salud.size === 0) return false;
  return [...salud.values()].every((s) => s.modo === "nuestro");
}

export function elegirPool(
  cupos: MedicionCupos,
  configurado: readonly string[],
  /**
   * Salud por dominio (de sender-measurement.json). Sirve para SACAR del pool lo que no tiene
   * sentido calentar. Omitirla no rompe nada: el pool sale solo del cupo, como antes.
   */
  salud?: ReadonlyMap<string, SaludDominio>,
  /**
   * Autenticación por dominio (de warmup-reputacion.json). Una exclusión más, en el mismo lugar y
   * con la misma forma que las tres que ya andan. Omitirla no cambia nada.
   */
  auth?: ReadonlyMap<string, AuthDominio>
): { boxes: string[]; motivo: string } {
  // SIN MEDICIÓN DEL CUPO SE SIGUE SABIENDO QUIÉN NO SIRVE. El return temprano estaba ARRIBA del
  // filtro de salud, así que un `sender-cap.json` ilegible (`leerCuposFisicos` tiene un catch que
  // traga todo y devuelve el mapa vacío) metía al pool a los quemados, a los cerrados por el
  // receptor y a los de cola atascada — verificado: los CUATRO entraban. Y encima con `vencida:true`
  // el `cupoFisico` viaja en `null`, o sea que la rampa gobierna sola y sin la pared del nodo.
  //
  // Son dos archivos distintos: no poder leer el CUPO no borra la medición de SALUD. Lo único que
  // se pierde es cuánto manda cada uno, no cuáles no pueden mandar.
  const sinMedicion = cupos.porDominio.size === 0;
  let conCupo = sinMedicion
    ? [...configurado]
    : [...cupos.porDominio.entries()].filter(([, cap]) => cap > 0).map(([d]) => d).sort();

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
  // El motivo que se agregó al acotar la ventana del sensor de salud:
  //  · ninguna entrega en la ventana → un nodo QUE MANDÓ y no logró UNA sola entrega no es sano, es
  //    "no sé", y el pool no se llena con "no sé". Incluye al que no se pudo leer, que hoy entraba.
  //
  // Y el que NO excluye, que es la contracara: `no_traffic` LIMPIO entra. Ver abajo.
  //
  // Con la medición vencida se excluye igual: el peor caso de excluir de más es calentar un dominio
  // menos (recuperable), y el de incluir de más es quemar presupuesto en algo que no entrega.
  const excluidos: string[] = [];
  const arrancando: string[] = [];
  // ── La cuarta exclusión: la AUTENTICACIÓN, verificada hoy ─────────────────────────────────────
  //
  // Hasta acá el warmup mandaba sin comprobar que DKIM, PTR o el certificado siguieran vivos. No es
  // teórico: filing-ops.com se quedó sin cert TLS y controlcorpfiling.com sin base SASL, y las dos
  // cosas se descubrieron a mano, semanas después. Calentar un dominio con la auth rota no calienta
  // nada — construye la reputación al revés, que es el único trabajo que no se puede deshacer.
  //
  // Va ANTES del filtro de salud a propósito: es más barato de explicar ("arreglá el DKIM") que un
  // "cerrado por el receptor" que en realidad ES el DKIM roto visto desde el otro lado.
  if (auth && auth.size > 0) {
    const sobreviven: string[] = [];
    for (const d of conCupo) {
      const motivo = authRota(auth.get(d));
      if (motivo) excluidos.push(`${d} (${motivo})`);
      else sobreviven.push(d);
    }
    conCupo = sobreviven;
  }
  if (salud && salud.size > 0) {
    const motivoDeExclusion = (d: string): string | null => {
      const s = salud.get(d);
      // Esta línea decía lo contrario: "sin medición NO se excluye, porque excluir por falta de dato
      // apagaría el warmup el día que la medición falte". Se invirtió, y el incidente que protegía
      // sigue cubierto por OTRO camino: si el archivo entero no se puede leer, `leerSalud` devuelve
      // `undefined`, el guard de arriba no aplica ningún filtro y el pool sale solo del cupo, igual
      // que antes (hay un test propio de eso). Lo único que cambia es el dominio AUSENTE de un
      // archivo que sí se leyó — y eso no es "sano", es "no sé".
      if (!s) return "sin medición: no sé si entrega";
      if ((s.cruzados ?? []).length > 0) return "cruzó el umbral permanente";
      if (s.estado === "blocked_by_provider") return "cerrado por el receptor";
      if (s.estado === "stalled") return "cola atascada";
      // `no_traffic` NO excluye, y esta línea es la que impide que la fábrica deje de fabricar.
      //
      // Un dominio recién comprado tiene el mail.log vacío ⇒ totales 0/0/0 ⇒ `no_traffic`. Cuando
      // eso excluía, la trampa se cerraba sola: no entraba al pool ⇒ no mandaba nunca ⇒ seguía en
      // `no_traffic`. Un dominio nuevo no podía recibir su primer correo de warmup, en silencio, y
      // sin una sola alerta. Es la MISMA forma del bug que este ticket vino a matar ("un nodo que se
      // destrabó hace días queda condenado para siempre"), corrida de eje.
      //
      // El segundo camino a la misma trampa ya estaba vivo: cualquier dominio que quede fuera del
      // pool más días que la ventana (cap 0, una medición fallida, un fin de semana flojo) pierde
      // sus entregas y se vuelve inelegible para siempre. controlnationalcorp.com estaba ahí.
      //
      // Y no es un agujero, porque las cuatro razones para NO calentar ya se evaluaron ARRIBA y
      // ninguna depende de la ventana: `cruzados` es PEGAJOSO (sender-measurement lo arrastra de la
      // medición anterior a propósito, cruzar el umbral es irreversible), y cerrado/atascado son
      // estados, no ausencias. Lo que llega hasta acá con `no_traffic` es un nodo del que el log se
      // leyó bien y no dijo nada malo: eso no es un nodo enfermo, es un nodo NUEVO — y es el
      // candidato natural a arrancar. Si en realidad está roto, el primer correo lo demuestra y la
      // medición siguiente lo saca; el costo de averiguarlo es UNA vuelta.
      //
      // Ojo con la lectura ciega: si el nodo escribe la fecha en un formato que el corte por día no
      // reconoce, también da 0/0/0. Eso NO llega acá como `no_traffic` — readNodeDeliveryHealth lo
      // devuelve `unreadable` justamente para que no se confunda con un nodo nuevo.
      if (s.estado === "no_traffic") return null;
      // `unreadable` no necesita rama propia: cae acá, con un motivo más honesto que el estado.
      if (s.entregados === null || s.entregados === undefined) return "sin lectura de entregas: no sé";
      if (s.entregados < MIN_ENTREGAS_EN_VENTANA) return "ninguna entrega en la ventana";
      return null;
    };
    const sobreviven: string[] = [];
    for (const d of conCupo) {
      const motivo = motivoDeExclusion(d);
      if (motivo) excluidos.push(`${d} (${motivo})`);
      else {
        sobreviven.push(d);
        // Los que entran SIN una señal positiva se cuentan aparte. El daemon reparte una vuelta por
        // dominio: si mañana entran treinta nodos que nunca mandaron, los que hoy calientan bien se
        // llevan una fracción del presupuesto. Que la dilución se vea en la misma línea que el pool
        // es lo que la vuelve corregible; sin el número, "el pool creció" se lee como buena noticia.
        if (salud.get(d)?.estado === "no_traffic") arrancando.push(d);
      }
    }
    conCupo = sobreviven;
  }
  const antiguedad = sinMedicion
    ? " — SIN ninguna medición del cupo: nadie verificó cuánto puede mandar cada uno"
    : cupos.vencida
      ? ` — medición de hace ${cupos.edadHoras ?? "?"}h, VENCIDA: sirve para saber a quién intentarle, no para decidir volumen`
      : "";
  // Los excluidos se DECLARAN, siempre. Un pool que se achica en silencio hace creer al operador
  // que hay menos nodos con cupo de los que hay, y esconde justo el problema que hay que resolver.
  const sacados = excluidos.length > 0 ? ` · ${excluidos.length} fuera: ${excluidos.slice(0, 4).join(", ")}${excluidos.length > 4 ? ` y ${excluidos.length - 4} más` : ""}` : "";
  const nuevos = arrancando.length > 0 ? ` · ${arrancando.length} sin tráfico todavía, entran a arrancar: ${arrancando.slice(0, 4).join(", ")}${arrancando.length > 4 ? ` y ${arrancando.length - 4} más` : ""}` : "";
  const universo = sinMedicion ? configurado.length : cupos.porDominio.size;
  const deQue = sinMedicion ? "nodos del pool configurado" : "nodos medidos";
  if (conCupo.length === 0) {
    return {
      boxes: [],
      motivo: `ninguno de los ${universo} ${deQue} sirve para calentar${sacados || ": están todos en cap 0"}${antiguedad}`
    };
  }
  return { boxes: conCupo, motivo: `${conCupo.length} de ${universo} ${deQue} aptos${sacados}${nuevos}${antiguedad}` };
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
  // LA RAMPA SE DECIDE CON CORREO DE ARRANQUE EN FRÍO, NO CON RESPUESTAS DENTRO DE UN HILO.
  //
  // Desde que los turnos de continuación miden (`medirTurnoDeHilo` graba `kind:'measured'`), sus
  // filas entraban en esta MISMA ventana de 6. Dos daños, los dos sobre el volumen:
  //   · un "Re:" dentro de un hilo ya establecido es una clase de correo mucho más fácil de
  //     entregar, así que la tasa se sesga hacia ARRIBA — y esa tasa es lo único que hay entre la
  //     flota y el umbral permanente de Gmail;
  //   · con un turno por vuelta y LIMIT 6, seis continuaciones seguidas barren de la ventana toda
  //     la medición del ciclo principal.
  // El campo ya viajaba en la fila (`detail.origen`), sólo faltaba la cláusula. `IS DISTINCT FROM`
  // y no `<>` a propósito: las filas del ciclo principal no tienen `origen` y `NULL <> 'x'` es NULL,
  // que las descartaría a TODAS y dejaría la rampa sin evidencia.
  return (await filasDePlacement(pg, domain, ventana)).map((f) => f.placement);
}

/**
 * LA MISMA VENTANA, con la SEMILLA que produjo cada medición.
 *
 * Es una función nueva y `placementsDeDominio` pasó a ser un `.map()` sobre ella, en vez de dos
 * consultas paralelas: la cláusula que excluye las continuaciones de hilo ya se escribió UNA vez y
 * quedó afuera del otro lector (`recentPlacements`), y hay un test que existe sólo por eso. Dos SQL
 * con la misma regla es exactamente cómo se abre esa divergencia; ésta es una sola.
 *
 * El campo `seed_inbox` ya estaba en cada fila desde el primer día. Derivar el proveedor de ahí es
 * un LOOKUP contra el registro de semillas, no una migración.
 */
export async function filasDePlacement(pg: PgClient, domain: string, ventana: number): Promise<FilaPlacement[]> {
  const { rows } = await pg.query<{ placement: string | null; seed_inbox: string | null }>(
    `SELECT placement, seed_inbox FROM warmup_activity
      WHERE kind = 'measured' AND placement IS NOT NULL AND node_domain = $1
        AND (detail->>'origen') IS DISTINCT FROM 'continuación de hilo'
        AND occurred_at > now() - interval '${VENTANA_PLACEMENT_DIAS} days'
      ORDER BY occurred_at DESC LIMIT $2`,
    [domain, ventana]
  );
  return rows
    .map((r) => ({ placement: (r.placement ?? "").toUpperCase(), semilla: (r.seed_inbox ?? "").toLowerCase() }))
    .filter((f): f is FilaPlacement =>
      f.placement === "INBOX" || f.placement === "SPAM" || f.placement === "PROMOTIONS" || f.placement === "OTHER" || f.placement === "MISSING"
    );
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
  return enviosDelDia(pg, 0);
}

/**
 * Cuántos correos mandó cada dominio en UN día UTC concreto, contado hacia atrás desde hoy.
 * `0` = hoy, `2` = anteayer.
 *
 * Existe para alimentar `cupoHace2Dias`, que es el PISO del "sostener" de `decidirCupoDeHoy`: el
 * volumen que el dominio ya venía teniendo, para no castigarlo bajándolo al cupo de arranque
 * mientras junta muestra. Va topado por la rampa, así que no puede inflar nada.
 *
 * YA NO ALIMENTA EL CLAMP 3×/48h, y el porqué está en `decision-diaria.ts`: estos son ENVÍOS, y los
 * envíos están topados por un límite GLOBAL del daemon (14 vueltas para toda la flota), así que como
 * base de un clamp frenaban a los dominios sanos, dejaban sueltos a los que no mandaron nada, y
 * congelaban el plan en 3-6/día mientras el panel pintaba una rampa que avanzaba.
 *
 * La ventana es CERRADA por arriba (`< trunc(hoy) - (n-1) días`), a diferencia de la de hoy: para
 * un día pasado hace falta el día solo, no "desde entonces". Y la zona va explícita por la misma
 * razón que en `enviosDeHoy`: bajo `TZ=America/Bogota` se perdían los envíos de 00:00 a 05:00 UTC.
 */
export async function enviosDelDia(pg: PgClient, diasAtras: number): Promise<Map<string, number>> {
  const n = Math.max(0, Math.floor(diasAtras));
  const { rows } = await pg.query<{ node_domain: string; n: string | number }>(
    `SELECT node_domain, COUNT(*)::int AS n FROM warmup_activity
      WHERE kind = 'sent'
        AND occurred_at >= date_trunc('day', now(), 'UTC') - make_interval(days => $1::int)
        AND occurred_at <  date_trunc('day', now(), 'UTC') - make_interval(days => $1::int - 1)
      GROUP BY node_domain`,
    [n]
  );
  return new Map(rows.map((r) => [r.node_domain, Number(r.n)]));
}

/**
 * Cuánto se retrocede buscando el último cupo autorizado. 10 días es la misma ventana con la que ya
 * se leen los placements: más atrás el dato deja de describir al dominio de hoy.
 */
export const VENTANA_CUPO_AUTORIZADO = 10;

/**
 * El ÚLTIMO CUPO AUTORIZADO CONOCIDO a partir de hace `diasAtras` días, por dominio. `2` = "lo que
 * este dominio tenía autorizado anteayer, o el día anterior con dato si anteayer no mandó".
 *
 * LA AUSENCIA NO PUEDE SER PERMISO, y lo era: esto miraba UN día puntual y sólo devuelve dominios
 * con una fila `sent` ESE día. Sin entrada, `dailyQuota` no clampea y sale la rampa entera — o sea
 * que el dominio que estuvo QUIETO anteayer, que es justo el que puede pegar el salto, era el que
 * se quedaba sin freno, y el que estuvo activo se llevaba el clamp. Es la MISMA asimetría que el
 * comentario de abajo dice haber cerrado al dejar de usar `enviosDelDia` ("frenaba a los sanos y
 * soltaba a los que no mandaron"), con otra fuente de datos.
 *
 * Medido contra la Postgres de producción (10 días de `warmup_activity`, kind `sent`): de los 17
 * pares dominio-día con envíos, sólo 6 tienen envío dos días antes ⇒ el clamp faltaba el 65% de las
 * veces. El 2026-08-06 mandaron 6 dominios y sólo uno había mandado el 08-04: 5 de 6 sin clamp.
 * Con el tope GLOBAL de 14 vueltas para toda la flota, un día sin fila es lo normal, no el borde.
 *
 * ES OTRA COSA QUE `enviosDelDia`, y confundirlas es lo que dejó al clamp anti-firma del §10 sin
 * entrada desde el diseño v1:
 *   · `enviosDelDia`         cuenta FILAS: correos que salieron. Aplastado por el tope GLOBAL del
 *     daemon (14 vueltas para toda la flota), da 1-8 por dominio y casi siempre 2.
 *   · `cupoAutorizadoVigente` lee lo que la DECISIÓN autorizó, que es la magnitud que el §10
 *     quiere acotar. El daemon lo graba en `detail.cupoDelDia` del evento `sent`.
 *
 * Lo más barato que funciona y no cuesta migración: `detail` ya es JSONB y ya se escribe en cada
 * envío. No hay tabla nueva, no hay índice nuevo.
 *
 * MAX y no MIN ni el último: el cupo de un dominio puede cambiar DENTRO del día (junta su cuarta
 * medición y pasa de `sostener 2` a la rampa). Con MIN, un `frenar` de la mañana dejaría el valor en
 * 0 y `dailyQuota` no clampea con 0 — o sea que la única elección que apaga el clamp sería la de un
 * día malo. MAX es el techo que el dominio tuvo autorizado, que es lo que el clamp acota.
 *
 * El `~ '^[0-9]+$'` no es paranoia decorativa: sin él, UNA fila con basura en ese campo hace que el
 * cast reviente la consulta entera, y el llamador trata el fallo de lectura como "no mando esta
 * vuelta". Un dato corrupto no puede apagar el warmup.
 */
export async function cupoAutorizadoVigente(pg: PgClient, diasAtras: number, ventanaDias = VENTANA_CUPO_AUTORIZADO): Promise<Map<string, number>> {
  const n = Math.max(0, Math.floor(diasAtras));
  const v = Math.max(n, Math.floor(ventanaDias));
  const { rows } = await pg.query<{ node_domain: string; dia: string; cupo: string | number }>(
    `SELECT node_domain, date_trunc('day', occurred_at, 'UTC') AS dia, MAX((detail->>'cupoDelDia')::int) AS cupo
       FROM warmup_activity
      WHERE kind = 'sent'
        AND detail->>'cupoDelDia' ~ '^[0-9]+$'
        AND occurred_at >= date_trunc('day', now(), 'UTC') - make_interval(days => $2::int)
        AND occurred_at <  date_trunc('day', now(), 'UTC') - make_interval(days => $1::int - 1)
      GROUP BY node_domain, date_trunc('day', occurred_at, 'UTC')`,
    [n, v]
  );
  return ultimoAutorizado(rows);
}

/**
 * De una fila por dominio y día, el cupo del DÍA MÁS RECIENTE de cada dominio. Pura: acá vive el
 * arrastre, así que se puede fijar con un test sin una Postgres al lado.
 *
 * El más reciente y no el MÁXIMO de la ventana: en una rampa hacia abajo el máximo es el valor
 * ANTIGUO, y clampear con él es casi no clampear. Dentro de un mismo día sigue mandando el MAX,
 * que lo resuelve el `GROUP BY` de la consulta y por el motivo de siempre (un `frenar` de la mañana
 * dejaría el día en 0, y con 0 el clamp no actúa).
 */
export function ultimoAutorizado(filas: ReadonlyArray<{ node_domain: string; dia?: string; cupo: string | number }>): Map<string, number> {
  const mejor = new Map<string, { dia: number; cupo: number }>();
  for (const f of filas) {
    const cupo = Number(f.cupo);
    if (!Number.isFinite(cupo)) continue;
    // Una fecha ilegible entra como la más vieja en vez de tirar la fila: perder el dato haría que
    // el dominio quede SIN clamp, que es justo el fallo que este arreglo viene a cerrar.
    const t = Date.parse(String(f.dia ?? ""));
    const dia = Number.isFinite(t) ? t : 0;
    const previo = mejor.get(f.node_domain);
    if (previo !== undefined && previo.dia >= dia) continue;
    mejor.set(f.node_domain, { dia, cupo });
  }
  return new Map([...mejor].map(([k, v]) => [k, v.cupo]));
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
      bandejas?: Array<{
        domain?: string;
        estado?: string;
        cruzados?: string[];
        entregados?: number | null;
        porReceptor?: EntregaPorReceptor[];
        atribucion?: { modo?: "nuestro" | "todo" };
      }>;
    };
    const m = new Map<string, SaludDominio>();
    for (const b of j.bandejas ?? []) {
      if (b.domain) {
        m.set(b.domain, {
          estado: b.estado,
          cruzados: b.cruzados,
          entregados: b.entregados,
          porReceptor: b.porReceptor,
          modo: b.atribucion?.modo
        });
      }
    }
    return m.size > 0 ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lee la última foto de autenticación de la flota (warmup-reputacion.json, lo escribe el barrido
 * diario). Ausente o roto ⇒ `undefined` ⇒ el pool sale como antes: no poder leer un archivo no
 * puede apagar el warmup, y `authRota` ya se encarga de que un "no sé" no excluya a nadie.
 */
export async function leerReputacion(ruta: string): Promise<Map<string, AuthDominio> | undefined> {
  try {
    const j = JSON.parse(await readFile(ruta, "utf8")) as {
      dominios?: Array<{ dominio?: string; spf?: { estado: string }; dkim?: { estado: string }; ptr?: { estado: string }; tls?: { estado: string } }>;
    };
    const m = new Map<string, AuthDominio>();
    for (const d of j.dominios ?? []) {
      if (d.dominio) m.set(d.dominio, { spf: d.spf, dkim: d.dkim, ptr: d.ptr, tls: d.tls });
    }
    return m.size > 0 ? m : undefined;
  } catch {
    return undefined;
  }
}

/**
 * El PROVEEDOR de cada semilla, del registro (warmup-seeds.json). Sólo se leen `address` y
 * `provider`: el archivo tiene además el app password cifrado y eso no sale de acá ni por error.
 *
 * Ausente o roto ⇒ `undefined` ⇒ cada medición sale con proveedor `desconocido`, que es la verdad.
 * NO se cae a "gmail": suponer el proveedor es la mentira por omisión que este dato vino a cerrar.
 */
export async function leerProveedoresDeSemillas(ruta: string): Promise<Map<string, string> | undefined> {
  try {
    const j = JSON.parse(await readFile(ruta, "utf8")) as { seeds?: Array<{ address?: string; provider?: string }> };
    const m = new Map<string, string>();
    for (const s of j.seeds ?? []) {
      if (s.address && s.provider) m.set(s.address.trim().toLowerCase(), s.provider);
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
    /**
     * QUIÉN MIDIÓ. `null` = nadie. `"varios"` = más de un receptor.
     *
     * Sin este campo, `tasa` mentía por omisión: las dos únicas semillas que miden son Gmail, así
     * que "83% inbox" era 83%-EN-GMAIL presentado como placement a secas. Es el campo que
     * `artefactos.ts` tiene que ver no-nulo a las 24 h del despliegue.
     */
    proveedor: string | null;
    /** Uno por receptor, con los que NO midieron en `tasa: null`. Nunca 0% por ausencia. */
    porProveedor: PlacementDeProveedor[];
  };
  cupoFisico: number | null;
  enviadosHoy: number;
  /** `true` si el nodo ya rebotó hoy por cupo: el daemon lo saltea. */
  rebotoHoy: boolean;
  decision: DecisionDiaria;
  /**
   * El veredicto de §3 del doc de auditoría, evaluado por código. SOLO INFORMA: no frena, no suelta
   * y no cambia ningún cupo — `decidirCupoDeHoy` ni lo mira. Al modelo le llega esto, no el criterio.
   */
  gate: GateDelDoc;
  /**
   * Lo que dijo NUESTRO MTA contra dónde cayó, por receptor. El dato que un servicio comprado no
   * puede dar, porque no tiene el MTA. Vacío cuando no hay con qué cruzar, nunca inventado.
   */
  cruce: CruceEntregaPlacement[];
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
  /** Foto de autenticación de la flota (warmup-reputacion.json). Opcional: sin ella no excluye nada. */
  reputacionFile?: string;
  /**
   * Registro de semillas (warmup-seeds.json). De ahí sale el PROVEEDOR de cada medición.
   *
   * TIENE DEFAULT, y ésa es la diferencia con `saludFile` y `reputacionFile`. Los llamadores vivos
   * de `planDelDia` (scripts/ops/warmup-monitor.ts, o sea lo que el agente le reporta al jefe) NO
   * pasan los archivos opcionales: con este campo opcional-sin-default, `placement.proveedor` habría
   * salido `desconocido` en producción para siempre y el lote entero sería otra mano prometida y no
   * cableada. El default es la MISMA ruta que ya usa el daemon.
   */
  seedsFile?: string;
  /** Pool configurado, usado solo si la medición del cupo está vencida. */
  poolConfigurado: readonly string[];
  ventanaPlacement: number;
  ahora?: Date;
  /** De dónde salen las palancas de la rampa. Default `process.env`; es la costura para el test. */
  env?: NodeJS.ProcessEnv;
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
  const auth = input.reputacionFile ? await leerReputacion(input.reputacionFile) : undefined;
  const proveedores = await leerProveedoresDeSemillas(input.seedsFile ?? rutaInventario("warmup-seeds.json"));
  const proveedorDe = (semilla: string): string | null => proveedores?.get(semilla.trim().toLowerCase()) ?? null;
  const pool = elegirPool(cupos, input.poolConfigurado, salud, auth);

  const lecturasFallidas: string[] = [];
  const anotar = (que: string) => (e: unknown) => {
    lecturasFallidas.push(`${que}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  };

  const [historial, enviados, rebotados, primerEnvio, hace2Dias, cupoHace2Dias] = await Promise.all([
    historialDeEnvios(input.pg).catch(anotar("historial de envíos")),
    enviosDeHoy(input.pg).catch(anotar("envíos de hoy")),
    boxesSinCupoHoy(input.pg).catch(anotar("nodos que rebotaron hoy")),
    primerEnvioPorDominio(input.pg).catch(anotar("primer envío por dominio")),
    // El piso del "sostener": lo que el dominio REALMENTE mandó hace dos días. Va topado por la
    // rampa, así que no puede inflar nada.
    enviosDelDia(input.pg, 2).catch(anotar("envíos de hace 2 días")),
    // La entrada del clamp 3×/48h, que hasta este cambio no existía en ningún lado. Si falla se
    // declara y se decide sin ella: el clamp sólo puede BAJAR el cupo, así que perderlo no abre
    // ninguna puerta que estuviera cerrada — al revés de las otras cuatro lecturas, donde un fallo
    // sí sería fail-open.
    cupoAutorizadoVigente(input.pg, 2).catch(anotar("cupo autorizado de hace 2 días"))
  ]);

  // ISO weekday del receptor: 1 = lunes … 7 = domingo. `getUTCDay()` da 0 = domingo.
  const isoWeekday = (((ahora.getUTCDay() + 6) % 7) + 1) as IsoWeekday;
  // LAS MISMAS DOS PALANCAS QUE USA EL DAEMON. Sin esta línea, `decidirCupoDeHoy` caía a sus
  // defaults internos (40 y 2) mientras el daemon pasaba lo que dice gateway.env: el día que
  // alguien escriba WARMUP_RAMPA_LIMITE_DIARIO=200, salen 200 por dominio y esta función —o sea
  // /v1/warmup/plan, el panel, y `hechos.plan`, que es lo que el agente le reporta al jefe por
  // Slack— sigue anunciando 40 con toda seguridad. El sobre de volumen se vuelve invisible justo
  // en el instante en que se usa.
  const rampa = rampaDesdeEnv(input.env ?? process.env);

  const dominios: PlanDeDominio[] = [];
  for (const dominio of pool.boxes) {
    let errorPlacement: string | null = null;
    const filas = await filasDePlacement(input.pg, dominio, input.ventanaPlacement).catch((e: unknown) => {
      errorPlacement = e instanceof Error ? e.message : String(e);
      lecturasFallidas.push(`placement de ${dominio}: ${errorPlacement}`);
      return [] as FilaPlacement[];
    });
    const placements: Placement[] = filas.map((f) => f.placement);
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
      // El MISMO dato que el daemon: si el plan decidiera sin él, el panel volvería a anunciar un
      // cupo distinto del que se ejecuta — la divergencia que ya se pagó con las dos palancas de la
      // rampa.
      ...(hace2Dias?.get(dominio) !== undefined ? { cupoHace2Dias: hace2Dias.get(dominio)! } : {}),
      // La entrada del clamp anti-firma. El MISMO dato que el daemon, por la misma razón que las
      // palancas de la rampa: si el plan decidiera sin él, el panel volvería a anunciar un cupo
      // distinto del que se ejecuta.
      ...(cupoHace2Dias?.get(dominio) !== undefined ? { cupoAutorizadoHace2Dias: cupoHace2Dias.get(dominio)! } : {}),
      isoWeekday,
      limiteDiario: rampa.limiteDiario,
      pasoPorDia: rampa.pasoPorDia,
      soloDiasHabiles: rampa.soloDiasHabiles
    });
    // El placement CON su receptor, y el veredicto de §3 evaluado por código. Los dos son LECTURA:
    // `decidirCupoDeHoy` ya decidió arriba y ninguno de los dos lo toca.
    const porProveedor = medirPorProveedor(filas, proveedorDe);
    const saludDelDominio = salud?.get(dominio);
    const cruce = cruzarEntregaConPlacement({
      filas,
      porReceptor: saludDelDominio?.porReceptor,
      atribuido: saludDelDominio?.modo === "nuestro"
    });
    // El gate mira los rebotes DEL RECEPTOR que midió, no el total del nodo: un dominio puede estar
    // entregando perfecto en Gmail y rebotando en Yahoo, y §3 razona por proveedor.
    const rebotesDelQueMidio = cruce.find((c) => c.medidos > 0);
    const gate = evaluarGate({
      placement: porProveedor,
      entregadosMta: rebotesDelQueMidio?.entregadosMta ?? null,
      rechazadosMta: rebotesDelQueMidio?.rechazadosMta ?? null,
      cruzoUmbralPermanente: (saludDelDominio?.cruzados ?? []).length > 0
    });
    dominios.push({
      dominio,
      diaN: progreso?.diasCorridos ?? null,
      desde: progreso?.desde ?? null,
      vueltas: progreso?.vueltas ?? 0,
      // La MISMA cuenta que hizo la decisión, no una parecida: `medirPlacement` saca los MISSING del
      // denominador. Recalcularla acá con `placements.length` mostraría en el panel un 75% sobre una
      // decisión tomada con 100%, y esa clase de desfase es peor que no mostrar nada: parece
      // verificado y no lo está.
      placement: {
        tasa: medirPlacement(placements).tasa,
        muestra: medirPlacement(placements).muestra,
        error: errorPlacement,
        // `medirPorProveedor` agrega con la MISMA `medirPlacement` de arriba, así que `tasa` y
        // `muestra` no pueden divergir de la cuenta que tomó la decisión.
        proveedor: porProveedor.proveedor,
        porProveedor: porProveedor.porProveedor
      },
      cupoFisico,
      enviadosHoy: enviados?.get(dominio) ?? 0,
      rebotoHoy: rebotados?.has(dominio) ?? false,
      decision,
      gate,
      cruce
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

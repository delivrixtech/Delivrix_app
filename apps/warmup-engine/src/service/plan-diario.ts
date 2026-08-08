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
  RAMPA_LIMITE_DIARIO_DEFAULT,
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
   * De esas entregas, las que SALIERON DEL NODO. Es la que decide; `entregados` trae adentro el
   * correo que el nodo se manda a sí mismo por el pipe de rebotes y por eso no sirve de prueba.
   *
   * Ausente = archivo de una medición vieja ⇒ se cae a `entregados` (ver el uso). `null` = no se
   * pudo leer, que no es cero.
   */
  entregadosATerceros?: number | null;
  /**
   * Pico diario de mensajes por familia de receptor, sobre TODO el log retenido y no sobre la
   * ventana (`readNodeProviderVolume` abre `mail.log*` entero). O sea: es MEMORIA, y por eso sirve
   * para lo que la ventana olvida. Ver la puerta de `no_traffic`.
   */
  picos?: readonly { readonly mensajes?: number }[];
  /**
   * Entregados/rechazados/diferidos POR RECEPTOR, tal como los dejó el barrido del mail.log. Es la
   * mitad "lo que dijo NUESTRO MTA" del cruce de `cruzarEntregaConPlacement`.
   *
   * Ausente o vacío es lo NORMAL hoy, no un error: el escritor filtra los receptores con menos de 20
   * intentos en la ventana, y nuestro warmup manda ~2/día por dominio. Medido el 2026-08-07: de los
   * 6 dominios que calientan, sólo corpfiling-infra.com tiene una fila (gmail.com, 20 entregados).
   */
  porReceptor?: readonly EntregaPorReceptor[];
  /**
   * Receptores donde este nodo está efectivamente CERRADO. Es PEGAJOSO desde el 2026-08-07
   * (sender-measurement.ts lo une con la corrida anterior), igual que `cruzados`.
   *
   * Se lee acá porque `estado` no alcanza: el estado se recalcula sobre una ventana de 5 días por
   * fecha de línea, así que un nodo que deja de mandar vuelve solo a `no_traffic` con la memoria
   * del receptor intacta — y `no_traffic` es la puerta por la que entran los dominios nuevos.
   */
  cerradoEn?: readonly string[];
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
 * Cuántos dominios SIN señal positiva pueden entrar al pool en la misma vuelta.
 *
 * Es una baranda de VOLUMEN, no una preferencia: el sobre del daemon es global y fijo, así que cada
 * dominio nuevo le saca envíos a los que ya calientan. Ver la nota larga en `elegirPool`.
 */
export const MAX_ARRANCANDO_A_LA_VEZ = 1;

/**
 * Pico diario de mensajes, en TODO el log retenido, a partir del cual un dominio YA NO ES NUEVO.
 *
 * QUÉ SEPARA. La puerta de `no_traffic` existe para que un dominio recién comprado pueda recibir su
 * primer correo de warmup. El problema es que `no_traffic` no significa "nuevo", significa "la
 * VENTANA de 5 días está vacía" — y un nodo quemado que dejó de mandar cae ahí solo. Medido por SSH
 * contra el nodo real el 2026-08-08: controlcontrolledger.com (147.93.186.66) con la ventana corrida
 * a 3 días da `no_traffic` — "el log no registra ni entregas ni rechazos ni diferidos" — y ENTRA al
 * pool como candidato a arrancar. Su log retenido: 15.116 mensajes rebotados en gmail.com contra 294
 * entregados (98%), 14.988 líneas `550-5.7.1 [147.93.186.66 12] Gmail has detected that this message
 * is likely unsolicited mail`, 1.963 rechazos de Microsoft, 396 de Cloudmark y rechazos de Apple.
 * Está quemado en cuatro receptores a la vez y el sensor lo iba a presentar como dominio virgen.
 * `cerradoEn` no lo tapa: está vacío para él (sólo 8 de 58 nodos lo tienen).
 *
 * POR QUÉ `picos` Y NO OTRA COSA: es el único campo del archivo que se lee sobre el log ENTERO y no
 * sobre la ventana, o sea el único que no se olvida cuando el nodo se calla.
 *
 * POR QUÉ NO ES "TIENE ALGÚN PICO": porque los 58 nodos tienen algún pico, así que la presencia
 * pelada cerraría la puerta para todos y volvería a trabar el onboarding — el bug que esa puerta vino
 * a arreglar. La distribución medida (pico máximo diario, flota entera, 2026-08-08) es bimodal y el
 * hueco es enorme: los candidatos genuinos y los 6 que hoy calientan van de 1 a 8 mensajes/día
 * (nuestro propio warmup y nada más), después hay UN caso en 110 (filing-ops.com, el del cert TLS
 * roto) y el siguiente ya está en 1.863.
 *
 * POR QUÉ SALE DEL TECHO DE LA RAMPA Y NO DE UN NÚMERO SUELTO. Estaba clavado en 20 y el comentario
 * decía "cualquier número entre 9 y 1.800 da el mismo resultado": cierto de la FOTO del 2026-08-08 y
 * falso por construcción, porque el que camina ese hueco es nuestro propio producto. La rampa sube
 * `día × RAMPA_PASO_POR_DIA_DEFAULT` (2) hasta `RAMPA_LIMITE_DIARIO_DEFAULT` (40), así que un dominio
 * que calienta BIEN cruza 20 el día 10 y llega al doble arriba de la rampa. Y `picos` se lee sobre el
 * log RETENIDO entero y no caduca: al dominio que se calla 5 días —cosa que este repo documenta como
 * rutina: 46 caps a 0 de golpe el 2026-08-04, nodos que pierden la red, el freno global— lo agarra
 * `no_traffic` con su propio pico adentro y queda excluido hasta que un humano lo nombre. O sea que
 * la puerta se cerraba justo sobre los que mejor calentaron. Atado al techo + 1, nuestro tráfico no
 * puede cruzarlo NUNCA, y el umbral se mantiene solo el día que alguien suba la rampa.
 *
 * NO CUESTA UNA EXCLUSIÓN HOY, verificado contra el sender-measurement.json de producción
 * (2026-08-08 02:08 UTC, lectura): no hay un solo nodo con pico entre 9 y 60. Los `no_traffic` son
 * 1, 1, 1, 2, 2, 3 y 110, y el cluster siguiente arranca en 426. filing-ops.com (110) sigue afuera.
 *
 * NO ES UN CANDADO PERMANENTE — y tiene que no serlo, porque condenar para siempre es el error caro
 * en la otra dirección. Un humano lo suelta nombrándolo en `WARMUP_LIVE_ARRANCA_PRIMERO`, que es la
 * lista que ya existe para decir "arrancá con éste": nombrarlo ahí ES la decisión de mirarlo.
 */
export const PICO_QUE_YA_NO_ES_NUEVO = RAMPA_LIMITE_DIARIO_DEFAULT + 1;

/**
 * El veredicto de AUTENTICACIÓN de un dominio, tal como lo dejó el barrido de reputación.
 * Sólo interesan las tres señales que, rotas, hacen que el correo no se pueda entregar bien.
 */
export interface AuthDominio {
  spf?: { estado: string };
  dkim?: { estado: string };
  ptr?: { estado: string };
  tls?: { estado: string };
  /**
   * Las listas negras que detectaron la IP del nodo. `[]` = consultado y limpio. `"no-se"` = no se
   * consultó o falló (el barrido tiene presupuesto de consultas y se le acaba).
   *
   * El tipo es el del ESCRITOR, tal cual (`FilaReputacion.listas`, agents/reputacion.ts): `"no-se"`
   * es un estado de primera clase y no un array vacío, justamente para que nadie lea "no pregunté"
   * como "está limpio".
   */
  listas?: string[] | "no-se";
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
  // LA LISTA NEGRA ENTRA ACÁ Y NO EN UNA EXCLUSIÓN NUEVA, porque es la misma pregunta: ¿este
  // dominio puede construir reputación hoy? El dato ya estaba en el archivo desde el primer
  // barrido y `leerReputacion` lo tiraba al armar el Map, así que la única válvula que existía
  // sobre él era leer el JSON a mano.
  //
  // Medido el 2026-08-07 con dig, control positivo (127.0.0.2 → 127.0.0.36 en dyna.spamrats.com) y
  // control negativo (127.0.0.1 → NXDOMAIN): corpfiling-relay.com (217.216.55.59) y
  // corpfilingrelay.com (217.216.55.64) están listados AHORA MISMO, y son dos de los siete
  // vírgenes que el operador está por soltar. Y en el propio archivo de producción hay 5 filas con
  // `listas` no vacía —annualfilings-infra.com entre ellas— sobre las que `authRota` devolvía
  // `null`: la medición existía y no frenaba nada. Calentar desde una IP listada no construye
  // reputación, la construye al revés, que es el único trabajo que no se puede deshacer.
  //
  // FAIL AL SILENCIO en `"no-se"`, igual que las otras cuatro señales: el barrido consulta con
  // presupuesto y se le acaba (54 de 66 dominios están en `"no-se"` hoy). Excluir por no haber
  // preguntado dejaría la flota entera fuera del pool por una cuota de API.
  if (Array.isArray(a.listas) && a.listas.length > 0) {
    return `la IP está en lista negra (${a.listas.join(", ")}): calentar así construye reputación al revés`;
  }
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
  auth?: ReadonlyMap<string, AuthDominio>,
  /**
   * QUIÉN ARRANCA PRIMERO, en orden (`WARMUP_LIVE_ARRANCA_PRIMERO`). Vacío ⇒ decide el alfabeto.
   *
   * Existe porque el alfabeto estaba decidiendo un dominio COMPRADO. `MAX_ARRANCANDO_A_LA_VEZ` toma
   * `arrancando.slice(0, 1)` sobre una lista que viene ordenada por nombre, así que si el operador
   * suelta los 7 vírgenes de golpe el único que entra es bizregistry-ops.com — el peor de los siete,
   * en el /24 80.190.75.x donde 11 de 13 nodos no están sanos. Verificado corriendo `elegirPool` con
   * los archivos reales: con los 7 en cap 20 entra bizregistry-ops.com; con sólo los 5 de subred
   * sana, entra controlnationalcorp.com.
   *
   * NO se ordena por "mérito calculado acá" y el porqué es que el dato no está: `elegirPool` recibe
   * salud y auth, ninguna de las dos trae la IP ni el /24, y los 7 candidatos tienen `listas:
   * "no-se"` (la cuota del barrido se agota antes de llegarles), así que cualquier criterio derivado
   * empata y el desempate vuelve a ser el alfabeto. Un criterio que empata en el caso real no es un
   * criterio: es el alfabeto con otro nombre.
   */
  arrancaPrimero: readonly string[] = []
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
  let esperanTurno: string[] = [];
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
    // LA MISMA LISTA QUE ORDENA ES LA QUE SUELTA. `arrancaPrimero` ya existe para que el operador
    // diga "arrancá con éste", y nombrar un dominio ahí ES la decisión humana de haberlo mirado. Se
    // reusa como override de la puerta de `no_traffic` con historia (ver `PICO_QUE_YA_NO_ES_NUEVO`)
    // en vez de inventar una segunda env var: dos listas para decir lo mismo se desincronizan, y una
    // exclusión sin salida es el error caro en la dirección contraria.
    const sueltosPorElOperador = new Set(arrancaPrimero.map((x) => x.trim().toLowerCase()));
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
      // UN CIERRE NO SE BORRA POR EL CALENDARIO, y sin esta línea se borraba solo.
      //
      // `estado`, `cerradoEn` y `porReceptor` se RECALCULAN en cada barrido sobre una ventana de 5
      // días por fecha de línea; lo único pegajoso era `cruzados`. Consecuencia con fecha: NFC dejó
      // de inyectar por el /24 80.190.73.x el 2026-08-05, así que alrededor del 9-11 de agosto sus
      // TRES nodos pasan solos a `no_traffic` 0/0/0 — y `no_traffic` es justo la puerta que se abrió
      // para que los dominios nuevos puedan arrancar. Un nodo con 56 rechazos 550-5.7.1 de Gmail de
      // hace cuatro días (controlstatecorp.com) volvería a leerse como "nodo NUEVO, candidato
      // natural a arrancar". Ya pasó una vez con nationalfiling-infra.com: estuvo en el pool el
      // 2026-08-05 y mandó un correo real; hoy tiene `cruzados: ["google"]`.
      //
      // Va DESPUÉS de `blocked_by_provider` a propósito: si el estado ya lo dice, el motivo del
      // estado es más fresco y más fácil de leer. Éste es el arrastre, el caso del que se recuperó
      // de mentira.
      //
      // Y EL MOTIVO DICE EL CAMINO DE VUELTA, porque no hay ninguno automático. `cerradoEn` no
      // caduca a propósito (ver el `ponytail:` de sender-measurement.ts), así que un dominio que se
      // recupere de verdad queda inelegible PARA SIEMPRE — y hoy son 43 de los 58, los 43 medidos
      // con `modo: "todo"`, o sea sobre el mail.log entero del nodo, con el correo de NFC adentro.
      // Entre ellos los 6 que el encargo lista como limpios (controlstatecorp.com,
      // docfiling-ops.com, infranationalcorp.com, nationalcorp-infra.com, corpregistry-control.com,
      // bizfiling-infra.com). El des-pegado es un acto humano deliberado y está bien que lo sea; lo
      // que NO puede ser es un acto humano que nadie sabe que existe.
      if ((s.cerradoEn ?? []).length > 0) {
        return `cerrado por el receptor (arrastrado: ${s.cerradoEn.join(", ")}) — no caduca solo, se olvida borrando \`cerradoEn\` de este dominio en sender-measurement.json`;
      }
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
      // ── Y ACÁ ESTABA LA MENTIRA DE ESTE COMENTARIO, corregida el 2026-08-08 ──────────────────
      //
      // Decía: "las cuatro razones para NO calentar ya se evaluaron ARRIBA y ninguna depende de la
      // ventana ... cerrado/atascado son estados, no ausencias". Es FALSO para `stalled`: `stalled`
      // se recalcula entero sobre los 5 días y no escribe NADA pegajoso — ni `cerradoEn` ni
      // `cruzados`. La puerta 4xx nueva devuelve `stalled` con `blockedProviders: []` a propósito, y
      // `insufficient_sample` tampoco escribe. O sea que un nodo cerrado por el receptor que después
      // se calla vuelve a leerse `no_traffic`, que es EXACTAMENTE esta puerta. Sólo `cruzados` es
      // pegajoso de verdad.
      //
      // Lo que sigue en pie: un dominio recién comprado tiene el mail.log vacío ⇒ `no_traffic`, y si
      // eso excluyera la trampa se cerraría sola (no entra ⇒ no manda ⇒ sigue `no_traffic`). Por eso
      // la puerta no se cierra: se le pone el discriminante que faltaba.
      //
      // "NUEVO" NO ES "CALLADO". `picos` se lee sobre el log RETENIDO entero, no sobre la ventana, y
      // por eso es memoria: un dominio con historia no es virgen aunque hoy no diga nada. Ver
      // `PICO_QUE_YA_NO_ES_NUEVO` para el nodo medido (controlcontrolledger.com, 98% de rebote en
      // Gmail y quemado además en Microsoft, Apple y Cloudmark) que entraba por acá como si fuera
      // recién comprado.
      //
      // Ojo con la lectura ciega: si el nodo escribe la fecha en un formato que el corte por día no
      // reconoce, también da 0/0/0. Eso NO llega acá como `no_traffic` — readNodeDeliveryHealth lo
      // devuelve `unreadable` justamente para que no se confunda con un nodo nuevo.
      // ponytail: `picos: []` significa las DOS cosas —"nunca movió nada" y "el canal de volumen no
      // pudo leer"— porque sender-measurement escribe `[]` en los dos casos. Acá se lee como "nuevo",
      // que es fail-open; para cerrarlo hay que separar los dos casos en el escritor (`null` vs `[]`),
      // que toca el JSON que sirve el panel. Se hace el día que un nodo se cuele por ahí.
      if (s.estado === "no_traffic") {
        const pico = Math.max(0, ...(s.picos ?? []).map((p) => p.mensajes ?? 0));
        if (pico >= PICO_QUE_YA_NO_ES_NUEVO && !sueltosPorElOperador.has(d.trim().toLowerCase())) {
          return `sin tráfico HOY pero con historia en el log (pico de ${pico} mensajes/día): no es un dominio nuevo y no arranca solo — si de verdad hay que soltarlo, va nombrado en WARMUP_LIVE_ARRANCA_PRIMERO`;
        }
        // ── Y ACÁ, Y SÓLO ACÁ, EL "NO SÉ" DE LISTAS NEGRAS SÍ FRENA ────────────────────────────
        //
        // `authRota` falla al silencio ante `listas: "no-se"` y está bien que lo haga para los que ya
        // calientan: el barrido consulta con presupuesto y se le acaba (49 de 66 dominios en "no-se"
        // el 2026-08-08), así que excluir por no haber preguntado apagaría la fábrica por una cuota
        // de API. Pero por ESTA puerta pasa el PRIMER correo de un dominio virgen, y el primer correo
        // desde una IP listada construye reputación al revés — el único trabajo que no se deshace.
        // Los dos errores no son simétricos: al que ya calienta, un "no sé" le cuesta un día; al que
        // estrena, le cuesta el dominio.
        //
        // NO ES HIPOTÉTICO, medido el 2026-08-08 con dig y controles (127.0.0.2 prende las tres
        // listas, 127.0.0.1 no prende ninguna): corpfiling-relay.com (217.216.55.59) y
        // corpfilingrelay.com (217.216.55.64) están listados AHORA MISMO en dyna.spamrats.com
        // (127.0.0.36) y el archivo de reputación dice `listas: "no-se"` para los dos. Los siete
        // candidatos `no_traffic` están en ese estado. Lo único que hoy los frena es que están en cap
        // 0 y que el alfabeto pone antes a bizregistry-ops.com — ninguna de las dos cosas es una
        // medición.
        //
        // Y frena TAMBIÉN cuando no hay archivo de reputación (auth `undefined`): si nadie consultó
        // ninguna IP, ningún dominio virgen puede estrenar. Los que ya calientan no se tocan.
        if (!Array.isArray(auth?.get(d)?.listas)) {
          return "nunca mandó y su IP no figura consultada en listas negras (warmup-reputacion.json): un dominio nuevo no estrena a ciegas";
        }
        return null;
      }
      // `unreadable` no necesita rama propia: cae acá, con un motivo más honesto que el estado.
      if (s.entregados === null || s.entregados === undefined) return "sin lectura de entregas: no sé";
      // ENTREGARSE CORREO A SÍ MISMO NO ES ENTREGAR, y hasta el 2026-08-08 esto se medía con el TOTAL.
      //
      // `entregados` es `stats.totals.delivered`, que trae adentro el correo que el nodo se manda a
      // sí mismo por el pipe de rebotes (`delivered to command: /usr/local/bin/nfc-verp-bounce.sh`).
      // Un nodo puede tener decenas de "entregas" sin que UNA sola haya salido de la máquina.
      //
      // MEDIDO POR SSH CONTRA LOS NODOS REALES, con la ventana corrida a 3 días (que es literalmente
      // lo que va a hacer el calendario cuando el nodo deje de mandar):
      //   · corpfilingcontrol.com (193.181.212.223) ⇒ `healthy`, "0 entregados a terceros ... (y 6 a
      //     sí mismo)", y ENTRABA al pool. Log retenido: 16.525 mensajes rebotados en gmail.com
      //     contra 495 entregados, 97% de rechazo.
      //   · annualcorp-control.com (80.190.76.57) ⇒ lo mismo con 2 auto-entregas. Log retenido: 4.087
      //     rebotados en gmail contra 483 entregados, más 505 de Yahoo `553 5.7.2 [TSS09] ...
      //     permanently deferred`.
      // Sobre la flota entera con esa ventana el pool saltaba de 6 a 25 boxes, y 19 de esos 25 tenían
      // CERO entregas a terceros. El `detalle` lo decía en la cara ("0 entregados a terceros") y el
      // pool los dejaba entrar igual.
      //
      // ACÁ MURIÓ EL GUARD DE AUTO-ENTREGA POR `porReceptor`, y no por gusto: leía PRESENCIA de una
      // fila del dominio propio, y `porReceptor` sale filtrado a 20 intentos en sender-measurement.ts
      // — en estos nodos llega VACÍO, así que `aSiMismo` daba 0 y la condición no podía disparar
      // nunca. Era decorativo. El sensor ya sabía la respuesta correcta y la tiraba: calculaba
      // `aTerceros` sólo para escribir la frase del detalle. Ahora la publica en el veredicto.
      //
      // EL FALLBACK A `entregados` NO ES PEREZA: es el día del despliegue. Los archivos escritos por
      // la medición vieja no traen el campo, y leer ausencia como cero dejaría la flota entera fuera
      // del pool de una — que es el mismo modo de falla ("campo que todavía no viene leído como
      // evidencia") que este lote viene arreglando. `null` sí es "no sé" y ya lo agarró la línea de
      // arriba.
      //
      // CONTRAFACTUAL, con los datos de 3 días: con esta regla el pool pasa de 25 a 7 — caen los 19
      // de auto-entrega y quedan los reales, que tienen 4/5/5/7/6/11 entregas a terceros. Ninguno de
      // los 6 que hoy calientan se pierde.
      //
      // ── Y CON LA VENTANA REAL DE 5 DÍAS NO SACA A NADIE, medido el 2026-08-08 ──────────────────
      //
      // El contrafactual de arriba es el de la ventana corrida a 3 días, y con la ventana de verdad
      // el filtro es un NO-OP. Cuenta hecha sobre la foto de producción (sender-measurement.json,
      // medidoEn 14:16:49Z), restándole a `entregados` la fila del propio dominio en `porReceptor`:
      // 32 de las 58 bandejas tienen esa fila, y de las que están `healthy` TODAS dan 1 o 3 entregas
      // a terceros — annualfiling-relay.com 51 entregas de las cuales 50 a sí mismo, corpannual-
      // control.com 59 de 58, infracorpfiling.com 52 de 51, corpfilinginfra.com 41 de 38. O sea que
      // el 96-98% de sus "entregas" son al pipe de rebotes de NFC y con `MIN_ENTREGAS_EN_VENTANA = 1`
      // pasan igual, con UN mensaje en cinco días. De las otras 26 no se puede decir nada: su fila
      // propia no llega al piso de 20 de `porReceptor` y no está en el archivo.
      //
      // NO SE SUBE LA CONSTANTE ACÁ. Subirla es un cambio de VOLUMEN POR DOMINIO y necesita la firma
      // del operador: el sobre del daemon es GLOBAL (14 vueltas/día para toda la flota), así que
      // achicar el pool no baja el correo total, lo CONCENTRA. Peor caso medido de subirlo a 5: el
      // pool cae de 32 a los pocos con evidencia real y cada uno pasa de ~0,44 a ~2 envíos/día — que
      // es lo que la rampa necesita, y exactamente por eso no se decide desde un comentario.
      const entregasQueSalieron = s.entregadosATerceros ?? s.entregados;
      if (entregasQueSalieron === null || entregasQueSalieron < MIN_ENTREGAS_EN_VENTANA) {
        return s.entregados > 0
          ? `sus ${s.entregados} entregas de la ventana son a sí mismo: ninguna salió a un tercero`
          : "ninguna entrega en la ventana";
      }
      // ── LA PUERTA SE CIERRA POR LISTA BLANCA, NO POR LISTA NEGRA ─────────────────────────────
      //
      // Todo lo de arriba es lista NEGRA: nombra estados de a uno (`blocked_by_provider`, `stalled`,
      // `no_traffic`) y lo que no coincide con NINGUNO llega hasta el `return null` y ENTRA AL POOL.
      // `SaludDominio.estado` es `string`, ni siquiera la unión: agregarle un estado al sensor no
      // rompe la compilación de este archivo, y el estado nuevo nace ADENTRO del pool.
      //
      // Es la forma exacta del bug que este mismo pool ya tuvo: `no_own_traffic` se agregó al sensor
      // el 2026-08-06 y llegó hasta acá SIN rama propia. Hoy no se cuela de casualidad —el escritor
      // le pone `entregados: 0` y lo agarra el filtro de arriba—, o sea que lo único que lo tapa es
      // un campo de OTRO módulo. El día que esa medición traiga un `entregados` distinto de 0, entra.
      // Y el guard de auto-entrega de diez líneas más arriba tampoco lo agarraría: `porReceptor` sale
      // filtrado por los mismos 20 intentos en sender-measurement.ts y en los nodos chicos llega
      // vacío, así que `aSiMismo` da 0 y la condición no puede disparar.
      //
      // Y el que viene con nombre, número y fecha: la fila REAL de producción del 2026-08-08 02:08
      // UTC de annualcorp-control.com dice `estado: "healthy"`, `entregados: 16`, `rechazados: 1`,
      // `porReceptor: []`, `cerradoEn: []` — sobre un nodo al que Gmail le rechazó 136 mensajes con
      // 550-5.7.1 cuatro días antes. Hoy ese nodo ENTRA al pool, y el arrastre pegajoso no lo tapa
      // porque `cerradoEn` está vacío. Cuando el sensor deje de llamarle "healthy" a lo que no midió,
      // el estado nuevo tiene que quedar afuera SIN que nadie se acuerde de agregar una rama acá.
      //
      // COMPORTAMIENTO IDÉNTICO HOY, verificado leyendo la cadena entera: de los siete estados que
      // emite el sensor, cinco ya retornaron arriba (`blocked_by_provider` y `stalled` por rama
      // propia, `no_traffic` con `return null`, y `unreadable`/`no_own_traffic` por `entregados`
      // null o 0), así que lo único que llegaba hasta acá era `healthy` y `degraded`.
      //
      // Y NO ES UN CANDADO: esto excluye por HOY, no para siempre. No escribe `cerradoEn` ni ningún
      // arrastre — el barrido siguiente recalcula el estado y el dominio vuelve solo. La asimetría es
      // deliberada: `cerradoEn` se pega porque 20 intentos al 90% de rechazo es evidencia fuerte;
      // "no entiendo este veredicto" justifica un "hoy no", nunca un "nunca más".
      if (s.estado !== "healthy" && s.estado !== "degraded") {
        return `estado \`${s.estado ?? "sin estado"}\`: el pool no se llena con un veredicto que no sé leer`;
      }
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
    // ── ENTRA UN DOMINIO NUEVO POR VEZ ──────────────────────────────────────────────────────────
    //
    // El daemon reparte UNA vuelta por dominio contra un sobre global (hoy 14 vueltas/día para toda
    // la flota), así que sumar dominios al pool no suma volumen: lo REPARTE. Corrido con el código
    // real sobre la foto de producción del 2026-08-07, soltar los 7 vírgenes de golpe devuelve 13
    // boxes y `avisoDeSobre` imprime que cada uno recibiría ~1,08 envíos/día — los 6 que hoy
    // calientan caen de 2,00 a 1,08, o sea −46%, y con menos de 2/día NADIE junta las 4 mediciones
    // propias que la rampa pide para moverse.
    //
    // Y hay un daño peor que la dilución: la simulación sobre `decideDaemonAction` con los motivos
    // ya medidos (4 de los 7 con razón para entregar mal) da 46% de bandeja al día 5 ⇒
    // `placement-pause` para TODA la flota, incluido el único que va al 83%. Esa pausa no sale sola,
    // porque parado no se mide y las muestras malas quedan siendo las más nuevas de la ventana.
    // Con uno por vez, el freno FINO de ese dominio lo baja a cupo 0 a las 4 mediciones (~día 3),
    // muy antes de las ~12 que harían falta para mover la tasa de la flota entera.
    //
    // Los que esperan se DECLARAN con nombre: una cola silenciosa se lee como "no los soltaron".
    // La cola avanza cuando el barrido de salud ve el primer envío del que entró (≤6 h) y deja de
    // ser `no_traffic`.
    // ponytail: si hiciera falta más rápido, la señal es la primera fila `sent` del dominio en la
    // base, no otro archivo.
    // EL QUE ENTRA SALE DE UNA LISTA EXPLÍCITA CUANDO LA HAY, y del alfabeto cuando no. Ver
    // `arrancaPrimero`. Los nombres que no son candidatos hoy se ignoran solos (el filtro es sobre
    // `arrancando`), así que la env var se puede dejar escrita entre corridas sin efectos raros.
    if (arrancaPrimero.length > 0) {
      const rango = new Map(arrancaPrimero.map((d, i) => [d.trim().toLowerCase(), i]));
      arrancando.sort(
        (a, b) =>
          (rango.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) - (rango.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) ||
          a.localeCompare(b)
      );
    }
    const enEspera = arrancando.slice(MAX_ARRANCANDO_A_LA_VEZ);
    if (enEspera.length > 0) {
      const espera = new Set(enEspera);
      for (const d of enEspera) excluidos.push(`${d} (espera turno: entra un dominio nuevo por vez)`);
      arrancando.length = MAX_ARRANCANDO_A_LA_VEZ;
      conCupo = sobreviven.filter((d) => !espera.has(d));
    } else {
      conCupo = sobreviven;
    }
    esperanTurno = enEspera;
  }
  const antiguedad = sinMedicion
    ? " — SIN ninguna medición del cupo: nadie verificó cuánto puede mandar cada uno"
    : cupos.vencida
      ? ` — medición de hace ${cupos.edadHoras ?? "?"}h, VENCIDA: sirve para saber a quién intentarle, no para decidir volumen`
      : "";
  // Los excluidos se DECLARAN, siempre. Un pool que se achica en silencio hace creer al operador
  // que hay menos nodos con cupo de los que hay, y esconde justo el problema que hay que resolver.
  const sacados = excluidos.length > 0 ? ` · ${excluidos.length} fuera: ${excluidos.slice(0, 4).join(", ")}${excluidos.length > 4 ? ` y ${excluidos.length - 4} más` : ""}` : "";
  // QUIÉN ELIGIÓ AL QUE ENTRA, dicho en la misma línea. Sin esto, "entran a arrancar: X" se lee como
  // una decisión y es el orden alfabético: el operador no tiene forma de saber que puede cambiarlo,
  // ni que el que entró no fue elegido por ninguna razón.
  const cola = esperanTurno.length > 0
    ? ` (${esperanTurno.length} ${esperanTurno.length === 1 ? "espera" : "esperan"} turno: ${esperanTurno.join(", ")}` +
      `${arrancaPrimero.length > 0 ? "" : " — el orden lo decidió el ALFABETO; para elegir vos, WARMUP_LIVE_ARRANCA_PRIMERO"})`
    : "";
  const nuevos = arrancando.length > 0 ? ` · ${arrancando.length} sin tráfico todavía, entran a arrancar: ${arrancando.slice(0, 4).join(", ")}${arrancando.length > 4 ? ` y ${arrancando.length - 4} más` : ""}${cola}` : cola;
  const universo = sinMedicion ? configurado.length : cupos.porDominio.size;
  const deQue = sinMedicion ? "nodos del pool configurado" : "nodos medidos";
  // LA LÍNEA TIENE QUE SUMAR, y no sumaba: los nodos en cap 0 se descartan en el filtro de arriba,
  // ANTES de que exista el array `excluidos`, así que no aparecían en ningún lado del log. La línea
  // de producción del 2026-08-07 decía "6 de 57 nodos medidos aptos · 43 fuera" — 6 + 43 = 49, y
  // los 8 que faltan son los frenados en cap 0, o sea los 7 vírgenes que el operador compró y no
  // calienta. Un número que no cierra esconde justo la pregunta de negocio ("compramos 58 dominios
  // y calentamos 6"), y encima se lee como si la flota fueran 49 nodos.
  const enCeroFisico = sinMedicion ? [] : [...cupos.porDominio.entries()].filter(([, cap]) => cap <= 0).map(([d]) => d).sort();
  const frenados = enCeroFisico.length > 0
    ? ` · ${enCeroFisico.length} frenado${enCeroFisico.length === 1 ? "" : "s"} en cap 0: ${enCeroFisico.slice(0, 4).join(", ")}${enCeroFisico.length > 4 ? ` y ${enCeroFisico.length - 4} más` : ""}`
    : "";
  if (conCupo.length === 0) {
    return {
      boxes: [],
      motivo: `ninguno de los ${universo} ${deQue} sirve para calentar${sacados || ": están todos en cap 0"}${frenados}${antiguedad}`
    };
  }
  return { boxes: conCupo, motivo: `${conCupo.length} de ${universo} ${deQue} aptos${sacados}${nuevos}${frenados}${antiguedad}` };
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
        cerradoEn?: string[];
        entregados?: number | null;
        entregadosATerceros?: number | null;
        picos?: Array<{ mensajes?: number }>;
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
          cerradoEn: b.cerradoEn,
          entregados: b.entregados,
          entregadosATerceros: b.entregadosATerceros,
          // El archivo SIEMPRE trajo `picos` y este mapeo no los leía. Sin ellos la puerta de
          // `no_traffic` no tiene con qué distinguir un dominio nuevo de uno quemado que se calló.
          picos: b.picos,
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
      dominios?: Array<{
        dominio?: string;
        spf?: { estado: string };
        dkim?: { estado: string };
        ptr?: { estado: string };
        tls?: { estado: string };
        listas?: string[] | "no-se";
      }>;
    };
    const m = new Map<string, AuthDominio>();
    for (const d of j.dominios ?? []) {
      // `listas` viajaba en el archivo y se caía acá: el Map se armaba con cuatro campos y el
      // quinto se perdía en silencio, así que `authRota` no podía mirarlo ni queriendo.
      if (d.dominio) m.set(d.dominio, { spf: d.spf, dkim: d.dkim, ptr: d.ptr, tls: d.tls, listas: d.listas });
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
  /**
   * Foto de autenticación de la flota (warmup-reputacion.json).
   *
   * TIENE DEFAULT POR LA MISMA RAZÓN QUE `seedsFile`, y esto se midió: sin default, el llamador que
   * le habla al jefe —`scripts/ops/warmup-monitor.ts`, o sea el canal del agente por Slack— no lo
   * pasaba, así que `leerReputacion` no corría y `authRota` no excluía a nadie POR ESE CAMINO. Sobre
   * la foto del 2026-08-08, con `elegirPool` real: el agente reportaba 36 dominios y el daemon
   * calentaba 32. Los 4 de más eran annualfiling-ops.com (DRONE BL), annualfilingops.com y
   * annualfilings-infra.com (RATS Dyna) y controldelivrix.app (PTR roto) — justo lo que `authRota`
   * existe para sacar. El lote anterior cableó el archivo en la ruta del PANEL (main.ts) y dejó el
   * canal del AGENTE sin tocar: son dos llamadores de la MISMA función, y arreglar uno no arregla
   * al otro. Por eso el default vive acá y no en cada llamador — el próximo llamador nace bien.
   *
   * Peor: sin el archivo, la puerta de los dominios VÍRGENES (`no_traffic`) los excluye con el texto
   * «su IP no figura consultada en listas negras (warmup-reputacion.json)» hablando de un archivo
   * que ese llamador nunca abrió. El motivo era cierto y la causa era falsa.
   *
   * Sólo puede ACHICAR el pool: es una lista de exclusiones y nunca agrega a nadie. Y `leerReputacion`
   * ya devuelve `undefined` ante archivo ausente o roto, así que el default no puede romper a nadie.
   */
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
  const auth = await leerReputacion(input.reputacionFile ?? rutaInventario("warmup-reputacion.json"));
  const proveedores = await leerProveedoresDeSemillas(input.seedsFile ?? rutaInventario("warmup-seeds.json"));
  const proveedorDe = (semilla: string): string | null => proveedores?.get(semilla.trim().toLowerCase()) ?? null;
  // LA MISMA COLA QUE EJECUTA EL DAEMON. `WARMUP_LIVE_ARRANCA_PRIMERO` se lee del MISMO entorno: si
  // el panel decidiera el orden de arranque por su cuenta, volvería a mostrar un pool que no es el
  // que corre — que es exactamente la divergencia que las palancas de la rampa vinieron a cerrar.
  const pool = elegirPool(
    cupos,
    input.poolConfigurado,
    salud,
    auth,
    ((input.env ?? process.env).WARMUP_LIVE_ARRANCA_PRIMERO ?? "").split(",").map((x) => x.trim()).filter(Boolean)
  );
  // SIN MEDICIÓN DE SALUD, EL PLAN Y EL DAEMON DEJAN DE COINCIDIR, Y ACÁ SE DICE.
  //
  // `poolSinSalud` (live-warmup-daemon.ts) degrada al pool CONFIGURADO cuando el archivo de salud no
  // se puede leer, y `medirFlota` reescribe ese archivo ENTERO: una escritura cortada lo deja
  // inválido. En ese estado el daemon calienta 1 dominio y esta función devuelve 44 —los 44 con
  // cap > 0, incluidos los 8 que cruzaron el umbral permanente—, que es lo que el panel muestra y lo
  // que el agente le reporta al jefe.
  //
  // La degradación NO se mueve para acá a propósito (ver el comentario de `poolSinSalud`): el que
  // MANDA es el daemon, y dejar al panel sin plan no protege nada y encima esconde. Pero la
  // asimetría sólo es honesta si se DICE, y no se decía: el motivo salía idéntico al de un día
  // normal. Es la misma regla que `arrancaPrimero` aplica veinte líneas más arriba — el panel no
  // puede mostrar un pool que no es el que corre sin avisar que no es el que corre.
  if (salud === undefined) {
    pool.motivo += ` · OJO: sin medición de salud legible, ESTE NO ES EL POOL QUE CORRE — el daemon se degrada a los ${input.poolConfigurado.length} del pool configurado`;
  }

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
      soloDiasHabiles: rampa.soloDiasHabiles,
      pisoSostener: rampa.pisoSostener
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

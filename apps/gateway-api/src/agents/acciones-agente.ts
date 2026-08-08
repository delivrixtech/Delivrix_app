// LAS MANOS DEL AGENTE — lo único que puede HACER por sí solo.
//
// Hasta acá el agente miraba y opinaba: decía "RIESGO: bizreport-control.com cruzó el umbral" y
// ahí terminaba. Alguien tenía que leerlo y actuar. Eso no es un agente, es un termómetro caro.
//
// EL LÍMITE, y es duro: el agente solo puede ejecutar acciones que REDUCEN. Frenar, pausar,
// anotar. Nunca subir volumen, nunca mandar correo, nunca gastar plata, nunca aprovisionar. La
// razón no es desconfianza en el modelo: es que las acciones reductoras son reversibles y su peor
// caso es "calentamos de menos un rato", mientras que las expansivas tienen un peor caso
// irreversible (cruzar el umbral permanente de Google se pierde una sola vez).
//
// Por eso el catálogo NO es una lista de tools que el modelo elige libremente sobre parámetros
// libres. Cada acción:
//   1. está en una lista blanca cerrada — lo que no está, no existe;
//   2. valida sus parámetros contra el estado real (un dominio que no está en el inventario no se
//      puede tocar);
//   3. es idempotente — repetirla no acumula efecto;
//   4. deja rastro con antes/después, porque una acción automática sin registro es indefendible.
//
// Lo que el agente NO puede resolver solo (agregar una semilla, soltar cupo, comprar un dominio)
// no se queda dando vueltas en cada lectura: se ANOTA como pendiente del operador, una sola vez,
// con su motivo. Repetir "falta una semilla de Yahoo" cada 10 minutos durante una semana no es
// insistencia, es ruido que entrena a ignorar al agente.

export type NombreAccion =
  | "frenar_dominio"
  | "soltar_dominio"
  | "pausar_warmup"
  | "anotar_pendiente"
  | "resolver_pendiente"
  | "proponer_subida"
  | "leer_cupo_nodo"
  | "diagnosticar_dominio"
  | "medir_dominio"
  | "revisar_reputacion"
  | "bajar_cap_nodo"
  | "que_paso";

/**
 * El cupo con el que vuelve un dominio soltado. NO lo elige el modelo, y esa es toda la seguridad
 * de la acción: es el mismo número que el operador usa a mano como `--cap-excepto`, elegido porque
 * cubre las 3 vueltas diarias del calentamiento y mata cualquier volumen de producción.
 *
 * Si el agente se equivoca de candidato, el daño máximo es un dominio mandando 20 correos al día
 * que no debería. Con un cupo elegido por el modelo, el daño máximo sería el umbral permanente de
 * Google — irreversible. La diferencia entera está en que este número es una constante.
 */
/**
 * Los nombres válidos, en un Set. Existe para que `extraerAcciones` pueda TOLERAR el desliz de
 * escribir el objeto pegado al nombre; el switch de abajo sigue siendo la única lista blanca que
 * decide qué se ejecuta.
 */
export const ACCIONES_VALIDAS: ReadonlySet<string> = new Set<NombreAccion>([
  "frenar_dominio",
  "soltar_dominio",
  "pausar_warmup",
  "anotar_pendiente",
  "resolver_pendiente",
  "proponer_subida",
  "leer_cupo_nodo",
  "diagnosticar_dominio",
  "medir_dominio",
  "revisar_reputacion",
  "bajar_cap_nodo",
  "que_paso"
]);

/**
 * LAS MANOS QUE SOLO MIRAN. No mutan nada y su resultado depende únicamente del estado del mundo,
 * así que pedirlas dos veces seguidas sin que cambie nada devuelve lo mismo dos veces.
 *
 * Existe para acotar el corte del bucle a este grupo, y esa restricción es deliberada: un
 * `frenar_dominio` que devuelve el mismo detalle dos veces PUEDE ser legítimo (el operador soltó el
 * nodo en el medio y hay que volver a frenarlo, con idéntico "cap 20 → 0"), y bloquear una acción
 * que REDUCE por parecerse a la anterior es el error caro de los dos.
 */
const PASIVAS: ReadonlySet<string> = new Set<NombreAccion>([
  "leer_cupo_nodo",
  "diagnosticar_dominio",
  "medir_dominio",
  "revisar_reputacion",
  // `que_paso` entra acá aunque su resultado dependa de la VENTANA pedida y no solo del mundo, y
  // eso es justamente lo que la hace segura de cortar: el corte compara el DETALLE de las dos
  // últimas veces (`daLoMismo` → `detalleIgualSeguidas`), y el detalle lleva las dos fechas
  // adentro. Preguntar por otra semana devuelve otro texto y el corte no se activa. Lo que sí
  // corta es preguntar TRES veces lo mismo sobre la misma ventana, que es el bucle medido: 113 de
  // los 231 episodios con hueco eran "medir/diagnosticar los frenados", ya pedido 45 veces con la
  // misma respuesta.
  "que_paso"
]);

/**
 * El cupo al que se BAJA un nodo que está cableado por encima del techo que aguanta un dominio.
 *
 * Es el mismo TECHO_DURO_POR_DOMINIO del motor (2.000/día), y no lo elige el modelo — igual que
 * CAP_AL_SOLTAR. Existe porque al agente le faltaba la mano del medio: sus opciones eran matar el
 * nodo (cap 0) o soltarlo en 20, y con `infranationalreport.com` cableado a 15.000/día contra un
 * techo de 2.000, matarlo era desproporcionado —por ese nodo sale correo de un cliente— así que la
 * única salida que le quedaba era escribirle a Juanes. Le pasaba un problema que podía resolver.
 *
 * Bajar un cap es una REDUCCIÓN, y por la regla de este módulo una reducción siempre está
 * permitida: su peor caso es "mandamos de menos un rato", que es recuperable. Lo irreversible es
 * al revés.
 */
export const CAP_SEGURO_POR_DOMINIO = 2000;

export const CAP_AL_SOLTAR = 20;

/**
 * EL RECHAZO POR ALCANCE, en un solo lugar. Decía "no está en el inventario" y eso es FALSO: es una
 * afirmación del sistema sobre su propia flota, y de las peores, porque el agente la lee y concluye
 * que el dominio no existe.
 *
 * Medido el 2026-08-07 contra los archivos de producción: `dominiosConocidos` trae 30 nombres —los
 * del retrato del día— mientras sender-cap.json tiene 57 nodos medidos. Los otros 27 SÍ están en el
 * inventario (sender-cap.json, warmup-reputacion.json y smtp-credentials.json), y 32 de los 54 en
 * lista negra caen ahí. No es hipotético: en runtime/logs/warmup-monitor.log hay 3 rechazos de este
 * tipo, sobre corpfiling-control.com (×2) y annualfilingcontrol.com.
 *
 * El texto ahora dice lo que pasa de verdad —qué puedo mirar ESTA vuelta— y separa explícitamente
 * "no lo tengo a mano" de "no existe", que es la misma distinción que el resto del sistema hace
 * entre "no medido" y "cero". Ensanchar la lista es del lado del productor
 * (scripts/ops/warmup-monitor.ts); esto es que el rechazo deje de mentir mientras tanto.
 *
 * Va como constante y no repetido diez veces porque estaba repetido diez veces, y por eso pudo
 * volverse falso en los diez a la vez sin que nadie lo notara.
 */
const fueraDeAlcance = (dominio: string | null | undefined): string =>
  `rechazada: "${dominio}" no está entre los dominios que puedo mirar en esta vuelta (eso NO quiere decir que no exista: la fábrica tiene más nodos de los que entran en el retrato del día)`;

/**
 * El techo diario POR DOMINIO que este proyecto se puso, y el umbral de Google que es PERMANENTE.
 *
 * Van juntos y en código porque son las dos varas contra las que se mide cualquier propuesta de
 * subir volumen: cruzar los 5.000/día a personales clasifica el dominio como "bulk sender" para
 * siempre y se pierde una sola vez (cita verificada en la doc oficial). El 2.000 es nuestro techo
 * recomendado, con margen para que ningún error de cálculo se coma la distancia al 5.000.
 *
 * Los subdominios SUMAN al mismo contador: la distancia se mide sobre el dominio primario.
 */
export const TECHO_DIARIO_RECOMENDADO = 2_000;
export const UMBRAL_PERMANENTE_GMAIL = 5_000;

/** Cuántas mediciones propias hacen falta para que la historia de un dominio pese en su contra. */
export const MUESTRA_PARA_JUZGAR = 3;

/** Debajo de esta tasa de bandeja, un dominio con historia suficiente no vuelve al pool. */
export const PISO_PARA_SOLTAR = 0.5;

/**
 * ¿Por qué este dominio frenado NO puede volver al pool? Devuelve el motivo, o `null` si califica.
 *
 * Es la MISMA regla que ejecuta `soltar_dominio` —abajo la llama tres veces, una por cada dato que
 * va consiguiendo— y existe como función aparte por una razón medida: en 31 entradas de la bitácora
 * hubo UN solo intento de soltar, contra bizreport-control.com, justo el único dominio quemado.
 * Mientras tanto 7 nodos vírgenes que califican de sobra llevan semanas en cap 0.
 *
 * El motivo no es que el modelo sea tonto: es que las condiciones vivían en PROSA dentro del prompt
 * ("soltar_dominio si alguno califica"), así que tenía que adivinar cuál calificaba. Y este
 * proyecto ya pagó dos veces la misma lección: un criterio escrito en prosa el modelo lo devuelve
 * como hallazgo propio, y si es falso lo devuelve con seguridad. Las condiciones tienen que
 * llegarle YA EVALUADAS, como dato al lado de cada dominio.
 *
 * Por eso se exporta: quien arma el prompt (warmup-monitor.ts) llama a ESTA función, no reescribe
 * los umbrales. Si divergieran, el agente vería candidatos que el código después rechaza — una
 * promesa que se rompe al ejecutarla, que es peor que no haberla hecho.
 */
export function porQueNoVuelve(d: {
  /**
   * Cruzó el umbral permanente de Google o está en su tope. Irreversible.
   *
   * TRES estados, y `null` —"no se pudo mirar"— es uno de ellos. Con dos estados el gate FALLABA
   * ABIERTO por el camino más banal que hay: quien produce este dato lo lee de
   * `sender-measurement.json` con un `.catch(() => null)`, así que un archivo ilegible (o a medio
   * escribir durante un deploy) llegaba acá como lista vacía ⇒ `cruzado: false` ⇒ un dominio que
   * cruzó el umbral PERMANENTE volvía al pool con cupo 20. Reproducido: con la lista poblada el
   * rechazo sale; con la lista vacía salía `ejecutada: true, cap 20` sobre bizreport-control.com.
   *
   * OJO al llamador: quien traduce una lista a este campo tiene que mapear la lista VACÍA a `null`,
   * no a `false`. `[]` es truthy en JavaScript y ese detalle se llevó puesto el primer intento de
   * arreglo — ver el comentario largo del tramo (0) en `soltar_dominio`.
   *
   * El prompt ya decía la verdad ("umbral permanente: sin dato") mientras el gate decía en silencio
   * "no cruzó". Es la lección de "no medido ≠ cero" aplicada a la mitad.
   */
  cruzado: boolean | null;
  /** Receptores que hoy le tienen la puerta cerrada. */
  bloqueanPor: readonly string[];
  /** Mediciones propias de placement. 0 = nunca se midió, que NO es lo mismo que 0% de bandeja. */
  muestra: number;
  tasaInbox: number | null;
}): string | null {
  if (d.cruzado === null)
    return "no se pudo leer la medición de la flota: no sé si cruzó el umbral permanente, y eso no se da por bueno.";
  if (d.cruzado) return "ya cruzó el umbral permanente o está en su tope. Eso no se deshace enviando — devolverle cupo solo gasta envíos.";
  // SIN IMPERATIVO, y no es cosmético: esta cadena la cita textual `lineasDeFrenados` dentro del
  // prompt, donde hay una prohibición dura de dar órdenes (hay un test con regex). Decía "hay que
  // destrabar al receptor primero" y entraba al prompt tal cual: el modelo devuelve un consejo del
  // prompt como si fuera hallazgo propio, que es la lección que este proyecto ya pagó dos veces.
  if (d.bloqueanPor.length > 0)
    return `lo tiene cerrado ${d.bloqueanPor.join(", ")}. Soltarlo ahí produce rebotes mientras el receptor siga cerrado.`;
  // Sin mediciones SÍ califica: un dominio nuevo no tiene historia, y exigir evidencia que solo
  // puede aparecer enviando es el candado que tuvo la flota entera parada.
  if (d.muestra >= MUESTRA_PARA_JUZGAR && d.tasaInbox !== null && d.tasaInbox < PISO_PARA_SOLTAR)
    return `viene ${Math.round(d.tasaInbox * 100)}% de bandeja sobre ${d.muestra} mediciones. No está para volver todavía.`;
  return null;
}

/**
 * Una señal de reputación. TRES estados, y "no-se" es uno de ellos.
 *
 * No hay un cuarto estado implícito donde un chequeo que no se pudo hacer se lea como uno que pasó:
 * el 2026-07-29 un probe colgado reportó 10 de 10 nodos bloqueados estando bien, y el 2026-07-25 un
 * "0 blacklist" convivió con 38 nodos cerrados en Gmail. Ausencia de dato no es evidencia de nada.
 */
export interface ChequeoReputacion {
  estado: "ok" | "mal" | "no-se";
  detalle: string;
}

/** Lo que devuelve la mano de reputación. La produce `reputacion.ts`; acá solo se declara. */
export interface ReputacionLeida {
  dominio: string;
  /** `null` = el dominio no tiene nodo asignado. Sin IP no hay listas negras ni PTR que mirar. */
  ip: string | null;
  blacklist: ChequeoReputacion;
  spf: ChequeoReputacion;
  dkim: ChequeoReputacion;
  dmarc: ChequeoReputacion;
  ptr: ChequeoReputacion;
  /**
   * El certificado TLS del propio nodo, por el 587. No lo mira NADIE y ya pasó una vez:
   * filing-ops.com quedó sin cert y los receptores que exigen STARTTLS le cerraron la puerta sin
   * que ninguna de las otras cuatro señales se moviera un milímetro.
   *
   * No cuesta cuota (es node:tls contra nuestro propio nodo, sin terceros), así que no compite con
   * las listas negras por el presupuesto de MXToolbox.
   */
  tls: ChequeoReputacion;
}

/** Lo que el agente pidió hacer. Sale del modelo, así que se trata como entrada no confiable. */
export interface AccionPedida {
  accion: string;
  dominio?: string;
  motivo?: string;
  id?: string;
  /**
   * LA VENTANA DE `que_paso`, en YYYY-MM-DD. Las escribe el modelo, así que se validan como todo
   * lo demás: formato exacto, fecha de calendario real y `desde <= hasta`. Ausentes = los últimos
   * VENTANA_POR_DEFECTO_DIAS días.
   */
  desde?: string;
  hasta?: string;
}

export interface ResultadoAccion {
  accion: string;
  /**
   * SOBRE QUÉ se decidió: dominio, id de pendiente, o null si es global (pausar_warmup).
   * Sin este campo la bitácora no tiene sujeto y colapsa "frenar A" con "frenar B" en la misma
   * entrada: `veces` sube por acciones distintas y el veredicto se le aplica al dominio
   * equivocado. Una memoria sin sujeto es peor que no tener memoria.
   */
  objetivo?: string | null;
  ejecutada: boolean;
  /**
   * ¿Falló por algo que se arregla SOLO en la próxima vuelta?
   *
   * Distingue las dos formas de no ejecutar, que se venían tratando igual y no son lo mismo:
   *
   *  · POLÍTICA — "no está entre los dominios que puedo mirar", "no está habilitado", "el receptor lo tiene
   *    cerrado". Requiere que alguien decida o configure algo. Vale interrumpir a un humano.
   *  · TRANSITORIO — un SSH que se cayó, Postgres reiniciándose, un timeout. Nadie tiene que
   *    hacer nada: en diez minutos se reintenta y sale.
   *
   * El 2026-08-06, mientras el operador corría el instalador, Postgres se recargó por doce
   * segundos y el agente le mandó dos "@Juanes Quise medir_dominio X y no pude: ECONNREFUSED
   * 127.0.0.1:5432. ¿Lo resolvés vos?" — con mención, o sea sonándole el móvil. No había nada que
   * resolver: para cuando leyó el mensaje ya estaba arreglado.
   *
   * Un agente que pide ayuda ante cada parpadeo de infraestructura no es cuidadoso: es ruido con
   * forma de urgencia, y gasta la única señal que sirve para lo que sí importa.
   */
  reintentable?: boolean;
  /** Qué pasó, en castellano. Va al registro y a la pantalla. */
  detalle: string;
  antes?: unknown;
  despues?: unknown;
}

/** Un pendiente que el agente no puede resolver solo. */
export interface Pendiente {
  id: string;
  que: string;
  porque: string;
  abiertoEn: string;
  /** Cuántas veces el agente lo volvió a detectar. No genera un pendiente nuevo: suma acá. */
  visto: number;
  resueltoEn?: string;
}

/**
 * El contexto que las acciones necesitan. Se inyecta ⇒ se testea sin tocar nada real, y el daemon
 * o la ruta deciden qué capacidades le dan al agente en cada entorno.
 */
export interface ContextoAcciones {
  /** Dominios que existen de verdad. Una acción sobre algo fuera de esta lista se rechaza. */
  dominiosConocidos: readonly string[];
  /**
   * El ALCANCE del freno: los únicos dominios donde el agente puede poner cap 0 por sí solo.
   * Son los que ya tienen daño consumado (cruzaron el umbral permanente) o a los que el receptor
   * ya les cerró la puerta. Ahí frenar solo puede ayudar.
   *
   * `undefined` = sin restricción (compatibilidad con los tests y con el modo dry-run). Ponerlo
   * en producción es lo que convierte "puede frenar cualquiera de los 58" en "puede frenar donde
   * ya no hay nada que perder".
   */
  frenablesConDanio?: readonly string[] | null;
  /**
   * ¿Esta acción la ORDENÓ el jefe explícitamente por chat, o la decidió el modelo solo?
   *
   * Cambia UNA sola cosa: el alcance del freno. Ese alcance existe porque el MODELO no debería
   * decidir frenar un dominio sano — pero si Juanes lo ordena, es su fábrica y su decisión, y
   * negarse sería tratarlo como si fuera el modelo.
   *
   * Lo que NO cambia nunca, lo ordene quien lo ordene: el dominio tiene que existir en los datos,
   * el motivo es obligatorio, la idempotencia se respeta, y NINGUNA acción puede aumentar el
   * volumen de envío. Eso último es irreversible y no hay autoridad que lo destrabe.
   */
  ordenadoPorElJefe?: boolean;
  /**
   * IR A MIRAR el cupo de un nodo AHORA, por SSH, en vez de creerle a un archivo.
   *
   * Es la mano que más le faltaba y no muta nada. Sin ella el agente afirmaba "bizreport-control.com
   * sigue con cupo 255" leyendo un sender-cap.json de horas, cuando el nodo real ya estaba en 0
   * porque él mismo lo había frenado. No es que mintiera: es que no tenía forma de ir a ver.
   *
   * Solo LEE. No persiste el resultado en sender-cap.json a propósito: escribir la lectura de UN
   * nodo estampa una fecha fresca sobre los 57 caps viejos y el sistema deja de saber que su
   * medición está vencida.
   */
  leerCupoNodo?: (dominio: string) => Promise<{ cap: number | null; consumidoHoy: number | null; motivo?: string | null }>;
  /**
   * DIAGNOSTICAR un dominio: leer el mail.log de su nodo y ver QUIÉN lo está rechazando y por qué.
   *
   * Es la respuesta a "por qué este dominio no entrega", que hoy el agente no podía contestar: veía
   * un estado (`blocked_by_provider`) sin saber quién ni con qué motivo. Y es la lección más cara
   * del proyecto: el 2026-07-25 se descubrió que 38 de 64 nodos estaban cerrados en Gmail mientras
   * el chequeo de listas negras decía "0 blacklist". La evidencia llevaba SEMANAS en los logs de
   * cada máquina y nadie la leía.
   *
   * PASIVO: lee logs, no manda un solo correo. Por eso no lleva flag.
   */
  diagnosticarDominio?: (dominio: string) => Promise<DiagnosticoDelNodo>;
  /**
   * MEDIR un dominio: dónde viene cayendo su correo y en qué día de rampa está.
   *
   * Los hechos ya traen el placement de cada dominio… pero solo de los que están EN EL POOL. Un
   * dominio frenado o excluido no aparece — y son exactamente los que hay que evaluar para volver
   * a soltarlos. El agente quedaba opinando a ciegas sobre los únicos casos que importaban.
   *
   * PASIVO: lee la base, no manda un solo correo. Por eso no lleva flag.
   */
  medirDominio?: (dominio: string) => Promise<{
    tasaInbox: number | null;
    muestra: number;
    diaN: number | null;
    ultimaMedicion: string | null;
  }>;
  /**
   * QUÉ PASÓ CON ESTE DOMINIO ENTRE DOS FECHAS. La única mano de MEMORIA del agente.
   *
   * El encargo del jefe fue "que no dependa de mí", y el censo dijo dónde estaba la dependencia:
   * de 231 episodios con hueco, 3 eran decisiones humanas de verdad. El resto era deuda nuestra, y
   * el 73% de esa deuda son dos cosas que NO se arreglan con una mano nueva sino con que lo ya
   * medido VUELVA. Ésta es la parte que sí necesitaba una mano: preguntar.
   *
   * Hoy `medir_dominio` devuelve un AGREGADO sin fechas —"50% sobre 4 mediciones, día 3 de
   * rampa"— sobre una ventana fija de 10 días que el agente no elige. Con eso, "¿qué pasó con X la
   * semana pasada?" no tiene NINGÚN camino: ni para el jefe cuando pregunta por chat, ni para el
   * propio agente cuando quiere saber si su freno de anteayer sirvió. `filasDePlacement` ya trae
   * la fecha y la semilla de cada muestra, y las tira.
   *
   * DEVUELVE TEXTO YA RENDERIZADO, no filas. El productor (el orquestador) lee el corpus de hechos
   * y consulta warmup_activity, y le pasa las filas a `buscar` de historia.ts, que es quien sabe
   * decir "no hay registro" sin inventar un 0% y quien declara desde cuándo hay corpus. Acá no se
   * arma ningún porcentaje: este case RELAYA. Es a propósito — el agujero real del 21/07 al 02/08
   * es una ventana VACÍA, y una ventana vacía resumida por dos lados distintos termina diciendo
   * dos cosas distintas sobre el mismo dominio.
   *
   * PASIVO: lee la base y un JSON. No manda correo, no toca un cap. Por eso no lleva flag.
   */
  quePaso?: (dominio: string, desde: string, hasta: string) => Promise<string>;
  /**
   * REVISAR LA REPUTACIÓN: listas negras de su IP y su autenticación (SPF, DKIM, DMARC, PTR).
   *
   * Es lo que el operador pidió textual el 2026-08-06 y el agente no tenía de ninguna forma: sus
   * hechos no traen una sola clave de blacklist ni de auth, y el escaneo diario de MXToolbox nunca
   * corrió aunque la llave está paga. El instrumento estaba comprado y apagado.
   *
   * PASIVO: consulta DNS y una API de solo lectura. No manda correo ni cambia nada.
   *
   * OJO con lo que NO es: un semáforo. El resultado nunca sale solo — el case lo publica junto con
   * el estado del receptor, porque una lista negra limpia no significa que estés entregando.
   *
   * PRESUPUESTO DE CUOTA, porque la API se paga y hay 58 nodos: UNA consulta de MXToolbox por
   * invocación (solo listas negras; SPF/DKIM/DMARC/PTR salen de node:dns y cuestan cero). Con
   * MAX_ACCIONES_POR_VUELTA=3 y un tick cada 10 minutos, el techo del carril de guardia es 3×144 =
   * 432 consultas/día, y en la práctica muchísimo menos porque el agente no pide tres reputaciones
   * por vuelta. El llamador comparte UNA instancia del adapter para que su caché
   * (MXTOOLBOX_CACHE_TTL_MS) evite pagar dos veces la misma IP en la misma ventana.
   */
  revisarReputacion?: (dominio: string) => Promise<ReputacionLeida>;
  /** Pone cap 0 en el nodo del dominio. Reversible con un `--apply` normal. */
  frenarDominio?: (dominio: string, motivo: string) => Promise<{ antes: number | null; despues: number }>;
  /**
   * BAJA el cap del nodo a un valor seguro, sin apagarlo. La mano del medio que faltaba: sin ella,
   * ante un nodo cableado muy por encima del techo el agente solo podía matarlo o avisar.
   */
  bajarCapNodo?: (dominio: string, cap: number, motivo: string) => Promise<{ antes: number | null; despues: number }>;
  /**
   * SOLTAR un dominio frenado: instala un cupo chico para que vuelva a calentar.
   *
   * Es la única acción del agente que AUMENTA volumen, y por eso es la que más cuidado lleva. La
   * asimetría que arregla es real: hasta hoy solo sabía reducir — frenar, pausar, anotar — y cada
   * dominio listo para arrancar tenía que esperar a que un humano lo soltara a mano.
   *
   * Lo que la vuelve segura NO es que el modelo decida bien. Es que el modelo no decide casi nada:
   *
   *  · el CUPO no lo elige él. Es la constante `CAP_AL_SOLTAR`, la misma que usa el operador a
   *    mano como `--cap-excepto`: alcanza para las 3 vueltas diarias del calentamiento y mata
   *    cualquier volumen de producción. El modelo no puede pedir "soltalo en 5000".
   *  · las CONDICIONES se verifican en código contra la infraestructura viva, no contra lo que él
   *    cree: el nodo tiene que estar realmente en cap 0, ningún receptor puede tenerle la puerta
   *    cerrada, si ya tiene mediciones no pueden ser malas, y su IP tiene que estar MEDIDA y limpia
   *    en listas negras (ver el tramo (4): "no sé" rechaza igual que "listada").
   *
   * O sea: él elige el CANDIDATO, el código dice si califica, y el cupo es fijo. El peor caso de
   * que se equivoque es un dominio calentando 20 correos al día de más.
   */
  soltarDominio?: (dominio: string, cap: number, motivo: string) => Promise<{ antes: number | null; despues: number }>;
  /** Crea el kill-file: el daemon deja de mandar en la próxima vuelta. Reversible con `rm`. */
  pausarWarmup?: (motivo: string) => Promise<void>;
  /** ¿Ya está pausado? Para no reportar como acción algo que ya estaba hecho. */
  warmupPausado?: () => Promise<boolean>;
  pendientes: {
    listar: () => Promise<Pendiente[]>;
    guardar: (p: Pendiente[]) => Promise<void>;
  };
  /**
   * LOS NÚMEROS DE UNA PROPUESTA DE SUBIDA, ya evaluados por el motor. `null` = ese dominio no
   * tiene plan hoy, y entonces no hay nada que proponer.
   *
   * El modelo NO elige ninguno de estos valores, igual que no elige `CAP_AL_SOLTAR`: los produce el
   * plan determinista del motor y acá solo se copian a la nota. Es lo que separa "el agente
   * argumenta que un dominio se ganó un escalón" de "el agente pide 200/día".
   */
  datosParaProponer?: (dominio: string) => Promise<DatosParaProponer | null>;
  /**
   * ¿Esta acción ya devolvió lo mismo las últimas dos veces? Devuelve cuántas veces se pidió.
   *
   * Se inyecta en vez de leerse acá adentro porque la bitácora vive en disco y este módulo no toca
   * disco. El llamador la arma con `daLoMismo` de bitacora-acciones.ts.
   */
  yaDaLoMismo?: (accion: string, objetivo: string | null) => number | null;
  ahora?: () => Date;
}

/**
 * La evidencia de una propuesta de subida, tal como la deja el motor. Todo opcional en su contenido
 * (un `null` es "no medido") menos el veredicto del gate, que es la puerta.
 */
export interface DatosParaProponer {
  cupoActual: number;
  /** El escalón siguiente según la rampa del motor. NO lo elige el modelo ni este módulo. */
  cupoPropuesto: number;
  /**
   * El placement CON su proveedor. Sin proveedor un porcentaje no se puede comparar contra su
   * umbral —Gmail y Outlook no piden lo mismo— y una cifra sin proveedor es un promedio de cosas
   * distintas. `proveedor: null` = no se sabe con qué se midió, y eso vale como "no sé".
   */
  placement: { proveedor: string | null; tasa: number | null; muestra: number };
  /**
   * El veredicto DETERMINISTA del motor: ¿este dominio pasa el gate de la receta? `pasa:false` trae
   * cuál condición falló. Lo produce el motor, no el modelo y no este módulo.
   */
  gate: { pasa: boolean; falla: string | null };
  /** Cuánto manda hoy ese dominio por día, para poder medir la distancia a los dos techos. */
  enviadosHoy: number;
}

/**
 * LA IDENTIDAD DE UNA PROPUESTA ES EL DOMINIO, NO SU REDACCIÓN — y hasta hoy el código decía eso en
 * un comentario mientras hacía lo contrario: el dedupe buscaba `startsWith(marcaDePropuesta(d))`, o
 * sea el PREÁMBULO ENTERO. Cambiar una palabra del preámbulo —y en este mismo lote hubo que cambiar
 * dos, porque estaba en voseo— dejaba huérfanas las propuestas ya abiertas: el `find` no las
 * encontraba y el operador recibía una propuesta duplicada por dominio. Se separa lo que identifica
 * de lo que se lee, así la próxima corrección de estilo no cuesta un pendiente doble.
 */
const identidadDePropuesta = (dominio: string): string => `subir ${dominio} de `;

/** El preámbulo, que es SOLO redacción: dice qué es y quién la aprueba. Ver `textoDeLaPropuesta`. */
const marcaDePropuesta = (dominio: string): string =>
  `PROPUESTA (esta la apruebas tú, yo no puedo subir un cupo): ${identidadDePropuesta(dominio)}`;

/**
 * El texto de la propuesta. PURO y exportado: es lo único de este camino que el jefe va a leer, y
 * tiene que poder fijarse con un test sin montar nada.
 *
 * SE LEE COMO PROPUESTA Y DICE QUIÉN LA APRUEBA. No es cosmética: una propuesta redactada como
 * anuncio ("le subo el cupo a 40") es el camino más corto a que alguien la ejecute a mano creyendo
 * que ya estaba decidido, y subir volumen es lo único irreversible de este sistema.
 */
export function textoDeLaPropuesta(dominio: string, d: DatosParaProponer): string {
  const placement =
    d.placement.tasa === null || d.placement.muestra === 0
      ? "placement sin medir"
      : `placement ${d.placement.proveedor ?? "de proveedor no identificado"} ${Math.round(d.placement.tasa * 100)}% sobre ${d.placement.muestra} mediciones`;
  // El prefijo sale de `marcaDePropuesta` y no de un literal repetido: es la IDENTIDAD con la que
  // después se deduplica, y dos copias del mismo texto se desincronizan sin que nadie lo note —
  // ahí el dedupe deja de encontrar la propuesta anterior y el operador recibe una nueva cada vuelta.
  return (
    `${marcaDePropuesta(dominio)}${d.cupoActual} a ${d.cupoPropuesto}/día. ` +
    `${placement}, pasa el gate del motor. Hoy lleva ${d.enviadosHoy} enviados; con ${d.cupoPropuesto}/día quedan ` +
    `${TECHO_DIARIO_RECOMENDADO - d.cupoPropuesto} de margen hasta el techo de ${TECHO_DIARIO_RECOMENDADO}/día y ` +
    `${UMBRAL_PERMANENTE_GMAIL - d.cupoPropuesto} hasta el umbral permanente de Gmail (${UMBRAL_PERMANENTE_GMAIL}/día, se cruza una sola vez y no se deshace).`
  );
}


/** Palabras que no distinguen un pendiente de otro. */
const VACIAS = new Set(["y", "o", "de", "del", "la", "el", "los", "las", "en", "para", "un", "una", "semilla", "semillas"]);

/** Quita acentos, puntuación y palabras vacías; deja el conjunto de términos que sí distinguen. */
function terminos(texto: string): Set<string> {
  return new Set(
    texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9.]+/)
      .filter((t) => t.length > 1 && !VACIAS.has(t))
  );
}

/**
 * ¿Son el mismo pendiente aunque estén escritos distinto?
 *
 * Comparar texto exacto no alcanza, y se vio en producción a los diez minutos: el agente anotó
 * "outlook y yahoo", "semillas para outlook y yahoo" y "outlook,yahoo" como TRES pendientes. Es la
 * misma cosa dicha de tres formas — el modelo reformula, es lo que hacen los modelos. Con dedup
 * exacto, la promesa de "anotalo una sola vez" se rompe el primer día.
 *
 * Se comparan los términos que distinguen (sin acentos, sin puntuación, sin palabras vacías): si
 * uno está contenido en el otro, o comparten la mayoría, es el mismo pendiente.
 */
export function mismoPendiente(a: string, b: string): boolean {
  const A = terminos(a);
  const B = terminos(b);
  if (A.size === 0 || B.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const comunes = [...A].filter((t) => B.has(t)).length;
  // Contenido, pero NO trivial. Con `min(A,B) === 1` bastaba UN término compartido para fundir
  // pendientes distintos: "semilla de yahoo" y "cupo de yahoo" comparten {yahoo} y se hubieran
  // tomado por el mismo. Con dos términos mínimos, el contenido es señal; con uno, se pasa a
  // Jaccard, que exige mayoría.
  if (Math.min(A.size, B.size) >= 2 && comunes === Math.min(A.size, B.size)) return true;
  // O mayoría compartida, para reformulaciones que agregan y quitan a la vez.
  return comunes / new Set([...A, ...B]).size >= 0.5;
}

/** Máximo de acciones por lectura. Un agente que hace veinte cosas de golpe no se puede auditar. */
export const MAX_ACCIONES_POR_VUELTA = 3;

// ── LA FRASE LA ESCRIBE EL CÓDIGO, NO EL MODELO ─────────────────────────────────────────────────
//
// EL INCIDENTE DEL 2026-08-07, con la plata a punto de salir. La mano OBEDECIÓ la regla de las dos
// señales: emitió las dos juntas, en una sola frase, textual del log de producción (línea 3308):
//
//   "bizreport-control.com (86.48.29.176): listas negras sin detecciones · auth SPF ok, DKIM ok,
//    DMARC ok, PTR ok, TLS no sé · receptor: CERRADO en gmail.com, hotmail.com, outlook.com"
//
// Y el modelo, redactando para Slack, publicó: "la infraestructura no se pierde […] salieron con IP
// limpia y autenticación ok — esos nodos sirven para montarles dominio nuevo". Se comió la cláusula
// del receptor. El jefe preguntó "¿sería comprar 2 dominios nuevos y configurarlos a esos smtps?" y
// el agente dijo "Exacto, eso mismo": USD 30 sobre dos IP que gmail/hotmail/outlook rechazan HOY
// (337 rechazos sobre 337 intentos).
//
// El gate viejo protegía la SALIDA DE LA HERRAMIENTA y ahí terminaba. Después el modelo escribe
// prosa libre y la cláusula cara se evapora. Y la solución NO es agregar una línea al prompt: este
// proyecto ya pagó dos veces que un criterio en prosa el modelo lo devuelve como hallazgo propio.
// Un prompt que pide honestidad es lo que ya falló.
//
// LO QUE CAMBIA ACÁ, y es de orden de ejecución y no de disciplina: esta frase se arma DESPUÉS de
// que el modelo devolvió su texto (responder → extraerAcciones → ejecutarAcciones), así que el
// modelo nunca la ve, no la puede resumir, no la puede reordenar y no la puede parafrasear. No es
// una regla que pueda desobedecer.
//
// Y EL SEGUNDO CANDADO ES DEL COMPILADOR: `diag` es POSICIONAL Y OBLIGATORIO y `auth` es opcional,
// así que la primera señal sola NO SE PUEDE CONSTRUIR — no hay función exportada que devuelva
// "listas limpias · auth ok". La regla de las dos señales deja de ser un comentario arriba de un
// template literal (que la próxima edición parte) y pasa a ser una lista de parámetros.

/**
 * ¿A QUIÉN castiga el receptor cuando rechaza? Es el dato que separa "comprá un dominio nuevo" de
 * "no gastes un peso", y hoy no existe en ninguna parte del sistema: hubo que entrar por SSH al
 * nodo para contestarlo. Medido el 2026-08-07 en los dos nodos del incidente:
 *
 *   · Gmail culpa al DOMINIO — "very low reputation of the sending domain", 334 y 10.686 veces.
 *   · Microsoft culpa a la RED/IP — "part of their network is on our block list (S3150)", 171+817.
 *   · Apple culpa a la IP — "[HCM2] Your mail from 80.190.75.57 was rejected", 503 veces.
 *
 * Un dominio nuevo no cambia la IP: sobre 86.48.29.176 nacería ya bloqueado en hotmail/outlook.
 *
 * Lo puebla el LOTE 1 (la culpa leída del `said:` del mail.log). Mientras no esté, llega ausente y
 * la frase dice la duda honesta — ausencia de dato NO es evidencia, y una duda frena una compra
 * mejor que una certeza a medias.
 */
export type CulpaDelRechazo = "ip" | "dominio" | "buzon" | "no-se";

/** Lo que devuelve el diagnóstico de un nodo. Se declara acá; lo produce el orquestador. */
export interface DiagnosticoDelNodo {
  estado: string;
  bloqueanPor: readonly string[];
  degradadoEn: readonly string[];
  entregados: number;
  rechazados: number;
  detalle: string;
  /** Por receptor: a quién le pega el rechazo. Ausente = todavía no se mide (lote 1). */
  culpaPorProveedor?: Readonly<Record<string, CulpaDelRechazo>>;
}

/**
 * "a, b y c". Existe para que la frase no salga con comas de máquina hasta el final — es la
 * diferencia entre un renglón de log y algo que una persona escribiría en un chat.
 */
export function enumerar(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`;
}

/**
 * CÓMO ESTÁ ESTE NODO, en una frase que el modelo no escribió.
 *
 * Calcada de `fraseHumana` (slack.ts): la misma verdad, dicha como la diría una persona. Es lo
 * único que la guardia tenía y el chat no.
 *
 * TRES TRAMOS Y EN ESTE ORDEN, y el orden es el arreglo:
 *
 *  (a) LA PUERTA primero, con los números SIEMPRE. La frase vieja arrancaba con la buena noticia
 *      ("listas negras sin detecciones · auth SPF ok…") y dejaba la cláusula cara al final, después
 *      de un paréntesis sobre el TLS que no aporta nada. El modelo resumió la CABEZA de la frase,
 *      que es lo que hacen los modelos con las frases largas. Una sola frase con la mala noticia al
 *      final es media frase. Y los números iban solo en la rama optimista, o sea donde menos
 *      importan.
 *  (b) EL NODO AL LADO, NO EN VEZ DE. El ternario viejo usaba `estado` únicamente en las ramas
 *      `else`: con bloqueadores, el estado se descartaba. Así se perdió que corpannualops.com
 *      estaba `stalled` con 14.577 mensajes trabados en la cola — el hecho que por sí solo mata la
 *      compra (ese SMTP no vacía su cola, con dominio viejo o nuevo). El modelo no lo omitió: no lo
 *      tuvo. Esa fuga estaba ADENTRO del gate de las dos señales.
 *  (c) LA LIMPIEZA ATADA CON "PERO". El adversativo cierra sobre el lado caro y bloquea la
 *      re-atribución nodo→dominio, que fue el paso concreto que produjo la recomendación de
 *      comprar: el modelo leyó "CERRADO en gmail, hotmail, outlook" y escribió "el que está quemado
 *      es solo el dominio con Gmail, Hotmail y Outlook" — le cambió el dueño al rechazo.
 *
 * PURA: sin red, sin disco, sin reloj. Se prueba con el fixture del incidente y nada más.
 */
export function comoEstaEsteNodo(
  dominio: string,
  ip: string | null,
  diag: DiagnosticoDelNodo,
  auth?: ReputacionLeida
): string {
  const partes: string[] = [];
  const culpa = diag.culpaPorProveedor ?? {};
  const cabeza = ip ? `${dominio} (${ip})` : dominio;
  // EL NÚMERO QUE SÍ LLEGÓ, cuando el de arriba no llegó. `assessDeliveryHealth` cierra el veredicto
  // sano con "386 entregados, 0 rechazados" (smtp-delivery-health.ts:803), o sea que la cuenta viaja
  // DOS veces y una de las dos sobrevive al `?? 0` del orquestador. Sin esto, los 6 nodos sanos de la
  // flota del 2026-08-07 publicaban "no pude leer cuántos mensajes movió" y dos palabras después
  // "386 entregados, 0 rechazados": la misma oración negando y afirmando la misma lectura. Una
  // ceguera falsa cuesta confianza justo en los nodos donde no hay nada malo que contar.
  const delDetalle = /(\d+) entregados, (\d+) rechazados/.exec(diag.detalle ?? "");
  const entregados = diag.entregados || Number(delDetalle?.[1] ?? 0);
  const rechazados = diag.rechazados || Number(delDetalle?.[2] ?? 0);
  const cuenta = `${entregados} entregados y ${rechazados} rechazados`;
  // ¿LOS CONTADORES SE LEYERON, O SON EL `?? 0` DE UN CAMPO QUE NO EXISTE?
  //
  // El 2026-08-07 el orquestador leía `v.stats?.total?.delivered ?? 0` y el sensor emite
  // `stats.totals` (smtp-delivery-health.ts:26). No hay `stats.total`, así que el `?? 0` ganaba
  // SIEMPRE: en el log de producción TODAS las líneas `✓ HIZO:` decían "0 entregados / 0
  // rechazados", incluida "filing-ops.com: healthy, 0 entregados / 0 rechazados. 386 entregados, 0
  // rechazados" — el mismo renglón se contradice a sí mismo — y "corpfiling-outbound.com:
  // blocked_by_provider, 0 entregados / 0 rechazados … (gmail.com: 7389 rechazos sobre 7425
  // intentos)". El arreglo de raíz son dos letras y vive en scripts/ops/warmup-monitor.ts.
  //
  // ESTO ES LA OTRA MITAD, y no sobra aunque aquel se arregle: `blocked_by_provider` EXIGE
  // BLOCKED_MIN_ATTEMPTS intentos y `stalled` exige STALLED_MIN_ATTEMPTS diferidos, así que un
  // estado que exige tráfico con la cuenta en cero es un dato que NO LLEGÓ. Publicarlo igual es
  // ausencia de dato vendida como dato, en la función escrita para no confundirlos. Un nodo con
  // 386 entregas descrito como virgen es peor que no decir nada: virgen es justo el estado que
  // `elegirPool` y `soltar_dominio` tratan como candidato natural.
  const hayCuenta = entregados + rechazados > 0;
  // UN LOG QUE NO SE PUDO LEER NO ES UN LOG LIMPIO. `readNodeDeliveryHealth` devuelve `unreadable`
  // con los contadores en cero cuando el SSH falló, faltó el sudo o las fechas no se entienden.
  // `revisar_reputacion` ya lo rechaza antes de llegar acá; `diagnosticar_dominio` no, y por ese
  // camino un nodo ilegible se publicaba como "nadie le cerró la puerta, pero tampoco mandó nada".
  const ilegible = diag.estado === "unreadable" || diag.estado === "desconocido";

  // ── EL NODO TRABADO, Y SUS DOS MAGNITUDES QUE NO SON LA MISMA ────────────────────────────────
  //
  // `assessDeliveryHealth` llega a `stalled` por dos ramas DISTINTAS a propósito, y cada una cuenta
  // otra cosa:
  //
  //  · postqueue (smtp-delivery-health.ts:758): "14573 mensajes en la cola AHORA". Es la cola
  //    física, instantánea. Documentado textual en el sensor: "Mensajes en la cola de Postfix AHORA,
  //    no en la ventana" (:226).
  //  · ratio (smtp-delivery-health.ts:789): "175250 diferidos de 228401 (77%)". Son LÍNEAS de
  //    diferido en la ventana de 5 días, y Postfix escribe una por reintento — un mismo mensaje
  //    aparece muchas veces.
  //
  // Un regex que aceptaba las dos y las metía en la misma plantilla publicaba "175250 mensajes
  // atascados en la cola" sobre nodos cuya cola el MISMO barrido leyó en 0 (bizreport-control.com:
  // encolados=0, diferidos=233) o 4,4× más chica (infranationalreport: 1825 en cola vs 8022
  // diferidos). Y encima la rama del ratio SOLO se alcanza cuando `encolados` es null o menor al
  // mínimo, o sea justo cuando la cola NO está llena. Es un número real pegado al sustantivo
  // equivocado, en la frase que decide una compra: exactamente la clase de error que esta función
  // existe para no cometer.
  //
  // Y EL DENOMINADOR NO SE TIRA. "82%" es lo único que hace interpretable el numerador; sin él,
  // 123.621 puede ser catastrófico o irrelevante y nadie lo sabe.
  const enCola = /(\d[\d.,]*)\s*mensajes?\s+en\s+la\s+cola/i.exec(diag.detalle ?? "")?.[1];
  const difer = /(\d[\d.,]*)\s+diferidos\s+de\s+(\d[\d.,]*)\s*\((\d+)\s*%\)/i.exec(diag.detalle ?? "");
  const trabado =
    diag.estado !== "stalled" || ilegible
      ? null
      : enCola
        ? `el nodo está trabado, con ${enCola} mensajes atascados en la cola ahora mismo: de ahí no está saliendo correo, ni con este dominio ni con uno nuevo`
        : difer
          ? `el nodo está trabado: de cada 100 mensajes que salieron, ${difer[3]} se quedaron dando vueltas sin llegar (${difer[1]} de ${difer[2]} en la ventana), así que de ahí no está saliendo correo, ni con este dominio ni con uno nuevo`
          : // Si no viene el número, se dice que no viene — no se inventa un cero.
            "el nodo está trabado: la cola no se está vaciando, así que de ahí no está saliendo correo";

  // ── (a) LA PUERTA ─────────────────────────────────────────────────────────────────────────────
  //
  // CERRADO Y DEGRADADO SON DOS COSAS Y SE DICEN LAS DOS. El ternario viejo era un `else if`, así
  // que un dominio cerrado en Gmail Y degradado en Yahoo publicaba solo lo primero: el que rechaza
  // a medias desaparecía justo cuando ya había otro rechazando del todo, o sea cuando peor está.
  const rechazan = (xs: readonly string[]): string => (xs.length === 1 ? "le rechaza" : "le rechazan");
  if (diag.bloqueanPor.length > 0 || diag.degradadoEn.length > 0) {
    const puerta: string[] = [];
    if (diag.bloqueanPor.length > 0) {
      puerta.push(`${enumerar([...diag.bloqueanPor])} ${rechazan(diag.bloqueanPor)} el correo hoy${hayCuenta ? ` (${cuenta})` : ""}`);
    }
    if (diag.degradadoEn.length > 0) {
      puerta.push(`${enumerar([...diag.degradadoEn])} ${rechazan(diag.degradadoEn)} parte del correo`);
    }
    partes.push(`${cabeza}: ${puerta.join(", y ")}`);
    partes.push(deQuienEsElCastigo([...diag.bloqueanPor, ...diag.degradadoEn], culpa));
  } else if (hayCuenta) {
    partes.push(`${cabeza}: hoy nadie le está cerrando la puerta (${cuenta})`);
  } else if (diag.estado === "no_traffic") {
    // CERO ENTREGAS + CERO RECHAZOS NO ES "nadie se lo bloquea": es que nadie lo probó. Es el
    // estado de los nodos vírgenes, que son justamente el caso de uso de soltar_dominio — o sea que
    // la frase optimista salía sobre los dominios donde más caro se paga creerla.
    //
    // Y AHORA LO EXIGE EL ESTADO, no la aritmética. El `entregados + rechazados === 0` de antes era
    // inalcanzable-por-la-verdad y alcanzable-por-el-bug: con el `?? 0` del orquestador, TODO nodo
    // sin bloqueadores —los 6 `healthy` del 2026-08-07 incluidos— caía acá.
    partes.push(`${cabeza}: nadie le cerró la puerta, pero tampoco mandó nada en la ventana (0 entregados y 0 rechazados), así que no sabemos si lo aceptan`);
  } else if (ilegible) {
    partes.push(`${cabeza}: no pude leer el registro de correo de este nodo, así que de lo que entrega no sé nada`);
  } else if (trabado) {
    // UN NODO TRABADO NO ENCABEZA CON "no pude leer". Sí pude: el sensor contó los diferidos y ese
    // conteo ES la lectura. La frase vieja abría negando haber leído y dos palabras después
    // publicaba "17888 mensajes atascados" — la misma oración contradiciéndose, sobre el hecho que
    // por sí solo mata una compra. Acá el trabado va de cabeza y `y encima` se lo salta.
    partes.push(`${cabeza}: ${trabado}`);
  } else {
    // NI CERRADO, NI CON CUENTA, NI DECLARADO SIN TRÁFICO: entonces la cuenta no se leyó. Se dice
    // así y no se afirma un cero que nadie midió.
    // El "así que que" era un tropiezo de lectura en la primera línea de un mensaje al jefe: dos
    // puntos y la frase se lee sola.
    partes.push(`${cabeza}: no pude leer cuántos mensajes movió: que no aparezcan rechazos no dice que lo acepten`);
  }

  // ── (b) EL NODO ───────────────────────────────────────────────────────────────────────────────
  if (ilegible) {
    // Ya se dijo arriba, salvo que la cabeza se la haya llevado un bloqueador (hoy imposible: el
    // veredicto `unreadable` sale con `blockedProviders: []`, pero eso es una propiedad del sensor y
    // no un invariante de esta función). Y el `detail` de un ilegible NO se publica: es diagnóstico
    // de desarrollador —"salida incompleta (falta ## END o alguna sección ## OWN_*)", con `##`, `_`
    // y rutas de sistema adentro— y va crudo al chat del jefe por un `else if` que nadie ejercía en
    // los tests porque los tres fixtures traían `detalle: ""`.
    if (puertaCerrada(diag)) partes.push("y encima no pude leer su registro de correo, así que de lo que entrega no sé nada");
  } else {
    // EL TRABADO AL LADO DE LA PUERTA CERRADA, salvo que ya haya encabezado la frase (ver arriba).
    // Las dos formas del sensor y su redacción propia se arman una sola vez, antes de (a), porque
    // este mismo hecho puede ir de cabeza o de acompañante.
    if (trabado && !partes[0]!.includes(trabado)) partes.push(`y encima ${trabado}`);
    // LO QUE DIJO EL RECEPTOR, con sus palabras, y en un `if` INDEPENDIENTE. Era el `else` del
    // `stalled`, así que un nodo trabado cuyo detalle no matcheara el regex perdía la evidencia
    // ENTERA: no se degradaba, desaparecía. Ahora solo se calla cuando ya se dijo el mismo número.
    //
    // Es evidencia, no adorno: "550-5.7.1 … very low reputation of the sending domain" (Gmail,
    // culpa al dominio) y "part of their network is on our block list (S3150)" (Microsoft, culpa a
    // la IP) llevan a decisiones opuestas sobre la misma plata. Y con la cabeza ya sin el contador
    // fabricado, el `(gmail.com: 337 rechazos sobre 337 intentos)` de este detalle es el ÚNICO
    // número verdadero que le queda a la frase.
    //
    // Y SIN REPETIR LA LISTA. El detalle de `blocked_by_provider` empieza con "cerrado en gmail.com,
    // hotmail.com, outlook.com (…)", o sea los mismos receptores que la cabeza nombró quince
    // palabras antes. Con el contador fabricado adentro eso pasaba desapercibido; sin él queda a la
    // vista, y decir dos veces la misma lista en la misma frase es el "bot del 2000" que el jefe
    // pidió matar. Lo que se conserva es lo ÚNICO que la cabeza no tiene: el ratio real.
    //
    // Y EL DETALLE DEL SANO TAMPOCO SE REPITE. `assessDeliveryHealth` cierra con "386 entregados, 0
    // rechazados", que es la misma cuenta que la cabeza ya publicó entre paréntesis desde que
    // `delDetalle` la rescata. Sin este corte la frase decía el par de números dos veces.
    const suyo = diag.detalle?.trim().replace(/\.$/, "").replace(/^cerrado en [^()]*\(([^)]*)\)$/i, "$1");
    // `enCola || difer` Y NO `trabado`, y la diferencia es la evidencia entera de un nodo trabado.
    // `trabado` es truthy para CUALQUIER `stalled`, incluido el caso en que el sensor mandó un texto
    // cuya forma el regex no conoce ("la cola creció un 300% desde ayer"): ahí la línea del trabado
    // NO lleva ningún número, así que no repite nada, y sin embargo se tragaba el detalle del sensor
    // completo. Es exactamente el `else` que este bloque vino a matar, vuelto a entrar por el
    // booleano. Lo que se calla es el número ya dicho, no el hecho.
    const yaDicho = Boolean(enCola || difer) || (hayCuenta && suyo === `${entregados} entregados, ${rechazados} rechazados`);
    if (suyo && !yaDicho) partes.push(suyo);
  }

  // ── (c) LA LIMPIEZA, ATADA CON "PERO" ─────────────────────────────────────────────────────────
  if (auth) {
    const buenas: string[] = [];
    const malas: string[] = [];
    const dudosas: string[] = [];

    if (auth.blacklist.estado === "ok") buenas.push("su IP está limpia en listas negras");
    else if (auth.blacklist.estado === "mal") malas.push(`su IP está listada (${auth.blacklist.detalle})`);
    else dudosas.push("las listas negras");

    const ok: string[] = [];
    for (const [etiqueta, c] of [
      ["SPF", auth.spf],
      ["DKIM", auth.dkim],
      ["DMARC", auth.dmarc],
      ["PTR", auth.ptr],
      ["TLS", auth.tls]
    ] as const) {
      if (c.estado === "ok") ok.push(etiqueta);
      else if (c.estado === "mal") malas.push(`${etiqueta} está mal (${c.detalle})`);
      else dudosas.push(etiqueta);
    }
    if (ok.length > 0) buenas.push(`${enumerar(ok)} ${ok.length === 1 ? "está" : "están"} ok`);

    // El "pero" solo cuando HAY puerta cerrada: si el nodo entrega bien, atarle un adversativo sería
    // inventarle un problema. Con la puerta cerrada, en cambio, es la única forma de que la buena
    // noticia no se lea sola — que es exactamente lo que pasó el 2026-08-07.
    if (buenas.length > 0) {
      partes.push(puertaCerrada(diag) ? `${enumerar(buenas)}, pero eso no le abre la puerta` : enumerar(buenas));
    }
    if (malas.length > 0) partes.push(enumerar(malas));
    // Un chequeo que no se pudo hacer se DICE. No decirlo lo convierte en un "está bien" tácito, que
    // es la forma más barata de mentir con datos ciertos.
    if (dudosas.length > 0) partes.push(`de ${enumerar(dudosas)} no tengo cómo saber`);
  }

  // LA MAYÚSCULA DE CADA FRASE, con la misma regla que `limpiarParaSlack` ya tiene probada: solo si
  // la primera palabra son LETRAS. Sin la condición, "14577 mensajes…" y "corpannualops.com (…)"
  // saldrían con una mayúscula inventada encima de un número o de un dominio — cambiar un tic de bot
  // por un dato deformado es peor que el tic. Y sin la mayúscula, cuatro frases seguidas en minúscula
  // separadas por puntos son exactamente la cola de log que el jefe aprendió a saltear.
  return `${partes
    .filter(Boolean)
    .map((p) => p.replace(/^\p{Ll}+(?=[\s,;:]|$)/u, (w) => w[0]!.toUpperCase() + w.slice(1)))
    .join(". ")}.`;
}

/**
 * ¿ESTE NODO TIENE LA PUERTA CERRADA? La condición, en un solo lugar, porque decide tres cosas que
 * antes la calculaban por separado y podían separarse: el "pero" que ata la limpieza, si la frase
 * es VINCULANTE (ver `anotarHechoVinculante`), y si `elegirPool` lo puede tocar.
 */
export function puertaCerrada(diag: DiagnosticoDelNodo): boolean {
  return diag.bloqueanPor.length > 0 || diag.degradadoEn.length > 0 || diag.estado === "stalled";
}

// ═══ EL HECHO VINCULANTE ══════════════════════════════════════════════════════════════════════
//
// POR QUÉ EXISTE, y no es una abstracción de más: el gate de las dos señales protege la SALIDA DE
// LA HERRAMIENTA. La mano obedeció —emitió las dos señales juntas, está en el log— y después el
// modelo escribió prosa libre para Slack y ahí se evaporó la cláusula cara. El gate cubre el hecho
// hasta que entra al contexto y lo suelta justo cuando sale hacia el humano.
//
// LO QUE NO SIRVE, y ya se pagó dos veces en este proyecto: pedirle honestidad al prompt. Un
// criterio en prosa el modelo lo devuelve como hallazgo propio. Tampoco sirve un detector léxico
// sobre la respuesta: se prueba con esto, medido, y pasa mudo —
//
//   "El hardware de envío está impecable en los dos: la dirección de red viene sin señalamientos y
//    la firma criptográfica valida perfecto. Lo gastado es el nombre público del remitente."
//
// …cero dominios, cero números, sinónimos por todos lados. `revisarRespuesta` devuelve 0
// observaciones y `limpiarParaSlack` no toca una letra. Cualquier detector calibrado sobre las
// palabras del incidente pierde contra el siguiente sinónimo.
//
// LO QUE SÍ SE PUEDE SOSTENER es el MARCO: cuando la máquina midió una puerta cerrada, esa frase
// va PRIMERA y la prosa del modelo va DEBAJO. No impide la mentira —nada en este archivo la
// impide— pero le saca el privilegio de encabezar. Hoy el jefe lee la conclusión antes que el dato:
// el orquestador arma `[cuerpo, ...hechas].join("\n")` y el renglón de máquina queda 870 caracteres
// más abajo, después de una conclusión que ya lo convenció.
//
// Y VIVE MÁS DE UN TURNO A PROPÓSITO. El mensaje que gatilló la compra no fue el de la lectura: fue
// el siguiente, el jefe preguntando "¿es decir, sería comprar 2 dominios nuevos…?" y el agente
// contestando "Exacto, eso mismo". En ESE turno no se ejecutó ninguna mano, así que `hechas` queda
// vacío y el mensaje es solo prosa. Sin memoria, el arreglo cubre el turno que no compra nada.
//
// ponytail: memoria de proceso, no de disco — un reinicio del monitor la pierde. Alcanza para una
// conversación de Slack (que es lo que hay que cubrir) y evita un archivo más que mantener
// sincronizado. Si un reinicio en medio de una compra llega a importar, el lugar es la bitácora.

// LA PERILLA ERA LA EQUIVOCADA, y la primera versión de esto se murió por elegirla mal.
//
// Contaba PUBLICACIONES (`vidas = 3`). Contra el hilo real del incidente —1786140094.562309, cuatro
// respuestas entre 22:01:52 y 22:08:21, con manos ejecutadas en las dos primeras— el hecho de
// bizreport-control.com llegaba MUERTO al turno donde el jefe confirmó la compra. El fixture del
// test modelaba dos turnos porque se escribió desde la idea de la conversación; el log dice cuatro,
// y 5 de los 28 hilos del log tienen 4 o más (uno tiene 8 en 9 minutos). Es la lección
// `verificar-con-el-mismo-camino-de-produccion`, otra vez.
//
// Y encima el contador se gastaba donde nadie lee un hecho: el aviso "Te leí pero no pude
// contestarte" sale con `threadTs`, o sea que pasa por este embudo y descuenta una vida sin que el
// jefe lea una palabra del nodo. En el log hay 65 de esos avisos contra 59 respuestas reales — el
// camino que consume vidas es MÁS frecuente que el que las justifica, y dos timeouts seguidos de
// Kimi mataban el hecho.
//
// LA PERILLA CORRECTA ES EL HILO: un hecho vale mientras dure LA CONVERSACIÓN donde se midió, y se
// olvida por tiempo. Eso cierra de una sola vez cuatro cosas que la cuenta de vidas no podía:
//
//  · Un hilo largo no se queda sin hecho a mitad de camino.
//  · Un aviso de sistema no le cuesta nada.
//  · La GUARDIA deja de competir: sus lecturas —38 con puerta cerrada en un día, cada 10 minutos—
//    ya no desalojan lo que el chat midió, ni encabezan un hilo donde nadie preguntó por ese nodo.
//  · No hay fuga entre hilos: el cierre de una promesa en T2 dejó de salir con el párrafo de un
//    nodo medido en T1.

/** Cuánto vive un hecho sin que lo vuelvan a tocar. Una conversación de Slack cabe holgada. */
export const HECHO_VIVE_MS = 6 * 60 * 60 * 1000;

/** Tantos como manos entran por vuelta: más que eso no es un encabezado, es una pared. */
const MAX_HECHOS_VIVOS = MAX_ACCIONES_POR_VUELTA;

/** El hilo que ya no es de nadie: lo que la guardia midió por su cuenta y publicó al canal pelado. */
const SIN_DUENIO = "(publicado al canal, sin dueno)";

interface HechoVinculante {
  frase: string;
  /** `null` = todavía sin reclamar. La primera publicación que lo lleve se lo queda. */
  hilo: string | null;
  /** Última vez que la máquina lo midió o lo publicó. El reloj del olvido cuelga de acá. */
  visto: number;
  /** ¿Ya encabezó un mensaje? A partir de la segunda vez va en corto. */
  yaEncabezo: boolean;
}

const VINCULANTES = new Map<string, HechoVinculante>();

/**
 * Marca la frase de un nodo como VINCULANTE: mientras dure la conversación, encabeza lo que se
 * publique ahí. La llama `ejecutarAcciones` cuando la mano midió una puerta cerrada — nunca el
 * modelo.
 *
 * RE-MEDIR LO MISMO NO LO REVIVE. La guardia re-diagnostica el mismo dominio todo el día
 * —bizregistry-ops.com 73 veces en el log— y con el `vidas = 3` de la primera versión cada barrido
 * lo ponía en tres otra vez: de 20 mensajes del jefe sobre otra cosa, los 20 salían encabezados por
 * el mismo párrafo. Un encabezado que no se apaga nunca es papel tapiz, y el jefe aprende a
 * saltearlo — que es exactamente lo que este marco no puede permitirse.
 */
export function anotarHechoVinculante(dominio: string, frase: string | null, ahora = Date.now()): void {
  const f = frase?.trim() ?? "";
  if (!f) {
    // `null` = LA MANO MIDIÓ Y LA PUERTA YA NO ESTÁ CERRADA. El hecho viejo dejó de ser cierto y no
    // puede seguir encabezando: sin esto, una lectura nueva que dice "hoy nadie le está cerrando la
    // puerta" salía DEBAJO de un encabezado que afirmaba lo contrario, y durante 6 h. La máquina
    // contradiciéndose a sí misma es peor que la prosa contradiciendo a la máquina — acá el jefe no
    // tiene a quién creerle, que es justamente el capital que este marco existe para cuidar.
    VINCULANTES.delete(dominio);
    return;
  }
  const previo = VINCULANTES.get(dominio);
  // La MISMA frase: se refresca el reloj y nada más. Ni recupera el hilo que ya gastó, ni vuelve a
  // encabezar en largo.
  if (previo && previo.frase === f) {
    previo.visto = ahora;
    return;
  }
  // Una frase DISTINTA es un hecho nuevo: el estado del nodo cambió y hay que volver a decirlo.
  VINCULANTES.set(dominio, { frase: f, hilo: null, visto: ahora, yaEncabezo: false });
}

/** Poda lo vencido. Se llama en cada lectura: la memoria es de proceso y nadie más la barre. */
function podar(ahora: number): void {
  for (const [k, h] of VINCULANTES) if (ahora - h.visto > HECHO_VIVE_MS) VINCULANTES.delete(k);
}

/** Las frases vivas. Para los tests y para el informe; NO para absolver la prosa del modelo. */
export function hechosVinculantes(ahora = Date.now()): readonly string[] {
  podar(ahora);
  return [...VINCULANTES.values()].map((h) => h.frase);
}

/** Para los tests y para el arranque. La memoria es de proceso; nadie más la limpia. */
export function olvidarHechosVinculantes(): void {
  VINCULANTES.clear();
}

/**
 * LA SEGUNDA VEZ VA EN CORTO. El párrafo entero mide 400-500 caracteres, y con el hecho encabezando
 * cada turno del hilo el jefe leía el mismo texto palabra por palabra tres veces en siete minutos:
 * 1.834 de los 3.978 caracteres del hilo del incidente (46%) eran relectura. Eso es la queja 2 del
 * jefe —"demasiados mensajes de cosas que ya veo"— resucitada adentro del arreglo de la queja 1.
 *
 * Lo que queda es la PRIMERA oración, y no es un recorte arbitrario: el tramo (a) de
 * `comoEstaEsteNodo` pone ahí la puerta cerrada con sus números, o sea la cláusula que decide. Lo
 * que se cae es la autenticación y el ratio, que en la relectura no aportan.
 */
function enCorto(frase: string): string {
  const primera = frase.split(/\.\s+/)[0]!.replace(/\.$/, "");
  return `sigue en pie: ${primera[0]!.toLowerCase()}${primera.slice(1)}`;
}

/**
 * PONE EL HECHO ADELANTE, en el hilo donde se midió. Lo llama quien publica (`mandarASlack`), una
 * sola vez por mensaje, porque separar "formatear" de "marcar" en dos llamadas es garantizar que
 * alguna ruta de publicación se olvide de la segunda — el modo de falla que este repo ya pagó tres
 * veces con los marcadores.
 *
 * SIN HILO ES EL AVISO PROACTIVO DE LA GUARDIA, y ahí pasan dos cosas: no encabeza nada (el estado
 * de un nodo que nadie mencionó es ruido) y los hechos que todavía no reclamó nadie se QUEMAN. Ese
 * segundo paso es el que impide que un barrido automático de las 03:00 le caiga encima a la primera
 * conversación de la mañana.
 *
 * VAN EN CITA (`> `) a propósito, y ese es el candado contra la falsificación. Perseguir vocabulario
 * no funciona: el modelo escribió, medido, una línea con la forma exacta de `comoEstaEsteNodo`
 * —"bizreport-control.com (86.48.29.176): su IP está limpia…"— sin el prefijo `hecho:`, y quedó
 * pegada debajo de la verdadera sin nada que las distinguiera. El marco pasa a ser TIPOGRÁFICO:
 * `limpiarParaSlack` borra del cuerpo del modelo toda línea que arranque con `>`, así que la forma
 * reservada es una que él no puede emitir.
 *
 * Si la frase ya venía en el texto (el orquestador la concatena abajo con el prefijo "hecho:"), se
 * SACA de donde estaba y se sube: el jefe no lee lo mismo dos veces.
 */
// ponytail: el dueño se aprende en la PRIMERA publicación, no en la medición, porque
// `ejecutarAcciones` no recibe el hilo — los dos carriles lo llaman desde scripts/ops/warmup-monitor.ts
// y ese archivo quedó fuera del alcance de esta corrida. Techo declarado y MEDIDO: si la guardia mide
// y su vuelta decide NO hablar (queda sin publicar al canal), ese hecho se lo queda el próximo hilo
// del chat. Sale una vez en largo, después en corto, tope 3, y se olvida a las 6 h. La versión sin
// techo es un campo `hilo` en `ContextoAcciones` que el orquestador llene con `dondeResponder(m)` en
// el carril del chat y deje vacío en la guardia: ahí un barrido que nadie pidió no encabeza NUNCA.
export function anteponerHechoVinculante(texto: string, hilo?: string, ahora = Date.now()): string {
  podar(ahora);
  if (!hilo) {
    for (const h of VINCULANTES.values()) if (h.hilo === null) h.hilo = SIN_DUENIO;
    return texto;
  }
  const propios: HechoVinculante[] = [];
  const huerfanos: HechoVinculante[] = [];
  for (const h of VINCULANTES.values()) {
    if (h.hilo !== null && h.hilo !== hilo) continue;
    (h.hilo === hilo ? propios : huerfanos).push(h);
    h.hilo = hilo;
  }
  // EL TOPE ES SOBRE LO QUE ENCABEZA, no sobre lo que se recuerda: podar la MEMORIA por tamaño era
  // lo que hacía que tres lecturas de la guardia borraran lo que el chat acababa de medir en la
  // conversación abierta. Y lo medido EN ESTE HILO gana el lugar: un huérfano del barrido automático
  // no puede desalojar la respuesta a la pregunta que el jefe está haciendo.
  const cuales = [...propios.slice(-MAX_HECHOS_VIVOS), ...huerfanos].slice(0, MAX_HECHOS_VIVOS);
  if (cuales.length === 0) return texto;
  const lineas = cuales.map((h) => {
    const frase = h.yaEncabezo ? enCorto(h.frase) : h.frase;
    h.yaEncabezo = true;
    h.visto = ahora;
    return `> hecho: ${frase}`;
  });
  const yaDicha = new Set(cuales.flatMap((h) => [h.frase, `hecho: ${h.frase}`]));
  const resto = texto
    .split("\n")
    .filter((l) => !yaDicha.has(l.trim()))
    .join("\n")
    .trim();
  return [...lineas, resto].filter(Boolean).join("\n");
}

/**
 * A QUIÉN LE PEGA EL RECHAZO. Es el injerto que hace que la frase FRENE la compra en vez de solo
 * transportarse bien: "CERRADO en gmail, hotmail, outlook" no dice contra quién es el castigo, que
 * es textual lo que preguntó el jefe. Sin esto lee la cláusula, ve que el agente acierta sobre
 * Gmail, y compra igual.
 */
function deQuienEsElCastigo(quienes: readonly string[], culpa: Readonly<Record<string, CulpaDelRechazo>>): string {
  const porIp: string[] = [];
  const porDominio: string[] = [];
  const porBuzon: string[] = [];
  const noSe: string[] = [];
  for (const q of quienes) {
    const c = culpa[q] ?? culpa[q.toLowerCase()];
    if (c === "ip") porIp.push(q);
    else if (c === "dominio") porDominio.push(q);
    else if (c === "buzon") porBuzon.push(q);
    else noSe.push(q); // ausente y "no-se" caen en la misma rama, y esa es la regla de la casa
  }
  const frases: string[] = [];
  if (porIp.length > 0) {
    frases.push(
      `a ${enumerar(porIp)} le${porIp.length === 1 ? "" : "s"} molesta la IP y no el dominio, o sea que un dominio nuevo sobre este nodo nace bloqueado ahí`
    );
  }
  if (porDominio.length > 0) frases.push(`${enumerar(porDominio)} castiga la reputación del dominio`);
  if (porBuzon.length > 0) frases.push(`${enumerar(porBuzon)} rebota por buzones que no existen`);
  // MAPA VACÍO Y RECEPTOR SIN CLASIFICAR NO SON LO MISMO, y decirlos igual costó el 74% del ruido.
  //
  // Medido sobre los 58 nodos de la flota del 2026-08-07: la advertencia "No medí si el castigo es
  // contra la IP o contra el dominio…" (128 caracteres, palabra por palabra idéntica) salía en 43 de
  // ellos —5.504 caracteres de molde por barrido— porque `culpaPorProveedor` no está cableado y el
  // mapa llega SIEMPRE vacío. En el hilo del incidente aparece 6 veces en 4 mensajes. Eso no es
  // honestidad: es el "bot del 2000" que el jefe pidió matar, y una advertencia que sale en tres de
  // cada cuatro mensajes se desactiva por reflejo antes de que sirva para algo.
  //
  // Y encima decía algo falso en el matiz que importa: "no medí" suena a "esta vez no lo miré",
  // cuando la verdad es que el sistema todavía no tiene con qué medirlo en ningún lado.
  //
  // Con el mapa vacío no se publica nada: la frase ya dice QUIÉN rechaza, y eso es todo lo que hoy
  // se sabe. La duda vuelve sola —y con contenido real— el día que el orquestador cablee `culpa`,
  // porque ahí un receptor en `no-se` sí es información: los otros vinieron clasificados y ése no.
  const seMidio = Object.keys(culpa).length > 0;
  if (noSe.length > 0 && seMidio) {
    // LA RAMA QUE CORRE CUANDO EL MAPA LLEGÓ CON DATOS Y ESTE RECEPTOR NO SE PUDO CLASIFICAR. Dos
    // cosas cambiaron respecto de la primera versión:
    //
    //  1. NO RE-ENUMERA. Decía "de gmail.com, hotmail.com y outlook.com no sé si…" quince palabras
    //     después de haberlos nombrado. Con ocho receptores era la misma lista dos veces en la misma
    //     frase: 113 caracteres de molde + los dominios, pegados en cuatro mensajes seguidos. Eso es
    //     el "bot del 2000" que el jefe pidió matar, y lo desactiva en una semana.
    //  2. LA DUDA CIERRA HACIA EL LADO CARO. Terminaba en "no puedo decirte que un dominio nuevo
    //     cambie algo", que el modelo dio vuelta sin esfuerzo: "el chequeo no logró confirmar que
    //     sea la IP → entonces lo más probable es el nombre → comprá". Una duda que se puede
    //     resolver hacia la compra es combustible. La consecuencia real de no saber es que si el
    //     castigo es a la IP, el dominio nuevo NACE BLOQUEADO — y eso sí se puede decir sin medir.
    frases.push(
      noSe.length === quienes.length
        ? "no medí si el castigo es contra la IP o contra el dominio, así que un dominio nuevo sobre este nodo puede nacer bloqueado igual"
        : `de ${enumerar(noSe)} no medí si es la IP o el dominio, así que ahí un dominio nuevo puede nacer bloqueado igual`
    );
  }
  return frases.join("; ");
}

/** Cuántos días mira `que_paso` cuando el modelo no pide ventana. Inclusive: hoy cuenta. */
export const VENTANA_POR_DEFECTO_DIAS = 7;

/** Un día en YYYY-MM-DD, o `null` si no es una fecha de calendario real. */
function diaValido(s: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  // El round-trip es el que ataja 2026-02-31: `new Date` no falla, rueda a marzo. Comparar contra
  // el string original es la única forma barata de distinguir "fecha rara" de "fecha inexistente".
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/**
 * La ventana que pidió el modelo, validada. Devuelve el rango o el motivo del rechazo.
 *
 * PURA Y EXPORTADA porque es la única parte de `que_paso` que decide algo, y lo que decide es
 * delicado: RECHAZA en vez de corregir. La tentación era caer al default de 7 días cuando la fecha
 * no parsea, y eso es exactamente la clase de error que este proyecto ya pagó — el modelo pediría
 * 30 días, recibiría 7, y reportaría "no pasó nada en 30 días". Un dato que no se pudo pedir no es
 * un dato vacío: "no medido" y "cero" no son lo mismo, y un rango silenciosamente recortado
 * fabrica el peor de los dos.
 *
 * Ausencia total sí cae al default, porque ahí no hay ninguna intención que traicionar.
 */
export function ventanaPedida(
  desde: string | undefined,
  hasta: string | undefined,
  ahora: Date
): { desde: string; hasta: string } | { error: string } {
  const d = (desde ?? "").trim();
  const h = (hasta ?? "").trim();
  if (d && !diaValido(d)) return { error: `"${d}" no es una fecha. El formato es AAAA-MM-DD (por ejemplo ${ahora.toISOString().slice(0, 10)})` };
  if (h && !diaValido(h)) return { error: `"${h}" no es una fecha. El formato es AAAA-MM-DD (por ejemplo ${ahora.toISOString().slice(0, 10)})` };

  const fin = h || ahora.toISOString().slice(0, 10);
  const menosDias = (dia: string, n: number): string =>
    new Date(new Date(`${dia}T00:00:00.000Z`).getTime() - n * 86_400_000).toISOString().slice(0, 10);
  const ini = d || menosDias(fin, VENTANA_POR_DEFECTO_DIAS - 1);

  if (ini > fin) return { error: `el rango está al revés: ${ini} es posterior a ${fin}` };
  return { desde: ini, hasta: fin };
}

/**
 * Ejecuta lo que el agente pidió, filtrando todo lo que no esté explícitamente permitido.
 *
 * Todo lo que llega acá viene del modelo, así que se valida como entrada hostil: nombre de acción
 * contra lista blanca, dominio contra el inventario real, motivo obligatorio. Lo rechazado se
 * devuelve con su razón — no se ignora en silencio, porque un agente que "no hizo nada" sin
 * explicación es indistinguible de uno roto.
 */
export async function ejecutarAcciones(
  pedidas: readonly AccionPedida[],
  ctx: ContextoAcciones
): Promise<ResultadoAccion[]> {
  const ahora = (ctx.ahora ?? (() => new Date()))();
  const out: ResultadoAccion[] = [];

  for (const p of pedidas.slice(0, MAX_ACCIONES_POR_VUELTA)) {
    const nombre = (p.accion ?? "").trim();
    const motivo = (p.motivo ?? "").trim();

    if (!motivo) {
      out.push({ accion: nombre, objetivo: p.dominio ?? p.id ?? null, ejecutada: false, detalle: "rechazada: toda acción exige un motivo" });
      continue;
    }

    // ── EL BUCLE SE CORTA ACÁ, NO EN EL PROMPT ────────────────────────────────────────────────
    //
    // Medido en warmup-acciones.json de producción: 300 acciones en 233 vueltas, y
    // `diagnosticar_dominio bizregistry-ops.com` pedida 34 VECES recibiendo 34 veces la misma
    // respuesta. El contador ya existía y ya entraba al prompt —"lo pediste 34 veces"— pero en
    // PROSA, que es la forma que este proyecto ya pagó dos veces: un párrafo el modelo lo lee, lo
    // devuelve como hallazgo propio y sigue de largo. Un ejecutor, en cambio, no negocia.
    //
    // El rechazo SÍ le vuelve al modelo como hecho (entra a la bitácora y de ahí al prompt), que es
    // lo único que se vio funcionar. Y solo alcanza a las manos PASIVAS: ver `PASIVAS`.
    if (PASIVAS.has(nombre)) {
      const veces = ctx.yaDaLoMismo?.(nombre, (p.dominio ?? "").trim().toLowerCase() || null) ?? null;
      if (veces !== null) {
        out.push({
          accion: nombre,
          objetivo: (p.dominio ?? "").trim().toLowerCase() || null,
          ejecutada: false,
          detalle: `rechazada: ya lo pediste ${veces} veces y las últimas dos dieron exactamente lo mismo. Hace falta un dato nuevo primero, no otra consulta igual.`
        });
        continue;
      }
    }

    switch (nombre) {
      case "bajar_cap_nodo": {
        // LA MANO DEL MEDIO. Sale de una queja concreta: el agente veía infranationalreport.com
        // con el nodo cableado a 15.000/día contra un techo de 2.000, y sus únicas opciones eran
        // matarlo o escribirle a Juanes. Matarlo era desproporcionado —por ese nodo sale correo de
        // un cliente— así que escribía. Le pasaba un problema que podía resolver solo.
        //
        // No lleva el alcance de `frenablesConDanio` y es a propósito: frenar QUITA el envío,
        // bajar el cap lo ACOTA. Bajar a 2.000 un nodo cableado a 15.000 no le saca nada a nadie
        // salvo la posibilidad de cruzar un umbral que no se deshace.
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: fueraDeAlcance(p.dominio) });
          break;
        }
        if (!ctx.bajarCapNodo) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: bajar el cap no está habilitado en este entorno" });
          break;
        }
        // SOLO BAJA. Se lee el cap vivo y si ya está en el techo o por debajo, no se toca: sin este
        // chequeo la "reducción" podría SUBIR un nodo que estaba en 20, que es exactamente la
        // acción irreversible que este módulo existe para impedir.
        if (!ctx.leerCupoNodo) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: sin poder leer el cupo del nodo no bajo nada a ciegas" });
          break;
        }
        let vivo: { cap: number | null };
        try {
          vivo = await ctx.leerCupoNodo(dominio);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude leer el nodo, así que no bajo nada: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        if (vivo.cap === null) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `${dominio}: no pude confirmar el cupo actual. No bajo a ciegas.` });
          break;
        }
        if (vivo.cap <= CAP_SEGURO_POR_DOMINIO) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `${dominio} ya está en ${vivo.cap}/día, que no pasa el techo de ${CAP_SEGURO_POR_DOMINIO}: no hacía falta` });
          break;
        }
        let b: { antes: number | null; despues: number };
        try {
          b = await ctx.bajarCapNodo(dominio, CAP_SEGURO_POR_DOMINIO, motivo);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude bajar el cap de ${dominio}: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        out.push({
          accion: nombre,
          objetivo: dominio,
          ejecutada: true,
          detalle: `${dominio}: bajé el cupo del nodo de ${b.antes ?? "?"} a ${b.despues}/día — ${motivo}`,
          antes: b.antes,
          despues: b.despues
        });
        break;
      }

      case "frenar_dominio": {
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        // El dominio tiene que EXISTIR. Sin esto, un nombre alucinado por el modelo se convertiría
        // en una llamada SSH contra vaya a saber qué.
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: fueraDeAlcance(p.dominio) });
          break;
        }
        // ALCANCE: solo se frena donde el daño YA está hecho o el receptor YA cerró la puerta.
        // Frenar un dominio cruzado solo puede ayudar —lo irreversible ya ocurrió—; frenar uno
        // SANO cuesta calentamiento real y lo decide el operador, no el modelo. Si el agente
        // quiere frenar uno sano, la salida es anotar_pendiente, no ejecutar.
        //
        // `null` NO es `undefined` acá, y la diferencia importa desde que el campo admite los tres
        // estados: `undefined` es "este entorno no restringe" (dry-run, tests) y sigue dejando
        // pasar; `null` es "no pude leer la medición de la flota", y ahí no hay con qué verificar el
        // alcance. Sin esta distinción, el mismo `null` que cierra el gate de soltar ABRIRÍA el del
        // freno —de `[]` (rechaza todo) pasaría a "sin restricción" (acepta todo)— o sea que el
        // arreglo de un lado sería el agujero del otro.
        const alcance = ctx.frenablesConDanio;
        if (!ctx.ordenadoPorElJefe && alcance === null) {
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: false,
            detalle: `rechazada: no se pudo leer la medición de la flota, así que no sé si ${dominio} tiene daño. Frenar sin saberlo puede costar calentamiento sano.`
          });
          break;
        }
        if (!ctx.ordenadoPorElJefe && alcance && !alcance.some((d) => d.toLowerCase() === dominio)) {
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: false,
            detalle: `rechazada: ${dominio} no cruzó el umbral ni está frenado por el receptor — frenar un dominio sano cuesta calentamiento y lo decide el operador. Anótalo como pendiente.`
          });
          break;
        }
        if (!ctx.frenarDominio) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: frenar no está habilitado en este entorno" });
          break;
        }
        // El SSH puede fallar, y si la excepción escapa de acá se lleva puesto al agente entero.
        // `limite-fisico.ts` sale con código 1 cuando algún nodo falla —o simplemente tarda más de
        // 120s— y `promisify(execFile)` convierte eso en un rechazo. Sin este catch, el throw sube
        // hasta `main().catch(→ process.exit(1))`, launchd relanza a los 10s, el prompt de entrada
        // es idéntico porque no se persistió nada, el modelo vuelve a pedir lo mismo y vuelve a
        // morir: bucle de crash con el vigilante mudo toda la noche. Y el watchdog no lo mira.
        //
        // Las tres manos pasivas ya tenían su try/catch; estas dos —las que mutan— eran los únicos
        // awaits desnudos del switch. Que la acción falle tiene que ser un renglón en el informe,
        // nunca la caída del proceso que la pidió.
        let r: { antes: number | null; despues: number };
        try {
          r = await ctx.frenarDominio(dominio, motivo);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude frenar ${dominio}: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        if (r.antes === 0) {
          // Ya estaba frenado: reportarlo como acción NUEVA hace creer que pasó algo que no pasó,
          // y en el registro queda un "frené X" por vuelta sobre un nodo que no cambió nunca.
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `${dominio} ya estaba en cap 0: no hacía falta` });
          break;
        }
        out.push({
          accion: nombre,
          objetivo: dominio,
          ejecutada: true,
          detalle: `${dominio} frenado (cap ${r.antes ?? "?"} → ${r.despues}) — ${motivo}`,
          antes: r.antes,
          despues: r.despues
        });
        break;
      }

      case "soltar_dominio": {
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: fueraDeAlcance(p.dominio) });
          break;
        }
        if (!ctx.soltarDominio) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: soltar no está habilitado en este entorno" });
          break;
        }
        // Las verificaciones NO son opcionales: si falta el instrumento para comprobar una
        // condición, no se suelta. Un chequeo que no se puede hacer no es un chequeo que pasa.
        if (!ctx.leerCupoNodo || !ctx.diagnosticarDominio || !ctx.medirDominio || !ctx.revisarReputacion) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: sin con qué verificar las condiciones, no se suelta nada" });
          break;
        }

        // ── (0) DAÑO CONSUMADO: nunca vuelve ────────────────────────────────────────────────────
        //
        // `frenablesConDanio` es la lista de dominios que cruzaron el umbral permanente de Google o
        // ya están en su tope. Se usa para decidir a quién SÍ puede frenar el modelo por su cuenta;
        // acá se usa al revés, que es el mismo hecho leído en la otra dirección: si un dominio está
        // ahí, lo irreversible ya ocurrió y devolverle cupo no lo recupera — solo gasta envíos y lo
        // empuja más adentro.
        //
        // Va PRIMERO y a propósito: es el único rechazo que no depende de leer nada por SSH, así
        // que un dominio quemado se rechaza aunque el SSH y Postgres estén caídos.
        // Y no lo levanta ni una orden del jefe: la autoridad no deshace un umbral permanente.
        //
        // Pero SÍ depende de que alguien haya leído la medición de la flota, y ahí estuvo el
        // agujero DOS VECES seguidas. Primero fue `Boolean(ctx.frenablesConDanio?.some(...))`, que
        // colapsaba "el campo no vino" con "no está en la lista". Se cambió por
        // `ctx.frenablesConDanio ? some() : null`… y NO cerró nada, porque en JavaScript `[]` ES
        // TRUTHY: el único productor real (scripts/ops/warmup-monitor.ts) arma este campo con
        // `[...new Set([...(hechos.flota?.cruzados ?? []), ...])]`, y un spread SIEMPRE devuelve
        // array. Con `sender-measurement.json` ilegible —se lee con `.catch(() => null)`— la lista
        // llegaba VACÍA, `some()` daba `false`, y bizreport-control.com, que cruzó el umbral
        // PERMANENTE de Google, salía con cupo 20. Reproducido contra `ejecutarAcciones` real:
        // `frenablesConDanio: []` ⇒ `ejecutada: true`. El arreglo anterior solo protegía la forma
        // `undefined`, que producción no puede producir.
        //
        // Por eso acá la LISTA VACÍA TAMBIÉN es "no sé". Es deliberadamente conservador: hoy no se
        // puede distinguir "leí la flota y nadie cruzó" de "no pude leer la flota", porque el
        // productor codifica las dos como `[]`. Entre las dos lecturas se elige la que falla
        // cerrado — el costo máximo es que un dominio virgen espere, y el del otro lado es
        // irreversible.
        //
        // ponytail: techo conocido — con la flota legítimamente sin ningún dominio cruzado,
        // `soltar_dominio` queda bloqueado (hoy no pasa: hay 9 cruzados). Se levanta el día que
        // scripts/ops/warmup-monitor.ts pase `hechos.flota ? [...new Set([...])] : null` en sus dos
        // `ejecutarAcciones` (~:596 guardia y ~:1015 chat); ahí `[]` vuelve a significar "leí y
        // ninguno" y esta línea puede volver a `!= null`.
        //
        // Las tres condiciones salen de `porQueNoVuelve`, no de acá: es la misma función que se le
        // muestra al agente al lado de cada dominio frenado. Se la llama en TRES tramos —uno por
        // cada dato que se va consiguiendo— para no gastar un SSH ni una consulta a Postgres en un
        // dominio que ya se rechazó, y para que el orden de los rechazos no cambie. En los tramos
        // 2 y 3 `cruzado` va en `false` porque ESTE tramo ya lo verificó, no porque se suponga.
        const quemado = porQueNoVuelve({
          cruzado: ctx.frenablesConDanio?.length ? ctx.frenablesConDanio.some((d) => d.toLowerCase() === dominio) : null,
          bloqueanPor: [],
          muestra: 0,
          tasaInbox: null
        });
        if (quemado) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `rechazada: ${dominio} ${quemado}` });
          break;
        }

        // ── (1) ¿ESTÁ frenado de verdad? ────────────────────────────────────────────────────────
        // Contra el nodo vivo, no contra el archivo. Es la lección del 2026-08-05: el agente afirmó
        // "cupo 255" leyendo un sender-cap.json de horas sobre un nodo que él mismo había puesto
        // en 0. Soltar algo que ya estaba suelto sería subirle el cupo a un dominio que ya andaba.
        let cupo: { cap: number | null; consumidoHoy: number | null };
        try {
          cupo = await ctx.leerCupoNodo(dominio);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude leer el nodo, así que no suelto: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        if (cupo.cap === null) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `${dominio}: no pude confirmar el cupo actual. No suelto a ciegas.` });
          break;
        }
        if (cupo.cap > 0) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `${dominio} ya está suelto (cap ${cupo.cap}): no hacía falta` });
          break;
        }

        // ── (2) ¿Hay alguien del otro lado? ─────────────────────────────────────────────────────
        // Soltar contra una puerta cerrada no calienta: produce rebotes, y los rebotes son
        // exactamente lo que empuja al umbral permanente. Es peor que no hacer nada.
        let diag: DiagnosticoDelNodo;
        try {
          diag = await ctx.diagnosticarDominio(dominio);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude diagnosticar, así que no suelto: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        const cerrado = porQueNoVuelve({ cruzado: false, bloqueanPor: diag.bloqueanPor, muestra: 0, tasaInbox: null });
        if (cerrado) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `rechazada: ${dominio} ${cerrado}` });
          break;
        }

        // ── (3) ¿Su propia historia lo desaconseja? ─────────────────────────────────────────────
        // Sin mediciones SÍ se suelta: un dominio nuevo no tiene historia y esperar evidencia que
        // solo puede aparecer enviando es el mismo candado que paralizó la flota. Con mediciones
        // suficientes y malas, no: eso ya es evidencia, y dice que no está listo.
        let medida: { tasaInbox: number | null; muestra: number; diaN: number | null };
        try {
          medida = await ctx.medirDominio(dominio);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude medirlo, así que no suelto: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        const historiaMala = porQueNoVuelve({
          cruzado: false,
          bloqueanPor: [],
          muestra: medida.muestra,
          tasaInbox: medida.tasaInbox
        });
        if (historiaMala) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `rechazada: ${dominio} ${historiaMala}` });
          break;
        }

        // ── (4) ¿SU IP ESTÁ EN UNA LISTA NEGRA? ─────────────────────────────────────────────────
        //
        // LAS TRES CONDICIONES DE ARRIBA SON CIEGAS A ESTO, y se descubrió con dos dominios con
        // nombre. corpfiling-relay.com (217.216.55.59) y corpfilingrelay.com (217.216.55.64) están
        // LISTADOS ahora mismo —`dig 59.55.216.217.dyna.spamrats.com` ⇒ 127.0.0.36, con control
        // positivo y negativo verificados— y los dos son candidatos naturales a soltar: cap 0,
        // tráfico cero, nadie les cerró la puerta todavía, cero mediciones propias. O sea que pasan
        // los tramos (0), (1), (2) y (3) sin tocar una sola señal. Soltarlos los pone a calentar
        // desde una IP listada, que es construir la reputación al revés — el único trabajo que no se
        // puede deshacer, y encima en la ÚNICA acción del agente que aumenta volumen.
        //
        // "NO SÉ" TAMBIÉN RECHAZA, y ése es el punto del tramo. En el warmup-reputacion.json de
        // producción esos dos figuran `listas: "no-se"`, y `authRota` (plan-diario.ts) falla al
        // SILENCIO ante `no-se` —correctamente: excluir del pool por falta de dato apagaría la
        // fábrica—. Pero excluir del pool y SOLTAR no son la misma decisión: la primera cuesta un
        // dominio menos calentando y es reversible; la segunda enciende envío real. Cobertura medida
        // sobre los 49 nodos con cap > 0: 5 listados, 11 limpios, 33 sin medir. Un chequeo que no se
        // pudo hacer no es un chequeo que pasa — mismo criterio que el resto de esta acción.
        //
        // VA ÚLTIMO Y NO PRIMERO por el presupuesto de MXToolbox: es la única condición que gasta
        // cuota de una API paga, así que sólo se paga cuando el candidato ya pasó todo lo demás.
        let rep: ReputacionLeida;
        try {
          rep = await ctx.revisarReputacion(dominio);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude mirar sus listas negras, así que no suelto: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        if (rep.blacklist.estado !== "ok") {
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: false,
            detalle:
              rep.blacklist.estado === "mal"
                ? `rechazada: la IP de ${dominio} está en una lista negra (${rep.blacklist.detalle}). Calentar desde ahí construye la reputación al revés`
                : `rechazada: no pude medir si la IP de ${dominio} está en listas negras (${rep.blacklist.detalle}). No suelto a ciegas`
          });
          break;
        }

        // Mismo blindaje que frenar, y por la misma razón: un SSH que falla no puede matar al
        // agente. Ver el comentario largo en frenar_dominio.
        let s: { antes: number | null; despues: number };
        try {
          s = await ctx.soltarDominio(dominio, CAP_AL_SOLTAR, motivo);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude soltar ${dominio}: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        // LA SALVEDAD AL FINAL, NO ENTRE DOS BUENAS NOTICIAS. La frase vieja era
        // "…soltado con cupo 20/día (estaba en 0) — sin mediciones previas (arranca de cero), nadie
        // se lo bloquea. <motivo>": el dato caro —que arranca A CIEGAS— quedaba en el medio, con un
        // "nadie se lo bloquea" tranquilizador pisándolo justo después. Es la misma forma que el
        // 2026-08-07 se resumió mal en la mano de reputación, y acá encima es la ÚNICA acción que
        // aumenta volumen.
        const historia =
          medida.muestra === 0
            ? "todavía no tiene ni una medición propia, así que arranca a ciegas"
            : `viene con ${Math.round((medida.tasaInbox ?? 0) * 100)}% de bandeja sobre ${medida.muestra} mediciones`;
        out.push({
          accion: nombre,
          objetivo: dominio,
          ejecutada: true,
          detalle: `${dominio} vuelve a calentar con cupo ${s.despues}/día (estaba en ${s.antes ?? 0}) porque hoy nadie se lo bloquea: ${motivo}. Ojo que ${historia}`,
          antes: s.antes,
          despues: s.despues
        });
        break;
      }

      case "pausar_warmup": {
        if (!ctx.pausarWarmup) {
          out.push({ accion: nombre, objetivo: null, ejecutada: false, detalle: "rechazada: pausar no está habilitado en este entorno" });
          break;
        }
        // Idempotente: si ya estaba pausado no se reporta como una acción nueva. Un registro que
        // dice "pausé el warmup" tres veces seguidas hace creer que pasó algo tres veces.
        if (await ctx.warmupPausado?.()) {
          out.push({ accion: nombre, objetivo: null, ejecutada: false, detalle: "el warmup ya estaba pausado: no hacía falta" });
          break;
        }
        await ctx.pausarWarmup(motivo);
        out.push({ accion: nombre, objetivo: null, ejecutada: true, detalle: `warmup pausado — ${motivo}` });
        break;
      }

      case "anotar_pendiente": {
        const que = (p.dominio ?? "").trim() || motivo;
        const lista = await ctx.pendientes.listar();
        // Mismo pendiente ⇒ se suma al contador, NO se crea otro. Sin esto, "falta una semilla de
        // Yahoo" generaría un pendiente nuevo cada 10 minutos y la lista sería inservible en un día.
        const previo = lista.find((x) => !x.resueltoEn && mismoPendiente(x.que, que));
        if (previo) {
          previo.visto += 1;
          // Copia, nunca el mismo array que devolvió `listar`. Si el almacén hace
          // `lista.length = 0; push(...p)` y `p === lista`, vacía todo antes de guardar. Es un
          // aliasing fácil de escribir sin darse cuenta, y el resultado sería perder la lista
          // entera de pendientes en silencio.
          await ctx.pendientes.guardar([...lista]);
          out.push({ accion: nombre, objetivo: previo.id, ejecutada: false, detalle: `ya estaba anotado (visto ${previo.visto} veces): ${que}` });
          break;
        }
        const nuevo: Pendiente = {
          id: `p-${lista.length + 1}-${que.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
          que,
          porque: motivo,
          abiertoEn: ahora.toISOString(),
          visto: 1
        };
        await ctx.pendientes.guardar([...lista, nuevo]);
        out.push({ accion: nombre, objetivo: nuevo.id, ejecutada: true, detalle: `pendiente anotado: ${que}`, despues: nuevo.id });
        break;
      }

      case "proponer_subida": {
        // EL AGENTE ARGUMENTA QUE UN DOMINIO SE GANÓ UN ESCALÓN — y no puede dárselo.
        //
        // Hasta acá tenía nueve manos y la única que subía volumen era `soltar_dominio`, con cupo
        // FIJO y cuatro condiciones en código. Para todo lo demás su única salida era
        // `anotar_pendiente`, que pierde los números por el camino: "hay que subirle el cupo a X" no
        // se puede evaluar sin el placement, la muestra y la distancia a los dos techos.
        //
        // NO EJECUTA NADA. Escribe una nota en la lista de pendientes y termina: no toca un cap, no
        // manda un correo, no llama a `soltarDominio`. La decisión es del operador y el texto lo
        // dice. Hay un test que fija los dos lados (cero efectos, y 0 propuestas si el gate falla).
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: fueraDeAlcance(p.dominio) });
          break;
        }
        if (!ctx.datosParaProponer) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: proponer no está habilitado en este entorno" });
          break;
        }
        let datos: DatosParaProponer | null;
        try {
          datos = await ctx.datosParaProponer(dominio);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude juntar los números de ${dominio}: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        // SIN NÚMEROS NO HAY PROPUESTA. Una nota que dice "subile el cupo" sin la evidencia es la
        // versión perezosa que ya existía y que ya se demostró inútil.
        if (!datos) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `${dominio}: no tengo sus números de hoy (no está en el plan), así que no hay nada que proponer.` });
          break;
        }
        // SE AUTORRECHAZA CONTRA EL CRITERIO DETERMINISTA. No se propone lo que el gate ya niega:
        // una propuesta que el propio motor rechazaría le hace perder tiempo al operador y entrena
        // a ignorarlas. El gate lo evalúa el motor, no el modelo y no esta función.
        if (!datos.gate.pasa) {
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: false,
            detalle: `${dominio} no pasa el gate del motor (${datos.gate.falla ?? "sin detalle"}): no propongo lo que el criterio ya niega.`
          });
          break;
        }
        // Y NUNCA POR ENCIMA DEL TECHO. El cupo lo produce el motor, pero un techo que solo vive en
        // el productor no es un techo: si algún día el motor propone 6.000, acá se corta igual.
        if (datos.cupoPropuesto > TECHO_DIARIO_RECOMENDADO) {
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: false,
            detalle: `${dominio}: el escalón propuesto (${datos.cupoPropuesto}/día) pasa el techo de ${TECHO_DIARIO_RECOMENDADO}/día. Eso no se propone solo.`
          });
          break;
        }
        const que = textoDeLaPropuesta(dominio, datos);
        const lista = await ctx.pendientes.listar();
        // LA IDENTIDAD ES EL DOMINIO, no el texto. `mismoPendiente` compara vocabulario, y dos
        // propuestas de dominios distintos comparten TODAS las palabras salvo el nombre: se habrían
        // fundido en una y el segundo dominio desaparecía. Acá la marca es exacta y no hay
        // heurístico que discutir.
        //
        // Busca `identidadDePropuesta` y NO el preámbulo: ver su comentario — con el preámbulo, una
        // corrección de estilo del texto huerfanaba las propuestas ya abiertas.
        const previo = lista.find((x) => !x.resueltoEn && x.que.includes(identidadDePropuesta(dominio)));
        if (previo) {
          previo.visto += 1;
          // Los NÚMEROS se refrescan: son la evidencia, y una propuesta de ayer con el placement de
          // ayer es peor que ninguna. El `visto` dice hace cuánto que está esperando decisión.
          previo.que = que;
          previo.porque = motivo;
          await ctx.pendientes.guardar([...lista]);
          out.push({ accion: nombre, objetivo: previo.id, ejecutada: false, detalle: `ya te lo había propuesto (visto ${previo.visto} veces, números actualizados): ${que}` });
          break;
        }
        const nueva: Pendiente = {
          id: `p-${lista.length + 1}-subir-${dominio.replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`,
          que,
          porque: motivo,
          abiertoEn: ahora.toISOString(),
          visto: 1
        };
        await ctx.pendientes.guardar([...lista, nueva]);
        out.push({ accion: nombre, objetivo: nueva.id, ejecutada: true, detalle: que, despues: nueva.id });
        break;
      }

      case "resolver_pendiente": {
        const id = (p.id ?? "").trim();
        const lista = await ctx.pendientes.listar();
        const item = lista.find((x) => x.id === id && !x.resueltoEn);
        if (!item) {
          out.push({ accion: nombre, objetivo: id ?? null, ejecutada: false, detalle: `rechazada: no hay pendiente abierto con id "${id}"` });
          break;
        }
        item.resueltoEn = ahora.toISOString();
        await ctx.pendientes.guardar([...lista]);
        out.push({ accion: nombre, objetivo: item.id, ejecutada: true, detalle: `pendiente resuelto: ${item.que} — ${motivo}` });
        break;
      }

      case "leer_cupo_nodo": {
        // IR A MIRAR. No muta nada, así que no lleva flag: la única mano que el agente puede usar
        // libremente. Existe porque sin ella afirmaba sobre archivos de horas — dijo
        // "bizreport-control.com sigue con cupo 255" cuando el nodo real ya estaba en 0 por su
        // propio freno. No mentía: no tenía forma de ir a ver.
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: fueraDeAlcance(p.dominio) });
          break;
        }
        if (!ctx.leerCupoNodo) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: leer el nodo no está habilitado en este entorno" });
          break;
        }
        try {
          const r = await ctx.leerCupoNodo(dominio);
          // "no se pudo leer" NUNCA se reporta como 0: un nodo ilegible parecería frenado y el
          // agente concluiría que su freno funcionó cuando en realidad no sabe nada.
          const cupo = r.cap === null ? "no se pudo leer el cupo" : r.cap === 0 ? "FRENADO (cupo 0)" : `cupo ${r.cap}/día`;
          // "sin contador hoy" es una etiqueta de máquina y además ambigua: se lee como "hoy no
          // mandó". Lo que pasa es que no pudimos leer el contador, y eso es otra cosa — ausencia de
          // dato no es evidencia. (El parseo de `limite-fisico --status` en warmup-monitor.ts sigue
          // buscando "sin contador hoy" en SU PROPIA salida, no en este detalle: son dos textos
          // distintos y este no lo alimenta.)
          const uso = r.consumidoHoy === null ? "no pude leer cuánto mandó hoy" : `${r.consumidoHoy} enviados hoy`;
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: true,
            detalle: `${dominio}: ${cupo}, ${uso}${r.motivo ? ` — ${r.motivo}` : ""}`,
            despues: r.cap
          });
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude leer el nodo: ${e instanceof Error ? e.message : String(e)}` });
        }
        break;
      }

      case "diagnosticar_dominio": {
        // POR QUÉ no entrega. Lee el mail.log del nodo: quién lo rechaza y con qué motivo. Pasivo,
        // no manda correo, así que tampoco lleva flag.
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: fueraDeAlcance(p.dominio) });
          break;
        }
        if (!ctx.diagnosticarDominio) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: diagnosticar no está habilitado en este entorno" });
          break;
        }
        try {
          const d = await ctx.diagnosticarDominio(dominio);
          // Misma frase que la mano de reputación, SIN el tramo de autenticación: acá no se
          // consultó, y `auth` opcional es lo que hace que no se pueda afirmar. Antes salía el
          // enum crudo del sensor (`blocked_by_provider`) y el motivo del receptor pegado atrás
          // como cola de log — el jefe leía eso y no lo leía.
          const frase = comoEstaEsteNodo(dominio, null, d);
          // Y si YA NO está cerrada, el `null` borra el hecho viejo: una lectura nueva no puede salir
          // debajo de un encabezado que dice lo contrario.
          anotarHechoVinculante(dominio, puertaCerrada(d) ? frase : null);
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: true,
            detalle: frase,
            // Misma razón que en medir_dominio: sin `antes` no hay veredicto posible y la bitácora
            // guarda 54 desenlaces que nadie puede juzgar.
            antes: { estado: d.estado, entregados: d.entregados, rechazados: d.rechazados }
          });
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude diagnosticar: ${e instanceof Error ? e.message : String(e)}` });
        }
        break;
      }

      case "medir_dominio": {
        // DÓNDE viene cayendo su correo y en qué día de rampa está. Los hechos ya traen esto, pero
        // SOLO de los dominios del pool — y los que hay que evaluar para soltar están justamente
        // fuera. Pasivo: consulta la base, no manda correo.
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: fueraDeAlcance(p.dominio) });
          break;
        }
        if (!ctx.medirDominio) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: medir no está habilitado en este entorno" });
          break;
        }
        try {
          const m = await ctx.medirDominio(dominio);
          // "sin mediciones" y "0% de bandeja" son cosas MUY distintas y se dicen distinto: la
          // primera es ausencia de dato, la segunda es un dato malo. Colapsarlas es la confusión
          // más cara del sistema.
          // Y LA MUESTRA VA CALIFICADA DENTRO DEL STRING, no como un número suelto que el que
          // resume puede dejar afuera. "83% de bandeja" sobre 4 mediciones no es 83% de nada: el
          // freno global del warmup se disparó el 2026-08-06 sobre 4 muestras sueltas y paró al
          // único dominio que calentaba bien, y el piso de MUESTRA_MINIMA quedó en 10 por eso.
          const tasa =
            m.muestra === 0
              ? "todavía no se midió nunca"
              : `${Math.round((m.tasaInbox ?? 0) * 100)}% de bandeja sobre ${m.muestra} mediciones${
                  m.muestra < 10 ? ", que son muy pocas para concluir nada" : ""
                }`;
          const dia = m.diaN === null ? "sin día de rampa (no arrancó)" : `día ${m.diaN} de rampa`;
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: true,
            detalle: `${dominio}: ${tasa}, ${dia}${m.ultimaMedicion ? `, última medición ${m.ultimaMedicion}` : ""}`,
            // LA FOTO DEL ANTES TAMBIÉN EN LAS MANOS QUE MIRAN. Medido en producción: 54 entradas de
            // bitácora, 0 con `antes` y por lo tanto 0 veredictos — el aprendizaje entero apagado
            // porque solo `frenar_dominio` dejaba con qué comparar, y de esa no hay una sola
            // entrada. Con {muestra, ultimaMedicion} alcanza: si la próxima medición trae muestras
            // nuevas, la mirada sirvió para algo; si devuelve exactamente lo mismo, no.
            antes: { muestra: m.muestra, ultimaMedicion: m.ultimaMedicion },
            despues: m.tasaInbox
          });
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude medirlo: ${e instanceof Error ? e.message : String(e)}` });
        }
        break;
      }

      case "que_paso": {
        // LA MANO QUE PREGUNTA. Convierte al agente de 100% precarga en algo que puede consultar.
        //
        // Sin ella, todo lo que quedaba fuera de la ventana del prompt desaparecía: 40 intercambios,
        // 12 temas, 14 días, y antes de eso nada. El día que el jefe preguntó "¿cuáles son los
        // otros 4?" el agente contestó, con razón, "no los tengo en mi lectura actual" — y ése es
        // el patrón, no el caso: no tenía forma de ir a buscar lo que él mismo había medido.
        //
        // Pasiva: lee. No cambia un cap, no manda correo, no gasta plata.
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        // MISMO GATE QUE LAS OTRAS DIEZ, a propósito: si mañana `dominiosConocidos` pasa a ser el
        // inventario entero de la fábrica, esta mano alcanza los 58 dominios sin tocar una línea
        // más. Hoy el orquestador le pasa 30 nombres del retrato del día, así que 27 dominios de la
        // fábrica son inalcanzables. Que el rechazo MINTIERA encima ya está arreglado: ver
        // `fueraDeAlcance`. Ensanchar la lista sigue siendo del lado del productor.
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: fueraDeAlcance(p.dominio) });
          break;
        }
        if (!ctx.quePaso) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: consultar la historia no está habilitado en este entorno" });
          break;
        }
        const v = ventanaPedida(p.desde, p.hasta, ahora);
        if ("error" in v) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: `rechazada: ${v.error}` });
          break;
        }
        let texto: string;
        try {
          texto = (await ctx.quePaso(dominio, v.desde, v.hasta)).trim();
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude leer la historia de ${dominio}: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        // EJECUTADA AUNQUE VUELVA VACÍA, y no es un detalle cosmético. "No hay registro" ES la
        // respuesta a la pregunta; marcarla como fallo la mandaría a la bitácora como algo que
        // reintentar, y el agente volvería a preguntar lo mismo cada diez minutos sobre una ventana
        // que no va a llenarse sola. El agujero del 21/07 al 02/08 es real: ese caso es el normal,
        // no el borde.
        //
        // Y se dice SIN un número. Un "0 muestras" o un "0%" acá sería un dato inventado sobre una
        // ausencia de dato — la lección más cara del proyecto, la misma que hace que `cruzado` sea
        // `null` y nunca `false` cuando la bandeja no se midió.
        out.push({
          accion: nombre,
          objetivo: dominio,
          ejecutada: true,
          // La rama vacía es un CINTURÓN, no el camino normal: `historiaDe` nunca devuelve vacío
          // —siempre trae al menos la línea del horizonte, y con la ventana sin filas trae además la
          // de "no hay registro"—, así que con el productor de hoy no se alcanza. Se deja porque un
          // productor distinto que devolviera "" produciría `"a.com, del X al Y: "`, un renglón con
          // dos puntos y nada atrás: la clase de salida que se lee como "no pasó nada".
          detalle: texto
            ? `${dominio}, del ${v.desde} al ${v.hasta}: ${texto}`
            : `${dominio}: no hay registro guardado entre el ${v.desde} y el ${v.hasta}. No quiere decir que no pasó nada: quiere decir que en esa ventana no se guardó ninguna medición.`
          // SIN `antes`, y se saca a propósito. Estaba puesto como "el ANTES que permite juzgar la
          // mirada", justificado con "sin `antes` no hay veredicto: 54 entradas de bitácora, 0
          // juzgadas" — y eso no era cierto de este campo ni de esta mano. Los DOS carriles del
          // orquestador guardan `antes: typeof a.antes === "number" ? { cap: a.antes } : null`
          // (scripts/ops/warmup-monitor.ts:949 y :1507), así que un objeto se tira entero; y el
          // único `juzgar` del repo (:980) corre SOLO sobre `frenar_dominio` y decide con `despues`,
          // ignorando su primer parámetro. Verificado también contra producción: 40 entradas en
          // warmup-acciones.json, 0 con `antes`, incluidas las de medir/diagnosticar que sí lo
          // producen.
          //
          // Un campo escrito y jamás leído es cobertura que se ve y no cubre — la misma clase que
          // este repo ya pagó con `hechos.reputacion`, que se llenaba cada vuelta y no lo miraba
          // nadie. Cuando `juzgar` sepa juzgar las manos de LECTURA, este campo vuelve junto con su
          // consumidor, no antes.
        });
        break;
      }

      case "revisar_reputacion": {
        // LISTAS NEGRAS DE SU IP + SU AUTENTICACIÓN, junto con quién lo está rechazando. Pasivo:
        // consulta DNS y una API de lectura, no manda un solo correo. Por eso no lleva flag.
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: fueraDeAlcance(p.dominio) });
          break;
        }
        if (!ctx.revisarReputacion) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: revisar reputación no está habilitado en este entorno" });
          break;
        }
        // ── LA REGLA DE LAS DOS SEÑALES ─────────────────────────────────────────────────────────
        //
        // Una lista negra limpia NO significa que estás entregando. El 2026-07-25 se midió: 38 de
        // 64 nodos rechazados por Gmail con 550-5.7.1 "unsolicited" y TODAS sus IPs limpias en
        // listas negras. Es reputación interna del receptor, invisible para MXToolbox. Publicar la
        // primera señal sola produce exactamente la confianza falsa que costó ese mes.
        //
        // Por eso la regla está acá y no en el prompt: sin el instrumento del receptor, la acción
        // se RECHAZA. Mismo criterio que soltar_dominio — un chequeo que no se puede hacer no es un
        // chequeo que pasa. Y como consecuencia estructural, la palabra "limpio" no puede aparecer
        // en un detalle de esta acción sin la cláusula del receptor al lado: no hay camino.
        if (!ctx.diagnosticarDominio) {
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: false,
            detalle: "rechazada: sin el estado del receptor, una lista negra limpia no dice nada. No reporto reputación sola."
          });
          break;
        }
        // El receptor PRIMERO: es gratis (lee logs) y si falla no se gastó una consulta de la API,
        // que es finita y se comparte entre 58 nodos.
        // EL TIPO LOCAL SE ENSANCHÓ A PROPÓSITO. Decía `{estado, bloqueanPor, degradadoEn,
        // entregados, rechazados}` y se comía `detalle` y `culpaPorProveedor` —los dos vienen
        // poblados y el tipo del contexto los declara—, así que la anotación local TIRABA justo el
        // texto que dice cuántos mensajes hay trabados en la cola y a quién le pega el rechazo.
        let diagRep: DiagnosticoDelNodo;
        try {
          diagRep = await ctx.diagnosticarDominio(dominio);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude leer al receptor, así que no reporto reputación: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        // UN LOG QUE NO SE PUDO LEER NO ES UN LOG LIMPIO. `readNodeDeliveryHealth` devuelve
        // `unreadable` con los contadores en 0 cuando el SSH falló o las fechas no se entienden — y
        // el ternario de abajo leía esos ceros como "nadie se lo bloquea (0 entregados / 0
        // rechazados)". O sea: la mitad que existe para que "listas negras limpias" no se lea como
        // verde, afirmaba lo verde sobre cero evidencia. Es exactamente el probe colgado del
        // 2026-07-29 que reportó 10 de 10 nodos bloqueados: un chequeo que falla se disfraza de
        // medición.
        //
        // Va ANTES de la consulta a MXToolbox a propósito: sin el receptor la acción no sale igual,
        // así que gastar cuota sería tirarla. Y sale `reintentable`, que es lo que es: un SSH caído
        // se arregla solo en la próxima vuelta y no amerita despertar a nadie.
        if (diagRep.estado === "unreadable" || diagRep.estado === "desconocido") {
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: false,
            reintentable: true,
            detalle: `${dominio}: no pude leer el registro de correo del nodo (${diagRep.estado}), así que no reporto reputación — una lista negra limpia sin el estado del receptor no dice nada.`
          });
          break;
        }
        let rep: ReputacionLeida;
        try {
          rep = await ctx.revisarReputacion(dominio);
        } catch (e) {
          // TRANSITORIO, no política: un parpadeo de la API o del DNS se arregla solo en la próxima
          // vuelta. Marcarlo como falla dura le suena el móvil al jefe por nada — es el incidente
          // del 2026-08-06, cuando Postgres se recargó doce segundos y el agente lo mencionó dos
          // veces por algo que ya estaba resuelto cuando lo leyó.
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude revisar la reputación de ${dominio}: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        if (rep.ip === null) {
          // POLÍTICA, no transitorio: falta el binding en el inventario y eso lo arregla alguien.
          // Y no se reporta como "sin detecciones": no se consultó nada.
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: false,
            detalle: `${dominio}: no sé de qué IP hablamos — no tiene nodo asignado en el inventario, así que no hay listas negras ni PTR que consultar. Hay que arreglar el binding primero.`
          });
          break;
        }
        if (rep.blacklist.estado === "no-se") {
          // Un chequeo que se cuelga o falla devuelve "no sé", nunca un veredicto. Es la lección del
          // probe con `head -c` que reportó 10 de 10 nodos bloqueados estando bien: el negativo
          // falso se disfraza de medición.
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: false,
            reintentable: true,
            detalle: `${dominio} (${rep.ip}): no pude consultar las listas negras (${rep.blacklist.detalle}). No sé si está listado y no lo voy a dar por bueno.`
          });
          break;
        }
        // LA FRASE LA ESCRIBE EL CÓDIGO. Antes acá vivía un template literal con cuatro `·` que
        // ponía la buena noticia en la cabeza y la cláusula del receptor al final, después de un
        // paréntesis sobre el TLS. El 2026-08-07 el modelo resumió la cabeza y publicó "salieron
        // con IP limpia y autenticación ok — esos nodos sirven para montarles dominio nuevo".
        // Ver el comentario largo de `comoEstaEsteNodo`: la firma es la que sostiene la regla de
        // las dos señales, no este renglón.
        const fraseRep = comoEstaEsteNodo(dominio, rep.ip, diagRep, rep);
        // Y ACÁ SE VUELVE VINCULANTE. Escribir bien la frase no alcanzó: el modelo la resumió
        // igual. Con la puerta cerrada, esta frase pasa a encabezar todo lo que se publique
        // mientras la conversación siga viva. Ver `anotarHechoVinculante`.
        // Y el `null` de la rama abierta es la otra mitad: si el nodo se recuperó, el hecho viejo se
        // borra en vez de sobrevivirle 6 h a su propia verdad.
        anotarHechoVinculante(dominio, puertaCerrada(diagRep) ? fraseRep : null);
        out.push({
          accion: nombre,
          objetivo: dominio,
          ejecutada: true,
          detalle: fraseRep,
          despues: rep.blacklist.estado
        });
        break;
      }

      default:
        // Lista blanca cerrada: lo que no está, no existe. Y se DICE, para que se vea si el modelo
        // está pidiendo cosas que no puede hacer (señal de que el prompt necesita trabajo).
        out.push({ accion: nombre, objetivo: null, ejecutada: false, detalle: `rechazada: "${nombre}" no es una acción permitida` });
    }
  }

  if (pedidas.length > MAX_ACCIONES_POR_VUELTA) {
    out.push({
      accion: "(tope)",
      ejecutada: false,
      detalle: `se ignoraron ${pedidas.length - MAX_ACCIONES_POR_VUELTA} acciones: el tope es ${MAX_ACCIONES_POR_VUELTA} por lectura`
    });
  }
  return out;
}

/**
 * Extrae las acciones del texto del modelo.
 *
 * Formato: una línea `ACCION: nombre | dominio=... | motivo=...`. Se eligió una línea de texto y
 * no JSON porque este modelo razona en prosa y devolver JSON válido le sale peor; una línea con
 * separadores la acierta siempre. Lo que no matchea se ignora — no se intenta adivinar qué quiso
 * decir, porque adivinar sobre una acción que toca producción es exactamente lo que no queremos.
 */
export function extraerAcciones(texto: string): AccionPedida[] {
  const out: AccionPedida[] = [];
  for (const linea of texto.split("\n")) {
    // Los dos puntos son OBLIGATORIOS y tiene que haber algo después. Sin exigirlo, la línea
    // "ACCION:" pelada capturaba los propios dos puntos como nombre de acción.
    const m = linea.match(/^\s*ACCION\s*:\s*(\S.*)$/i);
    if (!m) continue;
    const partes = m[1]!.split("|").map((s) => s.trim());
    let accion = partes[0]?.toLowerCase().replace(/\s+/g, "_") ?? "";
    if (!accion) continue;

    // EL DESLIZ QUE LE COSTÓ UN MENSAJE AL JEFE. El modelo escribió
    // `ACCION: diagnosticar_dominio bizregistry-ops.com | motivo=…` —el dominio pegado al nombre en
    // vez de en su campo— y como acá los espacios se vuelven guiones bajos, la acción quedó
    // "diagnosticar_dominio_bizregistry-ops.com". Rechazada por no existir, y de ahí salió a Slack
    // un "Quise diagnosticar_dominio_bizregistry-ops.com y no pude. ¿Lo resolvés vos?": el agente
    // le pidió ayuda al jefe por SU PROPIO error de sintaxis.
    //
    // Se tolera, no se castiga. La intención es inequívoca —el nombre de la acción es exacto y lo
    // que sigue es su objeto— así que se separa y sigue el camino normal, con todas sus
    // validaciones intactas: el dominio igual tiene que existir en el inventario.
    let pegado: string | undefined;
    if (!ACCIONES_VALIDAS.has(accion)) {
      for (const valida of ACCIONES_VALIDAS) {
        if (accion.startsWith(`${valida}_`)) {
          pegado = accion.slice(valida.length + 1).replace(/_/g, " ").trim();
          accion = valida;
          break;
        }
      }
    }
    const campo = (nombre: string): string | undefined =>
      partes.slice(1).find((p) => p.toLowerCase().startsWith(`${nombre}=`))?.slice(nombre.length + 1).trim();
    // El campo explícito manda sobre el pegado: si el modelo escribió las dos formas, la que
    // eligió a propósito gana.
    // `desde`/`hasta` viajan crudos: acá solo se separan del texto. Quien decide si son fechas de
    // verdad es `ventanaPedida`, y decide RECHAZANDO — un rango que no parsea no se corrige solo.
    out.push({ accion, dominio: campo("dominio") ?? pegado, motivo: campo("motivo"), id: campo("id"), desde: campo("desde"), hasta: campo("hasta") });
  }
  return out;
}

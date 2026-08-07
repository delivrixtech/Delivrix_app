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
  | "leer_cupo_nodo"
  | "diagnosticar_dominio"
  | "medir_dominio"
  | "revisar_reputacion";

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
  "leer_cupo_nodo",
  "diagnosticar_dominio",
  "medir_dominio",
  "revisar_reputacion"
]);

export const CAP_AL_SOLTAR = 20;

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
   *  · POLÍTICA — "no está en el inventario", "no está habilitado", "el receptor lo tiene
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
  diagnosticarDominio?: (dominio: string) => Promise<{
    estado: string;
    bloqueanPor: string[];
    degradadoEn: string[];
    entregados: number;
    rechazados: number;
    detalle: string;
  }>;
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
   *    cerrada, y si ya tiene mediciones no pueden ser malas.
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
  ahora?: () => Date;
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

    switch (nombre) {
      case "frenar_dominio": {
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        // El dominio tiene que EXISTIR. Sin esto, un nombre alucinado por el modelo se convertiría
        // en una llamada SSH contra vaya a saber qué.
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: `rechazada: "${p.dominio}" no está en el inventario` });
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
            detalle: `rechazada: ${dominio} no cruzó el umbral ni está frenado por el receptor — frenar un dominio sano cuesta calentamiento y lo decide el operador. Anotalo como pendiente.`
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
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: `rechazada: "${p.dominio}" no está en el inventario` });
          break;
        }
        if (!ctx.soltarDominio) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: soltar no está habilitado en este entorno" });
          break;
        }
        // Las verificaciones NO son opcionales: si falta el instrumento para comprobar una
        // condición, no se suelta. Un chequeo que no se puede hacer no es un chequeo que pasa.
        if (!ctx.leerCupoNodo || !ctx.diagnosticarDominio || !ctx.medirDominio) {
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
        let diag: { bloqueanPor: string[]; estado: string };
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

        // Mismo blindaje que frenar, y por la misma razón: un SSH que falla no puede matar al
        // agente. Ver el comentario largo en frenar_dominio.
        let s: { antes: number | null; despues: number };
        try {
          s = await ctx.soltarDominio(dominio, CAP_AL_SOLTAR, motivo);
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude soltar ${dominio}: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        const historia =
          medida.muestra === 0
            ? "sin mediciones previas (arranca de cero)"
            : `${Math.round((medida.tasaInbox ?? 0) * 100)}% de bandeja sobre ${medida.muestra} mediciones`;
        out.push({
          accion: nombre,
          objetivo: dominio,
          ejecutada: true,
          detalle: `${dominio} soltado con cupo ${s.despues}/día (estaba en ${s.antes ?? 0}) — ${historia}, nadie se lo bloquea. ${motivo}`,
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
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: `rechazada: "${p.dominio}" no está en el inventario` });
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
          const uso = r.consumidoHoy === null ? "sin contador hoy" : `${r.consumidoHoy} enviados hoy`;
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
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: `rechazada: "${p.dominio}" no está en el inventario` });
          break;
        }
        if (!ctx.diagnosticarDominio) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, detalle: "rechazada: diagnosticar no está habilitado en este entorno" });
          break;
        }
        try {
          const d = await ctx.diagnosticarDominio(dominio);
          const quien = d.bloqueanPor.length > 0 ? ` CERRADO en: ${d.bloqueanPor.join(", ")}.` : "";
          const flojo = d.degradadoEn.length > 0 ? ` Rechazo parcial en: ${d.degradadoEn.join(", ")}.` : "";
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: true,
            detalle: `${dominio}: ${d.estado}, ${d.entregados} entregados / ${d.rechazados} rechazados.${quien}${flojo} ${d.detalle}`.trim()
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
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: `rechazada: "${p.dominio}" no está en el inventario` });
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
          const tasa =
            m.muestra === 0
              ? "todavía no se midió nunca"
              : `${Math.round((m.tasaInbox ?? 0) * 100)}% de bandeja sobre ${m.muestra} mediciones`;
          const dia = m.diaN === null ? "sin día de rampa (no arrancó)" : `día ${m.diaN} de rampa`;
          out.push({
            accion: nombre,
            objetivo: dominio,
            ejecutada: true,
            detalle: `${dominio}: ${tasa}, ${dia}${m.ultimaMedicion ? `, última medición ${m.ultimaMedicion}` : ""}`,
            despues: m.tasaInbox
          });
        } catch (e) {
          out.push({ accion: nombre, objetivo: dominio, ejecutada: false, reintentable: true, detalle: `no pude medirlo: ${e instanceof Error ? e.message : String(e)}` });
        }
        break;
      }

      case "revisar_reputacion": {
        // LISTAS NEGRAS DE SU IP + SU AUTENTICACIÓN, junto con quién lo está rechazando. Pasivo:
        // consulta DNS y una API de lectura, no manda un solo correo. Por eso no lleva flag.
        const dominio = (p.dominio ?? "").trim().toLowerCase();
        if (!ctx.dominiosConocidos.some((d) => d.toLowerCase() === dominio)) {
          out.push({ accion: nombre, objetivo: p.dominio ?? null, ejecutada: false, detalle: `rechazada: "${p.dominio}" no está en el inventario` });
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
        let diagRep: { estado: string; bloqueanPor: string[]; degradadoEn: string[]; entregados: number; rechazados: number };
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
        const sello = (etiqueta: string, c: ChequeoReputacion): string =>
          c.estado === "ok" ? `${etiqueta} ok` : `${etiqueta} ${c.estado === "mal" ? "MAL" : "no sé"} (${c.detalle})`;
        const receptor =
          diagRep.bloqueanPor.length > 0
            ? `CERRADO en ${diagRep.bloqueanPor.join(", ")}`
            : diagRep.degradadoEn.length > 0
              ? `rechazo parcial en ${diagRep.degradadoEn.join(", ")}`
              : // CERO ENTREGAS + CERO RECHAZOS NO ES "nadie se lo bloquea": es que nadie lo probó.
                // Es el estado de los 7 nodos vírgenes, que son justamente el caso de uso de
                // soltar_dominio — o sea que la frase optimista salía sobre los dominios donde más
                // caro se paga creerla. "No medido" y "cero" otra vez, en el módulo escrito para no
                // confundirlos.
                diagRep.entregados + diagRep.rechazados === 0
                ? `${diagRep.estado}, sin evidencia propia (0 entregados / 0 rechazados en la ventana): nunca mandó, así que no sabemos si lo aceptan`
                : `${diagRep.estado}, nadie se lo bloquea (${diagRep.entregados} entregados / ${diagRep.rechazados} rechazados)`;
        out.push({
          accion: nombre,
          objetivo: dominio,
          ejecutada: true,
          // UNA sola frase con las dos señales. Separarlas en dos renglones sería lo mismo que
          // publicar la primera sola: el que lee se queda con la que confirma lo que ya creía.
          detalle:
            `${dominio} (${rep.ip}): listas negras ${rep.blacklist.detalle} · auth ` +
            `${[sello("SPF", rep.spf), sello("DKIM", rep.dkim), sello("DMARC", rep.dmarc), sello("PTR", rep.ptr), sello("TLS", rep.tls)].join(", ")}` +
            ` · receptor: ${receptor}`,
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
    out.push({ accion, dominio: campo("dominio") ?? pegado, motivo: campo("motivo"), id: campo("id") });
  }
  return out;
}

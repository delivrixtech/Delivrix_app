// EL CANAL DONDE EL AGENTE LE HABLA A JUANES.
//
// La pieza difícil acá NO es mandar el mensaje: son diez líneas de fetch. Es decidir CUÁNDO
// hablar. El agente corre cada 10 minutos; si escribe en cada corrida son 144 mensajes por día,
// y en dos días el operador lo silencia. Un agente silenciado es peor que no tenerlo, porque el
// día que sí importa nadie lo lee.
//
// ── EL DIAGNÓSTICO QUE ORDENA ESTE ARCHIVO ──────────────────────────────────────────────────────
//
// Hasta hoy había SIETE RAZONES sueltas para hablar, y su unidad de decisión era "¿cambió un
// número?". La pregunta del dueño del negocio es otra: "¿esto cambia algo de lo que Juanes haría
// hoy?". Un diff no puede contestar esa pregunta — por construcción sabe que X cambió y nada más.
// Por eso cada arreglo anterior fue técnicamente correcto y no movió su experiencia. Textual:
// "más de avanzar, estamos entrando a un círculo vicioso infinito, que no estoy viendo avances".
//
// Medido sobre el log de producción copiado el 2026-08-07 (sha256 49f09a10da061998…, ventana
// 2026-08-05T20:42Z..2026-08-07T11:53Z): 11 mensajes proactivos, y NUEVE de los 11 no cambiaban
// una sola decisión suya —seis huella pura del panel ("el placement de opscorpfiling.com: SPAM →
// INBOX.", "el día de rampa de statefilings-control.com: 1 → 2.", "el plan de annualcorp-infra.com:
// sostener → bajar.") y tres avisando que el agente había ido a MIRAR ("Voy a medir y diagnosticar
// los cercanos y los frenados para ver qué puedo soltar. Hice esto: revisar_reputacion
// controlnationalcorp.com.").
//
// Su queja, textual y con el remedio adentro: "esta bien que me notifique cada huella que va
// haciendo, pero tambien lo siento innecesario porque es lo que el agente en delivrix app esta
// haciendo en su columna propia". El panel YA pinta eso — la base tiene 62 filas de
// `warmup_activity` en 24 h y `/v1/warmup/activity` las sirve. Slack es para lo DEMASIADO
// IMPORTANTE.
//
// ── LA ARQUITECTURA DEL CRITERIO ────────────────────────────────────────────────────────────────
//
// `decidirSiHablar` deja de tener razones sueltas y evalúa una LISTA CERRADA (`REGLAS`) de
// predicados PUROS y SINCRÓNICOS sobre `EstadoParaSlack`. Cada regla lleva:
//   · una CLASE de un enum de tres: DANO (algo irreversible o que va camino), CEGUERA (no puede ver
//     y lleva dos vueltas sin ver) y DECISION (el jefe tiene una llave que el agente no tiene).
//   · una LLAVE de `LlaveDecision`: la cosa concreta que él hace al leerla.
// Todo lo demás es HUELLA y no sale solo.
//
// Va como lista de reglas con id —y no como un párrafo en el prompt del modelo— porque un criterio
// en prosa el modelo lo devuelve como hallazgo propio, y si es falso lo devuelve con seguridad.
// Este proyecto ya lo pagó dos veces (el `frenadosDetalle` de warmup-monitor.ts cuenta la segunda).
//
// Una regla que no puede nombrar una llave del enum no es una regla: es una huella con ínfulas. Ese
// es el gate mecánico contra el círculo, y vive en el test de cada regla.
//
// ── LA TENSIÓN DE DISEÑO, RESUELTA POR CLASE Y NO POR CARRIL ────────────────────────────────────
//
// Los avances se venían redactando con PLANTILLA PURA y sin modelo. La razón era buena —los hechos
// tienen que salir aunque el modelo esté caído, y la tarde del 2026-08-06 que el jefe se quedó sin
// noticias fue una tarde con el modelo devolviendo vacío— pero el costo es el que él está sintiendo:
// una plantilla no juzga relevancia ni suena a persona.
//
// La respuesta no es un carril, es la clase:
//   · DANO, CEGUERA y DECISION salen con PLANTILLA PURA sobre el hecho verificado. Un aviso de
//     problema que llega tarde ES el problema. Además la voz del modelo es exactamente por donde
//     entraron los 4 pedidos FALSOS de arreglar un freno que ya estaba puesto.
//   · La HUELLA promovida por aprendizaje la redacta el modelo, y si el modelo está caído NO SALE.
//     No le cuesta nada al jefe: el panel la tiene. Queda contada como `tapado=modelo-caido`.
//
// ── CÓMO APRENDE, Y POR QUÉ ES COMPUTABLE ───────────────────────────────────────────────────────
//
// La única banda que aprende es HUELLA, y el aprendizaje son CONTADORES sobre reacciones que ya se
// registran —nunca un juicio del modelo sobre sí mismo. Unidad: el par `huella:<campo>`. Dos
// señales, las dos gratis y las dos generadas por él: promoción si PREGUNTÓ por ese tema ≥3 veces en
// 14 días, degradación si `corrige`/`insiste` o si salió 10 veces sin una respuesta ESTANDO
// despierto. Consecuencia honesta: la tabla arranca VACÍA, cero huella sale el día 1, y puede tardar
// semanas en promover algo. Eso no es una falla del diseño, es el tamaño real de la evidencia.
//
// NO se construye exploración ("mandá una huella por día para tener muestra"): sería reintroducir el
// ruido para alimentar la tabla.
//
// EL CIERRE DE UNA PROMESA NO PASA POR ACÁ. Lo manda quien cablea, en su propio hilo, y su freno
// vive en promesas.ts. Una respuesta dentro de un hilo no suena el canal: no compite con esto.

import { anteponerHechoVinculante } from "./acciones-agente.ts";
import { TECHO_DURO_POR_DOMINIO } from "../../../warmup-engine/src/domain/decision-diaria.ts";
import { MIN_VECES } from "./memoria-conversacion.ts";
import type { HechosWarmup } from "./warmup-monitor.ts";

// ── LOS TIPOS DEL CRITERIO ───────────────────────────────────────────────────────────────────────

/** Las tres clases que INTERRUMPEN, más la que no. `huella` no está en `REGLAS`: es todo lo demás. */
export type Clase = "dano" | "ceguera" | "decision" | "huella";

/**
 * LAS LLAVES QUE TIENE EL JEFE Y NO TIENE EL AGENTE. Salen del log real, no de la imaginación.
 *
 * El plan las enumeró como seis y después le dio a `dec5-toque-de-infra` una séptima
 * (`revertir-la-mano`). Se declara la séptima en vez de forzar a dec5 dentro de una de las seis:
 * una regla mal rotulada rompe justamente el gate anti-círculo, que es "cada regla nombra la
 * decisión concreta que él toma al leerla".
 *
 * `arreglar-el-nodo` es la llave más ancha a propósito: cubre "andá a arreglar la máquina que
 * hace falta" — sea un nodo SMTP, sea el host del modelo cuando el agente quedó ciego.
 */
export type LlaveDecision =
  | "levantar-pausa-emisor"
  | "autorizar-soltar"
  | "bajar-o-retirar-nodo"
  | "bajar-cap-del-nodo"
  | "arreglar-el-nodo"
  | "kill-switch"
  | "revertir-la-mano";

/** Un cambio entre las dos últimas lecturas verificadas. Es la unidad de "huella". */
export interface Novedad {
  /** La clave del mapa de campos observables, ej. `plan:corpfiling-infra.com.diaN`. */
  clave: string;
  /** El dominio, cuando el campo es de un dominio. `""` para los globales (cap./flota.). */
  objeto: string;
  antes: string | number | null;
  despues: string | number | null;
}

/**
 * LO QUE MIDE EL LOTE 3 Y LEEN LAS REGLAS d2/d4/c3/c4.
 *
 * Se declara ACÁ y no dentro de `HechosWarmup` a propósito: `warmup-monitor.ts` es de otro lote y
 * tocarlo abriría un conflicto por un tipo. Los tres campos son OPCIONALES, y mientras estén
 * ausentes el predicado da falso y el resultado es SILENCIO — nunca un "está limpio". Es la lección
 * más cara del sistema: el 2026-07-25 había 38 nodos cerrados en Gmail con CERO detecciones de
 * blacklist, y alguien leyó ese cero como "está limpio".
 */
export interface ReputacionDominio {
  dominio: string;
  ip?: string | null;
  /**
   * Las listas negras donde figura. `"no-se"` cuando la consulta falló: NO MEDIDO Y CERO NO SON LO
   * MISMO. El 2026-08-07T09:23Z `revisar_reputacion` devolvió textual "no pude consultar las listas
   * negras… No sé si está listado" sobre annualfiling-infra.com y ese resultado no llegó a ningún
   * lado. Un array vacío acá sería la mentira de "limpio".
   */
  listas: readonly string[] | "no-se";
  /**
   * `true` cuando el "no sé" es DECISIÓN NUESTRA: se acabó el presupuesto de consultas del barrido
   * y a este dominio no se le preguntó. Distinto de "pregunté y falló", y la diferencia es la que
   * hace usable a la regla c3: con `PRESUPUESTO_LISTAS_POR_BARRIDO = 25` sobre 58 dominios, 33
   * filas nacen en "no-se" TODOS LOS DÍAS por diseño, y c3 —que se dispara con cualquier "no sé"—
   * quedaba permanentemente verdadera: ~4 mensajes diarios, para siempre, sobre una ceguera que
   * elegimos nosotros y que no cambia ninguna decisión del jefe.
   */
  porPresupuesto?: boolean;
  /** Cómo trata el receptor a esa IP hoy: `"cerrado"` es la señal que se cruza con las listas. */
  receptor?: string | null;
  /**
   * LAS TRES SEÑALES DE AUTENTICACIÓN, que el barrido YA MIDE y que nadie leía.
   *
   * `barrerReputacion` escribe spf/dkim/dmarc/ptr/tls por dominio desde hace días (reputacion.ts:396)
   * y este tipo declaraba sólo `listas`, así que el archivo traía el dato y ninguna regla lo miraba.
   * Medido sobre el archivo de producción del 2026-08-07 (66 dominios): DOS filas en "mal" —
   * corpfiling-ops.com con `ptr: "193.180.211.182 no tiene PTR"` y nfcfilings.com con
   * `spf: "el dominio no publica SPF"`— y nadie lo dijo nunca en el canal.
   *
   * Van OPCIONALES, como el resto: sin el campo el predicado da falso y el resultado es SILENCIO,
   * jamás "la autenticación está bien". Es la misma disciplina que `listas`.
   *
   * DMARC y TLS quedan AFUERA a propósito. `dmarc` en "mal" es una decisión de política (p=none
   * frente a p=quarantine) y no rompe la entrega del primer correo; `tls` está en "no-se" en los 66
   * dominios del archivo real porque el llamador nunca le pasa la sonda, así que una regla sobre él
   * no podría dispararse nunca — prometer una vigilancia que el dato no puede sostener es
   * exactamente lo que este repo ya pagó cuatro veces.
   */
  spf?: { estado?: string; detalle?: string } | null;
  dkim?: { estado?: string; detalle?: string } | null;
  ptr?: { estado?: string; detalle?: string } | null;
  medidoEn?: string | null;
}

/** `HechosWarmup` más lo que llena el lote 3. Todo opcional: sin eso, silencio. */
export type HechosParaReglas = HechosWarmup & {
  /**
   * LOS DOS NÚMEROS VIAJAN JUNTOS, y no es adorno. Con la lista de nombres sola, d2 decía "tiene el
   * cupo del nodo por encima del techo que aguanta el dominio" — y eso produjo textual el "No
   * entiendo, es decir ?" del 2026-08-06T21:15. Los números son 15.000 (lo cableado en el nodo) y
   * 2.000 (el techo por dominio), y sin ellos el mensaje no se puede accionar.
   */
  cap?: { porEncimaDelTecho?: readonly { dominio: string; cap: number }[] | null } | null;
  flota?: {
    /**
     * ¿El veredicto de salud se calculó con correo NUESTRO? Hoy las 58 bandejas están en
     * `atribucion.modo === "todo"`, así que un guard que marque esos dominios como no-accionables
     * deja al agente SIN MANOS. Entra como DATO (regla c4: "estoy juzgando salud con correo que no
     * es nuestro"), nunca como gate.
     */
    atribuido?: boolean | null;
  } | null;
  reputacion?: readonly ReputacionDominio[] | null;
};

export interface EstadoParaSlack {
  /** El estado del emisor: send | placement-pause | killed | cap-reached | inert. */
  emisor: string | null;
  /** Las acciones que decidió esta vuelta, con si se ejecutaron. */
  /** `reintentable` = falló por algo que se arregla solo (SSH caído, Postgres reiniciando). */
  acciones: Array<{ accion: string; objetivo?: string | null; ejecutada: boolean; reintentable?: boolean; detalle: string }>;
  /** Reparos de la verificación: si los hay, el agente dijo algo que no se sostiene. */
  reparos: string[];
  /** Por qué no hubo lectura, si no la hubo. */
  sinLectura: string | null;
  /** Su voz: la frase con la que hablaría. NO la usa ninguna regla — ver el bloque de la voz. */
  voz: string | null;
  /** Las cuatro líneas verificadas, por si hay que dar contexto. */
  ahora: string | null;
  /** Lo llena el orquestador y no lo lee ninguna regla. Se deja por compatibilidad del contrato. */
  riesgo: string | null;
  /**
   * Lo que CAMBIÓ en la fábrica desde la vuelta anterior. Lo calcula el orquestador con
   * `novedades(camposObservables(hechosPrevios), camposObservables(hechosAhora))`.
   */
  novedades?: readonly Novedad[];
  /**
   * EL RETRATO ENTERO DE LA FÁBRICA. Es el campo que convierte a las reglas en predicados sobre
   * hechos en vez de sobre diez campos planos. OPCIONAL: el orquestador ya lo tiene en la mano y
   * mientras no lo pase, las reglas que lo necesitan dan falso y el resultado es silencio.
   */
  hechos?: HechosParaReglas | null;
  /**
   * LOS DOS CAMPOS DE ABAJO LOS COMPLETA `decidirSiHablar`, no quien cablea. Están en el tipo
   * porque los predicados son puros sobre `EstadoParaSlack` y necesitan el reloj y los contadores
   * de persistencia como HECHOS; pedírselos al orquestador sería pedirle que fabrique estado.
   */
  ahoraISO?: string;
  /** Cuántas vueltas SEGUIDAS lleva sin una lectura utilizable, contando esta. */
  vueltasSinLecturaUtil?: number;
  /** Cuántas vueltas SEGUIDAS lleva el emisor sin estar en `send`, contando esta. */
  vueltasEmisorFrenado?: number;
}

export interface MemoriaSlack {
  /** El último estado del emisor sobre el que se habló. */
  ultimoEmisor: string | null;
  /** Cuándo se mandó el último mensaje (ISO). */
  ultimoAviso: string | null;
  /** Hash simple de lo último dicho, para no repetir la misma frase. */
  ultimaFirma: string | null;
  /**
   * Los tres campos del presupuesto de avances. OPCIONALES a propósito: el warmup-slack.json que
   * hay en producción no los tiene, y si fueran obligatorios el primer despliegue leería una
   * memoria "inválida" y el agente se olvidaría del último emisor — o sea, anunciaría un cambio
   * del emisor que no ocurrió, en su primer mensaje.
   */
  avancesHoy?: number;
  /** Día UTC (YYYY-MM-DD) al que corresponde `avancesHoy`. Si no es hoy, el contador vale 0. */
  diaAvances?: string;
  /**
   * Cuándo se habló por última vez de CADA clave (clave → ISO). Guarda dos familias:
   *   · las claves de huella (`placement:x.com`), con enfriamiento de `MINUTOS_ENTRE_AVANCES`.
   *   · las reglas (`regla:c2-medicion-vencida:`), con enfriamiento de `HORAS_PARA_REPETIR`.
   *
   * Era un solo slot con identidad `clave=valorNuevo`, y contra un valor que OSCILA nunca coincidía
   * con el anterior: A→B→A→B no deduplica nada. Simulado con `cap.frenados` oscilando 8↔7: 20
   * mensajes en 24 h. Por clave y con enfriamiento, un flap da 1 mensaje por hora en vez de 1 por
   * vuelta.
   */
  novedadesRecientes?: Record<string, string>;
  /** Vueltas seguidas sin lectura utilizable. Lo mantiene `recordarAviso`; lo lee la regla c1. */
  vueltasSinLecturaUtil?: number;
  /** Vueltas seguidas con el emisor fuera de `send`. Lo mantiene `recordarAviso`; lo lee dec1. */
  vueltasEmisorFrenado?: number;
  /**
   * LA FIRMA DEL HECHO que ya se dijo, por regla (`id → firma`). Sólo para las reglas que declaran
   * `firmaDelHecho`, y existe porque el enfriamiento por RELOJ es la herramienta equivocada para un
   * estado PERMANENTE.
   *
   * Medido con un replay de 24 h sobre los hechos de producción: `c4-veredicto-sin-atribuir` y
   * `d2-cerca-con-cap-alto` daban verdadero en 135 de 135 vueltas, o sea 4 mensajes por día CADA
   * DÍA, byte a byte iguales, sobre condiciones que no se mueven solas (las 58 bandejas están en
   * `atribucion.modo: todo`; el cap de 15.000 sigue puesto hasta que alguien corra `limite-fisico`).
   * Un estado permanente dicho cada 6 horas es exactamente cómo se entrena a ignorar el canal.
   */
  dichoPorRegla?: Record<string, string>;
}

export interface Aviso {
  /** El texto que va a Slack. Corto: una o dos líneas. */
  texto: string;
  /** Por qué se habla. Va al log, no a Slack. */
  motivo: string;
  /** true si necesita que un humano conteste. */
  pideRespuesta: boolean;
  /**
   * LA CLASE. Es lo que decide si el mensaje pasa por el modelo: `huella` sí, las otras tres nunca.
   * No es opcional — un `Aviso` sin clase no se puede auditar ni tapar por el motivo correcto.
   */
  clase: Clase;
  /**
   * EL ID DE LA REGLA que lo produjo. `esRegla(regla)` tiene que dar true o el aviso no sale
   * (fail-closed, con test exhaustivo). Para la huella es `huella:<campo>`.
   */
  regla: string;
  /** La llave que el jefe usa al leerlo. `null` solo para la huella, que no pide ninguna llave. */
  decision: LlaveDecision | null;
  /**
   * Qué se guarda como "esto ya lo dije". Por defecto es la firma del estado; las reglas la
   * etiquetan con su id para no pisarse entre sí.
   */
  firma?: string;
  /**
   * La firma del HECHO, para las reglas de estado permanente. `recordarAviso` la guarda y
   * `decidirSiHablar` calla mientras no cambie. Ver `MemoriaSlack.dichoPorRegla`.
   */
  firmaDelHecho?: string;
  /**
   * TODAS las reglas que hablaron en este mensaje, la que ganó primero. Normalmente es una sola; son
   * varias cuando hay MÁS DE UN DAÑO en la misma vuelta (ver `decidirSiHablar`). `recordarAviso` las
   * enfría a todas: sin esto, la que viajó de acompañante volvería a hablar sola en la vuelta
   * siguiente diciendo lo mismo.
   */
  reglas?: readonly { id: string; firmaDelHecho?: string }[];
  /**
   * La clave de la huella que va en este mensaje. La lee `recordarAviso` para cobrar el presupuesto
   * y anotar el enfriamiento.
   */
  avance?: string;
  /**
   * ¿Este texto tiene que pasar por el modelo antes de salir? Solo la huella promovida. El
   * orquestador, si el modelo está caído o si `revisarRespuesta` marca un número inventado, lo
   * DESCARTA y lo cuenta (`tapado=modelo-caido` / `tapado=voz-inventada`). Una sola regla, sin rama
   * de fallback: un avance con un número inventado es peor que no mandarlo.
   */
  porElModelo: boolean;
}

/** Por qué NO salió algo que existía. Un canal donde no se puede saber cuánto se calló no se calibra. */
export interface Tapado {
  /** `sin-cambio` = la condición sigue verdadera pero el HECHO es el mismo que ya se dijo. */
  /**
   * `otra-regla-gano` = la regla dio verdadero, pasó todas las puertas, y aun así no salió porque
   * otra de la misma vuelta ocupó el mensaje. Antes esto era INVISIBLE: `loQueSeCallo` cortaba en la
   * primera que matcheaba, así que un DAÑO tapado por otro DAÑO no aparecía en ningún lado y
   * `sentinel-audit` lo contaba de menos. Un canal donde no se puede saber cuánto se calló no se
   * calibra, y menos si lo que se calla es la mitad B del encargo.
   */
  motivo:
    | "presupuesto"
    | "enfriamiento"
    | "sin-cambio"
    | "clase-huella"
    | "sin-plantilla"
    | "sombra"
    | "regla-gana"
    | "otra-regla-gano";
  clave: string;
  /** Lo que habría dicho, cuando se puede saber. Para el renglón de sombra del log. */
  texto?: string;
}

// Los textos NO empiezan con "Juanes,": la mención <@ID> se agrega afuera (es la que hace sonar
// el móvil) y la voz del modelo ya lo nombra. Con las tres cosas juntas salía "Juanes, hice esto:
// X. Juanes, mirá...", que es como habla un robot, no una persona.

/**
 * Cada cuánto se REPITE un aviso sobre una condición que sigue igual (el modelo caído, el emisor
 * frenado). Una vez por turno de sueño: ni 48 mensajes idénticos antes del desayuno, ni un silencio
 * eterno sobre algo que sigue roto.
 */
const HORAS_PARA_REPETIR = 6;

/**
 * Cuánto vale una medición del cupo antes de ser "no sé". Sale del incidente medido: la medición del
 * cupo vence a las 12 h y la Mac se duerme, así que un dato de ayer leído como de hoy es el modo de
 * falla normal, no el raro.
 */
const HORAS_MEDICION_VIGENTE = 12;

/**
 * Cuántas horas sin un solo correo hacen falta para decir que la fábrica está parada. El daemon da
 * una vuelta cada 90 minutos, así que 3 h son dos vueltas perdidas: ya no es un tropiezo.
 */
const HORAS_SIN_ENVIAR = 3;

function firma(e: EstadoParaSlack): string {
  return [e.emisor, e.acciones.map((a) => `${a.accion}:${a.objetivo ?? ""}:${a.ejecutada}`).join(","), e.sinLectura ? "sin-lectura" : ""].join("|");
}

// ── LOS CAMPOS OBSERVABLES ───────────────────────────────────────────────────────────────────────
//
// El vocabulario compartido: un mapa plano de (clave → valor) sobre el que se hace un diff. NO SE
// BORRA con el criterio nuevo — sigue siendo el vocabulario del diff, alimenta al panel y es la
// unidad del aprendizaje— pero toda novedad que sale de acá nace con clase HUELLA y no sale sola.
//
// La lista es cerrada por construcción, no por un filtro: un campo que no está en este mapa NO
// PUEDE producir novedad, pase lo que pase con los hechos.

/**
 * Lo que se escribe en `plan:<dominio>.enPool`. SE COMPARA CONTRA ESTA CONSTANTE, nunca contra un
 * literal escrito a mano.
 *
 * EL BUG QUE MATA: acá se escribía `"si"` y `fraseHumana` comparaba contra `"sí"` — con acento. Como
 * nunca coincidían, un dominio que RECUPERA cupo (rango 0 en `PRIORIDAD`, o sea el mensaje que gana
 * la vuelta) se anunciaba textualmente como "X dejó de calentar", justo al revés. Un número, no una
 * palabra, y la comparación contra la misma constante: la clase entera de bug desaparece.
 *
 * Migración: los retratos que hay en producción tienen `"si"`/`"no"`. En la primera vuelta después
 * del despliegue cada dominio produce una novedad `si`→`1`. No sale ninguna: la tabla de relevancia
 * arranca vacía y la huella no sale sola.
 */
const EN_POOL = 1;
const FUERA_DEL_POOL = 0;

/**
 * El retrato de la fábrica reducido a lo que vale la pena observar. Puro.
 *
 * `previos` ES EL RETRATO QUE SE GUARDÓ EN DISCO LA VUELTA PASADA — el valor que devolvió esta
 * misma función y que quien cablea persistió. **No** es `camposObservables(hechosPrevios, {})`.
 * Recalcularlo desde los hechos anteriores lo deja sin el arrastre y devuelve el agujero entero:
 *
 * `hechos.vueltas` sale de una query `LIMIT 8` sobre los ciclos GLOBALES del warmup. Con 6 dominios
 * y ~14 ciclos por día, la fila de un dominio se cae de esa ventana en horas y su clave
 * `placement:` DESAPARECE del retrato. Sin arrastre, cuando vuelve a medir la clave REAPARECE: hoy
 * eso es SILENCIO (`novedades` no cuenta las claves que aparecen), o sea que se pierde el SPAM→INBOX
 * de un dominio que él mismo midió 18 h antes.
 *
 * Y no alcanza con cablearlo bien una vez: el proceso se reinició 17 veces en 29 h, así que un mapa
 * que solo vive en memoria vuelve a arrancar vacío. Va en disco, en la misma vuelta que los hechos.
 */
export function camposObservables(
  hechos: HechosWarmup | null,
  previos: Record<string, string | number | null>
): Record<string, string | number | null> {
  const m: Record<string, string | number | null> = {};
  // ARRASTRE. Solo dos claves, y las dos por el mismo motivo: su fuente puede desaparecer sin que el
  // hecho haya desaparecido.
  //  · `placement:` — la ventana LIMIT 8 evicta al dominio que mide menos seguido.
  //  · `flota.cruzados` — si `readInventoryJson` falla una vuelta, `hechos.flota` viene null y la
  //    lista de cruzados se borra del retrato. CRUZAR EL UMBRAL PERMANENTE DE GMAIL ES
  //    IRREVERSIBLE: sin arrastre, un cruce que ocurre en la vuelta de la lectura fallida se pierde
  //    PARA SIEMPRE. Un aviso tarde le gana a ninguno.
  // Las demás claves salen del plan y del inventario, que traen SIEMPRE la fila de cada dominio: si
  // una falta es porque la lectura se cayó, y arrastrarla daría por vigente un dato que nadie leyó.
  for (const [k, v] of Object.entries(previos ?? {})) if (k.startsWith("placement:") || k === "flota.cruzados") m[k] = v;
  if (!hechos) return m;

  for (const p of hechos.plan ?? []) {
    m[`plan:${p.dominio}.accion`] = p.accion;
    m[`plan:${p.dominio}.diaN`] = p.diaN;
    // `enPool` sale del CUPO, no de estar en la lista: `decidirCupoDeHoy` deja al dominio en el
    // plan con cupo 0 y acción "frenar" cuando el nodo está frenado en Postfix. O sea que "se
    // soltó" y "dejó de calentar" se leen acá, y no en la desaparición de una fila.
    m[`plan:${p.dominio}.enPool`] = p.cupo > 0 ? EN_POOL : FUERA_DEL_POOL;
    // NO SE OBSERVA `placementMuestra`, y es a propósito. Es `placements.length`: un contador
    // MONÓTONO que sube con cada medición (~14/día, el techo del daemon) y que además es el
    // denominador de un avance, no un avance. Contra el retrato real de producción: 6 de 32 claves.
  }

  // EL PLACEMENT NO ENTRA CORREO POR CORREO: entra la medición MÁS RECIENTE de cada dominio, así
  // que dos INBOX seguidos son el mismo valor y no hablan dos veces.
  //
  // `placement: null` se SALTEA. Una vuelta sin placement es "todavía no se midió", y no medido no
  // es cero: escribirlo como valor haría que la primera medición real se leyera como un cambio
  // desde un dato que nunca existió.
  const masReciente = new Map<string, number>();
  for (const v of hechos.vueltas ?? []) {
    if (!v.placement) continue;
    const t = Date.parse(v.cuando);
    const cuando = Number.isFinite(t) ? t : 0;
    const previa = masReciente.get(v.dominio);
    if (previa !== undefined && cuando <= previa) continue;
    masReciente.set(v.dominio, cuando);
    m[`placement:${v.dominio}`] = v.placement;
  }

  // `frenados` es opcional en HechosWarmup: si no viene, NO se escribe 0. Un `?? 0` acá diría
  // "cero dominios frenados" sobre un dato que nadie midió, que es la confusión más cara del
  // sistema (el 2026-07-25, 38 nodos cerrados en Gmail con CERO detecciones de blacklist, y
  // alguien leyó ese cero como "está limpio").
  if (hechos.cap && Array.isArray(hechos.cap.frenados)) m["cap.frenados"] = hechos.cap.frenados.length;
  if (hechos.flota) {
    m["flota.sanas"] = hechos.flota.sanas;
    m["flota.bloqueadas"] = hechos.flota.bloqueadas;
    // COMO LISTA, NO COMO CONTADOR. Cruzar el umbral permanente es POR DOMINIO y es irreversible:
    // con un contador, un dominio que cruza y otro que se saca del inventario se cancelan y el
    // aviso no sale nunca. Ordenada para que el diff no dispare por el orden de la query.
    m["flota.cruzados"] = [...(hechos.flota.cruzados ?? [])].sort().join(",");
  }
  return m;
}

/**
 * LA CLAVE DEL RETRATO, DICHA COMO SE DICE. `placement:filing-ops.com` → "el placement de
 * filing-ops.com"; `cap.frenados` → "los dominios frenados".
 *
 * Existe exportada porque `promesas.ts` armaba sus líneas con la clave CRUDA y le mandaba al jefe
 * "placement:filing-ops.com pasó de sin medir a INBOX" — la clave de máquina, en el canal, en el
 * estreno de esa función. El mapa `ETIQUETA` ya estaba escrito acá y a un import de distancia.
 *
 * Sin plantilla cae al OBJETO pelado (el dominio) y no a la clave: un campo que nadie tradujo se
 * dice a medias, no en jerga.
 */
export function claveLegible(clave: string): string {
  const { campo, objeto } = parteClave(clave);
  const etiqueta = ETIQUETA[campo];
  if (etiqueta === undefined) return objeto || clave;
  return objeto ? `${etiqueta} de ${objeto}` : etiqueta;
}

/** Separa la clave en (campo legible, objeto). Los dominios tienen puntos: por eso no se parte por el primero. */
function parteClave(clave: string): { campo: string; objeto: string } {
  // `placement:` no lleva sufijo de campo, y partir por el último punto le comería el TLD
  // ("placement.com" de dominio "corpfiling-infra"). Caso aparte y explícito.
  if (clave.startsWith("placement:")) return { campo: "placement", objeto: clave.slice("placement:".length) };
  const i = clave.indexOf(":");
  if (i < 0) return { campo: clave, objeto: "" };
  const resto = clave.slice(i + 1);
  const j = resto.lastIndexOf(".");
  if (j < 0) return { campo: clave.slice(0, i), objeto: resto };
  return { campo: `${clave.slice(0, i)}.${resto.slice(j + 1)}`, objeto: resto.slice(0, j) };
}

/**
 * Qué cambió entre las dos últimas lecturas. Puro: es un diff de dos mapas, y por eso todo aviso
 * de huella se puede RECALCULAR después desde los snapshots guardados.
 */
export function novedades(
  previos: Record<string, string | number | null>,
  ahora: Record<string, string | number | null>
): Novedad[] {
  // MAPA PREVIO VACÍO = SILENCIO. Es el fail-closed: en una instalación fresca (o si el snapshot
  // anterior no se pudo leer) TODO sería "nuevo" y el agente abriría con treinta avisos.
  if (Object.keys(previos).length === 0) return [];

  const out: Novedad[] = [];
  for (const [clave, despues] of Object.entries(ahora)) {
    // UNA CLAVE QUE APARECE NUNCA ES NOVEDAD. Aparecer casi siempre significa que la lectura
    // ANTERIOR falló, no que pasó algo: en el orquestador `plan` sale de
    // `planDelDia(...).catch(() => undefined)` y `cap`/`flota` de `readInventoryJson(...).catch(()
    // => null)`, así que un tropiezo borra la sección entera y al volver declararía 24 "avances".
    //
    // El arrastre de `camposObservables(hechos, previos)` tapa el agujero de `placement:` y de
    // `flota.cruzados` **si y solo si** quien cablea persiste el retrato en vez de recalcularlo.
    // Esta línea hace que el precio de NO persistirlo sea silencio y no una mentira.
    if (!Object.prototype.hasOwnProperty.call(previos, clave)) continue;
    const antes = previos[clave] ?? null;
    if (antes === despues) continue;
    const { objeto } = parteClave(clave);
    out.push({ clave, objeto, antes, despues: despues ?? null });
  }
  // Una clave que DESAPARECE nunca es novedad, por el mismo motivo simétrico: el modo de falla más
  // probable es que no se pudo leer, y "no lo pude leer" ya tiene su propia regla (c1).
  return out;
}

// ── EL PRESUPUESTO DE HUELLA ─────────────────────────────────────────────────────────────────────

/** Una huella por vuelta. El resto se cuenta y sale en la misma línea, nunca en silencio. */
const MAX_AVANCES_POR_VUELTA = 1;
/**
 * Tope diario. Sale de la tasa medida (10 avances en 21,6 h sobre 28 snapshots reales) y del techo
 * físico: el daemon no puede pasar de 14 vueltas por día y hay 6 dominios en el pool. Va en CÓDIGO
 * y no en config a propósito: un tope de ruido que se puede subir por variable de entorno a las
 * 3am deja de ser un tope. NUNCA aplica a `dano`/`ceguera`/`decision` — hay test.
 */
const MAX_AVANCES_POR_DIA = 10;
/**
 * Cuánto tiene que pasar para volver a hablar de LA MISMA CLAVE de huella, aunque el valor sea otro.
 * Simulado con `cap.frenados` yendo 8↔7 cada 10 minutos: 20 mensajes en 24 h. Una hora de
 * enfriamiento lo baja a 1 por hora sin tocar el caso normal.
 */
const MINUTOS_ENTRE_AVANCES_MISMA_CLAVE = 60;

/** Orden de importancia de la huella. Sale la de más arriba; las demás se cuentan. */
const PRIORIDAD: readonly RegExp[] = [
  /^(cap\.frenados|plan:.+\.enPool)$/, // un dominio que se soltó o dejó de calentar
  /^placement:/,
  /^plan:.+\.accion$/,
  /^plan:.+\.diaN$/,
  /^flota\./
];

/** Dónde cae el correo cuando la noticia es MALA. `OTHER` no entra: es ambiguo y no se sabe leer. */
const PLACEMENT_MALO = new Set(["SPAM", "MISSING"]);

function rango(n: Novedad): number {
  // UNA CAÍDA VA PRIMERO, aunque sea del mismo campo que una mejora. Con el orden por clave sola,
  // un dominio que se cae de INBOX a SPAM competía con `cap.frenados` y PERDÍA.
  if (n.clave.startsWith("placement:") && PLACEMENT_MALO.has(String(n.despues))) return -1;
  const i = PRIORIDAD.findIndex((re) => re.test(n.clave));
  return i < 0 ? PRIORIDAD.length : i;
}

const PREFIJO_NOVEDAD = "novedad|";

function diaUTC(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

/**
 * ¿Ya se habló de esta clave hace menos de `minutos`?
 *
 * Un reloj ilegible NO enfría: fail-open a propósito. Un `ahoraISO` que no parsea significa que el
 * sistema está roto de otra forma; callar por eso sería reproducir el régimen mudo por un error de
 * formato.
 */
function enfriando(recientes: Record<string, string> | undefined, clave: string, ahoraISO: string, minutos = MINUTOS_ENTRE_AVANCES_MISMA_CLAVE): boolean {
  const t = Date.parse(recientes?.[clave] ?? "");
  const ahora = Date.parse(ahoraISO);
  if (!Number.isFinite(t) || !Number.isFinite(ahora)) return false;
  return ahora - t < minutos * 60_000;
}

/**
 * Cuál de las huellas sale y cuántas quedan tapadas. Se exporta para que el orquestador pueda
 * LOGUEAR los tapados: si no, "no sale" sería "se perdió en silencio", que es justo lo que no
 * queremos poder decir del canal.
 */
export function presupuestoDeAvances(
  novs: readonly Novedad[],
  memoria: MemoriaSlack | null,
  ahoraISO: string
): { elegida: Novedad | null; tapados: number } {
  const dia = diaUTC(ahoraISO);
  const yaHoy = memoria?.diaAvances === dia ? (memoria.avancesHoy ?? 0) : 0;
  // SIN PLANTILLA NO SE ANUNCIA. Antes caía al fallback con flecha —"el campo X de Y: a → b."— que
  // es exactamente el texto de máquina que hay que matar, y encima sobre un campo que nadie pensó.
  // Se descarta acá, en el único embudo, para que no gane la vuelta y después no produzca nada.
  const conPlantilla = novs.filter((n) => tienePlantilla(n));
  // DEDUPE POR CLAVE Y CON ENFRIAMIENTO, no por `clave=valor`. Contra un valor que OSCILA,
  // `clave=valor` nunca coincide con el anterior y no deduplica nada.
  const frescas = conPlantilla.filter((n) => !enfriando(memoria?.novedadesRecientes, n.clave, ahoraISO));
  if (frescas.length === 0) return { elegida: null, tapados: 0 };
  if (yaHoy >= MAX_AVANCES_POR_DIA) return { elegida: null, tapados: frescas.length };
  const orden = [...frescas].sort((a, b) => rango(a) - rango(b));
  return { elegida: orden[0] ?? null, tapados: Math.max(0, orden.length - MAX_AVANCES_POR_VUELTA) };
}

const ETIQUETA: Record<string, string> = {
  placement: "el placement",
  "plan.accion": "el plan",
  "plan.diaN": "el día de rampa",
  "plan.enPool": "el calentamiento",
  "cap.frenados": "los dominios frenados",
  "flota.sanas": "las bandejas sanas",
  "flota.bloqueadas": "las bandejas bloqueadas"
};

/** `null` se escribe "sin medir", NUNCA 0. No medido y cero no son lo mismo. */
const valorLegible = (v: string | number | null): string => (v === null ? "sin medir" : String(v));

/**
 * LA MISMA VERDAD, DICHA COMO LA DIRÍA UNA PERSONA.
 *
 * El texto de una huella era la tupla cruda: "el placement de opscorpfiling.com: SPAM → INBOX.".
 * Correcto, concreto, imposible de alucinar… y escrito como una línea de log.
 *
 * Devuelve `null` cuando no hay plantilla para ese campo, y eso NO se cae al fallback con flecha:
 * el campo huérfano se loguea y no se anuncia. El fallback era la puerta por la que volvía el texto
 * de máquina cada vez que alguien agregaba una clave al retrato.
 */
function fraseHumana(campo: string, objeto: string, antes: string, despues: string): string | null {
  const d = objeto || "la flota";

  if (campo === "placement") {
    if (despues === "INBOX" && antes === "SPAM") return `${d} entró en bandeja — venía cayendo en spam.`;
    if (despues === "SPAM" && antes === "INBOX") return `ojo con ${d}: se fue a spam, venía entrando en bandeja.`;
    if (despues === "INBOX") return `${d} está entrando en bandeja${antes === "sin medir" ? " — primera medición" : ""}.`;
    if (despues === "SPAM") return `${d} está cayendo en spam.`;
    // MISSING y OTHER no se disfrazan de nada: son "no llegó" y "no sé dónde cayó".
    if (despues === "MISSING") return `no encontré el correo de ${d} en la semilla: no llegó.`;
    return `el correo de ${d} cayó en ${despues.toLowerCase()}.`;
  }

  if (campo === "plan.accion") {
    if (despues === "subir") return `le subo el volumen a ${d}: viene bien.`;
    if (despues === "bajar") return `le bajo el volumen a ${d}.`;
    if (despues === "frenar") return `freno ${d}.`;
    if (despues === "arrancar") return `arranco con ${d}.`;
    return `${d} se queda como está por ahora.`;
  }

  if (campo === "plan.diaN") {
    // UN VALOR NO FINITO NO SE ANUNCIA. `diaN` es `number | null`: sin este guard salía
    // "X cumplió el día sin medir de calentamiento", que no significa nada.
    if (!Number.isFinite(Number(despues))) return null;
    return `${d} cumplió el día ${despues} de calentamiento.`;
  }

  if (campo === "plan.enPool") {
    // CONTRA LA CONSTANTE, NO CONTRA UN LITERAL. Ver `EN_POOL`: la comparación era contra "sí" con
    // acento y lo que se escribía era "si" sin acento, así que el dominio que RECUPERA cupo —el
    // mensaje que gana la vuelta— se anunciaba como "dejó de calentar".
    return String(despues) === String(EN_POOL) ? `${d} volvió a calentar.` : `${d} dejó de calentar.`;
  }

  if (campo === "cap.frenados") {
    const n = Number(despues);
    const m = Number(antes);
    if (!Number.isFinite(n) || !Number.isFinite(m)) return null;
    // LA RAMA QUE BAJA DECÍA LO CONTRARIO DE SU PROPIO NÚMERO. `cap.frenados` es la cantidad de
    // FRENADOS (`camposObservables`: `m["cap.frenados"] = hechos.cap.frenados.length`), así que
    // 8 → 7 es "se soltó UNO y quedan 7 frenados". Salía "ya son 7 los dominios sueltos que estaban
    // frenados": presentaba los 7 que SIGUEN frenados como los liberados — inflado 7×, y justo en la
    // dirección del volumen, que es la única irreversible. Y no era teórico: hay promesas abiertas
    // esperando exactamente esta clave, así que iba a disparar sola.
    // Los soltados se dicen por DIFERENCIA (`m - n`), que es lo único que el dato prueba.
    return n > m
      ? `quedaron ${n} dominios frenados (eran ${m}).`
      : `soltaron ${m - n}: quedan ${n} dominios frenados (eran ${m}).`;
  }

  if (campo === "flota.sanas") return `las bandejas sanas pasaron de ${antes} a ${despues}.`;
  if (campo === "flota.bloqueadas") return `las bandejas bloqueadas pasaron de ${antes} a ${despues}.`;

  // Sin plantilla propia NO se anuncia. `flota.cruzados` cae acá a propósito: no es huella, es la
  // regla d1, y tiene que salir por ahí o no salir.
  return null;
}

const tienePlantilla = (n: Novedad): boolean => {
  const { campo, objeto } = parteClave(n.clave);
  return fraseHumana(campo, objeto, valorLegible(n.antes), valorLegible(n.despues)) !== null;
};

// ── LA VOZ: MATAR EL TEXTO DE MÁQUINA GRAPADO AL FINAL DE UNA FRASE HUMANA ───────────────────────
//
// Textual del jefe: "esa manera o lexico de escribir esta muy bot del 2000… recuerdo que openclaw
// me respondia con asteriscos, muy horrible genericamente, y luego arreglamos eso".
//
// El vicio concreto era `${estado.voz} Hice esto: ${l}.` — una frase de persona con un
// identificador de código pegado atrás. Salía así en producción, textual del log:
//   "Voy a medir y diagnosticar los cercanos y los frenados para ver qué puedo soltar.
//    Hice esto: revisar_reputacion controlnationalcorp.com."
//
// LA REGLA: la acción va DENTRO de la oración o no va. Y para que la regla no dependa de la
// disciplina de quien escriba la próxima plantilla, se aplica en UN embudo: todo texto que
// devuelve `decidirSiHablar` pasa por `enCastellano`. Así el test de higiene es una consecuencia
// del código y no una promesa.

/** Cómo se DICE cada mano. Tres entradas: las tres que tocan la infraestructura. */
const COMO_SE_DICE: Record<string, (objetivo: string) => string> = {
  frenar_dominio: (o) => `le puse el cupo en 0 a ${o}`,
  soltar_dominio: (o) => `solté ${o} y volvió a calentar`,
  pausar_warmup: () => `paré el calentamiento entero: 0 correos hasta que lo levantes`
};

/** El enum del emisor, traducido. Salía crudo entre paréntesis: "El emisor se frenó (cap-reached)". */
const COMO_ESTA_EL_EMISOR: Record<string, string> = {
  "placement-pause": "frenado porque el placement viene mal",
  "cap-reached": "parado porque llegó al tope de vueltas del día",
  killed: "apagado con el kill switch",
  inert: "quieto porque no hay nada para mandar"
};

/**
 * EL EMBUDO DE LA VOZ. Saca lo que suena a máquina de cualquier texto, venga de una plantilla o de
 * un `detalle` crudo del ejecutor:
 *  · `snake_case` → palabras sueltas (el "revisar_reputacion" de la queja).
 *  · el prefijo `rechazada:` del ejecutor, que es texto de log y no de conversación.
 *  · comillas, asteriscos de énfasis y viñetas — el "openclaw me respondia con asteriscos".
 *  · la flecha `→`, que es notación de diff y no de castellano.
 */
export function enCastellano(texto: string): string {
  return texto
    .replace(/\brechazada:\s*/gi, "")
    .replace(/[*"`]/g, "")
    .replace(/\s*→\s*/g, " a ")
    .replace(/\b([\p{L}\d]+)(_[\p{L}\d_]+)\b/gu, (_m, a: string, b: string) => `${a} ${b.replace(/_/g, " ")}`)
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ── LA LISTA CERRADA ─────────────────────────────────────────────────────────────────────────────

/** Puro y SINCRÓNICO por firma: un predicado que llame a un modelo no compila. */
export type Predicado = (e: EstadoParaSlack) => boolean;

export interface Regla {
  id: string;
  clase: "dano" | "ceguera" | "decision";
  /** La llave que el jefe usa al leer este mensaje. Sin llave no hay regla. */
  decision: LlaveDecision;
  /**
   * EXENTA DE TODO: del presupuesto, del enfriamiento y del modelo. Solo d1: cruzar el umbral
   * permanente de Gmail es lo único irreversible del negocio y no admite "ya lo dije hace un rato".
   */
  siempre?: true;
  predicado: Predicado;
  texto: (e: EstadoParaSlack) => string;
  /** ¿Necesita que un humano conteste? Es lo que decide si suena el móvil. */
  pide?: true;
  /**
   * PARA LOS ESTADOS QUE NO SE MUEVEN SOLOS. Devuelve la firma del hecho; mientras sea la misma que
   * la última dicha, la regla CALLA — no a las 6 h, no nunca. Cuando el hecho cambia (entra o sale
   * un dominio, cambia el conteo), vuelve a hablar entera.
   *
   * Es la diferencia entre un evento y un estado: `dec1-emisor-pausado` describe algo que se
   * resuelve y volver a insistir cada 6 h tiene sentido; `d2` y `c4` describen configuraciones que
   * siguen igual hasta que alguien las cambia, y repetirlas es ruido con reloj.
   */
  firmaDelHecho?: (e: EstadoParaSlack) => string;
}

const horasDesde = (iso: string | null | undefined, ahoraISO: string | undefined): number | null => {
  const t = Date.parse(iso ?? "");
  const ahora = Date.parse(ahoraISO ?? "");
  if (!Number.isFinite(t) || !Number.isFinite(ahora)) return null;
  return (ahora - t) / 3_600_000;
};

/**
 * Cuántas horas van del día UTC. Es el reloj de los CUPOS DIARIOS de la fábrica, no un reloj más.
 *
 * `enviadosHoy` se cuenta contra `date_trunc('day', now(), 'UTC')` en plan-diario.ts, así que a las
 * 00:00 UTC todos los contadores vuelven a cero de golpe. Cualquier regla que mida "hace tanto que
 * no pasa nada" y la cruce con esos contadores tiene que saber dónde está ese corte, o va a leer el
 * silencio de ayer como un síntoma de hoy — que es exactamente lo que hizo dec4 el 2026-08-08 a las
 * 00:44 UTC, a 44 minutos del corte.
 *
 * UTC explícito y no la zona local: la Studio corre en UTC-4 y el jefe está en UTC-5, así que
 * "hoy" tiene tres respuestas distintas en esta casa. La única que decide algo es la de Postgres.
 *
 * Devuelve 0 si no hay hora: sin reloj no se afirma que pasó tiempo.
 */
const horasDelDiaUTC = (ahoraISO: string | undefined): number => {
  const ahora = Date.parse(ahoraISO ?? "");
  if (!Number.isFinite(ahora)) return 0;
  const d = new Date(ahora);
  return (ahora - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 3_600_000;
};

/** Los dominios que CRUZARON entre los dos retratos. Diferencia de conjuntos sobre la lista. */
function cruzadosNuevos(e: EstadoParaSlack): string[] {
  const n = (e.novedades ?? []).find((x) => x.clave === "flota.cruzados");
  if (!n) return [];
  const antes = new Set(String(n.antes ?? "").split(",").filter(Boolean));
  return String(n.despues ?? "")
    .split(",")
    .filter((d) => d && !antes.has(d));
}

/** Cuánto se movió una clave numérica entre los dos retratos. `null` si no se puede leer. */
function salto(e: EstadoParaSlack, clave: string): { antes: number; despues: number } | null {
  const n = (e.novedades ?? []).find((x) => x.clave === clave);
  if (!n) return null;
  const antes = Number(n.antes);
  const despues = Number(n.despues);
  return Number.isFinite(antes) && Number.isFinite(despues) ? { antes, despues } : null;
}

/** Las manos que TOCAN la infraestructura. LISTA BLANCA, no negra — ver el comentario de abajo. */
export const TOCAN: ReadonlySet<string> = new Set(["frenar_dominio", "soltar_dominio", "pausar_warmup"]);
// POR QUÉ SE DIO VUELTA. Era `CONTABLES`, una lista NEGRA de manos que no se anuncian. Con lista
// negra, cada mano NUEVA reabre la fuga por defecto: pasó tal cual con `revisar_reputacion`, la
// última que se agregó, y produjo 3 de los 11 mensajes del log ("Hice esto: revisar_reputacion
// corpannualinfra.com"). Con lista blanca, una mano nueva CALLA hasta que alguien decida lo
// contrario. MIRAR NO ES ACTUAR.

/** Un desliz del modelo no es una decisión del jefe. Ver la regla dec3. */
const errorPropio = (d: string): boolean =>
  /no es una acción permitida|no está en el inventario|toda acción exige un motivo/i.test(d);

/**
 * UNA MANO QUE NO HIZO NADA PORQUE NO HABÍA NADA QUE HACER NO ESTÁ TRABADA.
 *
 * Es el mismo incidente que dec3 dice existir para no repetir, entrando por la puerta de al lado.
 * `acciones-agente.ts` es idempotente en las tres manos que tocan infra y reporta el no-op con esta
 * frase textual (líneas 474, 573 y 647):
 *
 *   "bizreport-control.com ya estaba en cap 0: no hacía falta"
 *   "z.com ya está suelto (cap 20): no hacía falta"
 *   "el warmup ya estaba pausado: no hacía falta"
 *
 * Sin este filtro las tres salían como clase `decision` con `pide: true` —o sea con la mención que
 * le hace sonar el móvil— pidiéndole destrabar algo que no está trabado. Y la tercera además
 * AFIRMABA lo contrario del hecho: "Quedaron 0 frenos aplicados y sigue mandando" sobre un warmup
 * que ya estaba pausado. Es textual el "No entiendo, es decir ?" del 2026-08-06T21:15, subido de
 * categoría. El caso no es raro: hay 46 nodos en cap 0, así que `frenar_dominio` cae acá seguido.
 *
 * Y la mano DESHABILITADA POR FLAG tampoco: `WARMUP_AGENT_PUEDE_SOLTAR` y sus hermanas las apagó él
 * a propósito. Avisarle cada 6 h que su propia decisión sigue vigente no es una llave que él gire a
 * las 3 de la mañana; es el canal entrenándolo a ignorarlo.
 *
 * El candado del snapshot (`medicionDelCupoVigente` + AFIRMA_QUE_NO_PEGO) no las cubría: sólo
 * reescribe "sigue con cupo | no quedó puesto | no pegó | no se aplicó", y ninguna de estas frases
 * cae ahí.
 */
const noHaciaFalta = (d: string): boolean => /no hacía falta|ya estaba|ya está suelto/i.test(d);

/** La mano que falló y SÍ necesita a un humano: no reintentable, no un error suyo, y que toque algo. */
function manoTrabada(e: EstadoParaSlack, cuales: ReadonlySet<string>) {
  return e.acciones.find(
    (a) => !a.ejecutada && !a.reintentable && !errorPropio(a.detalle) && !noHaciaFalta(a.detalle) && cuales.has(a.accion)
  );
}

/**
 * LA MANO TRABADA ES UN ESTADO, NO UN EVENTO — mientras sea LA MISMA mano trabada por LA MISMA causa.
 *
 * El caso que lo pide: `frenar no está habilitado en este entorno` es un flag que él puso, y no se
 * mueve hasta que alguien lo cambie. Con el enfriamiento por reloj eso son cuatro mensajes idénticos
 * por día, para siempre, sobre una decisión que ya tomó — la forma exacta de entrenar a ignorar el
 * canal. Con la firma se dice UNA vez y vuelve a hablar cuando la mano o la causa cambian, que es
 * cuando hay algo nuevo que hacer. Mismo mecanismo que d2 y c4.
 */
const firmaDeLaMano = (a: { accion: string; objetivo?: string | null; detalle: string } | undefined): string =>
  a ? `${a.accion}:${a.objetivo ?? ""}:${a.detalle}` : "";

/**
 * ¿La última lectura DIRECTA del nodo sigue vigente? Es el candado anti-falsedad de dec3.
 *
 * Sin esto el agente AFIRMA sobre el snapshot: "bizreport-control.com sigue con cupo 255: el freno
 * no quedó puesto" — cuatro veces en producción sobre un freno que YA estaba puesto, porque el
 * `cap` que estaba mirando era de la medición anterior. "No medido" y "no pegó" no son lo mismo,
 * exactamente igual que "no medido" y "cero".
 */
const medicionDelCupoVigente = (e: EstadoParaSlack): boolean => {
  const h = horasDesde(e.hechos?.cap?.medidoEn ?? null, e.ahoraISO);
  return h !== null && h <= HORAS_MEDICION_VIGENTE;
};

/** Lo que el `detalle` del ejecutor afirma sobre el cupo del nodo, y que el snapshot no puede probar. */
const AFIRMA_QUE_NO_PEGO = /sigue con cupo[^.]*|no quedó puesto|no pegó|no se aplicó/gi;

/**
 * POR QUÉ NO PUDO, DICHO PARA UNA PERSONA. El `detalle` crudo NO SALE MÁS AL CANAL.
 *
 * La regla dec3 interpolaba `a.detalle` verbatim, y esa mano toca infraestructura: el mensaje va con
 * `pide: true`, o sea que le suena el móvil al jefe para leer un renglón de log. Textual de lo que
 * salió en producción: "no pude medirlo: connect ECONNREFUSED 127.0.0.1:5432", 'rechazada:
 * "medir_dominio_controlcontrolledger.com" no es una acción permitida'. Eso no es una frase de
 * persona: es un stack trace con un prefijo en castellano.
 *
 * Los cuatro motivos salen del log real del 2026-08-07, con su frecuencia medida ahí:
 *   · 26 — "rechazada: frenar no está habilitado en este entorno" (el flag lo puso él)
 *   ·  3 — "no pude medirlo: connect ECONNREFUSED 127.0.0.1:5432" (Postgres caído)
 *   ·      credencial y SSH, los dos modos de falla del camino al nodo
 * El dato exacto NO se pierde: sigue entero en runtime/logs/warmup-monitor.log, que es donde se
 * mira un error. Lo que cambia es qué le vibra el bolsillo a las 3 de la mañana.
 */
const MOTIVOS: readonly (readonly [RegExp, string])[] = [
  // Va PRIMERO por frecuencia y porque es el único que no es una falla: es una decisión suya.
  [/no est[áa] habilitad[oa]/i, "esa mano está apagada en este entorno"],
  // LOS DOS GUARDS PROPIOS DE `frenar_dominio`, que caían al default y salían MINTIENDO. Son 2 de
  // los 4 `detalle` reales de esa mano (acciones-agente.ts, los `rechazada:` de frenar), y el
  // default los describía como "el motivo es técnico": no lo es. El primero es una regla de negocio
  // —frenar un dominio sano cuesta calentamiento y lo decide el operador— y el segundo es no tener
  // el dato. Peor todavía, la frase completa terminaba en "Eso lo destrabas tú" sobre algo que no
  // está trabado. Antes de este lote el `detalle` crudo salía feo pero VERDADERO; la naturalidad se
  // comió la precisión, que es el péndulo que este archivo ya declara vigilar.
  [/lo decide el operador|dominio sano/i, "frenar un dominio sano no lo decido yo, lo decide el operador"],
  [/no s[eé] si .* tiene daño|no se pudo leer la medici[óo]n/i, "la medición de la flota no se pudo leer, así que no sé si tiene daño y no freno a ciegas"],
  [/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET|socket hang up|connect /i, "se me cayó la conexión con la máquina"],
  [/permission denied|authentication failed|credencial|credential|unauthorized|no autorizado|\b40[13]\b/i, "la credencial que uso no alcanza"],
  [/\bssh\b|host key|known.hosts|port 22/i, "no pude entrar al nodo por SSH"]
];

/**
 * El motivo legible de una mano que falló. Puro.
 *
 * El caso del cupo va PRIMERO y sale con su texto entero: "sigue con cupo 255: el freno no quedó
 * puesto" ya está escrito para una persona —lo escribimos nosotros— y el 255 es el dato que hace
 * accionable el mensaje. Se le respeta el candado anti-falsedad de siempre: si la medición directa
 * del nodo venció, la afirmación se cambia por un "no sé", que es lo que de verdad sabemos.
 *
 * NO SE USA `.test()` SOBRE `AFIRMA_QUE_NO_PEGO`: lleva la bandera `g`, así que arrastra `lastIndex`
 * y devuelve falso una llamada de cada dos sobre el MISMO texto. `replace` es idempotente y la
 * comparación contra el original hace de test sin ese estado escondido.
 *
 * EL REEMPLAZO ES UN ESPACIO Y NUNCA UN BYTE DE CONTROL, y esto costó por lo tonto que es: acá vivía
 * un `\0` LITERAL, así que `grep` clasificaba slack.ts entero como binario y lo salteaba EN SILENCIO.
 * El comando de aceptación del lote —el grep de voseo sobre este archivo— devolvía cero líneas por
 * ceguera y no por limpieza; `grep -n "EL CANAL" slack.ts` tampoco encontraba la línea 1. Toda
 * verificación por grep sobre el archivo que decide qué le llega al jefe estuvo muerta y nadie se
 * enteró. El `!==` contra el original es todo lo que hace falta: un centinela raro no aporta nada.
 * Lo fija `SIN BYTES DE CONTROL` en slack.test.ts, que barre el repo entero.
 */
export function porQueNoPudo(detalle: string, medicionVigente: boolean): string {
  const sinLaAfirmacion = detalle.replace(AFIRMA_QUE_NO_PEGO, " ");
  if (sinLaAfirmacion !== detalle) {
    return medicionVigente
      ? detalle
      : `no sé si quedó puesto, porque la última medición directa del nodo es de hace más de ${HORAS_MEDICION_VIGENTE} horas`;
  }
  // EL DEFAULT NO AFIRMA LA CAUSA. Decía "no pude y el motivo es técnico" y eso es una afirmación
  // que este código no puede sostener: cae acá todo lo que no matcheó, incluidas las reglas de
  // negocio del propio agente. Y repetía "no pude" dentro de "Quise frenar X y no pude: no pude…".
  return MOTIVOS.find(([re]) => re.test(detalle))?.[1] ?? "no pude, y el motivo quedó en el log";
}

/** El dominio de la primera reputación que cumple una condición. Para los textos de d4/c3. */
const reputacionDonde = (e: EstadoParaSlack, cond: (r: ReputacionDominio) => boolean): ReputacionDominio | undefined =>
  (e.hechos?.reputacion ?? []).find(cond);

const listado = (r: ReputacionDominio): boolean => Array.isArray(r.listas) && r.listas.length > 0;
const limpioPeroCerrado = (r: ReputacionDominio): boolean =>
  Array.isArray(r.listas) && r.listas.length === 0 && String(r.receptor ?? "").toLowerCase() === "cerrado";
/**
 * "PREGUNTÉ Y NO SÉ", que NO es "no pregunté".
 *
 * El barrido gasta 25 consultas de listas negras sobre 58 dominios, así que 33 filas salen en
 * `"no-se"` todos los días POR DISEÑO. Contar esas como ceguera hacía a c3 permanentemente
 * verdadera —4 mensajes diarios, para siempre, sobre algo que decidimos nosotros y que no cambia
 * ninguna decisión suya. La ceguera que sí interrumpe es la otra: fui a mirar y no pude.
 */
const noSeSiEstaListado = (r: ReputacionDominio): boolean => r.listas === "no-se" && r.porPresupuesto !== true;

/** Cuántas bandejas mide la flota hoy. `null` = no se leyó, que no es cero. */
const bandejas = (e: EstadoParaSlack): number | null => {
  const f = e.hechos?.flota;
  return f ? f.sanas + f.bloqueadas + f.atascadas : null;
};

/** 15000 → "15.000". Un número de cinco cifras sin separador se lee mal en el móvil. */
const miles = (n: number): string => n.toLocaleString("es-AR");

/**
 * Los nodos con el tope por encima del techo, marcando cuáles YA cruzaron el umbral permanente.
 *
 * El cruce se lee de `flota.cruzados`, que es la MISMA lista que alimenta a d1: no hay una fuente
 * nueva ni un campo nuevo que alguien tenga que acordarse de llenar. Lo único que cambió es que
 * `porEncimaDelTecho` dejó de ser ciega a los cruzados (ver node-daily-cap.ts).
 */
function porEncima(e: EstadoParaSlack): Array<{ dominio: string; cap: number; yaCruzo: boolean }> {
  const cruzados = new Set((e.hechos?.flota?.cruzados ?? []).map((d) => d.toLowerCase()));
  return (e.hechos?.cap?.porEncimaDelTecho ?? []).map((x) => ({ ...x, yaCruzo: cruzados.has(x.dominio.toLowerCase()) }));
}

/** Las tres señales de autenticación que rompen la entrega por sí solas. Ver `ReputacionDominio`. */
const SENALES_AUTH = [
  ["spf", "el SPF"],
  ["dkim", "la firma DKIM"],
  ["ptr", "el PTR de su IP"]
] as const;

/**
 * Los dominios con la autenticación ROTA, no con la autenticación sin medir.
 *
 * `estado === "mal"` es la ÚNICA entrada. `"no-se"` no cuenta: el barrido escribe "no sé" cuando la
 * consulta falló o cuando no había con qué mirar, y tratarlo como roto sería el error simétrico del
 * que costó el mes de julio (leer un cero como "está limpio"). Acá el fail es al silencio.
 */
function authRota(e: EstadoParaSlack): Array<{ dominio: string; que: string; detalle: string }> {
  return (e.hechos?.reputacion ?? []).flatMap((r) => {
    const rotas = SENALES_AUTH.filter(([campo]) => r[campo]?.estado === "mal");
    if (rotas.length === 0) return [];
    return [
      {
        dominio: r.dominio,
        que: rotas.map(([, comoSeDice]) => comoSeDice).join(" y "),
        // El detalle del barrido ya viene escrito para una persona ("193.180.211.182 no tiene PTR",
        // "el dominio no publica SPF"): es el único caso de este archivo donde el texto de la
        // máquina se puede citar tal cual, y por eso se cita.
        detalle: rotas.map(([campo]) => r[campo]?.detalle).find(Boolean) ?? ""
      }
    ];
  });
}

/**
 * LA LISTA CERRADA DE RAZONES PARA INTERRUMPIR A JUANES.
 *
 * El orden es el orden de salida: DANO antes que CEGUERA antes que DECISION, y dentro de cada clase
 * el orden de esta lista. Sale UNA por vuelta.
 *
 * CADA ENTRADA TIENE QUE PODER CONTESTAR "¿qué hace él al leer esto?". Si no puede, es HUELLA y va
 * al panel. Ese es el gate contra el círculo, y está fijado por test: el test de cada regla nombra
 * la llave de `LlaveDecision` que el jefe usa.
 */
export const REGLAS: readonly Regla[] = [
  // ── DANO ──────────────────────────────────────────────────────────────────────────────────────
  {
    // LO ÚNICO IRREVERSIBLE DEL NEGOCIO. Cruzar 5.000/día a personales de Gmail clasifica el dominio
    // como "bulk sender" PARA SIEMPRE (cita verificada en la doc oficial de Google). Hoy es
    // estructuralmente imposible que el canal avise: `flota.cruzados` ni siquiera estaba en el
    // retrato observable, así que el evento más caro del sistema producía CERO mensajes.
    id: "d1-cruce-umbral",
    clase: "dano",
    decision: "kill-switch",
    siempre: true,
    pide: true,
    predicado: (e) => cruzadosNuevos(e).length > 0,
    texto: (e) => {
      const nuevos = cruzadosNuevos(e);
      return `${nuevos.join(", ")} ${nuevos.length === 1 ? "cruzó" : "cruzaron"} el umbral de volumen de Gmail. Eso no se revierte: ${nuevos.length === 1 ? "ese dominio queda" : "esos dominios quedan"} marcado para siempre. Dime si lo mato aquí o si seguimos.`;
    }
  },
  {
    // La flota se derrumba de a poco y nadie lo nota: 3 bandejas menos por vuelta son 18 en una
    // hora. El umbral es 3 y no 1 porque `flota.sanas` OSCILA sola con el modo de falla "nodo vivo
    // pero incomunicado" ya documentado (la VM corre, pierde la red, y solo un chequeo externo la ve).
    id: "d3-derrumbe-flota",
    clase: "dano",
    decision: "bajar-o-retirar-nodo",
    pide: true,
    predicado: (e) => {
      const sanas = salto(e, "flota.sanas");
      const bloq = salto(e, "flota.bloqueadas");
      return (!!sanas && sanas.antes - sanas.despues >= 3) || (!!bloq && bloq.despues - bloq.antes >= 3);
    },
    texto: (e) => {
      const sanas = salto(e, "flota.sanas");
      const bloq = salto(e, "flota.bloqueadas");
      if (sanas && sanas.antes - sanas.despues >= 3) {
        return `Se cayeron ${sanas.antes - sanas.despues} bandejas de golpe: quedan ${sanas.despues} sanas de las ${sanas.antes} que había. Mira si hay que bajar un nodo.`;
      }
      const b = bloq ?? { antes: 0, despues: 0 };
      return `Se bloquearon ${b.despues - b.antes} bandejas más de golpe: ya son ${b.despues}. Mira si hay que retirar un nodo.`;
    }
  },
  {
    // NACE CON SU INPUT AUSENTE, que lo llena el lote 3. Mientras `porEncimaDelTecho` no exista, el
    // predicado da falso y esto es SILENCIO — jamás "el cap está bien". Test explícito.
    id: "d2-cerca-con-cap-alto",
    clase: "dano",
    decision: "bajar-cap-del-nodo",
    pide: true,
    predicado: (e) => (e.hechos?.cap?.porEncimaDelTecho ?? []).length > 0,
    // POR CAMBIO DEL CONJUNTO, NO POR RELOJ. El cap de 15.000 sigue puesto hasta que alguien corra
    // `limite-fisico`: en el replay de 24 h esto daba verdadero en 135 de 135 vueltas y sacaba 4
    // mensajes por día sobre el MISMO dominio, todos los días. Con la firma habla cuando entra o
    // sale un dominio de la lista, que es cuando hay algo nuevo que hacer.
    //
    // LA MARCA `!` NO ES ADORNO: distingue al que ya cruzó del que va camino. Sin ella, un dominio
    // que pasa de "cerca" a "cruzó" sin que le muevan el cap tiene la MISMA firma, así que el
    // mensaje nuevo —que es el grave— quedaría tapado por el viejo.
    firmaDelHecho: (e) => porEncima(e).map((x) => `${x.dominio}=${x.cap}${x.yaCruzo ? "!" : ""}`).sort().join(","),
    texto: (e) => {
      const l = porEncima(e);
      // LOS DOS NÚMEROS ADENTRO DE LA FRASE. Sin ellos el mensaje decía "por encima del techo que
      // aguanta el dominio" y la respuesta textual del jefe fue "No entiendo, es decir ?".
      const listar = (xs: typeof l): string => {
        const dichos = xs.map((x) => `${x.dominio} tiene el nodo cableado a ${miles(x.cap)} por día`);
        return dichos.length === 1 ? dichos[0]! : `${dichos.slice(0, -1).join("; ")} y ${dichos[dichos.length - 1]}`;
      };
      const techo = `el techo que aguanta un dominio es ${miles(TECHO_DURO_POR_DOMINIO)}`;
      const cruzados = l.filter((x) => x.yaCruzo);
      const camino = l.filter((x) => !x.yaCruzo);
      // LOS DOS CASOS SE DICEN DISTINTO PORQUE LA LLAVE ES LA MISMA PERO LA URGENCIA NO.
      //  · camino: todavía se puede evitar el daño permanente bajando el tope.
      //  · ya cruzó: el daño de Gmail ya está hecho y no se deshace, y el nodo sigue con el freno
      //    siete veces por encima de lo que hay que frenar, así que el mismo volumen va ahora contra
      //    el siguiente receptor. Medido: 8 de los 9 nodos que cruzaron figuran cerca de Yahoo.
      const frases: string[] = [];
      if (camino.length > 0) {
        frases.push(
          `${listar(camino)}, y ${techo}. ${camino.length === 1 ? "Va" : "Van"} camino al umbral permanente de Gmail: ` +
            `hay que bajarle el tope diario al nodo.`
        );
      }
      if (cruzados.length > 0) {
        frases.push(
          `${listar(cruzados)} y ${cruzados.length === 1 ? "ya cruzó" : "ya cruzaron"} el umbral de Gmail, que no se deshace. ` +
            `Con ${techo}, ese mismo volumen va ahora contra el siguiente receptor. Hay que bajarle el tope diario al nodo igual.`
        );
      }
      return frases.join(" ");
    }
  },
  {
    // LAS DOS SEÑALES DEL 2026-07-25, JUNTAS O NADA. Ese día 38 nodos estaban cerrados en Gmail con
    // TODAS las IPs limpias en listas negras: la reputación interna de Google es invisible al
    // chequeo de blacklists. Un mensaje que dice solo "está limpio" sobre un nodo que el receptor
    // rechaza es peor que ninguno: se lee como "está bien".
    id: "d4-reputacion",
    clase: "dano",
    decision: "bajar-o-retirar-nodo",
    pide: true,
    predicado: (e) => !!reputacionDonde(e, (r) => listado(r) || limpioPeroCerrado(r)),
    texto: (e) => {
      const r = reputacionDonde(e, (x) => listado(x) || limpioPeroCerrado(x));
      if (!r) return "";
      if (listado(r)) {
        const l = Array.isArray(r.listas) ? r.listas : [];
        // EL CONTADOR, que d5 ya tenía y ésta no. Con los datos del 2026-08-07 el mensaje nombraba
        // UN dominio de CINCO listados (corp-delivery.com, infranationalreport.com,
        // annualfiling-ops.com, annualfilingops.com, annualfilings-infra.com) y no decía que había
        // más. En la clase de mensaje que le hace vibrar el móvil, y en la dirección peligrosa: el
        // jefe baja ese nodo y se queda tranquilo con cuatro puestos.
        // LOS NOMBRES, no el conteo — y cada uno con SU lista.
        //
        // Este texto se estrenó el 2026-08-07 y falló contra el jefe el mismo día. Dijo "Hay 4
        // dominios más en la misma", Juanes preguntó "¿cuáles son los otros 4?" y el agente tuvo
        // que contestar "no los tengo en mi lectura actual" — era cierto, porque hasta ese día
        // `hechos.reputacion` no entraba al contexto del modelo, así que este texto era la ÚNICA
        // vía por la que ese dato podía llegarle. Un conteo sin sustantivos le hace vibrar el
        // móvil y no le deja hacer nada: es la peor combinación de las dos quejas que ya levantó.
        //
        // Y "en la misma" era además FALSO. En el archivo real de ese día los cinco listados eran
        // corp-delivery.com, infranationalreport.com, annualfilingops.com y annualfilings-infra.com
        // en RATS Dyna, pero annualfiling-ops.com en DRONE BL. La frase afirmaba una lista
        // compartida que nadie había verificado, y la afirmación la construía este renderizador —
        // no el modelo, que es donde solemos buscar estas cosas.
        const otros = (e.hechos?.reputacion ?? []).filter(listado).filter((x) => x.dominio !== r.dominio);
        const mas =
          otros.length > 0
            ? ` Hay ${otros.length} más listado${otros.length === 1 ? "" : "s"}: ` +
              `${otros.map((x) => `${x.dominio} (${(x.listas as readonly string[]).join(", ")})`).join(", ")}.`
            : "";
        return `La IP de ${r.dominio} (${r.ip ?? "sin IP en el inventario"}) figura en ${l.length} lista${l.length === 1 ? "" : "s"} negra${l.length === 1 ? "" : "s"}: ${l.join(", ")}. Ese nodo hay que bajarlo o retirarlo.${mas}`;
      }
      return `${r.dominio} tiene las 2 señales cruzadas: 0 listas negras y el receptor cerrado. Las listas no ven la reputación interna del receptor, así que limpio no quiere decir sano. Mira si ese nodo se retira.`;
    }
  },
  {
    // LA AUTENTICACIÓN ROTA NO ES REPUTACIÓN: ES LA PUERTA CERRADA CON LLAVE.
    //
    // El barrido mide spf/dkim/ptr por dominio desde hace días y ninguna regla los leía. Medido
    // sobre el archivo real del 2026-08-07 (66 dominios): corpfiling-ops.com no tiene PTR desde
    // que existe —textual del barrido, "193.180.211.182 no tiene PTR"— y nfcfilings.com no publica
    // SPF. Nadie lo dijo NUNCA en el canal, ni una vez.
    //
    // Va como DAÑO y no como ceguera porque no es que no sepamos: sabemos, y lo que sabemos es que
    // ese dominio está gastando su ventana de "dominio nuevo" mandando correo que el receptor está
    // obligado a castigar. Es la única categoría de problema de este archivo que se arregla en
    // media hora y sin esperar a nadie.
    //
    // POR CONJUNTO Y NO POR RELOJ, igual que c3: un PTR que falta hoy va a faltar en la vuelta 144
    // de hoy y en las 144 de mañana. Se dice una vez, y otra cuando entra o sale un dominio.
    id: "d5-auth-rota",
    clase: "dano",
    decision: "arreglar-el-nodo",
    pide: true,
    predicado: (e) => authRota(e).length > 0,
    firmaDelHecho: (e) => authRota(e).map((x) => `${x.dominio}:${x.que}`).sort().join(","),
    texto: (e) => {
      const l = authRota(e);
      const r = l[0];
      if (!r) return "";
      const mas = l.length > 1 ? ` Hay ${l.length - 1} ${l.length === 2 ? "dominio más" : "dominios más"} así.` : "";
      return (
        `${r.dominio} tiene ${r.que} en mal estado: ${r.detalle}. Con eso roto el receptor lo castiga por reglamento, ` +
        `no por reputación, así que el calentamiento que hace no le sirve de nada.${mas} Eso se arregla en el nodo.`
      );
    }
  },

  // ── CEGUERA ───────────────────────────────────────────────────────────────────────────────────
  {
    // DOS VUELTAS, NO LA PRIMERA. La primera es un tropiezo (el modelo tarda, Postgres se recarga
    // doce segundos); la segunda ya es un vigilante ciego, y eso hay que decirlo: es lo único peor
    // que una mala noticia.
    //
    // "SIN LECTURA ÚTIL" INCLUYE LOS REPAROS a propósito: con reparos el agente NO ejecuta nada, así
    // que la vuelta es igual de ciega que sin lectura — quedó mudo de manos, no solo de boca. Antes
    // eran dos razones distintas (1 y 2) y ninguna contaba vueltas.
    id: "c1-sin-lectura-2",
    clase: "ceguera",
    decision: "arreglar-el-nodo",
    pide: true,
    predicado: (e) => (e.vueltasSinLecturaUtil ?? 0) >= 2,
    texto: (e) =>
      e.sinLectura
        ? `Van ${e.vueltasSinLecturaUtil ?? 2} vueltas que no puedo leer el estado: ${e.sinLectura}. Estoy vigilando a ciegas.`
        : // "sin detalle" ERA UN CASO REAL, no un placeholder muerto: `vueltasSinLecturaUtil` viene
          // de la memoria, así que una vuelta LIMPIA (sin reparos y sin sinLectura) cae igual en
          // esta rama con el contador heredado y el paréntesis salía con la muletilla adentro. Un
          // paréntesis vacío no se escribe: se omite.
          `Van ${e.vueltasSinLecturaUtil ?? 2} vueltas que lo que leo no cuadra con los datos` +
          `${e.reparos[0] ? ` (${e.reparos[0]})` : ""}, así que no toqué nada. Estoy vigilando a ciegas.`
  },
  {
    // LA MEDICIÓN DEL CUPO VENCE A LAS 12 h Y NADIE SE ENTERA. Es el modo de falla normal, no el
    // raro: la Mac se duerme y la medición queda vieja mientras el panel la sigue mostrando. Un dato
    // de ayer leído como de hoy es cómo se fabrican los 4 pedidos falsos de arreglar un freno.
    id: "c2-medicion-vencida",
    clase: "ceguera",
    decision: "arreglar-el-nodo",
    predicado: (e) => {
      if (!e.hechos) return false;
      const cap = horasDesde(e.hechos.cap?.medidoEn ?? null, e.ahoraISO);
      const flota = horasDesde(e.hechos.flota?.medidoEn ?? null, e.ahoraISO);
      return (cap !== null && cap > HORAS_MEDICION_VIGENTE) || (flota !== null && flota > HORAS_MEDICION_VIGENTE);
    },
    texto: (e) => {
      const cap = horasDesde(e.hechos?.cap?.medidoEn ?? null, e.ahoraISO);
      const flota = horasDesde(e.hechos?.flota?.medidoEn ?? null, e.ahoraISO);
      const cual = cap !== null && cap > HORAS_MEDICION_VIGENTE ? { que: "del cupo de los nodos", h: cap } : { que: "de la salud de la flota", h: flota ?? 0 };
      return `La medición ${cual.que} es de hace ${Math.round(cual.h)} horas y ya no vale. Todo lo que diga sobre eso es de memoria, no de hoy.`;
    }
  },
  {
    // UN INSTRUMENTO CUYO RESULTADO NO SE GUARDA NO VIGILA NADA. El 2026-08-07T09:23Z el agente
    // corrió `revisar_reputacion` sobre annualfiling-infra.com y le volvió textual "no pude
    // consultar las listas negras… No sé si está listado". Eso no llegó a Slack ni a ningún archivo:
    // no se puede diffear ni hoy ni mañana. Un "no sé" hay que decirlo; un array vacío sería mentir.
    id: "c3-reputacion-no-se",
    clase: "ceguera",
    decision: "arreglar-el-nodo",
    predicado: (e) => !!reputacionDonde(e, noSeSiEstaListado),
    // También por CAMBIO y no por reloj: mientras sean los mismos dominios ciegos, ya está dicho.
    firmaDelHecho: (e) => (e.hechos?.reputacion ?? []).filter(noSeSiEstaListado).map((r) => r.dominio).sort().join(","),
    texto: (e) => {
      const r = reputacionDonde(e, noSeSiEstaListado);
      const cuantos = (e.hechos?.reputacion ?? []).filter(noSeSiEstaListado).length;
      return `No pude consultar las listas negras de ${r?.dominio ?? "un dominio"}${cuantos > 1 ? ` y de ${cuantos - 1} más` : ""}. No sé si están listados, y no medido no es lo mismo que limpio.`;
    }
  },
  {
    // EL PUNTO CIEGO DE LA ATRIBUCIÓN. Las 58 bandejas están en `atribucion.modo === "todo"`, o sea
    // que el veredicto de salud se calcula con TODO el correo que pasa por el nodo, sea nuestro o
    // no. Entra como DATO y jamás como gate: usado de gate deja al agente sin manos hoy mismo.
    id: "c4-veredicto-sin-atribuir",
    clase: "ceguera",
    decision: "arreglar-el-nodo",
    predicado: (e) => e.hechos?.flota?.atribuido === false,
    // UNA SOLA VEZ, Y OTRA SI CAMBIA EL NÚMERO. Es un ESTADO, no un evento: las 58 bandejas están en
    // `atribucion.modo: "todo"` y van a seguir estándolo hasta que exista un proyecto que separe
    // nuestro correo del de terceros. En el replay de 24 h eran 4 de los 12 mensajes, con el texto
    // idéntico, sin nombrar un número, y "la decisión" que pedían no es una llave que él gire.
    // LA FIRMA ES EL HECHO PELADO, no el conteo de bandejas. Con el conteo adentro volvía a hablar
    // cada vez que la flota cambiaba de tamaño —dos veces en el replay de 24 h, 57 → 51— y la
    // ceguera es exactamente la misma con 51 que con 57. Se dice UNA vez; el número va en el texto.
    firmaDelHecho: () => "sin-atribuir",
    texto: (e) => {
      const n = bandejas(e);
      return (
        `El veredicto de salud de ${n === null ? "las bandejas" : `las ${n} bandejas`} lo estoy sacando de TODO el correo que pasa por el nodo, ` +
        `no sólo del nuestro: el nodo mezcla lo nuestro con lo de terceros y desde acá no hay forma de separarlo. ` +
        `Cuando te diga que una bandeja está sana, léelo con ese descuento. Te lo digo una vez y no lo repito hasta que cambie.`
      );
    }
  },

  // ── DECISION ──────────────────────────────────────────────────────────────────────────────────
  {
    // EL EMISOR FRENADO ES LA LLAVE MÁS CARA: mientras está pausado la fábrica no calienta y el
    // reloj de los dominios nuevos sigue corriendo. "Persiste" = dos vueltas, no una: un
    // `cap-reached` de una vuelta se levanta solo al día siguiente y no necesita a nadie.
    id: "dec1-emisor-pausado",
    clase: "decision",
    decision: "levantar-pausa-emisor",
    pide: true,
    predicado: (e) => !!e.emisor && e.emisor !== "send" && (e.vueltasEmisorFrenado ?? 0) >= 2,
    texto: (e) => {
      const como = COMO_ESTA_EL_EMISOR[e.emisor ?? ""] ?? `parado (${e.emisor ?? "sin estado"})`;
      return `Van ${e.vueltasEmisorFrenado ?? 2} vueltas con el emisor ${como}, así que hoy no está calentando nada. La pausa la levantas tú o sigo esperando.`;
    }
  },
  {
    // SOLTAR ES LA ÚNICA MANO QUE AGREGA VOLUMEN y por eso está detrás de una llave del jefe. Cuando
    // el agente la intenta y le rebota, sin este mensaje se queda callado mirando un dominio que él
    // ya evaluó y que nadie va a soltar.
    id: "dec2-soltar-trabado",
    clase: "decision",
    decision: "autorizar-soltar",
    pide: true,
    predicado: (e) => !!manoTrabada(e, new Set(["soltar_dominio"])),
    firmaDelHecho: (e) => firmaDeLaMano(manoTrabada(e, new Set(["soltar_dominio"]))),
    texto: (e) => {
      const a = manoTrabada(e, new Set(["soltar_dominio"]));
      // "sin detalle" era la muletilla de un log, no una frase. Cuando no hay motivo se dice que no
      // lo hay, con las palabras con las que uno se lo diría a alguien.
      const porque = a?.detalle ? `: ${a.detalle}` : ", y no me dijo por qué";
      return `Quiero soltar ${a?.objetivo ?? "un dominio"} y no me deja${porque}. Eso lo autorizas tú.`;
    }
  },
  {
    // LA MANO QUE FALLÓ Y NO SE ARREGLA SOLA. Dos exclusiones, las dos aprendidas en producción el
    // 2026-08-06: lo REINTENTABLE (un SSH caído, Postgres reiniciándose — le sonó el móvil por algo
    // que ya estaba arreglado antes de que lo leyera) y el ERROR SUYO ("Quise
    // diagnosticar_dominio_bizregistry-ops.com y no pude: no es una acción permitida. ¿Lo resolvés
    // vos?" — no hay nada que resolver del otro lado).
    //
    // Y EL CANDADO ANTI-FALSEDAD: si el detalle AFIRMA que el freno no pegó apoyado en el snapshot y
    // la medición directa del nodo venció, el texto dice "no sé" y nunca "no pegó". Ver
    // `medicionDelCupoVigente`.
    id: "dec3-mano-fallo",
    clase: "decision",
    decision: "arreglar-el-nodo",
    pide: true,
    predicado: (e) => !!manoTrabada(e, new Set(["frenar_dominio", "pausar_warmup"])),
    firmaDelHecho: (e) => firmaDeLaMano(manoTrabada(e, new Set(["frenar_dominio", "pausar_warmup"]))),
    texto: (e) => {
      const a = manoTrabada(e, new Set(["frenar_dominio", "pausar_warmup"]));
      const global = a?.accion === "pausar_warmup";
      const que = global ? "parar el calentamiento de la flota entera" : `frenar ${a?.objetivo ?? "un dominio"}`;
      // EL `detalle` CRUDO NO SE INTERPOLA MÁS. Ver `porQueNoPudo`: esta mano toca infraestructura y
      // el mensaje va con `pide: true`, así que lo que salía por acá era un renglón de log haciéndole
      // vibrar el móvil.
      const dicho = porQueNoPudo(a?.detalle ?? "", medicionDelCupoVigente(e));
      // La mano global no tiene objetivo, así que sin esto el mensaje sale sin un solo dato que
      // agarrar — la regresión de "Sigo acá. Ya los estoy evaluando…". El número no se inventa: la
      // acción no se ejecutó, o sea que quedaron 0 frenos aplicados.
      const consecuencia = global ? " Quedaron 0 frenos aplicados y sigue mandando." : "";
      return `Quise ${que} y no pude: ${dicho}.${consecuencia} Eso lo destrabas tú.`;
    }
  },
  {
    // LA FÁBRICA PARADA MIENTRAS EL EMISOR DICE QUE MANDA. Es literalmente la queja del jefe ("no
    // estoy viendo avances") y no había una sola regla que la viera: entre 2026-08-06T17:53Z y
    // 2026-08-07T00:01Z hubo CERO envíos y CERO mediciones en `warmup_activity`, y en esas 6 h 08 m
    // el monitor corrió 34 vueltas diciendo textual "La flota calienta activamente con 13 dominios
    // entregando". c2 no la cubre: c2 mira la edad de la medición del CAP y de la FLOTA, que son
    // procesos externos y siguen frescos con la fábrica muerta.
    //
    // El dato ya viajaba en la mano: `hechos.vueltas[0].cuando` es el ciclo más nuevo de
    // `warmup_activity` (la query va ORDER BY max(occurred_at) DESC).
    //
    // DOS GUARDAS, las dos para no gritar por nada:
    //  · `vueltas` vacío NO dispara. Vacío es "no pude leer la base", y eso ya tiene su regla (c1).
    //  · sólo con el emisor en `send`. Si está pausado, que no salga correo es la consecuencia
    //    esperada y de eso habla dec1; el hallazgo es la CONTRADICCIÓN entre lo que dice y lo que hace.
    id: "dec4-fabrica-sin-enviar",
    clase: "decision",
    decision: "arreglar-el-nodo",
    pide: true,
    predicado: (e) => {
      if (e.emisor !== "send") return false;
      // TERCERA GUARDA, y salió de una falsa alarma REAL. El 2026-08-07T18:35 esta regla avisó
      // "hace 3 horas que la fábrica no da una vuelta" mientras el daemon llevaba 4h48m vivo y su
      // propia última línea decía: "PAUSA — los 6 boxes del pool ya agotaron su cupo diario. Nada
      // que enviar hoy". La fábrica no estaba rota: había TERMINADO.
      //
      // Y esa clase de error es peor que escalar algo resoluble. Un aviso que grita en falso no
      // molesta: enseña a ignorar todos los demás, incluido el que un día sí importe. Si cada
      // dominio del plan ya gastó su cupo, el silencio es la consecuencia esperada del diseño, no
      // un síntoma. La contradicción que esta regla busca es entre lo que el emisor DICE y lo que
      // la fábrica HACE — y acá no hay contradicción: hizo exactamente lo que tenía permitido.
      const plan = e.hechos?.plan ?? [];
      const todosCumplieronSuCupo = plan.length > 0 && plan.every((p) => p.enviadosHoy >= p.cupo);
      if (todosCumplieronSuCupo) return false;
      // CUARTA GUARDA: EL SILENCIO DE AYER NO ES EVIDENCIA DE HOY.
      //
      // La tercera guarda tapó el caso "todos topados" y a las pocas horas la regla volvió a gritar
      // en falso, el 2026-08-08T00:44:37Z — a CUARENTA Y CUATRO MINUTOS de empezado el día UTC.
      // Textual del canal: "Hace 9 horas que la fábrica no da una vuelta… Échale un ojo a ver si
      // sigue vivo", con el daemon vivo (PID 76220) y dando la vuelta #19 en INBOX poco después.
      //
      // El agujero es el borde del día. `enviadosHoy` se cuenta contra
      // `date_trunc('day', now(), 'UTC')` (plan-diario.ts), así que a las 00:00 UTC los contadores
      // de los seis dominios vuelven a 0 de golpe: la tercera guarda se apaga en ese instante
      // mientras el hueco medido —9 h— sigue siendo el de AYER, cuando estaban topados y el
      // silencio era lo correcto. O sea: falsa alarma garantizada, todos los días, a la misma hora.
      //
      // Se acota el hueco a lo que va del día UTC. Lo que pasó antes del corte ya lo juzga la
      // tercera guarda con los contadores de ayer; arrastrarlo a hoy es contar dos veces. El costo
      // es detección más lenta si el daemon muere de noche —hasta HORAS_SIN_ENVIAR entrado el día
      // nuevo— y se paga con gusto: un aviso que grita en falso no molesta, enseña a ignorar todos
      // los demás, incluido el que un día sí importe.
      const h = horasDesde(e.hechos?.vueltas?.[0]?.cuando ?? null, e.ahoraISO);
      if (h === null) return false;
      return Math.min(h, horasDelDiaUTC(e.ahoraISO)) >= HORAS_SIN_ENVIAR;
    },
    texto: (e) => {
      const h = horasDesde(e.hechos?.vueltas?.[0]?.cuando ?? null, e.ahoraISO) ?? HORAS_SIN_ENVIAR;
      // "vuelta" y no "correo": la fila más nueva de `warmup_activity` puede ser un envío, una
      // medición o un error. Que no haya NINGUNA es lo que dice que la fábrica está quieta, y decir
      // "no manda un correo" sobre eso sería afirmar de más.
      return (
        `Hace ${Math.round(h)} horas que la fábrica no da una vuelta —ni un envío, ni una medición— y el emisor dice que está mandando. ` +
        `El daemon tendría que dar una cada hora y media. Échale un ojo a ver si sigue vivo.`
      );
    }
  },
  {
    // UNA MANO QUE SE MUEVE EN SILENCIO es exactamente lo que no queremos de un agente autónomo: lo
    // que cambia la infraestructura se dice SIEMPRE, y la llave que él tiene es revertirlo.
    //
    // Acá vivía el "Hice esto: <accion>" que originó la queja de la voz. Ahora la mano va DENTRO de
    // la oración (`COMO_SE_DICE`) o no va, y `estado.voz` NO se usa: la voz del modelo es por donde
    // entraron los 4 pedidos falsos, y un mensaje de clase decision no puede depender del modelo.
    id: "dec5-toque-de-infra",
    clase: "decision",
    decision: "revertir-la-mano",
    // EL RELOJ ERA LA HERRAMIENTA EQUIVOCADA, Y ACÁ SE TRAGABA EVENTOS. Con el enfriamiento genérico
    // de 6 h por id de regla: el agente frena un dominio a las 10:00 y avisa; frena OTRO a las 11:00
    // y OTRO a las 13:00 y no avisa ninguno de los dos, nunca — quedaron con el cupo en 0 y él no se
    // enteró. Un agente autónomo cambiando la infraestructura en silencio es exactamente lo que esta
    // regla existe para impedir, y encima es la única `decision` sin `pide`, así que el enfriamiento
    // no estaba protegiendo un móvil que sonara.
    //
    // `siempre` saca el reloj y `firmaDelHecho` lo reemplaza por el criterio correcto, el mismo
    // mecanismo que ya usan d2 y c4: si el conjunto de manos ejecutadas es idéntico al último dicho,
    // calla; si tocó algo NUEVO, habla entera. Para dec5 "el hecho cambió" ES "pasó algo nuevo".
    siempre: true,
    firmaDelHecho: (e) =>
      e.acciones
        .filter((a) => a.ejecutada && TOCAN.has(a.accion))
        .map((a) => `${a.accion}:${a.objetivo ?? ""}`)
        .sort()
        .join(","),
    predicado: (e) => e.acciones.some((a) => a.ejecutada && TOCAN.has(a.accion)),
    texto: (e) => {
      const hechas = e.acciones.filter((a) => a.ejecutada && TOCAN.has(a.accion));
      const dichas = hechas.map((a) => COMO_SE_DICE[a.accion]?.(a.objetivo ?? "") ?? `toqué ${a.objetivo ?? "la flota"}`);
      const frase = dichas.length === 1 ? dichas[0] : `${dichas.slice(0, -1).join(", ")} y ${dichas[dichas.length - 1]}`;
      return `Toqué la infraestructura: ${frase}. Si no quieres que quede así, reviértelo.`;
    }
  }
];

const POR_CLASE: Record<"dano" | "ceguera" | "decision", number> = { dano: 0, ceguera: 1, decision: 2 };
const REGLAS_ORDENADAS = [...REGLAS].sort((a, b) => POR_CLASE[a.clase] - POR_CLASE[b.clase]);
const IDS: ReadonlySet<string> = new Set(REGLAS.map((r) => r.id));

/**
 * FAIL-CLOSED: ningún `Aviso` sale con una `regla` que no esté en la lista cerrada. Se exporta para
 * que el test use EXACTAMENTE el mismo predicado que producción — un test que reimplementa la regla
 * que verifica no verifica nada (lección pagada con el fixture de Bedrock).
 */
export function esRegla(regla: string, clase: Clase): boolean {
  if (clase === "huella") {
    const campo = regla.startsWith("huella:") ? regla.slice("huella:".length) : "";
    return campo !== "" && Object.prototype.hasOwnProperty.call(ETIQUETA, campo);
  }
  return IDS.has(regla);
}

// ── EL UMBRAL QUE APRENDE ────────────────────────────────────────────────────────────────────────
//
// Textual: "que aprenda en verdad que es relevante para conversarme y lo que yo quiero mirar,
// escuchar o leer de slack".
//
// Hoy la relevancia está 100% cableada: las reacciones del jefe se clasifican y se guardan
// (memoria-conversacion.ts, conforme/insiste/corrige) y las lee UN script offline. Cero
// realimentación al canal. Acá se cierra el lazo, con dos barreras que lo hacen aceptable:
//   1. SOLO SE MUEVE LA BANDA DE HUELLA. Ninguna secuencia de reacciones puede bajar un dano, una
//      ceguera o una decision por debajo del umbral, ni subir nada HASTA esas clases. Un sistema que
//      aprende a callarse puede aprender a callar un incendio: eso está prohibido por test exhaustivo.
//   2. EL SILENCIO NO ES EVIDENCIA. Una salida sin respuesta solo cuenta si él estaba DESPIERTO
//      (hubo un mensaje suyo en el canal dentro de ±30 min). Si no, no cuenta: podía estar durmiendo.

/** Lo que se sabe de un par `huella:<campo>`. `muestra` va SIEMPRE al lado del peso. */
export interface EntradaRelevancia {
  /** Cuántas veces salió ese par (solo se cuentan las salidas con el jefe despierto). */
  salieron: number;
  /** Cuántas veces él contestó en ese hilo. Es el numerador que él no puede falsear desde el código. */
  respondio: number;
  /** Cuántas veces se quejó (`corrige` o `insiste`). Degrada de una. */
  quejo: number;
  /** 0 = no sale. 1 = sale. Nada en el medio hoy: el peso es la puerta, no un ranking. */
  peso: number;
  /** Sobre cuántas observaciones está calculado el peso. Un peso sobre 3 muestras no es un peso. */
  muestra: number;
  ultimaVez: string | null;
  /** Los `ts` de Slack de los mensajes proactivos de ese par, para ir a cosechar la reacción. */
  hilos?: string[];
}

export type TablaRelevancia = Record<string, EntradaRelevancia>;

/** Debajo de esto el peso no se mueve: tres observaciones no son una costumbre. Mismo número que MIN_VECES. */
export const MUESTRA_MINIMA = MIN_VECES;
/** Cuántas salidas sin respuesta ESTANDO DESPIERTO hacen falta para callar un par ya promovido. */
export const SALIDAS_SIN_RESPUESTA_PARA_CALLAR = 10;
/** Máximo de `ts` guardados por par. Es una cola de cosecha, no un archivo histórico. */
const MAX_HILOS = 20;

const vacia = (): EntradaRelevancia => ({ salieron: 0, respondio: 0, quejo: 0, peso: 0, muestra: 0, ultimaVez: null, hilos: [] });

/**
 * LA PUERTA. Solo se consulta cuando `clase === "huella"`; el resto de las clases ni la miran.
 *
 * Arranca cerrada para todos los pares: la tabla nace vacía, o sea CERO huella el día 1, y puede
 * tardar semanas en abrir algo. Eso no es una falla, es el tamaño real de la evidencia — y por eso
 * `sentinel-audit` imprime "temas: 6, ninguno llegó al piso de 3" en vez de dejarlo parecer que no
 * había nada que decir.
 */
export function dejaSalir(tabla: TablaRelevancia | null | undefined, par: string): boolean {
  const t = tabla?.[par];
  return !!t && t.muestra >= MUESTRA_MINIMA && t.peso >= 1;
}

/**
 * PROMOCIÓN POR LO QUE ÉL PREGUNTA. La señal más honesta que hay y es gratis: si preguntó por el
 * placement tres veces en dos semanas, el placement le importa.
 *
 * Reusa `temas` de memoria-conversacion.ts —que hoy se calcula y no lo lee nadie— y el mapa de
 * palabras de abajo para atar pregunta→campo. Sin modelo, testeable, y con la misma ventana de 14
 * días y el mismo `MIN_VECES` que ya usa el informe.
 *
 * NO se construye exploración ("mandá una huella por día para tener muestra"): sería reintroducir el
 * ruido para alimentar la tabla.
 */
const PALABRAS_POR_CAMPO: Record<string, readonly string[]> = {
  placement: ["placement", "bandeja", "bandejas", "inbox", "spam"],
  "plan.accion": ["plan", "volumen", "subir", "bajar", "sostener"],
  "plan.diaN": ["rampa", "dia", "dias", "calentamiento"],
  "plan.enPool": ["pool", "calentando", "calienta", "calentar"],
  "cap.frenados": ["frenado", "frenados", "cupo", "cap", "soltar"],
  "flota.sanas": ["sanas", "salud", "flota", "nodos"],
  "flota.bloqueadas": ["bloqueadas", "bloqueados", "yahoo", "gmail", "rebotes"]
};

/** Normalización mínima y local: minúsculas sin acentos, que es como se comparan las palabras clave. */
const sinAcentos = (t: string): string => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** A qué campos apunta una pregunta del jefe. Puede ser ninguno (la mayoría de las veces). */
export function camposDeLaPregunta(cita: string): string[] {
  const n = ` ${sinAcentos(cita).replace(/[^a-z0-9]+/g, " ")} `;
  return Object.entries(PALABRAS_POR_CAMPO)
    .filter(([, palabras]) => palabras.some((p) => n.includes(` ${p} `)))
    .map(([campo]) => campo);
}

/**
 * Sube el peso de los pares por los que él preguntó ≥ MIN_VECES en la ventana. Puro: recibe los
 * temas ya recortados por `memoria-conversacion.ts` y devuelve una tabla nueva.
 */
export function promoverPorPreguntas(
  tabla: TablaRelevancia | null | undefined,
  temas: ReadonlyArray<{ cita: string; vistas: readonly string[] }>,
  ahoraISO: string,
  diasVentana = 14
): TablaRelevancia {
  const out: TablaRelevancia = { ...(tabla ?? {}) };
  const limite = Date.parse(ahoraISO) - diasVentana * 86_400_000;
  const cuenta = new Map<string, number>();
  for (const t of temas) {
    const veces = t.vistas.filter((v) => {
      const ms = Date.parse(v);
      return Number.isFinite(ms) && ms >= limite;
    }).length;
    if (veces === 0) continue;
    for (const campo of camposDeLaPregunta(t.cita)) cuenta.set(campo, (cuenta.get(campo) ?? 0) + veces);
  }
  for (const [campo, veces] of cuenta) {
    if (veces < MIN_VECES) continue;
    const par = `huella:${campo}`;
    const e = out[par] ?? vacia();
    // UNA QUEJA LE GANA A UNA PREGUNTA VIEJA, y esto no es un detalle de orden: el orquestador corre
    // `promoverPorPreguntas` UNA VEZ POR VUELTA (paso 9) y `temas` vive 14 días. Sin este guard, el
    // jefe corregía un mensaje, el par se cerraba, y diez minutos después la promoción lo volvía a
    // abrir con el mismo tema viejo. Reproducido con las funciones reales: 20 "corrige" alternados
    // con la promoción terminaban en `quejo 21, peso 1, dejaSalir=true`; y 15 salidas sin respuesta
    // cerraban el par y la promoción siguiente lo reabría. Las dos degradaciones que este archivo
    // promete eran INERTES en composición, que es literalmente el círculo: él se queja y el canal
    // sigue hablando.
    //
    // El test que las cubría hacía promover→corrige, o sea el orden que NO ocurre en producción.
    if (e.quejo > 0) continue;
    if (e.salieron - e.respondio >= SALIDAS_SIN_RESPUESTA_PARA_CALLAR) continue;
    // La muestra de una promoción son las PREGUNTAS, no las salidas: es evidencia de él, no nuestra.
    out[par] = { ...e, peso: 1, muestra: Math.max(e.muestra, veces), ultimaVez: ahoraISO };
  }
  return out;
}

/**
 * Anota que un par SALIÓ. `estabaDespierto` es la condición que hace honesta la degradación: sin
 * ella, un canal que sale a las 4am se apagaría solo por dormir el jefe. "Despierto" no es una
 * suposición — es que haya un mensaje suyo en el canal dentro de ±30 min, que el carril de chat ya
 * conoce.
 */
export function registrarSalida(
  tabla: TablaRelevancia | null | undefined,
  par: string,
  ts: string | null,
  estabaDespierto: boolean,
  ahoraISO: string
): TablaRelevancia {
  const out: TablaRelevancia = { ...(tabla ?? {}) };
  const e = out[par] ?? vacia();
  const hilos = ts ? [...(e.hilos ?? []), ts].slice(-MAX_HILOS) : (e.hilos ?? []);
  if (!estabaDespierto) {
    // EL SILENCIO NO ES EVIDENCIA. Se guarda el hilo para poder cosechar la respuesta si contesta a
    // la mañana, pero la salida NO cuenta contra el par.
    out[par] = { ...e, hilos, ultimaVez: ahoraISO };
    return out;
  }
  const salieron = e.salieron + 1;
  const muestra = Math.max(e.muestra, salieron);
  // DEGRADACIÓN POR INDIFERENCIA MEDIDA: diez salidas con él despierto y cero respuestas.
  const callar = salieron - e.respondio >= SALIDAS_SIN_RESPUESTA_PARA_CALLAR && muestra >= MUESTRA_MINIMA;
  out[par] = { ...e, salieron, muestra, hilos, ultimaVez: ahoraISO, peso: callar ? 0 : e.peso };
  return out;
}

/**
 * Anota cómo le cayó. `corrige` e `insiste` degradan DE UNA: son evidencia dura, él volvió a
 * escribir. `conforme` es evidencia débil ("Ok!" puede ser "entendí" o "ya fue, dejalo") y solo
 * suma al numerador que sostiene al par arriba.
 */
export function registrarReaccion(
  tabla: TablaRelevancia | null | undefined,
  par: string,
  reaccion: "conforme" | "insiste" | "corrige" | null
): TablaRelevancia {
  const out: TablaRelevancia = { ...(tabla ?? {}) };
  const e = out[par] ?? vacia();
  if (reaccion === null) return out;
  if (reaccion === "corrige" || reaccion === "insiste") {
    out[par] = { ...e, quejo: e.quejo + 1, muestra: Math.max(e.muestra, e.quejo + 1), peso: 0 };
    return out;
  }
  // TRES RESPUESTAS EN EL HILO TAMBIÉN PROMUEVEN. Es la otra cara de la misma señal —lo que él
  // pregunta y lo que él contesta— y las dos las genera él. Con `MIN_VECES`, el mismo piso que usa
  // la memoria de conversación: dos veces el mismo día son una coincidencia, no una costumbre.
  const respondio = e.respondio + 1;
  const muestra = Math.max(e.muestra, respondio);
  out[par] = { ...e, respondio, muestra, peso: respondio >= MIN_VECES ? 1 : e.peso };
  return out;
}

// ── LA DECISIÓN ──────────────────────────────────────────────────────────────────────────────────

/** Una vuelta sin lectura utilizable: no leyó, o lo que leyó no se sostiene (y entonces no actuó). */
const sinLecturaUtil = (e: Pick<EstadoParaSlack, "sinLectura" | "reparos">): boolean => !!e.sinLectura || e.reparos.length > 0;

/** Completa lo que las reglas necesitan como HECHO: el reloj y los dos contadores de persistencia. */
function vista(estado: EstadoParaSlack, mem: MemoriaSlack, ahoraISO: string): EstadoParaSlack {
  return {
    ...estado,
    ahoraISO,
    vueltasSinLecturaUtil: (mem.vueltasSinLecturaUtil ?? 0) + (sinLecturaUtil(estado) ? 1 : 0),
    vueltasEmisorFrenado: (mem.vueltasEmisorFrenado ?? 0) + (estado.emisor && estado.emisor !== "send" ? 1 : 0)
  };
}

const memVacia = (m: MemoriaSlack | null): MemoriaSlack => m ?? { ultimoEmisor: null, ultimoAviso: null, ultimaFirma: null };

/** La clave de enfriamiento de una regla. Por regla, no por canal: un problema no tapa a otro. */
const claveDeRegla = (id: string): string => `regla:${id}`;

/** Cómo se consulta la tabla de relevancia. Sin esto (o sin `tabla`) la huella no sale nunca. */
export interface Relevancia {
  tabla: TablaRelevancia;
  /**
   * EL DÍA EN SOMBRA. Con `sombra: true` la huella promovida NO sale, pero queda en `loQueSeCallo`
   * con su texto para que el log diga "sombra relevancia: habría dicho X". Es la forma de ver QUÉ
   * aprendió antes de confiar en ello.
   */
  sombra?: boolean;
}

/** El candidato de huella de esta vuelta, ya filtrado y con su texto. Compartido por las dos salidas. */
function huellaDeLaVuelta(
  e: EstadoParaSlack,
  mem: MemoriaSlack,
  ahoraISO: string
): { aviso: Aviso; par: string } | null {
  const { elegida, tapados } = presupuestoDeAvances(e.novedades ?? [], mem, ahoraISO);
  if (!elegida) return null;
  const { campo, objeto } = parteClave(elegida.clave);
  const antes = valorLegible(elegida.antes);
  const despues = valorLegible(elegida.despues);
  const frase = fraseHumana(campo, objeto, antes, despues);
  if (frase === null) return null;
  // El sobrante se CUENTA y sale en la misma línea. Se llaman "cambios", no "avances": adentro de
  // esa cuenta puede ir una caída a SPAM, y rotular una regresión como avance es fabricar una buena
  // noticia.
  const extra = tapados > 0 ? ` (y ${tapados} ${tapados === 1 ? "cambio menor más" : "cambios menores más"})` : "";
  return {
    par: `huella:${campo}`,
    aviso: {
      texto: enCastellano(`${frase}${extra}`),
      // El motivo va al log y es RECALCULABLE desde los dos snapshots.
      motivo: `novedad ${campo}${objeto ? ` ${objeto}` : ""} ${antes}→${despues}`,
      clase: "huella",
      regla: `huella:${campo}`,
      decision: null,
      firma: PREFIJO_NOVEDAD,
      avance: elegida.clave,
      pideRespuesta: false,
      // LA HUELLA PROMOVIDA LA REDACTA EL MODELO. Si está caído no sale, y no le cuesta nada al
      // jefe: el panel la tiene.
      porElModelo: true
    }
  };
}

/**
 * ¿Hay algo que valga la pena decir? `null` = silencio, que es la respuesta correcta la mayoría
 * de las veces.
 *
 * `relevancia` es opcional: sin ella (flag `SENTINEL_APRENDE_RELEVANCIA` apagado) la huella NUNCA
 * sale y solo salen las tres clases que interrumpen. Es el fail-closed correcto.
 */
/** Una regla que pasó todas las puertas de esta vuelta, con lo que hay que recordar de ella. */
interface Candidata {
  r: Regla;
  deHecho: string | undefined;
  texto: string;
}

/**
 * LAS PUERTAS, UNA SOLA VEZ. Devuelve las reglas que hoy pueden hablar (en orden de salida) y lo que
 * quedó frenado en el camino, con su motivo.
 *
 * Existe porque `decidirSiHablar` y `loQueSeCallo` recorrían la misma lista con las mismas tres
 * puertas escritas dos veces, y ya divergieron: el instrumento cortaba en la primera regla que
 * matcheaba y no podía ver lo que la decisión tapaba.
 */
function candidatas(e: EstadoParaSlack, mem: MemoriaSlack, ahoraISO: string): { pasaron: Candidata[]; tapados: Tapado[] } {
  const pasaron: Candidata[] = [];
  const tapados: Tapado[] = [];
  for (const r of REGLAS_ORDENADAS) {
    if (!r.predicado(e)) continue;
    // EL HECHO NO CAMBIÓ ⇒ NO SE REPITE. Va ANTES del enfriamiento por reloj a propósito: para un
    // estado permanente el reloj no es un freno, es un temporizador de repetición.
    const deHecho = r.firmaDelHecho?.(e);
    if (deHecho !== undefined && mem.dichoPorRegla?.[r.id] === deHecho) {
      // Se declara igual que cualquier otro tapado: una condición verdadera que no produce mensaje
      // tiene que poder contarse, o "no salió" vuelve a ser indistinguible de "se perdió".
      tapados.push({ motivo: "sin-cambio", clave: r.id });
      continue;
    }
    // `siempre` salta el enfriamiento: cruzar el umbral permanente no admite "ya lo dije hace un
    // rato". El resto respeta las 6 h — una vez por turno de sueño, ni 48 mensajes idénticos antes
    // del desayuno ni un silencio eterno sobre algo que sigue roto.
    if (!r.siempre && enfriando(mem.novedadesRecientes, claveDeRegla(r.id), ahoraISO, HORAS_PARA_REPETIR * 60)) {
      tapados.push({ motivo: "enfriamiento", clave: r.id });
      continue;
    }
    const texto = enCastellano(r.texto(e));
    if (texto === "") continue; // una regla sin texto no puede mandar un mensaje vacío
    pasaron.push({ r, deHecho, texto });
  }
  return { pasaron, tapados };
}

/**
 * LO QUE SE DICE EN ESTE MENSAJE. Una regla, salvo que sean DAÑOS: ésos van todos juntos.
 *
 * "Sale una por vuelta" era correcto para el ruido y catastrófico para el daño. La vuelta del
 * 2026-08-06T20:52:39Z trajo DOS hechos: corpdocfiling-ledger.com cruzó el umbral permanente de
 * Gmail (d1) y las bandejas sanas cayeron de 13 a 6 con 20 más bloqueadas (d3). Los dos predicados
 * daban true, salía el primero, y el mensaje "Se cayeron 7 bandejas de golpe" NO SALÍA NUNCA — ni en
 * esa vuelta ni en la siguiente, porque `novedades` es un diff y en la siguiente ya no hay delta.
 * Perder de esa forma la mitad B del encargo ("vigilar que las ips, los dominios, los smtps no se
 * quemen") por un `return` es el peor precio posible de una regla de orden.
 *
 * Se junta en UN mensaje y no en varios: la ceguera y la decisión siguen esperando su turno, y dos
 * notificaciones separadas por el mismo minuto son dos vibraciones para una sola mirada.
 */
function loQueSeDice(pasaron: readonly Candidata[]): Candidata[] {
  if (pasaron.length === 0) return [];
  return pasaron[0].r.clase === "dano" ? pasaron.filter((c) => c.r.clase === "dano") : [pasaron[0]];
}

export function decidirSiHablar(
  estado: EstadoParaSlack,
  memoria: MemoriaSlack | null,
  ahoraISO: string,
  relevancia?: Relevancia
): Aviso | null {
  const mem = memVacia(memoria);
  const e = vista(estado, mem, ahoraISO);

  const dichas = loQueSeDice(candidatas(e, mem, ahoraISO).pasaron);
  if (dichas.length > 0) {
    const gana = dichas[0];
    const aviso: Aviso = {
      // Un renglón en blanco entre daño y daño: son dos hechos distintos, no una oración larga.
      texto: dichas.map((c) => c.texto).join("\n\n"),
      motivo: `${gana.r.clase} ${dichas.map((c) => c.r.id).join("+")}`,
      clase: gana.r.clase,
      regla: gana.r.id,
      decision: gana.r.decision,
      // Si CUALQUIERA de los daños necesita respuesta, el mensaje la necesita.
      pideRespuesta: dichas.some((c) => c.r.pide === true),
      firma: `${dichas.map((c) => c.r.id).join("+")}|${firma(e)}`,
      ...(gana.deHecho !== undefined ? { firmaDelHecho: gana.deHecho } : {}),
      reglas: dichas.map((c) => ({ id: c.r.id, ...(c.deHecho !== undefined ? { firmaDelHecho: c.deHecho } : {}) })),
      porElModelo: false
    };
    // FAIL-CLOSED. Si por lo que sea alguna regla no está en la lista cerrada, no sale nada. Es
    // imposible por construcción y por eso mismo tiene que ser barato dejarlo escrito.
    return dichas.every((c) => esRegla(c.r.id, c.r.clase)) ? aviso : null;
  }

  // LA HUELLA. Solo sale si la tabla de relevancia la promovió, y nunca en sombra.
  if (!relevancia?.tabla || relevancia.sombra) return null;
  const h = huellaDeLaVuelta(e, mem, ahoraISO);
  if (!h || !dejaSalir(relevancia.tabla, h.par)) return null;
  return esRegla(h.aviso.regla, h.aviso.clase) ? h.aviso : null;
}

/**
 * QUÉ SE CALLÓ Y POR QUÉ. Pura, y se llama en las DOS ramas del orquestador: "no salió" nunca puede
 * ser indistinguible de "se perdió". Es la mitad del instrumento que hace falsificable todo esto.
 *
 * Los dos motivos que faltan acá —`modelo-caido` y `voz-inventada`— los sabe el orquestador, que es
 * quien llama al modelo y quien corre `revisarRespuesta`.
 */
export function loQueSeCallo(
  estado: EstadoParaSlack,
  memoria: MemoriaSlack | null,
  ahoraISO: string,
  relevancia?: Relevancia
): Tapado[] {
  const mem = memVacia(memoria);
  const e = vista(estado, mem, ahoraISO);

  const { pasaron, tapados } = candidatas(e, mem, ahoraISO);
  const out: Tapado[] = [...tapados];
  // LO QUE PASÓ TODAS LAS PUERTAS Y AUN ASÍ NO SALIÓ, porque otra ocupó el mensaje. Se declara una
  // por una y con su texto: sin esto, un DAÑO tapado por otro DAÑO era invisible para el instrumento
  // que existe justamente para medir cuánto se calla.
  const dichas = new Set(loQueSeDice(pasaron).map((c) => c.r.id));
  for (const c of pasaron) if (!dichas.has(c.r.id)) out.push({ motivo: "otra-regla-gano", clave: c.r.id, texto: c.texto });
  const ganoUnaRegla = dichas.size > 0;

  // Las novedades sin plantilla se nombran una por una: un campo huérfano en el retrato tiene que
  // poder verse, o alguien agrega una clave al retrato y nadie se entera de que no se anuncia nunca.
  for (const n of estado.novedades ?? []) if (!tienePlantilla(n)) out.push({ motivo: "sin-plantilla", clave: n.clave });

  const p = presupuestoDeAvances(estado.novedades ?? [], mem, ahoraISO);
  const h = huellaDeLaVuelta(e, mem, ahoraISO);
  if (h) {
    const abierta = dejaSalir(relevancia?.tabla, h.par);
    if (ganoUnaRegla) out.push({ motivo: "regla-gana", clave: h.par, texto: h.aviso.texto });
    else if (!abierta) out.push({ motivo: "clase-huella", clave: h.par, texto: h.aviso.texto });
    else if (relevancia?.sombra) out.push({ motivo: "sombra", clave: h.par, texto: h.aviso.texto });
  }
  // EL SOBRANTE, AGREGADO Y NO UNO POR UNO. En una vuelta mala son 58 dominios × 4 campos y un
  // renglón de log con 230 claves no lo lee nadie — que es otra forma de perderlo en silencio. Se
  // dice CUÁNTAS quedaron y por cuál de los dos frenos; el detalle está en el retrato persistido, que
  // es reproducible con `novedades()`.
  if (p.tapados > 0) out.push({ motivo: p.elegida ? "clase-huella" : "presupuesto", clave: `${p.tapados} huellas más` });
  return out;
}

/** Actualiza la memoria después de hablar (o de callarse). */
export function recordarAviso(
  estado: EstadoParaSlack,
  hablo: boolean,
  ahoraISO: string,
  memoria: MemoriaSlack | null,
  aviso?: Aviso | null
): MemoriaSlack {
  const mem = memVacia(memoria);
  // El emisor y los dos contadores se recuerdan SIEMPRE, se haya hablado o no: si no, el primer
  // cambio después de un silencio se reportaría contra un estado viejísimo, y las reglas que
  // cuentan vueltas (c1, dec1) no podrían contar nada.
  const base: MemoriaSlack = {
    ...mem,
    ultimoEmisor: estado.emisor ?? mem.ultimoEmisor,
    vueltasSinLecturaUtil: sinLecturaUtil(estado) ? (mem.vueltasSinLecturaUtil ?? 0) + 1 : 0,
    vueltasEmisorFrenado: estado.emisor && estado.emisor !== "send" ? (mem.vueltasEmisorFrenado ?? 0) + 1 : 0
  };

  // EL ENFRIAMIENTO, en un solo mapa para las dos familias: la huella se anota por su clave del
  // retrato, la regla por `regla:<id>`. Se PODAN las claves ya frías al escribir: son 58 dominios ×
  // 4 campos y sin poda el mapa crece hasta ~230 entradas en un JSON que `updateInventoryJson`
  // re-serializa entero bajo lock cada 10 minutos.
  const anotar = (...claves: string[]): Record<string, string> => ({
    ...Object.fromEntries(
      Object.entries(base.novedadesRecientes ?? {}).filter(([k]) =>
        enfriando(base.novedadesRecientes, k, ahoraISO, k.startsWith("regla:") ? HORAS_PARA_REPETIR * 60 : MINUTOS_ENTRE_AVANCES_MISMA_CLAVE)
      )
    ),
    ...Object.fromEntries(claves.map((c) => [c, ahoraISO]))
  });

  if (!hablo || !aviso) return { ...base, ultimoAviso: mem.ultimoAviso, ultimaFirma: mem.ultimaFirma };

  if (aviso.clase === "huella") {
    // UNA HUELLA NO TOCA EL RELOJ DE LOS PROBLEMAS. Lleva su propia memoria (enfriamiento + contador
    // diario) y deja `ultimoAviso`/`ultimaFirma` intactos. No es prolijidad: si pisara
    // `ultimaFirma`, una regla de decisión volvería a interrumpir en la vuelta siguiente; y si
    // pisara `ultimoAviso`, una huella cada tanto correría para adelante el reloj de las 6 h y un
    // problema que persiste se dejaría de repetir. El goteo y el olvido tienen relojes distintos.
    const dia = diaUTC(ahoraISO);
    return {
      ...base,
      avancesHoy: (base.diaAvances === dia ? (base.avancesHoy ?? 0) : 0) + 1,
      diaAvances: dia,
      ...(aviso.avance ? { novedadesRecientes: anotar(aviso.avance) } : {})
    };
  }

  // TODAS las reglas que hablaron, no sólo la que da el título. Cuando dos daños viajan en el mismo
  // mensaje, el acompañante tiene que quedar enfriado igual: si no, en la vuelta siguiente sale solo
  // repitiendo lo que ya se leyó. `reglas` está siempre presente desde `decidirSiHablar`; el fallback
  // cubre a quien arme un Aviso a mano (los tests, el cierre de una promesa).
  const hablaron = aviso.reglas ?? [{ id: aviso.regla, ...(aviso.firmaDelHecho !== undefined ? { firmaDelHecho: aviso.firmaDelHecho } : {}) }];
  // La firma del hecho NO se poda con el tiempo, al revés que el enfriamiento: es lo que hace que un
  // estado permanente se diga UNA vez. Podarla sería volver a los 4 mensajes diarios.
  const firmas = Object.fromEntries(
    hablaron.flatMap((r) => (r.firmaDelHecho !== undefined ? [[r.id, r.firmaDelHecho]] : []))
  );
  return {
    ...base,
    novedadesRecientes: anotar(...hablaron.map((r) => claveDeRegla(r.id))),
    ...(Object.keys(firmas).length > 0 ? { dichoPorRegla: { ...(base.dichoPorRegla ?? {}), ...firmas } } : {}),
    ultimoAviso: ahoraISO,
    ultimaFirma: aviso.firma ?? firma(estado)
  };
}

/**
 * Manda el mensaje. Falla suave: que Slack esté caído no puede tumbar al agente.
 *
 * DEVUELVE EL `ts`, y es el cable que faltaba. Se venía descartando la respuesta de
 * `chat.postMessage`, y sin ese identificador es literalmente imposible saber a qué mensaje
 * PROACTIVO contestó el jefe: `leerHilo` necesita el ts del hilo. Sin eso, todo el aprendizaje de
 * relevancia es ciego del lado de la respuesta, que es justo el numerador que él no puede falsear.
 */
export async function mandarASlack(
  // El parámetro NO es `Aviso` a propósito: mandar no sabe nada del criterio. Por acá también salen
  // el cierre de una promesa y la respuesta del chat, que no son avisos de la guardia y no tienen
  // —ni deben tener— clase, regla ni llave de decisión. Un `Aviso` completo entra igual.
  aviso: { texto: string; motivo?: string; pideRespuesta?: boolean },
  cfg: { token?: string; canal?: string; threadTs?: string; fetchImpl?: typeof fetch }
): Promise<{ ok: boolean; motivo: string | null; ts: string | null }> {
  if (!cfg.token || !cfg.canal) return { ok: false, motivo: "sin SLACK_BOT_TOKEN o SLACK_CANAL", ts: null };
  const doFetch = cfg.fetchImpl ?? fetch;
  // EL HECHO VINCULANTE VA PRIMERO, y va acá porque este es el ÚNICO embudo por el que sale todo:
  // la respuesta del chat, el aviso de la guardia y el cierre de una promesa. Ponerlo en el
  // orquestador cubriría un carril y dejaría los otros dos, que es el modo de falla que este repo
  // ya pagó tres veces con los marcadores.
  //
  // El 2026-08-07 el mensaje salió como `[cuerpo, ...hechas].join("\n")`: la conclusión del modelo
  // arriba ("esos nodos sirven para montarles dominio nuevo") y el dato que la desmiente 870
  // caracteres abajo, con forma de cola de log. Nadie lee eso después de una conclusión. Invertir
  // el orden no arregla la mentira: le saca el marco. Ver `anotarHechoVinculante`.
  //
  // SOLO DENTRO DE UN HILO, y el corte no es arbitrario: un hecho vinculante existe para que no se
  // pueda decir lo contrario EN LA CONVERSACIÓN donde se midió, y en este orquestador los cuatro
  // llamadores se parten justo por ahí — la respuesta del chat, su aviso de fallo y el cierre de una
  // promesa van con `threadTs`; el aviso PROACTIVO de la guardia sale al canal pelado. Encabezar ese
  // último con el estado de un nodo que nadie mencionó es ruido, y el ruido es la queja 2 del jefe.
  //
  // PERO SE LLAMA IGUAL SIN HILO, y ese fue el arreglo: antes el camino sin hilo salteaba la función
  // entera, así que los hechos que la guardia medía por su cuenta quedaban sin dueño y se los
  // adoptaba el PRÓXIMO hilo del chat. Un barrido de las 03:00 encabezaba la primera conversación de
  // la mañana con un nodo que nadie mencionó. Pasando por acá, la publicación al canal los quema.
  const texto = anteponerHechoVinculante(aviso.texto, cfg.threadTs);
  try {
    const r = await doFetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      // TIMEOUT. Sin esto un POST colgado deja al agente mudo sin decir por qué, que es el modo de
      // falla más caro que tiene: indistinguible de "no había nada que decir".
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${cfg.token}` },
      // threadTs: contestar DENTRO del hilo. Sin esto cada respuesta abre un mensaje suelto y la
      // conversación queda partida — que es literalmente "el agente se pierde".
      body: JSON.stringify({ channel: cfg.canal, text: texto, ...(cfg.threadTs ? { thread_ts: cfg.threadTs } : {}) })
    });
    const data = (await r.json()) as { ok?: boolean; error?: string; ts?: string };
    return data.ok
      ? { ok: true, motivo: null, ts: typeof data.ts === "string" ? data.ts : null }
      : { ok: false, motivo: data.error ?? "slack respondió sin ok", ts: null };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : String(e), ts: null };
  }
}

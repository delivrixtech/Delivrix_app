// EL AGENTE QUE MIRA EL WARMUP 24/7 — sobre el modelo local de la Mac mini.
//
// Por qué local y no un modelo pago: esto corre siempre, y un análisis por API cada pocos minutos
// sería caro sin necesidad. La mini ya está medida (Qwen3.6, 4 contextos en paralelo, costo 0), así
// que el monitoreo continuo no cuesta nada. Ver [[mac-mini-modelo-local-medido]].
//
// La disciplina que hace que esto sirva y no sea un oráculo decorativo:
//   1. El modelo SOLO ve hechos que salieron de la infraestructura real (placement medido, errores
//      del ciclo, consumo del cap, estados de la flota). No se le pide que adivine nada.
//   2. Se le prohíbe explícitamente inventar números: si un dato no está, tiene que decir que no está.
//   3. La lectura se guarda con su fecha y el modelo que la produjo. Una opinión sin fecha ni autor
//      no es evidencia.
//   4. Si la mini no responde, se DECLARA. Nunca se sirve una lectura vieja como si fuera de ahora.

// El veredicto de "¿este frenado puede volver?" se PIDE, no se reescribe. `porQueNoVuelve` es la
// misma función que ejecuta `soltar_dominio`, con los mismos umbrales (MUESTRA_PARA_JUZGAR,
// PISO_PARA_SOLTAR) viviendo en un solo módulo. Si acá se copiaran, el prompt le mostraría al agente
// candidatos que el gate después rechaza: una promesa que se rompe al ejecutarla, que es peor que
// no haberla hecho.
import { porQueNoVuelve } from "./acciones-agente.ts";
import { clave } from "./decisiones-del-jefe.ts";
import type { ReputacionDominio } from "./slack.ts";

/**
 * Un dominio frenado (cap 0) con las tres condiciones de `soltar_dominio` ya evaluadas.
 *
 * `null` NO es `false` en ninguno de estos campos: es "no se miró". La confusión entre las dos
 * cosas es la más cara del sistema (el 2026-07-25, 38 nodos estaban cerrados en Gmail con CERO
 * detecciones de blacklist, y alguien leyó ese cero como "está limpio"). Por eso cada campo
 * distingue los tres estados y las líneas del prompt los dicen con palabras distintas.
 */
export interface FrenadoDetalle {
  dominio: string;
  /** ¿Está en `flota.cruzados`? `null` = no se pudo leer la medición de flota. */
  cruzado: boolean | null;
  /** Receptores que hoy lo rechazan. `[]` = ninguno; `null` = NO se diagnosticó. */
  bloqueanPor: readonly string[] | null;
  /** Mediciones propias de placement. `null` = no se miró; `0` = se miró y no hay ninguna. */
  muestra: number | null;
  tasaInbox: number | null;
}

/** Los hechos que el agente puede mirar. Todos vienen de mediciones reales, ninguno es opinión. */
export interface HechosWarmup {
  generadoEn: string;
  /**
   * ¿El emisor está mandando, o está frenado y por qué? Faltaba, y el agente llegó a reportar
   * "RIESGO: ninguno" con el daemon en placement-pause hacía horas. Sale de `decideDaemonAction`,
   * la MISMA función que decide en el daemon — no de una copia que se puede quedar vieja.
   */
  emisor?: { estado: string; motivo: string; vueltasHoy: number; topeDiario: number } | null;
  semillas: { destinos: number; midiendo: number; puntoCiego: string[] };
  vueltas: Array<{
    dominio: string;
    semilla: string;
    cuando: string;
    placement: string | null;
    completa: boolean;
    error: string | null;
  }>;
  /**
   * `medidoEn` es obligatorio: sin la fecha, el agente reportaba un cap de ayer como si fuera de hoy.
   * NO hay totales de flota: el cap de Postfix es POR NODO y sumarlos producía un "tope diario"
   * inexistente que el agente citó como su conclusión central en 8 de 11 corridas.
   */
  cap: {
    nodosMedidos: number;
    nodosSinMedir: number;
    enElTope: string[];
    /**
     * Los que están en cap 0. Sin esta lista la mano de soltar era decorativa: un dominio frenado
     * no aparece en el plan (el pool excluye cap 0) ni en las vueltas (no manda), así que ninguno
     * llegaba a `dominiosConocidos` y `soltar_dominio` los rechazaba con "no está en el inventario".
     *
     * Sigue siendo `string[]` porque es la lista que arma `dominiosConocidos` en el orquestador
     * (scripts/ops/warmup-monitor.ts, dos sitios). El detalle evaluado viaja al lado, en
     * `frenadosDetalle`. Son dos campos y no uno a propósito acotado: el productor vive en
     * scripts/, que este lote no toca. Cuando el orquestador escriba los dos desde el mismo filtro,
     * esto colapsa a un solo campo.
     */
    frenados?: string[];
    /**
     * Los mismos frenados, pero con las condiciones de `soltar_dominio` YA EVALUADAS por quien
     * produce los hechos (`porQueNoVuelve` de acciones-agente.ts).
     *
     * Por qué el veredicto viene calculado y no se explica en el prompt: hasta hoy la lista de
     * frenados iba con la frase "…y soltar_dominio si alguno califica", o sea el CRITERIO en prosa.
     * Este proyecto ya pagó dos veces lo mismo — un criterio en párrafo el modelo lo devuelve como
     * hallazgo propio, y si es falso lo devuelve con seguridad. El resultado medido: en 31 entradas
     * de bitácora hubo UN solo intento de soltar, y fue contra bizreport-control.com, justo el que
     * cruzó el umbral permanente. Adivinó, en vez de mirar. Ahora mira.
     */
    frenadosDetalle?: readonly FrenadoDetalle[];
    /**
     * Los que están CERCA del umbral permanente Y además tienen el nodo cableado por encima del
     * techo que aguanta un dominio. Con el cap AL LADO del nombre, no solo el nombre: con la lista
     * pelada el aviso decía "tiene el cupo del nodo por encima del techo" y la respuesta textual
     * del jefe fue "No entiendo, es decir ?". Los dos números son lo que lo vuelve accionable.
     */
    porEncimaDelTecho?: readonly { dominio: string; cap: number }[];
    sinLimite: number;
    medidoEn?: string | null;
  } | null;
  /**
   * La última corrida del barrido de reputación, si existe. AUSENTE cuando el archivo no está —
   * nunca `{}` ni `[]`: las reglas que la miran tienen que dar SILENCIO, jamás "está limpio". Es la
   * confusión más cara del sistema, la que dejó leer "0 blacklist" como sano mientras 38 nodos
   * estaban cerrados en Gmail.
   */
  reputacion?: readonly ReputacionDominio[];
  flota: {
    /**
     * ¿El veredicto de salud se calculó con correo NUESTRO? Hoy las 58 bandejas están en modo
     * "todo", así que entra como DATO —el agente puede decir "estoy juzgando salud con correo que
     * no es nuestro"— y nunca como gate: marcarlas no-accionables lo dejaría sin manos.
     */
    atribuido?: boolean | null;
    sanas: number;
    bloqueadas: number;
    atascadas: number;
    cruzados: string[];
    /** EXCLUYE a los que ya cruzaron: estar en las dos listas le hacía contar el mismo dominio dos veces. */
    cerca: string[];
    medidoEn?: string | null;
  } | null;
  /**
   * EL PLAN: qué decidió el motor para cada dominio hoy, con su motivo. Faltaba, y por eso el
   * agente opinaba sobre el volumen sin saber qué se había decidido — describía el pasado y
   * proponía cosas que el sistema ya estaba haciendo.
   */
  plan?: Array<{
    dominio: string;
    diaN: number | null;
    placementTasa: number | null;
    placementMuestra: number;
    /**
     * CON QUÉ PROVEEDOR se midió ese placement. Lo produce el motor (apps/warmup-engine).
     *
     * Sin él, un "83% de inbox" es 83%-en-Gmail presentado como placement a secas: la única semilla
     * que mide hoy es Gmail, y Outlook y Yahoo son punto ciego declarado. Importa porque los
     * umbrales de la receta son DISTINTOS por proveedor (≥95% Gmail, ≥90% Outlook), así que un
     * número sin proveedor no se puede comparar contra su umbral.
     *
     * OPCIONAL y `null` = "no se sabe con qué se midió". Nunca se rellena con un default: mientras
     * el motor no lo emita, las líneas dicen "sin proveedor" y no inventan uno.
     */
    placementProveedor?: string | null;
    /**
     * El veredicto DETERMINISTA de la receta para este dominio, ya evaluado por el motor: si pasa
     * el gate y, si no, CUÁL condición falló.
     *
     * Viene calculado y no explicado: los umbrales viven en una función del motor con su test, no
     * en prosa dentro del prompt. Es la lección que este proyecto pagó dos veces — un criterio en
     * párrafo el modelo lo devuelve como hallazgo propio, y si es falso lo devuelve con seguridad.
     *
     * AUSENTE mientras el motor no lo emita, y ahí el prompt no dice nada del gate: un veredicto
     * inventado sobre el volumen es exactamente lo que no se puede fabricar.
     */
    gate?: { pasa: boolean; falla: string | null } | null;
    cupo: number;
    accion: string;
    motivo: string;
    enviadosHoy: number;
  }>;
  /**
   * Los rechazos YA CLASIFICADOS por origen. Antes se le pasaba la cadena cruda y el agente tenía
   * que deducir de quién era el freno; con "450 daily send cap reached" concluyó "los límites de
   * Gmail" y de ahí "hay que esperar a que se reseteen" — las dos cosas falsas. El texto crudo no
   * alcanza para desambiguar, así que ahora se desambigua antes.
   */
  rechazos?: Array<{ origen: string; cuantos: number; explicacion: string; ejemplo: string }>;
  /**
   * Pendientes ya abiertos, CON su id. Sin esto el agente no podía cerrarlos nunca: la acción
   * `resolver_pendiente` existía en la lista blanca pero él no veía ningún id que pasarle, así que
   * la lista solo crecía.
   */
  pendientesAbiertos?: Array<{ id: string; que: string }>;
  /**
   * El VECINDARIO de cada dominio del pool: cuántos nodos hay en su misma /24 y cuántos NO están
   * sanos. Va como DATO y no como consejo en el prompt, a propósito: un criterio escrito en prosa
   * el modelo lo repite como si fuera un hallazgo (ya pasó con "no se arregla limpiando listas"),
   * mientras que un número al lado del dominio lo obliga a razonar sobre ESTE caso.
   *
   * El criterio nació midiendo: el /24 80.190.75.x tiene 13 nodos y 11 no sanos, 9 de ellos
   * cerrados por el receptor. Un dominio sano ahí adentro empuja contra la corriente, porque los
   * receptores evalúan reputación también por subred.
   */
  vecindarios?: Array<{ dominio: string; subred: string; nodos: number; noSanos: number }>;
  /**
   * Dominios cuyo VOLUMEN por proveedor no se pudo medir. En los 12 nodos Webdock el canal de
   * volumen devuelve vacío, así que ahí la cercanía al umbral permanente NO está medida y un
   * "ratio 0" no prueba nada. Sin esta marca, el agente trata una ausencia de dato como evidencia
   * de que no hay riesgo — que es la confusión más cara del sistema.
   */
  sinMedirVolumen?: string[];
}

export interface LecturaAgente {
  generadoEn: string;
  modelo: string;
  /** El texto del agente. `null` si no se pudo obtener. */
  lectura: string | null;
  /** Por qué no hay lectura. `null` cuando salió bien. */
  motivo: string | null;
  /** Cuánto costó en tokens (el razonamiento del modelo se cobra acá adentro). */
  tokens: { prompt: number; completion: number } | null;
  /** Los hechos exactos sobre los que opinó: sin esto la lectura no es auditable. */
  hechos: HechosWarmup;
  /** La lectura partida y verificada contra los hechos. `null` si no hubo lectura. */
  verificacion?: LecturaEstructurada | null;
}

/**
 * El system prompt del agente. Se EXPORTA porque el dataset de destilación tiene que entrenarse
 * con el mismo: si el maestro responde bajo un prompt y el alumno se entrena bajo otro, se le
 * enseña a contestar una pregunta que nunca le van a hacer.
 */
export const SISTEMA = [
  // ESTE PROMPT VA EN TUTEO, y no es cosmética. El encargo pedía voz colombiana y VOZ (el chat) se
  // reescribió; SISTEMA se quedó 100% en voseo rioplatense — 55 marcas medidas sobre sus literales.
  // Un modelo imita el REGISTRO de sus instrucciones antes que el contenido de la instrucción, y se
  // filtró a lo que el jefe lee por DOS caminos: la clase `avance` publica texto del modelo, y la
  // lectura entera de la guardia entra al prompt del chat por `construirContexto`. Medido en
  // producción: 34 de 1312 líneas del modelo local traen voseo (mirá ×15, revisá ×14, querés ×7,
  // avisame ×4). Los COMENTARIOS del repo siguen en rioplatense a propósito: son el registro del
  // código, no la voz del agente. Lo fija el test de higiene, que corre la regex sobre esta
  // constante y nunca sobre el archivo — así la distinción se sostiene sola.
  "Eres el ingeniero de guardia de la fábrica de dominios de envío de Delivrix. Vives en la Mac",
  "Studio y miras el calentamiento las 24 horas.",
  "",
  "CON QUIÉN HABLAS. Juanes te creó y es tu jefe directo; le hablas de tú y por su nombre. Arriba",
  "de él están AP (Armando J Portillo), Armando J Portillo Senior y Estefanía (Esty). Esaú es",
  "líder técnico, como Juanes: con él hablas de ingeniería de igual a igual.",
  "",
  "FORMATO OBLIGATORIO — exactamente estas cuatro líneas, cada una empezando por su etiqueta:",
  "AHORA: <una sola frase: qué está pasando en este momento>",
  "PORQUE: <una sola frase: el dato concreto que lo explica, citando el número o el nombre>",
  "RIESGO: <una sola frase: qué se rompe si esto sigue así. Si no hay riesgo, escribe: ninguno>",
  "FALTA: <una sola frase: lo único que hace falta para destrabar. Si no falta nada, escribe: nada>",
  "",
  "Y UNA QUINTA LÍNEA, OPCIONAL, que es donde hablas como tú:",
  "VOZ: <lo que le dirías a Juanes por chat, en una sola frase corta>",
  "",
  "Cómo suena tu VOZ: directa, despierta, sin vueltas. Nada de párrafos ni de formalidad.",
  "Por defecto la VOZ cuenta LO QUE HICISTE o lo que estás por hacer — no pide nada:",
  "  'Ya lo frené y quedó en cero.'   'Lo medí, viene bien, sigo.'   'Lo estoy mirando.'",
  "Solo le pides algo a Juanes cuando de verdad no tienes cómo resolverlo tú, y entonces lo dices",
  // EL EJEMPLO ENSEÑABA EL TIC. Decía "'Juanes, esto no lo puedo destrabar yo, mirá X'", o sea que
  // el prompt le mostraba cómo arrancar cada línea con el vocativo — y el modelo aprendió: 71 de las
  // 192 líneas VOZ del log de producción empiezan con "Juanes,". Mientras tanto slack.ts declara el
  // invariante contrario y nadie lo aplicaba. Sacarlo del ejemplo es la mitad barata del arreglo; la
  // que lo sostiene el día que el modelo lo escriba igual es `limpiarParaSlack` en sentinel-chat.ts.
  // Los dos hablan por el mismo canal: ahí ya sabe con quién habla, repetirle el nombre en cada
  // frase es de bot, no de compañero de trabajo.
  "sin rodeos y sin arrancar con su nombre: 'esto no lo puedo destrabar yo, mira X'. Si dudas de si",
  "puedes, MIRA TU LISTA de acciones: si está ahí, es tuyo y no se pide permiso.",
  "Si algo está bien, lo dices corto y sigues. Si algo te preocupa y puedes investigarlo, investígalo",
  "primero y cuenta lo que encontraste — no le pases la duda cruda.",
  "",
  "REGLA DURA DE LA VOZ: no lleva números, ni nombres de dominio, ni datos nuevos. Los hechos van",
  "en las cuatro líneas de arriba, que se verifican una por una. La VOZ es el tono, no la",
  "evidencia. Si quieres decir un dato, dilo arriba.",
  "",
  "REGLAS DURAS:",
  "- Cuatro líneas. Ni una más. Nada antes ni después. Sin viñetas, sin títulos, sin despedidas.",
  "- Cada línea, UNA frase. Si necesitas dos, es que estás explicando de más.",
  "- Toda afirmación tiene que apoyarse en un dato que te di. Si no está en los datos, no existe.",
  "- NUNCA inventes números, nombres de dominio ni fechas.",
  "- No repitas definiciones ni conceptos generales: el operador los conoce. Reporta ESTE momento.",
  "- No propongas algo que los datos muestran que el sistema ya está haciendo.",
  "- Si un dato falta, di que falta. 'No se midió' es una respuesta correcta y útil.",
  "- Si todo está bien, dilo en cuatro líneas igual. No inventes un problema para tener qué decir.",
  "",
  "PUEDES ACTUAR. Después de las cuatro líneas, agrega una línea ACCION por cada cosa que decidas",
  "hacer (ninguna, una, o hasta tres). Formato exacto:",
  "ACCION: <nombre> | dominio=<valor> | motivo=<por qué>",
  "",
  "Las únicas acciones que existen:",
  "- frenar_dominio | dominio=<un dominio de los datos> | motivo=... → le pone cupo 0 en el nodo.",
  "  Úsalo cuando un dominio está haciendo daño: cruzó el umbral permanente, o su placement se",
  "  desplomó. Es reversible.",
  // EL AVISO NO ES DECORATIVO. `frenarDominio` vive detrás de WARMUP_AGENT_PUEDE_FRENAR y el flag
  // está APAGADO por defecto, así que en muchos entornos la mano no existe. Prometida plana, el
  // modelo la pide y le vuelve "no está habilitado": medido en el log de producción, 26 rechazos en
  // 5 horas sobre 31 pedidos del MISMO dominio. Decírselo de entrada convierte el rechazo en un
  // dato en vez de un bucle. Hay un test de contrato que exige esta línea mientras siga bajo flag.
  "  Puede no estar habilitada en este entorno: si te vuelve rechazada por eso, es un dato para",
  "  contar, no un error tuyo — no la repitas.",
  "- pausar_warmup | motivo=... → frena TODO el calentamiento. Solo si el daño es general.",
  "- resolver_pendiente | id=<id de la lista de pendientes> | motivo=... → cierra un pendiente que",
  "  los datos muestran resuelto. Solo si los datos lo muestran: cerrar a ciegas borra trabajo del",
  "  operador.",
  "- leer_cupo_nodo | dominio=<uno de los datos> | motivo=... → va a mirar el nodo AHORA por SSH y",
  "  te dice el cupo real. No cambia nada. Úsala antes de afirmar cómo está un dominio si el dato",
  "  que tienes ya tiene horas.",
  "- diagnosticar_dominio | dominio=<uno del contexto> | motivo=... → lee el registro de correo de",
  "  su nodo y te dice QUIÉN lo está rechazando (Gmail, Yahoo, Outlook) y con qué motivo. Es la",
  "  respuesta a \"por qué este dominio no entrega\". Pasivo: no manda correo. Úsala antes de",
  "  proponer frenar algo, para saber si el problema es del dominio o del receptor.",
  "- medir_dominio | dominio=<cualquier dominio real, esté o no en el plan> | motivo=... → te dice",
  "  dónde viene cayendo su correo y en qué día de rampa está. Pasivo. Sirve sobre todo para los",
  "  dominios que NO figuran en el plan de arriba: de esos no tienes ningún dato, y son justamente",
  "  los que hay que evaluar para ver si están listos para volver.",
  // `revisar_reputacion` VUELVE, y la historia de esta línea vale contarla porque es el proceso
  // funcionando. El equipo que escribió el módulo lo dejó sin cablear; el auditor lo detectó y
  // SACÓ la línea del prompt en vez de dejar una promesa suelta —la falla que este repo ya había
  // pagado dos veces, con 26 rechazos de "frenar no está habilitado" en 5 horas sobre el mismo
  // dominio— y además dejó el test de contrato que exige las dos mitades. Después se cableó la
  // capacidad en el orquestador, así que la condición se cumple y la línea entra.
  //
  // Va SIN la advertencia de "puede no estar habilitada" a propósito: es pasiva (DNS + una consulta
  // de listas) y se cablea sin flag, así que siempre está. El test de contrato verifica justamente
  // eso: si algún día quedara detrás de un flag, exige que esta línea lo diga.
  "- revisar_reputacion | dominio=<uno del inventario> | motivo=... → mira la reputación de su IP y",
  "  su dominio: listas negras, SPF, DKIM, DMARC y el PTR. Pasiva, no manda correo ni cambia nada.",
  "  Úsala antes de soltar un dominio y cuando quieras saber si una IP está limpia.",
  "  DOS AVISOS que cambian cómo se lee el resultado: una lista negra LIMPIA no significa que estés",
  "  entregando —el 2026-07-25 había 38 nodos cerrados en Gmail con cero detecciones de blacklist—,",
  "  y si un chequeo no se pudo hacer devuelve \"no sé\", que NO es lo mismo que \"limpio\".",
  "- bajar_cap_nodo | dominio=<uno del inventario> | motivo=... → le baja el cupo del nodo a 2.000",
  "  por día, que es el techo que aguanta un dominio. No lo apaga: lo acota. Úsalo cuando veas un",
  "  nodo cableado muy por encima de ese techo, en vez de frenarlo: por ese nodo puede estar",
  "  saliendo correo de un cliente y apagarlo sería desproporcionado. Solo BAJA — si ya está en el",
  "  techo o por debajo, se rechaza sola. El número no lo eliges tú.",
  "- soltar_dominio | dominio=<uno frenado> | motivo=... → le devuelve un cupo CHICO para que vuelva",
  "  a calentar. Es la única acción que sube volumen y la única que puede hacer daño de verdad, así",
  "  que antes de pedirla mira: medir_dominio para saber su historia y diagnosticar_dominio para",
  "  saber si hay alguien del otro lado. El cupo no lo eliges tú, es fijo.",
  "  Se rechaza sola si el nodo no está frenado, si algún receptor lo tiene cerrado, o si sus",
  "  mediciones dicen que todavía no está. Un rechazo ahí es información, no un error tuyo.",
  "  Puede no estar habilitada en este entorno; si te vuelve por eso, no la repitas.",
  "- anotar_pendiente | dominio=<qué hace falta, en pocas palabras> | motivo=<por qué> → deja",
  "  asentado algo que tú NO puedes resolver y necesita al operador (una semilla nueva, una",
  "  credencial). Anótalo UNA vez: si ya lo anotaste, no lo repitas.",
  "",
  "REGLAS DE LAS ACCIONES:",
  "- Puedes REDUCIR (frenar, pausar), MIRAR (leer, diagnosticar, medir), SOLTAR",
  "  un dominio frenado, y ANOTAR. No existe ninguna acción que mande correo ni cambie",
  "  configuración: si hace falta algo así, usa anotar_pendiente.",
  "- MIRAR ES GRATIS Y ACTUAR NO. Las tres manos pasivas no tocan nada: úsalas sin pedir permiso y",
  "  sin anunciarlo. Antes de afirmar algo sobre un dominio concreto, ve a mirarlo. Antes de",
  "  proponer frenar o soltar, averigua primero. Un dato de hace horas no es el estado de ahora.",
  "",
  "NO LE PIDAS A JUANES LO QUE PUEDES HACER TÚ. Esta es la regla más importante de todas y la que",
  "más veces rompiste: pasaste una noche entera mandándole 'revisa el nodo', 'confírmame si',",
  "'necesito tu luz', 'mira los cupos' — sobre cosas que están en tu lista de acciones. Él estaba",
  "durmiendo y se despertó con veinticinco mensajes que le pedían trabajo a él.",
  "Antes de escribir cualquier frase que empiece con 'revisa', 'confírmame', 'mira' o 'necesito",
  "que', para y pregúntate: ¿lo puedo hacer yo? Si la respuesta es sí, HAZLO y cuenta el resultado.",
  "",
  "MOLÉSTALO SOLO SI SE CUMPLEN LAS DOS: es grave AHORA, y tú no tienes herramienta para resolverlo.",
  "Ejemplos de lo que SÍ amerita escribirle: falta una semilla y no puedes crearla; una credencial",
  "caducó; hace falta comprar o migrar algo. Ejemplos de lo que NO: querer saber el cupo de un nodo",
  "(léelo), no saber quién rechaza un dominio (diagnostícalo), dudar del placement (mídelo), un",
  "dominio frenado que quizá esté listo (evalúalo y suéltalo si califica).",
  "Si algo no se puede resolver ni por ti ni por él ahora mismo, no es un mensaje: es un pendiente.",
  "- El dominio tiene que aparecer TEXTUAL en los datos que te di. Un nombre inventado se rechaza.",
  "- Si no hay nada que hacer, no escribas ninguna línea ACCION. No actuar es la respuesta correcta",
  "  la mayoría de las veces.",
  "- Nunca frenes algo solo porque tiene pocos datos: falta de medición no es evidencia de daño.",
  "",
  "CRITERIOS PARA DECIDIR (son para razonar, NO para reportar — no los repitas en tus cuatro líneas",
  "salvo que el caso concreto de hoy los active):",
  "- La reputación se evalúa también por SUBRED. Un dominio sano en una /24 donde la mayoría de sus",
  "  vecinos está cerrada por el receptor arranca en desventaja: mira el vecindario antes de opinar",
  "  sobre por qué a un dominio le va mal.",
  "- Un volumen NO MEDIDO no es un volumen bajo. Si un dominio figura entre los que no se pudieron",
  "  medir, no afirmes que está lejos del umbral: di que no se sabe.",
  "- Lo que reconstruye reputación es volumen BAJO con buena señal, no parar del todo. Un dominio",
  "  detenido no se recupera, se queda quieto.",
  // Se BORRÓ el criterio "el tope diario de vueltas es de toda la flota": era factualmente falso
  // —el cap de Postfix es por nodo— y de ahí el modelo sacó la palabra "vueltas" para contar
  // mensajes y construyó con ella su conclusión central en 8 de 11 corridas. Un criterio en prosa
  // el modelo lo devuelve como hallazgo propio; si además es falso, lo devuelve con seguridad.
  "- El límite físico es POR NODO. Un nodo en su tope no frena a los demás: no existe un tope de",
  "  la flota entera, y sumar los caps de los nodos no produce uno.",
  "- El placement es el instrumento del warmup: si un dominio tiene señal buena y muestra",
  "  suficiente, dilo. Un dominio listo para subir volumen es un hallazgo, no solo los problemas."
].join("\n");

/**
 * Las líneas de los dominios frenados, para los DOS carriles: el prompt de la guardia y el contexto
 * del chat. Una sola función porque cuando cada carril armaba su propia lista terminaban diciendo
 * cosas distintas sobre el mismo dominio — y acá el chat directamente no los nombraba nunca.
 *
 * PROHIBIDO en toda línea: imperativos ("deberías", "hay que", "conviene"). Hay un test con regex.
 * Cada línea cita datos guardados y nada más; el juicio lo pone `porQueNoVuelve`, no el texto.
 */
export function lineasDeFrenados(
  cap: HechosWarmup["cap"] | undefined,
  /**
   * La medición de flota, SOLO para llenar `cruzado`. Es el dato que estaba a dos campos de
   * distancia y la función no miraba: nadie escribe `frenadosDetalle` todavía, así que las ocho
   * líneas salían enteras en "sin dato" mientras `hechos.flota.cruzados` traía la lista exacta de
   * los que cruzaron el umbral permanente — justo la condición que rechazó a bizreport-control.com.
   * No cuesta ni un SSH ni una consulta: ya venía en el mismo snapshot.
   *
   * `null`/ausente = la medición no se pudo leer, y entonces `cruzado` queda en `null` = "no sé".
   * Nunca en `false`: ver el gate de `porQueNoVuelve`.
   */
  flota?: HechosWarmup["flota"]
): string[] {
  const detalle = cap?.frenadosDetalle ?? [];
  const nombres = cap?.frenados ?? [];
  if (detalle.length === 0 && nombres.length === 0) return [];

  // Fallback honesto mientras el orquestador no escriba `frenadosDetalle`: se listan igual, pero
  // TODO queda en "sin evaluar". Nunca en "califica" — inventar un veredicto que nadie calculó es
  // exactamente la mano prometida y no cableada que este proyecto ya pagó dos veces.
  const filas: readonly FrenadoDetalle[] =
    detalle.length > 0
      ? detalle
      : nombres.map((d) => ({ dominio: d, cruzado: null, bloqueanPor: null, muestra: null, tasaInbox: null }));

  const cruzados = flota ? new Set(flota.cruzados.map((d) => d.toLowerCase())) : null;
  const cuerpo: string[] = [];
  let evaluadas = 0;
  for (const f of filas) {
    // El detalle manda si vino; si no, se completa con la flota. Sin flota queda `null` = "no sé".
    const cruzado = f.cruzado ?? (cruzados ? cruzados.has(f.dominio.toLowerCase()) : null);
    // Con un dato en `null` NO se llama a `porQueNoVuelve` con un relleno: pasarle `bloqueanPor: []`
    // cuando nadie diagnosticó sería afirmar "ningún receptor lo rechaza" sobre algo que no se miró,
    // y ahí está el error más caro de este sistema (el 2026-07-25: 38 nodos cerrados en Gmail con
    // CERO detecciones de blacklist, y ese cero leído como "limpio").
    //
    // La excepción es `cruzado === true`: esa condición gana sola y no necesita a las otras dos.
    const evaluable = cruzado === true || (f.bloqueanPor !== null && f.muestra !== null);
    const motivo = evaluable
      ? porQueNoVuelve({ cruzado, bloqueanPor: f.bloqueanPor ?? [], muestra: f.muestra ?? 0, tasaInbox: f.tasaInbox })
      : undefined;
    if (motivo !== undefined) evaluadas++;
    const veredicto =
      motivo === undefined
        ? "todavía no se evaluó si puede volver"
        : motivo === null
          ? "califica para soltar_dominio"
          : `no vuelve: ${motivo}`;
    const umbral =
      cruzado === null
        ? "umbral permanente: sin dato"
        : cruzado
          ? "cruzó el umbral permanente"
          : "no cruzó el umbral permanente";
    const receptor =
      f.bloqueanPor === null
        ? "receptores: sin diagnosticar"
        : f.bloqueanPor.length === 0
          ? "receptores: ninguno lo rechaza"
          : `lo rechazan: ${f.bloqueanPor.join(", ")}`;
    const placement =
      f.muestra === null
        ? "placement propio: sin medir"
        : f.tasaInbox === null
          ? `placement propio: ${f.muestra} mediciones, sin tasa`
          : `placement propio ${Math.round(f.tasaInbox * 100)}% sobre ${f.muestra} mediciones`;
    cuerpo.push(`- ${f.dominio}: ${veredicto} · ${umbral} · ${receptor} · ${placement}`);
  }
  // EL ENCABEZADO NO PUEDE AFIRMAR MÁS DE LO QUE HAY DEBAJO. Decía "las condiciones de
  // soltar_dominio ya evaluadas contra los nodos" mientras las ocho líneas salían en "sin dato": una
  // afirmación falsa dentro del prompt, y de las caras — el agente lee que el trabajo ya está hecho
  // y no vuelve a mirar.
  //
  // EL PRIMER ARREGLO NO ALCANZÓ, y el estado real de producción es justamente el caso que dejó
  // pasar: el guard era `algunoEvaluado` (ALGUNA fila), y bizreport-control.com saca veredicto solo
  // —está en `flota.cruzados`, el atajo `cruzado === true` no necesita ni SSH ni Postgres— así que
  // UNA fila daba vuelta el encabezado a "ya evaluadas" mientras las otras SIETE decían "todavía no
  // se evaluó · receptores: sin diagnosticar · placement propio: sin medir". Verificado contra el
  // warmup-monitor.json real de las 23:45Z: 1 de 8.
  //
  // Por eso son TRES encabezados y el del medio lleva el número: un "3 de 8" no se puede leer como
  // "está hecho". El agente tiene que poder distinguir "ya lo miré y no califica" de "todavía nadie
  // lo miró", que es exactamente la diferencia entre los 7 vírgenes y el dominio quemado.
  const total = filas.length;
  return [
    evaluadas === total
      ? "FRENADOS (cupo 0, no están calentando). Al lado de cada uno, las condiciones de soltar_dominio ya evaluadas contra los nodos:"
      : evaluadas === 0
        ? "FRENADOS (cupo 0, no están calentando). Sus condiciones de soltar_dominio TODAVÍA NO se evaluaron:"
        : `FRENADOS (cupo 0, no están calentando). ${evaluadas} de ${total} con sus condiciones de soltar_dominio evaluadas; a los otros ${total - evaluadas} todavía no los miró nadie:`,
    ...cuerpo
  ];
}

/**
 * Junta los reparos que son LA MISMA LECCIÓN con distinto dominio o número. Devuelve el texto
 * completo del primero de cada clase, con su contador.
 *
 * Medido en el archivo real: las 5 ranuras de "ERRORES QUE YA COMETISTE" estaban ocupadas por la
 * misma lección cinco veces —"nombra X, que no está en los datos"— con cinco dominios distintos. O
 * sea que la memoria de errores tenía capacidad para UNA lección, y cualquier reparo de otra clase
 * quedaba empujado afuera por el `slice`. Con el contador dice más en menos lugar: cinco veces la
 * misma equivocación es un dato más fuerte que cinco renglones casi iguales.
 *
 * La clase se calcula normalizando dominios y números y pasando por `clave()`, el mismo
 * normalizador que usa `esLaMisma` — una copia local se desincroniza y empieza a agrupar distinto.
 */
export function agruparReparos(reparos: readonly string[]): string[] {
  const grupos = new Map<string, { texto: string; veces: number }>();
  for (const r of reparos) {
    const k = clave(r.replace(/\b[a-z0-9][a-z0-9-]*\.(com|net|org|app|io|co)\b/gi, " X ").replace(/\d+/g, " N "));
    const g = grupos.get(k);
    if (g) g.veces += 1;
    else grupos.set(k, { texto: r, veces: 1 });
  }
  return [...grupos.values()].map((g) => (g.veces > 1 ? `${g.texto} (te pasó ${g.veces} veces, con distintos nombres)` : g.texto));
}

/** Arma el pedido. Puro: se puede testear sin red. */
export function construirPrompt(
  hechos: HechosWarmup,
  erroresPrevios: readonly string[] = [],
  loQueHiciste: readonly string[] = [],
  decisiones: readonly string[] = []
): string {
  const l: string[] = [];
  // MEMORIA: los reparos que la verificación le encontró en corridas anteriores. No se puede
  // reentrenar el modelo, pero sí mostrarle en qué se equivocó — que es la forma barata y honesta
  // de que no repita el mismo error. Nace del caso real: atribuyó a Gmail un freno nuestro, y sin
  // esto lo habría vuelto a hacer cada 10 minutos para siempre.
  if (erroresPrevios.length > 0) {
    l.push("ERRORES QUE YA COMETISTE ANTES sobre estos mismos datos. No los repitas:");
    // AGRUPADOS POR CLASE: las 5 ranuras las ocupaba la MISMA lección con 5 dominios distintos, así
    // que la memoria de errores tenía capacidad para una sola y el resto quedaba afuera del slice.
    for (const e of agruparReparos(erroresPrevios).slice(0, 5)) l.push(`- ${e}`);
    l.push("");
  }
  // LO QUE PEDISTE ANTES Y QUÉ PASÓ. Va como HECHO sobre sus propias acciones, no como consejo:
  // "pediste X 10 veces y no se ejecutó" es un dato verificable, no un criterio que pueda repetir
  // como hallazgo propio. Es lo único que corta el bucle de pedir siempre lo mismo.
  if (loQueHiciste.length > 0) {
    l.push("LO QUE YA PEDISTE, Y QUÉ PASÓ CON CADA COSA:");
    for (const x of loQueHiciste.slice(0, 8)) l.push(x);
    l.push("Si algo ya lo pediste y te lo negaron, NO lo vuelvas a pedir: busca otra salida o di qué hace falta para destrabarlo.");
    l.push("");
  }
  // Las decisiones del jefe van ANTES que los hechos: si un hecho dice "falta una semilla en
  // outlook" y el jefe ya dijo "arreglate con las dos que hay", manda lo que decidió el jefe.
  if (decisiones.length > 0) {
    for (const d of decisiones) l.push(d);
    l.push("");
  }
  l.push(`Momento: ${hechos.generadoEn}`);
  l.push(
    `Semillas (buzones nuestros de prueba): ${hechos.semillas.destinos} reciben correo, ${hechos.semillas.midiendo} pueden medir dónde cayó.` +
      (hechos.semillas.puntoCiego.length > 0
        ? ` PUNTO CIEGO: no tenemos semilla en estos PROVEEDORES (no son dominios nuestros): ${hechos.semillas.puntoCiego.join(", ")} — o sea, no sabemos dónde cae nuestro correo ahí.`
        : "")
  );

  // EL PRIMER HECHO: ¿está mandando o no? Todo lo demás se lee distinto según la respuesta.
  if (hechos.emisor) {
    const e = hechos.emisor;
    l.push(
      e.estado === "send"
        ? `EMISOR: ACTIVO, mandando. Vueltas hoy ${e.vueltasHoy}/${e.topeDiario}.`
        : `EMISOR: NO ESTÁ MANDANDO (${e.estado}) — ${e.motivo}. Vueltas hoy ${e.vueltasHoy}/${e.topeDiario}.`
    );
  } else {
    l.push("EMISOR: no pude leer si está mandando.");
  }

  if (hechos.cap) {
    const edad = hechos.cap.medidoEn ? (Date.now() - Date.parse(hechos.cap.medidoEn)) / 3_600_000 : null;
    // Se informa COBERTURA de la medición, no un total: el cap es por nodo y sumarlo inventaba
    // un "tope de flota" que no existe. Y los nodos sin medir se dicen como sin medir, no como 0.
    l.push(
      `Límite físico${edad !== null && Number.isFinite(edad) ? ` (medido hace ${edad.toFixed(1)}h${edad > 12 ? ", VENCIDO" : ""})` : " (sin fecha de medición)"}: ` +
        `es un tope POR NODO, no de la flota; un nodo en su tope no frena a los demás. ` +
        `${hechos.cap.nodosMedidos} nodos con consumo medido, ${hechos.cap.nodosSinMedir} SIN medir.` +
        (hechos.cap.enElTope.length > 0 ? ` En su tope: ${hechos.cap.enElTope.join(", ")}.` : "") +
        (hechos.cap.sinLimite > 0 ? ` ${hechos.cap.sinLimite} nodos SIN límite puesto.` : "")
    );
  } else {
    l.push("Límite físico: sin lectura.");
  }

  // Los frenados salen del renglón del cap y pasan a tener una línea por dominio, con su veredicto
  // ya calculado. Antes iban como una enumeración seguida de "…y soltar_dominio si alguno califica"
  // —el criterio en PROSA— y el resultado medido fue que en 31 entradas de bitácora hubo un solo
  // intento de soltar, contra el único dominio que había cruzado el umbral permanente.
  //
  // La flota va como segundo argumento y no es un detalle: es de donde sale `cruzado`. Sin ella las
  // ocho líneas salían en "umbral permanente: sin dato" con la lista de cruzados a dos campos de
  // distancia en el mismo objeto.
  for (const x of lineasDeFrenados(hechos.cap, hechos.flota)) l.push(x);

  if (hechos.flota) {
    const edadF = hechos.flota.medidoEn ? (Date.now() - Date.parse(hechos.flota.medidoEn)) / 3_600_000 : null;
    l.push(
      `Flota${edadF !== null && Number.isFinite(edadF) ? ` (medida hace ${edadF.toFixed(1)}h${edadF > 12 ? ", VIEJA: no la reportes como el estado de ahora" : ""})` : " (sin fecha de medición)"}: ` +
        `${hechos.flota.sanas} entregan, ${hechos.flota.bloqueadas} cerradas por el receptor, ${hechos.flota.atascadas} con la cola atascada.` +
        (hechos.flota.cruzados.length > 0
          ? ` CRUZARON el umbral permanente (irreversible): ${hechos.flota.cruzados.join(", ")}.`
          : "") +
        (hechos.flota.cerca.length > 0 ? ` Cerca del umbral (ninguno de estos cruzó todavía): ${hechos.flota.cerca.join(", ")}.` : "")
    );
  } else {
    l.push("Flota: sin medición.");
  }

  // EL PLAN va primero: es la decisión que el sistema ya tomó. Sin esto el agente opinaba sobre el
  // volumen a ciegas y proponía cosas que el motor ya estaba haciendo.
  if (hechos.plan && hechos.plan.length > 0) {
    l.push("Decisión de HOY, por dominio (esto ya está decidido y en curso):");
    for (const p of hechos.plan) {
      // EL PLACEMENT NUNCA SIN SU PROVEEDOR. Hoy la única semilla que mide es Gmail, así que un
      // "83%" a secas es 83%-en-Gmail disfrazado de placement general — y los umbrales de la receta
      // son distintos por proveedor. Mientras el motor no emita el campo se dice "sin proveedor",
      // que es la verdad; nunca se rellena con "Gmail" por ser el único que hay.
      const proveedor = p.placementProveedor ?? null;
      l.push(
        `- ${p.dominio}: ${p.accion}, cupo ${p.cupo}/día (lleva ${p.enviadosHoy}) · día ${p.diaN ?? "?"} · ` +
          (p.placementTasa === null
            ? `placement SIN MEDIR (${p.placementMuestra} mediciones)`
            : `placement ${proveedor ?? "sin proveedor"} ${Math.round(p.placementTasa * 100)}% sobre ${p.placementMuestra} mediciones`) +
          // El gate solo se nombra si alguien lo evaluó. Ausente = silencio, jamás "pasa".
          (p.gate ? ` · gate: ${p.gate.pasa ? "PASA" : `NO pasa (${p.gate.falla ?? "sin detalle"})`}` : "") +
          ` · motivo: ${p.motivo}`
      );
    }
  } else {
    // Distingue "no se pudo leer" de "se leyó y no hay dominios": con el mismo texto, el agente
    // reportaba un fallo de lectura cuando en realidad no había nada que calentar.
    l.push(
      hechos.plan
        ? "Decisión de hoy: ningún dominio en calentamiento (el pool está vacío)."
        : "Decisión de hoy: NO se pudo leer el plan."
    );
  }

  // Los rechazos YA clasificados: de quién es cada freno. La cadena cruda no alcanza — con
  // "450 daily send cap reached" el agente concluyó "los límites de Gmail", que es falso.
  if (hechos.rechazos && hechos.rechazos.length > 0) {
    l.push("Rechazos recientes, ya clasificados por origen:");
    for (const r of hechos.rechazos) {
      l.push(`- ${r.cuantos}× ${r.origen}: ${r.explicacion}`);
    }
  }

  if ((hechos.vecindarios ?? []).length > 0) {
    l.push("Vecindario de cada dominio que calienta (nodos en su misma subred /24, y cuántos NO están sanos):");
    for (const v of hechos.vecindarios ?? []) {
      l.push(`- ${v.dominio}: subred ${v.subred}.x — ${v.nodos} nodos, ${v.noSanos} NO sanos`);
    }
  }
  if ((hechos.sinMedirVolumen ?? []).length > 0) {
    l.push(
      `Dominios cuyo VOLUMEN por proveedor NO se pudo medir (el dato no existe, no es un cero): ${(hechos.sinMedirVolumen ?? []).join(", ")}.`
    );
  }

  if ((hechos.pendientesAbiertos ?? []).length > 0) {
    l.push(
      "Pendientes que YA anotaste (no los vuelvas a anotar; ciérralos con resolver_pendiente si los" +
        ` datos muestran que se resolvieron): ${(hechos.pendientesAbiertos ?? []).map((p) => `${p.id} · ${p.que}`).join(" ; ")}`
    );
  }

  if (hechos.vueltas.length === 0) {
    l.push("Vueltas de calentamiento: ninguna registrada.");
  } else {
    l.push("Últimas vueltas de calentamiento:");
    for (const v of hechos.vueltas.slice(0, 8)) {
      l.push(
        `- ${v.cuando} · ${v.dominio} → ${v.semilla} · ` +
          (v.placement ? `cayó en ${v.placement}` : "sin placement medido") +
          (v.completa ? " · ciclo completo" : "")
      );
    }
  }

  l.push("");
  l.push("Reporta el estado en las cuatro líneas del formato.");
  l.push(
    // ESTAS TRES LÍNEAS SON LAS ÚLTIMAS QUE EL MODELO LEE ANTES DE ESCRIBIR, y estaban en voseo
    // mientras SISTEMA —en el mismo archivo— ya estaba castellanizado entero. La premisa del lote es
    // que el modelo imita el REGISTRO de sus instrucciones: dárselo en porteño en el renglón final
    // es la peor posición posible. La aceptación no lo vio porque grepeaba un rango de líneas que
    // sólo cubría la constante SISTEMA; el test ahora corre sobre la SALIDA de esta función.
    "Después, si hay algo que hacer, agrega una línea ACCION por cada cosa (máximo 3). Si lo que" +
      " falta no lo puedes resolver tú, anótalo con anotar_pendiente en vez de repetirlo. Si no hay" +
      " nada que hacer, no escribas ninguna línea ACCION."
  );
  return l.join("\n");
}

/** La lectura partida en sus cuatro campos. `null` en un campo = el modelo no respetó el formato. */
export interface LecturaEstructurada {
  ahora: string | null;
  porque: string | null;
  riesgo: string | null;
  falta: string | null;
  /**
   * LA VOZ: cómo lo diría hablándole a Juanes. Es lo único que NO se verifica contra los hechos —
   * a propósito. Darle personalidad metiéndola en los campos verificables sería reabrir el bug que
   * costó caro: el modelo devolviendo criterio como si fuera hallazgo. Acá el "qué" sigue siendo
   * dato contrastado, y el "cómo lo dice" es libre.
   *
   * Regla que sí se controla: la voz no puede traer números ni dominios (ver `estilo`). Si trae un
   * dato, ese dato no pasó por ninguna verificación.
   */
  voz: string | null;
  /**
   * Observaciones sobre la VOZ. NO son reparos: no bloquean acciones ni marcan la lectura como no
   * confiable. Separarlos es lo que permite tener personalidad sin debilitar el gate.
   */
  estilo: string[];
  /**
   * Problemas detectados en la propia respuesta. Vacío = la lectura se puede mostrar tal cual.
   * NO se corrige el texto: se muestra con la advertencia. Editarle la salida al modelo esconde
   * que se está portando mal, que es justo lo que hay que ver para arreglarlo.
   */
  reparos: string[];
}

/**
 * Parte la lectura en sus cuatro líneas y la CONTRASTA contra los hechos.
 *
 * Por qué no alcanza con pedírselo en el prompt: se lo pedimos antes ("usá solo los datos que te
 * doy") y aun así afirmó que el freno era de Gmail. Una regla en el prompt es una intención; esto
 * es una verificación. Lo que no se sostiene se marca y el operador lo ve marcado.
 */
export function verificarLectura(
  texto: string,
  hechos: HechosWarmup,
  /**
   * LAS LÍNEAS DE SU PROPIA BITÁCORA, las mismas que `construirPrompt` le entrega arriba.
   *
   * El incidente, 3 de 51 vueltas del log de producción: `construirPrompt` le pasa "LO QUE YA
   * PEDISTE" CON el nombre del dominio adentro ("- pediste diagnosticar_dominio bizregistry-ops.com
   * 34 veces y NO se ejecutó…"), el agente lo nombra —porque se lo dimos NOSOTROS— y acá se le
   * marcaba como invención, porque `conocidos` se armaba solo desde `hechos`. Como el runner
   * ejecuta únicamente con `reparos.length === 0`, el agente perdía las manos esa vuelta entera por
   * citar un dato que le entregamos.
   *
   * Es la TERCERA instancia de una clase que este mismo archivo declara peor que el error que
   * previene: un reparo falso bloquea las acciones correctas y entrena al operador a ignorar los
   * reparos.
   */
  loQueHiciste: readonly string[] = []
): LecturaEstructurada {
  // Los dos puntos son opcionales: el modelo escribe "PORQUE el 75%..." tan seguido como
  // "PORQUE: el 75%...". Rechazar por eso marcaría como "fuera de formato" una respuesta
  // perfectamente estructurada, y un reparo que salta por puntuación entrena al operador a
  // ignorar los reparos — que es lo contrario de para qué existen.
  const linea = (etiqueta: string): string | null => {
    const m = texto.match(new RegExp(`^\\s*\\*{0,2}${etiqueta}\\*{0,2}\\s*:?\\s*(.+)$`, "im"));
    return m?.[1]?.trim() || null;
  };
  const out: LecturaEstructurada = {
    ahora: linea("AHORA"),
    porque: linea("PORQUE"),
    riesgo: linea("RIESGO"),
    falta: linea("FALTA"),
    voz: linea("VOZ"),
    estilo: [],
    reparos: []
  };

  // La voz se mira, pero sus observaciones NO entran a `reparos`: un problema de tono no puede
  // impedir que el agente actúe sobre un análisis correcto.
  if (out.voz) {
    if (/\d/.test(out.voz)) out.estilo.push("la voz trae números: los datos van en las cuatro líneas, que sí se verifican");
    if (/\b[a-z0-9][a-z0-9-]*\.(com|net|org|app|io|co)\b/i.test(out.voz)) out.estilo.push("la voz nombra un dominio: eso va arriba, donde se contrasta");
    if (out.voz.length > 180) out.estilo.push("la voz es larga: una frase corta, no un párrafo");
  }

  if (!out.ahora || !out.porque) out.reparos.push("no respetó el formato de cuatro líneas");

  const cuerpo = [out.ahora, out.porque, out.riesgo, out.falta].filter(Boolean).join(" ");

  // 1. Dominios inventados. Cualquier dominio nombrado tiene que estar en los hechos.
  const conocidos = new Set<string>([
    ...(hechos.plan ?? []).map((p) => p.dominio.toLowerCase()),
    ...hechos.vueltas.map((v) => v.dominio.toLowerCase()),
    ...(hechos.flota?.cruzados ?? []).map((d) => d.toLowerCase()),
    ...(hechos.flota?.cerca ?? []).map((d) => d.toLowerCase()),
    ...(hechos.cap?.enElTope ?? []).map((d) => d.toLowerCase()),
    ...(hechos.cap?.frenados ?? []).map((d) => d.toLowerCase()),
    ...(hechos.cap?.frenadosDetalle ?? []).map((f) => f.dominio.toLowerCase()),
    ...hechos.vueltas.map((v) => v.semilla.toLowerCase()),
    // Lo que le dimos en SU PROPIA bitácora también es un dato que le dimos. Ver el comentario del
    // parámetro: sin esta línea, nombrar lo que nosotros escribimos en el prompt era "inventar".
    ...loQueHiciste.flatMap((l) => (l.match(/\b[a-z0-9][a-z0-9-]*\.(com|net|org|app|io|co)\b/gi) ?? []).map((d) => d.toLowerCase()))
  ]);
  // Proveedores que el agente puede nombrar como concepto (Gmail, Outlook…), no como dominio nuestro.
  const PROVEEDORES = new Set(["gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "icloud.com"]);
  for (const d of cuerpo.match(/\b[a-z0-9][a-z0-9-]*\.(com|net|org|app|io|co)\b/gi) ?? []) {
    const bajo = d.toLowerCase();
    if (!conocidos.has(bajo) && !PROVEEDORES.has(bajo) && ![...conocidos].some((c) => c.includes(bajo))) {
      out.reparos.push(`nombra "${d}", que no está en los datos`);
    }
  }

  // 2. La confusión que originó todo esto: atribuirle a un proveedor un freno que es NUESTRO.
  // PRESENCIA, no exclusividad. Con `.every` bastaba UN solo rechazo de receptor en la ventana
  // para desarmar el chequeo: verificado con los datos reales del 2026-08-04 (6 frenos propios + 1
  // de receptor), la frase textual que originó todo este módulo —"está bloqueado por los límites
  // diarios de Gmail"— volvía a pasar limpia. Y como el runner ejecuta acciones solo cuando no hay
  // reparos, además habilitaba a actuar sobre ese razonamiento falso.
  const hayFrenoPropio = (hechos.rechazos ?? []).some((r) => r.origen === "freno_propio");
  if (hayFrenoPropio && /l[íi]mite[s]? (diario[s]?|de env[íi]o)? ?de (gmail|google|outlook|yahoo)/i.test(cuerpo)) {
    out.reparos.push("atribuye a un proveedor un freno que en los datos figura como nuestro cap de Postfix");
  }

  // 3. El conteo de dominios que CRUZARON el umbral permanente. Es el número más caro del sistema
  //    —cruzarlo es irreversible— así que exagerarlo asusta al operador con algo que no pasó, y
  //    minimizarlo esconde daño real. Se chequea contra la lista exacta de los hechos.
  const cruzados = hechos.flota?.cruzados.length ?? null;
  if (cruzados !== null) {
    const NUM: Record<string, number> = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
    // El `(?!\s*o\s)` evita el falso positivo visto en producción: el agente escribió "5 ya
    // cruzaron O ROZAN el umbral", que junta dos grupos en una frase y es impreciso, no inventado.
    // La distinción importa porque un reparo BLOQUEA todas las acciones de esa vuelta, incluidas
    // las correctas: marcar imprecisiones como falsedades entrena a desconfiar del verificador y
    // deja al agente sin manos por un problema de redacción.
    const m = cuerpo.match(/\b(\d+|un|uno|una|dos|tres|cuatro|cinco|seis)\s+(?:dominios?\s+)?(?:ya\s+)?(?:lo\s+)?cruzar\w*(?!\s*o\s)/i);
    const ambiguo = /cruzar\w*\s+o\s+(rozan|est[áa]n|se acercan)/i.test(cuerpo);
    const dicho = m ? (NUM[m[1]!.toLowerCase()] ?? Number(m[1])) : null;
    if (!ambiguo && dicho !== null && Number.isFinite(dicho) && dicho !== cruzados) {
      out.reparos.push(`dice que cruzaron ${dicho} dominios y los datos dicen ${cruzados}`);
    }
  }

  // 4. Atribuirle a un dominio conocido un cruce del umbral que los datos NO dicen. Es la
  //    afirmación más cara del sistema, y hasta acá solo se chequeaba el CONTEO, no el nombre.
  const cruzadosReales = new Set((hechos.flota?.cruzados ?? []).map((d) => d.toLowerCase()));
  for (const d of cuerpo.match(/\b[a-z0-9][a-z0-9-]*\.(com|net|org|app|io|co)\b/gi) ?? []) {
    const bajo = d.toLowerCase();
    if (!conocidos.has(bajo)) continue;
    const cerca = cuerpo.slice(Math.max(0, cuerpo.toLowerCase().indexOf(bajo) - 40), cuerpo.toLowerCase().indexOf(bajo) + bajo.length + 90);
    if (/cruz\w*\s+(el\s+)?umbral|super\w*\s+(el\s+)?umbral/i.test(cerca) && !cruzadosReales.has(bajo) && !/o\s+(rozan|est[áa]n)/i.test(cerca)) {
      out.reparos.push(`dice que ${d} cruzó el umbral y no figura entre los cruzados`);
    }
  }

  // 5. Un porcentaje de placement citado que no coincide con ninguno de los que le dimos.
  //
  // OJO: las tasas válidas NO son solo las del plan. El hecho `emisor` trae su propio porcentaje
  // en el motivo ("inbox 33% < piso 50%") y viene de decideDaemonAction, o sea que es tan real
  // como cualquier otro. Sin incluirlo, el verificador marcaba como inventado un número que
  // nosotros mismos le pasamos — un reparo FALSO. Y un reparo falso hace dos daños: le bloquea
  // las manos al agente (con reparos no ejecuta nada) y entrena al operador a ignorar los reparos,
  // que es lo contrario de para qué existen. Pasó en producción el 2026-08-06.
  const tasas = new Set((hechos.plan ?? []).filter((p) => p.placementTasa !== null).map((p) => Math.round((p.placementTasa ?? 0) * 100)));
  for (const m of (hechos.emisor?.motivo ?? "").matchAll(/(\d{1,3})\s?%/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) tasas.add(n);
  }
  if (tasas.size > 0) {
    for (const m of cuerpo.matchAll(/(\d{1,3})\s?%\s*(?:de\s+)?(?:placement|inbox|bandeja)|placement\s+(?:del?\s+)?(\d{1,3})\s?%/gi)) {
      const n = Number(m[1] ?? m[2]);
      if (Number.isFinite(n) && !tasas.has(n)) {
        out.reparos.push(`cita un placement de ${n}% que no coincide con ninguno de los datos (${[...tasas].join("%, ")}%)`);
      }
    }
  }

  // 6. Afirmar que algo se midió cuando no hay muestra.
  const sinMuestra = (hechos.plan ?? []).length > 0 && (hechos.plan ?? []).every((p) => p.placementMuestra === 0);
  if (sinMuestra && /placement (del|de) \d+ ?%|\d+ ?% de (inbox|bandeja)/i.test(cuerpo)) {
    out.reparos.push("cita un placement medido cuando no hay ninguna medición");
  }

  return out;
}

export interface PedirLecturaInput {
  hechos: HechosWarmup;
  /** Reparos de corridas anteriores. Es la memoria del agente: se le muestran para que no repita. */
  erroresPrevios?: readonly string[];
  /** Qué acciones pidió antes y en qué terminaron. Ver bitacora-acciones.ts. */
  loQueHiciste?: readonly string[];
  /** Lo que el jefe ya decidió. Gana sobre los hechos que lo contradigan. */
  decisiones?: readonly string[];
  baseUrl: string;
  modelo: string;
  /**
   * Bearer para APIs que lo piden (Kimi/Moonshot, OpenAI, cualquiera compatible). La mini con
   * LM Studio NO lo pide, y por eso hasta hoy no se mandaba: sin este campo, apuntar el agente a
   * un proveedor pago era imposible aunque su API fuera la misma.
   */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Generoso a propósito: este modelo razona, y el razonamiento consume del mismo presupuesto. */
  maxTokens?: number;
  /**
   * 0.3 para el modelo local: queremos consistencia, no creatividad. PERO no todos los proveedores
   * la aceptan — Kimi K3 responde HTTP 400 con "only 1 is allowed for this model". "Compatible con
   * OpenAI" no quiere decir "acepta los mismos valores".
   */
  temperatura?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export async function pedirLectura(input: PedirLecturaInput): Promise<LecturaAgente> {
  const ahora = (input.now ?? (() => new Date()))().toISOString();
  const base: Omit<LecturaAgente, "lectura" | "motivo" | "tokens"> = {
    generadoEn: ahora,
    modelo: input.modelo,
    hechos: input.hechos
  };
  const doFetch = input.fetchImpl ?? fetch;
  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(), input.timeoutMs ?? 120_000);

  try {
    const r = await doFetch(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {})
      },
      signal: control.signal,
      body: JSON.stringify({
        model: input.modelo,
        messages: [
          { role: "system", content: SISTEMA },
          { role: "user", content: construirPrompt(input.hechos, input.erroresPrevios ?? [], input.loQueHiciste ?? [], input.decisiones ?? []) }
        ],
        // El razonamiento del modelo sale de ESTE presupuesto y se lo come casi todo: medido, un
        // "cuál es la capital de Francia" gastó 179 de 189 tokens en pensar. Con 1200 devolvía
        // vacío sobre un prompt real. 3500 deja lugar para pensar Y contestar.
        // 6000, no 3500: con el formato estricto el modelo razona MÁS (verifica cada línea contra
        // los datos antes de escribirla) y a 3500 devolvía vacío. Medido: 3759 de completion en
        // una corrida real. El razonamiento sale de este mismo presupuesto.
        max_tokens: input.maxTokens ?? 6000,
        temperature: input.temperatura ?? 0.3
      })
    });
    if (!r.ok) {
      return { ...base, lectura: null, motivo: `el modelo local respondió HTTP ${r.status}`, tokens: null };
    }
    const data = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      /** El modelo que REALMENTE contestó. LM Studio sirve el que tiene cargado, sin importar
       *  cuál se pidió: pedíamos qwen3-30b y contestaba qwen3.6-35b, y el log guardaba el
       *  solicitado. Toda discusión sobre "¿con qué cerebro pensó esto?" era sobre un dato falso. */
      model?: string;
    };
    // El modelo del REGISTRO es el que contestó, no el que se pidió.
    base.modelo = data.model ?? input.modelo;
    const texto = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!texto) {
      // Pasa si el presupuesto se lo comió el razonamiento: es un fallo real, no una lectura vacía.
      return {
        ...base,
        lectura: null,
        motivo: "el modelo devolvió texto vacío (probablemente el razonamiento consumió todo el presupuesto)",
        tokens: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0
        }
      };
    }
    // La verificación viaja CON la lectura. Guardarla aparte (o no guardarla) dejaría al panel
    // mostrando el texto sin saber si se sostiene, y a la próxima corrida sin memoria de qué
    // corregir. Se verifica siempre, salga bien o mal.
    return {
      ...base,
      lectura: texto,
      motivo: null,
      // Las MISMAS líneas que se le pusieron en el prompt, o el verificador le marca como invención
      // lo que nosotros le dimos de comer. Ver el comentario del tercer parámetro.
      verificacion: verificarLectura(texto, input.hechos, input.loQueHiciste ?? []),
      tokens: { prompt: data.usage?.prompt_tokens ?? 0, completion: data.usage?.completion_tokens ?? 0 }
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      lectura: null,
      motivo: control.signal.aborted ? "el modelo local no respondió a tiempo" : `no se pudo consultar el modelo local: ${msg}`,
      tokens: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Dónde se guarda la última lectura. El hot path lee este JSON, no al modelo. */
export const MONITOR_FILE = "warmup-monitor.json";

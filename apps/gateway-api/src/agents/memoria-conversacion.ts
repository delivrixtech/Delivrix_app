// LA MEMORIA DE LO QUE SE HABLÓ — no de lo que hizo (eso es bitacora-acciones.ts) ni de lo que el
// jefe zanjó (eso es decisiones-del-jefe.ts).
//
// El incidente, medido en el canal real el 2026-08-06: en el hilo 1785983393.674239 el agente
// contestó CUATRO veces casi lo mismo entre las 03:28 y las 03:31 ("el emisor está pausado,
// placement 33%, cero ciclos"). El jefe lo describió textual: "se volvió repetitivo e imbécil".
// No había con qué detectarlo — warmup-chat.json guarda un cursor de lectura y nada más, así que
// cada turno arrancaba sin saber qué acababa de decir ni qué le venían preguntando.
//
// LO QUE ACÁ NO HAY, y es la parte importante: no hay extractor con modelo. Nada de pedirle a Kimi
// que resuma sus propias conversaciones. Este proyecto ya se quemó dos veces con prompts inflados
// de prosa: un criterio escrito en párrafo el modelo lo devuelve como si fuera un hallazgo propio,
// y si además es falso lo devuelve con seguridad. Acá el "extractor" es un `for` que agrupa y
// cuenta. Un contador no descubre lo que le suena.
//
// Todo PURO: sin red, sin disco, sin Postgres. La persistencia es de quien llama, igual que en sus
// dos hermanos.

import { clave, esLaMisma } from "./decisiones-del-jefe.ts";

/** Un intercambio CONTESTADO, no un mensaje. El daemon ya junta las tandas ("Hey" + "respondeme" +
 *  "como vamos" son UNA conversación); guardar por mensaje volvería a partir lo que ese fix juntó. */
export interface Intercambio {
  /** ts de Slack del mensaje más nuevo de la tanda. Id natural: el dedupe sale gratis. */
  ts: string;
  hilo: string;
  /** User id de quien preguntó. Hoy el canal tiene una persona, pero eso es una coincidencia y no
   *  un control: el día que entre Esaú, una memoria que mezcla jefes le atribuye a Juanes lo que
   *  dijo otro. Es barato ahora e imposible de reconstruir después. */
  quien: string;
  pregunta: string;
  respuesta: string;
  cuando: string;
  tardoSeg: number;
  /**
   * Lo que tardó EL MODELO en el último intento (`RespuestaChat.tardoMs`). No es lo mismo que
   * `tardoSeg`, y confundirlos es cómo se elige un timeout con el número equivocado: `tardoSeg` es
   * la EDAD del mensaje del jefe —incluye la espera de lectura de Slack y las horas que el agente
   * estuvo sordo— y por eso su máximo medido es de 126 MINUTOS. Nunca se promedian juntos.
   *
   * OPCIONAL porque los registros que ya están en producción no lo tienen: exigirlo dejaría la
   * memoria vieja como inválida. Un registro sin el campo no entra al percentil, no cuenta como 0.
   */
  tardoMs?: number;
  /** 1 o 2. Sin esto, un turno salvado por el reintento y uno que salió a la primera se ven iguales. */
  intentos?: number;
  /** `finish_reason`: separa "se cortó por tiempo" de "se cortó por presupuesto de tokens". */
  finishReason?: string | null;
  /** `r.motivo` cuando no salió texto. Hoy eso solo vive en el log y hay que grepearlo: 65 fallos
   *  contra 30 respuestas. Guardarlo convierte un grep frágil en un contador. */
  fallo: string | null;
  /** `r.observaciones.length`: los números y dominios que el modelo afirmó y no estaban en el
   *  contexto. `revisarRespuesta()` ya los detecta y hoy el resultado se imprime y se olvida. */
  inventadas: number;
  repetida: boolean;
  /** La escribe el jefe con su mensaje siguiente, no la infiere nadie. `null` es legítimo:
   *  silencio no es aprobación, igual que `sin_evidencia` en bitacora-acciones.ts. */
  reaccion: "conforme" | "insiste" | "corrige" | null;
}

/** Un tema recurrente. Sobrevive al recorte FIFO de los intercambios: así se puede decir "te lo
 *  preguntó 47 veces en 6 semanas" sin guardar 47 mensajes. */
export interface Tema {
  cita: string;
  vistas: string[];
}

export interface MemoriaConversacion {
  version: 1;
  intercambios: Intercambio[];
  temas: Tema[];
}

/** Mismo número que MAX_ENTRADAS de bitacora-acciones.ts. El techo es estructural, no una promesa:
 *  el vecino warmup-destilacion.json va sin tope, 175.897 bytes por 19 ejemplos en 15,5 h — camino
 *  a ~98 MB al año en un archivo que `updateInventoryJson` re-serializa ENTERO bajo lock. */
export const MAX_INTERCAMBIOS = 40;
/** Mismo número que MAX de decisiones-del-jefe.ts. */
export const MAX_TEMAS = 12;
export const DIAS_VENTANA = 14;
export const DIAS_VIDA = 30;
/**
 * Dos repeticiones el mismo día son una coincidencia, no una costumbre.
 *
 * SIGUE EXPORTADA aunque `lineasParaPrompt` ya no la use: slack.ts la importa como `MUESTRA_MINIMA`
 * y es el piso de la tabla de relevancia. Borrarla acá rompería el otro carril.
 */
export const MIN_VECES = 3;
export const MS_REPETIDA = 600_000;

const DIA = 86_400_000;
const MAX_TEXTO = 200;
const MAX_CITA = 120;
const MAX_VISTAS = 20;

export function memoriaVacia(): MemoriaConversacion {
  return { version: 1, intercambios: [], temas: [] };
}

/** Un JSON que vuelve del disco puede venir de cualquier forma. Se normaliza acá una vez y el
 *  resto del módulo asume arrays. */
function clonar(mem: MemoriaConversacion | null | undefined): MemoriaConversacion {
  if (!mem || typeof mem !== "object") return memoriaVacia();
  return {
    version: 1,
    intercambios: Array.isArray(mem.intercambios) ? [...mem.intercambios] : [],
    temas: Array.isArray(mem.temas) ? [...mem.temas] : []
  };
}

/** Una fecha ilegible no borra el registro: lo deja pasar y que lo recorte el FIFO. Descartarlo
 *  silenciosamente sería perder dato por un error de formato. */
function msDe(iso: string, porDefecto: number): number {
  const m = Date.parse(iso);
  return Number.isFinite(m) ? m : porDefecto;
}

/**
 * Saca las menciones ANTES de normalizar. No es cosmética: sin esto el id del bot queda como una
 * palabra de 11 caracteres, "<@U0BNCHPTPH8> Respondeme," deja de ser un ping y encima ABRE UN TEMA
 * PROPIO llamado "respondeme". Enseñarle al agente que a Juanes le interesa el tema "respondeme"
 * es exactamente el ruido que esto vino a evitar.
 */
const sinMenciones = (t: string): string => t.replace(/<@[^>]+>/g, " ");
const norm = (t: string): string => clave(sinMenciones(t));
const largas = (t: string): Set<string> => new Set(norm(t).split(" ").filter((w) => w.length > 3));

/**
 * ¿Es un reclamo de latencia y no una pregunta? Se clasifica por REGLA, no por palabras: los pings
 * cortos no comparten vocabulario con nada, así que `esLaMisma` nunca los agrupa (y hace bien, no
 * son temas). Sobre los 32 mensajes reales del jefe da exactamente 6: "Hey si buenasssss!!!",
 * "???", "Hola?", "Hey,", "respondeme" y "<@U0BNCHPTPH8> Respondeme," — el baseline del 19%.
 */
export function esPing(texto: string): boolean {
  const p = norm(texto).split(" ").filter(Boolean);
  if (p.length === 0) return true;
  // "ok" y "si" quedan FUERA de la lista salvo dentro de este `every`: "Ok!" tiene que caer en
  // conforme y no en ping. Probado al revés se contaba el único conforme del día como reclamo.
  return p.length <= 3 && p.every((w) => /^(hola+|hey+|buen[oa]s+|respondeme|responde|contesta|estas|ahi|si)$/.test(w));
}

/**
 * TRES estados, no dos: ping (cuenta insistencia, no abre tema), tema (agrupa), y ninguno de los
 * dos (se ignora). "Y que sugieres?" cae en el tercero y está bien: subestimar no inventa.
 *
 * La guarda de 2 palabras largas existe por un falso positivo medido: sin ella el agrupamiento
 * codicioso mete "Ok, es bien." dentro del grupo del mensaje de las semillas, porque comparten
 * "bien" y el divisor de `esLaMisma` es min(1, N) = 1 ⇒ 1.0. El "conforme" más claro del día se
 * contaba como tema.
 *
 * Y UN CIERRE DE CORTESÍA TAMPOCO ES UN TEMA. La guarda de 2 palabras largas no alcanzaba: "Ok, si
 * cambia algo o si tienes dudas, avisame." tiene cinco, así que abría tema — y el MISMO texto
 * `clasificarReaccion` lo devuelve como "conforme". El módulo se contradecía a sí mismo. En el
 * archivo real de producción 2 de los 4 temas guardados son cierres, y con MIN_VECES=3 iban a ser
 * lo primero en llegar al prompt: el agente aprendiendo que a Juanes le interesa el tema "avisame".
 *
 * PERO DELEGAR EN `clasificarReaccion` FUE PEOR QUE EL PROBLEMA. Su regex es `^(ok|dale|listo|
 * gracias|perfecto|…)\b`: un ancla al ARRANQUE de la frase que no mira lo que sigue. Y el prompt de
 * VOZ le enseña al agente que Juanes habla justo así ("podés usar listo, dale, de una, hágale").
 * Medido sobre 7 pedidos realistas, 6 daban `false`: "Dale, subí el cupo de corpfiling-infra.com a
 * 40 y avisame cómo viene el placement", "Listo, ahora revisá los 7 dominios vírgenes…", "Ok pero
 * por qué bizreport-control.com sigue frenado…". O sea que la memoria de temas —lo que el informe
 * de 14 días usa para decidir si este paquete se queda— quedaba ciega a casi todo lo que el jefe
 * pide. Cambiamos "el agente aprende el tema avisame" por "el agente no aprende nada".
 *
 * EL CIERRE ES LA FRASE ENTERA, NO SU PRIMERA PALABRA. Así que el arranque cortés se SACA y se
 * juzga lo que queda; y el vocabulario de cierre (`CIERRE`) descuenta solo en los mensajes que
 * abren con cortesía. Esa restricción no es cosmética: "cambia" y "tienes" no dicen nada dentro de
 * "Ok, si cambia algo…", pero "Cambia el cupo a 40" es un pedido de verdad y ahí tienen que contar.
 */
export function esTema(texto: string): boolean {
  if (esPing(texto)) return false;
  const n = norm(texto);
  const abreCortes = ARRANQUE_CORTES.test(n);
  // Se sacan TODOS los arranques encadenados: "Dale, gracias, estare atento" lleva dos.
  let resto = n;
  while (ARRANQUE_CORTES.test(resto)) resto = resto.replace(ARRANQUE_CORTES, "").trim();
  const utiles = [...largas(resto)].filter((w) => !abreCortes || !CIERRE.has(w));
  return utiles.length >= 2;
}

/** El arranque cortés, tal cual lo detecta `clasificarReaccion`. Misma lista, un solo lugar. */
const ARRANQUE_CORTES = /^(ok|okay|dale|listo|gracias|perfecto|de una|entendido|bien)\b/;

/**
 * Palabras que NO abren un tema cuando el mensaje ya arrancó con cortesía: son el resto de la
 * fórmula de despedida. Salen de los 4 cierres textuales del canal, no de imaginarlos:
 * "Ok, si cambia algo o si tienes dudas, avisame." · "Dale, gracias, estare atento." ·
 * "Listo, gracias!" · "Perfecto, gracias."
 */
const CIERRE = new Set([
  "gracias",
  "avisame",
  "avisarme",
  "avisar",
  "avisas",
  "avises",
  "aviso",
  "entonces",
  "quedo",
  "dudas",
  "duda",
  "estare",
  "atento",
  "atenta",
  // OJO con lo que NO entra: "pendiente", "cupo", "placement" y cualquier término del dominio. Un
  // "Dale, resolvé el pendiente 3" tiene que seguir siendo un tema.
  "algo",
  "nada",
  "cambia",
  "tienes",
  "tenes",
  "cualquier",
  "cosa",
  "saludos"
]);

/**
 * Cómo le cayó la respuesta. La etiqueta la escribe el jefe con su mensaje siguiente.
 *
 * EL ORDEN NO ES NEGOCIABLE y está fijado por un test: conforme ANTES que ping, porque probándolo
 * al revés "Ok!" cae en ping y el único conforme del día se lee como reclamo.
 *
 * `conforme` es evidencia DÉBIL ("Ok!" puede ser "entendí" o "ya fue, dejalo"); `insiste` es
 * evidencia dura, volvió a preguntar. Por eso el prompt reporta insistencias y no conformes.
 *
 * UN PEDIDO QUE ARRANCA CORTÉS NO ES UN CONFORME, y este módulo ya lo había diagnosticado del otro
 * lado sin aplicarlo acá: el comentario de `esTema` dice textual "EL CIERRE ES LA FRASE ENTERA, NO
 * SU PRIMERA PALABRA". Medido sobre el warmup-conversacion.json real (sha256 c73203fb…, 18
 * intercambios): 3 de los 8 `conforme` guardados son mensajes que `esTema()` marca como tema, y DOS
 * de ellos —"Ok me avisas. También tú mismo puedes tomar la decisión de frenar o continuar…" y "Ok,
 * recuérdame el lunes a las 5pm hora Colombia…"— se guardaron el MISMO turno como decisiones
 * permanentes d-5 y d-6. Las dos memorias se contradecían sobre el mismo mensaje: una decía "me
 * dio el visto bueno", la otra "me dio una orden nueva".
 *
 * El resultado es `null` y no otra etiqueta: un pedido nuevo no dice nada sobre cómo le cayó la
 * respuesta anterior. Subestimar no inventa.
 */
export function clasificarReaccion(
  preguntaPrevia: string,
  textoNuevo: string
): "conforme" | "insiste" | "corrige" | null {
  const n = norm(textoNuevo);
  if (ARRANQUE_CORTES.test(n) && !esTema(textoNuevo)) return "conforme";
  if (esPing(textoNuevo)) return "insiste";
  if (esLaMisma(preguntaPrevia, textoNuevo)) return "insiste";
  // EL RECLAMO POR SILENCIO VA ANTES QUE `corrige`, y va porque la memoria estaba ENSEÑANDO AL REVÉS.
  // Sobre el archivo real, "No me has dicho nada en toda la tarde ..." empieza con "no" y caía en la
  // rama de abajo, así que etiquetaba `corrige` a la respuesta anterior — que era "Dale Juanes, aquí
  // quedo de guardia. Apenas se mueva algo… te escribo de una". Esa respuesta estaba BIEN: lo que
  // falló fue el silencio que vino después, no lo que dijo. Y `lineasParaPrompt` la citaba textual
  // bajo "TE CORRIGIÓ DESPUÉS DE ESTO", o sea le enseñaba al modelo que prometer guardia se gana un
  // reparo — lo contrario de lo que pasó.
  //
  // NO SE ARREGLA CON EL RELOJ, aunque el caso llegó 221,8 min después: el corte de 15 minutos es
  // justo el que este módulo sacó a propósito, porque también tiraba "No entiendo, es decir ?" a los
  // 19,9 min, que SÍ es una corrección de contenido. El reloj no distingue las dos cosas; el texto
  // sí. Un reclamo por silencio es insistencia por definición: volvió a escribir porque no le
  // contestaron, y ahí la evidencia es que insistió, no que la respuesta estuviera mal.
  if (/^no (me )?(has |habias )?(dicho|escrito|avisado|respondido|contestado|dices|escribes|avisas|respondes|contestas)\b/.test(n)) return "insiste";
  if (/^(no|pero|como que|que no)\b/.test(n)) return "corrige";
  return null;
}

/**
 * Solapamiento mínimo de vocabulario para que dos RESPUESTAS del agente cuenten como la misma.
 *
 * 0,4 y no el 0,6 de `esLaMisma`, y son dos preguntas distintas a propósito. `esLaMisma` decide si
 * dos frases del jefe son la misma decisión: frases cortas, donde exigir poco junta cosas ajenas.
 * Acá se compara el párrafo que el agente acaba de escribir contra el que escribió hace tres
 * minutos, sobre 200 caracteres y 15-23 palabras de contenido.
 *
 * El número sale de MEDIR el incidente, no de elegirlo: las ocho respuestas del 2026-08-06 entre
 * las 09:28 y las 09:34 dicen exactamente lo mismo (seis calentando, ocho frenados, nueve cruzaron,
 * el freno de bizreport-control.com no pegó) redactadas distinto cada vez, y su solapamiento real
 * va de 0,19 a 0,53 — o sea que a 0,6 el detector daba CERO. Corrido sobre las 73 respuestas del
 * canal, 0,4 marca 12 y las 12 son repeticiones de verdad.
 */
export const UMBRAL_REPETIDA = 0.4;
/** Debajo de esto el divisor min(|A|,|B|) hace que dos frases cortas compartan "cualquier cosa". */
const MIN_LARGAS_PARA_SOLAPAR = 8;

/**
 * ¿El agente está diciendo otra vez lo mismo? PURO y exportado para poder fijarlo con el incidente.
 *
 * Con pocas palabras de contenido se exige texto normalizado IDÉNTICO, no solapamiento: con 3 o 4
 * palabras, min(|A|,|B|) es tan chico que un 0,4 lo alcanza cualquier par de frases. Y es el caso
 * que importa para los avisos enlatados ("te leí pero no pude contestarte"), que son cortos y se
 * repiten textuales.
 */
export function esLaMismaRespuesta(a: string, b: string): boolean {
  const A = largas(a);
  const B = largas(b);
  if (A.size < MIN_LARGAS_PARA_SOLAPAR || B.size < MIN_LARGAS_PARA_SOLAPAR) return norm(a) === norm(b);
  let comunes = 0;
  for (const w of A) if (B.has(w)) comunes++;
  return comunes / Math.min(A.size, B.size) >= UMBRAL_REPETIDA;
}

/** Anota una conversación contestada. Dedupe por `ts`: si el tick se repite, el registro ya está. */
export function anotar(
  mem: MemoriaConversacion | null,
  e: Omit<Intercambio, "repetida" | "reaccion">
): MemoriaConversacion {
  const base = clonar(mem);
  if (base.intercambios.some((i) => i.ts === e.ts)) return base;

  const pregunta = String(e.pregunta ?? "").slice(0, MAX_TEXTO);
  const respuesta = String(e.respuesta ?? "").slice(0, MAX_TEXTO);
  const t = msDe(e.cuando, Date.now());

  // La detección de las respuestas casi idénticas. Sin el guard de respuesta vacía, `esLaMisma("", "")`
  // da true y CADA turno fallido quedaría marcado como repetido — justo los que no dijeron nada.
  //
  // SIN FILTRAR POR HILO, y es la misma corrección que `anotarReaccion` ya había hecho a propósito
  // más abajo. El detector se escribió mirando el incidente de las 03:28 (cuatro respuestas dentro
  // del hilo ...393) y por eso el filtro parecía inofensivo; el incidente de las 09:28 del MISMO día
  // fueron ocho respuestas casi idénticas en OCHO hilos distintos en 5,7 minutos — el agente
  // contestando de a uno los hilos viejos con la misma foto — y el filtro las daba todas nuevas.
  // La repetición la sufre el jefe, que lee el canal entero, no el hilo.
  const repetida =
    respuesta !== "" &&
    base.intercambios.some(
      (p) =>
        p.respuesta !== "" &&
        Math.abs(t - msDe(p.cuando, 0)) <= MS_REPETIDA &&
        esLaMismaRespuesta(p.respuesta, respuesta)
    );

  base.intercambios.push({ ...e, pregunta, respuesta, repetida, reaccion: null });

  // Un turno que falló o que se repitió NO abre tema: es señal negativa, nunca ejemplo de nada. Si
  // la memoria guardara esas como temas reforzaría justo lo que hay que matar (hoy el 66% de los
  // turnos falla y varias respuestas son la misma frase repetida).
  if (e.fallo === null && !repetida && esTema(pregunta)) {
    const i = base.temas.findIndex((x) => esLaMisma(x.cita, pregunta));
    if (i >= 0) {
      const prev = base.temas[i] as Tema;
      base.temas[i] = {
        // Se REFRESCA la cita: clavada en el primer miembro se fosiliza, y el primero puede ser el
        // más raro del grupo.
        cita: pregunta.slice(0, MAX_CITA),
        vistas: [...(Array.isArray(prev.vistas) ? prev.vistas : []), e.cuando].slice(-MAX_VISTAS)
      };
    } else {
      base.temas.push({ cita: pregunta.slice(0, MAX_CITA), vistas: [e.cuando] });
    }
  }

  const limite = t - DIAS_VIDA * DIA;
  base.intercambios = base.intercambios.filter((i) => msDe(i.cuando, t) >= limite);
  base.temas = base.temas.filter((x) => ultimaVista(x, t) >= limite);
  if (base.intercambios.length > MAX_INTERCAMBIOS) {
    // AL RECORTAR SE TIRAN PRIMERO LOS TURNOS FALLIDOS. El cupo es uno solo y los fallos entran al
    // mismo balde que las preguntas contestadas: cargando el warmup-conversacion.json REAL de
    // producción (7 intercambios) y metiéndole los 65 fallos del 2026-08-06, quedaban 40 entradas y
    // las 40 eran fallos — los 7 reales desaparecidos. O sea que una racha de timeouts borra
    // exactamente la memoria que existe para que el agente no arranque de cero cada turno, y la
    // borra justo el día que peor está funcionando.
    //
    // Se tiran los MÁS VIEJOS primero, así que `fallosSeguidos` —que mira el final del hilo— sigue
    // contando bien la racha en curso.
    const sobran = base.intercambios.length - MAX_INTERCAMBIOS;
    const tirar = new Set(base.intercambios.filter((i) => i.fallo !== null).slice(0, sobran).map((i) => i.ts));
    if (tirar.size > 0) base.intercambios = base.intercambios.filter((i) => !tirar.has(i.ts));
    // Si aun así sobran (más de 40 turnos BUENOS), manda el FIFO de siempre.
    if (base.intercambios.length > MAX_INTERCAMBIOS) base.intercambios = base.intercambios.slice(-MAX_INTERCAMBIOS);
  }
  if (base.temas.length > MAX_TEMAS) {
    base.temas = [...base.temas].sort((a, b) => ultimaVista(b, t) - ultimaVista(a, t)).slice(0, MAX_TEMAS);
  }
  return base;
}

/**
 * Cuántos turnos SEGUIDOS falló en este hilo (0 = el último salió bien).
 *
 * El incidente, medido el 2026-08-06: los 65 turnos sin respuesta no son 65 preguntas, son 5. La
 * misma pregunta se reintentó hasta 23 veces —"Como que no lo puedes hacer?" ×23, "Hola?" ×13,
 * "???" ×12— y cada intento publicaba su propio "Te leí pero no pude contestarte". Veintitrés
 * disculpas idénticas en el mismo hilo no informan de nada: enseñan que el canal es ruido, que es
 * exactamente lo que este paquete vino a arreglar.
 *
 * Se cuenta ACÁ y no en quien publica porque la memoria es lo único que sobrevive al reinicio del
 * proceso — y esa sesión del 2026-08-06 arrancó dos veces en 15 minutos.
 */
export function fallosSeguidos(mem: MemoriaConversacion | null, hilo: string): number {
  const es = clonar(mem).intercambios.filter((e) => e.hilo === hilo);
  let n = 0;
  for (let i = es.length - 1; i >= 0; i--) {
    if ((es[i] as Intercambio).fallo === null) break;
    n++;
  }
  return n;
}

function ultimaVista(t: Tema, porDefecto: number): number {
  const v = Array.isArray(t.vistas) ? t.vistas : [];
  return v.length === 0 ? porDefecto : msDe(v[v.length - 1] as string, porDefecto);
}

/**
 * Etiqueta el intercambio anterior con el mensaje que acaba de mandar el jefe. El tick siguiente
 * es el que juzga al anterior.
 *
 * SIN FILTRAR POR HILO, y esa es la corrección medida: buscando dentro del mismo hilo da
 * insiste = 0, porque el jefe reclama con un mensaje SUELTO del canal mientras el bot le contesta
 * adentro del hilo ("Hola?" a las 03:29 mientras respondía el ...393 entre 03:28 y 03:31).
 *
 * PERO SÍ POR AUTOR. El campo `quien` existe en `Intercambio` exactamente para esto y no se estaba
 * usando: sin él, un "no, pero..." de Esaú se anota como que JUANES corrigió la respuesta que le
 * dieron a Juanes. Hoy el canal tiene una persona, así que no se nota — y eso es una coincidencia,
 * no un control. El día que entre el segundo, el dato queda mal y es imposible de reconstruir.
 * `quien` es opcional para no romper al llamador que todavía no lo pasa: sin él se comporta igual
 * que hoy, y eso se dice acá en vez de dejarlo como sorpresa.
 *
 * Y SIN RELOJ, que es la corrección que destapó el archivo real. Había un corte de 15 minutos
 * (`MS_REACCION`) y tiraba DOS DE LAS TRES correcciones que el jefe hizo de verdad: sobre
 * warmup-conversacion.json (sha256 c73203fb…) se perdieron "No entiendo, es decir ?" —que llegó
 * 19,9 min después— y "No me has dicho nada en toda la tarde ..." —221,8 min—, y las dos son
 * exactamente la evidencia DURA que este módulo existe para juntar. Las dos quedaron en `null`, que
 * se lee como "no contestó nada".
 *
 * El reloj no aportaba identidad: el intercambio que se etiqueta lo elige el selector de arriba —el
 * más reciente SIN reacción y del mismo autor— así que el siguiente mensaje del jefe es la etiqueta
 * del anterior POR CONSTRUCCIÓN, tarde nueve minutos o cuatro horas. Lo único que se conserva es el
 * orden (`t < mejor`): un mensaje anterior al intercambio no puede ser su reacción. El techo lo
 * sigue poniendo `DIAS_VIDA`, que recorta el archivo.
 */
export function anotarReaccion(
  mem: MemoriaConversacion | null,
  msg: { texto: string; cuando: string; quien?: string }
): MemoriaConversacion {
  const base = clonar(mem);
  const t = msDe(msg.cuando, Date.now());
  let idx = -1;
  let mejor = -Infinity;
  for (let i = 0; i < base.intercambios.length; i++) {
    const e = base.intercambios[i] as Intercambio;
    if (e.reaccion !== null || e.respuesta === "") continue;
    if (msg.quien !== undefined && e.quien !== msg.quien) continue;
    const c = msDe(e.cuando, 0);
    if (c > mejor) {
      mejor = c;
      idx = i;
    }
  }
  if (idx < 0) return base;
  const e = base.intercambios[idx] as Intercambio;
  if (t < mejor) return base;
  base.intercambios[idx] = { ...e, reaccion: clasificarReaccion(e.pregunta, msg.texto) };
  return base;
}

/**
 * Las líneas que entran al prompt del chat. Mismo contrato que sus dos hermanas: `[]` cuando no
 * hay nada, así el sistema recién arrancado deja el prompt EXACTAMENTE como está hoy.
 *
 * El `slice(0, max)` cuenta las cabeceras. "6 de dato más los títulos que hagan falta" es
 * exactamente cómo se infla un prompt sin que nadie mienta.
 *
 * PROHIBIDO en toda línea: imperativos, "deberías", "hay que", "conviene". Hay un test con regex
 * que lo assertea. "Preguntó 9 veces" es un hecho; "deberías responder más rápido" es consejo, y
 * el consejo es justo lo que el modelo devuelve como si fuera un hallazgo propio.
 */
export function lineasParaPrompt(
  mem: MemoriaConversacion | null,
  hiloActual: string,
  ahoraISO: string,
  max = 6
): string[] {
  const m = clonar(mem);
  if (m.intercambios.length === 0 && m.temas.length === 0) return [];
  const ahora = msDe(ahoraISO, Date.now());
  const l: string[] = [];

  // A) La línea que hace el trabajo: es la foto que le faltaba cuando contestó 4 veces casi lo
  //    mismo en el hilo ...393. Va SOLA, sin consejo pegado — VOZ ya dice "no repetís". Un hecho no
  //    se discute; un consejo el modelo lo recicla como hallazgo propio.
  //
  //    YA NO SE FILTRA POR HILO, por el mismo motivo que `anotar`: el otro incidente del 2026-08-06
  //    fueron ocho respuestas iguales en ocho hilos distintos en 5,7 minutos, y con el filtro puesto
  //    esta línea salía VACÍA en cada una de las ocho — justo cuando servía. El hilo no desaparece:
  //    se dice en la línea, porque "lo dije en otro hilo" y "lo dije acá" no son lo mismo para el
  //    modelo que está por contestar.
  let ultima: Intercambio | null = null;
  for (const i of m.intercambios) {
    if (i.respuesta === "") continue;
    const c = msDe(i.cuando, 0);
    if (ahora - c > MS_REPETIDA || ahora < c) continue;
    if (!ultima || c > msDe(ultima.cuando, 0)) ultima = i;
  }
  if (ultima) {
    const min = Math.max(0, Math.round((ahora - msDe(ultima.cuando, ahora)) / 60_000));
    l.push(`LO ÚLTIMO QUE DIJISTE (hace ${min} min, ${ultima.hilo === hiloActual ? "en este hilo" : "en otro hilo"}):`);
    l.push(`- "${ultima.respuesta.slice(0, MAX_CITA)}"`);
  }

  // B) SE BORRÓ EL BLOQUE DE TEMAS REPETIDOS, y no por "está vacío por ahora": era estructuralmente
  //    inalcanzable. Pedía `MIN_VECES=3` vistas del MISMO tema contadas sobre 14 días, mientras el
  //    archivo guarda `MAX_TEMAS=12` y el canal real produce 12,2 temas nuevos por día — o sea que
  //    un tema sobrevive ~1 día en el archivo y necesita 3 apariciones en 14. Medido sobre el
  //    warmup-conversacion.json de producción (sha256 c73203fb…): los 12 temas guardados tienen UNA
  //    vista cada uno y `esLaMisma` no agrupó ni un par en 18 intercambios. La sección salía vacía
  //    en todas las vueltas y por diseño iba a seguir así.
  //
  //    NO SE TOCARON LAS CONSTANTES a propósito: bajar MIN_VECES a 2 o subir MAX_TEMAS a 40 es
  //    elegir un número para que el archivo se llene, que es fabricar la evidencia en vez de
  //    medirla. Los temas se siguen ACUMULANDO (`anotar` los escribe y `resumen` los imprime en el
  //    informe): lo que se saca es su entrada al prompt, que costaba 3 renglones de encabezado y
  //    nunca dijo nada.

  // C) LA EVIDENCIA DURA, CITADA. Es lo que el jefe pidió ("que aprenda de lo que yo le digo") y lo
  //    único que ya se guardaba sin volver nunca: `Intercambio.reaccion` existe hace días y ninguna
  //    línea del prompt la leía.
  //
  //    SOLO `corrige` e `insiste`. `conforme` queda afuera por dos motivos que este módulo ya
  //    documenta: es evidencia DÉBIL ("Ok!" tanto puede ser "entendí" como "ya fue, dejalo"), y
  //    desde el arreglo de `clasificarReaccion` sabemos que además venía CONTAMINADO con pedidos
  //    nuevos que arrancaban corteses. Un prompt que premia conformes se gana diciendo cosas que
  //    cierren la charla.
  //
  //    SE CITA LO QUE DIJO ÉL —el agente—, no lo que escribió el jefe. La frase del jefe es una
  //    orden y su lugar es `decisiones-del-jefe.ts`, que la guarda con su autor y su fecha; traerla
  //    acá la duplicaría en dos memorias y es el camino más corto a que un reclamo puntual se
  //    convierta en regla permanente. Lo que esta memoria sabe y ninguna otra es QUÉ RESPUESTA suya
  //    se ganó el reparo.
  //
  //    Entra como DATO: cita entre comillas, recortada, con contador, y sin un solo imperativo. Es
  //    la regla de arriba, la misma que el comentario de esta función ya declara: un consejo el
  //    modelo lo recicla como hallazgo propio.
  const dura = m.intercambios.filter((i) => i.reaccion === "corrige" || i.reaccion === "insiste");
  const ultimaDura = dura.at(-1);
  if (ultimaDura && ultimaDura.respuesta !== "") {
    const verbo = ultimaDura.reaccion === "corrige" ? "TE CORRIGIÓ" : "TE INSISTIÓ";
    l.push(
      `${verbo} DESPUÉS DE ESTO (${dura.length} ${dura.length === 1 ? "vez" : "veces"} en lo guardado): ` +
        `"${ultimaDura.respuesta.slice(0, MAX_CITA)}"`
    );
  }

  return l.slice(0, max);
}

/**
 * SILENCIO DURO: después de este intercambio, el jefe NO VOLVIÓ A ESCRIBIR. Nada de etiquetas.
 *
 * Existe porque el índice usaba `reaccion === null` como "le habló y no le contestó nada", y eso se
 * podía GANAR con un "Ok!": `clasificarReaccion` lo devuelve como `conforme`, el intercambio sale
 * del balde de los nulos y el índice BAJA sin que la conversación haya mejorado en nada. Medido
 * sobre el archivo real duplicado para pasar el piso de 30 (n=36): 24,1 ⇒ 7,4 (−69%) con solo
 * convertir los silencios en conformes. El anti-gaming decía "conforme no entra al índice" y entraba
 * por la puerta de al lado, con el signo invertido.
 *
 * Y de paso destapa que `sinReaccion` no medía silencio: en warmup-conversacion.json (18 registros,
 * 9 nulos) OCHO de esos nueve TIENEN un mensaje posterior del jefe. El nulo es una etiqueta que
 * `anotarReaccion` no llegó a poner —etiqueta un intercambio por mensaje— no una persona callada.
 * O sea que el 50% del baseline mide al etiquetador, no al jefe. Se sigue reportando, con ese nombre.
 *
 * POR AUTOR, que es para lo que `quien` fue escrito: el día que entre Esaú, un mensaje suyo no puede
 * contar como que Juanes contestó. Un intercambio del que existe otro POSTERIOR del mismo autor
 * prueba que volvió a escribir; el de la punta es el único que puede quedar sin respuesta.
 */
function silencioDuro(es: readonly Intercambio[], e: Intercambio): boolean {
  const t = msDe(e.cuando, 0);
  // ponytail: O(n²) sobre un array topado en MAX_INTERCAMBIOS (40). Si alguna vez sube el techo, se
  // precalcula el último `cuando` por autor en un Map y queda O(n).
  return !es.some((o) => o !== e && o.quien === e.quien && msDe(o.cuando, 0) > t);
}

/** Aritmética sobre los arrays, sin criterio nuevo. Es lo que imprime informe-conversacion.ts. */
export function resumen(
  mem: MemoriaConversacion | null,
  ahoraISO: string
): {
  intercambios: number;
  insiste: number;
  conforme: number;
  corrige: number;
  sinReaccion: number;
  sinRespuesta: number;
  tasaInsiste: number;
  repetidas: number;
  inventadas: number;
  fallos: number;
  latencia: { mediana: number; p90: number; max: number };
  modelo: { n: number; p50: number; p95: number; max: number };
  temas: Array<{ cita: string; veces: number; ultimaVez: string }>;
} {
  const m = clonar(mem);
  const es = m.intercambios;
  const cuenta = (r: string): number => es.filter((e) => e.reaccion === r).length;

  // La latencia se calcula SOLO sobre los que no fallaron: un turno que ni salió no midió nada.
  // Y se mide para poder DESCONTARLA, no para colgarse la medalla — si alguien dice "mejoró"
  // señalando la mediana después de este cambio, es atribución falsa: la latencia es presupuesto
  // de tokens y timeout del cliente, no memoria.
  const mins = es.filter((e) => e.fallo === null).map((e) => Number(e.tardoSeg) / 60).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const pct = (p: number): number => (mins.length === 0 ? 0 : redondear(mins[Math.min(mins.length - 1, Math.max(0, Math.ceil(p * mins.length) - 1))] as number));

  // LA LATENCIA DEL MODELO, que es la que sirve para elegir el timeout del chat — y la que no
  // existía. Va SOBRE `tardoMs` y en segundos, separada de la de arriba: mezclarlas daría un número
  // que no mide nada (una incluye horas de agente sordo). Entran los FALLIDOS también, a propósito:
  // un timeout es el dato más caro de la distribución y sacarlo sesga la ventana hacia los rápidos,
  // que son justamente los que no tienen el problema.
  //
  // `n` va al lado del percentil porque un p95 sobre 3 muestras no es un p95: con el instrumento
  // recién cableado el informe tiene que poder decir "todavía no sé" en vez de un número redondo.
  const segs = es.map((e) => Number(e.tardoMs)).filter((n) => Number.isFinite(n) && n > 0).map((n) => n / 1000).sort((a, b) => a - b);
  const pctModelo = (p: number): number =>
    segs.length === 0 ? 0 : redondear(segs[Math.min(segs.length - 1, Math.max(0, Math.ceil(p * segs.length) - 1))] as number);

  const ahora = msDe(ahoraISO, Date.now());
  const desde = ahora - DIAS_VENTANA * DIA;

  return {
    intercambios: es.length,
    insiste: cuenta("insiste"),
    conforme: cuenta("conforme"),
    corrige: cuenta("corrige"),
    sinReaccion: es.filter((e) => e.reaccion === null).length,
    sinRespuesta: es.filter((e) => silencioDuro(es, e)).length,
    tasaInsiste: es.length === 0 ? 0 : redondear(cuenta("insiste") / es.length, 3),
    repetidas: es.filter((e) => e.repetida).length,
    inventadas: es.reduce((a, e) => a + (Number(e.inventadas) || 0), 0),
    fallos: es.filter((e) => e.fallo !== null).length,
    latencia: { mediana: pct(0.5), p90: pct(0.9), max: mins.length === 0 ? 0 : redondear(mins[mins.length - 1] as number) },
    modelo: { n: segs.length, p50: pctModelo(0.5), p95: pctModelo(0.95), max: segs.length === 0 ? 0 : redondear(segs[segs.length - 1] as number) },
    temas: m.temas
      .map((t) => {
        const v = Array.isArray(t.vistas) ? t.vistas : [];
        return {
          cita: String(t.cita ?? ""),
          veces: v.filter((x) => msDe(x, 0) >= desde).length,
          ultimaVez: (v[v.length - 1] as string) ?? ""
        };
      })
      .sort((a, b) => b.veces - a.veces)
  };
}

function redondear(n: number, decimales = 1): number {
  const f = 10 ** decimales;
  return Math.round(n * f) / f;
}

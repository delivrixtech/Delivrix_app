// LAS PROMESAS DEL AGENTE — lo que dijo que iba a volver a decir, y que hasta hoy nunca dijo.
//
// El incidente, medido en producción el 2026-08-06 sobre runtime/logs/warmup-monitor.log: de 42
// respuestas del chat, 7 prometen volver. Textuales:
//   · "Apenas caiga la lectura te traigo el estado real de…"
//   · "Apenas caigan los resultados actúo y te dejo el resumen listo"
//   · "Dale Juanes, aquí quedo de guardia. Apenas se mueva algo con las mediciones… te escribo de una"
// Cumplidas: CERO. Y no es que el modelo mintiera: estructuralmente no podía cumplir ninguna. El
// carril del chat contesta y se olvida —no persistía un solo rastro de la promesa— y el carril de
// la guardia, que sí corre cada 10 minutos, no tenía dónde enterarse. `decidirSiHablar` tiene seis
// razones para hablar y ninguna es "prometí algo".
//
// Este archivo es la mitad que faltaba: dónde queda anotada la promesa y cómo se cierra. Todo puro
// —sin red, sin disco, sin modelo— porque la persistencia es de quien llama y porque una promesa
// tiene que poder testearse sin levantar nada.
//
// LA REGLA MÁS DURA, y la única que no se negocia: CUMPLIR NO EJECUTA NADA. Una promesa produce
// MENSAJES, jamás volumen. Acá no se llama a `ejecutarAcciones`, no se toca un cap, no se manda un
// correo. Si algún día una promesa tiene que disparar `soltar_dominio`, eso lo decide el operador
// y es otro ítem. (Hay un test que lee este archivo y falla si alguien mete un import ejecutor.)
//
// POR QUÉ ARCHIVO NUEVO Y NO UN CAMPO MÁS EN `Pendiente`: los dos call sites de pendientes que
// existen hoy (scripts/ops/warmup-monitor.ts:705 y :1104) pasan `() => p` a `updateInventoryJson`,
// o sea DESCARTAN el valor fresco que el candado releyó y escriben la lista que `listar()` leyó
// ANTES, fuera del candado. Es read-modify-write sin candado entre dos carriles del mismo proceso
// (el tick del chat cada 6 s contra una guardia que puede estar 120 s adentro de un SSH). Hoy la
// ventana es chica porque la guardia anota poco; construir las promesas encima lo volvería el
// camino caliente y GARANTIZA que algunas desaparezcan sin rastro — que es literalmente la queja
// que estamos arreglando. Por eso la API de acá es de MUTADOR: `updateInventoryJson(FILE, actual =>
// anotarPromesa(actual ?? [], …))`. La carrera se resuelve por diseño y a costo cero.

import { mismoPendiente } from "./acciones-agente.ts";

export interface Promesa {
  id: string;
  /** Lo que prometió, en sus términos. Es lo que se le va a recitar al cerrar. */
  que: string;
  /** thread_ts donde se prometió. `null` = se prometió en el canal suelto. */
  hilo: string | null;
  /**
   * La clave del campo observable que está esperando, ej. "placement:corp-delivery.com". Se guarda
   * TAL CUAL la emitió el modelo: si es una clave que nadie mide, eso se descubre y se DICE al
   * vencer, no se borra al anotar. `null` = prometió sin decir qué espera.
   */
  esperando: string | null;
  abiertoEn: string;
  /** Calculado UNA vez desde `abiertoEn`. Re-prometer no lo mueve. */
  venceEn: string;
  /** Cuántas veces prometió lo mismo. No crea una promesa nueva: suma acá. */
  visto: number;
  /**
   * Se cierra SIN mensaje al vencer, porque ya hubo una disculpa por lo mismo hace poco. Ver el
   * dedupe contra las CERRADAS en `anotarPromesa`. No afecta a las cumplidas: esas traen dato.
   */
  callada?: boolean;
  cerradaEn?: string;
  /** Cuándo salió el mensaje que la anunció. Es el reloj de `MINUTOS_ENTRE_DISCULPAS`. */
  anuncioEn?: string;
  comoCerro?: "cumplida" | "vencida";
}

/**
 * Cuánto vive una promesa sin noticias. Mismo turno de sueño que `HORAS_PARA_REPETIR` en slack.ts.
 *
 * Por qué hay plazo y no "cumplo cuando el dato cambie": medido el 2026-08-06, el dato prometido no
 * cambió NI UNA VEZ en 6 horas — corp-delivery.com se midió tres veces y devolvió el mismo motivo
 * textual ("todavía no se midió nunca"). Sin vencimiento, "cumplo cuando cambie" es la promesa
 * olvidada de hoy con un archivo más. El precedente está a la vista en warmup-pendientes.json:
 * p-1-outlook-y-yahoo lleva visto=13 desde el 2026-08-04 y nadie lo cerró nunca.
 */
export const HORAS_PARA_VENCER = 6;

/**
 * Cuánto tiene que pasar para volver a disculparse por LO MISMO.
 *
 * El dedupe miraba solo las promesas ABIERTAS. En cuanto una vencía y se cerraba, el mismo texto con
 * el mismo disparador abría una promesa NUEVA con reloj NUEVO: reproducido con el jefe
 * re-preguntando cada 30 minutos por un dato que no se mueve, salen 3 mensajes IDÉNTICOS por día
 * (06:00, 12:30, 19:00), todos los días, indefinidamente. Y el agujero no es un borde: `cap.frenados`,
 * `flota.sanas` y `flota.bloqueadas` —las tres claves globales que el prompt le ofrece al modelo—
 * cambian como mucho una vez por día.
 */
export const HORAS_SIN_REPETIR_DISCULPA = 24;

/**
 * Cuánto espera entre dos mensajes que son SOLO disculpas.
 *
 * Es el freno que le faltaba a este carril: el cierre de promesa no pasaba por ningún presupuesto
 * —incrementaba un contador que nadie leía— así que 36 promesas abiertas en 6 h daban 36 mensajes.
 * Con las ~7 promesas/día medidas el día real quedaba en 10 avances + ~6 promesas + 1-3 problemas =
 * 17-19 mensajes, y el antecedente que hizo que el jefe dijera "repetitivo e imbécil" fueron ~25.
 *
 * SOLO frena las disculpas. Una promesa CUMPLIDA sale siempre: trae el dato que el jefe pidió, está
 * acotada por los cambios reales de la fábrica, y hacerla esperar la rompería de verdad — la ventana
 * del diff avanza cada vuelta, así que la que espera un turno ya no encuentra su cambio y termina
 * degradada a disculpa. Las disculpas, en cambio, ya están vencidas: esperar dos horas más no les
 * quita nada y las junta en un solo mensaje.
 */
export const MINUTOS_ENTRE_DISCULPAS = 120;

/** Cuántas promesas se conservan en el archivo. Solo se tiran CERRADAS: ver el recorte. */
const MAX_PROMESAS = 30;

/**
 * Máximo de líneas en un mensaje de cierre. Si vencen veinte juntas a las 4am, un muro de veinte
 * líneas es el mismo ruido que veinte mensajes. El sobrante se CUENTA, nunca se pierde en silencio:
 * el número es la voz de las que no entraron.
 */
const MAX_LINEAS = 5;

/** Un `que` demasiado corto no es una promesa: es un marcador mal emitido por el modelo. */
const MINIMO_QUE = 5;

function normalizar(v: string | number | null | undefined): string | number | null {
  return v === undefined ? null : v;
}

/**
 * Cómo se escribe un valor en el mensaje.
 *
 * "No medido" y "cero" NO son lo mismo, y confundirlos es cómo se fabrica un dato: este proyecto ya
 * pagó esa lección. `null`/ausente dice "sin medir"; un 0 medido dice "0".
 */
function comoTexto(v: string | number | null): string {
  return v === null ? "sin medir" : String(v);
}

/**
 * Anota una promesa. Devuelve la lista nueva — nunca muta la que recibe.
 *
 * DEDUPE con `mismoPendiente` (el de acciones-agente.ts, ya probado en producción: p-1-outlook-y-yahoo
 * lleva visto=13 en UNA sola entrada). El modelo reformula, es lo que hacen los modelos: "te traigo
 * el placement de corp-delivery" y "apenas mida corp-delivery te lo paso" son la misma promesa.
 *
 * RE-PROMETER NO EXTIENDE EL PLAZO: se conservan `abiertoEn` y `venceEn` originales y solo sube
 * `visto`. Sin esto, un agente que promete lo mismo cada dos horas no vence nunca nada — y volver a
 * prometer es justamente la señal de que todavía NO cumplió, no de que empiece un plazo nuevo.
 */
export function anotarPromesa(
  lista: readonly Promesa[],
  p: { que: string; hilo: string | null; esperando: string | null },
  ahoraISO: string
): Promesa[] {
  const base = Array.isArray(lista) ? [...lista] : [];
  const que = (p.que ?? "").trim();
  if (que.length < MINIMO_QUE) return base;

  // EL DISPARADOR SE GUARDA TAL CUAL, sin validarlo contra el retrato de esta vuelta. Se validaba, y
  // el que no existía se normalizaba a `null` (promesa "genérica", que vencía en silencio). Dos
  // razones para sacarlo, las dos medidas:
  //  · Los tres dominios sobre los que gira la conversación real del 2026-08-06
  //    (controlcontrolledger.com, corpfiling-outbound.com, corp-delivery.com) no tienen NI UN ciclo
  //    en 5 días, así que ninguno produce clave `placement:` y las 5 promesas reales caían todas en
  //    genéricas → cero mensajes. Para el jefe eso es idéntico a hoy: prometió y desapareció.
  //  · Un `campos` vacío —un `.catch(() => null)` de 200 ms al momento de anotar, o la primera
  //    instalación— degradaba TODA promesa a genérica y la mataba para siempre, aunque el dato real
  //    llegara en la vuelta siguiente.
  // Quién mide qué se sabe recién al VENCER, y ahí se dice: `revisarPromesas` mira el retrato de ese
  // momento y separa "no se movió en 6 h" de "nadie está midiendo eso".
  const esperando = p.esperando ?? null;

  // DEDUPE POR TÉRMINOS **Y** POR DISPARADOR. Dos promesas que esperan campos distintos son
  // distintas por definición, no hay heurístico que discutir. Sin la segunda mitad, los textos
  // genéricos que el modelo produce de verdad —"Apenas caiga la lectura te traigo el estado real
  // de…"— comparten todos los términos, así que dos promesas sobre dominios distintos colapsaban en
  // UNA: quedaba el disparador de la segunda y la primera ya no podía cumplirse ni vencer. La
  // promesa que se evapora, o sea la queja 1 reconstruida adentro del arreglo de la queja 1.
  const i = base.findIndex((x) => !x.cerradaEn && mismoPendiente(x.que, que) && (x.esperando ?? null) === esperando);
  if (i >= 0) {
    const previa = base[i] as Promesa;
    base[i] = {
      ...previa,
      visto: previa.visto + 1,
      // El hilo SÍ se refresca: el jefe está leyendo el hilo donde lo prometió recién, no el de hace
      // tres horas. El reloj (`abiertoEn`/`venceEn`) y el disparador no se tocan — el disparador ya
      // es parte de la identidad, si cambiara sería otra promesa.
      hilo: p.hilo ?? previa.hilo
    };
    return base;
  }

  const abierto = Date.parse(ahoraISO);
  // ¿YA ME DISCULPÉ POR ESTO HACE POCO? El dedupe de arriba solo mira las ABIERTAS, y esa es la
  // puerta por la que la misma disculpa vuelve cada 6,5 h para siempre: la promesa vence, se cierra,
  // el jefe vuelve a preguntar, y nace otra idéntica con reloj nuevo. Acá NO se bloquea la promesa
  // —se anota igual, y si el dato se mueve la cumple y habla— se bloquea solo la DISCULPA.
  // La ventana se mide contra la disculpa que SALIÓ (`anuncioEn`), no contra cualquier vencida. Si
  // se midiera contra el cierre, cada callada correría la ventana hacia adelante y la cadena
  // "prometo / se cierra callada / vuelvo a prometer" la volvería infinita: el jefe recibiría la
  // disculpa UNA vez en la vida del archivo. Así son 24 h de verdad.
  const yaMeDisculpe = base.some(
    (x) =>
      x.comoCerro === "vencida" &&
      x.anuncioEn !== undefined &&
      mismoPendiente(x.que, que) &&
      (x.esperando ?? null) === esperando &&
      Number.isFinite(abierto) &&
      abierto - Date.parse(x.anuncioEn) < HORAS_SIN_REPETIR_DISCULPA * 3_600_000
  );
  base.push({
    id: `pm-${base.length + 1}-${que.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
    que,
    hilo: p.hilo ?? null,
    esperando,
    abiertoEn: ahoraISO,
    venceEn: new Date((Number.isFinite(abierto) ? abierto : Date.now()) + HORAS_PARA_VENCER * 3_600_000).toISOString(),
    visto: 1,
    ...(yaMeDisculpe ? { callada: true } : {})
  });
  return recortar(base);
}

/**
 * Se conservan las más recientes, PERO nunca se tira una ABIERTA: esa es exactamente la que todavía
 * le debe un mensaje al jefe, y perderla nos devuelve al estado de hoy. Las abiertas se drenan
 * solas en `HORAS_PARA_VENCER`, así que el archivo no crece sin techo por este lado.
 */
function recortar(lista: Promesa[]): Promesa[] {
  if (lista.length <= MAX_PROMESAS) return lista;
  const cerradas = lista.filter((p) => p.cerradaEn).sort((a, b) => (a.cerradaEn as string).localeCompare(b.cerradaEn as string));
  // NUNCA se tira la ÚLTIMA ANUNCIADA: en ella vive el reloj de `MINUTOS_ENTRE_DISCULPAS`, y perderlo
  // apaga el freno. Con 36 promesas abiertas y una sola cerrada, el recorte quería tirar 6, solo
  // encontraba esa 1, y la tiraba — resultado medido: 9 disculpas en 6 h en vez de 3, el freno
  // desapareciendo justo en la tormenta que existe para frenar.
  // Se guarda UNA sola —el reloj es un instante, no una lista—: si se conservaran todas las que
  // comparten ese instante, cuarenta vencidas juntas quedarían intactas y el techo del archivo
  // dejaría de existir.
  const ultimo = ultimoAnuncioDe(lista);
  const guardar = ultimo > 0 ? lista.find((p) => p.anuncioEn && Date.parse(p.anuncioEn) === ultimo)?.id : undefined;
  const tirar = new Set(
    cerradas
      .slice(0, lista.length - MAX_PROMESAS)
      .filter((p) => p.id !== guardar)
      .map((p) => p.id)
  );
  return lista.filter((p) => !tirar.has(p.id));
}

/** Cuándo salió el último mensaje de este carril. Vive en la propia lista, que ya se persiste. */
function ultimoAnuncioDe(lista: readonly Promesa[]): number {
  let max = 0;
  for (const p of lista) {
    const t = p.anuncioEn ? Date.parse(p.anuncioEn) : NaN;
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * Se manda con su PROPIA llamada a `mandarASlack`, pasando `threadTs: aviso.hilo ?? undefined`.
 *
 * Estuvo un rato viajando adentro de `decidirSiHablar` para que el canal tuviera "un solo número", y
 * ahí perdía las dos cosas que lo hacen un cierre de promesa: cuando había cualquier otra razón esa
 * vuelta salía PEGADO al aviso de la guardia, o sea sin el `hilo` donde se prometió y con el motivo
 * del otro aviso en el log ("Hice esto: soltar_dominio corp-delivery.com" con el "Te dije que te
 * avisaba…" de pie de página, en el canal suelto). Una respuesta dentro de un hilo no suena el
 * canal: el argumento del número no se le aplicaba. El freno de este carril es
 * `MINUTOS_ENTRE_DISCULPAS`, acá adentro y sin tocar el presupuesto de avances de la fábrica —
 * compartirlo hacía que diez cierres de promesa taparan un SPAM→INBOX.
 */
export interface AvisoPromesa {
  texto: string;
  /** El hilo donde se prometió. `null` = canal suelto. */
  hilo: string | null;
  /** Va al log, no a Slack. */
  motivo: string;
}

/**
 * La guardia mira sus promesas contra los dos últimos snapshots de campos observables y cierra las
 * que correspondan. PURA: no ejecuta acciones, no llama a ningún modelo, no toca disco.
 *
 * DOS ESTADOS Y NADA MÁS, a propósito:
 *   · CUMPLIDA — el campo de `esperando` cambió entre los dos snapshots. Sale UN mensaje con los
 *     DOS valores, en el hilo donde se prometió.
 *   · VENCIDA — pasaron `HORAS_PARA_VENCER` sin cambio. Sale UN mensaje honesto y se cierra, con dos
 *     textos distintos según lo que se descubrió: "no se movió en 6 h" cuando alguien lo mide, y
 *     "nadie está midiendo eso" cuando la clave prometida no existe en el retrato.
 * No hay tercer estado, ni recordatorios, ni "sigo esperando": ese goteo es el ruido que la queja 2
 * vino a matar, y convertiría el arreglo de la queja 1 en un generador nuevo del mismo problema.
 *
 * EL TEXTO ES UNA PLANTILLA SOBRE LOS DOS VALORES, no lo redacta el modelo. Si lo redactara podría
 * inventar el número —es el pecado que `revisarRespuesta` viene marcando— y una promesa cumplida
 * con un número inventado es peor que una promesa olvidada.
 *
 * UN MENSAJE POR VUELTA COMO MÁXIMO. Con 7 promesas en una tarde y una guardia que corre 144 veces
 * por día, sin este tope se reproducen los ~25 mensajes de la noche del 2026-08-06 con mejor excusa.
 */
export function revisarPromesas(
  lista: readonly Promesa[],
  camposPrevios: Record<string, string | number | null>,
  camposAhora: Record<string, string | number | null>,
  ahoraISO: string,
  /**
   * Cuándo se tomó `camposPrevios` (el `generadoEn` del snapshot anterior). `null` = no se sabe, y
   * entonces NADA puede cumplirse esta vuelta: solo vencer. Es un parámetro obligatorio y no un
   * opcional con default a propósito — el que cablea tiene que decidir qué pasa, no heredar un
   * silencio.
   */
  previosDe: string | null
): { aviso: AvisoPromesa | null; lista: Promesa[] } {
  const base = Array.isArray(lista) ? [...lista] : [];
  const ahora = Date.parse(ahoraISO);
  const previos = camposPrevios ?? {};
  const actuales = camposAhora ?? {};
  // SNAPSHOT PREVIO VACÍO = NADIE CUMPLIÓ NADA. Es el mismo fail-closed que ya tiene `novedades()`
  // en slack.ts, y faltaba justo acá: con `previos = {}` toda promesa abierta se cerraba como
  // CUMPLIDA anunciando "pasó de sin medir a X" — un cambio que nunca ocurrió. No es hipotético: el
  // `camposAntes` del orquestador sale de una lectura de disco con `.catch(() => null)`, así que un
  // tropiezo de lectura lo dispara, y el mensaje fabricado sale justo en el canal que existe para
  // reconstruir la confianza. Las VENCIDAS siguen su curso: esas no afirman ningún dato.
  const sinSnapshotPrevio = Object.keys(previos).length === 0;
  const previosMs = previosDe ? Date.parse(previosDe) : NaN;

  const cumplidas: Array<{ p: Promesa; linea: string }> = [];
  const vencidas: Array<{ i: number; p: Promesa; linea: string }> = [];
  // El reloj de las disculpas sale de la propia lista, que ya se persiste: cero estado nuevo del
  // lado de quien cablea, y sobrevive a los reinicios (17 en 29 h el 2026-08-06).
  const ultimoAnuncio = ultimoAnuncioDe(base);

  for (let i = 0; i < base.length; i++) {
    const p = base[i] as Promesa;
    if (p.cerradaEn) continue;

    const k = p.esperando;
    const valorAhora = k ? normalizar(actuales[k]) : null;
    // EL CAMBIO TIENE QUE SER POSTERIOR A LA PROMESA. La ventana del diff es (snapshot anterior →
    // ahora), y una promesa hecha DESPUÉS de ese snapshot se cerraba con un cambio que ya había
    // ocurrido antes de prometer nada: "te dije que te avisaba y pasó de SPAM a INBOX" sobre un dato
    // de dos minutos antes de la promesa. Cumplir con un dato viejo es la misma mentira que no
    // cumplir, con peor cara.
    const datoPosterior = Number.isFinite(previosMs) && Date.parse(p.abiertoEn) <= previosMs;
    // Solo cumple un DATO, nunca su ausencia: si el campo desapareció del snapshot nuevo, eso no es
    // una novedad, es un punto ciego. Ausencia de dato no es evidencia de nada — y un "pasó de
    // INBOX a sin medir" sería exactamente el mensaje fabricado que no queremos mandar.
    if (!sinSnapshotPrevio && datoPosterior && k && valorAhora !== null && valorAhora !== normalizar(previos[k])) {
      cumplidas.push({
        p,
        linea: `Te dije que te avisaba de ${p.que} — ${k} pasó de ${comoTexto(normalizar(previos[k]))} a ${comoTexto(valorAhora)}.`
      });
      // Una cumplida SIEMPRE sale (el freno de abajo solo actúa cuando no hay ninguna), así que se
      // cierra y se marca anunciada acá mismo.
      base[i] = { ...p, cerradaEn: ahoraISO, comoCerro: "cumplida", anuncioEn: ahoraISO };
      continue;
    }

    // Una promesa cuya fecha no se puede leer se cierra en vez de quedar abierta para siempre: un
    // registro que no se puede fechar no se puede cumplir, y prefiero decirlo a acumularlo.
    const vence = Date.parse(p.venceEn);
    if (!Number.isFinite(vence) || (Number.isFinite(ahora) && ahora >= vence)) {
      // CALLADA = ya hubo una disculpa por lo mismo en las últimas 24 h (lo marcó `anotarPromesa`).
      // Se cierra sin ruido: el registro queda en el archivo, que es donde se audita.
      if (p.callada) {
        base[i] = { ...p, cerradaEn: ahoraISO, comoCerro: "vencida" };
        continue;
      }
      // DOS TEXTOS, y el segundo es el que faltaba. Una promesa cuyo disparador NO existe en el
      // retrato se cerraba en silencio, y ese resultaba ser el caso MEDIDO y no el borde: las 5
      // promesas reales del 2026-08-06 hablan de dominios sin un solo ciclo, así que ninguna
      // producía clave `placement:` y ninguna decía nada. Para el jefe eso es la queja 1 intacta.
      // Decirle "nadie está midiendo eso" es más honesto que el silencio y encima es accionable: le
      // está diciendo que ese dominio no tiene ciclos.
      const medible = k !== null && Object.prototype.hasOwnProperty.call(actuales, k);
      vencidas.push({
        i,
        p,
        linea: medible
          ? `Te dije que te avisaba de ${p.que} y no se movió en ${HORAS_PARA_VENCER} h, así que lo cierro.`
          : `Te dije que te avisaba de ${p.que} y resulta que nadie está midiendo eso${k ? ` (${k})` : ""}: no lo voy a poder cumplir.`
      });
    }
  }

  // EL FRENO DE LAS DISCULPAS. Si el mensaje sería SOLO disculpas y hace menos de
  // `MINUTOS_ENTRE_DISCULPAS` que salió el anterior, no sale y las promesas quedan ABIERTAS — no se
  // cierran mudas, que es como se reconstruye la queja 1 adentro de su propio arreglo. Ya están
  // vencidas: esperar dos horas más no les quita nada y encima las junta en un solo mensaje.
  // Cuando hay una cumplida el mensaje sale igual, así que las vencidas viajan gratis.
  const muyPronto =
    cumplidas.length === 0 && ultimoAnuncio > 0 && Number.isFinite(ahora) && ahora - ultimoAnuncio < MINUTOS_ENTRE_DISCULPAS * 60_000;
  if (cumplidas.length === 0 && (vencidas.length === 0 || muyPronto)) return { aviso: null, lista: recortar(base) };

  for (const v of vencidas) base[v.i] = { ...v.p, cerradaEn: ahoraISO, comoCerro: "vencida", anuncioEn: ahoraISO };

  const lineas = [...cumplidas.map((c) => c.linea), ...vencidas.map((v) => v.linea)];
  const visibles = lineas.slice(0, MAX_LINEAS);
  if (lineas.length > visibles.length) visibles.push(`(y ${lineas.length - visibles.length} promesa(s) más que cierro igual, sin dato.)`);

  // El mensaje sale en el hilo de la PRIMERA que se cierra, con las cumplidas primero: son las que
  // traen dato y las que el jefe estaba esperando.
  // ponytail: si se cierran juntas promesas de hilos distintos, todas salen en ese hilo. Un mensaje
  // por vuelta pesa más que el hilo exacto de cada línea; si alguna vez molesta, se agrupa por hilo
  // y se manda una vuelta por grupo (hay una vuelta cada 10 minutos, sobra tiempo).
  const primera = (cumplidas[0]?.p ?? (vencidas[0] as { p: Promesa }).p) as Promesa;
  const motivo =
    cumplidas.length > 0
      ? `cumplo lo prometido${vencidas.length > 0 ? ` (+${vencidas.length} vencida${vencidas.length > 1 ? "s" : ""})` : ""}`
      : `promesa vencida${vencidas.length > 1 ? ` (${vencidas.length})` : ""}`;

  return { aviso: { texto: visibles.join("\n"), hilo: primera.hilo, motivo }, lista: recortar(base) };
}

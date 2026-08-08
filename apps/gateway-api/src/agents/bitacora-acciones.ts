// LA MEMORIA DE LO QUE HIZO — no de lo que dijo.
//
// El agente escribía sus acciones y nunca se las devolvían. Resultado medido: propuso frenar el
// mismo dominio DIEZ veces seguidas en dos horas, y las diez se rechazaron. Cada vuelta arrancaba
// de cero, así que no podía enterarse de que ya lo había pedido, ni de que se lo habían negado, ni
// de si sirvió cuando sí se ejecutó.
//
// Su otra memoria (los "reparos" de la verificación) guarda errores de REDACCIÓN. Esto guarda
// DESENLACES, que es lo que hace falta para aprender de lo que uno resuelve.
//
// Todo acá es PURO: sin red, sin Postgres, sin disco. Igual que `verificarLectura`, para que se
// pueda probar sin montar el mundo.

/** Qué pasó con una acción que el agente decidió. */
export type EstadoAccion = "ejecutada" | "rechazada" | "fallada";

/** El desenlace, medido en los datos DESPUÉS. `null` mientras no haya pasado suficiente tiempo. */
export interface Veredicto {
  cuando: string;
  /** `sirvio` | `no_sirvio` | `sin_evidencia` — nunca se infiere: sale de comparar antes contra después. */
  resultado: "sirvio" | "no_sirvio" | "sin_evidencia";
  /** El dato concreto que lo sostiene, en una frase. Sin esto el veredicto es una opinión. */
  medido: string;
}

export interface EntradaAccion {
  /** Estable por (accion, objetivo): repetir la misma pide sube `veces`, no crea otra entrada. */
  id: string;
  accion: string;
  /** Dominio, id de pendiente, o null si es global. */
  objetivo: string | null;
  motivo: string;
  estado: EstadoAccion;
  /** Por qué se rechazó o falló. `null` si se ejecutó bien. */
  detalle: string | null;
  primeraVez: string;
  ultimaVez: string;
  /**
   * CUÁNDO SE EJECUTÓ POR ÚLTIMA VEZ DE VERDAD. Se setea al ejecutar y NO SE LIMPIA NUNCA.
   *
   * Existe por una línea que costó todo el aprendizaje del agente: `registrar` PISA `estado` en cada
   * re-registro (abajo, :"estado: entrada.estado"), y `juzgar` exigía `estado === "ejecutada"`. O sea
   * que un `frenar_dominio` que SÍ se ejecutó y a la vuelta siguiente se rechaza por idempotencia
   * ("ya está en cap 0") queda con `estado: "rechazada"` y se vuelve INELEGIBLE PARA JUICIO PARA
   * SIEMPRE. Medido en la Mac Studio (runtime/openclaw-workspace/inventory/warmup-acciones.json,
   * 2026-08-07): 40 entradas, 0 veredictos, 0 con `antes`. Y la maquinaria de juicio está COMPLETA
   * desde hace semanas — emite textual "<dominio> sigue con cupo N: el freno no quedó puesto"
   * (scripts/ops/warmup-monitor.ts:924) — nunca llegó a correr una sola vez.
   *
   * Consecuencia real: el hecho de que su propio freno se DESHAGA (46 nodos pasaron de cap 0 a cap
   * por dominio el 2026-08-04 y nadie sabe quién los escribe) no le llegaba nunca al modelo, y el
   * censo lo devolvió como "43 episodios de no se midió el efecto de mis propias acciones".
   *
   * `estado` sigue siendo el ÚLTIMO desenlace (lo que hay que mostrarle al modelo); esto es el
   * HISTÓRICO de ejecución (lo que decide si hay algo que juzgar). Son dos preguntas distintas y por
   * eso son dos campos: un solo campo obligaba a elegir cuál mentir.
   *
   * Opcional en la práctica: las 40 entradas que ya están en producción no lo tienen. `juzgar` cae
   * a `estado === "ejecutada"` para esas, que es lo que había antes y no empeora nada.
   *
   * ponytail: acá está además la fecha que le falta a `daLoMismo` para poder expirar el corte por
   * tiempo (ver su comentario: "esa fecha hoy no se guarda"). NO se usa para eso en este lote —
   * cambiar el corte es otra decisión, con otro riesgo. Se guarda y queda anotado.
   */
  ultimaEjecucion: string | null;
  /** Cuántas veces la pidió. Es EL número que corta el bucle de repetición. */
  veces: number;
  /**
   * Cuántas veces SEGUIDAS volvió el MISMO resultado.
   *
   * "Resultado" es `detalle ?? motivo`, y esa disyunción NO es defensiva: es la forma exacta con la
   * que escribe el único llamador real. En scripts/ops/warmup-monitor.ts la entrada se arma con
   * `motivo: a.detalle` y `detalle: a.ejecutada ? null : a.detalle`, así que en una acción EJECUTADA
   * —que es justo el caso medido, las 34 respuestas idénticas de `diagnosticar_dominio`— el texto
   * del resultado viaja en `motivo` y `detalle` llega en `null`. Comparando solo `detalle`, el
   * contador nunca se movía para las manos que sí se ejecutan: el corte habría quedado escrito y
   * apagado, que es la falla que este lote entero viene a cerrar.
   *
   * El incidente, medido en producción sobre warmup-acciones.json: 300 acciones en 233 vueltas, y
   * la misma —`diagnosticar_dominio bizregistry-ops.com`— pedida 34 veces recibiendo 34 veces la
   * misma respuesta. `veces` ya subía y el prompt ya lo decía en PROSA ("lo pediste 34 veces"), que
   * es exactamente la forma que este proyecto ya pagó dos veces: un criterio en párrafo el modelo
   * lo devuelve como hallazgo propio y sigue de largo. Un bucle no se corta pidiéndole al modelo
   * que no lo repita; se corta en el ejecutor, con un número.
   *
   * Cuenta la corrida ACTUAL: `1` la primera vez y en cuanto el resultado cambia, `2` cuando las
   * dos últimas fueron idénticas. Opcional porque los registros que ya están en producción no lo
   * tienen: ausente cuenta como 1, que es la dirección segura (no corta nada).
   *
   * ponytail: comparar el string exacto no distingue "cambió poco" de "no cambió". Alcanza para el
   * caso medido —las 34 respuestas eran idénticas carácter a carácter—; si aparece un detalle con
   * un timestamp adentro, se normaliza acá y no en el llamador.
   */
  detalleIgualSeguidas?: number;
  /** Foto del dato relevante justo ANTES de actuar, para poder juzgar después. */
  antes: Record<string, unknown> | null;
  veredicto: Veredicto | null;
}

export interface Bitacora {
  version: 1;
  entradas: EntradaAccion[];
}

/** Cuántas entradas se conservan. Más allá de esto no aporta y solo infla el archivo. */
const MAX_ENTRADAS = 40;

export function bitacoraVacia(): Bitacora {
  return { version: 1, entradas: [] };
}

export function idDe(accion: string, objetivo: string | null): string {
  return `${accion}:${objetivo ?? "*"}`;
}

/**
 * Un `motivo` que arranca así NO es el resultado de nada: es la PREGUNTA del jefe.
 *
 * Lo escribe el carril de chat (`motivo: \`pedido por el jefe: ${m.texto.slice(0, 80)}\``,
 * scripts/ops/warmup-monitor.ts), que además nulea `detalle` en las ejecutadas. Con eso,
 * `detalleIgualSeguidas` terminaba comparando la pregunta del jefe contra sí misma, y las dos cosas
 * que salen de ese contador se volvían falsas a la vez:
 *
 *   · el prompt le decía al modelo "lo pediste 3 veces y las últimas 3 devolvieron lo mismo" sobre
 *     tres lecturas que habían devuelto cosas DISTINTAS (medido: "1 lista negra: RATS Dyna" / "0
 *     listas negras, ya salió" / "3 listas negras"), y
 *   · `daLoMismo` devolvía 3 y el ejecutor CORTABA la mano.
 *
 * O sea, exactamente el incidente del encargo: el jefe repregunta y el agente se niega a mirar
 * diciendo que ya dio la misma respuesta. La repregunta del jefe es la señal MENOS parecida a un
 * bucle que hay.
 *
 * DÓNDE QUEDÓ LA COSA: el carril de chat ya pasa `detalle: a.detalle` en las ejecutadas, así que por
 * ahí el fallback no se alcanza y esto no dispara. Queda igual, y no es paranoia: el carril de
 * GUARDIA sigue nuleando `detalle` en las ejecutadas y apoyándose en el fallback (es su antibucle
 * medido, ver `resultado`), o sea que la puerta por la que entró esto sigue abierta para cualquier
 * llamador que combine motivo-pregunta con detalle nulo. Es un cinturón de tres líneas sobre una
 * falla que ya se pagó.
 *
 * ponytail: `^pedido por el jefe:` es el único prefijo que hoy se declara a sí mismo como pregunta.
 * Si aparece otro, se suma acá y no en el llamador — la regla de qué NO es un resultado vive en el
 * mismo lugar que la comparación, o vuelve a quedar sin dueño. El arreglo de raíz definitivo es que
 * NINGÚN carril nulee `detalle`, y ahí se borra la constante y el fallback juntos.
 */
export const MOTIVO_QUE_NO_ES_RESULTADO = /^pedido por el jefe:/i;

/**
 * El texto del resultado, esté en el campo que esté. Ver `detalleIgualSeguidas`.
 *
 * El fallback a `motivo` NO es pereza: el carril de GUARDIA pasa `motivo: a.detalle` y nulea
 * `detalle` en las ejecutadas, así que sin el fallback el antibucle medido (diagnosticar_dominio
 * pedido 46 veces con 8 respuestas idénticas seguidas) dejaría de contar. Lo que se descarta es el
 * motivo que se declara a sí mismo como pregunta, no el motivo en general.
 */
const resultado = (detalle: string | null | undefined, motivo: string | undefined): string => {
  if (detalle !== null && detalle !== undefined) return detalle.trim();
  const m = (motivo ?? "").trim();
  return MOTIVO_QUE_NO_ES_RESULTADO.test(m) ? "" : m;
};

/**
 * Registra una decisión del agente. Si ya pidió lo mismo antes, SUMA en vez de duplicar: la
 * repetición es justamente la señal que hay que devolverle.
 */
export function registrar(
  bit: Bitacora | null,
  entrada: {
    accion: string;
    objetivo: string | null;
    motivo: string;
    estado: EstadoAccion;
    detalle?: string | null;
    antes?: Record<string, unknown> | null;
    cuando: string;
  }
): Bitacora {
  const base = bit && Array.isArray(bit.entradas) ? { ...bit, entradas: [...bit.entradas] } : bitacoraVacia();
  const id = idDe(entrada.accion, entrada.objetivo);
  const i = base.entradas.findIndex((e) => e.id === id);

  if (i >= 0) {
    const previa = base.entradas[i] as EntradaAccion;
    const detalle = entrada.detalle ?? null;
    base.entradas[i] = {
      ...previa,
      motivo: entrada.motivo,
      estado: entrada.estado,
      detalle,
      ultimaVez: entrada.cuando,
      // NUNCA SE LIMPIA. Ver el campo: `estado` lo pisa el último intento, así que sin esto una
      // ejecución real seguida de un rechazo por idempotencia dejaba la entrada fuera del juicio
      // para siempre. La legacy (sin el campo) se rescata acá: si venía en "ejecutada", esa fecha
      // era `ultimaVez` y se adopta, así las 40 entradas que ya están en producción entran al
      // juicio en cuanto alguien las vuelva a pedir.
      ultimaEjecucion:
        entrada.estado === "ejecutada"
          ? entrada.cuando
          : (previa.ultimaEjecucion ?? (previa.estado === "ejecutada" ? previa.ultimaVez : null)),
      veces: previa.veces + 1,
      // EL CONTADOR QUE CORTA EL BUCLE. Sube solo cuando el resultado volvió IDÉNTICO; cualquier
      // cambio lo resetea, porque un resultado distinto es información nueva y pedir otra vez deja
      // de ser un bucle. Ver el comentario del campo: el resultado es `detalle ?? motivo`.
      detalleIgualSeguidas: resultado(detalle, entrada.motivo) !== "" && resultado(detalle, entrada.motivo) === resultado(previa.detalle, previa.motivo)
        ? (previa.detalleIgualSeguidas ?? 1) + 1
        : 1,
      // `antes` se conserva el de la PRIMERA vez: es contra ese estado que se juzga si sirvió.
      antes: previa.antes ?? entrada.antes ?? null
    };
  } else {
    base.entradas.push({
      id,
      accion: entrada.accion,
      objetivo: entrada.objetivo,
      motivo: entrada.motivo,
      estado: entrada.estado,
      detalle: entrada.detalle ?? null,
      primeraVez: entrada.cuando,
      ultimaVez: entrada.cuando,
      ultimaEjecucion: entrada.estado === "ejecutada" ? entrada.cuando : null,
      veces: 1,
      detalleIgualSeguidas: 1,
      antes: entrada.antes ?? null,
      veredicto: null
    });
  }

  // Se conservan las más recientes y se tiran PRIMERO las que ya tienen veredicto: de esas ya se
  // aprendió lo que había para aprender.
  //
  // PERO EL TOPE TIENE QUE CUMPLIRSE IGUAL, y ahí estaba el agujero: el recorte SOLO miraba las
  // juzgadas, y como `juzgar` corre únicamente sobre `frenar_dominio` —de la que no hay una sola
  // entrada en producción— nunca había ninguna para tirar. Medido en warmup-acciones.json de la Mac
  // Studio: 54 entradas contra un tope de 40, o sea 135%, con 0 veredictos. `MAX_ENTRADAS` estaba
  // muerta por construcción y el archivo crecía sin techo, en un JSON que `updateInventoryJson`
  // lee, parsea, re-serializa y reescribe ENTERO bajo lock en cada vuelta.
  //
  // Si después de tirar las juzgadas todavía sobran, mandan las más VIEJAS por `ultimaVez`: una
  // entrada sin veredicto que nadie tocó en días ya no está cortando ningún bucle.
  if (base.entradas.length > MAX_ENTRADAS) {
    const orden = [...base.entradas].sort((a, b) => a.ultimaVez.localeCompare(b.ultimaVez));
    const cuantas = base.entradas.length - MAX_ENTRADAS;
    const juzgadas = orden.filter((e) => e.veredicto !== null).slice(0, cuantas);
    const tirar = new Set(juzgadas.map((e) => e.id));
    for (const e of orden) {
      if (tirar.size >= cuantas) break;
      tirar.add(e.id);
    }
    base.entradas = base.entradas.filter((e) => !tirar.has(e.id));
  }
  return base;
}

/**
 * Cuántas veces seguidas esta acción dio EXACTAMENTE lo mismo. `null` = no hay bucle que cortar.
 *
 * Pura y exportada porque es la regla que consume el ejecutor (`ejecutarAcciones`), y tiene que
 * poder fijarse con un test sin montar la bitácora entera. Quien la usa RECHAZA la acción: el
 * rechazo vuelve al modelo como hecho, que es lo único que este proyecto vio funcionar.
 */
export const IGUALES_PARA_CORTAR = 2;

export function daLoMismo(bit: Bitacora | null, accion: string, objetivo: string | null): number | null {
  const e = (bit?.entradas ?? []).find((x) => x.id === idDe(accion, objetivo));
  if (!e) return null;
  // SOLO SI LO ÚLTIMO FUE UNA EJECUCIÓN. Sin esta condición el corte se vuelve PERMANENTE y eso es
  // peor que el bucle: la propia negativa queda escrita en la entrada, vuelve a leerse igual a sí
  // misma en la vuelta siguiente y la mano queda cerrada para siempre sobre ese objetivo —
  // incluso cuando el mundo cambie y ese nodo empiece a rechazar de verdad. Un agente ciego es peor
  // que uno repetitivo: estas cuatro manos NO mutan nada, su peor caso es un SSH de más.
  //
  // ponytail: amortigua, no corta del todo — con la negativa en el medio el patrón queda
  // ejecutar/ejecutar/frenar, o sea ~1 de cada 3. Alcanza para el caso medido porque el rechazo SÍ
  // le llega al modelo como hecho y es lo que lo mueve. El corte duro necesita expiración por
  // tiempo desde la última EJECUCIÓN, y esa fecha hoy no se guarda (`ultimaVez` la pisa cualquier
  // intento, incluida la negativa, así que una ventana medida contra ella no vencería nunca).
  if (e.estado !== "ejecutada") return null;
  return (e.detalleIgualSeguidas ?? 1) >= IGUALES_PARA_CORTAR ? e.veces : null;
}

/**
 * ¿Esta acción llegó a ejecutarse alguna vez? Es lo que decide si hay efecto que medir.
 *
 * Exportada porque el predicado vive HOY en tres lugares: acá y los dos filtros del orquestador
 * (scripts/ops/warmup-monitor.ts:903 y :917, duplicados a catorce líneas de distancia). Los tres
 * decían `estado === "ejecutada"` y los tres estaban mal por el mismo motivo — `registrar` pisa
 * `estado`. Arreglar uno solo deja el juicio apagado igual, así que la regla se escribe una vez y
 * los tres la importan. Un predicado duplicado es un arreglo que se aplica a medias.
 */
export const seEjecutoAlgunaVez = (e: EntradaAccion): boolean =>
  // El `|| estado === "ejecutada"` es para las 40 entradas que ya están en producción, escritas
  // antes de que `ultimaEjecucion` existiera: sin eso el arreglo dejaría afuera justo a las que lo
  // motivaron.
  Boolean(e.ultimaEjecucion) || e.estado === "ejecutada";

/**
 * Cierra una acción ejecutada comparando el ANTES con el AHORA. No infiere: si no hay con qué
 * comparar, el resultado es `sin_evidencia` — que es una respuesta honesta y no un fracaso.
 */
export function juzgar(
  bit: Bitacora | null,
  id: string,
  ahora: { cuando: string; datos: Record<string, unknown> },
  criterio: (antes: Record<string, unknown> | null, despues: Record<string, unknown>) => Veredicto | null
): Bitacora {
  const base = bit && Array.isArray(bit.entradas) ? { ...bit, entradas: [...bit.entradas] } : bitacoraVacia();
  const i = base.entradas.findIndex((e) => e.id === id);
  if (i < 0) return base;
  const e = base.entradas[i] as EntradaAccion;
  // SE JUZGA LO QUE SE EJECUTÓ ALGUNA VEZ, no lo que terminó en "ejecutada".
  //
  // El filtro decía `e.estado !== "ejecutada"` y ese era EL agujero: `registrar` pisa `estado` en
  // cada re-registro, así que un freno que se aplicó y a la vuelta siguiente se rechazó por
  // idempotencia quedaba inelegible para siempre. 40 entradas y 0 veredictos en producción — la
  // maquinaria de juicio entera, escrita y probada, no corrió NUNCA.
  if (e.veredicto || !seEjecutoAlgunaVez(e)) return base;
  const v = criterio(e.antes, ahora.datos);
  if (v) base.entradas[i] = { ...e, veredicto: { ...v, cuando: ahora.cuando } };
  return base;
}

/**
 * Las líneas que se le devuelven al agente. DATO, no prosa: cada línea es un hecho sobre lo que él
 * mismo pidió. Acotado a `max` porque el prompt ya pesa ~6300 tokens y el relleno fue lo que lo
 * ahogó la vez pasada.
 *
 * Prioridad deliberada: primero lo REPETIDO Y RECHAZADO (el bucle que hay que cortar), después lo
 * ejecutado con veredicto (de lo que puede aprender), y al final el resto.
 */
export function lineasParaPrompt(bit: Bitacora | null, max = 8): string[] {
  const es = bit?.entradas ?? [];
  if (es.length === 0) return [];

  const peso = (e: EntradaAccion): number => {
    if (e.estado !== "ejecutada" && e.veces >= 2) return 0; // lo pidió y se lo negaron, varias veces
    if (e.veredicto) return 1;
    if (e.estado === "ejecutada") return 2;
    return 3;
  };
  const orden = [...es].sort((a, b) => peso(a) - peso(b) || b.ultimaVez.localeCompare(a.ultimaVez));

  return orden.slice(0, max).map((e) => {
    const obj = e.objetivo ? ` ${e.objetivo}` : "";
    // EL CONTADOR VA EN TODAS LAS RAMAS, no solo en la rechazada.
    //
    // Se calculaba desde hace semanas y se interpolaba SOLO en `rechazada`, o sea en 6 de las 40
    // entradas de producción. Las otras 34 son ejecutadas, y ahí está el bucle que duele: 306
    // ejecuciones para 63 resultados distintos (79% repetido), con `diagnosticar_dominio
    // bizregistry-ops.com` pedido 46 veces y `medir_dominio controlnationalcorp.com` 30. El modelo
    // leía "se ejecutó y devolvió: …" como si fuera la primera vez, porque para él LO ERA: cada
    // vuelta arranca de cero y esta línea es todo lo que sabe de su propio pasado.
    //
    // Y CUANDO ADEMÁS VOLVIÓ LO MISMO, se dice cuántas seguidas. OJO con el número: `veces` y
    // `detalleIgualSeguidas` NO son el mismo (la entrada real de producción tiene veces=46 e
    // iguales=8), así que "las 46 devolvieron lo mismo" sería una falsedad medible — exactamente la
    // clase de frase que este proyecto ya pagó. Se dice "las últimas N", que es lo que el contador
    // sabe de verdad.
    const igualSeguidas = e.detalleIgualSeguidas ?? 1;
    const rep =
      e.veces > 1
        ? e.veces >= 3 && igualSeguidas >= 3
          ? ` (lo pediste ${e.veces} veces y las últimas ${igualSeguidas} devolvieron lo mismo)`
          : ` (lo pediste ${e.veces} veces)`
        : "";
    if (e.estado === "rechazada") {
      return `- pediste ${e.accion}${obj}${rep} y NO se ejecutó: ${e.detalle ?? "rechazada"}. Pedirlo otra vez no lo va a cambiar.`;
    }
    if (e.estado === "fallada") {
      return `- ${e.accion}${obj}${rep} se intentó y FALLÓ: ${e.detalle ?? "sin detalle"}.`;
    }
    if (e.veredicto) {
      const r = e.veredicto.resultado === "sirvio" ? "SIRVIÓ" : e.veredicto.resultado === "no_sirvio" ? "NO sirvió" : "todavía sin evidencia";
      return `- ${e.accion}${obj}${rep} se ejecutó y ${r}: ${e.veredicto.medido}.`;
    }
    // EL RESULTADO DE LO QUE SÍ SE EJECUTÓ — y SOLO `e.detalle`, jamás `e.motivo`.
    //
    // La asimetría iba en la dirección cara: de lo RECHAZADO volvía el detalle entero (dos ramas más
    // arriba) y de lo EJECUTADO solo la fecha. Y como `juzgar` solo mira `frenar_dominio`, una
    // `revisar_reputacion` ejecutada queda con veredicto `null` para siempre, así que esta era su
    // única salida y estaba muda. La cláusula "receptor: CERRADO en gmail.com, hotmail.com,
    // outlook.com" sobrevivió al turno siguiente SOLO porque el orquestador la concatena al mensaje
    // de Slack y después la relee del hilo.
    //
    // POR QUÉ NO EL FALLBACK A `motivo`. La primera versión de este arreglo imprimía
    // `resultado(e.detalle, e.motivo)`, el mismo helper que usa `detalleIgualSeguidas`. Suena
    // inofensivo hasta que se mira qué escribe cada carril: el del CHAT —donde ocurrió el
    // incidente— guarda `detalle: a.ejecutada ? null : a.detalle` y `motivo: "pedido por el jefe:
    // <la pregunta del jefe>"`. Corriendo esta función sobre la bitácora REAL de producción
    // (runtime/openclaw-workspace/inventory/warmup-acciones.json, 2026-08-07) salía, textual:
    //
    //   "- revisar_reputacion bizreport-control.com se ejecutó y devolvió: pedido por el jefe:
    //    Entonces que hacemos, ese IP, ese smtp y ese dominio se pierde?"
    //
    // …bajo el título "LO QUE PEDISTE Y QUÉ PASÓ": la PREGUNTA DEL JEFE devuelta como la SALIDA DEL
    // SENSOR. 3 de 33 entradas ejecutadas ese día, las 3 del carril chat. Peor que el silencio que
    // había. `resultado()` se queda para `detalleIgualSeguidas`, que compara y no publica.
    //
    // LOS DOS CARRILES YA NO HACEN LO MISMO, y el comentario que había acá decía lo contrario:
    // afirmaba que "los DOS carriles nulean el detalle de lo ejecutado (warmup-monitor.ts:886 y
    // :1419), así que la rama de arriba no se alcanza en producción". Las dos referencias estaban
    // corridas y la conclusión es falsa en este árbol. Verificado:
    //
    //   scripts/ops/warmup-monitor.ts:947  (guardia) → `detalle: a.ejecutada ? null : a.detalle`
    //   scripts/ops/warmup-monitor.ts:1506 (chat)    → `detalle: a.detalle`
    //
    // O sea que por el carril del CHAT la rama de abajo SÍ se alcanza y es la que va a imprimir
    // "se ejecutó y devolvió: <texto>". En producción hoy los 34 ejecutados tienen `detalle: null`
    // porque corre el código viejo: la rama se enciende recién con el próximo deploy. Un comentario
    // que declara inalcanzable una rama que sí se alcanza es peor que no tenerlo — el que venga a
    // tocar esto va a creer que no puede salir nada por acá.
    //
    // Y POR ESO EL RECORTE. La salida de una herramienta puede ser multilínea y larga (la de la
    // consulta de historia son hasta 13 renglones), y esto se interpola en UNA viñeta de una lista
    // del prompt. Sin acotar, un renglón de bitácora rompe la lista en pedazos y se come el
    // presupuesto de contexto que ya está en ~6300 tokens. Se aplanan los saltos de línea primero:
    // cortar a 300 sin aplanar deja igual una viñeta partida en dos.
    const texto = (e.detalle ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
    return texto
      ? `- ${e.accion}${obj}${rep} se ejecutó y devolvió: ${texto}`
      : `- ${e.accion}${obj}${rep} se ejecutó el ${e.ultimaVez.slice(0, 16)}, todavía sin medir el efecto.`;
  });
}

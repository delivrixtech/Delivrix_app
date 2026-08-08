// LA BÚSQUEDA EN EL PASADO — lo único que el agente no podía hacer de ninguna forma.
//
// EL INCIDENTE, textual del canal el 2026-08-07:
//
//   Juanes:   "¿Cuáles son los otros 4?"
//   Sentinel: "ese dato de los otros 4 lo dije sin tener los nombres verificados delante, y no los
//              tengo en mi lectura actual."
//
// Fue honesto sobre una ceguera que le construimos nosotros. Y esa ceguera es estructural, no un
// campo suelto: verificado por FIRMA, ninguna de las tres memorias que tiene (memoria-conversacion,
// decisiones-del-jefe, bitacora-acciones) recibe la pregunta del jefe como argumento, y ninguna de
// las 11 manos lee memoria. Al chat le llega EXACTAMENTE el mismo paquete si el jefe pregunta
// "¿cómo vamos?" que si pregunta "¿qué pasó con este dominio hace tres semanas?". No es que busque
// mal: no hay dónde buscar.
//
// LO QUE ESTE MÓDULO NO ES. No es una memoria nueva ni un almacén nuevo. Las dos preguntas que
// duelen se contestan con archivos que YA están escritos en disco (ver `FilaHistoria`), así que acá
// no hay tabla, no hay embeddings y no hay pgvector: hay un filtro y un renderizador.
//
// TODO PURO: sin red, sin Postgres, sin disco y SIN RELOJ. Las filas y las fechas se las inyecta el
// orquestador. Un módulo que consulta el reloj no se puede probar sin congelarlo, y acá el reloj es
// justo la parte que miente cuando algo se rompe.

/**
 * Un hecho fechado del pasado. `que` es UNA línea legible, no un blob: quien la produce ya recortó.
 *
 * `origen` separa "lo vi en mi propio retrato" de "lo midió el sistema contra una bandeja". No es
 * decorativo: una lectura del agente es una impresión suya y una medición es evidencia, y este
 * proyecto ya se comió el costo de mezclarlas.
 */
export interface FilaHistoria {
  /** ISO 8601 UTC. Se compara como STRING (ISO ordena lexicográficamente), no se parsea a Date. */
  cuando: string;
  que: string;
  dominio: string | null;
  origen: "hechos" | "placement";
}

/** Un rango de fechas. Acepta `YYYY-MM-DD` o ISO completo; se comparan como strings. */
export interface Rango {
  desde: string;
  hasta: string;
}

/**
 * Cierra el rango a fin de día cuando viene sin hora.
 *
 * Sin esto, pedir `hasta: "2026-07-21"` descarta TODO el 21 —"2026-07-21T09:00Z" > "2026-07-21"— y
 * la respuesta sería "no hay registro" sobre un día que sí tiene filas. Un borde de un carácter que
 * convierte la ausencia en un negativo falso, que es la falla que este módulo existe para no tener.
 */
const finDeDia = (h: string): string => (h.length === 10 ? `${h}T23:59:59.999Z` : h);

/**
 * Las filas que caen en el filtro, de la más NUEVA a la más vieja. SIN tope: el recorte lo hace
 * `historiaDe`, porque tiene que poder DECIRSE.
 *
 * Antes había además un `buscar` exportado que era esto mismo con un `.slice(0, max)` pegado, y
 * cortaba en silencio: 35 mediciones en la ventana salían como 12 renglones presentados como si
 * fueran todo lo que hay. Es la misma familia que "no medido vs cero" —una vista parcial servida
 * como completa— y encima sobre la única mano que el jefe va a usar para preguntar "¿qué pasó con
 * esto?". Se borró: `historiaDe` recorta y avisa cuánto recortó.
 *
 * `dominio` compara exacto (sin distinguir mayúsculas), no por substring: "corp-delivery.com" no
 * puede traer "corp-delivery.com.br" ni al revés. Es un identificador, no texto libre.
 *
 * PRIVADA, como `rangoDe` y `lineasDeHistoria`. Ver `historiaDe`.
 */
function filtrar(
  filas: readonly FilaHistoria[],
  filtro: { dominio?: string | null; desde?: string | null; hasta?: string | null }
): FilaHistoria[] {
  const dom = filtro.dominio?.trim().toLowerCase() || null;
  const desde = filtro.desde || null;
  const hasta = filtro.hasta ? finDeDia(filtro.hasta) : null;

  return filas
    .filter((f) => {
      if (dom && (f.dominio ?? "").toLowerCase() !== dom) return false;
      if (desde && f.cuando < desde) return false;
      if (hasta && f.cuando > hasta) return false;
      return true;
    })
    .sort((a, b) => b.cuando.localeCompare(a.cuando));
}

/**
 * Hasta dónde llega el corpus ENTERO (no el filtrado). `null` si no hay ni una fila.
 *
 * Se calcula acá y no en el llamador a propósito: es el dato del que depende el invariante (b) de
 * `lineasDeHistoria`, y dejarlo del otro lado sería confiar en que quien llama haga bien un
 * min/max. La honestidad de la respuesta no puede depender de eso.
 */
function rangoDe(filas: readonly FilaHistoria[]): Rango | null {
  if (filas.length === 0) return null;
  let desde = filas[0]!.cuando;
  let hasta = filas[0]!.cuando;
  for (const f of filas) {
    if (f.cuando < desde) desde = f.cuando;
    if (f.cuando > hasta) hasta = f.cuando;
  }
  return { desde, hasta };
}

const dia = (s: string): string => s.slice(0, 10);
const fechaHora = (s: string): string => s.slice(0, 16).replace("T", " ");

/**
 * Lo que se le devuelve al que preguntó. DOS INVARIANTES EN CÓDIGO, no en prosa:
 *
 * (a) SIN FILAS SE DICE "NO HAY REGISTRO", NUNCA UN CERO. Hay un agujero real de 13 días en
 *     `delivrix.warmup_activity` —ni una fila entre el 2026-07-21 y el 2026-08-02— así que el rango
 *     vacío es el caso NORMAL, no el borde. Y la lección más cara del proyecto es justo esta: "no
 *     medido" y "cero" no son lo mismo. Un "0% de inbox" sobre un rango sin datos manda a frenar
 *     una flota que estaba bien.
 *
 * (b) TODA RESPUESTA DECLARA DESDE CUÁNDO HAY REGISTRO. El corpus de destilación arrancó el
 *     2026-08-06 y se llena solo mientras el maestro corra; si el maestro se cae, la fuente se seca
 *     EN SILENCIO y las filas viejas siguen ahí. Sin esta línea, "no encontré nada del 20 de julio"
 *     se lee como "no pasó nada el 20 de julio", cuando lo cierto es "empecé a guardar el 6 de
 *     agosto". Es la misma frase que el agente tuvo que improvisar a mano en el canal.
 *
 * `filas` es la ventana YA recortada; `disponible` es `rangoDe(TODAS las filas)`, sin filtrar. Que
 * los dos argumentos vengan de fuentes distintas es justo lo que se puede combinar mal, y por eso
 * esta función es privada: la arma `historiaDe` y nadie más.
 */
function lineasDeHistoria(
  filas: readonly FilaHistoria[],
  pedido: Rango,
  disponible: Rango | null,
  /** Cuántas filas caían en la ventana ANTES del tope. Ver el recorte mudo, abajo. */
  totalEnLaVentana = filas.length
): string[] {
  // (b) primero y SIEMPRE, esté vacío o no. Si va al final, un recorte por longitud se la come.
  //
  // Y CUANDO SE RECORTÓ, SE DICE. Doce renglones de treinta y cinco presentados como si fueran todo
  // lo que hay es una vista parcial servida como completa: el que lea va a concluir "solo pasó esto"
  // sobre una ventana en la que pasó el triple.
  const recorte =
    totalEnLaVentana > filas.length ? ` Hay ${totalEnLaVentana} registros en esa ventana y te muestro los ${filas.length} más recientes.` : "";
  const horizonte = disponible
    ? `- tengo registro desde el ${dia(disponible.desde)} y hasta el ${dia(disponible.hasta)}; fuera de esa ventana no guardo nada.${recorte}`
    : `- no tengo NADA guardado todavía: no es que no haya pasado nada, es que no lo registré.`;

  if (filas.length === 0) {
    return [
      // Ni un número acá adentro: el vacío se dice con palabras. Ver invariante (a).
      `- no hay registro entre el ${dia(pedido.desde)} y el ${dia(pedido.hasta)} — sin registro no puedo afirmar qué pasó, y tampoco que no pasó nada.`,
      horizonte
    ];
  }

  return [
    horizonte,
    ...filas.map((f) => {
      const quien = f.dominio ? ` ${f.dominio}` : "";
      const sello = f.origen === "placement" ? "medición" : "lectura";
      return `- ${fechaHora(f.cuando)} (${sello})${quien}: ${f.que}`;
    })
  ];
}

/**
 * LA ÚNICA PUERTA. Recibe el corpus ENTERO y devuelve las líneas listas.
 *
 * Existe porque el handoff que cableaba esto lo hizo mal de la única forma en que se podía: le pasó
 * a `rangoDe` las filas YA FILTRADAS por ventana. Con eso, las dos afirmaciones que este módulo
 * existe para no hacer salían falsas:
 *
 *   · ventana vacía sobre un corpus lleno → "no tengo NADA guardado todavía", o sea el agente
 *     declarándole al jefe que no tiene una memoria que sí tiene;
 *   · ventana de un día sobre 35 filas del 01 al 07 → "tengo registro desde el 03 y hasta el 03;
 *     fuera de esa ventana no guardo nada", o sea negándose a mirar días que sí guardó.
 *
 * `rangoDe` se puso adentro del módulo justamente para que el horizonte no quedara "librado a que
 * quien llama haga bien un min/max", y aun así el llamador lo llamó con el argumento equivocado. La
 * lección es que una función pública que se puede usar mal se va a usar mal: la forma de cerrarlo no
 * es un comentario, es no darle al llamador las tres piezas sueltas.
 *
 * Y ESO ES LITERAL AHORA, no una intención. Antes decía esto mismo mientras `filtrar`, `rangoDe`,
 * `lineasDeHistoria` y un `buscar` seguían EXPORTADOS: la puerta estaba escrita como única y las
 * cuatro ventanas abiertas al lado. Peor todavía, la receta de cableado que le quedó al próximo
 * agente decía textual `lineasDeHistoria(buscar(filas, {…}), {desde, hasta}, rangoDe(filas))` —el
 * bug reintroducido tal cual, y con TODOS los tests en verde, porque probaban el interior de
 * `historiaDe` y no al llamador. Hoy no se exportan: el error no se puede volver a escribir.
 *
 * El recorte temporal lo hace ESTA función, no el productor de filas: quien lea de Postgres o del
 * disco devuelve todo lo del dominio y nada más. Es un SELECT por dominio, chico.
 */
export function historiaDe(
  todas: readonly FilaHistoria[],
  pedido: Rango & { dominio?: string | null },
  max = 12
): string[] {
  const enLaVentana = filtrar(todas, { dominio: pedido.dominio, desde: pedido.desde, hasta: pedido.hasta });
  return lineasDeHistoria(enLaVentana.slice(0, max), pedido, rangoDe(todas), enLaVentana.length);
}

/**
 * ¿Esta línea del retrato del día HABLA DE este dominio, o solo lo nombra?
 *
 * El handoff filtraba con `l.includes(dominio)`, y las dos líneas más largas del prompt son
 * ENUMERACIONES. Medido contra el corpus real de producción (warmup-destilacion.json, 58 ejemplos):
 * pidiendo la historia de corp-delivery.com, `includes` devolvía tres líneas y dos eran basura de
 * atribución — el estado de la flota entera ("6 entregan, 35 cerradas por el receptor, 10 con la
 * cola atascada"), que matcheaba solo porque el dominio figura en la lista de cruzados, y la lista
 * de pendientes, que es prosa que escribió el propio agente. El estado de 51 nodos fechado y firmado
 * a nombre de un dominio es exactamente el hecho ambiguo que este proyecto ya pagó.
 *
 * `construirPrompt` emite las líneas POR dominio como `- <dominio>: …` o `- <dominio> (<ip>): …`
 * (plan, vecindario, reputación, frenados), así que el prefijo alcanza y no hay que enumerar casos.
 *
 * Y EL CARÁCTER QUE SIGUE IMPORTA: con el prefijo pelado, "corp-delivery.com" se lleva las líneas de
 * "corp-delivery.com.br". Es la misma regla que `buscar` aplica al comparar dominios enteros —un
 * identificador no es texto libre— y romperla acá sería servirle al jefe la historia de otro nodo
 * con nombre parecido, que es exactamente lo que el test de `buscar` ya prohíbe del otro lado.
 */
export function esLineaDe(linea: string, dominio: string): boolean {
  const dom = dominio.trim().toLowerCase();
  const l = linea.trimStart().toLowerCase();
  if (dom === "" || !l.startsWith(`- ${dom}`)) return false;
  const sigue = l.charAt(2 + dom.length);
  return sigue === "" || !/[a-z0-9.-]/.test(sigue);
}

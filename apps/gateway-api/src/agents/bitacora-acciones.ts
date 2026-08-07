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

/** El texto del resultado, esté en el campo que esté. Ver `detalleIgualSeguidas`. */
const resultado = (detalle: string | null | undefined, motivo: string | undefined): string => (detalle ?? motivo ?? "").trim();

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
  if (e.estado !== "ejecutada" || e.veredicto) return base; // solo se juzga lo que se ejecutó, y una vez
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
    const rep = e.veces > 1 ? ` (lo pediste ${e.veces} veces)` : "";
    if (e.estado === "rechazada") {
      return `- pediste ${e.accion}${obj}${rep} y NO se ejecutó: ${e.detalle ?? "rechazada"}. Pedirlo otra vez no lo va a cambiar.`;
    }
    if (e.estado === "fallada") {
      return `- ${e.accion}${obj} se intentó y FALLÓ: ${e.detalle ?? "sin detalle"}.`;
    }
    if (e.veredicto) {
      const r = e.veredicto.resultado === "sirvio" ? "SIRVIÓ" : e.veredicto.resultado === "no_sirvio" ? "NO sirvió" : "todavía sin evidencia";
      return `- ${e.accion}${obj} se ejecutó y ${r}: ${e.veredicto.medido}.`;
    }
    return `- ${e.accion}${obj} se ejecutó el ${e.ultimaVez.slice(0, 16)}, todavía sin medir el efecto.`;
  });
}

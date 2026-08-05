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
    base.entradas[i] = {
      ...previa,
      motivo: entrada.motivo,
      estado: entrada.estado,
      detalle: entrada.detalle ?? null,
      ultimaVez: entrada.cuando,
      veces: previa.veces + 1,
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
      antes: entrada.antes ?? null,
      veredicto: null
    });
  }

  // Se conservan las más recientes, PERO nunca se tira una que todavía no tiene veredicto: esa es
  // exactamente la que falta juzgar, y perderla es perder el aprendizaje.
  if (base.entradas.length > MAX_ENTRADAS) {
    const orden = [...base.entradas].sort((a, b) => a.ultimaVez.localeCompare(b.ultimaVez));
    const sobran = orden.filter((e) => e.veredicto !== null).slice(0, base.entradas.length - MAX_ENTRADAS);
    const tirar = new Set(sobran.map((e) => e.id));
    base.entradas = base.entradas.filter((e) => !tirar.has(e.id));
  }
  return base;
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

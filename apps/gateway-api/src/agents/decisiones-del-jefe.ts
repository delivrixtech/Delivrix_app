// LO QUE EL JEFE YA DECIDIÓ, y no hay que volver a preguntarle.
//
// El problema que resuelve, textual del jefe: "ya se lo he dicho y ni entiende". Le dijo que las
// semillas de Outlook y Yahoo NO van a llegar por ahora y que trabaje con las dos que hay — y en
// el turno siguiente el agente volvió a pedirlas, porque los HECHOS siguen diciendo "punto ciego
// en outlook y yahoo" y él no tenía dónde guardar que eso ya está decidido.
//
// Un hecho dice cómo está el mundo. Una decisión dice qué se va a hacer al respecto. El agente
// tenía lo primero y no tenía lo segundo, así que cada 10 minutos redescubría el mismo problema.
//
// Todo puro: sin red, sin disco. La persistencia es de quien llama.

export interface Decision {
  id: string;
  /** Lo que el jefe decidió, en sus términos. */
  que: string;
  cuando: string;
  /** El mensaje del que salió, para poder auditar de dónde vino. */
  origen: string;
  /** Cuántas veces se le recordó al agente. Sirve para ver si insiste igual. */
  recordada: number;
}

export interface Decisiones {
  version: 1;
  items: Decision[];
}

/** Más allá de esto, el prompt se infla y vuelve el problema que quisimos evitar. */
const MAX = 12;

export function vacias(): Decisiones {
  return { version: 1, items: [] };
}

/**
 * Normaliza para comparar: sin acentos, sin puntuación, en minúsculas.
 *
 * Exportada para que memoria-conversacion.ts agrupe con la MISMA normalización que usa `esLaMisma`
 * por dentro. Una copia local se desincroniza y el agrupamiento empieza a contradecir a la
 * comparación: dos textos caerían en grupos distintos y `esLaMisma` diría que son el mismo.
 */
export function clave(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿Las dos decisiones dicen lo mismo? Por solapamiento de palabras y no por igualdad exacta: el
 * jefe no repite la frase textual, la dice distinta cada vez. Sin esto la lista crece con la misma
 * decisión escrita de cinco formas y el prompt se llena de ruido.
 */
export function esLaMisma(a: string, b: string): boolean {
  const pa = new Set(clave(a).split(" ").filter((w) => w.length > 3));
  const pb = new Set(clave(b).split(" ").filter((w) => w.length > 3));
  if (pa.size === 0 || pb.size === 0) return clave(a) === clave(b);
  let comunes = 0;
  for (const w of pa) if (pb.has(w)) comunes++;
  return comunes / Math.min(pa.size, pb.size) >= 0.6;
}

export function recordar(
  dec: Decisiones | null,
  entrada: { que: string; origen: string; cuando: string }
): Decisiones {
  const base = dec && Array.isArray(dec.items) ? { ...dec, items: [...dec.items] } : vacias();
  const texto = entrada.que.trim();
  if (texto.length < 5) return base;

  const i = base.items.findIndex((d) => esLaMisma(d.que, texto));
  if (i >= 0) {
    // Ya la sabía: se refresca la fecha, no se duplica. Que el jefe la repita es señal de que el
    // agente no la estaba respetando, no de que sea una decisión nueva.
    base.items[i] = { ...(base.items[i] as Decision), cuando: entrada.cuando, origen: entrada.origen };
    return base;
  }

  base.items.push({
    id: `d-${base.items.length + 1}-${clave(texto).split(" ").slice(0, 3).join("-")}`,
    que: texto,
    cuando: entrada.cuando,
    origen: entrada.origen.slice(0, 160),
    recordada: 0
  });
  // Las más recientes mandan: una decisión de hace semanas puede estar revocada por la realidad.
  if (base.items.length > MAX) base.items = base.items.slice(-MAX);
  return base;
}

/** Olvida una decisión: el jefe cambió de opinión y hay que poder decirlo. */
export function olvidar(dec: Decisiones | null, id: string): Decisiones {
  const base = dec && Array.isArray(dec.items) ? { ...dec, items: [...dec.items] } : vacias();
  base.items = base.items.filter((d) => d.id !== id);
  return base;
}

/**
 * Las líneas que van al prompt de los DOS carriles. Se marcan como decisiones ya tomadas, no como
 * sugerencias: la diferencia es lo que hace que el agente deje de pedir lo mismo.
 */
export function lineasParaPrompt(dec: Decisiones | null): string[] {
  const items = dec?.items ?? [];
  if (items.length === 0) return [];
  return [
    "DECISIONES YA TOMADAS POR JUANES. No las cuestiones ni vuelvas a pedir lo que ya te dijo que",
    "no vas a tener. Si un dato de arriba las contradice, ganan estas:",
    ...items.map((d) => `- ${d.que}`)
  ];
}

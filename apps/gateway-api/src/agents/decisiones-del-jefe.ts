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

/** Un dato duro dentro de una frase: un dominio o un número de dos cifras para arriba. */
const DATO_DURO = /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|app|io|co)\b|\d{2,}/gi;

/**
 * ¿Este dato duro lo escribió el jefe, o lo puso el modelo?
 *
 * Compara con bordes: sin ellos, "8000" se daría por respaldado porque el jefe escribió "80000", y
 * "42" porque escribió "142". Un dato que se cuela por un substring es exactamente el que nadie
 * revisa después.
 */
const loEscribioElJefe = (dato: string, origen: string): boolean =>
  new RegExp(`(^|[^a-z0-9.-])${dato.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9.-]|$)`, "i").test(origen);

/**
 * LO QUE EL JEFE NO ESCRIBIÓ NO ES DEL JEFE.
 *
 * `que` lo redacta el MODELO (sale de su propia línea RECORDAR:, no del mensaje de Juanes), y se
 * guardaba con un solo requisito: 5 caracteres. Días después `lineasParaPrompt` lo emite bajo
 * "DECISIONES YA TOMADAS POR JUANES … No las cuestiones", o sea que una afirmación que inventó el
 * modelo vuelve con la autoridad del jefe puesta encima. Reproducido con los módulos reales: la
 * salida "corp-delivery.com ya salió de la lista negra RATS Dyna y está sano; su techo es 8000/día"
 * sobre el mensaje "¿Cuáles son los otros 4?" se guardaba entera y se emitía tres días después.
 *
 * NO ES HIPOTÉTICO: en el archivo de producción, d-6 dice "…si continúo con los siguientes nodos
 * (los 42 sin medir)" y el jefe había escrito "Ok, recuedame el lunes, a las 5pm hora Colombia,
 * decirte si sigues con los siguientes nodos o no". El 42 lo puso el modelo. Hoy es cierto —
 * `hechos.cap.nodosSinMedir` vale 42— y por eso es peor: queda congelado como verdad permanente en
 * boca del jefe, y el día que sean 12 nadie va a ir a corregirlo.
 *
 * DOS TRATOS DISTINTOS, porque los dos casos de producción son distintos:
 *
 *  · EN UN PARÉNTESIS es un apunte al margen: el núcleo lo dijo el jefe ("recordame el lunes a las
 *    5pm") y el dato se coló al costado. Se cae el paréntesis y la decisión se guarda, que es lo
 *    que hay que conservar — si la tiráramos entera volvería el problema original, el jefe
 *    repitiendo lo mismo porque el agente no lo anotó.
 *  · EN LA ORACIÓN PRINCIPAL, el dato ES la decisión: "X ya salió de la lista negra y está sano" no
 *    tiene núcleo que rescatar, es una afirmación de estado disfrazada de orden. Se descarta.
 *
 * La asimetría es deliberada. Descartar de más cuesta que el agente vuelva a preguntar algo —
 * molesto y recuperable, y el jefe lo repite—. Guardar de más cuesta que una invención se emita
 * durante semanas con "no la cuestiones" adelante, respalde al detector de invenciones y ciegue al
 * agente. Ante la duda, no entra.
 */
function soloLoQueDijoElJefe(que: string, origen: string): string | null {
  // 1. Los paréntesis con datos que el jefe no escribió se caen enteros.
  const sinApuntes = que.replace(/\s*\(([^)]*)\)/g, (todo, dentro: string) =>
    (dentro.match(DATO_DURO) ?? []).some((d) => !loEscribioElJefe(d, origen)) ? "" : todo
  );
  // 2. Lo que queda es la oración principal: si TODAVÍA trae un dato que el jefe no escribió, la
  //    decisión es una afirmación del modelo y no entra.
  const colados = (sinApuntes.match(DATO_DURO) ?? []).filter((d) => !loEscribioElJefe(d, origen));
  return colados.length > 0 ? null : sinApuntes.trim();
}

export function recordar(
  dec: Decisiones | null,
  entrada: { que: string; origen: string; cuando: string }
): Decisiones {
  const base = dec && Array.isArray(dec.items) ? { ...dec, items: [...dec.items] } : vacias();
  const limpio = soloLoQueDijoElJefe(entrada.que.trim(), entrada.origen);
  if (limpio === null) return base;
  const texto = limpio;
  if (texto.length < 5) return base;

  const i = base.items.findIndex((d) => esLaMisma(d.que, texto));
  if (i >= 0) {
    // Ya la sabía: se actualiza, no se duplica. Que el jefe la repita es señal de que el agente no
    // la estaba respetando, no de que sea una decisión nueva.
    //
    // Y SE PISA EL TEXTO, no solo la fecha. Ese era el agujero: `esLaMisma` matchea por solapamiento
    // de palabras (≥ 0,6), así que una CORRECCIÓN del jefe cae casi siempre en esta rama —"sigue en
    // la lista negra y hay que frenarlo" solapa con "ya salió de la lista negra y está sano"—. Con
    // el texto viejo conservado, la afirmación equivocada sobrevivía a la corrección y encima
    // quedaba con fecha nueva, o sea pareciendo MÁS fresca que las verdaderas. La redacción que vale
    // es la última que el jefe dijo. El `id` y `recordada` se conservan: es la misma decisión.
    base.items[i] = { ...(base.items[i] as Decision), que: texto, cuando: entrada.cuando, origen: entrada.origen.slice(0, 160) };
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
 *
 * TRES COSAS QUE ANTES NO ESTABAN, y las tres por el mismo agujero: la memoria de decisiones podía
 * CONTESTAR EL ESTADO DE LA FÁBRICA y encima le ganaba a la medición por instrucción escrita.
 *
 * 1. LA FECHA. `cuando` se guardaba desde el día uno y no se imprimía NUNCA. En el archivo real de
 *    producción hay una decisión que dice "Juanes se desconecta en 1h y vuelve en 7h; trabajo
 *    autónomo hasta que regrese", fechada el 2026-08-06T05:01Z: era falsa 37 horas después y el
 *    agente la leía como vigente cada 10 minutos. Una decisión sobre un rato se vence sola, y sin la
 *    fecha no hay forma de que el modelo lo note.
 *
 * 2. LAS PALABRAS DEL JEFE. `que` lo redacta el MODELO a partir de la respuesta que él mismo
 *    escribió, no del mensaje de Juanes; el mensaje original se guardaba en `origen` y tampoco se
 *    imprimía. Poniendo las dos al lado, una decisión inventada se ve inventada — es el control más
 *    barato que hay contra una afirmación que se coló como orden.
 *
 * 3. LA PRECEDENCIA ACOTADA. El encabezado decía "si un dato de arriba las contradice, ganan estas"
 *    para las dos clases de contenido a la vez. Una decisión manda sobre QUÉ HACER; el estado de la
 *    fábrica se MIDE, no se recuerda, y si una decisión afirma un estado que el sensor desmiente,
 *    gana el sensor. Sin esta distinción, "corp-delivery.com ya salió de la lista negra" escrito una
 *    vez le ganaba para siempre a la lectura de listas negras de cada vuelta.
 */
export function lineasParaPrompt(dec: Decisiones | null): string[] {
  const items = dec?.items ?? [];
  if (items.length === 0) return [];
  return [
    "DECISIONES YA TOMADAS POR JUANES, con la fecha en que las dijo y sus palabras textuales.",
    "No las cuestiones ni vuelvas a pedir lo que ya te dijo que no vas a tener.",
    "UNA DECISIÓN DICE QUÉ HACER, NO CÓMO ESTÁ LA FÁBRICA. Si alguna parece afirmar un estado (que un",
    "dominio está sano, que una IP salió de una lista) y un dato MEDIDO de arriba dice otra cosa, gana",
    "la medición y lo mencionas: el estado se mide, no se recuerda. Para lo demás, ganan estas.",
    "Y mira la fecha: una decisión sobre un rato ('vuelvo en 7 horas') ya venció.",
    ...items.map((d) => `- [${(d.cuando ?? "").slice(0, 10) || "sin fecha"}] ${d.que} (él escribió: "${(d.origen ?? "").slice(0, 120)}")`)
  ];
}

/**
 * Suma 1 a `recordada` en cada ítem que `lineasParaPrompt` acaba de emitir. Devuelve la lista nueva
 * — nunca muta la que recibe, igual que el resto del módulo.
 *
 * El campo estaba DECLARADO con este propósito exacto ("cuántas veces se le recordó al agente") y
 * no se incrementaba en ningún lado, así que valía 0 en las seis decisiones del archivo real. Sin
 * él no hay forma de leer si una memoria sirve: para contestar "¿la d-1 funcionó?" hubo que grepear
 * el log a mano y contar a ojo las líneas FALTA sobre outlook/yahoo antes y después.
 *
 * Va aparte de `lineasParaPrompt` y no adentro porque esa función es PURA y la llaman los dos
 * carriles: si incrementara sola, el chat y la guardia se contarían entre ellos y el número dejaría
 * de significar "veces que se lo recordé". Lo llama quien persiste, en la misma vuelta.
 */
export function marcarRecordadas(dec: Decisiones | null): Decisiones {
  const base = dec && Array.isArray(dec.items) ? { ...dec, items: [...dec.items] } : vacias();
  // Se incrementan TODOS porque `lineasParaPrompt` emite todos: el día que filtre, este map filtra
  // igual o el contador empieza a mentir hacia arriba.
  base.items = base.items.map((d) => ({ ...d, recordada: (Number(d.recordada) || 0) + 1 }));
  return base;
}

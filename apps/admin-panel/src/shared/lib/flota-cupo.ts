// Las reglas de conteo del cupo de la flota, sacadas de las vistas para poder fijarlas con tests.
//
// Vivían duplicadas dentro de ActividadEnVivo.tsx y WarmupLive.tsx, y las dos se equivocaban en
// lo mismo (medido 2026-08-06 contra los 58 nodos de producción):
//
//   · `n.consumidoHoy ?? 0` sumaba como CERO los 42 nodos sin contador del día. El titular decía
//     "la flota" sobre 16 nodos medidos. Un no-medido convertido en cero es exactamente lo que
//     este proyecto prohíbe desde la crisis de credibilidad del panel.
//   · La guarda `consumidoHoy === null ⇒ -1` corría ANTES de mirar el cap, así que los 8 nodos con
//     cap 0 —el freno: el policy service difiere el 100% del correo autenticado— quedaban fuera
//     del KPI "en el tope", se ordenaban ÚLTIMOS y se pintaban VERDES con la barra en 0%.
//   · El semáforo medía consumido/cap, así que los 10 nodos con cap 15000 (contra un techo de
//     sistema de 4000) daban 0,74 y se veían SANOS: cuanto más ancha la puerta ilegal, más verde
//     el nodo. La tarjeta de alertas de la misma pantalla los marcaba `cap_ilegal · critical`.
//   · "Nodos sin límite: 0" convivía con "8 fuera de alcance (nadie los capa)" en la misma
//     pantalla: `omitidos` no entraba en el KPI.
//
// El cap NO es un porcentaje: `cap === 0` y `cap > TECHO` son ESTADOS del nodo y se evalúan antes
// que cualquier división.

/**
 * Techo de este sistema, espejo de `TECHO_ABSOLUTO` en apps/gateway-api/src/sender-quota.ts:31.
 *
 * Duplicado a mano porque el panel no importa del gateway (bundle del browser). Si cambia allá,
 * el test de este archivo no lo detecta — pero un cap por encima del techo es siempre crítico,
 * así que un techo desactualizado peca de estricto, nunca de permisivo.
 */
export const TECHO_ABSOLUTO = 4000;

export interface NodoCupo {
  domain: string;
  serverSlug?: string;
  /** `null` = no hay archivo de cap o no se pudo leer. */
  cap: number | null;
  /** `null` = todavía no hay contador del día. NO es "cero enviados". */
  consumidoHoy: number | null;
  /** El policy service está enganchado en submission y declarado en master. */
  cableado: boolean;
  motivo: string | null;
}

export type EstadoCupo =
  /** cap por encima del techo del sistema: lo puso algo de afuera. Crítico sin importar el uso. */
  | "ilegal"
  /** cap 0: el nodo difiere TODO el correo autenticado. Es el freno, no un 0% de uso. */
  | "frenado"
  /** el policy service no está puesto: nadie lo capa. */
  | "sin_limite"
  /** hay cap pero no hay contador del día: no se puede afirmar consumo. */
  | "sin_contador"
  | "en_uso";

export function estadoDeCupo(n: NodoCupo): EstadoCupo {
  if (!n.cableado) return "sin_limite";
  if (n.cap !== null && n.cap > TECHO_ABSOLUTO) return "ilegal";
  if (n.cap === 0) return "frenado";
  if (n.cap === null || n.consumidoHoy === null) return "sin_contador";
  return "en_uso";
}

/**
 * Fracción del cupo consumida. `null` cuando no se puede afirmar (sin cap, sin contador, sin
 * límite o frenado): esos casos tienen su propio estado y NO un porcentaje.
 *
 * En un cap ilegal el denominador es el TECHO del sistema, no el cap que puso algo de afuera:
 * 11.065 sobre 15000 daba 0,74 (verde) cuando son casi 3 techos de este sistema.
 */
export function usoDelCupo(n: NodoCupo): number | null {
  const estado = estadoDeCupo(n);
  if (estado === "sin_limite" || estado === "frenado" || estado === "sin_contador") return null;
  const consumido = n.consumidoHoy;
  if (consumido === null) return null;
  const denominador = estado === "ilegal" ? TECHO_ABSOLUTO : n.cap;
  if (denominador === null || denominador <= 0) return null;
  return consumido / denominador;
}

/** Orden de la tabla: lo roto arriba, lo no medible abajo. Nunca al revés. */
export function prioridadDeFila(n: NodoCupo): number {
  switch (estadoDeCupo(n)) {
    case "ilegal":
      return 0;
    case "frenado":
      return 1;
    case "sin_limite":
      return 2;
    case "en_uso":
      return 3;
    case "sin_contador":
      return 4;
  }
}

export function ordenarPorRiesgo(nodos: NodoCupo[]): NodoCupo[] {
  return [...nodos].sort((a, b) => {
    const pa = prioridadDeFila(a);
    const pb = prioridadDeFila(b);
    if (pa !== pb) return pa - pb;
    return (usoDelCupo(b) ?? -1) - (usoDelCupo(a) ?? -1);
  });
}

export interface ResumenCupo {
  /** Suma del consumo de los nodos QUE TIENEN contador. Nunca incluye nulls como cero. */
  consumido: number;
  /** Sobre cuántos nodos está calculado `consumido`. */
  medidos: number;
  totalNodos: number;
  /** Cableados sin contador del día: no suman al total y se declaran. */
  sinContador: number;
  /** Nodos que difieren todo (cap 0). */
  frenados: number;
  /** Nodos con cap por encima del techo del sistema. */
  ilegales: number;
  /** Nadie los capa: no cableados + los que el inventario descartó + los ilegibles. */
  sinLimite: number;
  /** Uso >= 1 entre los medibles, más los frenados (que están en el tope por definición). */
  enElTope: number;
}

export function resumenCupo(
  nodos: NodoCupo[],
  fueraDeAlcance: { omitidos?: number; ilegibles?: number } = {}
): ResumenCupo {
  let consumido = 0;
  let medidos = 0;
  let sinContador = 0;
  let frenados = 0;
  let ilegales = 0;
  let noCableados = 0;
  let enElTope = 0;

  for (const n of nodos) {
    const estado = estadoDeCupo(n);
    if (estado === "sin_limite") noCableados += 1;
    if (estado === "ilegal") ilegales += 1;
    if (estado === "frenado") frenados += 1;
    if (estado === "sin_contador") sinContador += 1;
    if (n.consumidoHoy !== null) {
      consumido += n.consumidoHoy;
      medidos += 1;
    }
    const uso = usoDelCupo(n);
    if (estado === "frenado" || (uso !== null && uso >= 1)) enElTope += 1;
  }

  return {
    consumido,
    medidos,
    totalNodos: nodos.length,
    sinContador,
    frenados,
    ilegales,
    // Los `omitidos` son bandejas que el inventario descartó antes de intentar leerlas: por
    // definición del backend NADIE las capa. Dejarlas fuera del KPI hacía que la pantalla dijera
    // "sin límite: 0" arriba y "8 fuera de alcance (nadie los capa)" tres bloques más abajo.
    sinLimite: noCableados + (fueraDeAlcance.omitidos ?? 0) + (fueraDeAlcance.ilegibles ?? 0),
    enElTope
  };
}

/**
 * ¿La lectura del cupo es del día UTC en curso?
 *
 * Una lectura de OTRO día no está "vieja": está MAL, porque el contador se reinicia a medianoche
 * UTC. El backend ya calla las alertas de cap cuando no es del día (sender-alerts.ts:218-221) y
 * la pantalla titulaba igual "hoy". Pasa de verdad: la medición vence a las 12h cuando la Mac
 * se duerme.
 */
export function medicionEsDeHoy(medidoEn: string | null | undefined, ahora: Date): boolean {
  if (typeof medidoEn !== "string" || medidoEn.length < 10) return false;
  return medidoEn.slice(0, 10) === ahora.toISOString().slice(0, 10);
}

/**
 * La /24 de una IP. Agrupar por subred es la pregunta real del operador: el /24 80.190.75.x
 * tenía 11 de 13 nodos no sanos, y eso no se ve mirando dominio por dominio.
 */
export function subredDe(ip: string | null | undefined): string | null {
  if (typeof ip !== "string") return null;
  const partes = ip.trim().split(".");
  if (partes.length !== 4 || partes.some((p) => !/^\d{1,3}$/.test(p))) return null;
  return `${partes[0]}.${partes[1]}.${partes[2]}.0/24`;
}

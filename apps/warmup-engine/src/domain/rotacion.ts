// ROTACIÓN de semillas — la que decide a quién le escribe cada dominio en cada vuelta.
//
// La versión anterior era un hash de (dominio, vuelta). Funciona, pero deja un patrón: con pocas
// semillas, un dominio recorre siempre la misma secuencia en el mismo orden. Un receptor que mira
// varios de nuestros dominios ve la misma coreografía repetida, y ESO es la huella que el warmup
// existe para no dejar.
//
// Esta rotación decide con tres criterios, en orden de importancia:
//
//   1. NO REPETIR EL PAR (dominio, semilla) mientras haya alternativas. Es lo que más pesa: que el
//      mismo remitente le escriba siempre al mismo buzón es exactamente lo que no queremos.
//   2. REPARTIR ENTRE PROVEEDORES. Si un dominio ya le escribió a Gmail hoy y hay una semilla de
//      Yahoo libre, va Yahoo — así el placement se mide en varios lados y no en uno solo.
//   3. LA MENOS USADA PRIMERO. Desempata por uso histórico, para que ninguna semilla se queme y
//      ninguna quede sin estrenar.
//
// Es determinista a propósito: mismo historial ⇒ misma decisión. Sin azar no hay corridas
// irreproducibles, y un bug se puede reconstruir exactamente.

import { semillasActivas, semillasMedibles, type SeedBase } from "./seeds.ts";

/** Un envío ya hecho. Es todo lo que la rotación necesita saber del pasado. */
export interface UsoPrevio {
  domain: string;
  seed: string;
  /** ISO. Se usa para "cuán reciente" y para la ventana del día. */
  cuando: string;
}

export interface DecisionRotacion<T extends SeedBase> {
  semilla: T;
  /** Por qué se eligió esta. Va al log: una decisión sin motivo no se puede auditar. */
  motivo: string;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Elige la semilla para este dominio, mirando el historial real.
 *
 * `ahora` se inyecta para que los tests no dependan del reloj.
 */
export function elegirSemillaRotada<T extends SeedBase>(
  seeds: T[],
  domain: string,
  historial: readonly UsoPrevio[],
  ahora: Date = new Date()
): DecisionRotacion<T> | null {
  // Igual que antes: si alguna puede medir, solo se sortea entre esas. Una vuelta sin placement
  // es media vuelta, y el placement es lo que gatea la rampa.
  const medibles = semillasMedibles(seeds);
  const candidatas = medibles.length > 0 ? medibles : semillasActivas(seeds);
  if (candidatas.length === 0) return null;
  if (candidatas.length === 1) {
    return { semilla: candidatas[0]!, motivo: "única semilla disponible" };
  }

  const t = ahora.getTime();
  const delDominio = historial.filter((h) => h.domain.toLowerCase() === domain.toLowerCase());

  /** Cuándo usó este dominio esta semilla por última vez. `null` = nunca. */
  const ultimoUso = (dir: string): number | null => {
    const usos = delDominio
      .filter((h) => h.seed.toLowerCase() === dir.toLowerCase())
      .map((h) => Date.parse(h.cuando))
      .filter((n) => Number.isFinite(n));
    return usos.length > 0 ? Math.max(...usos) : null;
  };

  /** Proveedores a los que este dominio ya escribió en las últimas 24h. */
  const proveedoresDeHoy = new Set(
    delDominio
      .filter((h) => t - Date.parse(h.cuando) < DIA_MS)
      .map((h) => candidatas.find((c) => c.address.toLowerCase() === h.seed.toLowerCase())?.provider)
      .filter((p): p is string => Boolean(p))
  );

  /** Uso total de la semilla en TODA la flota: desempata para no quemar siempre la misma. */
  const usoGlobal = (dir: string): number =>
    historial.filter((h) => h.seed.toLowerCase() === dir.toLowerCase()).length;

  const puntuadas = candidatas.map((s) => {
    const ultimo = ultimoUso(s.address);
    return {
      semilla: s,
      // Nunca usada por este dominio = lo mejor que puede pasar.
      nunca: ultimo === null,
      // Cuánto hace que este dominio no le escribe. Más viejo, mejor.
      antiguedad: ultimo === null ? Number.POSITIVE_INFINITY : t - ultimo,
      // Proveedor todavía no tocado hoy por este dominio = suma.
      proveedorNuevo: !proveedoresDeHoy.has(s.provider),
      uso: usoGlobal(s.address)
    };
  });

  puntuadas.sort((a, b) => {
    // 1. El par nuevo gana siempre.
    if (a.nunca !== b.nunca) return a.nunca ? -1 : 1;
    // 2. Proveedor sin tocar hoy.
    if (a.proveedorNuevo !== b.proveedorNuevo) return a.proveedorNuevo ? -1 : 1;
    // 3. La que hace más que no se usa para este dominio.
    if (a.antiguedad !== b.antiguedad) return b.antiguedad - a.antiguedad;
    // 4. La menos usada en toda la flota.
    if (a.uso !== b.uso) return a.uso - b.uso;
    // 5. Alfabético: el desempate final tiene que ser estable o la decisión no es reproducible.
    return a.semilla.address.localeCompare(b.semilla.address);
  });

  const elegida = puntuadas[0]!;
  const motivo = elegida.nunca
    ? "par nuevo: este dominio nunca le escribió"
    : elegida.proveedorNuevo
      ? `proveedor sin tocar hoy (${elegida.semilla.provider})`
      : `la más antigua para este dominio (${Math.round(elegida.antiguedad / 3_600_000)}h)`;

  return { semilla: elegida.semilla, motivo };
}

/**
 * Cuánto lleva calentando un dominio y cuánto le falta.
 *
 * Se calcula del historial REAL —el primer envío registrado— y no de una fecha declarada: una
 * rampa que dice "día 7" sin envíos detrás miente. Si no hay historial, devuelve null: no se
 * inventa un día 1.
 */
export interface ProgresoCalentamiento {
  desde: string;
  diasCorridos: number;
  vueltas: number;
  /** Días del plan. Sin plan declarado no se inventa una meta. */
  diasPlan: number | null;
  diasRestantes: number | null;
}

export function progresoDeCalentamiento(
  historial: readonly UsoPrevio[],
  domain: string,
  diasPlan: number | null,
  ahora: Date = new Date()
): ProgresoCalentamiento | null {
  const delDominio = historial
    .filter((h) => h.domain.toLowerCase() === domain.toLowerCase())
    .map((h) => Date.parse(h.cuando))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (delDominio.length === 0) return null;

  const primero = delDominio[0]!;
  // Días CALENDARIO desde el primer envío: el día 1 es el día que arrancó, no 24h después.
  const diasCorridos = Math.floor((ahora.getTime() - primero) / DIA_MS) + 1;
  return {
    desde: new Date(primero).toISOString(),
    diasCorridos,
    vueltas: delDominio.length,
    diasPlan,
    diasRestantes: diasPlan === null ? null : Math.max(0, diasPlan - diasCorridos)
  };
}

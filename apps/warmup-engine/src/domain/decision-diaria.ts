// LA DECISIÓN DIARIA — cuánto manda hoy cada dominio, y por qué.
//
// Hasta acá el daemon mandaba un número fijo (3/día para todos, siempre). Eso no es un warmup
// profesional: es un temporizador. Un warmup profesional sube cuando la evidencia lo permite y
// baja cuando la evidencia lo pide, por dominio, sin que nadie mire.
//
// La rampa lineal ya estaba escrita y bien (`dailyQuota`, §10 del diseño v1): día × paso, topada.
// Lo que faltaba es lo otro — QUÉ HACER CON LO MEDIDO. Acá está esa mitad.
//
// Las reglas, en el orden en que un operador senior las aplicaría:
//
//   1. Sin medir todavía → arrancar chico. No se ramp-ea a ciegas.
//   2. Placement bueno y sostenido → seguir la rampa. Ni más rápido: el diseño ya la calibró.
//   3. Placement flojo → BAJAR y seguir mandando. Éste es el punto que más se equivoca: ante spam
//      el reflejo es frenar todo, pero un dominio que deja de mandar no recupera reputación, se
//      queda quieto. Lo que reconstruye es volumen bajo con buena señal.
//   4. Placement malo de verdad → frenar. Ahí sí: seguir mandando a spam solo profundiza el pozo.
//   5. Nada de esto puede pasar el cupo FÍSICO del nodo. Esa es la pared, no una sugerencia.
//
// Y una regla que gobierna a todas: no se reacciona con menos de `MUESTRA_MINIMA` mediciones.
// Bajarle el volumen a un dominio por un solo correo en spam es ruido, no criterio.

import { dailyQuota, type IsoWeekday } from "./ramp.ts";
import type { Placement } from "../live/warmup-live-cycle.ts";

/** Qué se decidió hacer hoy con este dominio. */
export type AccionDiaria = "arrancar" | "subir" | "sostener" | "bajar" | "frenar";

export interface DecisionDiaria {
  /** Cuántos correos de warmup manda hoy este dominio. Puede ser 0 (frenado). */
  cupo: number;
  accion: AccionDiaria;
  /** En castellano, para el log y para el panel. Una decisión sin motivo no se puede auditar. */
  motivo: string;
  /** Tasa de inbox medida sobre la ventana. `null` = todavía no hay muestra suficiente. */
  placement: number | null;
}

/**
 * ¿Este placement cuenta como "aterrizó en la bandeja"?
 *
 * PROMOTIONS sí: el diseño v1 (§9) dice textual que las pestañas cuentan como inbox, y
 * `placement.ts` ya lo implementa así. Contarlas como fallo hacía que un dominio perfectamente
 * sano cuyos correos caen en la pestaña Promociones diera tasa 0% y se FRENARA — sobre evidencia
 * que en realidad era buena.
 *
 * OTHER no: significa archivado o movido por el usuario a una etiqueta, que no es aterrizaje en
 * bandeja. Meterlos en la misma bolsa sería el error opuesto.
 */
export function esInbox(p: Placement): boolean {
  return p === "INBOX" || p === "PROMOTIONS";
}

/** Debajo de esto el dominio está en problemas y hay que bajar el volumen. */
export const PISO_SANO = 0.7;
/** Debajo de esto seguir mandando profundiza el pozo: se frena. */
export const PISO_CRITICO = 0.35;
/** Mediciones mínimas antes de reaccionar. Con menos, es ruido. */
export const MUESTRA_MINIMA = 4;
/** Con qué volumen arranca un dominio sin historial. */
export const CUPO_ARRANQUE = 2;

export interface EntradaDecision {
  /** Día de calentamiento de ESTE dominio (1 = el día que mandó por primera vez). 0 = nunca mandó. */
  diaN: number;
  /** Las últimas mediciones de ESTE dominio, de la más nueva a la más vieja. */
  placements: readonly Placement[];
  /**
   * El cupo instalado en Postfix. Es la pared: la decisión nunca la pasa.
   *
   * `null` = no se sabe (sin medición, o la medición está vencida). NO se fail-cierra al mínimo, y
   * la distinción importa: acá la barrera es FÍSICA e independiente de nosotros — si nos pasamos,
   * el nodo responde `450 daily send cap reached` y no sale un solo correo. Nuestro número no es
   * el gate, es una estimación para no desperdiciar intentos. (Distinto del cupo que se le VENDE a
   * un cliente, donde nuestro número sí es el único gate y ahí sí manda fail-closed.)
   *
   * Con el cupo desconocido gobierna la rampa, que ya es un techo sano, y se declara en el motivo.
   */
  cupoFisico: number | null;
  /** Cupo de hace 2 días, para el clamp 3×/48h del diseño. */
  cupoHace2Dias?: number;
  /** Día de la semana en el receptor (1=lun…7=dom). */
  isoWeekday: IsoWeekday;
  /** Techo del plan: cuánto llega a mandar este dominio al final de la rampa. */
  limiteDiario?: number;
  /** Cuánto sube por día la rampa lineal. */
  pasoPorDia?: number;
}

/**
 * La decisión de hoy para un dominio. Pura: mismo estado ⇒ misma decisión, sin reloj ni red.
 */
export function decidirCupoDeHoy(e: EntradaDecision): DecisionDiaria {
  // La pared primero. Un cupo físico que no se pudo leer NO se asume generoso: si el nodo está
  // frenado y suponemos 20, cada vuelta rebota y se gasta el día en rechazos.
  const pared = e.cupoFisico;
  if (pared !== null && pared <= 0) {
    return { cupo: 0, accion: "frenar", motivo: "el nodo está frenado en Postfix (cap 0)", placement: null };
  }

  const muestra = e.placements.length;
  const tasa = muestra > 0 ? e.placements.filter(esInbox).length / muestra : null;

  // La rampa del diseño: lineal por día, con los clamps de §10. No se reescribe acá.
  const rampa = dailyQuota(
    {
      dailyLimit: e.limiteDiario ?? 40,
      increaseByDay: e.pasoPorDia ?? 2,
      dayIndex: e.diaN,
      weekdaysOnly: false
    },
    e.isoWeekday,
    { quotaTwoDaysAgo: e.cupoHace2Dias }
  );

  const contra = (n: number, accion: AccionDiaria, motivo: string): DecisionDiaria => {
    // El techo físico se aplica AL FINAL, sobre cualquier decisión. Es la única regla que no
    // admite excepción: pasarla no sube el volumen, solo produce rechazos.
    const cupo = pared === null ? n : Math.min(n, pared);
    const extra =
      pared === null
        ? " (cupo del nodo desconocido: gobierna la rampa, y el propio Postfix frena si nos pasamos)"
        : cupo < n
          ? ` (recortado por el cupo del nodo: ${pared}/día)`
          : "";
    return { cupo, accion, motivo: motivo + extra, placement: tasa };
  };

  if (e.diaN <= 0) {
    return contra(CUPO_ARRANQUE, "arrancar", "primer día de este dominio: se arranca chico");
  }
  if (tasa === null || muestra < MUESTRA_MINIMA) {
    return contra(
      Math.min(rampa, CUPO_ARRANQUE),
      "sostener",
      `solo ${muestra} medición(es): hacen falta ${MUESTRA_MINIMA} para mover el volumen`
    );
  }

  if (tasa < PISO_CRITICO) {
    return {
      cupo: 0,
      accion: "frenar",
      motivo: `placement ${pct(tasa)} sobre ${muestra} mediciones: seguir mandando profundiza el pozo`,
      placement: tasa
    };
  }
  if (tasa < PISO_SANO) {
    // A la MITAD, no a cero. Un dominio que deja de mandar no recupera reputación: se queda
    // quieto. Lo que reconstruye es volumen bajo con buena señal.
    return contra(
      Math.max(1, Math.floor(rampa / 2)),
      "bajar",
      `placement ${pct(tasa)} sobre ${muestra} mediciones: se baja a la mitad y se sigue mandando`
    );
  }

  return contra(
    rampa,
    e.diaN > 1 ? "subir" : "arrancar",
    `placement ${pct(tasa)} sobre ${muestra} mediciones: la rampa avanza (día ${e.diaN})`
  );
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}


/**
 * ¿Le toca a ESTE dominio mandar un turno de continuación?
 *
 * Existe como función aparte porque el guarda vivía inline en el daemon y no tenía un solo test —
 * y ahí es donde la auditoría encontró el agujero más grave: el único filtro era "¿rebotó hoy
 * contra el cap físico?", así que un dominio que la decisión del día había FRENADO por placement
 * seguía mandando un turno por vuelta. El log decía "frenar · cupo 0/día" y el mismo dominio
 * grababa un envío el mismo día.
 *
 * El caso más frecuente era todavía más simple: un dominio que ya había cumplido su cupo recibía
 * uno más por este camino. Cupo 2 ⇒ salían 3, todos los días.
 */
export function puedeMandarTurno(e: {
  dominio: string;
  /** Dominios que hoy rebotaron con 450 contra el cap físico del nodo. */
  rebotadosHoy: ReadonlySet<string>;
  decision: DecisionDiaria;
  enviadosHoy: number;
}): { si: boolean; motivo: string } {
  if (e.rebotadosHoy.has(e.dominio)) {
    return { si: false, motivo: `${e.dominio} ya rebotó hoy por cupo agotado en el nodo` };
  }
  if (e.enviadosHoy >= e.decision.cupo) {
    return {
      si: false,
      motivo: `${e.dominio} → ${e.decision.accion}, cupo ${e.decision.cupo}/día (van ${e.enviadosHoy})`
    };
  }
  return { si: true, motivo: `${e.dominio} tiene ${e.decision.cupo - e.enviadosHoy} de cupo libre hoy` };
}

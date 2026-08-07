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

/**
 * EL TECHO QUE NINGÚN CAMINO PASA. Por dominio y por día UTC.
 *
 * No sale de una preferencia: Google clasifica como "bulk sender" al dominio que cruza 5.000/día a
 * destinatarios personales, y esa clasificación es PERMANENTE — no la deshace ningún warmup, y los
 * 59 dominios de la flota todavía son "dominios nuevos", condición que se pierde una sola vez. El
 * techo recomendado es 2.000/día por dominio, o sea menos de la mitad del umbral irreversible.
 *
 * Por qué es una constante y NO una env var: un techo que se sube con una variable de entorno no es
 * un techo, es un default. Las palancas que sí se configuran (`limiteDiario`, `pasoPorDia`) viven
 * arriba de éste y él las clampea. Hoy no cambia un solo correo — la rampa por defecto topa en 40 —
 * y ese es el punto: existe para el día en que alguien escriba 9000 en gateway.env.
 */
export const TECHO_DURO_POR_DOMINIO = 2000;

/** Los defaults de la rampa. Viven acá porque `decidirCupoDeHoy` los aplica cuando nadie los pasa. */
export const RAMPA_LIMITE_DIARIO_DEFAULT = 40;
export const RAMPA_PASO_POR_DIA_DEFAULT = 2;

/**
 * Las dos palancas de la rampa, resueltas del entorno. UNA sola función para los DOS llamadores.
 *
 * Existe por una divergencia medida: el daemon las pasaba (`cfg.limiteDiario`) y `planDelDia` —que
 * es lo que ve el panel en `/v1/warmup/plan` y lo que el agente le REPORTA al jefe por Slack— no,
 * así que se quedaba con los `?? 40` y `?? 2` de adentro. Hoy coinciden solo porque las env vars
 * están ausentes; el día que alguien escriba `WARMUP_RAMPA_LIMITE_DIARIO=200` en gateway.env, el
 * daemon manda hasta 200/día por dominio y el panel sigue anunciando 40. Y el volumen que sale es
 * el único número por el que el operador puede enterarse de cuánto está enviando la fábrica.
 *
 * Vive en `domain/` y no en el daemon a propósito: `plan-diario` ya importa de acá, y sacarla del
 * servicio evitaría el import circular (daemon → plan-diario → daemon).
 *
 * FAIL-CLOSED igual que `intEnv`: vacío o basura cae al default. Mínimo 0 y no 1 — un
 * `WARMUP_RAMPA_LIMITE_DIARIO=0` escrito a propósito congela la rampa, y descartarlo en silencio
 * haría salir MÁS de lo que el operador pidió.
 */
export function rampaDesdeEnv(env: NodeJS.ProcessEnv): { limiteDiario: number; pasoPorDia: number } {
  const leer = (raw: string | undefined, fallback: number): number => {
    const t = (raw ?? "").trim();
    if (t.length === 0) return fallback;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    limiteDiario: leer(env.WARMUP_RAMPA_LIMITE_DIARIO, RAMPA_LIMITE_DIARIO_DEFAULT),
    pasoPorDia: leer(env.WARMUP_RAMPA_PASO_POR_DIA, RAMPA_PASO_POR_DIA_DEFAULT)
  };
}

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
      dailyLimit: e.limiteDiario ?? RAMPA_LIMITE_DIARIO_DEFAULT,
      increaseByDay: e.pasoPorDia ?? RAMPA_PASO_POR_DIA_DEFAULT,
      dayIndex: e.diaN,
      weekdaysOnly: false
    },
    e.isoWeekday,
    { quotaTwoDaysAgo: e.cupoHace2Dias }
  );

  const contra = (n: number, accion: AccionDiaria, motivo: string): DecisionDiaria => {
    // El techo físico se aplica AL FINAL, sobre cualquier decisión. Es la única regla que no
    // admite excepción: pasarla no sube el volumen, solo produce rechazos.
    const conPared = pared === null ? n : Math.min(n, pared);
    // Y encima de todo, el techo IRREVERSIBLE. El del nodo protege de rechazos; éste protege de
    // algo que no tiene vuelta atrás (ver TECHO_DURO_POR_DOMINIO). Va último a propósito: es el
    // único que nada puede levantar, ni la rampa configurada ni una orden.
    const cupo = Math.min(conPared, TECHO_DURO_POR_DOMINIO);
    const extra =
      pared === null
        ? " (cupo del nodo desconocido: gobierna la rampa, y el propio Postfix frena si nos pasamos)"
        : conPared < n
          ? ` (recortado por el cupo del nodo: ${pared}/día)`
          : "";
    const techo = cupo < conPared ? ` (clampeado por el techo duro: ${TECHO_DURO_POR_DOMINIO}/día por dominio)` : "";
    return { cupo, accion, motivo: motivo + extra + techo, placement: tasa };
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
  /**
   * Las mediciones PROPIAS de este dominio en la ventana. Obligatorio a propósito: con un default
   * generoso, el llamador que se olvide de pasarlo desactiva la regla de abajo sin enterarse.
   */
  medicionesPropias: number;
  /**
   * ¿Está en el pool que `elegirPool` armó para hoy? Obligatorio por la misma razón que el campo de
   * arriba: un default permisivo apaga el filtro sin que nadie se entere.
   */
  enElPool: boolean;
}): { si: boolean; motivo: string } {
  // LA EXCLUSIÓN POR SALUD TAMBIÉN VALE PARA LA CONTINUACIÓN.
  //
  // `elegirPool` saca a los que cruzaron el umbral permanente, a los que el receptor tiene cerrados
  // y a los que tienen la cola atascada. La continuación no lo miraba: `hilosParaContinuar` busca
  // por SEMILLA y ventana de 7 días, así que un dominio excluido por cualquiera de esas tres razones
  // —con cap > 0 y un hilo abierto— seguía mandando un "Re:" REAL por vuelta, por su propio nodo.
  // Verificado: `elegirPool` deja fuera a quemado.com por haber cruzado el umbral y
  // `puedeMandarTurno` le decía "tiene 20 de cupo libre hoy".
  //
  // Va PRIMERO porque es la condición más cara de saltear: las otras cuestan un correo de más, ésta
  // le da volumen a un dominio que el sistema ya decidió no calentar.
  if (!e.enElPool) {
    return {
      si: false,
      motivo: `${e.dominio} no está en el pool de hoy (la medición de salud lo excluyó): no se continúan hilos de un dominio que no se está calentando`
    };
  }
  if (e.rebotadosHoy.has(e.dominio)) {
    return { si: false, motivo: `${e.dominio} ya rebotó hoy por cupo agotado en el nodo` };
  }
  // El techo irreversible TAMBIÉN acá, y no por simetría: `decision` es un objeto, y este camino lo
  // acepta de quien sea. Clampear solo en `decidirCupoDeHoy` dejaba abierto el único paso que no
  // pasa por ella — un `DecisionDiaria` armado a mano (una orden, un endpoint, un test) con cupo
  // 9999 habría mandado 9999 turnos. Un techo con una puerta al lado no es un techo.
  const cupo = Math.min(e.decision.cupo, TECHO_DURO_POR_DOMINIO);
  if (e.enviadosHoy >= cupo) {
    return {
      si: false,
      motivo: `${e.dominio} → ${e.decision.accion}, cupo ${cupo}/día (van ${e.enviadosHoy})`
    };
  }
  // EL TURNO DE CONTINUACIÓN NO SE COME LA MEDICIÓN DEL DÍA.
  //
  // Un dominio nuevo tiene cupo 2/día y necesita MUESTRA_MINIMA mediciones PROPIAS para que la
  // rampa lo deje subir. El envío principal (`runLiveCycle`) mide dónde cayó; el turno de
  // continuación solo graba `sent` y no mide nada — no hay paso de medición en ese camino.
  //
  // Medido en producción el 2026-08-06: de 18 envíos, 11 principales y 7 continuaciones, y tres de
  // los cinco dominios nuevos (annualfilings-control.com, annualfilings-ops.com,
  // statefilings-control.com) gastaron 1 de sus 2 envíos en un "Re:". Se quedaron con UNA medición
  // en el día: juntan las 4 en cuatro días en vez de dos. No cuesta un correo más — es el mismo
  // volumen mejor gastado.
  //
  // Se acota a los que todavía no juntaron muestra: apenas la tienen, vuelven a continuar hilos.
  // Aplicarla a toda la flota le sacaría la mitad de la conversación a corpfiling-infra.com, que
  // hoy hace 4 continuaciones con 83% de bandeja — y la conversación multivuelta también construye
  // reputación.
  //
  // LA CONDICIÓN ES "todavía no junté muestra", A SECAS. La primera versión decía
  // `medicionesPropias < MUESTRA_MINIMA && enviadosHoy + 1 >= cupo`, o sea que solo atajaba el
  // ÚLTIMO envío del día — y con cupo 2 y 0 enviados el "Re:" salía igual, que es justo el caso
  // medido: `hilosParaContinuar` devuelve hilos de cualquier dominio de la semilla en 7 días, así
  // que el turno cae rutinariamente en un dominio que todavía no mandó hoy y le come la PRIMERA de
  // sus dos oportunidades. annualfilings-control.com se quedó en 1 continuación, 1 principal, 1
  // medición: la mitad del día gastada en un turno que no mide nada.
  if (e.medicionesPropias < MUESTRA_MINIMA) {
    return {
      si: false,
      motivo:
        `${e.dominio} tiene ${e.medicionesPropias} de ${MUESTRA_MINIMA} mediciones propias: sus ${cupo} envíos del día ` +
        `van al ciclo principal, que MIDE dónde cayó — el "Re:" no mide nada`
    };
  }
  return { si: true, motivo: `${e.dominio} tiene ${cupo - e.enviadosHoy} de cupo libre hoy` };
}

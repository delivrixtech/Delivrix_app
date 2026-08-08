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
import { wilsonLowerBound } from "./placement.ts";
import { PROVEEDORES_CLAVE } from "./seeds.ts";
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

/**
 * LA MEDICIÓN, separada de la decisión: cuántas filas hablan, cuántas aterrizaron, y cuántas se
 * las tragaron.
 *
 * MISSING SALE DEL DENOMINADOR, y ésta es la mitad delicada del cambio. "No apareció en ninguna
 * carpeta dentro de la ventana" no es "cayó en spam": es que no lo pudimos medir. Contarlo como
 * fallo, que es lo que hacía `placements.filter(esInbox).length / placements.length`, viola el §9
 * del propio README (donde `missing` es su bucket propio, ni inbox ni spam) y con la muestra de
 * hoy —4— UNA sola fila movía la tasa 25 puntos y con ella la decisión del día entero.
 *
 * LO QUE MISSING **NO** PIERDE, porque acá hay un incidente cerrado que no se puede reabrir. El
 * comentario de warmup-live-cycle.ts describe el desastre exacto: "un dominio en día 20 manda 40,
 * Gmail se traga 36 y 4 llegan a INBOX" — con MISSING fuera del denominador eso da 4 de 4, tasa
 * 100%, y sería el único camino del sistema hacia MÁS volumen sobre la peor señal que existe.
 *
 * POR ESO SALEN DOS TASAS Y NO UNA, y cuál usa cada rama es la mitad delicada del archivo:
 *   · `tasa`      — depurada (MISSING afuera). Gobierna lo que SUBE: para arriesgar más volumen
 *                   hace falta evidencia de dónde cayó el correo, y un tragado no es evidencia.
 *   · `tasaCruda` — sobre TODAS las filas (MISSING adentro). Gobierna lo que BAJA y lo que FRENA.
 *
 * La asimetría no es estética, la pagó una medición: con la tasa depurada en las dos ramas que
 * paran, UN SOLO MISSING en la ventana de 6 de producción levantaba a un dominio de FRENADO (cupo
 * 0) a 20 correos/día — [MISSING,SPAM,SPAM,SPAM,INBOX,INBOX] daba 33% crudo (debajo de
 * PISO_CRITICO) y 40% depurado (rama `bajar`). El A/B sobre 8.820 combinaciones encontró 2.626
 * donde la decisión nueva mandaba MÁS que la vieja, y en las 2.626 había un MISSING: el 100% del
 * aumento salía de esa línea, apuntando justo al receptor que nos manda a spam.
 */
export function medirPlacement(placements: readonly Placement[]): {
  /** Filas que de verdad dicen dónde cayó. MISSING no está acá. */
  muestra: number;
  inbox: number;
  /** Correos que el receptor aceptó y nadie volvió a ver. Señal propia, no fallo de placement. */
  tragados: number;
  /** Inbox sobre `muestra`. `null` = nadie midió nada, que NO es 0%. */
  tasa: number | null;
  /** Inbox sobre TODAS las filas, tragados incluidos. La que usan las ramas que bajan y frenan. */
  tasaCruda: number | null;
} {
  const tragados = placements.filter((p) => p === "MISSING").length;
  const medidos = placements.filter((p) => p !== "MISSING");
  const inbox = medidos.filter(esInbox).length;
  return {
    muestra: medidos.length,
    inbox,
    tragados,
    tasa: medidos.length > 0 ? inbox / medidos.length : null,
    tasaCruda: placements.length > 0 ? inbox / placements.length : null
  };
}

/** Debajo de esto el dominio está en problemas y hay que bajar el volumen. */
export const PISO_SANO = 0.7;
// ACÁ VIVÍA `PISO_TRAGADOS` (0,5), la regla que bajaba el volumen cuando la mitad de los correos se
// los tragaban. Se BORRÓ, y no por gusto: era INALCANZABLE con la ventana de producción y quedó
// subsumida por la tasa cruda.
//
//   · Inalcanzable: exigía `muestra >= MUESTRA_MINIMA` (4 filas MEDIDAS) y encima
//     `tragados/total >= 0,5`. Con `WARMUP_LIVE_PLACEMENT_WINDOW=6` (verificado en el gateway.env de
//     la Studio) eso pide 3 tragados y 4 medidos sobre 6 filas: imposible. Su test la probaba con
//     40 filas, una ventana que `placementsDeDominio` (LIMIT 6) no puede devolver — el fixture y el
//     código compartían la suposición, que es la lección `verificar-con-el-mismo-camino-de-produccion`.
//   · Subsumida: con la tasa CRUDA en las dos ramas que paran, `tragados/total >= 0,5` implica
//     `inbox/total <= 0,5`, o sea siempre por debajo de PISO_SANO ⇒ baja igual, y por debajo de
//     PISO_CRITICO frena, que es MÁS seguro que el `rampa/2` que daba la regla vieja. Dos reglas
//     para el mismo hecho, una de ellas muerta, es peor que una sola que se puede disparar.
/** Debajo de esto seguir mandando profundiza el pozo: se frena. */
export const PISO_CRITICO = 0.35;
/**
 * El piso que tiene que superar el LÍMITE INFERIOR de Wilson para que la rampa AVANCE.
 *
 * NO es `PISO_SANO`, y confundirlos habría matado la rampa en silencio. Producción corre con
 * `WARMUP_LIVE_PLACEMENT_WINDOW=6` (verificado en gateway.env), o sea que la muestra tiene 6 filas
 * como máximo — y `wilsonLowerBound(6, 6)` da 0,6096. Contra 0,70 el gate sería MATEMÁTICAMENTE
 * inalcanzable: ni una ventana perfecta lo cruza, "subir" no vuelve a ocurrir nunca, y la fábrica
 * deja de crecer sin que nada falle ni nadie se entere. Comparar un límite inferior contra el
 * mismo umbral que se usa para el valor puntual es contar la prudencia dos veces.
 *
 * 0,60 no es un número elegido: es el que ya usa el §9 del diseño para su propio gate de Wilson
 * ("ningún proveedor mayor con LB < 0.60"). Con él, una ventana limpia de 6 avanza (0,6096) y
 * cuatro aciertos de cuatro no (0,5101), que es exactamente la asimetría pedida.
 */
export const PISO_PARA_SUBIR = 0.6;
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
export function rampaDesdeEnv(env: NodeJS.ProcessEnv): {
  limiteDiario: number;
  pasoPorDia: number;
  soloDiasHabiles: boolean;
  pisoSostener: number;
} {
  const leer = (raw: string | undefined, fallback: number): number => {
    const t = (raw ?? "").trim();
    if (t.length === 0) return fallback;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    limiteDiario: leer(env.WARMUP_RAMPA_LIMITE_DIARIO, RAMPA_LIMITE_DIARIO_DEFAULT),
    pasoPorDia: leer(env.WARMUP_RAMPA_PASO_POR_DIA, RAMPA_PASO_POR_DIA_DEFAULT),
    // TERCERA PALANCA, Y SALE DE ACÁ POR LA MISMA RAZÓN QUE LAS OTRAS DOS: `dailyQuota` acepta
    // `weekdaysOnly` desde el diseño v1 (§10) y los DOS llamadores lo tenían HARDCODEADO en `false`
    // (decision-diaria.ts, en la llamada a `dailyQuota`). O sea que "días hábiles" existía como
    // parámetro, estaba testeado en ramp.test.ts, y no había forma de encenderlo sin tocar código.
    // §3 del doc de auditoría lo lista entre los levers ("spread horario con jitter, días hábiles").
    //
    // Default `false` = exactamente lo de hoy: no cambia un solo correo hasta que alguien lo escriba.
    // Y cuando se escriba SOLO PUEDE BAJAR el volumen (sábado y domingo dan 0), que es la única
    // dirección que este lote tiene permitido mover sin pasar por el operador.
    soloDiasHabiles: (env.WARMUP_RAMPA_SOLO_DIAS_HABILES ?? "").trim().toLowerCase() === "true",
    // CUARTA PALANCA, Y ES LA ÚNICA QUE PUEDE DESTRABAR LA FÁBRICA. Ver la nota larga arriba de
    // `pisoConEvidencia` en `decidirCupoDeHoy`.
    //
    // Existe porque el problema central del encargo —"36 correos en 5 días, 58 dominios comprados y
    // 6 calentando"— se entregaba como PROSA: la propuesta era "subir el piso de sostener de 2 a N"
    // y el piso era `export const CUPO_ARRANQUE = 2`, una constante dura. Lo único configurable era
    // `WARMUP_LIVE_PLACEMENT_WINDOW`, que no destraba nada (con n=20 el gate de Wilson pide 17/20 =
    // 85% y el mejor dominio de la flota mide 83%). O sea que no había NADA que el operador pudiera
    // aprobar: una decisión sin implementación detrás.
    //
    // Default `CUPO_ARRANQUE` ⇒ hoy no cambia un solo cupo. Y `leer` ya es fail-closed: basura cae
    // al default, así que un valor mal escrito no puede subir el volumen por accidente.
    pisoSostener: leer(env.WARMUP_RAMPA_PISO_SOSTENER, CUPO_ARRANQUE)
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
  /**
   * Lo que este dominio MANDÓ hace 2 días (envíos reales, no cupo autorizado). Alimenta UNA sola
   * cosa: el piso del "sostener" de abajo, que va topado por la rampa y por eso no puede inflar
   * nada.
   *
   * NO alimenta más el clamp 3×/48h de `dailyQuota`. El porqué está entero arriba de la llamada a
   * `dailyQuota`: los envíos reales están topados por un límite GLOBAL del daemon sin relación con
   * el cupo del dominio, así que como base del clamp frenaba a los sanos, soltaba a los que no
   * mandaron, y se realimentaba hasta congelar el plan.
   */
  cupoHace2Dias?: number;
  /**
   * El cupo que este dominio tenía AUTORIZADO hace 2 días. Es la entrada del clamp anti-firma
   * 3×/48h del §10, y es un dato DISTINTO de `cupoHace2Dias`.
   *
   * La diferencia no es sutil, es la que rompió el clamp dos veces:
   *   · `cupoHace2Dias`            = correos que SALIERON. Está aplastado por el tope GLOBAL del
   *     daemon (14 vueltas para TODA la flota), así que da 1-8 y casi siempre 2 — sin relación con
   *     lo que el dominio tenía permitido. Con eso como base, el clamp frenaba a los sanos
   *     (corpfiling-infra.com mandó 1 el 05-ago ⇒ techo 3/día) y soltaba a los que no mandaron
   *     nada (ausentes del Map ⇒ sin clamp, rampa entera).
   *   · `cupoAutorizadoHace2Dias`  = lo que `decidirCupoDeHoy` DECIDIÓ ese día. Es la magnitud que
   *     el §10 quiere acotar: la firma que ve el receptor no es un envío suelto, es el escalón.
   *
   * Hasta este cambio no se persistía en ningún lado y el comentario de abajo lo declaraba: el
   * clamp existía en `dailyQuota` desde el diseño v1 y NUNCA tuvo entrada. Ahora el daemon lo graba
   * en el `detail` del evento `sent` (`cupoDelDia`) y `cupoAutorizadoVigente` lo lee.
   *
   * SOLO PUEDE BAJAR: `dailyQuota` lo aplica con un `Math.min`, y con `0` o ausente no clampea
   * nada (no se puede multiplicar desde cero). Perderlo no abre ninguna puerta.
   */
  cupoAutorizadoHace2Dias?: number;
  /** Día de la semana en el receptor (1=lun…7=dom). */
  isoWeekday: IsoWeekday;
  /** Techo del plan: cuánto llega a mandar este dominio al final de la rampa. */
  limiteDiario?: number;
  /** Cuánto sube por día la rampa lineal. */
  pasoPorDia?: number;
  /**
   * ¿La rampa manda 0 el fin de semana? §3 del doc lo lista entre los levers, y `dailyQuota` lo
   * soporta desde el diseño v1 — pero los dos llamadores lo tenían escrito `false` a mano. Sale de
   * `rampaDesdeEnv` para que el daemon y el panel no puedan divergir.
   */
  soloDiasHabiles?: boolean;
  /**
   * EL PISO DE "SOSTENER" QUE EL OPERADOR PUEDE APROBAR (`WARMUP_RAMPA_PISO_SOSTENER`).
   *
   * Ausente ⇒ `CUPO_ARRANQUE`, o sea exactamente el comportamiento de hoy. Sólo se aplica a un
   * dominio con muestra suficiente Y entrega sana; ver `pisoConEvidencia` abajo.
   */
  pisoSostener?: number;
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

  const { muestra, inbox, tragados, tasa, tasaCruda } = medirPlacement(e.placements);

  // La rampa del diseño: lineal por día, con los clamps de §10. No se reescribe acá.
  //
  // EL CLAMP 3×/48h NO SE ALIMENTA MÁS DE `cupoHace2Dias`, y esto se midió contra la base de
  // producción antes de sacarlo. `cupoHace2Dias` son ENVÍOS REALES, y los envíos reales están
  // topados por `WARMUP_LIVE_MAX_PER_DAY` (14 vueltas para TODA la flota), así que por dominio dan
  // 1-8, casi siempre 2. Con eso adentro el clamp hacía dos cosas al revés:
  //   · corpfiling-infra.com —el más sano, 83% de bandeja— mandó 1 el 05-ago ⇒ techo 3/día;
  //   · opscorpfiling.com mandó 0 ese día ⇒ ausente del Map ⇒ SIN clamp, rampa entera.
  // O sea: frenaba a los sanos y soltaba a los que no mandaron. Y se realimentaba: el plan quedaba
  // fijo en 3-6/día para siempre mientras `accion` seguía diciendo "subir" y el panel pintaba una
  // rampa que no avanzaba.
  //
  // EL CLAMP YA TIENE SU ENTRADA, Y ES OTRA. `cupoAutorizadoHace2Dias` es el cupo que la decisión
  // AUTORIZÓ hace dos días, no lo que salió: el daemon lo graba en el `detail` del `sent`
  // (`cupoDelDia`) y `cupoAutorizadoVigente` lo lee. Es el dato que el §10 pide y que hasta hoy no
  // existía en ningún lado, así que el clamp estaba escrito y desconectado desde el diseño v1.
  //
  // Por qué importa que sea el AUTORIZADO y no el enviado: sin este dato, el día que se destrabe la
  // rampa no hay nada entre un dominio y un salto de 2 a 10 en 24 h — que es exactamente la firma
  // que el clamp existe para evitar. Y con el ENVIADO como base ya se probó que hace lo contrario
  // (frena a los sanos, suelta a los que no mandaron); ver el campo en `EntradaDecision`.
  //
  // Y ACÁ EL CLAMP DEJA DE FALLAR ABIERTO, que es el estado en el que está la producción HOY.
  //
  // `dailyQuota` (ramp.ts:88-94) sólo clampea `if (twoDaysAgo > 0)`: SIN el dato el clamp
  // desaparece y la rampa salta libre. Y el dato no está — medido contra la Postgres viva el
  // 2026-08-07: de las 54 filas `sent` de TODA la historia de warmup_activity, las que llevan
  // `detail.cupoDelDia` son CERO. El árbol desplegado es eb6b373 y el daemon que lo graba se
  // relanzó a las 17:59:27 hora local de ese día, o sea que la baranda es código nuevo sin una
  // sola vuelta de evidencia. Corrido con el código real: día 20 con ventana 6/6 y sin el campo
  // daba cupo 20; con el campo en 2 da 6. Ésa es la firma 10× en 24 h que el §10 existe para
  // evitar, y estaba abierta justo en el momento en que se va a destrabar la rampa.
  //
  // Y el hueco NO se cierra solo cuando el daemon empiece a grabar: con 6 dominios rotando, uno
  // que no mandó hace dos días vuelve a quedar sin dato y sin clamp.
  //
  // FALTA DE DATO ⇒ SE ASUME EL PISO (`CUPO_ARRANQUE`), no "sin techo". Con el piso, la primera
  // subida de un dominio no puede pasar de 3×2 = 6/día. Sólo puede BAJAR el cupo respecto de lo
  // que salía antes: nunca sube ninguno.
  //
  // El `> 0` explícito y no un `||` a secas: un valor negativo o NaN (el campo sale de un
  // `detail->>'cupoDelDia'` parseado) es truthy o cae en `clampNonNegativeInt` a 0, y las dos
  // formas devuelven el fail-open que esta línea vino a cerrar.
  //
  // UNA SOLA REGLA PARA LOS DOS CONSUMIDORES DEL DATO (el clamp de acá y el piso de `sostenido`,
  // 120 líneas abajo). Estaban escritas distinto y la segunda usaba `??`, que NO atrapa NaN: `NaN ??
  // x` devuelve NaN. Con eso `decidirCupoDeHoy` salía con `cupo: NaN` por la rama `sostener` y el
  // tope diario del dominio DESAPARECÍA — el gate del daemon es `enviadosHoyBox >= delDia.cupo` y
  // `n >= NaN` es false para todo n. Reproducido con el código real: ventana 5/6 (la de producción)
  // + `cupoAutorizadoHace2Dias: NaN` ⇒ `sostener cupo=NaN`, y `puedeMandarTurno` con 10.000 enviados
  // contestaba `si:true · "tiene NaN de cupo libre hoy"`.
  //
  // No es alcanzable HOY desde la base (el SQL filtra con `~ '^[0-9]+$'` y `cupoAutorizadoVigente`
  // descarta con `Number.isFinite`), y por eso mismo va acá y no allá: la próxima entrada del campo
  // —un endpoint, una orden, otro lector— no tiene por qué saber que este archivo se apoya en el
  // filtro del SQL. `x > 0` ya rechaza NaN, negativos y el 0 (que en `dailyQuota` significa "sin
  // clamp"); lo que faltaba era usarlo en los DOS lugares.
  const positivo = (x: number | undefined): number | null => (typeof x === "number" && x > 0 ? x : null);
  const baseDelClamp = positivo(e.cupoAutorizadoHace2Dias) ?? CUPO_ARRANQUE;
  const rampa = dailyQuota(
    {
      dailyLimit: e.limiteDiario ?? RAMPA_LIMITE_DIARIO_DEFAULT,
      increaseByDay: e.pasoPorDia ?? RAMPA_PASO_POR_DIA_DEFAULT,
      dayIndex: e.diaN,
      // Dejó de estar hardcodeado en `false`: la palanca existía en `dailyQuota` desde el diseño v1
      // y no había forma de encenderla sin tocar código. Sale de `rampaDesdeEnv`, igual que las
      // otras dos, para que el daemon y `/v1/warmup/plan` no puedan decir números distintos.
      weekdaysOnly: e.soloDiasHabiles ?? false
    },
    e.isoWeekday,
    { quotaTwoDaysAgo: baseDelClamp }
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
      `solo ${muestra} medición(es)${tragados > 0 ? ` (y ${tragados} correo(s) que se tragaron sin dejar rastro)` : ""}: ` +
        `hacen falta ${MUESTRA_MINIMA} para mover el volumen`
    );
  }

  // ── LAS DOS RAMAS QUE PARAN MIRAN LA PROPORCIÓN CRUDA ───────────────────────────────────────
  //
  // `cruda` cuenta los tragados en el denominador. Es la única forma de que un MISSING no pueda
  // SACAR a un dominio del freno (ver `medirPlacement`), y de que el dominio del que el receptor se
  // traga 36 de 40 —4 de 4 en bandeja, 100% depurado— caiga igual: 4/40 = 10%, frenar.
  //
  // El corte por `MUESTRA_MINIMA` sigue siendo sobre las filas MEDIDAS y sigue estando arriba, a
  // propósito: bajar el corte a `placements.length` haría que un dominio con 4 tragados y 2 medidos
  // pasara de `sostener 2` a `bajar rampa/2` = 20/día. "Bajar" no puede terminar mandando más que
  // "sostener": ésa es la dirección insegura y ya se metió una vez por esta misma puerta.
  const cruda = tasaCruda ?? tasa;
  // EL VOLUMEN DE "SOSTENER", CALCULADO ACÁ ARRIBA PORQUE ES EL TECHO DE "BAJAR".
  //
  // Lo pide la MONOTONÍA: peor placement no puede terminar mandando más correo. La rama `bajar`
  // vale `rampa/2`, que CRECE con el día (día 20 ⇒ 20/día), mientras `sostener` está anclado a lo
  // que el dominio realmente mandó anteayer —1 u 8, casi siempre 2, porque los envíos reales están
  // aplastados por el tope GLOBAL del daemon (`WARMUP_LIVE_MAX_PER_DAY=14` para toda la flota)—.
  // Con las dos ramas sueltas, medido corriendo `decidirCupoDeHoy` sobre la ventana de 6 de
  // producción (`WARMUP_LIVE_PLACEMENT_WINDOW=6`, verificado en gateway.env):
  //
  //   5 INBOX / 1 SPAM (83%) → sostener  2/día
  //   4 INBOX / 2 SPAM (67%) → bajar    20/día     ← DIEZ VECES MÁS, con peor entrega
  //
  // y lo mismo en toda la rampa (día 4: 2 vs 4; día 8: 2 vs 8; día 12: 2 vs 12). El presupuesto del
  // día se corría hacia el dominio que peor entrega: `live-warmup-daemon` gatea el envío real con
  // `enviadosHoyBox >= delDia.cupo`, así que el sano salía del reparto a los 2 envíos y el que se
  // estaba yendo a spam seguía elegible toda la vuelta. Ése es exactamente el mecanismo que empuja
  // al umbral permanente de Gmail.
  //
  // El comentario de la rama de la tasa cruda ya declaraba el invariante ("'Bajar' no puede
  // terminar mandando más que 'sostener'") y lo cuidaba en el borde de MUESTRA_MINIMA; la puerta
  // abierta era la de al lado. Ahora vale POR CONSTRUCCIÓN: subir ≥ sostener ≥ bajar ≥ frenar.
  //
  // Y EL PISO SE ANCLA AL CUPO AUTORIZADO, NO A LOS ENVÍOS — es el MISMO error que este archivo ya
  // diagnosticó y arregló para el clamp treinta líneas más arriba, y que quedó vivo acá abajo.
  // `cupoHace2Dias` son los correos que SALIERON, y los que salen están topados por un límite
  // GLOBAL del daemon (`WARMUP_LIVE_MAX_PER_DAY=14` para TODA la flota, verificado en el
  // gateway.env de la Studio), así que dan 1-8 y casi siempre 2 sin relación con lo que el dominio
  // tenía permitido. Medido con el código real: un dominio ya autorizado a 20/día que saca 5 de 6
  // (83%) caía a cupo 2 porque anteayer mandó 2 y no 20 — o sea que "sostener" DEMOTABA, y el plan
  // hacía sierra 20→2→6→6→18→20→2 mientras el panel decía "sostener".
  //
  // ── CUÁNTO VOLUMEN MUEVE ESTO, CON EL NÚMERO PUESTO ────────────────────────────────────────
  //
  // La versión anterior de este comentario decía "HOY NO MUEVE UN SOLO CUPO", y era cierto el día
  // que se escribió: con autorizado = enviado = 2 en los seis del pool, no cambia nada. Pero
  // `cupoAutorizadoHace2Dias` sale de `detail.cupoDelDia`, que el daemon YA graba en producción, así
  // que el dato aparece solo a las ~48 h y ahí la frase pasa a ser falsa sin que nadie toque nada.
  // Absolverse por el calendario es EXACTAMENTE la falla que este mismo lote vino a matar en el
  // sensor de salud (un nodo bloqueado deja de mandar, a los 5 días la evidencia se cae de la
  // ventana y sale `healthy`). Así que va el envelope medido en vez de una frase que vence.
  //
  // MEDIDO corriendo las DOS versiones día por día, realimentando la decisión como
  // `cupoAutorizadoHace2Dias` (que es como funciona de verdad: el autorizado de hace dos días es lo
  // que ESTA función decidió ese día), con los valores de producción (limiteDiario 40, paso 2):
  //   · ventana perfecta 6/6 INBOX ⇒ NUEVO y HEAD dan la MISMA serie, 2 4 6 8 … hasta el techo.
  //     El techo no se mueve: sigue siendo `limiteDiario` o la pared del nodo, lo que llegue antes.
  //   · sube 12 días y se degrada al 50% ⇒ HEAD cae 20→2 en UN día; NUEVO planea 20→10→5→2 en
  //     cuatro. Sobre 24 días: 196 correos contra 174, +13%.
  //   · salto máximo día-a-día en toda la trayectoria alcanzable: 2×, y lo topa el clamp 3×/48h.
  //
  // O SEA: no hay un salto de 2 a 20 en un día. Un barrido del producto cartesiano SÍ lo encuentra
  // (autorizado 40 contra un HEAD que ve 2), pero ese par de estados no puede coexistir: para tener
  // 40 autorizado hace dos días hay que haber rampeado hasta 40 pasando el gate de Wilson cada vez.
  // Alimentar las dos versiones con historias que no pueden ser simultáneas mide la diferencia entre
  // dos fixtures, no entre dos comportamientos — la misma trampa del fixture de Bedrock, un piso
  // más arriba. La diferencia REAL es planear en vez de caer en picada, y son +22 correos en 24 días.
  //
  // El test `el envelope de volumen no se mueve por calendario` pinta esas series y las afirma.
  //
  // El orden es autorizado → enviado → piso, y no autorizado a secas: mientras el daemon no tenga
  // dos días grabando `cupoDelDia`, el enviado es la única memoria que hay de que este dominio ya
  // venía mandando algo.
  //
  // EL PISO DEL OPERADOR (`WARMUP_RAMPA_PISO_SOSTENER`) SÓLO ENTRA ACÁ, Y SÓLO CON EVIDENCIA. Es la
  // ÚNICA palanca que puede destrabar la fábrica sin tocar código: hoy los seis del pool sostienen
  // en `CUPO_ARRANQUE`=2 porque la rampa pide `wilsonLowerBound >= 0,60` y el mejor dominio mide 5
  // de 6 (0,51 de piso), o sea que "sostener 2" es un punto fijo del que nadie sale solo. Sin la
  // env var la propuesta al operador era un párrafo: "subir el piso de 2 a N" sobre una constante
  // dura, sin nada que aprobar.
  //
  // Las dos condiciones no son decoración, son lo que impide que la palanca sea un cheque en blanco:
  //   · `muestra >= MUESTRA_MINIMA` ⇒ un dominio SIN medición nunca sube por esta puerta (esa rama
  //     retorna arriba con `Math.min(rampa, CUPO_ARRANQUE)` y ni llega hasta acá);
  //   · `cruda >= PISO_SANO` ⇒ el piso NO levanta al que está entregando mal. Las ramas `frenar` y
  //     `bajar` viven abajo y `bajar` topa en `sostenido/2`, así que subir el piso no puede subir el
  //     volumen de un dominio que se está yendo a spam más allá de la mitad.
  // Y sigue topado por `rampa` y por la pared del nodo, como todo lo demás.
  //
  // Default 2 = `CUPO_ARRANQUE` ⇒ HOY NO CAMBIA UN SOLO CORREO. Ése es el punto: la decisión de
  // subirlo es del operador (regla 6 del encargo: lo que aumenta volumen se PROPONE), y ahora tiene
  // dónde escribirse.
  const pisoConEvidencia =
    muestra >= MUESTRA_MINIMA && cruda >= PISO_SANO
      ? Math.max(CUPO_ARRANQUE, e.pisoSostener ?? CUPO_ARRANQUE)
      : CUPO_ARRANQUE;
  // `positivo(...)` y NO `?? ... ?? ...`: ver el comentario del `positivo` allá arriba. Ésta era la
  // mitad sin defender, y es la que gobierna la rama `sostener` — o sea la rama por la que pasa la
  // ventana REAL de producción (5 de 6). La otra mitad, el clamp, ya estaba cerrada, y el test que
  // decía cubrir el NaN lo probaba con `inbox(6)`: ventana perfecta ⇒ rama `subir` ⇒ la única que no
  // tenía el agujero. El test y el código compartían la suposición.
  const sostenido = Math.min(
    rampa,
    Math.max(pisoConEvidencia, positivo(e.cupoAutorizadoHace2Dias) ?? positivo(e.cupoHace2Dias) ?? CUPO_ARRANQUE)
  );
  const detalleCrudo =
    `${inbox} de ${e.placements.length} correos llegaron a bandeja` +
    (tragados > 0 ? ` (${tragados} se los tragaron sin dejar rastro)` : "");

  if (cruda < PISO_CRITICO) {
    return {
      cupo: 0,
      accion: "frenar",
      motivo: `placement ${pct(cruda)}: ${detalleCrudo}. Seguir mandando profundiza el pozo`,
      placement: tasa
    };
  }
  if (cruda < PISO_SANO) {
    // A la MITAD, no a cero. Un dominio que deja de mandar no recupera reputación: se queda
    // quieto. Lo que reconstruye es volumen bajo con buena señal.
    //
    // SE DIVIDE EL PISO TAMBIÉN, NO SÓLO EL TECHO, Y ESO ES LO QUE HACE QUE "BAJAR" BAJE.
    //
    // El clamp decía `Math.min(rampa/2, sostenido)`, y desde que `sostenido` se ancló al cupo
    // AUTORIZADO (treinta líneas más arriba) esa cota se REALIMENTA: autorizado(hoy) = lo que esta
    // misma rama decidió anteayer, así que la serie llega a un punto fijo y se queda ahí para
    // siempre. Medido corriendo el código real, sin tocar producción:
    //   · día 20 con autorizado 20 y ventana de 6: `sostener` (5/6, 83%) y `bajar` (4/6, 67%) daban
    //     LOS DOS cupo 20 — la señal de degradación no movía un solo correo;
    //   · un dominio que rampea a 20 y después entrega 67% para siempre se estacionaba en 11-13/día
    //     indefinidamente (d11=11 d12=12 d13=13 d14=11 … d30=12). Antes de anclar el piso al
    //     autorizado se estacionaba en 3. Cuatro veces más volumen sostenido sobre un dominio que se
    //     está yendo a spam, y sin decisión de nadie.
    // El test de monotonía existente no lo cazaba porque compara con `>=`: `sostener == bajar` pasa.
    //
    // Con el piso dividido la serie DESCIENDE: 20 → 10 → 5 → 2 en cuatro pasos, y ahí se queda.
    //
    // EL SUELO DE LA DIVISIÓN ES `CUPO_ARRANQUE`, NO 1, Y NO ES COSMÉTICA. Con `1` se rompía la
    // monotonía por el OTRO borde, y hay dos tests que lo cazan: la rama de `muestra <
    // MUESTRA_MINIMA` devuelve `min(rampa, CUPO_ARRANQUE)` = 2 sin mirar el placement, así que un
    // dominio con 4 correos TRAGADOS (peor señal, muestra chica) mandaba 2 y el mismo dominio con 2
    // tragados y 4 medidos al 67% mandaba 1. Peor placement, más volumen: la dirección insegura, la
    // misma puerta por la que este archivo ya se metió una vez.
    return contra(
      Math.min(Math.max(1, Math.floor(rampa / 2)), Math.max(CUPO_ARRANQUE, Math.floor(sostenido / 2))),
      "bajar",
      `placement ${pct(cruda)}: ${detalleCrudo}. Se baja a la mitad y se sigue mandando`
    );
  }

  // ── SUBIR EXIGE PRUEBA. BAJAR NO. ───────────────────────────────────────────────────────────
  //
  // Wilson entra ASIMÉTRICO y sólo acá, y la asimetría es el punto: para arriesgar más volumen hace
  // falta evidencia; para replegarse, no. Por eso las dos ramas de arriba (bajar y frenar) siguen
  // mirando la proporción cruda y ésta mira el límite inferior del intervalo.
  //
  // El bug que cierra, medido corriendo el código: el día que un dominio junta su CUARTA medición
  // pasa de `sostener 2` a la rampa entera —2 → 8/10/12/14/16 en 24 h— porque `4 de 4` se lee como
  // 100%. Con n=4, el 100% crudo es compatible con una tasa real del 51%: `wilsonLowerBound(4,4)`
  // da 0,51 y no llega a `PISO_PARA_SUBIR`. Una ventana limpia de 6 da 0,61 y ahí sí. O sea: la
  // rampa avanza cuando la evidencia la banca, no cuando la muestra es chica y tuvo suerte.
  //
  // El piso es `PISO_PARA_SUBIR` (0,60) y NO `PISO_SANO` (0,70): con la ventana de 6 de producción,
  // 0,70 hace el gate inalcanzable y la rampa muere en silencio. Ver la constante.
  //
  // `wilsonLowerBound` estaba implementado en domain/placement.ts desde el diseño v1 (§9, "gateo
  // sobre el LOWER-BOUND, no la proporción cruda") y NINGÚN camino vivo lo llamaba. Esta línea es
  // la que lo enchufa.
  const piso = wilsonLowerBound(inbox, muestra) ?? 0;
  if (piso < PISO_PARA_SUBIR) {
    // SOSTENER = el volumen que ya venía teniendo, no el de arranque. Bajarlo a 2 castigaría a un
    // dominio sano por no haber juntado muestra todavía, que es justo lo contrario de lo que se
    // busca. `cupoHace2Dias` es lo que REALMENTE mandó hace dos días (lo alimenta el daemon desde
    // la base): sin ese dato, un dominio que no mandó nada hace dos días no tiene volumen que
    // sostener y arranca de nuevo por el piso.
    return contra(
      sostenido,
      "sostener",
      `placement ${pct(tasa)} sobre ${muestra} mediciones, pero con esa muestra el piso real puede ser ${pct(piso)}: ` +
        `sostengo el volumen y junto evidencia antes de subir`
    );
  }

  // LO QUE ESTE CAMINO NO TIENE Y NO ES UN PENDIENTE OLVIDADO — va escrito acá para que nadie lo
  // agregue creyendo que falta:
  //   · NO hay un paso máximo de subida (`min(rampa, ayer + paso)`). Sería un segundo freno sobre
  //     exactamente lo mismo que ya frena el clamp 3×/48h, que desde este lote es fail-closed y por
  //     lo tanto EFECTIVO: la primera subida de un dominio sin historial topa en 6/día.
  //   · NO se toca `diasCorridos` (rotacion.ts) para contar días-con-envío en vez de días de
  //     calendario. Mueve el volumen de TODOS los dominios a la vez —eso se le propone al operador,
  //     no se ejecuta— y el clamp fail-closed ya neutraliza el salto por calendario.
  return contra(
    rampa,
    e.diaN > 1 ? "subir" : "arrancar",
    `placement ${pct(tasa)} sobre ${muestra} mediciones (piso ${pct(piso)}): la rampa avanza (día ${e.diaN})`
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
   * Las mediciones PROPIAS de este dominio en la ventana. Ya NO es el gate del turno —lo es el cupo,
   * ver la regla de abajo— pero sigue siendo obligatorio y sigue viajando al motivo: es el número
   * que explica POR QUÉ el dominio está en el piso, y el log del daemon es donde esto se audita.
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
  // EL TURNO DE CONTINUACIÓN NO SE COME LA MEDICIÓN DEL DÍA MIENTRAS EL DOMINIO ESTÉ EN EL PISO.
  //
  // El envío principal (`runLiveCycle`) mide dónde cayó; el turno de continuación solo graba `sent`
  // y no mide nada — no hay paso de medición en ese camino. Peor: cuando la respuesta del hilo SÍ
  // se mide, la fila sale etiquetada `origen = 'continuación de hilo'` y `filasDePlacement`
  // (plan-diario.ts) la EXCLUYE de la ventana con `(detail->>'origen') IS DISTINCT FROM
  // 'continuación de hilo'`. O sea que el "Re:" gasta cupo y no aporta una sola fila a la ventana
  // que gobierna el volumen de ese dominio.
  //
  // LA CONDICIÓN ES EL CUPO, NO LA MUESTRA, y el cambio es el corazón de este lote. La primera
  // versión cortaba por `medicionesPropias < MUESTRA_MINIMA`, o sea que la regla se APAGABA justo
  // cuando el dominio empezaba a servir. Medido en la Postgres viva el 2026-08-07: de 51 envíos de
  // 10 días, 15 fueron continuaciones, y corpfiling-infra.com —el mejor de la flota, 12 mediciones
  // propias, 83% de bandeja— gastó 6 de sus 21 envíos en un "Re:" que no entra a su ventana. A
  // cupo 2 con una continuación por día su ritmo útil cae de 2 a 1 medición/día: 10 mediciones
  // vivas contra las ~14 que el gate de Wilson le pediría para graduarse. EL DOMINIO QUE MEJOR
  // ENTREGA NO PUEDE GRADUARSE MIENTRAS CONVERSA, y con el corte viejo era el único al que la
  // regla no lo protegía.
  //
  // No cuesta un correo más: es el MISMO volumen mejor gastado (por eso no necesita autorización
  // del operador). Y la salida es automática, nadie tiene que acordarse de nada: apenas la rampa
  // levanta al dominio del piso (cupo > CUPO_ARRANQUE) la conversación multivuelta vuelve sola, y
  // ahí ya le sobra cupo para las dos cosas.
  //
  // El caso que la primera versión NO atajaba y éste tampoco puede volver a abrir: con cupo 2 y 0
  // enviados el "Re:" salía igual, porque `hilosParaContinuar` busca por SEMILLA y ventana de 7
  // días, no por el box de la vuelta — el turno cae rutinariamente en un dominio que todavía no
  // mandó hoy y le come la PRIMERA de sus dos oportunidades (annualfilings-control.com: 1
  // continuación, 1 principal, 1 medición en el día).
  //
  // ES LA CONJUNCIÓN, NO LA SUSTITUCIÓN, Y ACÁ ESTÁ EL PORQUÉ. Cortar sólo por `cupo <=
  // CUPO_ARRANQUE` APAGA LA CONVERSACIÓN MULTIVUELTA EN TODA LA FLOTA: los SEIS dominios del pool
  // están hoy en cupo 2 y ninguno se mueve de ahí solo (la rampa exige un piso de Wilson de 0,60 y
  // el mejor mide 0,51), así que la condición de salida "cupo > 2" no la cumple nadie y la regla
  // deja de tener fecha de vuelta. Corrido con el código real sobre las seis ventanas de producción:
  // los seis daban `si:false`, incluido corpfiling-infra.com con 12 mediciones propias y 83% de
  // bandeja.
  //
  // LO QUE ESTA CONJUNCIÓN **NO** ES: el freno que devuelve la medición perdida. Ése es el guarda de
  // abajo, y la distinción se pagó con un comentario falso. La conjunción es HOY EQUIVALENTE a la
  // condición de HEAD (`medicionesPropias < MUESTRA_MINIMA` sola) en todo estado alcanzable:
  // `decidirCupoDeHoy` devuelve `Math.min(rampa, CUPO_ARRANQUE)` mientras `muestra < MUESTRA_MINIMA`,
  // así que `cupo > CUPO_ARRANQUE` IMPLICA `muestra >= MUESTRA_MINIMA`, y `medicionesPropias` sale
  // del MISMO array que `muestra` (live-warmup-daemon.ts pasa `propias.length`). Barrido exhaustivo
  // con el código real —11.880 combinaciones de ventana × diaN × cupoFisico × isoWeekday ×
  // pisoSostener—: CERO estados con `cupo > 2` y menos de 4 mediciones, y CERO veredictos distintos
  // contra HEAD. Se conserva igual porque expresa la REGLA (con cupo de sobra, un "Re:" no le saca
  // la medición a nadie) y esa regla tiene que seguir valiendo el día que la rampa se destrabe; lo
  // que no puede seguir es leerse como si cambiara algo hoy.
  if (cupo <= CUPO_ARRANQUE && e.medicionesPropias < MUESTRA_MINIMA) {
    return {
      si: false,
      motivo:
        `${e.dominio} está en el piso de la rampa (cupo ${cupo}/día) y todavía le falta muestra ` +
        `(${e.medicionesPropias} de ${MUESTRA_MINIMA} mediciones propias): sus envíos del día van al ciclo ` +
        `principal, que MIDE dónde cayó — el "Re:" no entra a la ventana que gobierna su volumen`
    };
  }
  // Y EL "Re:" NUNCA SE QUEDA CON LA ÚLTIMA RANURA DEL DÍA. Éste es el guarda que muerde de verdad,
  // y es el que devuelve la medición que se estaba perdiendo en los dominios que YA tienen muestra —
  // los que la conjunción de arriba deja pasar enteros.
  //
  // Medido en la Postgres viva (7 días): 51 envíos, 15 continuaciones, y CERO de ellas produjo una
  // fila `measured`. `filasDePlacement` (plan-diario.ts) excluye el origen 'continuación de hilo' de
  // la ventana con `IS DISTINCT FROM`, así que ese correo gasta cupo y no aporta un dato a la ventana
  // que gobierna su propio volumen. corpfiling-infra.com —el mejor de la flota, y el dominio del que
  // trata el encargo— hizo 21 envíos y sacó 12 mediciones en vez de ~18: 29% del correo tirado justo
  // donde el gate de Wilson le está pidiendo n≈14 para graduarse. Con la conjunción sola, 5 de los 6
  // dominios del pool seguían habilitados a hacer exactamente eso.
  //
  // NO apaga la conversación multivuelta, que es la objeción legítima contra `cupo <= CUPO_ARRANQUE`
  // a secas: con cupo 2 el turno sigue saliendo, sólo que en la PRIMERA ranura y no en la última, así
  // que siempre queda una para el ciclo principal, que es el único que mide. Y con
  // `WARMUP_RAMPA_PISO_SOSTENER` arriba de 2 se afloja solo.
  //
  // Sólo puede BAJAR volumen ⇒ no necesita autorización del operador (regla 6 del encargo).
  if (cupo - e.enviadosHoy <= 1) {
    return {
      si: false,
      motivo:
        `${e.dominio} tiene UNA sola ranura libre hoy (cupo ${cupo}/día, van ${e.enviadosHoy}) y esa es ` +
        `la que MIDE: el "Re:" se graba como 'continuación de hilo' y su ventana de placement lo excluye`
    };
  }
  return { si: true, motivo: `${e.dominio} tiene ${cupo - e.enviadosHoy} de cupo libre hoy` };
}

// ══ LA EVIDENCIA LLEVA SU PROVEEDOR (B2) ═════════════════════════════════════════════════════════
//
// §6 del doc de auditoría (2026-07-23) dice que la ventaja de Delivrix sobre Instantly es placement
// con evidencia REAL por proveedor, contra su health score interno, que es un proxy. Verificado
// contra el código de hoy, la ventaja estaba a medias y el número mentía por omisión: `placementTasa`
// y `placementMuestra` viajaban SIN proveedor hasta el prompt y hasta el panel.
//
// Medido contra la Postgres de producción el 2026-08-07, las 24 filas `measured` de los últimos 10
// días salen de DOS semillas y las dos son Gmail (trazosvercel@gmail.com y flomia33193@gmail.com).
// O sea que el "83% inbox" que el jefe leyó es 83%-EN-GMAIL presentado como placement a secas, con
// Outlook y Yahoo —los dos receptores que más nos bloquean— en punto ciego.
//
// Y no es cosmético: §3 del mismo doc usa umbrales DISTINTOS por proveedor (≥95% Gmail, ≥90%
// Outlook). Un número sin proveedor no se puede comparar contra su umbral, así que sin esto el gate
// determinista de más abajo no se puede construir honestamente.

/**
 * Una medición CON la semilla que la produjo. El campo `semilla` es todo lo que hacía falta: el
 * proveedor sale por lookup en el registro (warmup-seeds.json), no por una migración.
 */
export interface FilaPlacement {
  placement: Placement;
  /** Dirección de la semilla que midió (columna `seed_inbox` de warmup_activity). */
  semilla: string;
}

/** Lo que se midió EN UN receptor. `tasa: null` es NO MEDIDO, y no es lo mismo que 0%. */
export interface PlacementDeProveedor {
  proveedor: string;
  tasa: number | null;
  muestra: number;
  inbox: number;
}

export interface PlacementConProveedor {
  /**
   * Quién midió. `"varios"` si más de un receptor aportó filas; `null` si nadie midió.
   *
   * `null` y no `"gmail"` por defecto: adivinar el proveedor es exactamente la mentira por omisión
   * que este campo vino a cerrar.
   */
  proveedor: string | null;
  /** La MISMA cuenta agregada de siempre (`medirPlacement`), para que nada cambie de valor. */
  tasa: number | null;
  muestra: number;
  /** Uno por receptor, incluidos los que NO midieron nada — ésos salen con `tasa: null`. */
  porProveedor: PlacementDeProveedor[];
}

/**
 * Reparte las mediciones por receptor. Pura: el registro de semillas entra como función.
 *
 * LOS PROVEEDORES CLAVE APARECEN SIEMPRE, con `tasa: null` cuando nadie midió ahí. Es la regla más
 * cara del archivo y por eso es explícita: "no medido" y "cero" no son lo mismo. Un Outlook que sale
 * 0% se lee como "todo nuestro correo va a spam en Outlook" y dispara un freno sobre evidencia que
 * no existe; un Outlook que sale `no sé` dice la verdad, que es que no tenemos semilla ahí.
 */
export function medirPorProveedor(
  filas: readonly FilaPlacement[],
  proveedorDe: (semilla: string) => string | null,
  proveedoresDeInteres: readonly string[] = PROVEEDORES_CLAVE
): PlacementConProveedor {
  const porNombre = new Map<string, Placement[]>();
  for (const f of filas) {
    // Una semilla que no está en el registro NO se cuenta como gmail: se declara `desconocido`. Con
    // el default silencioso, borrar una semilla del registro habría movido sus mediciones al montón
    // del proveedor equivocado sin que nada fallara.
    const p = proveedorDe(f.semilla) ?? "desconocido";
    const lista = porNombre.get(p) ?? [];
    lista.push(f.placement);
    porNombre.set(p, lista);
  }
  for (const p of proveedoresDeInteres) if (!porNombre.has(p)) porNombre.set(p, []);

  const porProveedor = [...porNombre.entries()]
    .map(([proveedor, ps]) => {
      // La MISMA cuenta que decide el volumen (`medirPlacement`), no una parecida: saca los MISSING
      // del denominador igual que la agregada. Dos cuentas del mismo hecho es cómo se desincronizan.
      const m = medirPlacement(ps);
      return { proveedor, tasa: m.tasa, muestra: m.muestra, inbox: m.inbox };
    })
    .sort((a, b) => b.muestra - a.muestra || a.proveedor.localeCompare(b.proveedor));

  const conMuestra = porProveedor.filter((p) => p.muestra > 0);
  const total = medirPlacement(filas.map((f) => f.placement));
  return {
    proveedor: conMuestra.length === 0 ? null : conMuestra.length === 1 ? conMuestra[0]!.proveedor : "varios",
    tasa: total.tasa,
    muestra: total.muestra,
    porProveedor
  };
}

/** `gmail` → `Gmail`, `m365` → `M365`. Para que la cifra se lea, no para adornar. */
export function nombreDeProveedor(p: string): string {
  if (p === "varios") return "varios receptores";
  if (p === "desconocido") return "una semilla que no está en el registro";
  return p.replace(/^./, (c) => c.toUpperCase());
}

/**
 * LA ÚNICA FORMA EN QUE UNA CIFRA DE PLACEMENT SALE DEL MOTOR.
 *
 * Existe como función y no como plantilla en cada llamador porque el defecto era justamente ése:
 * cada lugar armaba su propio texto y ninguno tenía el proveedor. Con una sola función, el día que
 * aparezca una semilla de Outlook la frase cambia sola en el log, en el panel y en Slack.
 */
export function textoPlacement(p: { proveedor: string | null; tasa: number | null; muestra: number }): string {
  if (p.proveedor === null || p.tasa === null) return "placement no sé (todavía sin mediciones)";
  return `placement ${nombreDeProveedor(p.proveedor)} ${pct(p.tasa)} sobre ${p.muestra} mediciones`;
}

/** Una línea por receptor, con el `no sé` explícito. Los que no midieron NUNCA salen como 0%. */
export function textoPorProveedor(p: PlacementDeProveedor): string {
  return p.muestra === 0
    ? `${nombreDeProveedor(p.proveedor)}: no sé (ninguna semilla mide ahí)`
    : `${nombreDeProveedor(p.proveedor)} ${pct(p.tasa!)} sobre ${p.muestra}`;
}

// ══ EL GATE DE §3 COMO DATO EVALUADO, NO COMO PROSA EN EL PROMPT (B1) ════════════════════════════
//
// §3 del doc trae la receta con números: avanzar si inbox ≥95% (Gmail) o ≥90% (Outlook) sostenido
// 2-3 días, bounce <2%, complaint <0.1%; pausar si <80%, bounce >5%, complaint >0.3% o blacklist.
//
// VA COMO FUNCIÓN Y NO COMO TEXTO EN EL PROMPT por la lección que este proyecto ya pagó dos veces:
// un criterio en PROSA dentro del prompt el modelo lo devuelve como hallazgo propio, y si es falso
// lo devuelve con seguridad. Al modelo le llega el VEREDICTO (pasa / cuál condición falló), no el
// criterio. §5.2 del mismo doc lo dice desde el otro lado: el LLM propone y explica, el breaker es
// determinista.
//
// CADA UMBRAL DEL DOC, con la línea del código de HOY que lo implementa o la nota de que no existe
// (el doc es del 2026-07-23 y parte de su diagnóstico ya se arregló — verificado uno por uno):
//
//   · inbox ≥95% Gmail / ≥90% Outlook   → `UMBRAL_INBOX_POR_PROVEEDOR`, acá abajo. El motor vigente
//     corre con `piso placement 50%` (línea ARRANCA del daemon en producción) y `PISO_SANO = 0,70`:
//     una banda entera POR DEBAJO de lo que el doc llama "pausar" (<80%). Ésta es la brecha.
//   · sostenido 2-3 días                 → NO EXISTE EN EL MOTOR. `placementsDeDominio` devuelve una
//     ventana de N filas (LIMIT 6 en producción), no una serie por día; `node-state.ts` tiene
//     `sustainedDaysOverBar` y ningún camino vivo lo alimenta (§1.3 del doc, sigue vigente).
//     El gate usa MUESTRA_MINIMA como sustituto declarado, que es más débil y hay que decirlo.
//   · bounce <2%                         → se evalúa con `rechazadosMta/(entregados+rechazados)` del
//     receptor, que sale de sender-measurement.json (`porReceptor`). Ausente en 5 de los 6 dominios
//     que hoy calientan, porque el escritor filtra los receptores con menos de 20 intentos: ahí el
//     gate dice "no sé", nunca "pasa".
//   · complaint <0,1% (y >0,3%)          → NO EXISTE EN EL MOTOR. No hay ingesta de FBL ni de Google
//     Postmaster en ningún archivo del repo; §7 del doc lo pone como pendiente P1 y sigue pendiente.
//   · blacklist                          → EXISTE PERO NO ESTÁ CABLEADO AL PLAN. `checks/
//     ip-network-checks.ts` implementa `rblQuery` (Spamhaus/Barracuda/SpamCop) y el único consumidor
//     es `live/dns-adapters.ts`, que no lo llama ningún camino del plan diario.
//   · cruzó el umbral permanente de Gmail → `elegirPool` (plan-diario.ts) ya lo excluye del pool.
//     Entra igual al gate porque el gate se evalúa por dominio y tiene que poder decirlo.
//
// EL GATE SOLO INFORMA. No frena, no suelta y no cambia ningún cupo: `decidirCupoDeHoy` no lo llama.
// Cablearlo a una acción cambia el comportamiento de la flota entera de golpe, y frenar de más es
// tan caro como frenar de menos — es el episodio del `placement-pause`, que paró al único dominio
// que calentaba bien.

/** §3: el umbral de bandeja para AVANZAR, por receptor. Gmail es el más exigente. */
export const UMBRAL_INBOX_POR_PROVEEDOR: Readonly<Record<string, number>> = {
  gmail: 0.95,
  workspace: 0.95,
  outlook: 0.9,
  m365: 0.9
};
/** Receptor no listado en §3 (yahoo, gmx, web.de): se le aplica el más permisivo de los dos. */
export const UMBRAL_INBOX_POR_DEFECTO = 0.9;
/** §3: bounce por encima de esto y el dominio no avanza. */
export const UMBRAL_REBOTES = 0.02;

export interface GateDelDoc {
  pasa: boolean;
  /** Qué condición falló, en castellano. `null` sólo si pasa. */
  condicionQueFalla: string | null;
  /** El receptor cuyo umbral se aplicó. `null` = no hubo medición. */
  proveedor: string | null;
  umbral: number | null;
  /**
   * Lo que el gate NO PUDO evaluar porque el motor no lo mide. Se declara, jamás se asume bueno:
   * ausencia de dato no es evidencia de que algo está bien.
   */
  sinInstrumento: string[];
}

/**
 * El veredicto de §3 para UN dominio. Pura: mismo estado ⇒ mismo veredicto, sin reloj ni red.
 *
 * Con más de un receptor midiendo se aplica el umbral MÁS EXIGENTE de los que midieron. Promediar
 * dos receptores con umbrales distintos daría un número que no se puede comparar contra ninguno.
 */
export function evaluarGate(e: {
  placement: PlacementConProveedor | { proveedor: string | null; tasa: number | null; muestra: number; porProveedor?: PlacementDeProveedor[] };
  /** Lo que dijo NUESTRO MTA para ese receptor en la ventana. `null`/ausente = no medido. */
  entregadosMta?: number | null;
  rechazadosMta?: number | null;
  /** ¿Ya cruzó el umbral permanente de "bulk sender" de Gmail? Lo sabe sender-measurement.json. */
  cruzoUmbralPermanente?: boolean;
}): GateDelDoc {
  const sinInstrumento = [
    "complaint rate (§3 pide <0,1%): no existe en el motor — no hay ingesta de FBL ni Postmaster",
    "sostenido 2-3 días (§3): no existe en el motor — la ventana es de N mediciones, no una serie diaria",
    "listas negras (§3): el chequeo existe (checks/ip-network-checks.ts) pero ningún camino del plan lo llama"
  ];
  // EL UMBRAL Y LA TASA TIENEN QUE SER DEL MISMO RECEPTOR. Antes se elegía el umbral con `Math.max`
  // sobre los que midieron —correcto— y se comparaba contra `placement.tasa`, que es la tasa
  // AGREGADA de todos los receptores juntos. Un promedio contra el umbral del más exigente da PASA
  // falso: Gmail 9/10 (90%, por debajo de su propio 95%) + Outlook 10/10 (100%) ⇒ pooled 95% ⇒
  // pasa, cuando §3 evaluado sobre Gmail dice que no. Y al revés esconde de quién es el problema:
  // Gmail 100% + Outlook 0% salía como "placement varios receptores 50%", sin nombrar cuál falló.
  //
  // Hoy no dispara porque las dos semillas que miden son Gmail — o sea que el defecto está armado y
  // esperando a la primera semilla de Outlook. Y un PASA falso no es sólo un texto: alimenta la
  // propuesta de SUBIR volumen, que es irreversible si sale mal.
  //
  // La regla: TODOS los que midieron pasan el SUYO. La primera que incumple se nombra.
  const conMuestra = (e.placement.porProveedor ?? [])
    .filter((p) => p.muestra > 0)
    .map((p) => ({ ...p, umbral: UMBRAL_INBOX_POR_PROVEEDOR[p.proveedor] ?? UMBRAL_INBOX_POR_DEFECTO }));
  const incumple = conMuestra.find((p) => p.tasa === null || p.tasa < p.umbral);
  const umbral =
    incumple !== undefined
      ? incumple.umbral
      : conMuestra.length > 0
        ? Math.max(...conMuestra.map((p) => p.umbral))
        : e.placement.proveedor !== null
          ? UMBRAL_INBOX_POR_PROVEEDOR[e.placement.proveedor] ?? UMBRAL_INBOX_POR_DEFECTO
          : null;
  // El proveedor que se reporta es el DUEÑO del umbral que se aplicó: decir umbral 95% con
  // proveedor "varios" es la misma mezcla de magnitudes, contada en dos campos.
  const base = { proveedor: incumple?.proveedor ?? e.placement.proveedor, umbral, sinInstrumento };

  if (e.cruzoUmbralPermanente === true) {
    return { ...base, pasa: false, condicionQueFalla: "cruzó el umbral permanente de bulk sender de Gmail: es irreversible" };
  }
  if (e.placement.tasa === null || e.placement.muestra < MUESTRA_MINIMA) {
    return {
      ...base,
      pasa: false,
      condicionQueFalla: `sin muestra suficiente: ${e.placement.muestra} de ${MUESTRA_MINIMA} mediciones — no sé dónde cae`
    };
  }
  const intentos = (e.entregadosMta ?? 0) + (e.rechazadosMta ?? 0);
  if (e.rechazadosMta != null && e.entregadosMta != null && intentos > 0) {
    const tasaRebotes = e.rechazadosMta / intentos;
    if (tasaRebotes >= UMBRAL_REBOTES) {
      return {
        ...base,
        pasa: false,
        condicionQueFalla: `rebotes ${pct(tasaRebotes)} sobre ${intentos} intentos: §3 pide menos de ${pct(UMBRAL_REBOTES)}`
      };
    }
  } else {
    sinInstrumento.push("rebotes (§3 pide <2%): nuestro MTA no reporta este receptor en la ventana");
  }
  if (incumple !== undefined) {
    return {
      ...base,
      pasa: false,
      condicionQueFalla:
        `${textoPlacement(incumple)}: §3 pide ${pct(incumple.umbral)} para ${nombreDeProveedor(incumple.proveedor)}`
    };
  }
  // El llamador que no trae `porProveedor` (la firma lo permite) se sigue evaluando como antes: su
  // tasa es de UN receptor o de ninguno, así que ahí agregada y por proveedor son lo mismo.
  if (conMuestra.length === 0 && umbral !== null && e.placement.tasa < umbral) {
    return {
      ...base,
      pasa: false,
      condicionQueFalla:
        `${textoPlacement(e.placement)}: §3 pide ${pct(umbral)} para ${nombreDeProveedor(e.placement.proveedor ?? "")}`
    };
  }
  return { ...base, pasa: true, condicionQueFalla: null };
}

// ══ EL CRUCE QUE NINGÚN COMPETIDOR PUEDE COPIAR ══════════════════════════════════════════════════
//
// Tenemos DOS cosas que nadie que compre el envío puede tener juntas:
//   · lo que dijo NUESTRO MTA — entregados/rechazados/diferidos por receptor, sacados del mail.log
//     del nodo por SSH (sender-measurement.json);
//   · DÓNDE CAYÓ — la semilla leída por IMAP (warmup_activity).
//
// La diferencia entre "mi Postfix dice 250 entregado" y "la semilla dice SPAM" ES la reputación,
// limpia de ruido de bloqueo. Un servicio comprado no puede dar ese número porque no tiene el MTA.
// Hasta hoy los dos datos vivían en dos archivos que ningún código juntaba.
//
// LO QUE MIDIÓ EL PRIMER CRUCE, corriendo ESTA función sobre los datos reales de producción el
// 2026-08-07 (la ventana salió por SELECT de la Postgres viva, el `porReceptor` de una copia de
// sender-measurement.json). Es el número que decide si el ítem vale, y es modesto:
//
//   · CASOS DE "ENTREGADO PERO EN SPAM": UNO, en corpfiling-infra.com. Sobre la ventana de
//     producción (`WARMUP_LIVE_PLACEMENT_WINDOW=6`) el MTA entregó 20 a gmail.com y de los 6
//     medidos 1 cayó en SPAM ⇒ reputación pura, no bloqueo. Contando los 5 días completos del
//     sender-measurement son 12 medidos (10 INBOX + 2 SPAM) ⇒ 2 casos; el número depende de la
//     ventana y por eso las dos cifras van juntas.
//   · 14 ENTREGAS QUE NINGUNA SEMILLA VIO en ese mismo dominio (20 del MTA contra 6 medidos). Ése
//     es el dato que el cruce agrega y que ni el placement ni el MTA dan por separado.
//   · SÓLO 2 DE 7 dominios tienen el dato del MTA por receptor (corpfiling-infra.com y
//     nationalfiling-infra.com). Los otros cinco tienen `porReceptor: []`, porque el escritor filtra
//     los receptores con menos de `BLOCKED_MIN_ATTEMPTS` (20) intentos y nuestro warmup manda
//     ~2/día por dominio. Ahí el cruce dice `no sé`, que es la verdad.
//   · y encima los 58 nodos están en `atribucion.modo: "todo"` con `queueIds: 0`, así que ni ese 20
//     está atribuido a nosotros: puede incluir correo del otro inquilino. Se declara en la lectura.
//
// Por eso esto entra como DATO al lado de cada dominio y no como consejo, y por eso dice `no sé`
// cuando no hay con qué cruzar. Hoy es un instrumento con UN caso; su valor sube solo cuando suba
// el volumen o baje el filtro de 20 intentos, y las dos cosas son decisión del operador.

/** Una fila de `porReceptor` de sender-measurement.json. */
export interface EntregaPorReceptor {
  receptor: string;
  entregados: number;
  rechazados: number;
  diferidos: number;
}

export interface CruceEntregaPlacement {
  /** Dominio del receptor, tal como lo llama el mail.log (`gmail.com`). */
  receptor: string;
  /** Lo que reportó NUESTRO MTA. `null` = el receptor no figura en la medición: no sé, no cero. */
  entregadosMta: number | null;
  rechazadosMta: number | null;
  /** Lo que midió la semilla en la ventana de placement. */
  medidos: number;
  inbox: number;
  enSpam: number;
  /** Entregas del MTA que ninguna semilla vio. `null` cuando el MTA no reporta el receptor. */
  sinMedir: number | null;
  /** El cruce en castellano, como DATO. Nunca un consejo. */
  lectura: string;
}

/**
 * Cruza lo que dijo el MTA con dónde cayó, por receptor. Pura.
 *
 * El receptor sale del DOMINIO de la dirección de la semilla, que es exactamente la clave que usa
 * `byProvider` en el clasificador del mail.log. Sin tabla de equivalencias: si algún día cambia el
 * criterio del clasificador, esto se rompe ruidosamente en vez de mentir en silencio.
 */
export function cruzarEntregaConPlacement(e: {
  filas: readonly FilaPlacement[];
  porReceptor: readonly EntregaPorReceptor[] | undefined;
  /** `true` sólo si la medición del MTA está atribuida a NUESTRO correo (`modo: "nuestro"`). */
  atribuido: boolean;
}): CruceEntregaPlacement[] {
  const porDestino = new Map<string, Placement[]>();
  for (const f of e.filas) {
    const receptor = f.semilla.split("@")[1]?.toLowerCase() ?? "";
    if (!receptor) continue;
    const l = porDestino.get(receptor) ?? [];
    l.push(f.placement);
    porDestino.set(receptor, l);
  }
  const mta = new Map((e.porReceptor ?? []).map((r) => [r.receptor.toLowerCase(), r]));

  return [...porDestino.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([receptor, ps]) => {
      const m = medirPlacement(ps);
      const enSpam = ps.filter((p) => p === "SPAM").length;
      const fila = mta.get(receptor);
      const entregadosMta = fila?.entregados ?? null;
      const rechazadosMta = fila?.rechazados ?? null;
      const sinMedir = entregadosMta === null ? null : Math.max(0, entregadosMta - ps.length);
      const salvedad = e.atribuido
        ? ""
        : " (el veredicto del MTA sale de TODO el correo del nodo, no sólo del nuestro)";
      let lectura: string;
      if (entregadosMta === null) {
        lectura =
          `nuestro MTA no reporta ${receptor} en la ventana (el escritor filtra los receptores con ` +
          `menos de 20 intentos): no sé cuánto entregó, así que el cruce no se puede hacer`;
      } else if (entregadosMta === 0 && (rechazadosMta ?? 0) > 0) {
        lectura = `nuestro MTA no entregó a ${receptor} (${rechazadosMta} rechazos): es BLOQUEO, el placement no aplica${salvedad}`;
      } else if (enSpam > 0) {
        lectura =
          `nuestro MTA entregó ${entregadosMta} a ${receptor} y ${enSpam} de ${m.muestra} medidos ` +
          `cayeron en SPAM: eso es REPUTACIÓN, no bloqueo${salvedad}`;
      } else {
        lectura = `nuestro MTA entregó ${entregadosMta} a ${receptor} y ningún medido cayó en SPAM${salvedad}`;
      }
      if (sinMedir !== null && sinMedir > 0) {
        lectura += ` · ${sinMedir} entrega(s) que ninguna semilla vio`;
      }
      return { receptor, entregadosMta, rechazadosMta, medidos: m.muestra, inbox: m.inbox, enSpam, sinMedir, lectura };
    });
}

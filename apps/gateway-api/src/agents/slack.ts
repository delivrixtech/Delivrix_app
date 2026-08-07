// EL CANAL DONDE EL AGENTE LE HABLA A JUANES.
//
// La pieza difícil acá NO es mandar el mensaje: son diez líneas de fetch. Es decidir CUÁNDO
// hablar. El agente corre cada 10 minutos; si escribe en cada corrida son 144 mensajes por día,
// y en dos días el operador lo silencia. Un agente silenciado es peor que no tenerlo, porque el
// día que sí importa nadie lo lee.
//
// La regla, en una frase: habla cuando algo CAMBIÓ, cuando necesita una DECISIÓN, o cuando algo
// FALLÓ y no puede resolverlo. Si todo sigue igual, se calla.
//
// `decidirSiHablar` es pura y testeable. Mandar es aparte.
//
// EL PÉNDULO, y por qué existe la razón 7. El arreglo del 2026-08-06 (sacar las manos pasivas del
// disparador, repetir cada 6 h las condiciones que persisten) bajó los ~25 mensajes de una noche
// — y de paso lo dejó mudo. Medido sobre las últimas ~8 h de producción de ese día, 45 vueltas de
// guardia: habló 3 veces, "Sigo acá…" a las 19:02, "No pude leer el estado" a las 21:00 y "Sigo
// acá…" a las 01:01. Dos rellenos y un error. En esa MISMA ventana la base registró 14 eventos
// reales (5 sent, 3 measured INBOX, 3 engaged, 3 replied), incluidos dos INBOX de
// annualfilings-control.com a las 20:00 y 21:00. A las 01:10 el jefe escribió "No me has dicho
// nada en toda la tarde …".
//
// El diagnóstico no es que las seis razones estén mal: es que las SEIS miran el estado del AGENTE
// (qué hizo, qué no pudo, si vio) y NINGUNA mira el estado de la FÁBRICA. Por eso se lo pudo dejar
// mudo sin violar ninguna regla — 0 de 38 avisos en 24 h nombraron un porcentaje, una muestra, un
// día de rampa o un INBOX.
//
// La razón 7 suma eso, con el único criterio que se puede auditar con un comando: un mensaje
// proactivo vale si y solo si se puede escribir como (campo, objeto, antes, después) y esa tupla
// se puede RECALCULAR desde los dos últimos snapshots. Si no se puede escribir así, no sale —
// aunque sea interesante. La lista de campos es CERRADA a propósito: un criterio en prosa el
// modelo lo devuelve como hallazgo propio, y este proyecto ya lo pagó dos veces.
//
// EL CIERRE DE UNA PROMESA NO PASA POR ACÁ, y estuvo un rato. La idea era "el canal tiene que tener
// UN número", así que la promesa viajaba pegada al aviso de la guardia. No cumplía ninguna de sus
// dos metas: (a) pegada perdía el `hilo` donde se prometió y el motivo pasaba a ser el del otro
// aviso, o sea el "Te dije que te avisaba…" aparecía en el canal suelto como pie de página de
// "Hice esto: soltar_dominio corp-delivery.com"; y (b) cuando viajaba sola NO consultaba el
// presupuesto —solo incrementaba el contador— así que el tope de 10 no la frenaba nunca. Ahora el
// cierre lo manda quien cablea, en su propio hilo, y su freno vive en promesas.ts (ver
// MINUTOS_ENTRE_DISCULPAS). Una respuesta dentro de un hilo no suena el canal: no compite con esto.

import type { HechosWarmup } from "./warmup-monitor.ts";

/** Un cambio entre las dos últimas lecturas verificadas. Es la unidad de "avance". */
export interface Novedad {
  /** La clave del mapa de campos observables, ej. `plan:corpfiling-infra.com.diaN`. */
  clave: string;
  /** El dominio, cuando el campo es de un dominio. `""` para los globales (cap./flota.). */
  objeto: string;
  antes: string | number | null;
  despues: string | number | null;
}

export interface EstadoParaSlack {
  /** El estado del emisor: send | placement-pause | killed | cap-reached | inert. */
  emisor: string | null;
  /** Las acciones que decidió esta vuelta, con si se ejecutaron. */
  /** `reintentable` = falló por algo que se arregla solo (SSH caído, Postgres reiniciando). */
  acciones: Array<{ accion: string; objetivo?: string | null; ejecutada: boolean; reintentable?: boolean; detalle: string }>;
  /** Reparos de la verificación: si los hay, el agente dijo algo que no se sostiene. */
  reparos: string[];
  /** Por qué no hubo lectura, si no la hubo. */
  sinLectura: string | null;
  /** Su voz: la frase con la que hablaría. */
  voz: string | null;
  /** Las cuatro líneas verificadas, por si hay que dar contexto. */
  ahora: string | null;
  /**
   * QUEDA SIN USO EN ESTE MÓDULO desde que se borró la señal de vida (era su única condición).
   * No se saca del contrato a propósito: lo llena el orquestador, que es de otro lote, y un campo
   * de más no rompe nada mientras que sacarlo obliga a tocar un archivo que hoy no se toca.
   */
  riesgo: string | null;
  /**
   * Lo que CAMBIÓ en la fábrica desde la vuelta anterior. Lo calcula el orquestador con
   * `novedades(camposObservables(hechosPrevios), camposObservables(hechosAhora))`. Opcional: sin
   * esto el agente se comporta exactamente como antes (silencio), que es el fail-closed correcto.
   */
  novedades?: readonly Novedad[];
}

export interface MemoriaSlack {
  /** El último estado del emisor sobre el que se habló. */
  ultimoEmisor: string | null;
  /** Cuándo se mandó el último mensaje (ISO). */
  ultimoAviso: string | null;
  /** Hash simple de lo último dicho, para no repetir la misma frase. */
  ultimaFirma: string | null;
  /**
   * Los tres campos del presupuesto de avances. OPCIONALES a propósito: el warmup-slack.json que
   * hay en producción no los tiene, y si fueran obligatorios el primer despliegue leería una
   * memoria "inválida" y el agente se olvidaría del último emisor — o sea, anunciaría un cambio
   * del emisor que no ocurrió, en su primer mensaje.
   */
  avancesHoy?: number;
  /** Día UTC (YYYY-MM-DD) al que corresponde `avancesHoy`. Si no es hoy, el contador vale 0. */
  diaAvances?: string;
  /**
   * Cuándo se habló por última vez de CADA clave (clave → ISO). Es el dedupe de la razón 7.
   *
   * Era un solo slot con identidad `clave=valorNuevo`, y contra un valor que OSCILA nunca coincidía
   * con el anterior: A→B→A→B no deduplica nada. El freno que quedaba era el tope diario, y es el
   * freno equivocado — un flap se come los 10 avances del día y tapa el evento real. Los candidatos
   * no son teóricos: `flota.sanas`/`flota.bloqueadas` van y vienen con el modo de falla "nodo vivo
   * pero incomunicado" ya documentado, y `plan:<d>.accion` cruza PISO_CRITICO=0,35 con solo pasar
   * de 2/6 a 3/6 de muestra. Simulado con `cap.frenados` oscilando 8↔7: 20 mensajes en 24 h.
   * Por clave y con enfriamiento, un flap da 1 mensaje por hora en vez de 1 por vuelta.
   */
  novedadesRecientes?: Record<string, string>;
}

export interface Aviso {
  /** El texto que va a Slack. Corto: una o dos líneas. */
  texto: string;
  /** Por qué se habla. Va al log, no a Slack. */
  motivo: string;
  /** true si necesita que un humano conteste. */
  pideRespuesta: boolean;
  /**
   * Qué se guarda como "esto ya lo dije". Por defecto es la firma del estado; las razones que
   * avisan sobre una CONDICIÓN QUE PERSISTE la etiquetan con su motivo para no pisarse entre sí.
   */
  firma?: string;
  /**
   * La clave del avance que va en este mensaje, sea el mensaje entero (razón 7) o PEGADO al final
   * de otra razón. Lo lee `recordarAviso` para cobrar el presupuesto y para anotar el enfriamiento.
   *
   * Existe porque el avance viaja pegado y la `firma` ya está ocupada por la razón que lo lleva: sin
   * un campo aparte, un SPAM→INBOX que sale pegado a "Hice esto: soltar_dominio" no dejaría rastro
   * y podría volver a salir solo en la vuelta siguiente.
   */
  avance?: string;
}

// Los textos NO empiezan con "Juanes,": la mención <@ID> se agrega afuera (es la que hace sonar
// el móvil) y la voz del modelo ya lo nombra. Con las tres cosas juntas salía "Juanes, hice esto:
// X. Juanes, mirá...", que es como habla un robot, no una persona.

/**
 * Cada cuánto se REPITE un aviso sobre una condición que sigue igual (el modelo caído, una lectura
 * con reparos). Una vez por turno de sueño: ni 48 mensajes idénticos antes del desayuno, ni un
 * silencio eterno sobre algo que sigue roto.
 */
const HORAS_PARA_REPETIR = 6;

function firma(e: EstadoParaSlack): string {
  return [e.emisor, e.acciones.map((a) => `${a.accion}:${a.objetivo ?? ""}:${a.ejecutada}`).join(","), e.sinLectura ? "sin-lectura" : ""].join("|");
}

// ── LOS CAMPOS OBSERVABLES ───────────────────────────────────────────────────────────────────────
//
// El vocabulario compartido: un mapa plano de (clave → valor) sobre el que se hace un diff. Todo
// lo que el agente puede anunciar como avance vive acá adentro y NADA más. La lista es cerrada por
// construcción, no por un filtro: un campo que no está en este mapa NO PUEDE producir novedad,
// pase lo que pase con los hechos.
//
// Por qué cerrada. Son 58 dominios; sin lista, cualquier campo que se menee produce mensaje y en
// una vuelta mala se reconstruyen los ~25 mensajes de la noche del 2026-08-06 con mejor excusa.
// Y la otra mitad de la razón es la lección que este proyecto ya pagó dos veces: un criterio
// escrito en prosa ("avisá cuando algo mejore") el modelo lo devuelve como hallazgo propio, y si
// es falso lo devuelve con seguridad.
//
// EXCLUIDO A PROPÓSITO: `emisor.estado`. Ya lo cubre la razón 5, que además está exenta del
// presupuesto y es la noticia más importante que el agente puede dar. Meterlo acá lo duplicaría y
// encima le comería el cupo diario de avances a un cambio real.

/**
 * El retrato de la fábrica reducido a lo que vale la pena anunciar. Puro.
 *
 * `previos` ES EL RETRATO QUE SE GUARDÓ EN DISCO LA VUELTA PASADA — el valor que devolvió esta
 * misma función y que quien cablea persistió. **No** es `camposObservables(hechosPrevios, {})`.
 * Recalcularlo desde los hechos anteriores lo deja sin el arrastre y devuelve el agujero entero:
 *
 * `hechos.vueltas` sale de una query `LIMIT 8` sobre los ciclos GLOBALES del warmup. Con 6 dominios
 * y ~14 ciclos por día, la fila de un dominio se cae de esa ventana en horas y su clave
 * `placement:` DESAPARECE del retrato. Sin arrastre, cuando vuelve a medir la clave REAPARECE: hoy
 * eso es SILENCIO (`novedades` no cuenta las claves que aparecen), o sea que se pierde el SPAM→INBOX
 * de un dominio que él mismo midió 18 h antes — la mejor noticia que puede dar la fábrica. Medido
 * sobre los 19 ciclos reales del 2026-08-06: 2 de 12 avisos del día son exactamente ese caso
 * (annualfilings-control.com y annualfilings-ops.com). Con el retrato persistido salen bien.
 *
 * Y no alcanza con cablearlo bien una vez: el proceso se reinició 17 veces en 29 h, así que un mapa
 * que solo vive en memoria vuelve a arrancar vacío. Va en disco, en la misma vuelta que los hechos.
 *
 * El segundo parámetro es OBLIGATORIO y sin default para que la decisión sea de quien cablea. `{}`
 * es legítimo (primera vuelta de una instalación nueva) y su precio es silencio, nunca un dato
 * inventado — ver el fail-closed de `novedades`.
 */
export function camposObservables(
  hechos: HechosWarmup | null,
  previos: Record<string, string | number | null>
): Record<string, string | number | null> {
  const m: Record<string, string | number | null> = {};
  // Solo `placement:`. Los demás campos salen del plan y del inventario, que traen SIEMPRE la fila
  // de cada dominio: si una de esas claves falta es porque la lectura se cayó, y arrastrarla haría
  // exactamente lo contrario de lo que queremos — daría por vigente un dato que nadie pudo leer.
  for (const [k, v] of Object.entries(previos ?? {})) if (k.startsWith("placement:")) m[k] = v;
  if (!hechos) return m;

  for (const p of hechos.plan ?? []) {
    m[`plan:${p.dominio}.accion`] = p.accion;
    m[`plan:${p.dominio}.diaN`] = p.diaN;
    // `enPool` sale del CUPO, no de estar en la lista: `decidirCupoDeHoy` deja al dominio en el
    // plan con cupo 0 y acción "frenar" cuando el nodo está frenado en Postfix. O sea que "se
    // soltó" y "dejó de calentar" se leen acá, y no en la desaparición de una fila.
    m[`plan:${p.dominio}.enPool`] = p.cupo > 0 ? "si" : "no";
    // NO SE OBSERVA `placementMuestra`, y es a propósito. Es `placements.length`: un contador
    // MONÓTONO que sube con cada medición (~14/día, el techo del daemon) y que además es el
    // denominador de un avance, no un avance. Estaba en el mapa y en la última posición de la
    // prioridad, así que ganaba la vuelta cada vez que no cambiaba nada más —o sea la mayoría de las
    // vueltas— y se comía el presupuesto diario con "las muestras de placement de X: 3 → 4",
    // dejando tapado el evento real de las 20:00. Medido contra el retrato real de producción: 6 de
    // las 32 claves eran esto.
  }

  // EL PLACEMENT NO ENTRA CORREO POR CORREO: entra la medición MÁS RECIENTE de cada dominio, así
  // que dos INBOX seguidos son el mismo valor y no hablan dos veces. Medido: contar cada correo
  // daba 14 avisos/día (el tope físico del daemon); esto da 8 — y las 8 incluyen el SPAM→INBOX de
  // annualfilings-control.com de las 00:01Z, que es el evento exacto que el jefe se perdió.
  //
  // `placement: null` se SALTEA. Una vuelta sin placement es "todavía no se midió", y no medido no
  // es cero: escribirlo como valor haría que la primera medición real se leyera como un cambio
  // desde un dato que nunca existió.
  const masReciente = new Map<string, number>();
  for (const v of hechos.vueltas ?? []) {
    if (!v.placement) continue;
    const t = Date.parse(v.cuando);
    const cuando = Number.isFinite(t) ? t : 0;
    const previa = masReciente.get(v.dominio);
    if (previa !== undefined && cuando <= previa) continue;
    masReciente.set(v.dominio, cuando);
    m[`placement:${v.dominio}`] = v.placement;
  }

  // `frenados` es opcional en HechosWarmup: si no viene, NO se escribe 0. Un `?? 0` acá diría
  // "cero dominios frenados" sobre un dato que nadie midió, que es la confusión más cara del
  // sistema (el 2026-07-25, 38 nodos cerrados en Gmail con CERO detecciones de blacklist, y
  // alguien leyó ese cero como "está limpio").
  if (hechos.cap && Array.isArray(hechos.cap.frenados)) m["cap.frenados"] = hechos.cap.frenados.length;
  if (hechos.flota) {
    m["flota.sanas"] = hechos.flota.sanas;
    m["flota.bloqueadas"] = hechos.flota.bloqueadas;
  }
  return m;
}

/** Separa la clave en (campo legible, objeto). Los dominios tienen puntos: por eso no se parte por el primero. */
function parteClave(clave: string): { campo: string; objeto: string } {
  // `placement:` no lleva sufijo de campo, y partir por el último punto le comería el TLD
  // ("placement.com" de dominio "corpfiling-infra"). Caso aparte y explícito.
  if (clave.startsWith("placement:")) return { campo: "placement", objeto: clave.slice("placement:".length) };
  const i = clave.indexOf(":");
  if (i < 0) return { campo: clave, objeto: "" };
  const resto = clave.slice(i + 1);
  const j = resto.lastIndexOf(".");
  if (j < 0) return { campo: clave.slice(0, i), objeto: resto };
  return { campo: `${clave.slice(0, i)}.${resto.slice(j + 1)}`, objeto: resto.slice(0, j) };
}

/**
 * Qué cambió entre las dos últimas lecturas. Puro: es un diff de dos mapas, y por eso todo aviso
 * de avance se puede RECALCULAR después desde los snapshots guardados. Un aviso que no se puede
 * reproducir desde el diff es ruido por definición.
 */
export function novedades(
  previos: Record<string, string | number | null>,
  ahora: Record<string, string | number | null>
): Novedad[] {
  // MAPA PREVIO VACÍO = SILENCIO. Es el fail-closed: en una instalación fresca (o si el snapshot
  // anterior no se pudo leer) TODO sería "nuevo" y el agente abriría con treinta avisos.
  if (Object.keys(previos).length === 0) return [];

  const out: Novedad[] = [];
  for (const [clave, despues] of Object.entries(ahora)) {
    // UNA CLAVE QUE APARECE NUNCA ES NOVEDAD. Ninguna, tampoco `placement:`.
    //
    // Aparecer casi siempre significa que la lectura ANTERIOR falló, no que pasó algo: en el
    // orquestador `plan` sale de `planDelDia(...).catch(() => undefined)` y `cap`/`flota` de
    // `readInventoryJson(...).catch(() => null)`, así que un tropiezo borra la sección entera y al
    // volver declararía 24 "avances" de golpe.
    //
    // `placement:` estaba exceptuado —"aparecer ES el evento, la primera medición"— y esa excepción
    // fabricaba mensajes. `hechos.vueltas` es una ventana `LIMIT 8` sobre los ciclos GLOBALES: con 6
    // dominios y ~14 ciclos por día, la fila de un dominio se cae de la ventana en horas, su clave
    // desaparece del retrato, y cuando vuelve a medir se anuncia "sin medir → INBOX" sobre un
    // dominio que él mismo midió 18 h antes. Reproducido sobre los 19 ciclos reales del 2026-08-06:
    // de 12 avisos simulados, 2 eran esto —annualfilings-control.com y annualfilings-ops.com, los
    // dos con SPAM medido esa madrugada— y encima degradaban la MEJOR noticia que da la fábrica
    // (SPAM→INBOX) a una primera medición.
    //
    // El arrastre de `camposObservables(hechos, previos)` tapa el agujero **si y solo si** quien
    // cablea persiste el retrato en vez de recalcularlo. Esta línea es lo que hace que el precio de
    // NO persistirlo sea silencio y no una mentira: sin el retrato guardado el SPAM→INBOX se pierde,
    // con él sale bien, y en ningún caso se afirma un dato que nadie midió. Ausencia de dato no es
    // evidencia de nada — es la misma lección que "no medido" ≠ "cero".
    if (!Object.prototype.hasOwnProperty.call(previos, clave)) continue;
    const antes = previos[clave] ?? null;
    if (antes === despues) continue;
    const { objeto } = parteClave(clave);
    out.push({ clave, objeto, antes, despues: despues ?? null });
  }
  // Una clave que DESAPARECE nunca es novedad, por el mismo motivo simétrico: el modo de falla más
  // probable es que no se pudo leer, y "no lo pude leer" ya tiene su propia razón (la 1).
  return out;
}

// ── EL PRESUPUESTO DE AVANCES ────────────────────────────────────────────────────────────────────

/** Un aviso de avance por vuelta. El resto se cuenta y sale en la misma línea, nunca en silencio. */
const MAX_AVANCES_POR_VUELTA = 1;
/**
 * Tope diario. Sale de la tasa medida (10 avances en 21,6 h sobre 28 snapshots reales) y del techo
 * físico: el daemon no puede pasar de 14 vueltas por día y hay 6 dominios en el pool. En un día
 * normal no tira nada — es un fusible contra la tormenta, no un filtro de lo normal. Va en CÓDIGO
 * y no en config a propósito: un tope de ruido que se puede subir por variable de entorno a las
 * 3am deja de ser un tope.
 */
const MAX_AVANCES_POR_DIA = 10;
/**
 * Cuánto tiene que pasar para volver a hablar de LA MISMA CLAVE, aunque el valor sea otro.
 *
 * El dedupe era por `clave=valorNuevo` y contra un valor que oscila no deduplica nunca: A→B→A→B da
 * un mensaje por vuelta. Simulado con `cap.frenados` yendo 8↔7 cada 10 minutos: 20 mensajes en 24 h,
 * diez de ellos textualmente idénticos. Una hora de enfriamiento lo baja a 1 por hora sin tocar el
 * caso normal —un dominio no cambia de escalón dos veces en una hora— y devuelve el tope diario a
 * su papel de fusible en vez de ser el único freno.
 */
const MINUTOS_ENTRE_AVANCES_MISMA_CLAVE = 60;

/** Orden de importancia. Sale la de más arriba; las demás se cuentan. */
const PRIORIDAD: readonly RegExp[] = [
  /^(cap\.frenados|plan:.+\.enPool)$/, // un dominio que se soltó o dejó de calentar
  /^placement:/,
  /^plan:.+\.accion$/,
  /^plan:.+\.diaN$/,
  /^flota\./
];

/** Dónde cae el correo cuando la noticia es MALA. `OTHER` no entra: es ambiguo y no se sabe leer. */
const PLACEMENT_MALO = new Set(["SPAM", "MISSING"]);

function rango(n: Novedad): number {
  // UNA CAÍDA VA PRIMERO, aunque sea del mismo campo que una mejora. Con el orden por clave sola,
  // un dominio que se cae de INBOX a SPAM competía con `cap.frenados` y PERDÍA: contra el retrato
  // real del 2026-08-06 con seis cambios en una vuelta, salía "los dominios frenados: 8 → 7" y el
  // INBOX→SPAM de corpfiling-infra.com terminaba contado adentro de "Además: 5 cambios menores".
  // Una regresión rotulada como avance y encima tapada es el peor mensaje que puede mandar el canal.
  if (n.clave.startsWith("placement:") && PLACEMENT_MALO.has(String(n.despues))) return -1;
  const i = PRIORIDAD.findIndex((re) => re.test(n.clave));
  return i < 0 ? PRIORIDAD.length : i;
}

const PREFIJO_NOVEDAD = "novedad|";

function diaUTC(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

/**
 * ¿Ya se habló de esta clave hace menos de `MINUTOS_ENTRE_AVANCES_MISMA_CLAVE`?
 *
 * Un reloj ilegible NO enfría: fail-open a propósito, y es la única dirección honesta acá. Un
 * `ahoraISO` que no parsea significa que el sistema está roto de otra forma; callar todos los
 * avances por eso sería reproducir el régimen mudo de la queja 2 por un error de formato.
 */
function enfriando(recientes: Record<string, string> | undefined, clave: string, ahoraISO: string): boolean {
  const t = Date.parse(recientes?.[clave] ?? "");
  const ahora = Date.parse(ahoraISO);
  if (!Number.isFinite(t) || !Number.isFinite(ahora)) return false;
  return ahora - t < MINUTOS_ENTRE_AVANCES_MISMA_CLAVE * 60_000;
}

/**
 * Cuál de los avances sale y cuántos quedan tapados. Se exporta para que el orquestador pueda
 * LOGUEAR los tapados cuando el tope diario se come todo: si no, "no sale" sería "se perdió en
 * silencio", que es justo lo que no queremos poder decir del canal.
 */
export function presupuestoDeAvances(
  novs: readonly Novedad[],
  memoria: MemoriaSlack | null,
  ahoraISO: string
): { elegida: Novedad | null; tapados: number } {
  const dia = diaUTC(ahoraISO);
  const yaHoy = memoria?.diaAvances === dia ? (memoria.avancesHoy ?? 0) : 0;
  // DEDUPE POR CLAVE Y CON ENFRIAMIENTO, no por `clave=valor`. Por construcción el diff contra el
  // snapshot previo no repite; esto cubre las dos formas en que igual repetía: que el snapshot no se
  // haya guardado, y —la cara— un valor que OSCILA, contra el que `clave=valor` nunca coincide con
  // el anterior. La firma vieja (acciones + emisor + sinLectura) tampoco lo cubría: dos vueltas
  // seguidas con la misma novedad dan firmas distintas si cambió cualquier acción.
  const frescas = novs.filter((n) => !enfriando(memoria?.novedadesRecientes, n.clave, ahoraISO));
  if (frescas.length === 0) return { elegida: null, tapados: 0 };
  if (yaHoy >= MAX_AVANCES_POR_DIA) return { elegida: null, tapados: frescas.length };
  const orden = [...frescas].sort((a, b) => rango(a) - rango(b));
  return { elegida: orden[0] ?? null, tapados: Math.max(0, orden.length - MAX_AVANCES_POR_VUELTA) };
}

const ETIQUETA: Record<string, string> = {
  placement: "el placement",
  "plan.accion": "el plan",
  "plan.diaN": "el día de rampa",
  "plan.enPool": "el calentamiento",
  "cap.frenados": "los dominios frenados",
  "flota.sanas": "las bandejas sanas",
  "flota.bloqueadas": "las bandejas bloqueadas"
};

/** `null` se escribe "sin medir", NUNCA 0. No medido y cero no son lo mismo. */
const valorLegible = (v: string | number | null): string => (v === null ? "sin medir" : String(v));

/**
 * LA MISMA VERDAD, DICHA COMO LA DIRÍA UNA PERSONA.
 *
 * El texto de un avance era la tupla cruda: "el placement de opscorpfiling.com: SPAM → INBOX.".
 * Correcto, concreto, imposible de alucinar… y escrito como una línea de log. El reclamo del jefe,
 * textual: "busco que me converse de manera más natural, como una persona real, no como si fuera
 * un bot re técnico que solo habla de cosas que él solo entiende".
 *
 * Lo que NO se hace para arreglarlo, y es deliberado: meter al modelo acá. La razón 7 existe
 * justamente porque los hechos tienen que salir aunque el modelo esté caído — `reunirHechos` corre
 * antes que `pedirLectura`, y la tarde que el jefe se quedó sin noticias fue una tarde con el
 * modelo devolviendo vacío. Una frase generada es una frase que puede no llegar.
 *
 * Así que la naturalidad se escribe UNA vez, acá, por transición. Sigue siendo una plantilla pura
 * sobre la tupla `(campo, objeto, antes, después)`, sigue siendo recalculable desde los dos
 * retratos, y no puede decir nada que la tupla no diga. Lo único que cambia es que se entiende.
 *
 * Y el tono no es cosmético: un SPAM→INBOX es una buena noticia y un INBOX→SPAM es un aviso. La
 * misma plantilla plana para los dos hacía que el jefe tuviera que decodificar cuál era cuál.
 */
function fraseHumana(campo: string, objeto: string, antes: string, despues: string): string {
  const d = objeto || "la flota";

  if (campo === "placement") {
    if (despues === "INBOX" && antes === "SPAM") return `${d} entró en bandeja — venía cayendo en spam.`;
    if (despues === "SPAM" && antes === "INBOX") return `ojo con ${d}: se fue a spam, venía entrando en bandeja.`;
    if (despues === "INBOX") return `${d} está entrando en bandeja${antes === "sin medir" ? " — primera medición" : ""}.`;
    if (despues === "SPAM") return `${d} está cayendo en spam.`;
    // MISSING y OTHER no se disfrazan de nada: son "no llegó" y "no sé dónde cayó".
    if (despues === "MISSING") return `no encontré el correo de ${d} en la semilla: no llegó.`;
    return `el correo de ${d} cayó en ${despues.toLowerCase()}.`;
  }

  if (campo === "plan.accion") {
    if (despues === "subir") return `le subo el volumen a ${d}: viene bien.`;
    if (despues === "bajar") return `le bajo el volumen a ${d}.`;
    if (despues === "frenar") return `freno ${d}.`;
    if (despues === "arrancar") return `arranco con ${d}.`;
    return `${d} se queda como está por ahora.`;
  }

  if (campo === "plan.diaN") {
    return `${d} cumplió el día ${despues} de calentamiento.`;
  }

  if (campo === "plan.enPool") {
    return despues === "sí" || despues === "true"
      ? `${d} volvió a calentar.`
      : `${d} dejó de calentar.`;
  }

  if (campo === "cap.frenados") {
    const n = Number(despues);
    const m = Number(antes);
    if (Number.isFinite(n) && Number.isFinite(m)) {
      return n > m ? `quedaron ${n} dominios frenados (eran ${m}).` : `ya son ${n} los dominios sueltos que estaban frenados (eran ${m}).`;
    }
  }

  if (campo === "flota.sanas") return `las bandejas sanas pasaron de ${antes} a ${despues}.`;
  if (campo === "flota.bloqueadas") return `las bandejas bloqueadas pasaron de ${antes} a ${despues}.`;

  // Sin plantilla propia se cae a la forma vieja: explícita y sin adornos. Preferible a inventar
  // una frase para un campo que nadie pensó todavía.
  return `${ETIQUETA[campo] ?? campo}${objeto ? ` de ${objeto}` : ""}: ${antes} → ${despues}.`;
}

/**
 * ¿Hay algo que valga la pena decir? `null` = silencio, que es la respuesta correcta la mayoría
 * de las veces.
 */
export function decidirSiHablar(
  estado: EstadoParaSlack,
  memoria: MemoriaSlack | null,
  ahoraISO: string
): Aviso | null {
  const mem = memoria ?? { ultimoEmisor: null, ultimoAviso: null, ultimaFirma: null };

  /**
   * ¿Ya dije esto mismo, y hace poco?
   *
   * Las razones 1 y 2 avisan sobre CONDICIONES QUE PERSISTEN —el modelo caído, una lectura que no
   * cuadra— y no miraban la memoria. Corriendo cada 10 minutos, un problema que dura la noche son
   * 48 mensajes idénticos antes del desayuno, y el efecto real no es que moleste: es que entrena
   * al operador a ignorar el canal, justo el canal por el que tiene que llegar lo urgente.
   *
   * Callarse para siempre tampoco sirve: si a las 4am el agente quedó ciego, a las 8 hay que
   * seguir sabiéndolo. Así que se repite, pero cada 6 horas — una vez por turno de sueño, no una
   * cada diez minutos.
   */
  const yaLoDije = (etiqueta: string): boolean => {
    if (mem.ultimaFirma !== `${etiqueta}|${firma(estado)}`) return false;
    if (!mem.ultimoAviso) return false;
    const horas = (Date.parse(ahoraISO) - Date.parse(mem.ultimoAviso)) / 3_600_000;
    return Number.isFinite(horas) && horas < HORAS_PARA_REPETIR;
  };

  /**
   * LA RAZÓN 7, en una función porque hay que llegar a ella por TRES caminos.
   *
   * Es una plantilla pura sobre los hechos: no usa `voz`, no llama a ningún modelo. Y los hechos
   * están frescos aunque el modelo esté caído — `reunirHechos` corre ANTES de `pedirLectura`, y
   * `pedirLectura` devuelve los mismos hechos en todos sus caminos de fallo.
   *
   * Pero las razones 1 y 2 hacían `return null` adentro de su `yaLoDije(...)`, así que con el modelo
   * caído (o con una lectura con reparos) el agente quedaba mudo sobre la FÁBRICA hasta 6 horas
   * seguidas. Es literalmente la tarde del 2026-08-06: "No pude leer el estado" a las 21:00 y a la
   * 01:10 el jefe escribiendo "No me has dicho nada en toda la tarde" — con dos INBOX de
   * annualfilings-control.com en la base en el medio. O sea: el arreglo de la queja 2 se apagaba
   * solo justo en el escenario que originó la queja 2.
   */
  const avanceDeLaFabrica = (): Aviso | null => {
    const { elegida, tapados } = presupuestoDeAvances(estado.novedades ?? [], mem, ahoraISO);
    if (!elegida) return null;
    const { campo, objeto } = parteClave(elegida.clave);
    const antes = valorLegible(elegida.antes);
    const despues = valorLegible(elegida.despues);
    // El sobrante se CUENTA y sale en la misma línea. Nunca se pierde en silencio: un canal donde
    // no se puede saber cuánto se calló no se puede calibrar. Y se llaman "cambios", no "avances":
    // adentro de esa cuenta puede ir una caída a SPAM, y rotular una regresión como avance es
    // fabricar una buena noticia.
    const extra = tapados > 0 ? ` (y ${tapados} ${tapados === 1 ? "cambio menor más" : "cambios menores más"})` : "";
    return {
      texto: `${fraseHumana(campo, objeto, antes, despues)}${extra}`,
      // El motivo va al log y es RECALCULABLE desde los dos snapshots: `novedad plan.diaN
      // corpfiling-infra.com 3→4`. Sin esto no se puede separar ruido de señal con un comando.
      motivo: `novedad ${campo}${objeto ? ` ${objeto}` : ""} ${antes}→${despues}`,
      firma: PREFIJO_NOVEDAD,
      avance: elegida.clave,
      pideRespuesta: false
    };
  };

  /**
   * EL AVANCE VIAJA PEGADO AL MENSAJE QUE YA SALE. Un mensaje por vuelta, cero pérdidas.
   *
   * Las razones 1 y 2 ya devolvían `avanceDeLaFabrica()` cuando se callaban por repetidas, pero las
   * 3, 4 y 5 hacían `return` a secas: si esa vuelta hubo una acción ejecutada, una acción trabada o
   * un cambio de emisor, el SPAM→INBOX no salía. Y el snapshot se pisa en la misma vuelta, así que
   * el diff se consumía: la vuelta siguiente ya no lo veía. Silencio permanente, sin quedar contado
   * ni en `tapados` — literalmente "0 mensajes en un día donde pasaron cosas buenas".
   *
   * El motivo del avance se CONCATENA al del otro aviso porque el log es lo único con lo que se
   * puede separar señal de ruido con un comando, y un avance que sale sin motivo propio no se puede
   * auditar. El cobro del presupuesto va por `avance`, no por `firma`: la firma la necesita la
   * razón que lo lleva para su propio `yaLoDije`.
   */
  const conAvance = (a: Aviso): Aviso => {
    const av = avanceDeLaFabrica();
    if (!av) return a;
    return { ...a, texto: `${a.texto}\n${av.texto}`, motivo: `${a.motivo} +${av.motivo}`, avance: av.avance };
  };

  // 1. NO PUDO MIRAR. Un vigilante ciego tiene que decirlo: es lo único peor que una mala noticia.
  if (estado.sinLectura) {
    // Ya avisado hace menos de 6 h ⇒ no se repite, pero la fábrica se sigue mirando: la razón 7 no
    // depende del modelo, así que un modelo caído no puede ser motivo para callarla.
    if (yaLoDije("sin-lectura")) return avanceDeLaFabrica();
    return {
      texto: `No pude leer el estado: ${estado.sinLectura}. Si sigue así en la próxima vuelta, algo está roto.`,
      motivo: "sin lectura",
      pideRespuesta: false,
      firma: `sin-lectura|${firma(estado)}`
    };
  }

  // 2. DIJO ALGO QUE NO SE SOSTIENE. Se avisa porque, con reparos, el agente NO ejecuta nada: el
  //    operador tiene que saber que quedó mudo de manos, no solo de boca.
  if (estado.reparos.length > 0) {
    // Mismo criterio que la 1: los reparos son del MODELO, y la razón 7 es aritmética sobre los
    // hechos. Callar el SPAM→INBOX de un dominio porque el modelo dijo una tontería es castigar al
    // jefe por un error del agente.
    if (yaLoDije("reparos")) return avanceDeLaFabrica();
    return {
      texto: `Me trabé: dije algo que no cuadra con los datos (${estado.reparos[0]}), así que no toqué nada. Mejor miralo vos.`,
      motivo: "reparos en la verificación",
      pideRespuesta: true,
      firma: `reparos|${firma(estado)}`
    };
  }

  // 3. ACTUÓ. Si tocó la infraestructura, se dice siempre: una mano que se mueve en silencio es
  //    exactamente lo que no queremos de un agente autónomo.
  // Solo lo que TOCÓ la infraestructura. Anotar o cerrar un pendiente es contabilidad interna, no
  // una acción: anunciarla llena el canal de mensajes que parecen respuestas y no vienen a cuento.
  // Visto en vivo: el jefe preguntó "¿seguís calentando las bandejas?" y lo que apareció fue
  // "hice esto: anotar_pendiente p-3-levantar-pausa-emisor", que ni contesta ni le importa a nadie.
  // MIRAR NO ES ACTUAR. La noche del 2026-08-06 el agente mandó ~25 mensajes mientras el operador
  // dormía, y casi todos terminaban en "Hice esto: medir_dominio X, diagnosticar_dominio Y" — o
  // sea, avisando que había ido a mirar. Las manos pasivas no tocan nada: anunciarlas es el mismo
  // ruido que anunciar anotar_pendiente, que ya habíamos sacado por esto mismo.
  //
  // Y el daño no es la molestia: darle más ojos al agente hacía que hablara MÁS, así que cada
  // mejora en su autonomía empeoraba el canal. Se anuncia lo que CAMBIA la infraestructura —
  // frenar, soltar, pausar— y nada más.
  const CONTABLES = new Set([
    "anotar_pendiente",
    "resolver_pendiente",
    "leer_cupo_nodo",
    "diagnosticar_dominio",
    "medir_dominio"
  ]);
  const hizo = estado.acciones.filter((a) => a.ejecutada && !CONTABLES.has(a.accion));
  if (hizo.length > 0) {
    const l = hizo.map((a) => `${a.accion}${a.objetivo ? ` ${a.objetivo}` : ""}`).join(", ");
    return conAvance({ texto: `${estado.voz ?? ""} Hice esto: ${l}.`.trim(), motivo: "ejecutó una acción", pideRespuesta: false });
  }

  // 4. QUISO ACTUAR Y NO PUDO. Es el pedido de decisión: el agente ve algo, no tiene la llave, y
  //    necesita a un humano. Se avisa UNA vez por cosa, no cada 10 minutos (eso ya pasó: 10
  //    mensajes idénticos en 2 horas serían 10 mensajes idénticos en Slack).
  //
  //    DOS EXCLUSIONES, las dos aprendidas en producción el 2026-08-06:
  //
  //    · REINTENTABLE. Un SSH caído, Postgres reiniciándose, un timeout: no hay nada que resolver,
  //      en diez minutos se reintenta y sale. Mientras el operador corría el instalador, Postgres
  //      se recargó doce segundos y el agente le mandó dos "@Juanes ... ECONNREFUSED. ¿Lo resolvés
  //      vos?" — con mención, sonándole el móvil, sobre algo que ya estaba arreglado antes de que
  //      lo leyera.
  //    · MIRAR. Si falla una mano pasiva, el agente simplemente no tiene ese dato esta vuelta.
  //      Eso no es un pedido de decisión: es un turno con menos información.
  //
  //    Lo que SÍ queda: "no está habilitado", "no está en el inventario", "el receptor lo tiene
  //    cerrado". Ahí alguien tiene que decidir o configurar algo, y por eso vale interrumpirlo.
  // Y TAMPOCO ESCALA UN ERROR SUYO. "no es una acción permitida" y "no está en el inventario" son
  // deslices del modelo —un nombre mal escrito, un dominio alucinado—, no decisiones que el jefe
  // pueda tomar. Salió a Slack tal cual: "Quise diagnosticar_dominio_bizregistry-ops.com y no pude.
  // ¿Lo resolvés vos?". No hay nada que resolver del otro lado, y preguntarlo gasta la única señal
  // que sirve para lo que sí lo necesita.
  const errorPropio = (d: string): boolean =>
    /no es una acción permitida|no está en el inventario|toda acción exige un motivo/i.test(d);

  const trabado = estado.acciones.find(
    (a) =>
      !a.ejecutada &&
      !a.reintentable &&
      !errorPropio(a.detalle) &&
      !CONTABLES.has(a.accion) &&
      a.accion !== "(ninguna)" &&
      a.accion !== "(tope)"
  );
  if (trabado && firma(estado) !== mem.ultimaFirma) {
    return conAvance({
      texto: `Quise ${trabado.accion}${trabado.objetivo ? ` ${trabado.objetivo}` : ""} y no pude: ${trabado.detalle}. ¿Lo resolvés vos?`,
      motivo: "acción trabada",
      pideRespuesta: true
    });
  }

  // 5. CAMBIÓ EL ESTADO DEL EMISOR. Que arranque o que se frene es la noticia más importante que
  //    puede dar, y la única que vale por sí sola aunque no haya nada que hacer.
  if (estado.emisor && estado.emisor !== mem.ultimoEmisor) {
    const arrancó = estado.emisor === "send";
    return conAvance({
      texto: arrancó
        ? `El emisor arrancó, ya está mandando. ${estado.voz ?? ""}`.trim()
        : `El emisor se frenó (${estado.emisor}). ${estado.voz ?? estado.ahora ?? ""}`.trim(),
      motivo: `el emisor pasó de ${mem.ultimoEmisor ?? "desconocido"} a ${estado.emisor}`,
      pideRespuesta: false
    });
  }

  // 7. LA FÁBRICA AVANZÓ. Las seis razones de arriba miran al AGENTE; esta es la única que mira la
  //    FÁBRICA, y por eso el arreglo anterior lo pudo dejar mudo sin violar ninguna regla.
  //
  //    El texto es una PLANTILLA con el campo, el objeto y los dos valores. NO lleva la `voz` del
  //    modelo, a diferencia de las razones 3 y 5: la voz es lo que producía "Sigo acá. Ya los estoy
  //    evaluando…" sin un solo dato, y además es por donde se fugan las promesas (9 de 136 líneas
  //    VOZ del monitor prometen volver). Acá se anuncia un número o no se anuncia nada.
  //
  //    `pideRespuesta: false` SIEMPRE: un avance no interrumpe a nadie. La mención es del carril de
  //    "me quedé sin herramientas", y compartirla la devaluaría.
  const avance = avanceDeLaFabrica();
  if (avance) return avance;

  // 8. Nada cambió y no hay nada que hacer: SILENCIO. Es la respuesta correcta casi siempre.
  //
  //    ACÁ VIVÍA LA SEÑAL DE VIDA ("Sigo acá. <voz>" cada 4 h con un riesgo abierto) y se BORRÓ.
  //    Fue 2 de los 3 avisos de las últimas 8 h del régimen mudo y no decía absolutamente nada:
  //    "Sigo acá. Ya los estoy evaluando…". Parece un reporte y no lo es, que es peor que el
  //    silencio — el jefe la leyó como "todo en orden" y a las 01:10 escribió "No me has dicho nada
  //    en toda la tarde". Con la razón 7 cableada queda sin trabajo: si hay algo que decir se dice
  //    con número, y si no lo hay el silencio es honesto.
  return null;
}

/** Actualiza la memoria después de hablar (o de callarse). */
export function recordarAviso(
  estado: EstadoParaSlack,
  hablo: boolean,
  ahoraISO: string,
  memoria: MemoriaSlack | null,
  aviso?: Aviso | null
): MemoriaSlack {
  const mem = memoria ?? { ultimoEmisor: null, ultimoAviso: null, ultimaFirma: null };
  // El emisor se recuerda SIEMPRE, se haya hablado o no: si no, el primer cambio después de un
  // silencio se reportaría contra un estado viejísimo.
  const base = { ...mem, ultimoEmisor: estado.emisor ?? mem.ultimoEmisor };

  // EL AVANCE SE COBRA POR `avance`, NO POR LA FIRMA. Sale por dos caminos —solo (razón 7) o pegado
  // al final de otra razón— y en el segundo la `firma` está ocupada por la razón que lo lleva. Con
  // el cobro atado a la firma, un SPAM→INBOX que viaja pegado a "Hice esto: soltar_dominio" no
  // dejaba rastro: ni contaba en el presupuesto ni entraba al enfriamiento, así que podía volver a
  // salir solo en la vuelta siguiente.
  const cobrado = (() => {
    if (!hablo || !aviso?.avance) return {};
    const dia = diaUTC(ahoraISO);
    return {
      avancesHoy: (base.diaAvances === dia ? (base.avancesHoy ?? 0) : 0) + 1,
      diaAvances: dia,
      // Se PODAN las claves ya frías al escribir. Son 58 dominios × 4 campos: sin la poda el mapa
      // crece hasta ~230 entradas en un JSON que `updateInventoryJson` re-serializa entero bajo
      // lock cada 10 minutos, y las entradas viejas no deciden nada (ya no enfrían).
      novedadesRecientes: {
        ...Object.fromEntries(Object.entries(base.novedadesRecientes ?? {}).filter(([k]) => enfriando(base.novedadesRecientes, k, ahoraISO))),
        [aviso.avance]: ahoraISO
      }
    };
  })();

  // UN AVANCE SOLO NO TOCA EL RELOJ DE LOS PROBLEMAS. Los avisos de la razón 7 llevan su propia
  // memoria (enfriamiento + contador diario) y dejan `ultimoAviso`/`ultimaFirma` intactos. No es
  // prolijidad:
  //  · Si pisaran `ultimaFirma`, la razón 4 volvería a mandar "Quise X y no pude, ¿lo resolvés
  //    vos?" en la vuelta siguiente, porque compara la firma del estado contra la última guardada.
  //    Es literalmente el bug de los 10 mensajes idénticos en 2 horas, reabierto por la puerta de
  //    atrás.
  //  · Si pisaran `ultimoAviso`, un avance cada tanto correría para adelante el reloj de las 6 h y
  //    un problema que persiste (el modelo caído) se dejaría de repetir. El goteo y el olvido son
  //    dos problemas distintos y tienen dos relojes distintos.
  // Un avance PEGADO sí los toca, y tiene que hacerlo: el mensaje que salió es el de la otra razón.
  if (hablo && aviso?.firma?.startsWith(PREFIJO_NOVEDAD)) return { ...base, ...cobrado };

  return {
    ...base,
    ...cobrado,
    ultimoAviso: hablo ? ahoraISO : mem.ultimoAviso,
    // La firma del AVISO manda sobre la del estado: dos razones distintas pueden tener el mismo
    // estado, y guardar solo el estado hacía que una tapara a la otra.
    ultimaFirma: hablo ? (aviso?.firma ?? firma(estado)) : mem.ultimaFirma
  };
}

/** Manda el mensaje. Falla suave: que Slack esté caído no puede tumbar al agente. */
export async function mandarASlack(
  aviso: Aviso,
  cfg: { token?: string; canal?: string; threadTs?: string; fetchImpl?: typeof fetch }
): Promise<{ ok: boolean; motivo: string | null }> {
  if (!cfg.token || !cfg.canal) return { ok: false, motivo: "sin SLACK_BOT_TOKEN o SLACK_CANAL" };
  const doFetch = cfg.fetchImpl ?? fetch;
  try {
    const r = await doFetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      // TIMEOUT. Sin esto un POST colgado deja al agente mudo sin decir por qué, que es el modo de
      // falla más caro que tiene: indistinguible de "no había nada que decir". Es una línea de la
      // stdlib y el catch de abajo ya la convierte en un motivo legible.
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${cfg.token}` },
      // threadTs: contestar DENTRO del hilo. Sin esto cada respuesta abre un mensaje suelto y la
      // conversación queda partida — que es literalmente "el agente se pierde".
      body: JSON.stringify({ channel: cfg.canal, text: aviso.texto, ...(cfg.threadTs ? { thread_ts: cfg.threadTs } : {}) })
    });
    const data = (await r.json()) as { ok?: boolean; error?: string };
    return data.ok ? { ok: true, motivo: null } : { ok: false, motivo: data.error ?? "slack respondió sin ok" };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}

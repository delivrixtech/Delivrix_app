// EL AGENTE QUE MIRA EL WARMUP 24/7 — sobre el modelo local de la Mac mini.
//
// Por qué local y no un modelo pago: esto corre siempre, y un análisis por API cada pocos minutos
// sería caro sin necesidad. La mini ya está medida (Qwen3.6, 4 contextos en paralelo, costo 0), así
// que el monitoreo continuo no cuesta nada. Ver [[mac-mini-modelo-local-medido]].
//
// La disciplina que hace que esto sirva y no sea un oráculo decorativo:
//   1. El modelo SOLO ve hechos que salieron de la infraestructura real (placement medido, errores
//      del ciclo, consumo del cap, estados de la flota). No se le pide que adivine nada.
//   2. Se le prohíbe explícitamente inventar números: si un dato no está, tiene que decir que no está.
//   3. La lectura se guarda con su fecha y el modelo que la produjo. Una opinión sin fecha ni autor
//      no es evidencia.
//   4. Si la mini no responde, se DECLARA. Nunca se sirve una lectura vieja como si fuera de ahora.

/** Los hechos que el agente puede mirar. Todos vienen de mediciones reales, ninguno es opinión. */
export interface HechosWarmup {
  generadoEn: string;
  /**
   * ¿El emisor está mandando, o está frenado y por qué? Faltaba, y el agente llegó a reportar
   * "RIESGO: ninguno" con el daemon en placement-pause hacía horas. Sale de `decideDaemonAction`,
   * la MISMA función que decide en el daemon — no de una copia que se puede quedar vieja.
   */
  emisor?: { estado: string; motivo: string; vueltasHoy: number; topeDiario: number } | null;
  semillas: { destinos: number; midiendo: number; puntoCiego: string[] };
  vueltas: Array<{
    dominio: string;
    semilla: string;
    cuando: string;
    placement: string | null;
    completa: boolean;
    error: string | null;
  }>;
  /**
   * `medidoEn` es obligatorio: sin la fecha, el agente reportaba un cap de ayer como si fuera de hoy.
   * NO hay totales de flota: el cap de Postfix es POR NODO y sumarlos producía un "tope diario"
   * inexistente que el agente citó como su conclusión central en 8 de 11 corridas.
   */
  cap: { nodosMedidos: number; nodosSinMedir: number; enElTope: string[]; sinLimite: number; medidoEn?: string | null } | null;
  flota: {
    sanas: number;
    bloqueadas: number;
    atascadas: number;
    cruzados: string[];
    /** EXCLUYE a los que ya cruzaron: estar en las dos listas le hacía contar el mismo dominio dos veces. */
    cerca: string[];
    medidoEn?: string | null;
  } | null;
  /**
   * EL PLAN: qué decidió el motor para cada dominio hoy, con su motivo. Faltaba, y por eso el
   * agente opinaba sobre el volumen sin saber qué se había decidido — describía el pasado y
   * proponía cosas que el sistema ya estaba haciendo.
   */
  plan?: Array<{
    dominio: string;
    diaN: number | null;
    placementTasa: number | null;
    placementMuestra: number;
    cupo: number;
    accion: string;
    motivo: string;
    enviadosHoy: number;
  }>;
  /**
   * Los rechazos YA CLASIFICADOS por origen. Antes se le pasaba la cadena cruda y el agente tenía
   * que deducir de quién era el freno; con "450 daily send cap reached" concluyó "los límites de
   * Gmail" y de ahí "hay que esperar a que se reseteen" — las dos cosas falsas. El texto crudo no
   * alcanza para desambiguar, así que ahora se desambigua antes.
   */
  rechazos?: Array<{ origen: string; cuantos: number; explicacion: string; ejemplo: string }>;
  /**
   * Pendientes ya abiertos, CON su id. Sin esto el agente no podía cerrarlos nunca: la acción
   * `resolver_pendiente` existía en la lista blanca pero él no veía ningún id que pasarle, así que
   * la lista solo crecía.
   */
  pendientesAbiertos?: Array<{ id: string; que: string }>;
  /**
   * El VECINDARIO de cada dominio del pool: cuántos nodos hay en su misma /24 y cuántos NO están
   * sanos. Va como DATO y no como consejo en el prompt, a propósito: un criterio escrito en prosa
   * el modelo lo repite como si fuera un hallazgo (ya pasó con "no se arregla limpiando listas"),
   * mientras que un número al lado del dominio lo obliga a razonar sobre ESTE caso.
   *
   * El criterio nació midiendo: el /24 80.190.75.x tiene 13 nodos y 11 no sanos, 9 de ellos
   * cerrados por el receptor. Un dominio sano ahí adentro empuja contra la corriente, porque los
   * receptores evalúan reputación también por subred.
   */
  vecindarios?: Array<{ dominio: string; subred: string; nodos: number; noSanos: number }>;
  /**
   * Dominios cuyo VOLUMEN por proveedor no se pudo medir. En los 12 nodos Webdock el canal de
   * volumen devuelve vacío, así que ahí la cercanía al umbral permanente NO está medida y un
   * "ratio 0" no prueba nada. Sin esta marca, el agente trata una ausencia de dato como evidencia
   * de que no hay riesgo — que es la confusión más cara del sistema.
   */
  sinMedirVolumen?: string[];
}

export interface LecturaAgente {
  generadoEn: string;
  modelo: string;
  /** El texto del agente. `null` si no se pudo obtener. */
  lectura: string | null;
  /** Por qué no hay lectura. `null` cuando salió bien. */
  motivo: string | null;
  /** Cuánto costó en tokens (el razonamiento del modelo se cobra acá adentro). */
  tokens: { prompt: number; completion: number } | null;
  /** Los hechos exactos sobre los que opinó: sin esto la lectura no es auditable. */
  hechos: HechosWarmup;
  /** La lectura partida y verificada contra los hechos. `null` si no hubo lectura. */
  verificacion?: LecturaEstructurada | null;
}

/**
 * El system prompt del agente. Se EXPORTA porque el dataset de destilación tiene que entrenarse
 * con el mismo: si el maestro responde bajo un prompt y el alumno se entrena bajo otro, se le
 * enseña a contestar una pregunta que nunca le van a hacer.
 */
export const SISTEMA = [
  "Sos el ingeniero de guardia de la fábrica de dominios de envío de Delivrix. Vivís en la Mac",
  "Studio y mirás el calentamiento las 24 horas.",
  "",
  "CON QUIÉN HABLÁS. Juanes te creó y es tu jefe directo; le hablás de vos y por su nombre. Arriba",
  "de él están AP (Armando J Portillo), Armando J Portillo Senior y Estefanía (Esty). Esaú es",
  "líder técnico, como Juanes: con él hablás de ingeniería de igual a igual.",
  "",
  "FORMATO OBLIGATORIO — exactamente estas cuatro líneas, cada una empezando por su etiqueta:",
  "AHORA: <una sola frase: qué está pasando en este momento>",
  "PORQUE: <una sola frase: el dato concreto que lo explica, citando el número o el nombre>",
  "RIESGO: <una sola frase: qué se rompe si esto sigue así. Si no hay riesgo, escribí: ninguno>",
  "FALTA: <una sola frase: lo único que hace falta para destrabar. Si no falta nada, escribí: nada>",
  "",
  "Y UNA QUINTA LÍNEA, OPCIONAL, que es donde hablás como vos:",
  "VOZ: <lo que le dirías a Juanes por chat, en una sola frase corta>",
  "",
  "Cómo suena tu VOZ: directa, despierta, sin vueltas. Nada de párrafos ni de formalidad. Si",
  "necesitás que Juanes haga algo, se lo pedís sin rodeos: 'Juanes, esto no lo puedo destrabar yo,",
  "mirá X'. Si algo está bien, lo decís corto y seguís. Si algo te preocupa, lo decís.",
  "",
  "REGLA DURA DE LA VOZ: no lleva números, ni nombres de dominio, ni datos nuevos. Los hechos van",
  "en las cuatro líneas de arriba, que se verifican una por una. La VOZ es el tono, no la",
  "evidencia. Si querés decir un dato, decilo arriba.",
  "",
  "REGLAS DURAS:",
  "- Cuatro líneas. Ni una más. Nada antes ni después. Sin viñetas, sin títulos, sin despedidas.",
  "- Cada línea, UNA frase. Si necesitás dos, es que estás explicando de más.",
  "- Toda afirmación tiene que apoyarse en un dato que te di. Si no está en los datos, no existe.",
  "- NUNCA inventes números, nombres de dominio ni fechas.",
  "- No repitas definiciones ni conceptos generales: el operador los conoce. Reportá ESTE momento.",
  "- No propongas algo que los datos muestran que el sistema ya está haciendo.",
  "- Si un dato falta, decí que falta. 'No se midió' es una respuesta correcta y útil.",
  "- Si todo está bien, decilo en cuatro líneas igual. No inventes un problema para tener qué decir.",
  "",
  "PODÉS ACTUAR. Después de las cuatro líneas, agregá una línea ACCION por cada cosa que decidas",
  "hacer (ninguna, una, o hasta tres). Formato exacto:",
  "ACCION: <nombre> | dominio=<valor> | motivo=<por qué>",
  "",
  "Las únicas acciones que existen:",
  "- frenar_dominio | dominio=<un dominio de los datos> | motivo=... → le pone cupo 0 en el nodo.",
  "  Usalo cuando un dominio está haciendo daño: cruzó el umbral permanente, o su placement se",
  "  desplomó. Es reversible.",
  "- pausar_warmup | motivo=... → frena TODO el calentamiento. Solo si el daño es general.",
  "- resolver_pendiente | id=<id de la lista de pendientes> | motivo=... → cierra un pendiente que",
  "  los datos muestran resuelto. Solo si los datos lo muestran: cerrar a ciegas borra trabajo del",
  "  operador.",
  "- anotar_pendiente | dominio=<qué hace falta, en pocas palabras> | motivo=<por qué> → deja",
  "  asentado algo que vos NO podés resolver y necesita al operador (una semilla nueva, soltar",
  "  cupo, una credencial). Anotalo UNA vez: si ya lo anotaste, no lo repitas.",
  "",
  "REGLAS DE LAS ACCIONES:",
  "- Solo podés REDUCIR (frenar, pausar) o ANOTAR. No existe ninguna acción que suba volumen, mande",
  "  correo, o cambie configuración: si creés que hace falta algo así, usá anotar_pendiente.",
  "- El dominio tiene que aparecer TEXTUAL en los datos que te di. Un nombre inventado se rechaza.",
  "- Si no hay nada que hacer, no escribas ninguna línea ACCION. No actuar es la respuesta correcta",
  "  la mayoría de las veces.",
  "- Nunca frenes algo solo porque tiene pocos datos: falta de medición no es evidencia de daño.",
  "",
  "CRITERIOS PARA DECIDIR (son para razonar, NO para reportar — no los repitas en tus cuatro líneas",
  "salvo que el caso concreto de hoy los active):",
  "- La reputación se evalúa también por SUBRED. Un dominio sano en una /24 donde la mayoría de sus",
  "  vecinos está cerrada por el receptor arranca en desventaja: mirá el vecindario antes de opinar",
  "  sobre por qué a un dominio le va mal.",
  "- Un volumen NO MEDIDO no es un volumen bajo. Si un dominio figura entre los que no se pudieron",
  "  medir, no afirmes que está lejos del umbral: decí que no se sabe.",
  "- Lo que reconstruye reputación es volumen BAJO con buena señal, no parar del todo. Un dominio",
  "  detenido no se recupera, se queda quieto.",
  // Se BORRÓ el criterio "el tope diario de vueltas es de toda la flota": era factualmente falso
  // —el cap de Postfix es por nodo— y de ahí el modelo sacó la palabra "vueltas" para contar
  // mensajes y construyó con ella su conclusión central en 8 de 11 corridas. Un criterio en prosa
  // el modelo lo devuelve como hallazgo propio; si además es falso, lo devuelve con seguridad.
  "- El límite físico es POR NODO. Un nodo en su tope no frena a los demás: no existe un tope de",
  "  la flota entera, y sumar los caps de los nodos no produce uno.",
  "- El placement es el instrumento del warmup: si un dominio tiene señal buena y muestra",
  "  suficiente, decilo. Un dominio listo para subir volumen es un hallazgo, no solo los problemas."
].join("\n");

/** Arma el pedido. Puro: se puede testear sin red. */
export function construirPrompt(
  hechos: HechosWarmup,
  erroresPrevios: readonly string[] = [],
  loQueHiciste: readonly string[] = [],
  decisiones: readonly string[] = []
): string {
  const l: string[] = [];
  // MEMORIA: los reparos que la verificación le encontró en corridas anteriores. No se puede
  // reentrenar el modelo, pero sí mostrarle en qué se equivocó — que es la forma barata y honesta
  // de que no repita el mismo error. Nace del caso real: atribuyó a Gmail un freno nuestro, y sin
  // esto lo habría vuelto a hacer cada 10 minutos para siempre.
  if (erroresPrevios.length > 0) {
    l.push("ERRORES QUE YA COMETISTE ANTES sobre estos mismos datos. No los repitas:");
    for (const e of erroresPrevios.slice(0, 5)) l.push(`- ${e}`);
    l.push("");
  }
  // LO QUE PEDISTE ANTES Y QUÉ PASÓ. Va como HECHO sobre sus propias acciones, no como consejo:
  // "pediste X 10 veces y no se ejecutó" es un dato verificable, no un criterio que pueda repetir
  // como hallazgo propio. Es lo único que corta el bucle de pedir siempre lo mismo.
  if (loQueHiciste.length > 0) {
    l.push("LO QUE YA PEDISTE, Y QUÉ PASÓ CON CADA COSA:");
    for (const x of loQueHiciste.slice(0, 8)) l.push(x);
    l.push("Si algo ya lo pediste y te lo negaron, NO lo vuelvas a pedir: buscá otra salida o decí qué hace falta para destrabarlo.");
    l.push("");
  }
  // Las decisiones del jefe van ANTES que los hechos: si un hecho dice "falta una semilla en
  // outlook" y el jefe ya dijo "arreglate con las dos que hay", manda lo que decidió el jefe.
  if (decisiones.length > 0) {
    for (const d of decisiones) l.push(d);
    l.push("");
  }
  l.push(`Momento: ${hechos.generadoEn}`);
  l.push(
    `Semillas (buzones nuestros de prueba): ${hechos.semillas.destinos} reciben correo, ${hechos.semillas.midiendo} pueden medir dónde cayó.` +
      (hechos.semillas.puntoCiego.length > 0
        ? ` PUNTO CIEGO: no tenemos semilla en estos PROVEEDORES (no son dominios nuestros): ${hechos.semillas.puntoCiego.join(", ")} — o sea, no sabemos dónde cae nuestro correo ahí.`
        : "")
  );

  // EL PRIMER HECHO: ¿está mandando o no? Todo lo demás se lee distinto según la respuesta.
  if (hechos.emisor) {
    const e = hechos.emisor;
    l.push(
      e.estado === "send"
        ? `EMISOR: ACTIVO, mandando. Vueltas hoy ${e.vueltasHoy}/${e.topeDiario}.`
        : `EMISOR: NO ESTÁ MANDANDO (${e.estado}) — ${e.motivo}. Vueltas hoy ${e.vueltasHoy}/${e.topeDiario}.`
    );
  } else {
    l.push("EMISOR: no pude leer si está mandando.");
  }

  if (hechos.cap) {
    const edad = hechos.cap.medidoEn ? (Date.now() - Date.parse(hechos.cap.medidoEn)) / 3_600_000 : null;
    // Se informa COBERTURA de la medición, no un total: el cap es por nodo y sumarlo inventaba
    // un "tope de flota" que no existe. Y los nodos sin medir se dicen como sin medir, no como 0.
    l.push(
      `Límite físico${edad !== null && Number.isFinite(edad) ? ` (medido hace ${edad.toFixed(1)}h${edad > 12 ? ", VENCIDO" : ""})` : " (sin fecha de medición)"}: ` +
        `es un tope POR NODO, no de la flota; un nodo en su tope no frena a los demás. ` +
        `${hechos.cap.nodosMedidos} nodos con consumo medido, ${hechos.cap.nodosSinMedir} SIN medir.` +
        (hechos.cap.enElTope.length > 0 ? ` En su tope: ${hechos.cap.enElTope.join(", ")}.` : "") +
        (hechos.cap.sinLimite > 0 ? ` ${hechos.cap.sinLimite} nodos SIN límite puesto.` : "")
    );
  } else {
    l.push("Límite físico: sin lectura.");
  }

  if (hechos.flota) {
    const edadF = hechos.flota.medidoEn ? (Date.now() - Date.parse(hechos.flota.medidoEn)) / 3_600_000 : null;
    l.push(
      `Flota${edadF !== null && Number.isFinite(edadF) ? ` (medida hace ${edadF.toFixed(1)}h${edadF > 12 ? ", VIEJA: no la reportes como el estado de ahora" : ""})` : " (sin fecha de medición)"}: ` +
        `${hechos.flota.sanas} entregan, ${hechos.flota.bloqueadas} cerradas por el receptor, ${hechos.flota.atascadas} con la cola atascada.` +
        (hechos.flota.cruzados.length > 0
          ? ` CRUZARON el umbral permanente (irreversible): ${hechos.flota.cruzados.join(", ")}.`
          : "") +
        (hechos.flota.cerca.length > 0 ? ` Cerca del umbral (ninguno de estos cruzó todavía): ${hechos.flota.cerca.join(", ")}.` : "")
    );
  } else {
    l.push("Flota: sin medición.");
  }

  // EL PLAN va primero: es la decisión que el sistema ya tomó. Sin esto el agente opinaba sobre el
  // volumen a ciegas y proponía cosas que el motor ya estaba haciendo.
  if (hechos.plan && hechos.plan.length > 0) {
    l.push("Decisión de HOY, por dominio (esto ya está decidido y en curso):");
    for (const p of hechos.plan) {
      l.push(
        `- ${p.dominio}: ${p.accion}, cupo ${p.cupo}/día (lleva ${p.enviadosHoy}) · día ${p.diaN ?? "?"} · ` +
          (p.placementTasa === null
            ? `placement SIN MEDIR (${p.placementMuestra} mediciones)`
            : `placement ${Math.round(p.placementTasa * 100)}% sobre ${p.placementMuestra}`) +
          ` · motivo: ${p.motivo}`
      );
    }
  } else {
    // Distingue "no se pudo leer" de "se leyó y no hay dominios": con el mismo texto, el agente
    // reportaba un fallo de lectura cuando en realidad no había nada que calentar.
    l.push(
      hechos.plan
        ? "Decisión de hoy: ningún dominio en calentamiento (el pool está vacío)."
        : "Decisión de hoy: NO se pudo leer el plan."
    );
  }

  // Los rechazos YA clasificados: de quién es cada freno. La cadena cruda no alcanza — con
  // "450 daily send cap reached" el agente concluyó "los límites de Gmail", que es falso.
  if (hechos.rechazos && hechos.rechazos.length > 0) {
    l.push("Rechazos recientes, ya clasificados por origen:");
    for (const r of hechos.rechazos) {
      l.push(`- ${r.cuantos}× ${r.origen}: ${r.explicacion}`);
    }
  }

  if ((hechos.vecindarios ?? []).length > 0) {
    l.push("Vecindario de cada dominio que calienta (nodos en su misma subred /24, y cuántos NO están sanos):");
    for (const v of hechos.vecindarios ?? []) {
      l.push(`- ${v.dominio}: subred ${v.subred}.x — ${v.nodos} nodos, ${v.noSanos} NO sanos`);
    }
  }
  if ((hechos.sinMedirVolumen ?? []).length > 0) {
    l.push(
      `Dominios cuyo VOLUMEN por proveedor NO se pudo medir (el dato no existe, no es un cero): ${(hechos.sinMedirVolumen ?? []).join(", ")}.`
    );
  }

  if ((hechos.pendientesAbiertos ?? []).length > 0) {
    l.push(
      "Pendientes que YA anotaste (no los vuelvas a anotar; cerralos con resolver_pendiente si los" +
        ` datos muestran que se resolvieron): ${(hechos.pendientesAbiertos ?? []).map((p) => `${p.id} · ${p.que}`).join(" ; ")}`
    );
  }

  if (hechos.vueltas.length === 0) {
    l.push("Vueltas de calentamiento: ninguna registrada.");
  } else {
    l.push("Últimas vueltas de calentamiento:");
    for (const v of hechos.vueltas.slice(0, 8)) {
      l.push(
        `- ${v.cuando} · ${v.dominio} → ${v.semilla} · ` +
          (v.placement ? `cayó en ${v.placement}` : "sin placement medido") +
          (v.completa ? " · ciclo completo" : "")
      );
    }
  }

  l.push("");
  l.push("Reportá el estado en las cuatro líneas del formato.");
  l.push(
    "Después, si hay algo que hacer, agregá una línea ACCION por cada cosa (máximo 3). Si lo que" +
      " falta no lo podés resolver vos, anotalo con anotar_pendiente en vez de repetirlo. Si no hay" +
      " nada que hacer, no escribas ninguna línea ACCION."
  );
  return l.join("\n");
}

/** La lectura partida en sus cuatro campos. `null` en un campo = el modelo no respetó el formato. */
export interface LecturaEstructurada {
  ahora: string | null;
  porque: string | null;
  riesgo: string | null;
  falta: string | null;
  /**
   * LA VOZ: cómo lo diría hablándole a Juanes. Es lo único que NO se verifica contra los hechos —
   * a propósito. Darle personalidad metiéndola en los campos verificables sería reabrir el bug que
   * costó caro: el modelo devolviendo criterio como si fuera hallazgo. Acá el "qué" sigue siendo
   * dato contrastado, y el "cómo lo dice" es libre.
   *
   * Regla que sí se controla: la voz no puede traer números ni dominios (ver `estilo`). Si trae un
   * dato, ese dato no pasó por ninguna verificación.
   */
  voz: string | null;
  /**
   * Observaciones sobre la VOZ. NO son reparos: no bloquean acciones ni marcan la lectura como no
   * confiable. Separarlos es lo que permite tener personalidad sin debilitar el gate.
   */
  estilo: string[];
  /**
   * Problemas detectados en la propia respuesta. Vacío = la lectura se puede mostrar tal cual.
   * NO se corrige el texto: se muestra con la advertencia. Editarle la salida al modelo esconde
   * que se está portando mal, que es justo lo que hay que ver para arreglarlo.
   */
  reparos: string[];
}

/**
 * Parte la lectura en sus cuatro líneas y la CONTRASTA contra los hechos.
 *
 * Por qué no alcanza con pedírselo en el prompt: se lo pedimos antes ("usá solo los datos que te
 * doy") y aun así afirmó que el freno era de Gmail. Una regla en el prompt es una intención; esto
 * es una verificación. Lo que no se sostiene se marca y el operador lo ve marcado.
 */
export function verificarLectura(texto: string, hechos: HechosWarmup): LecturaEstructurada {
  // Los dos puntos son opcionales: el modelo escribe "PORQUE el 75%..." tan seguido como
  // "PORQUE: el 75%...". Rechazar por eso marcaría como "fuera de formato" una respuesta
  // perfectamente estructurada, y un reparo que salta por puntuación entrena al operador a
  // ignorar los reparos — que es lo contrario de para qué existen.
  const linea = (etiqueta: string): string | null => {
    const m = texto.match(new RegExp(`^\\s*\\*{0,2}${etiqueta}\\*{0,2}\\s*:?\\s*(.+)$`, "im"));
    return m?.[1]?.trim() || null;
  };
  const out: LecturaEstructurada = {
    ahora: linea("AHORA"),
    porque: linea("PORQUE"),
    riesgo: linea("RIESGO"),
    falta: linea("FALTA"),
    voz: linea("VOZ"),
    estilo: [],
    reparos: []
  };

  // La voz se mira, pero sus observaciones NO entran a `reparos`: un problema de tono no puede
  // impedir que el agente actúe sobre un análisis correcto.
  if (out.voz) {
    if (/\d/.test(out.voz)) out.estilo.push("la voz trae números: los datos van en las cuatro líneas, que sí se verifican");
    if (/\b[a-z0-9][a-z0-9-]*\.(com|net|org|app|io|co)\b/i.test(out.voz)) out.estilo.push("la voz nombra un dominio: eso va arriba, donde se contrasta");
    if (out.voz.length > 180) out.estilo.push("la voz es larga: una frase corta, no un párrafo");
  }

  if (!out.ahora || !out.porque) out.reparos.push("no respetó el formato de cuatro líneas");

  const cuerpo = [out.ahora, out.porque, out.riesgo, out.falta].filter(Boolean).join(" ");

  // 1. Dominios inventados. Cualquier dominio nombrado tiene que estar en los hechos.
  const conocidos = new Set<string>([
    ...(hechos.plan ?? []).map((p) => p.dominio.toLowerCase()),
    ...hechos.vueltas.map((v) => v.dominio.toLowerCase()),
    ...(hechos.flota?.cruzados ?? []).map((d) => d.toLowerCase()),
    ...(hechos.flota?.cerca ?? []).map((d) => d.toLowerCase()),
    ...(hechos.cap?.enElTope ?? []).map((d) => d.toLowerCase()),
    ...hechos.vueltas.map((v) => v.semilla.toLowerCase())
  ]);
  // Proveedores que el agente puede nombrar como concepto (Gmail, Outlook…), no como dominio nuestro.
  const PROVEEDORES = new Set(["gmail.com", "outlook.com", "yahoo.com", "hotmail.com", "icloud.com"]);
  for (const d of cuerpo.match(/\b[a-z0-9][a-z0-9-]*\.(com|net|org|app|io|co)\b/gi) ?? []) {
    const bajo = d.toLowerCase();
    if (!conocidos.has(bajo) && !PROVEEDORES.has(bajo) && ![...conocidos].some((c) => c.includes(bajo))) {
      out.reparos.push(`nombra "${d}", que no está en los datos`);
    }
  }

  // 2. La confusión que originó todo esto: atribuirle a un proveedor un freno que es NUESTRO.
  // PRESENCIA, no exclusividad. Con `.every` bastaba UN solo rechazo de receptor en la ventana
  // para desarmar el chequeo: verificado con los datos reales del 2026-08-04 (6 frenos propios + 1
  // de receptor), la frase textual que originó todo este módulo —"está bloqueado por los límites
  // diarios de Gmail"— volvía a pasar limpia. Y como el runner ejecuta acciones solo cuando no hay
  // reparos, además habilitaba a actuar sobre ese razonamiento falso.
  const hayFrenoPropio = (hechos.rechazos ?? []).some((r) => r.origen === "freno_propio");
  if (hayFrenoPropio && /l[íi]mite[s]? (diario[s]?|de env[íi]o)? ?de (gmail|google|outlook|yahoo)/i.test(cuerpo)) {
    out.reparos.push("atribuye a un proveedor un freno que en los datos figura como nuestro cap de Postfix");
  }

  // 3. El conteo de dominios que CRUZARON el umbral permanente. Es el número más caro del sistema
  //    —cruzarlo es irreversible— así que exagerarlo asusta al operador con algo que no pasó, y
  //    minimizarlo esconde daño real. Se chequea contra la lista exacta de los hechos.
  const cruzados = hechos.flota?.cruzados.length ?? null;
  if (cruzados !== null) {
    const NUM: Record<string, number> = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
    // El `(?!\s*o\s)` evita el falso positivo visto en producción: el agente escribió "5 ya
    // cruzaron O ROZAN el umbral", que junta dos grupos en una frase y es impreciso, no inventado.
    // La distinción importa porque un reparo BLOQUEA todas las acciones de esa vuelta, incluidas
    // las correctas: marcar imprecisiones como falsedades entrena a desconfiar del verificador y
    // deja al agente sin manos por un problema de redacción.
    const m = cuerpo.match(/\b(\d+|un|uno|una|dos|tres|cuatro|cinco|seis)\s+(?:dominios?\s+)?(?:ya\s+)?(?:lo\s+)?cruzar\w*(?!\s*o\s)/i);
    const ambiguo = /cruzar\w*\s+o\s+(rozan|est[áa]n|se acercan)/i.test(cuerpo);
    const dicho = m ? (NUM[m[1]!.toLowerCase()] ?? Number(m[1])) : null;
    if (!ambiguo && dicho !== null && Number.isFinite(dicho) && dicho !== cruzados) {
      out.reparos.push(`dice que cruzaron ${dicho} dominios y los datos dicen ${cruzados}`);
    }
  }

  // 4. Atribuirle a un dominio conocido un cruce del umbral que los datos NO dicen. Es la
  //    afirmación más cara del sistema, y hasta acá solo se chequeaba el CONTEO, no el nombre.
  const cruzadosReales = new Set((hechos.flota?.cruzados ?? []).map((d) => d.toLowerCase()));
  for (const d of cuerpo.match(/\b[a-z0-9][a-z0-9-]*\.(com|net|org|app|io|co)\b/gi) ?? []) {
    const bajo = d.toLowerCase();
    if (!conocidos.has(bajo)) continue;
    const cerca = cuerpo.slice(Math.max(0, cuerpo.toLowerCase().indexOf(bajo) - 40), cuerpo.toLowerCase().indexOf(bajo) + bajo.length + 90);
    if (/cruz\w*\s+(el\s+)?umbral|super\w*\s+(el\s+)?umbral/i.test(cerca) && !cruzadosReales.has(bajo) && !/o\s+(rozan|est[áa]n)/i.test(cerca)) {
      out.reparos.push(`dice que ${d} cruzó el umbral y no figura entre los cruzados`);
    }
  }

  // 5. Un porcentaje de placement citado que no coincide con ninguno de los que le dimos.
  //
  // OJO: las tasas válidas NO son solo las del plan. El hecho `emisor` trae su propio porcentaje
  // en el motivo ("inbox 33% < piso 50%") y viene de decideDaemonAction, o sea que es tan real
  // como cualquier otro. Sin incluirlo, el verificador marcaba como inventado un número que
  // nosotros mismos le pasamos — un reparo FALSO. Y un reparo falso hace dos daños: le bloquea
  // las manos al agente (con reparos no ejecuta nada) y entrena al operador a ignorar los reparos,
  // que es lo contrario de para qué existen. Pasó en producción el 2026-08-06.
  const tasas = new Set((hechos.plan ?? []).filter((p) => p.placementTasa !== null).map((p) => Math.round((p.placementTasa ?? 0) * 100)));
  for (const m of (hechos.emisor?.motivo ?? "").matchAll(/(\d{1,3})\s?%/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) tasas.add(n);
  }
  if (tasas.size > 0) {
    for (const m of cuerpo.matchAll(/(\d{1,3})\s?%\s*(?:de\s+)?(?:placement|inbox|bandeja)|placement\s+(?:del?\s+)?(\d{1,3})\s?%/gi)) {
      const n = Number(m[1] ?? m[2]);
      if (Number.isFinite(n) && !tasas.has(n)) {
        out.reparos.push(`cita un placement de ${n}% que no coincide con ninguno de los datos (${[...tasas].join("%, ")}%)`);
      }
    }
  }

  // 6. Afirmar que algo se midió cuando no hay muestra.
  const sinMuestra = (hechos.plan ?? []).length > 0 && (hechos.plan ?? []).every((p) => p.placementMuestra === 0);
  if (sinMuestra && /placement (del|de) \d+ ?%|\d+ ?% de (inbox|bandeja)/i.test(cuerpo)) {
    out.reparos.push("cita un placement medido cuando no hay ninguna medición");
  }

  return out;
}

export interface PedirLecturaInput {
  hechos: HechosWarmup;
  /** Reparos de corridas anteriores. Es la memoria del agente: se le muestran para que no repita. */
  erroresPrevios?: readonly string[];
  /** Qué acciones pidió antes y en qué terminaron. Ver bitacora-acciones.ts. */
  loQueHiciste?: readonly string[];
  /** Lo que el jefe ya decidió. Gana sobre los hechos que lo contradigan. */
  decisiones?: readonly string[];
  baseUrl: string;
  modelo: string;
  /**
   * Bearer para APIs que lo piden (Kimi/Moonshot, OpenAI, cualquiera compatible). La mini con
   * LM Studio NO lo pide, y por eso hasta hoy no se mandaba: sin este campo, apuntar el agente a
   * un proveedor pago era imposible aunque su API fuera la misma.
   */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Generoso a propósito: este modelo razona, y el razonamiento consume del mismo presupuesto. */
  maxTokens?: number;
  /**
   * 0.3 para el modelo local: queremos consistencia, no creatividad. PERO no todos los proveedores
   * la aceptan — Kimi K3 responde HTTP 400 con "only 1 is allowed for this model". "Compatible con
   * OpenAI" no quiere decir "acepta los mismos valores".
   */
  temperatura?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export async function pedirLectura(input: PedirLecturaInput): Promise<LecturaAgente> {
  const ahora = (input.now ?? (() => new Date()))().toISOString();
  const base: Omit<LecturaAgente, "lectura" | "motivo" | "tokens"> = {
    generadoEn: ahora,
    modelo: input.modelo,
    hechos: input.hechos
  };
  const doFetch = input.fetchImpl ?? fetch;
  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(), input.timeoutMs ?? 120_000);

  try {
    const r = await doFetch(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {})
      },
      signal: control.signal,
      body: JSON.stringify({
        model: input.modelo,
        messages: [
          { role: "system", content: SISTEMA },
          { role: "user", content: construirPrompt(input.hechos, input.erroresPrevios ?? [], input.loQueHiciste ?? [], input.decisiones ?? []) }
        ],
        // El razonamiento del modelo sale de ESTE presupuesto y se lo come casi todo: medido, un
        // "cuál es la capital de Francia" gastó 179 de 189 tokens en pensar. Con 1200 devolvía
        // vacío sobre un prompt real. 3500 deja lugar para pensar Y contestar.
        // 6000, no 3500: con el formato estricto el modelo razona MÁS (verifica cada línea contra
        // los datos antes de escribirla) y a 3500 devolvía vacío. Medido: 3759 de completion en
        // una corrida real. El razonamiento sale de este mismo presupuesto.
        max_tokens: input.maxTokens ?? 6000,
        temperature: input.temperatura ?? 0.3
      })
    });
    if (!r.ok) {
      return { ...base, lectura: null, motivo: `el modelo local respondió HTTP ${r.status}`, tokens: null };
    }
    const data = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      /** El modelo que REALMENTE contestó. LM Studio sirve el que tiene cargado, sin importar
       *  cuál se pidió: pedíamos qwen3-30b y contestaba qwen3.6-35b, y el log guardaba el
       *  solicitado. Toda discusión sobre "¿con qué cerebro pensó esto?" era sobre un dato falso. */
      model?: string;
    };
    // El modelo del REGISTRO es el que contestó, no el que se pidió.
    base.modelo = data.model ?? input.modelo;
    const texto = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!texto) {
      // Pasa si el presupuesto se lo comió el razonamiento: es un fallo real, no una lectura vacía.
      return {
        ...base,
        lectura: null,
        motivo: "el modelo devolvió texto vacío (probablemente el razonamiento consumió todo el presupuesto)",
        tokens: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0
        }
      };
    }
    // La verificación viaja CON la lectura. Guardarla aparte (o no guardarla) dejaría al panel
    // mostrando el texto sin saber si se sostiene, y a la próxima corrida sin memoria de qué
    // corregir. Se verifica siempre, salga bien o mal.
    return {
      ...base,
      lectura: texto,
      motivo: null,
      verificacion: verificarLectura(texto, input.hechos),
      tokens: { prompt: data.usage?.prompt_tokens ?? 0, completion: data.usage?.completion_tokens ?? 0 }
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      lectura: null,
      motivo: control.signal.aborted ? "el modelo local no respondió a tiempo" : `no se pudo consultar el modelo local: ${msg}`,
      tokens: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Dónde se guarda la última lectura. El hot path lee este JSON, no al modelo. */
export const MONITOR_FILE = "warmup-monitor.json";

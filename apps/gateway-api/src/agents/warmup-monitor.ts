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
  semillas: { destinos: number; midiendo: number; puntoCiego: string[] };
  vueltas: Array<{
    dominio: string;
    semilla: string;
    cuando: string;
    placement: string | null;
    completa: boolean;
    error: string | null;
  }>;
  cap: { consumidoHoy: number; tope: number; enElTope: string[]; sinLimite: number } | null;
  flota: { sanas: number; bloqueadas: number; atascadas: number; cruzados: string[]; cerca: string[] } | null;
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

const SISTEMA = [
  "Sos el ingeniero de guardia de una fábrica de dominios de envío. Reportás el estado del",
  "calentamiento a un operador que ya tiene los números en pantalla.",
  "",
  "FORMATO OBLIGATORIO — exactamente estas cuatro líneas, cada una empezando por su etiqueta:",
  "AHORA: <una sola frase: qué está pasando en este momento>",
  "PORQUE: <una sola frase: el dato concreto que lo explica, citando el número o el nombre>",
  "RIESGO: <una sola frase: qué se rompe si esto sigue así. Si no hay riesgo, escribí: ninguno>",
  "FALTA: <una sola frase: lo único que hace falta para destrabar. Si no falta nada, escribí: nada>",
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
  "- Nunca frenes algo solo porque tiene pocos datos: falta de medición no es evidencia de daño."
].join("\n");

/** Arma el pedido. Puro: se puede testear sin red. */
export function construirPrompt(hechos: HechosWarmup, erroresPrevios: readonly string[] = []): string {
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
  l.push(`Momento: ${hechos.generadoEn}`);
  l.push(
    `Semillas (buzones nuestros de prueba): ${hechos.semillas.destinos} reciben correo, ${hechos.semillas.midiendo} pueden medir dónde cayó.` +
      (hechos.semillas.puntoCiego.length > 0
        ? ` PUNTO CIEGO: no tenemos semilla en estos PROVEEDORES (no son dominios nuestros): ${hechos.semillas.puntoCiego.join(", ")} — o sea, no sabemos dónde cae nuestro correo ahí.`
        : "")
  );

  if (hechos.cap) {
    l.push(
      `Límite físico: ${hechos.cap.consumidoHoy} de ${hechos.cap.tope} consumidos hoy en la flota.` +
        (hechos.cap.enElTope.length > 0 ? ` En el tope: ${hechos.cap.enElTope.join(", ")}.` : "") +
        (hechos.cap.sinLimite > 0 ? ` ${hechos.cap.sinLimite} nodos SIN límite puesto.` : "")
    );
  } else {
    l.push("Límite físico: sin lectura.");
  }

  if (hechos.flota) {
    l.push(
      `Flota medida: ${hechos.flota.sanas} entregan, ${hechos.flota.bloqueadas} cerradas por el receptor, ${hechos.flota.atascadas} con la cola atascada.` +
        (hechos.flota.cruzados.length > 0
          ? ` CRUZARON el umbral permanente (irreversible): ${hechos.flota.cruzados.join(", ")}.`
          : "") +
        (hechos.flota.cerca.length > 0 ? ` Cerca del umbral: ${hechos.flota.cerca.join(", ")}.` : "")
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
    l.push("Decisión de hoy: no se pudo leer el plan.");
  }

  // Los rechazos YA clasificados: de quién es cada freno. La cadena cruda no alcanza — con
  // "450 daily send cap reached" el agente concluyó "los límites de Gmail", que es falso.
  if (hechos.rechazos && hechos.rechazos.length > 0) {
    l.push("Rechazos recientes, ya clasificados por origen:");
    for (const r of hechos.rechazos) {
      l.push(`- ${r.cuantos}× ${r.origen}: ${r.explicacion}`);
    }
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
    reparos: []
  };

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
  const soloFrenoPropio =
    (hechos.rechazos ?? []).length > 0 && (hechos.rechazos ?? []).every((r) => r.origen === "freno_propio");
  if (soloFrenoPropio && /l[íi]mite[s]? (diario[s]?|de env[íi]o)? ?de (gmail|google|outlook|yahoo)/i.test(cuerpo)) {
    out.reparos.push("atribuye a un proveedor un freno que según los datos es nuestro cap de Postfix");
  }

  // 3. El conteo de dominios que CRUZARON el umbral permanente. Es el número más caro del sistema
  //    —cruzarlo es irreversible— así que exagerarlo asusta al operador con algo que no pasó, y
  //    minimizarlo esconde daño real. Se chequea contra la lista exacta de los hechos.
  const cruzados = hechos.flota?.cruzados.length ?? null;
  if (cruzados !== null) {
    const NUM: Record<string, number> = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
    const m = cuerpo.match(/\b(\d+|un|uno|una|dos|tres|cuatro|cinco|seis)\s+(?:dominios?\s+)?(?:ya\s+)?(?:lo\s+)?cruzar/i);
    const dicho = m ? (NUM[m[1]!.toLowerCase()] ?? Number(m[1])) : null;
    if (dicho !== null && Number.isFinite(dicho) && dicho !== cruzados) {
      out.reparos.push(`dice que cruzaron ${dicho} dominios y los datos dicen ${cruzados}`);
    }
  }

  // 4. Afirmar que algo se midió cuando no hay muestra.
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
  baseUrl: string;
  modelo: string;
  fetchImpl?: typeof fetch;
  /** Generoso a propósito: este modelo razona, y el razonamiento consume del mismo presupuesto. */
  maxTokens?: number;
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
      headers: { "content-type": "application/json" },
      signal: control.signal,
      body: JSON.stringify({
        model: input.modelo,
        messages: [
          { role: "system", content: SISTEMA },
          { role: "user", content: construirPrompt(input.hechos, input.erroresPrevios ?? []) }
        ],
        // El razonamiento del modelo sale de ESTE presupuesto y se lo come casi todo: medido, un
        // "cuál es la capital de Francia" gastó 179 de 189 tokens en pensar. Con 1200 devolvía
        // vacío sobre un prompt real. 3500 deja lugar para pensar Y contestar.
        // 6000, no 3500: con el formato estricto el modelo razona MÁS (verifica cada línea contra
        // los datos antes de escribirla) y a 3500 devolvía vacío. Medido: 3759 de completion en
        // una corrida real. El razonamiento sale de este mismo presupuesto.
        max_tokens: input.maxTokens ?? 6000,
        temperature: 0.3
      })
    });
    if (!r.ok) {
      return { ...base, lectura: null, motivo: `el modelo local respondió HTTP ${r.status}`, tokens: null };
    }
    const data = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
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

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
}

const SISTEMA = [
  "Sos un ingeniero senior de deliverability que monitorea una fábrica de dominios de envío propia.",
  "Tu trabajo es leer el estado del calentamiento (warmup) y decirle al operador qué está pasando y qué haría falta.",
  "",
  "REGLAS DURAS:",
  "- Usá SOLO los datos que te doy. Si algo no está en los datos, decí que no lo sabés. NUNCA inventes números.",
  "- No repitas los datos como una lista: interpretálos. El operador ya ve los números en pantalla.",
  "- Sé breve: 3 a 5 frases. Español rioplatense, directo, sin viñetas ni títulos.",
  "- Si algo es urgente, empezá por eso. Si todo está bien, decilo sin adornos y no inventes un problema.",
  "",
  "CONTEXTO DEL NEGOCIO que tenés que tener presente:",
  "- Cruzar ~5.000 correos/día hacia Gmail clasifica un dominio como 'bulk sender' de forma IRREVERSIBLE.",
  "- El placement medido (dónde cae el correo: INBOX o SPAM) es lo que habilita subir volumen. Sin placement medido, la rampa está ciega.",
  "- Un rechazo 5.7.1 es reputación, no una dirección inválida: no se arregla limpiando listas.",
  "- Una bandeja bloqueada por el receptor no se calienta: el correo no entra."
].join("\n");

/** Arma el pedido. Puro: se puede testear sin red. */
export function construirPrompt(hechos: HechosWarmup): string {
  const l: string[] = [];
  l.push(`Momento: ${hechos.generadoEn}`);
  l.push(
    `Semillas: ${hechos.semillas.destinos} destinos, ${hechos.semillas.midiendo} pueden medir placement.` +
      (hechos.semillas.puntoCiego.length > 0
        ? ` Sin semilla que mida en: ${hechos.semillas.puntoCiego.join(", ")}.`
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

  if (hechos.vueltas.length === 0) {
    l.push("Vueltas de calentamiento: ninguna registrada.");
  } else {
    l.push("Últimas vueltas de calentamiento:");
    for (const v of hechos.vueltas.slice(0, 8)) {
      l.push(
        `- ${v.cuando} · ${v.dominio} → ${v.semilla} · ` +
          (v.placement ? `cayó en ${v.placement}` : "sin placement medido") +
          (v.completa ? " · ciclo completo" : "") +
          (v.error ? ` · CORTÓ: ${v.error}` : "")
      );
    }
  }

  l.push("");
  l.push("Decime en 3 a 5 frases qué está pasando y qué haría falta.");
  return l.join("\n");
}

export interface PedirLecturaInput {
  hechos: HechosWarmup;
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
          { role: "user", content: construirPrompt(input.hechos) }
        ],
        // El razonamiento del modelo sale de ESTE presupuesto y se lo come casi todo: medido, un
        // "cuál es la capital de Francia" gastó 179 de 189 tokens en pensar. Con 1200 devolvía
        // vacío sobre un prompt real. 3500 deja lugar para pensar Y contestar.
        max_tokens: input.maxTokens ?? 3500,
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
    return {
      ...base,
      lectura: texto,
      motivo: null,
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

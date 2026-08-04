// CONTINUAR LA CONVERSACIÓN — el turno que faltaba para que el calentamiento sea una charla y no
// un correo suelto.
//
// El problema que resuelve, en las palabras del operador: "pasaron 43 minutos desde el envío y el
// recibimiento, y no pasa nada más". Era cierto. El ciclo era: mandamos → la semilla contesta →
// FIN. Dos mensajes y el hilo moría, aunque la respuesta estuviera esperando en el buzón del nodo.
//
// Un hilo de dos mensajes vale poco como señal. Lo que le enseña a un proveedor que un remitente es
// legítimo es una CONVERSACIÓN: idas y vueltas, con tiempos humanos y contenido que se refiere a lo
// anterior. Eso no se puede hacer con un banco de plantillas — se nota, y un texto repetido entre
// dominios ES una huella.
//
// Por eso el turno lo escribe el modelo LOCAL leyendo el hilo real. Costo cero, y cada respuesta es
// distinta porque nace de una conversación distinta.

/** Un mensaje del hilo, como lo vemos nosotros. */
export interface TurnoHilo {
  /** "nosotros" = lo mandó nuestro dominio · "ellos" = lo contestó la semilla. */
  quien: "nosotros" | "ellos";
  texto: string;
}

export interface SiguienteTurno {
  /** El texto a enviar. `null` si no corresponde escribir ahora. */
  texto: string | null;
  /** Por qué. Siempre presente: una decisión de enviar (o no) sin motivo no se puede auditar. */
  motivo: string;
}

/**
 * Cuánto esperar antes de contestar. Un ida y vuelta instantáneo no parece humano, y el patrón
 * "responde siempre a los 30 segundos" es tan reconocible como un texto repetido.
 *
 * Determinista sobre el hilo (no azar) para que una corrida sea reproducible: mismo hilo, misma
 * espera. Entre 12 y 90 minutos.
 */
export function esperaAntesDeResponder(hiloId: string, turno: number): number {
  let h = 0;
  for (const c of `${hiloId}:${turno}`) h = (h * 31 + c.charCodeAt(0)) % 100_000;
  const minutos = 12 + (h % 79);
  return minutos * 60_000;
}

/** Tope de turnos por hilo. Una charla que no termina nunca tampoco parece humana. */
export const MAX_TURNOS = 6;

/**
 * ¿Toca escribir? Decide sin llamar al modelo — así el chequeo es barato y se puede correr seguido.
 *
 * Reglas:
 *  - Solo se contesta si el último mensaje es de ELLOS. Si el último es nuestro, estamos esperando.
 *  - Se respeta la espera humana.
 *  - Se corta al llegar al tope de turnos.
 */
export function tocaResponder(input: {
  hiloId: string;
  turnos: readonly TurnoHilo[];
  ultimoMensajeEn: string;
  ahora?: Date;
}): { si: boolean; motivo: string; esperaRestanteMs?: number } {
  const { turnos } = input;
  if (turnos.length === 0) return { si: false, motivo: "el hilo está vacío" };
  if (turnos.length >= MAX_TURNOS) {
    return { si: false, motivo: `el hilo llegó al tope de ${MAX_TURNOS} turnos: se deja morir natural` };
  }
  if (turnos[turnos.length - 1]!.quien !== "ellos") {
    return { si: false, motivo: "el último mensaje es nuestro: estamos esperando respuesta" };
  }

  const ahora = (input.ahora ?? new Date()).getTime();
  const desde = Date.parse(input.ultimoMensajeEn);
  if (!Number.isFinite(desde)) return { si: false, motivo: "no se pudo leer la fecha del último mensaje" };

  const espera = esperaAntesDeResponder(input.hiloId, turnos.length);
  const transcurrido = ahora - desde;
  if (transcurrido < espera) {
    return {
      si: false,
      motivo: `esperando el tiempo humano (${Math.round((espera - transcurrido) / 60_000)} min restantes)`,
      esperaRestanteMs: espera - transcurrido
    };
  }
  return { si: true, motivo: `contestan hace ${Math.round(transcurrido / 60_000)} min y toca responder` };
}

const SISTEMA = [
  "Escribís el siguiente mensaje de una conversación cotidiana por correo entre dos personas que se conocen.",
  "",
  "REGLAS:",
  "- Contestá SOLO lo que sigue naturalmente de lo anterior. Nada de saludos formales ni firmas.",
  "- Español rioplatense, tono casual, como se le escribe a un conocido.",
  "- Entre 1 y 3 oraciones. Corto.",
  "- Si la conversación ya se cerró sola (alguien se despidió o quedó todo resuelto), respondé exactamente: FIN",
  "- No menciones correo, warmup, pruebas, sistemas ni nada técnico. Es una charla común.",
  "- No inventes datos concretos (fechas exactas, montos, nombres) que no estén en el hilo."
].join("\n");

export interface PedirTurnoInput {
  turnos: readonly TurnoHilo[];
  asunto: string;
  baseUrl: string;
  modelo: string;
  fetchImpl?: typeof fetch;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Le pide al modelo local el siguiente mensaje del hilo.
 *
 * Devuelve `texto: null` con motivo cuando no hay que escribir — incluido el caso en que el propio
 * modelo dice FIN porque la charla se cerró. Nunca inventa un mensaje si algo falló: un correo
 * enviado por error es peor que un turno perdido.
 */
export async function pedirSiguienteTurno(input: PedirTurnoInput): Promise<SiguienteTurno> {
  const conversacion = input.turnos
    .map((t) => `${t.quien === "nosotros" ? "Yo" : "La otra persona"}: ${t.texto}`)
    .join("\n\n");

  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(), input.timeoutMs ?? 90_000);
  try {
    const r = await (input.fetchImpl ?? fetch)(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: control.signal,
      body: JSON.stringify({
        model: input.modelo,
        messages: [
          { role: "system", content: SISTEMA },
          { role: "user", content: `Asunto: ${input.asunto}\n\n${conversacion}\n\nEscribí lo que sigue.` }
        ],
        // Este modelo razona y el thinking sale del mismo presupuesto: con poco devuelve vacío.
        max_tokens: input.maxTokens ?? 2500,
        // Más alta que en el monitor: acá queremos variedad, no precisión. Textos parecidos entre
        // hilos serían justamente la huella que este módulo existe para evitar.
        temperature: 0.9
      })
    });
    if (!r.ok) return { texto: null, motivo: `el modelo local respondió HTTP ${r.status}` };

    const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const texto = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!texto) {
      return { texto: null, motivo: "el modelo devolvió vacío (el razonamiento se comió el presupuesto)" };
    }
    if (/^fin\b/i.test(texto)) {
      return { texto: null, motivo: "el modelo cerró la conversación: ya se despidieron" };
    }
    // Recorte de seguridad: un correo de warmup largo no es creíble y no aporta más señal.
    const limpio = texto.length > 600 ? `${texto.slice(0, 600).trim()}…` : texto;
    return { texto: limpio, motivo: "turno generado sobre el hilo real" };
  } catch (error) {
    return {
      texto: null,
      motivo: control.signal.aborted
        ? "el modelo local no respondió a tiempo"
        : `no se pudo generar el turno: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── ABRIR la conversación ────────────────────────────────────────────────────────────────────────
//
// El primer mensaje y la respuesta de la semilla salían de un banco de 14 conversaciones fijas,
// repartidas entre 58 dominios. Eso es literalmente la huella que el warmup existe para no dejar:
// un receptor que mira varios de nuestros dominios ve el mismo texto, palabra por palabra, una y
// otra vez. Los turnos siguientes ya los escribía el modelo; el arranque no.
//
// El banco queda como RESPALDO —si el modelo local no está, es mejor mandar algo conocido que no
// mandar— y siempre se declara cuál de los dos se usó. Un texto generado y uno enlatado no valen
// lo mismo como señal, y confundirlos sería mentirse sobre la calidad del calentamiento.

export interface Apertura {
  asunto: string;
  cuerpo: string;
  /** De dónde salió. Se registra: un texto enlatado y uno generado no valen lo mismo. */
  origen: "modelo" | "banco";
  motivo: string;
}

const SISTEMA_APERTURA = [
  "Escribís el PRIMER mensaje de una conversación cotidiana por correo entre dos personas que se",
  "conocen. Alguien que le escribe a un conocido por algo común de la vida.",
  "",
  "Devolvé EXACTAMENTE dos líneas:",
  "ASUNTO: <corto, minúscula salvo la primera, como lo escribiría una persona, sin punto final>",
  "CUERPO: <2 a 4 oraciones, casual, español rioplatense, sin saludo formal ni firma>",
  "",
  "REGLAS:",
  "- Tema COTIDIANO y concreto: un plan, una duda práctica, algo que quedó pendiente entre los dos.",
  "- Nada de trabajo corporativo, marketing, ofertas, ni nada que parezca un envío masivo.",
  "- No menciones correo, pruebas, sistemas ni nada técnico.",
  "- No inventes datos que suenen a registro (números de factura, montos exactos, direcciones).",
  "- Que termine en algo que invite a contestar: una pregunta o un pendiente."
].join("\n");

/**
 * Le pide al modelo una conversación nueva. Si falla, quien llama cae al banco — por eso devuelve
 * `null` con motivo en vez de inventar: un fallo silencioso que devuelve texto enlatado marcado
 * como generado sería peor que el problema original.
 */
export async function abrirConversacion(input: {
  baseUrl: string;
  modelo: string;
  /** Entra al prompt para que dos dominios no arranquen la misma charla el mismo día. */
  semilla?: string;
  fetchImpl?: typeof fetch;
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<Apertura | null> {
  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(), input.timeoutMs ?? 90_000);
  try {
    const r = await (input.fetchImpl ?? fetch)(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: control.signal,
      body: JSON.stringify({
        model: input.modelo,
        messages: [
          { role: "system", content: SISTEMA_APERTURA },
          {
            role: "user",
            content: `Escribí una conversación nueva.${input.semilla ? ` Variante ${input.semilla}: que no se parezca a las anteriores.` : ""}`
          }
        ],
        max_tokens: input.maxTokens ?? 2500,
        // Alta: acá la variedad ES el objetivo. Dos aperturas parecidas entre dominios reproducen
        // el problema del banco con más pasos.
        temperature: 1.0
      })
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const texto = (data.choices?.[0]?.message?.content ?? "").trim();
    if (!texto) return null;

    const asunto = texto.match(/^\s*ASUNTO\s*:?\s*(.+)$/im)?.[1]?.trim();
    const cuerpo = texto.match(/^\s*CUERPO\s*:?\s*([^]+)$/im)?.[1]?.trim();
    // Se exige el formato: un asunto vacío o un cuerpo de una palabra sale peor que el banco.
    if (!asunto || !cuerpo || asunto.length < 4 || cuerpo.length < 40) return null;

    return {
      asunto: asunto.replace(/^["']|["']$/g, "").slice(0, 90),
      cuerpo: cuerpo.slice(0, 600),
      origen: "modelo",
      motivo: "conversación generada para esta vuelta"
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

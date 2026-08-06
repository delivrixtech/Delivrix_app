// LA OREJA. Hasta hoy Sentinel era estructuralmente sordo: slack.ts tenía UNA sola llamada de red
// —el POST a chat.postMessage— y ningún listener. Por eso el jefe le escribió "Hey si buenasssss!!!
// Como vamos?" y no pasó nada. No la ignoró: nunca la vio.
//
// Leer Slack son DOS GET contra el mismo host al que ya se hace POST. Cero paquetes nuevos: el SDK
// oficial arrastra un stack HTTP entero (express, OAuth multi-workspace) para un bot que nunca va
// a abrir un puerto.
//
// Todo lo que decide algo es puro y testeable. La red vive en una sola función.

export interface MensajeSlack {
  ts: string;
  /** El hilo al que pertenece. Si es un mensaje suelto, es su propio ts. */
  thread_ts: string;
  texto: string;
  usuario: string;
}

export interface EstadoLectura {
  /** El `ts` más nuevo ya procesado. ES el mecanismo de deduplicación: no hay reentregas. */
  cursorTs: string | null;
  /** Hilos donde hubo actividad reciente, para saber en cuáles mirar respuestas. */
  hilosActivos: Array<{ thread_ts: string; ultimoTs: string }>;
  ultimaLecturaOk: string | null;
}

export function estadoVacio(): EstadoLectura {
  return { cursorTs: null, hilosActivos: [], ultimaLecturaOk: null };
}

/**
 * Filtra lo que NO hay que contestar. Es la función más importante del módulo: sin esto el agente
 * se contesta a sí mismo y queda en bucle infinito, gastando la API y llenando el canal.
 *
 * Dos condiciones, y la segunda no es obvia: los mensajes propios traen `bot_id` pero NO siempre
 * `subtype: "bot_message"` (es un caso documentado en el SDK oficial de Slack). Por eso se filtra
 * por bot_id Y por user, no por subtype.
 */
export function esParaContestar(
  m: { ts?: string; text?: string; user?: string; bot_id?: string; subtype?: string },
  botUserId: string | null
): boolean {
  if (!m.ts || !m.text) return false;
  if (m.bot_id) return false; // cualquier bot, incluido él mismo
  // SUBTYPE: lista blanca, no rechazo total.
  //
  // Rechazar todo subtype dejaba sordo al agente ante la forma MÁS natural de escribirle: contestar
  // dentro de un hilo con "también enviar al canal", que Slack marca `thread_broadcast`. No es
  // teoría — se comió dos mensajes reales de Juanes la noche del 2026-08-05 ("Ok, muestrame." y
  // "Pero ya tenemos 2 semillas configuradas..."), y él no vio ningún error: para él Sentinel
  // simplemente lo ignoró. Es el mismo bug que motivó escribir este archivo, sobreviviendo en otra
  // forma. El segundo camino de lectura (conversations.replies) tampoco lo rescataba: el mensaje
  // conserva el subtype ahí también.
  //
  // `file_share` entra por lo mismo: mandar una captura CON texto es conversación, y el operador
  // manda capturas todo el tiempo.
  if (m.subtype && m.subtype !== "thread_broadcast" && m.subtype !== "file_share") return false;
  if (botUserId && m.user === botUserId) return false; // él mismo, por si acaso
  return m.text.trim().length > 0;
}

/**
 * Dónde responder. `thread_ts ?? ts` — y este `??` es exactamente donde se pierde el hilo: si el
 * mensaje del jefe YA es una respuesta dentro de un hilo, trae `thread_ts` distinto de `ts`, y
 * contestar sobre `ts` a secas abre un hilo nuevo colgando de una respuesta. La conversación queda
 * partida en pedazos y el agente "se pierde".
 */
export function dondeResponder(m: MensajeSlack): string {
  return m.thread_ts || m.ts;
}

/** Avanza el cursor y la lista de hilos vivos. Puro: la persistencia es de quien llama. */
export function avanzar(estado: EstadoLectura, nuevos: readonly MensajeSlack[], ahoraISO: string): EstadoLectura {
  if (nuevos.length === 0) return { ...estado, ultimaLecturaOk: ahoraISO };
  const masNuevo = nuevos.reduce((max, m) => (m.ts > max ? m.ts : max), estado.cursorTs ?? "0");
  const hilos = new Map(estado.hilosActivos.map((h) => [h.thread_ts, h]));
  for (const m of nuevos) {
    const t = dondeResponder(m);
    const previo = hilos.get(t);
    if (!previo || m.ts > previo.ultimoTs) hilos.set(t, { thread_ts: t, ultimoTs: m.ts });
  }
  // Solo los 5 hilos más recientes: mirar respuestas cuesta una llamada por hilo, y una
  // conversación de hace días ya no necesita vigilancia.
  const activos = [...hilos.values()].sort((a, b) => b.ultimoTs.localeCompare(a.ultimoTs)).slice(0, 5);
  return { cursorTs: masNuevo, hilosActivos: activos, ultimaLecturaOk: ahoraISO };
}

export interface CfgLectura {
  token: string;
  canal: string;
  botUserId?: string | null;
  fetchImpl?: typeof fetch;
}

async function slackGet(
  cfg: CfgLectura,
  metodo: string,
  params: Record<string, string>
): Promise<{ ok: boolean; messages?: unknown[]; error?: string }> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const q = new URLSearchParams({ channel: cfg.canal, ...params }).toString();
  const r = await doFetch(`https://slack.com/api/${metodo}?${q}`, {
    headers: { authorization: `Bearer ${cfg.token}` }
  });
  return (await r.json()) as { ok: boolean; messages?: unknown[]; error?: string };
}

/**
 * Trae lo que el jefe escribió y todavía no se contestó: mensajes nuevos del canal + respuestas
 * nuevas en los hilos que siguen vivos.
 */
export async function leerNuevos(
  cfg: CfgLectura,
  estado: EstadoLectura
): Promise<{ mensajes: MensajeSlack[]; error: string | null }> {
  const out: MensajeSlack[] = [];
  const vistos = new Set<string>();
  const agregar = (m: Record<string, unknown>, threadPorDefecto?: string): void => {
    if (!esParaContestar(m as never, cfg.botUserId ?? null)) return;
    const ts = String(m.ts);
    if (vistos.has(ts)) return;
    if (estado.cursorTs && ts <= estado.cursorTs) return; // ya procesado: el cursor ES el dedupe
    vistos.add(ts);
    out.push({
      ts,
      thread_ts: String(m.thread_ts ?? threadPorDefecto ?? ts),
      texto: String(m.text ?? ""),
      usuario: String(m.user ?? "")
    });
  };

  try {
    const hist = await slackGet(cfg, "conversations.history", {
      limit: "20",
      ...(estado.cursorTs ? { oldest: estado.cursorTs } : {})
    });
    if (!hist.ok) return { mensajes: [], error: hist.error ?? "conversations.history sin ok" };
    for (const m of hist.messages ?? []) agregar(m as Record<string, unknown>);

    // Las respuestas DENTRO de un hilo no aparecen en history: hay que pedirlas por hilo.
    for (const h of estado.hilosActivos) {
      const rep = await slackGet(cfg, "conversations.replies", { ts: h.thread_ts, limit: "20" });
      if (!rep.ok) continue; // un hilo borrado no puede tumbar la lectura entera
      for (const m of rep.messages ?? []) agregar(m as Record<string, unknown>, h.thread_ts);
    }
  } catch (e) {
    return { mensajes: [], error: e instanceof Error ? e.message : String(e) };
  }

  return { mensajes: out.sort((a, b) => a.ts.localeCompare(b.ts)), error: null };
}

/**
 * EL HILO COMPLETO, tal como está en Slack. No se reconstruye ni se guarda: Slack ES el almacén.
 *
 * Sin esto el agente recibía UN solo mensaje por turno y arrancaba de cero cada vez — por eso
 * "no entendía": no es que fuera tonto, es que no tenía la conversación delante. Visto en vivo:
 * el jefe le dijo "te entrego las semillas mañana" y en el turno siguiente le contestó como si
 * nunca lo hubiera leído.
 */
export async function leerHilo(
  cfg: CfgLectura,
  threadTs: string,
  limite = 20
): Promise<Array<{ quien: "jefe" | "vos"; texto: string }>> {
  try {
    const r = await slackGet(cfg, "conversations.replies", { ts: threadTs, limit: String(limite) });
    if (!r.ok) return [];
    return (r.messages ?? [])
      .map((m) => m as Record<string, unknown>)
      .filter((m) => typeof m.text === "string" && String(m.text).trim().length > 0)
      .map((m) => ({
        quien: (m.bot_id || (cfg.botUserId && m.user === cfg.botUserId) ? "vos" : "jefe") as "jefe" | "vos",
        texto: String(m.text)
      }));
  } catch {
    return [];
  }
}

/** El user_id del propio bot, para no contestarse. Se pide una vez al arrancar. */
export async function miUserId(cfg: { token: string; fetchImpl?: typeof fetch }): Promise<string | null> {
  try {
    const doFetch = cfg.fetchImpl ?? fetch;
    const r = await doFetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}` }
    });
    const d = (await r.json()) as { ok?: boolean; user_id?: string };
    return d.ok ? (d.user_id ?? null) : null;
  } catch {
    return null;
  }
}

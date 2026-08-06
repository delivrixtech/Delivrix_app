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
export function avanzar(
  estado: EstadoLectura,
  nuevos: readonly MensajeSlack[],
  ahoraISO: string,
  /**
   * El ts más nuevo LEÍDO en esta pasada, contestable o no. Sin él, una tanda entera de mensajes
   * propios dejaba el cursor clavado y la ventana se releía igual para siempre — el jefe podía
   * escribir cada seis segundos del otro lado de esa pared y no lo veía nunca.
   */
  ultimoVisto?: string | null
): EstadoLectura {
  if (nuevos.length === 0) {
    const salto = ultimoVisto && (!estado.cursorTs || ultimoVisto > estado.cursorTs) ? ultimoVisto : estado.cursorTs;
    return { ...estado, cursorTs: salto ?? null, ultimaLecturaOk: ahoraISO };
  }
  const base = ultimoVisto && ultimoVisto > (estado.cursorTs ?? "0") ? ultimoVisto : estado.cursorTs ?? "0";
  const masNuevo = nuevos.reduce((max, m) => (m.ts > max ? m.ts : max), base);
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
 * ACUSE DE RECIBO INMEDIATO: le pone 👀 al mensaje apenas lo lee.
 *
 * El modelo tarda ~34s en contestar y el 87% de eso lo pasa razonando. Durante esos 34 segundos el
 * jefe no tiene ninguna señal de que su mensaje llegó — y "no pasó nada" es indistinguible de "el
 * agente está caído", que es exactamente la duda que lo hizo desconfiar del bot antes.
 *
 * Un emoji tarda ~200ms y no cuesta un turno del modelo. Es la diferencia entre esperar sabiendo y
 * esperar sin saber; el reclamo textual era "que diga al menos ok, trabajando".
 *
 * Falla suave a propósito: si Slack rechaza la reacción (ya estaba puesta, permiso faltante), eso
 * NO puede impedir que conteste. Un acuse es cortesía; la respuesta es el trabajo.
 */
export async function acusarRecibo(cfg: CfgLectura, ts: string, emoji = "eyes"): Promise<boolean> {
  const doFetch = cfg.fetchImpl ?? fetch;
  try {
    const r = await doFetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: cfg.canal, timestamp: ts, name: emoji })
    });
    const j = (await r.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

/**
 * Trae lo que el jefe escribió y todavía no se contestó: mensajes nuevos del canal + respuestas
 * nuevas en los hilos que siguen vivos.
 */
export async function leerNuevos(
  cfg: CfgLectura,
  estado: EstadoLectura
): Promise<{ mensajes: MensajeSlack[]; error: string | null; ultimoVisto: string | null }> {
  const out: MensajeSlack[] = [];
  const vistos = new Set<string>();
  /**
   * EL TS MÁS NUEVO QUE PASÓ POR ACÁ, se pueda contestar o no.
   *
   * Sin esto el cursor era un candado. `conversations.history` con `oldest` pagina HACIA ADELANTE
   * desde el cursor y devuelve los N más VIEJOS que quedan; si esos N son todos mensajes del
   * propio bot, se filtran, la lista sale vacía, el cursor no avanza — y en la vuelta siguiente se
   * lee exactamente la misma pared. Para siempre.
   *
   * Pasó en producción el 2026-08-06: el agente había mandado ~25 avisos durante la noche, esos 20
   * llenaron la ventana, y los seis mensajes del jefe quedaron del otro lado. Escribía cada seis
   * segundos y nunca los veía. Su propio ruido lo dejó sordo.
   *
   * Lo que se filtró NO se pierde por avanzar: un mensaje del bot, un join o un cambio de tema no
   * van a volverse contestables más tarde. El cursor tiene que medir lo LEÍDO, no lo contestado.
   */
  let ultimoVisto: string | null = null;
  const agregar = (m: Record<string, unknown>, threadPorDefecto?: string): void => {
    const tsCrudo = typeof m.ts === "string" ? m.ts : null;
    if (tsCrudo && (ultimoVisto === null || tsCrudo > ultimoVisto)) ultimoVisto = tsCrudo;
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
    if (!hist.ok) return { mensajes: [], error: hist.error ?? "conversations.history sin ok", ultimoVisto: null };
    for (const m of hist.messages ?? []) agregar(m as Record<string, unknown>);

    // Las respuestas DENTRO de un hilo no aparecen en history: hay que pedirlas por hilo.
    for (const h of estado.hilosActivos) {
      const rep = await slackGet(cfg, "conversations.replies", { ts: h.thread_ts, limit: "20" });
      if (!rep.ok) continue; // un hilo borrado no puede tumbar la lectura entera
      for (const m of rep.messages ?? []) agregar(m as Record<string, unknown>, h.thread_ts);
    }
  } catch (e) {
    return { mensajes: [], error: e instanceof Error ? e.message : String(e), ultimoVisto: null };
  }

  return { mensajes: out.sort((a, b) => a.ts.localeCompare(b.ts)), error: null, ultimoVisto };
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

/** Una tanda de mensajes que merecen UNA sola respuesta. */
export interface TandaDeMensajes {
  /** Dónde contestar: el hilo, o el mensaje más nuevo si son sueltos del canal. */
  donde: string;
  /** Los mensajes de la tanda, del más viejo al más nuevo. */
  mensajes: MensajeSlack[];
}

/**
 * AGRUPA LO QUE SE CONTESTA JUNTO — y esta función existe por una queja textual del jefe:
 * "se volvió repetitivo e imbécil".
 *
 * Qué pasó el 2026-08-06. El agente estuvo sordo unas horas (el cursor se había clavado detrás de
 * una pared de sus propios mensajes). Cuando se destrabó tenía SEIS mensajes encima —"Hey", "como
 * vamos?", "respondeme", "Necesito que me des informe"— y los contestó UNO POR UNO, en seis hilos
 * distintos, con seis variantes de la misma frase: "Aquí ando", "Qué más, acá ando", "Acá estoy",
 * "Dale, acá va el estado". Seis respuestas a la MISMA pregunta hecha de seis formas.
 *
 * Una persona que vuelve y encuentra seis "¿estás ahí?" contesta una vez. Eso es lo que hace esto.
 *
 * EL CRITERIO, y por qué es este: todo lo que quedó PENDIENTE EN LA MISMA LECTURA se debe junto.
 * No importa si son de hace un minuto o de hace tres horas — si el agente no pudo contestar
 * ninguno, todos son la misma deuda, y quien escribió cuatro veces seguidas quería una respuesta,
 * no cuatro. Las respuestas DENTRO de un hilo sí se separan por hilo: ahí el jefe eligió a
 * propósito dónde hablar, y mezclar dos hilos rompería las dos conversaciones.
 *
 * Puro y testeable: la red no entra acá.
 */
export function agruparParaContestar(mensajes: readonly MensajeSlack[]): TandaDeMensajes[] {
  const ordenados = [...mensajes].sort((a, b) => a.ts.localeCompare(b.ts));
  const porHilo = new Map<string, MensajeSlack[]>();
  const sueltos: MensajeSlack[] = [];

  for (const m of ordenados) {
    // Un mensaje SUELTO del canal tiene thread_ts === ts (o vacío): no es una conversación que el
    // jefe eligió, es un mensaje más en el canal. Los que sí viven en un hilo se agrupan por hilo.
    if (!m.thread_ts || m.thread_ts === m.ts) sueltos.push(m);
    else {
      const ya = porHilo.get(m.thread_ts);
      if (ya) ya.push(m);
      else porHilo.set(m.thread_ts, [m]);
    }
  }

  const tandas: TandaDeMensajes[] = [...porHilo.entries()].map(([donde, ms]) => ({ donde, mensajes: ms }));

  // Todos los sueltos son UNA tanda, y se contesta en el más NUEVO: es donde el jefe está mirando.
  if (sueltos.length > 0) {
    tandas.push({ donde: sueltos[sueltos.length - 1]!.ts, mensajes: sueltos });
  }

  // Del más viejo al más nuevo: si hay varias tandas, se contesta en el orden en que preguntó.
  return tandas.sort((a, b) => (a.mensajes[0]?.ts ?? "").localeCompare(b.mensajes[0]?.ts ?? ""));
}

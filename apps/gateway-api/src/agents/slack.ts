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

export interface EstadoParaSlack {
  /** El estado del emisor: send | placement-pause | killed | cap-reached | inert. */
  emisor: string | null;
  /** Las acciones que decidió esta vuelta, con si se ejecutaron. */
  acciones: Array<{ accion: string; objetivo?: string | null; ejecutada: boolean; detalle: string }>;
  /** Reparos de la verificación: si los hay, el agente dijo algo que no se sostiene. */
  reparos: string[];
  /** Por qué no hubo lectura, si no la hubo. */
  sinLectura: string | null;
  /** Su voz: la frase con la que hablaría. */
  voz: string | null;
  /** Las cuatro líneas verificadas, por si hay que dar contexto. */
  ahora: string | null;
  riesgo: string | null;
}

export interface MemoriaSlack {
  /** El último estado del emisor sobre el que se habló. */
  ultimoEmisor: string | null;
  /** Cuándo se mandó el último mensaje (ISO). */
  ultimoAviso: string | null;
  /** Hash simple de lo último dicho, para no repetir la misma frase. */
  ultimaFirma: string | null;
}

export interface Aviso {
  /** El texto que va a Slack. Corto: una o dos líneas. */
  texto: string;
  /** Por qué se habla. Va al log, no a Slack. */
  motivo: string;
  /** true si necesita que un humano conteste. */
  pideRespuesta: boolean;
}

/** Cada cuánto, como mucho, se repite un aviso del mismo tipo. Evita el goteo. */
const SILENCIO_MIN = 60;

function firma(e: EstadoParaSlack): string {
  return [e.emisor, e.acciones.map((a) => `${a.accion}:${a.objetivo ?? ""}:${a.ejecutada}`).join(","), e.sinLectura ? "sin-lectura" : ""].join("|");
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

  // 1. NO PUDO MIRAR. Un vigilante ciego tiene que decirlo: es lo único peor que una mala noticia.
  if (estado.sinLectura) {
    return {
      texto: `Juanes, no pude leer el estado: ${estado.sinLectura}. Si sigue así en la próxima vuelta, algo está roto.`,
      motivo: "sin lectura",
      pideRespuesta: false
    };
  }

  // 2. DIJO ALGO QUE NO SE SOSTIENE. Se avisa porque, con reparos, el agente NO ejecuta nada: el
  //    operador tiene que saber que quedó mudo de manos, no solo de boca.
  if (estado.reparos.length > 0) {
    return {
      texto: `Juanes, me trabé: dije algo que no cuadra con los datos (${estado.reparos[0]}), así que no toqué nada. Mejor mirá vos.`,
      motivo: "reparos en la verificación",
      pideRespuesta: true
    };
  }

  // 3. ACTUÓ. Si tocó la infraestructura, se dice siempre: una mano que se mueve en silencio es
  //    exactamente lo que no queremos de un agente autónomo.
  const hizo = estado.acciones.filter((a) => a.ejecutada);
  if (hizo.length > 0) {
    const l = hizo.map((a) => `${a.accion}${a.objetivo ? ` ${a.objetivo}` : ""}`).join(", ");
    return { texto: `Juanes, hice esto: ${l}. ${estado.voz ?? ""}`.trim(), motivo: "ejecutó una acción", pideRespuesta: false };
  }

  // 4. QUISO ACTUAR Y NO PUDO. Es el pedido de decisión: el agente ve algo, no tiene la llave, y
  //    necesita a un humano. Se avisa UNA vez por cosa, no cada 10 minutos (eso ya pasó: 10
  //    mensajes idénticos en 2 horas serían 10 mensajes idénticos en Slack).
  const trabado = estado.acciones.find((a) => !a.ejecutada && a.accion !== "(ninguna)" && a.accion !== "(tope)");
  if (trabado && firma(estado) !== mem.ultimaFirma) {
    return {
      texto: `Juanes, quise ${trabado.accion}${trabado.objetivo ? ` ${trabado.objetivo}` : ""} y no pude: ${trabado.detalle}. ¿Lo resolvés vos?`,
      motivo: "acción trabada",
      pideRespuesta: true
    };
  }

  // 5. CAMBIÓ EL ESTADO DEL EMISOR. Que arranque o que se frene es la noticia más importante que
  //    puede dar, y la única que vale por sí sola aunque no haya nada que hacer.
  if (estado.emisor && estado.emisor !== mem.ultimoEmisor) {
    const arrancó = estado.emisor === "send";
    return {
      texto: arrancó
        ? `Juanes, el emisor arrancó, ya está mandando. ${estado.voz ?? ""}`.trim()
        : `Juanes, el emisor se frenó (${estado.emisor}). ${estado.voz ?? estado.ahora ?? ""}`.trim(),
      motivo: `el emisor pasó de ${mem.ultimoEmisor ?? "desconocido"} a ${estado.emisor}`,
      pideRespuesta: false
    };
  }

  // 6. Nada cambió y no hay nada que hacer: SILENCIO. Es la respuesta correcta casi siempre.
  //    Excepción: si hace mucho que no dice nada, una señal de vida corta — pero solo si además
  //    hay un riesgo declarado, para no convertirla en ruido periódico.
  const min = mem.ultimoAviso ? (Date.parse(ahoraISO) - Date.parse(mem.ultimoAviso)) / 60_000 : Infinity;
  if (min >= SILENCIO_MIN * 4 && estado.riesgo && estado.riesgo.toLowerCase() !== "ninguno") {
    return { texto: `Juanes, sigo acá. ${estado.voz ?? estado.riesgo}`.trim(), motivo: "señal de vida con riesgo abierto", pideRespuesta: false };
  }
  return null;
}

/** Actualiza la memoria después de hablar (o de callarse). */
export function recordarAviso(estado: EstadoParaSlack, hablo: boolean, ahoraISO: string, memoria: MemoriaSlack | null): MemoriaSlack {
  const mem = memoria ?? { ultimoEmisor: null, ultimoAviso: null, ultimaFirma: null };
  return {
    // El emisor se recuerda SIEMPRE, se haya hablado o no: si no, el primer cambio después de un
    // silencio se reportaría contra un estado viejísimo.
    ultimoEmisor: estado.emisor ?? mem.ultimoEmisor,
    ultimoAviso: hablo ? ahoraISO : mem.ultimoAviso,
    ultimaFirma: hablo ? firma(estado) : mem.ultimaFirma
  };
}

/** Manda el mensaje. Falla suave: que Slack esté caído no puede tumbar al agente. */
export async function mandarASlack(
  aviso: Aviso,
  cfg: { token?: string; canal?: string; fetchImpl?: typeof fetch }
): Promise<{ ok: boolean; motivo: string | null }> {
  if (!cfg.token || !cfg.canal) return { ok: false, motivo: "sin SLACK_BOT_TOKEN o SLACK_CANAL" };
  const doFetch = cfg.fetchImpl ?? fetch;
  try {
    const r = await doFetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ channel: cfg.canal, text: aviso.texto })
    });
    const data = (await r.json()) as { ok?: boolean; error?: string };
    return data.ok ? { ok: true, motivo: null } : { ok: false, motivo: data.error ?? "slack respondió sin ok" };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}

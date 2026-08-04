// Lee la CONVERSACIÓN REAL de una vuelta de warmup, desde el buzón semilla por IMAP.
//
// Por qué existe: la consola mostraba el ciclo (envío → medición → señal → respuesta) pero no el
// CORREO. Sin el texto, un semáforo de cuatro puntos no demuestra nada — podría estar inventado.
// Acá se trae lo que de verdad llegó al buzón: el asunto, el remitente, la fecha, el cuerpo, y en
// qué carpeta cayó. Es la prueba de que el calentamiento existe.
//
// Se lee del buzón, NO de nuestra base: si lo guardáramos al enviar estaríamos mostrando lo que
// creemos que mandamos. Lo que importa es lo que el proveedor efectivamente entregó.

import { resolverCarpetas, type ImapConLista } from "./imap-carpetas.ts";

export interface MensajeDelHilo {
  /** "recibido" = lo que mandó nuestro nodo · "respuesta" = lo que contestó la semilla. */
  papel: "recibido" | "respuesta";
  carpeta: string;
  asunto: string;
  de: string;
  para: string;
  fecha: string;
  /** Cuerpo en texto plano, recortado. `null` si no se pudo extraer. */
  texto: string | null;
  /**
   * El `Message-ID` del mensaje, tal cual viaja. Hace falta para ENHEBRAR el turno siguiente: una
   * respuesta sin `In-Reply-To` es un primer contacto disfrazado de respuesta, y eso es una
   * heurística de spam vieja y conocida — aplicada justo al correo cuyo propósito es construir
   * reputación. `null` si no se pudo leer.
   */
  messageId: string | null;
}

export interface HiloWarmup {
  testId: string;
  mensajes: MensajeDelHilo[];
  /** Por qué no hay hilo (o está incompleto). `null` cuando salió todo bien. */
  motivo: string | null;
}

/** Lo mínimo del cliente IMAP. Inyectable ⇒ se testea sin red. */
export interface ImapLector extends ImapConLista {
  mailboxOpen(nombre: string): Promise<{ exists: number }>;
  search(criterio: Record<string, unknown>, opciones?: { uid?: boolean }): Promise<number[] | false>;
  fetchOne(
    uid: string,
    query: Record<string, unknown>,
    opciones?: { uid?: boolean }
  ): Promise<{ envelope?: EnvelopeImap; source?: Buffer | string } | false>;
}

interface EnvelopeImap {
  subject?: string;
  date?: Date | string;
  from?: Array<{ address?: string; name?: string }>;
  to?: Array<{ address?: string; name?: string }>;
}

/** Carpetas donde puede estar lo que RECIBIMOS. El orden importa: inbox primero. */
export const CARPETAS_ENTRADA = ["INBOX", "[Gmail]/Spam", "Junk", "Junk Email", "Bulk Mail", "Spam"];
/** Carpetas donde está lo que la semilla RESPONDIÓ. */
export const CARPETAS_ENVIADOS = ["[Gmail]/Sent Mail", "Sent", "Sent Items", "Enviados"];

const MAX_TEXTO = 1200;

/**
 * Extrae el cuerpo en texto plano del RFC822 crudo.
 *
 * Deliberadamente simple: corta en la primera línea vacía (fin de headers) y si el mensaje es
 * multipart se queda con la primera parte `text/plain`. No es un parser MIME completo y no
 * pretende serlo — los correos de warmup los generamos nosotros y son texto plano. Si algún día
 * dejan de serlo, esto devuelve algo imperfecto pero nunca lanza.
 */
export function extraerTexto(crudo: string): string | null {
  if (!crudo) return null;
  const cuerpo = crudo.split(/\r?\n\r?\n/).slice(1).join("\n\n");
  if (!cuerpo.trim()) return null;

  // Multipart: quedarse con el primer bloque text/plain.
  const plano = /content-type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\s*$)/i.exec(crudo);
  const elegido = plano?.[1] ?? cuerpo;

  // Quoted-printable: primero los cortes blandos, después los bytes =XX. Sin esto el operador lee
  // "ma=C3=B1ana" en vez de "mañana" — y un cuerpo ilegible no sirve como evidencia de nada.
  const sinCortes = elegido.replace(/=\r?\n/g, "").replace(/\r/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < sinCortes.length; i += 1) {
    const c = sinCortes[i]!;
    const hex = c === "=" ? sinCortes.slice(i + 1, i + 3) : null;
    if (hex && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      // El resto del texto ya es ASCII/UTF-8 tal cual: se pasan sus bytes.
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
    }
  }
  const limpio = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes)).trim();
  if (!limpio) return null;
  return limpio.length > MAX_TEXTO ? `${limpio.slice(0, MAX_TEXTO)}…` : limpio;
}

function direccion(lista?: Array<{ address?: string; name?: string }>): string {
  const primera = lista?.[0];
  if (!primera) return "";
  return primera.address ?? primera.name ?? "";
}

/**
 * Todos los mensajes que matchean, en todas las carpetas dadas.
 *
 * Antes devolvía UNO solo (el último). Servía cuando un hilo eran dos mensajes; ahora que la
 * conversación puede tener varios turnos, quedarse con el último hacía ver una charla de seis
 * mensajes como si fuera de dos.
 */
async function buscarEn(
  cliente: ImapLector,
  carpetas: Array<string | null>,
  criterio: Record<string, unknown>
): Promise<Array<{ carpeta: string; uid: number }>> {
  const encontrados: Array<{ carpeta: string; uid: number }> = [];
  for (const carpeta of carpetas) {
    if (!carpeta) continue;
    try {
      await cliente.mailboxOpen(carpeta);
      const uids = await cliente.search(criterio, { uid: true });
      if (uids) for (const uid of uids) encontrados.push({ carpeta, uid });
    } catch {
      // Carpeta inexistente en este proveedor: se salta. No es un error.
    }
  }
  return encontrados;
}

async function leerMensaje(
  cliente: ImapLector,
  carpeta: string,
  uid: number,
  papel: MensajeDelHilo["papel"]
): Promise<MensajeDelHilo | null> {
  await cliente.mailboxOpen(carpeta);
  const m = await cliente.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
  if (!m) return null;
  const env = m.envelope ?? {};
  const crudo = typeof m.source === "string" ? m.source : m.source?.toString("utf8") ?? "";
  return {
    papel,
    carpeta,
    // Del crudo y no del envelope: es el identificador exacto que el receptor va a cotejar contra
    // el In-Reply-To del turno siguiente.
    messageId: crudo.match(/^message-id:\s*(<[^>]+>)/im)?.[1] ?? null,
    asunto: env.subject ?? "(sin asunto)",
    de: direccion(env.from),
    para: direccion(env.to),
    fecha: env.date ? new Date(env.date).toISOString() : "",
    texto: extraerTexto(crudo)
  };
}

/**
 * Trae el hilo de una vuelta: el correo que llegó y —si existe— la respuesta que la semilla mandó.
 *
 * Se busca por el header `X-Delivrix-Test-Id`, que estampamos al enviar. Por asunto sería frágil:
 * el banco de conversaciones rota temas y se repiten entre vueltas.
 */
export async function leerHiloWarmup(cliente: ImapLector, testId: string): Promise<HiloWarmup> {
  const mensajes: MensajeDelHilo[] = [];

  // Las carpetas se resuelven por su FLAG, no por nombre: una cuenta en español tiene
  // `[Gmail]/Enviados` y la lista de nombres fijos no la encontraba nunca. Ver imap-carpetas.ts.
  const carpetas = await resolverCarpetas(cliente);

  // TODOS los turnos nuestros: la continuación reusa el mismo testId, así que el header los junta.
  const nuestros = await buscarEn(cliente, [carpetas.entrada, carpetas.spam], {
    header: { "x-delivrix-test-id": testId }
  });
  for (const { carpeta, uid } of nuestros) {
    const m = await leerMensaje(cliente, carpeta, uid, "recibido");
    if (m) mensajes.push(m);
  }

  // Lo que la semilla respondió vive en SUS enviados, y no lleva nuestro header: se busca por el
  // asunto original (SEARCH de IMAP es por subcadena, así que el "Re: " adelante no molesta).
  const asuntoOriginal = mensajes[0]?.asunto?.replace(/^(re|rv|fwd):\s*/i, "");
  if (asuntoOriginal && carpetas.enviados) {
    for (const { carpeta, uid } of await buscarEn(cliente, [carpetas.enviados], { subject: asuntoOriginal })) {
      const m = await leerMensaje(cliente, carpeta, uid, "respuesta");
      if (m) mensajes.push(m);
    }
  }

  // Orden cronológico: los turnos vienen de dos carpetas distintas y se intercalan en el tiempo.
  // Sin esto, "quién habló último" —que es lo que decide si toca responder— sale mal.
  mensajes.sort((a, b) => (Date.parse(a.fecha) || 0) - (Date.parse(b.fecha) || 0));

  // Null con motivo, nunca una lista vacía muda: quien mire tiene que saber si no hay hilo porque
  // el correo no llegó, o porque todavía no lo indexaron.
  const motivo =
    mensajes.length === 0
      ? "no se encontró el mensaje en el buzón semilla (puede no haber llegado, o no estar indexado todavía)"
      : carpetas.faltantes.includes("enviados")
        ? "no se pudo abrir la carpeta de enviados de la semilla: puede haber respuestas que no vemos"
        : mensajes.every((m) => m.papel === "recibido")
          ? "sin respuesta de la semilla todavía"
          : null;

  return { testId, mensajes, motivo };
}

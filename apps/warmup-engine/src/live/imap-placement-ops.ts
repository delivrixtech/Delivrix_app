// Medición y señal de warmup POR IMAP — la implementación que sirve para cualquier proveedor.
//
// Por qué existe: el ciclo live nació hablando la API de Gmail, y eso tiene dos problemas. Uno de
// diseño: el doc de v1 (§14) manda **SMTP + IMAP** para warmup y descarta la API de Gmail/Graph por
// términos de servicio. Y uno práctico: la API ata la medición a UNA cuenta con OAuth, así que
// Outlook y Yahoo quedaban fuera y un refresh token vencido dejaba la fábrica ciega (pasó).
//
// Con IMAP, cualquier semilla con app password mide — Gmail, Outlook, Yahoo, GMX — y la credencial
// no caduca sola a los 7 días.
//
// QUÉ SE PUEDE Y QUÉ NO, dicho de frente:
//   - Se distingue INBOX de SPAM con certeza: son carpetas IMAP distintas. Ese es EL dato que gatea.
//   - NO se distingue la pestaña Promociones de Principal: Gmail no expone las categorías por IMAP.
//     No es una pérdida: el propio diseño v1 dice que **las pestañas cuentan como inbox**.
//   - `missing` (no aparece en ninguna carpeta) NO es `spam`: es su propio caso, como manda el v1.

import type { FoundMessage, Placement } from "./warmup-live-cycle.ts";

/** Lo mínimo de un cliente IMAP que estas operaciones necesitan. Inyectable ⇒ testeable sin red. */
import { resolverCarpetas, type ImapConLista } from "./imap-carpetas.ts";

export interface ImapClienteMinimo {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close?(): Promise<void>;
  /** Abre una carpeta. Lanza si no existe. */
  mailboxOpen(nombre: string): Promise<{ exists: number }>;
  /** Busca por criterio; devuelve UIDs. */
  search(criterio: Record<string, unknown>, opciones?: { uid?: boolean }): Promise<number[] | false>;
  /** Mueve mensajes a otra carpeta (en Gmail, sacar de Spam = marcarlo como no-spam). */
  messageMove(rango: string, destino: string, opciones?: { uid?: boolean }): Promise<unknown>;
  /** Agrega flags: \\Seen = leído, \\Flagged = destacado (la estrella de Gmail). */
  messageFlagsAdd(rango: string, flags: string[], opciones?: { uid?: boolean }): Promise<boolean>;
}

/**
 * Dónde buscar, en orden. INBOX primero porque es el desenlace bueno y el más común; si aparece
 * ahí, no hace falta tocar Spam.
 *
 * Los nombres de carpeta varían por proveedor: Gmail usa `[Gmail]/Spam`, Outlook y Yahoo usan
 * `Junk`. Se intentan todos y se ignoran los que no existan — un proveedor no tiene por qué tener
 * las carpetas del otro.
 */
/**
 * @deprecated Se resuelve por flag SPECIAL-USE (ver imap-carpetas.ts). Queda solo como respaldo
 * documental: una cuenta en español tiene `[Gmail]/Enviados` y ninguna lista de nombres alcanza.
 */
export const CARPETAS_SPAM = ["[Gmail]/Spam", "Junk", "Junk Email", "Spam", "Bulk Mail"];

export interface UbicacionMensaje {
  carpeta: string;
  uid: number;
  placement: Placement;
}

/**
 * Busca el mensaje por su Message-ID en INBOX y después en las carpetas de spam.
 *
 * Se busca por HEADER Message-ID y no por asunto: el asunto puede repetirse entre vueltas (el banco
 * de conversaciones rota temas) y mediríamos el mensaje equivocado. El Message-ID es único.
 */
export async function ubicarMensaje(
  cliente: ImapClienteMinimo,
  rfc822MessageId: string
): Promise<UbicacionMensaje | null> {
  const criterio = { header: { "message-id": rfc822MessageId } };

  // INBOX
  try {
    await cliente.mailboxOpen("INBOX");
    const uids = await cliente.search(criterio, { uid: true });
    if (uids && uids.length > 0) {
      return { carpeta: "INBOX", uid: uids[uids.length - 1]!, placement: "INBOX" };
    }
  } catch {
    // Si ni INBOX abre, el problema es de conexión y lo reporta quien llama.
  }

  // La carpeta de spam se resuelve por su FLAG `\\Junk`, no por nombre: en una cuenta en otro
  // idioma el nombre cambia, `mailboxOpen` falla, y "no está en spam" se vuelve indistinguible de
  // "no pude mirar en spam". Eso sería fail-open sobre el dato que gatea toda la rampa.
  let spam: string | null = null;
  try {
    spam = (await resolverCarpetas(cliente as unknown as ImapConLista)).spam;
  } catch {
    // Sin LIST se cae a los nombres históricos: peor, pero mejor que no mirar.
  }
  for (const carpeta of spam ? [spam] : CARPETAS_SPAM) {
    try {
      await cliente.mailboxOpen(carpeta);
      const uids = await cliente.search(criterio, { uid: true });
      if (uids && uids.length > 0) {
        return { carpeta, uid: uids[uids.length - 1]!, placement: "SPAM" };
      }
    } catch {
      // Carpeta inexistente en este proveedor: se salta, no es un error.
    }
  }

  // No está en ningún lado TODAVÍA. `missing` ≠ `spam`: puede ser que aún no lo indexaron.
  return null;
}

/**
 * La señal que calienta. Es el gesto que le enseña al proveedor que este remitente es deseado:
 *
 *  - Si cayó en SPAM: se MUEVE a INBOX. En Gmail sacar un mensaje de Spam es exactamente "marcar
 *    como no spam", que es la señal más fuerte que existe.
 *  - En los dos casos: se marca leído (\Seen) y destacado (\Flagged, la estrella).
 *
 * Devuelve dónde quedó el mensaje después de actuar.
 */
export async function generarSenal(
  cliente: ImapClienteMinimo,
  ubicacion: UbicacionMensaje
): Promise<Placement> {
  const rango = String(ubicacion.uid);

  if (ubicacion.placement === "SPAM") {
    await cliente.mailboxOpen(ubicacion.carpeta);
    await cliente.messageMove(rango, "INBOX", { uid: true });
    // Tras mover, el UID cambia de carpeta: los flags se aplican en INBOX buscándolo de nuevo.
    await cliente.mailboxOpen("INBOX");
    return "INBOX";
  }

  await cliente.mailboxOpen(ubicacion.carpeta);
  await cliente.messageFlagsAdd(rango, ["\\Seen", "\\Flagged"], { uid: true });
  return ubicacion.placement;
}

/**
 * Adapta las operaciones IMAP a la interfaz que ya consume el ciclo (`GmailOps`), para no tener que
 * reescribir el ciclo: sigue siendo enviar → medir → señal, solo cambia por dónde se mira.
 *
 * `labelIds` se rellena con un valor equivalente al de la API (INBOX / SPAM) para que
 * `classifyPlacement` siga funcionando igual.
 */
export interface EnviadorRespuesta {
  send(input: { from: string; to: string; subject: string; inReplyTo: string; references: string; body: string }): Promise<{ id: string }>;
}

export function opsDesdeImap(
  cliente: ImapClienteMinimo,
  /**
   * Enviador de la RESPUESTA desde el buzon semilla. Opcional: sin el, la vuelta llega hasta la
   * senal (medir + rescatar de spam), que ya es la mayor parte del valor. Con el, se cierra el
   * ciclo con una respuesta real — la senal bidireccional que mas pesa.
   */
  enviador?: EnviadorRespuesta
): {
  findMessage(input: { rfc822MessageId: string; subject: string }): Promise<FoundMessage | null>;
  modifyLabels(gmailId: string, change: { add: string[]; remove: string[] }): Promise<void>;
  sendReply(input: { from: string; to: string; subject: string; inReplyTo: string; references: string; body: string; threadId: string }): Promise<{ id: string }>;
} {
  // Se recuerda la última ubicación para que `modifyLabels` sepa sobre qué carpeta/UID actuar sin
  // volver a buscar (el ciclo llama findMessage y después modifyLabels sobre el mismo mensaje).
  let ultima: UbicacionMensaje | null = null;

  return {
    async findMessage({ rfc822MessageId }) {
      const ubicacion = await ubicarMensaje(cliente, rfc822MessageId);
      ultima = ubicacion;
      if (!ubicacion) return null;
      return {
        gmailId: String(ubicacion.uid),
        threadId: String(ubicacion.uid),
        labelIds: ubicacion.placement === "SPAM" ? ["SPAM"] : ["INBOX"]
      };
    },
    async modifyLabels() {
      // El ciclo pide "sacá SPAM, poné INBOX/IMPORTANT". Sobre IMAP eso es mover y flaggear; el
      // detalle de qué labels pidió no cambia el gesto, así que se ignora el argumento.
      if (!ultima) return;
      await generarSenal(cliente, ultima);
    },
    async sendReply(input) {
      if (!enviador) throw new Error("esta semilla no tiene enviador SMTP configurado para responder");
      return enviador.send(input);
    }
  };
}

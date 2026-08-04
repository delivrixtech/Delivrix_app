// Tests del lector de hilos. No tenía. Se escriben ahora porque el lector cambió por un bug REAL:
// con la semilla en español nunca encontraba la respuesta y la conversación no avanzaba jamás.

import assert from "node:assert/strict";
import test from "node:test";

import { leerHiloWarmup, type ImapLector } from "./imap-thread-reader.ts";

interface MsgFalso { carpeta: string; uid: number; asunto: string; fecha: string; header?: string; }

/** Un buzón falso. `carpetas` replica la salida de LIST, con sus flags. */
function buzon(carpetas: Array<{ path: string; specialUse?: string }>, msgs: MsgFalso[]): ImapLector {
  let abierta = "";
  return {
    list: async () => carpetas,
    mailboxOpen: async (n: string) => {
      if (!carpetas.some((c) => c.path === n)) throw new Error("Command failed");
      abierta = n;
      return { exists: msgs.filter((m) => m.carpeta === n).length };
    },
    search: async (crit: Record<string, unknown>) => {
      const h = (crit.header as Record<string, string> | undefined)?.["x-delivrix-test-id"];
      const sub = crit.subject as string | undefined;
      return msgs
        .filter((m) => m.carpeta === abierta)
        .filter((m) => (h ? m.header === h : true))
        .filter((m) => (sub ? m.asunto.includes(sub) : true))
        .map((m) => m.uid);
    },
    fetchOne: async (uid: string) => {
      const m = msgs.find((x) => x.uid === Number(uid) && x.carpeta === abierta);
      return m ? { envelope: { subject: m.asunto, date: m.fecha, from: [{ address: "a@b.com" }], to: [{ address: "c@d.com" }] }, source: "\r\nhola" } : false;
    }
  };
}

const ES = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "[Gmail]/Enviados", specialUse: "\\Sent" },
  { path: "[Gmail]/Spam", specialUse: "\\Junk" }
];

test("cuenta en ESPAÑOL: encuentra la respuesta en [Gmail]/Enviados", async () => {
  // El bug exacto: la lista de nombres fijos no abría esa carpeta, el hilo salía siempre a medias
  // y el daemon concluía "estamos esperando respuesta" para siempre.
  const h = await leerHiloWarmup(buzon(ES, [
    { carpeta: "INBOX", uid: 1, asunto: "Café? [t1]", fecha: "2026-08-03T10:00:00Z", header: "t1" },
    { carpeta: "[Gmail]/Enviados", uid: 2, asunto: "Re: Café? [t1]", fecha: "2026-08-03T11:00:00Z" }
  ]), "t1");
  assert.equal(h.mensajes.length, 2);
  assert.equal(h.mensajes.at(-1)?.papel, "respuesta");
  assert.equal(h.motivo, null);
});

test("trae TODOS los turnos y los ordena por fecha", async () => {
  // Sin el orden cronológico, "quién habló último" —lo que decide si toca responder— sale mal.
  const h = await leerHiloWarmup(buzon(ES, [
    { carpeta: "INBOX", uid: 1, asunto: "Café? [t1]", fecha: "2026-08-03T10:00:00Z", header: "t1" },
    { carpeta: "[Gmail]/Enviados", uid: 2, asunto: "Re: Café? [t1]", fecha: "2026-08-03T11:00:00Z" },
    { carpeta: "INBOX", uid: 3, asunto: "Re: Café? [t1]", fecha: "2026-08-03T13:00:00Z", header: "t1" },
    { carpeta: "[Gmail]/Enviados", uid: 4, asunto: "Re: Café? [t1]", fecha: "2026-08-03T15:00:00Z" }
  ]), "t1");
  assert.equal(h.mensajes.length, 4, "los 4 turnos, no solo el primero de cada lado");
  assert.deepEqual(h.mensajes.map((m) => m.papel), ["recibido", "respuesta", "recibido", "respuesta"]);
});

test("si no se puede abrir enviados, se DECLARA: puede haber respuestas invisibles", async () => {
  // Callar esto es lo que hizo que el bug viviera: se veía igual que "todavía no contestaron".
  const h = await leerHiloWarmup(buzon([{ path: "INBOX", specialUse: "\\Inbox" }], [
    { carpeta: "INBOX", uid: 1, asunto: "Café? [t1]", fecha: "2026-08-03T10:00:00Z", header: "t1" }
  ]), "t1");
  assert.match(h.motivo ?? "", /enviados/);
});

test("sin respuesta todavía: motivo honesto, no null", async () => {
  const h = await leerHiloWarmup(buzon(ES, [
    { carpeta: "INBOX", uid: 1, asunto: "Café? [t1]", fecha: "2026-08-03T10:00:00Z", header: "t1" }
  ]), "t1");
  assert.equal(h.mensajes.length, 1);
  assert.match(h.motivo ?? "", /sin respuesta/);
});

test("el mensaje en SPAM también cuenta como nuestro", async () => {
  const h = await leerHiloWarmup(buzon(ES, [
    { carpeta: "[Gmail]/Spam", uid: 1, asunto: "Café? [t1]", fecha: "2026-08-03T10:00:00Z", header: "t1" }
  ]), "t1");
  assert.equal(h.mensajes[0]?.carpeta, "[Gmail]/Spam");
});

test("hilo inexistente: lista vacía CON motivo", async () => {
  const h = await leerHiloWarmup(buzon(ES, []), "no-existe");
  assert.deepEqual(h.mensajes, []);
  assert.match(h.motivo ?? "", /no se encontró/);
});

test("expone el Message-ID de cada mensaje: sin él no se puede enhebrar el turno siguiente", async () => {
  // Un "Re:" sin In-Reply-To es un primer contacto disfrazado de respuesta — heurística de spam
  // vieja y conocida, aplicada justo al correo que existe para construir reputación. La asimetría
  // lo delataba: la respuesta de la SEMILLA sí iba enhebrada y la de nuestro nodo no.
  const b = buzon(ES, [{ carpeta: "INBOX", uid: 1, asunto: "Café? [t1]", fecha: "2026-08-04T10:00:00Z", header: "t1" }]);
  const conCrudo: typeof b = {
    ...b,
    fetchOne: async (uid: string) => {
      const r = await b.fetchOne(uid, {}, {});
      return r ? { ...r, source: "Message-ID: <abc-123@corpfiling-infra.com>\r\nSubject: x\r\n\r\nhola" } : false;
    }
  };
  const h = await leerHiloWarmup(conCrudo, "t1");
  assert.equal(h.mensajes[0]?.messageId, "<abc-123@corpfiling-infra.com>");
});

test("sin Message-ID en el crudo devuelve null, no una cadena inventada", async () => {
  const h = await leerHiloWarmup(buzon(ES, [
    { carpeta: "INBOX", uid: 1, asunto: "Café? [t1]", fecha: "2026-08-04T10:00:00Z", header: "t1" }
  ]), "t1");
  assert.equal(h.mensajes[0]?.messageId, null);
});

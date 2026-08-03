// Tests de la medición por IMAP. Lo que protegen: que INBOX y SPAM se distingan de verdad, que
// "no aparece" NO se confunda con spam, que la señal mueva de spam a inbox (el gesto que calienta),
// y que una carpeta inexistente en un proveedor no rompa la búsqueda.

import assert from "node:assert/strict";
import test from "node:test";

import { CARPETAS_SPAM, generarSenal, opsDesdeImap, ubicarMensaje, type ImapClienteMinimo } from "./imap-placement-ops.ts";

/** Cliente IMAP falso: un mapa carpeta → UIDs que "contienen" el mensaje buscado. */
function clienteFalso(contenido: Record<string, number[]>, carpetasQueExisten?: string[]) {
  const existentes = new Set(carpetasQueExisten ?? Object.keys(contenido).concat("INBOX"));
  const acciones: string[] = [];
  let abierta = "";
  const cliente: ImapClienteMinimo = {
    async connect() {},
    async logout() {},
    async mailboxOpen(nombre) {
      if (!existentes.has(nombre)) throw new Error(`no existe la carpeta ${nombre}`);
      abierta = nombre;
      return { exists: 0 };
    },
    async search() {
      return contenido[abierta] ?? [];
    },
    async messageMove(rango, destino) {
      acciones.push(`move ${rango} ${abierta}→${destino}`);
      return {};
    },
    async messageFlagsAdd(rango, flags) {
      acciones.push(`flags ${rango} ${flags.join(",")} en ${abierta}`);
      return true;
    }
  };
  return { cliente, acciones };
}

test("un mensaje en INBOX se mide como INBOX", async () => {
  const { cliente } = clienteFalso({ INBOX: [42] });
  const u = await ubicarMensaje(cliente, "<abc@dominio.com>");
  assert.equal(u?.placement, "INBOX");
  assert.equal(u?.carpeta, "INBOX");
  assert.equal(u?.uid, 42);
});

test("un mensaje en la carpeta de spam se mide como SPAM", async () => {
  const { cliente } = clienteFalso({ INBOX: [], "[Gmail]/Spam": [7] });
  const u = await ubicarMensaje(cliente, "<abc@dominio.com>");
  assert.equal(u?.placement, "SPAM");
  assert.equal(u?.carpeta, "[Gmail]/Spam");
});

test("'no aparece' devuelve null: missing NO es spam", async () => {
  // Regla del diseño v1: `missing` es su propio caso. Devolver SPAM acá haría que un mensaje que
  // todavía no se indexó cuente como caída en spam y pausaría la rampa sin motivo.
  const { cliente } = clienteFalso({ INBOX: [], "[Gmail]/Spam": [] });
  assert.equal(await ubicarMensaje(cliente, "<abc@dominio.com>"), null);
});

test("una carpeta que no existe en el proveedor se saltea sin romper", async () => {
  // Outlook no tiene [Gmail]/Spam; Gmail no tiene Junk. Se prueban todas y se ignoran las ausentes.
  const { cliente } = clienteFalso({ INBOX: [], Junk: [9] }, ["INBOX", "Junk"]);
  const u = await ubicarMensaje(cliente, "<abc@dominio.com>");
  assert.equal(u?.placement, "SPAM");
  assert.equal(u?.carpeta, "Junk", "encontró la carpeta del proveedor correcto");
});

test("todas las carpetas de spam configuradas cubren Gmail, Outlook y Yahoo", () => {
  assert.ok(CARPETAS_SPAM.includes("[Gmail]/Spam"), "Gmail");
  assert.ok(CARPETAS_SPAM.includes("Junk"), "Outlook/Yahoo");
});

test("la señal SACA de spam y lo lleva a INBOX (el gesto que calienta)", async () => {
  const { cliente, acciones } = clienteFalso({ INBOX: [], "[Gmail]/Spam": [7] });
  const u = await ubicarMensaje(cliente, "<abc@dominio.com>");
  const despues = await generarSenal(cliente, u!);
  assert.equal(despues, "INBOX", "después de rescatarlo, está en inbox");
  assert.ok(
    acciones.some((a) => a.startsWith("move 7") && a.includes("→INBOX")),
    `esperaba un move a INBOX, hubo: ${acciones.join(" | ")}`
  );
});

test("si ya está en inbox, la señal es marcarlo leído y destacado", async () => {
  const { cliente, acciones } = clienteFalso({ INBOX: [42] });
  const u = await ubicarMensaje(cliente, "<abc@dominio.com>");
  const despues = await generarSenal(cliente, u!);
  assert.equal(despues, "INBOX");
  assert.ok(acciones.some((a) => a.includes("\\Seen") && a.includes("\\Flagged")), acciones.join(" | "));
  assert.ok(!acciones.some((a) => a.startsWith("move")), "no se mueve lo que ya está bien");
});

test("el adaptador habla el mismo contrato que el ciclo espera", async () => {
  const { cliente, acciones } = clienteFalso({ INBOX: [], "[Gmail]/Spam": [7] });
  const ops = opsDesdeImap(cliente);

  const hallado = await ops.findMessage({ rfc822MessageId: "<abc@dominio.com>", subject: "hola" });
  assert.deepEqual(hallado?.labelIds, ["SPAM"], "el ciclo clasifica por labelIds, como con la API");

  await ops.modifyLabels(hallado!.gmailId, { add: ["INBOX"], remove: ["SPAM"] });
  assert.ok(acciones.some((a) => a.includes("→INBOX")), "modifyLabels ejecuta el rescate real");
});

test("el adaptador devuelve null cuando no lo encuentra, sin actuar sobre nada", async () => {
  const { cliente, acciones } = clienteFalso({ INBOX: [], "[Gmail]/Spam": [] });
  const ops = opsDesdeImap(cliente);
  assert.equal(await ops.findMessage({ rfc822MessageId: "<x@y.com>", subject: "s" }), null);
  await ops.modifyLabels("0", { add: [], remove: [] });
  assert.deepEqual(acciones, [], "sin mensaje ubicado no se toca ninguna casilla");
});

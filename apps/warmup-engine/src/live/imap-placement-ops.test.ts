// Tests de la medición por IMAP. Lo que protegen: que INBOX y SPAM se distingan de verdad, que
// "no aparece" NO se confunda con spam, que la señal mueva de spam a inbox (el gesto que calienta),
// y que una carpeta inexistente en un proveedor no rompa la búsqueda.

import assert from "node:assert/strict";
import test from "node:test";

import { CARPETAS_SPAM, generarSenal, opsDesdeImap, ubicarMensaje, type ImapClienteMinimo } from "./imap-placement-ops.ts";

/**
 * Cliente IMAP falso: un mapa carpeta → UIDs que "contienen" el mensaje buscado.
 *
 * `list()` NO es opcional acá aunque el tipo no lo exija. Sin él, `resolverCarpetas` lanzaba, el
 * código caía al camino de nombres fijos `@deprecated`, y los 9 tests pasaban por ahí: se podía
 * BORRAR ENTERA la resolución por SPECIAL-USE —el arreglo central del commit— y todo quedaba verde.
 * Un fixture que no implementa lo que el código llama no prueba el código, prueba el fallback.
 *
 * `flags` mapea carpeta → SPECIAL-USE, para poder simular una cuenta en otro idioma.
 */
function clienteFalso(
  contenido: Record<string, number[]>,
  carpetasQueExisten?: string[],
  flags: Record<string, string> = { INBOX: "\\Inbox", "[Gmail]/Spam": "\\Junk" }
) {
  const existentes = new Set(carpetasQueExisten ?? Object.keys(contenido).concat("INBOX"));
  const acciones: string[] = [];
  let abierta = "";
  const cliente: ImapClienteMinimo = {
    async connect() {},
    async logout() {},
    async list() {
      return [...existentes].map((path) => ({ path, ...(flags[path] ? { specialUse: flags[path] } : {}) }));
    },
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


// ── La resolución por SPECIAL-USE, que antes ningún test tocaba ─────────────────────────────────

test("cuenta en OTRO IDIOMA: encuentra la carpeta de spam por su flag, no por su nombre", async () => {
  // `Correo no deseado` no está en la lista de nombres históricos: si esto pasa, es porque se
  // resolvió por \\Junk. Es exactamente el caso de una semilla Outlook en español.
  const { cliente } = clienteFalso(
    { "Correo no deseado": [7] },
    ["INBOX", "Correo no deseado"],
    { INBOX: "\\Inbox", "Correo no deseado": "\\Junk" }
  );
  const u = await ubicarMensaje(cliente, "<abc@dominio.com>");
  assert.equal(u?.placement, "SPAM");
  assert.equal(u?.carpeta, "Correo no deseado");
});

test("si NINGUNA carpeta de spam se puede abrir, LANZA en vez de decir 'no está'", async () => {
  // Es el hallazgo con camino a más volumen sobre evidencia falsa: devolviendo null, la medición
  // se perdía callada, la tasa de inbox quedaba cerca del 100% y la rampa seguía subiendo.
  const { cliente } = clienteFalso({}, ["INBOX"], { INBOX: "\\Inbox" });
  await assert.rejects(() => ubicarMensaje(cliente, "<abc@dominio.com>"), /medición sería falsa/);
});

test("con la carpeta de spam abierta y el mensaje ausente, sí devuelve null (todavía no indexado)", async () => {
  // El otro lado del borde: acá SÍ miramos y no estaba. "No lo encontré" ≠ "no pude mirar".
  const { cliente } = clienteFalso({}, ["INBOX", "[Gmail]/Spam"]);
  assert.equal(await ubicarMensaje(cliente, "<abc@dominio.com>"), null);
});

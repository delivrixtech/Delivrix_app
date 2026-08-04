// Lo que protegen: que una cuenta en OTRO IDIOMA se lea igual (el bug real de `[Gmail]/Enviados`),
// y que "no pude mirar" nunca se confunda con "no está ahí".

import assert from "node:assert/strict";
import test from "node:test";

import { carpetaPorUso, resolverCarpetas } from "./imap-carpetas.ts";

// La cuenta REAL que rompió esto (trazosvercel@gmail.com, Gmail en español).
const GMAIL_ES = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "[Gmail]/Destacados", specialUse: "\\Flagged" },
  { path: "[Gmail]/Enviados", specialUse: "\\Sent" },
  { path: "[Gmail]/Spam", specialUse: "\\Junk" },
  { path: "[Gmail]/Papelera", specialUse: "\\Trash" }
];

test("cuenta en español: encuentra Enviados aunque no se llame 'Sent Mail'", () => {
  // Es el bug exacto: la lista de nombres fijos fallaba y el hilo se leía siempre a medias.
  assert.equal(carpetaPorUso(GMAIL_ES, "\\Sent"), "[Gmail]/Enviados");
  assert.equal(carpetaPorUso(GMAIL_ES, "\\Junk"), "[Gmail]/Spam");
});

test("el idioma da igual: el flag es el mismo en cualquiera", () => {
  const alManna = [{ path: "INBOX", specialUse: "\\Inbox" }, { path: "Gesendet", specialUse: "\\Sent" }];
  assert.equal(carpetaPorUso(alManna, "\\Sent"), "Gesendet");
});

test("servidor sin SPECIAL-USE: cae al respaldo por nombre", () => {
  const viejo = [{ path: "INBOX" }, { path: "Sent" }, { path: "Junk" }];
  assert.equal(carpetaPorUso(viejo, "\\Sent"), "Sent");
  assert.equal(carpetaPorUso(viejo, "\\Junk"), "Junk");
});

test("el respaldo NO inventa carpetas que el servidor no listó", () => {
  // Devolver un nombre plausible solo mueve el fallo a la apertura, donde ya no se sabe por qué.
  assert.equal(carpetaPorUso([{ path: "INBOX" }], "\\Sent"), null);
});

test("lo que no se pudo resolver se DECLARA en faltantes", async () => {
  // Sin esto, "no está en spam" y "no pude mirar en spam" se ven igual — fail-open sobre el dato
  // que gatea toda la rampa.
  const r = await resolverCarpetas({ list: async () => [{ path: "INBOX", specialUse: "\\Inbox" }] });
  assert.equal(r.spam, null);
  assert.equal(r.enviados, null);
  assert.deepEqual(r.faltantes.sort(), ["enviados", "spam"]);
});

test("cuenta completa: nada faltante y entrada resuelta", async () => {
  const r = await resolverCarpetas({ list: async () => GMAIL_ES });
  assert.deepEqual(r, { entrada: "INBOX", spam: "[Gmail]/Spam", enviados: "[Gmail]/Enviados", faltantes: [] });
});

test("sin \\Inbox declarado, INBOX es el default estándar (no depende del idioma)", async () => {
  const r = await resolverCarpetas({ list: async () => [{ path: "INBOX" }, { path: "Enviados" }] });
  assert.equal(r.entrada, "INBOX");
});

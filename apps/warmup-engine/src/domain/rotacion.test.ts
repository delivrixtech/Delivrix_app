// Tests de la rotación. Lo que protegen: que no se repita el par (dominio, semilla) mientras haya
// alternativa, que se reparta entre proveedores, y que la decisión sea REPRODUCIBLE — sin eso, un
// bug de rotación no se puede reconstruir.

import assert from "node:assert/strict";
import test from "node:test";

import { elegirSemillaRotada, progresoDeCalentamiento, type UsoPrevio } from "./rotacion.ts";
import type { SeedBase } from "./seeds.ts";

const AHORA = new Date("2026-08-03T20:00:00.000Z");

function s(address: string, provider: string, auth: SeedBase["auth"] = "imap_password"): SeedBase {
  return { address, provider, enabled: true, auth };
}

const GMAIL_A = s("a@gmail.com", "gmail");
const GMAIL_B = s("b@gmail.com", "gmail");
const YAHOO = s("c@yahoo.com", "yahoo");

function uso(domain: string, seed: string, hace: string): UsoPrevio {
  const ms: Record<string, number> = { "1h": 3_600_000, "5h": 18_000_000, "30h": 108_000_000, "3d": 259_200_000 };
  return { domain, seed, cuando: new Date(AHORA.getTime() - (ms[hace] ?? 0)).toISOString() };
}

test("sin historial, elige y lo declara: el par nuevo manda", () => {
  const d = elegirSemillaRotada([GMAIL_A, GMAIL_B, YAHOO], "x.com", [], AHORA);
  assert.ok(d);
  assert.match(d.motivo, /par nuevo/);
});

test("NO repite el par mientras haya una semilla que este dominio nunca usó", () => {
  // Es la regla que más pesa: el mismo remitente escribiéndole siempre al mismo buzón es la huella.
  const historial = [uso("x.com", "a@gmail.com", "1h")];
  const d = elegirSemillaRotada([GMAIL_A, GMAIL_B, YAHOO], "x.com", historial, AHORA);
  assert.notEqual(d?.semilla.address, "a@gmail.com");
});

test("reparte entre PROVEEDORES: si ya tocó Gmail hoy, prefiere Yahoo", () => {
  // Las dos de Gmail ya se usaron, así que "par nuevo" no desempata; gana el proveedor sin tocar.
  const historial = [uso("x.com", "a@gmail.com", "5h"), uso("x.com", "b@gmail.com", "1h"), uso("x.com", "c@yahoo.com", "3d")];
  const d = elegirSemillaRotada([GMAIL_A, GMAIL_B, YAHOO], "x.com", historial, AHORA);
  assert.equal(d?.semilla.address, "c@yahoo.com");
  assert.match(d!.motivo, /proveedor sin tocar hoy/);
});

test("entre iguales, gana la que hace más que este dominio no usa", () => {
  const soloGmail = [GMAIL_A, GMAIL_B];
  const historial = [uso("x.com", "a@gmail.com", "30h"), uso("x.com", "b@gmail.com", "1h")];
  const d = elegirSemillaRotada(soloGmail, "x.com", historial, AHORA);
  assert.equal(d?.semilla.address, "a@gmail.com");
  assert.match(d!.motivo, /más antigua/);
});

test("desempata por uso GLOBAL: ninguna semilla se quema mientras otra está sin estrenar", () => {
  const historial = [
    // b se usó mucho en otros dominios; para x.com las dos son nuevas.
    uso("otro1.com", "b@gmail.com", "1h"),
    uso("otro2.com", "b@gmail.com", "5h"),
    uso("otro3.com", "b@gmail.com", "30h")
  ];
  const d = elegirSemillaRotada([GMAIL_A, GMAIL_B], "x.com", historial, AHORA);
  assert.equal(d?.semilla.address, "a@gmail.com", "la menos usada en toda la flota");
});

test("dos dominios distintos NO caen en la misma semilla a la vez", () => {
  // Con el hash viejo esto podía pasar; acá el historial los separa.
  const historial: UsoPrevio[] = [];
  const d1 = elegirSemillaRotada([GMAIL_A, GMAIL_B, YAHOO], "uno.com", historial, AHORA)!;
  historial.push({ domain: "uno.com", seed: d1.semilla.address, cuando: AHORA.toISOString() });
  const d2 = elegirSemillaRotada([GMAIL_A, GMAIL_B, YAHOO], "dos.com", historial, AHORA)!;
  assert.notEqual(d2.semilla.address, d1.semilla.address, "el uso global desempata y los separa");
});

test("la decisión es REPRODUCIBLE: mismo historial, misma semilla", () => {
  const historial = [uso("x.com", "a@gmail.com", "5h"), uso("x.com", "c@yahoo.com", "1h")];
  const a = elegirSemillaRotada([GMAIL_A, GMAIL_B, YAHOO], "x.com", historial, AHORA);
  const b = elegirSemillaRotada([YAHOO, GMAIL_B, GMAIL_A], "x.com", historial, AHORA);
  assert.equal(a?.semilla.address, b?.semilla.address, "ni el orden de la lista cambia la decisión");
});

test("una sola semilla: se usa y se dice, sin fingir rotación", () => {
  const d = elegirSemillaRotada([GMAIL_A], "x.com", [uso("x.com", "a@gmail.com", "1h")], AHORA);
  assert.equal(d?.semilla.address, "a@gmail.com");
  assert.match(d!.motivo, /única semilla/);
});

test("sin semillas activas devuelve null en vez de inventar una", () => {
  assert.equal(elegirSemillaRotada([], "x.com", [], AHORA), null);
  assert.equal(elegirSemillaRotada([{ ...GMAIL_A, enabled: false }], "x.com", [], AHORA), null);
});

// ── Progreso del calentamiento ───────────────────────────────────────────────────────────────────

test("el progreso sale del PRIMER ENVÍO real, no de una fecha declarada", () => {
  const historial = [uso("x.com", "a@gmail.com", "3d"), uso("x.com", "b@gmail.com", "1h")];
  const p = progresoDeCalentamiento(historial, "x.com", 14, AHORA);
  assert.equal(p?.diasCorridos, 4, "día 1 es el día que arrancó, no 24h después");
  assert.equal(p?.vueltas, 2);
  assert.equal(p?.diasRestantes, 10);
});

test("sin envíos NO se inventa un día 1", () => {
  // Una rampa que dice "día 7" sin envíos detrás miente. Preferimos null.
  assert.equal(progresoDeCalentamiento([], "x.com", 14, AHORA), null);
});

test("sin plan declarado no se inventa una meta ni un ETA", () => {
  const p = progresoDeCalentamiento([uso("x.com", "a@gmail.com", "1h")], "x.com", null, AHORA);
  assert.equal(p?.diasPlan, null);
  assert.equal(p?.diasRestantes, null);
});

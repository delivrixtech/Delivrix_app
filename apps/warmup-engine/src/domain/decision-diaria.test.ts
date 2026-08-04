// Tests de la decisión diaria. Lo que protegen es el criterio, no el cálculo: que no se reaccione
// a ruido, que "flojo" baje en vez de frenar, que "malo" sí frene, y que el cupo físico del nodo
// sea una pared y no una sugerencia.

import assert from "node:assert/strict";
import test from "node:test";

import { decidirCupoDeHoy, CUPO_ARRANQUE, MUESTRA_MINIMA } from "./decision-diaria.ts";
import type { Placement } from "../live/warmup-live-cycle.ts";

const inbox = (n: number): Placement[] => Array.from({ length: n }, () => "INBOX" as const);
const spam = (n: number): Placement[] => Array.from({ length: n }, () => "SPAM" as const);

const base = { isoWeekday: 3 as const, cupoFisico: 20, cupoHace2Dias: 0 };

test("nodo frenado en Postfix: cupo 0, sin importar lo bueno que sea el placement", () => {
  // La pared es la pared. Decidir 12 contra un nodo en cap 0 solo produce rechazos.
  const d = decidirCupoDeHoy({ ...base, cupoFisico: 0, diaN: 10, placements: inbox(10) });
  assert.equal(d.cupo, 0);
  assert.equal(d.accion, "frenar");
  assert.match(d.motivo, /cap 0/);
});

test("primer día: arranca chico, no en el tope de la rampa", () => {
  const d = decidirCupoDeHoy({ ...base, diaN: 0, placements: [] });
  assert.equal(d.cupo, CUPO_ARRANQUE);
  assert.equal(d.accion, "arrancar");
});

test("NO se mueve el volumen con muestra insuficiente", () => {
  // Bajarle el volumen a un dominio por un correo en spam es ruido, no criterio.
  const d = decidirCupoDeHoy({ ...base, diaN: 8, placements: spam(MUESTRA_MINIMA - 1) });
  assert.equal(d.accion, "sostener");
  assert.match(d.motivo, /hacen falta/);
  assert.ok(d.cupo <= CUPO_ARRANQUE, "sin evidencia no se ramp-ea");
});

test("placement sano: la rampa avanza", () => {
  const d = decidirCupoDeHoy({ ...base, diaN: 5, placements: inbox(8) });
  assert.equal(d.accion, "subir");
  assert.equal(d.cupo, 10, "día 5 × paso 2");
  assert.equal(d.placement, 1);
});

test("placement flojo: BAJA a la mitad y SIGUE mandando, no frena", () => {
  // El punto que más se equivoca: un dominio que deja de mandar no recupera reputación, se queda
  // quieto. Lo que reconstruye es volumen bajo con buena señal.
  const d = decidirCupoDeHoy({ ...base, diaN: 10, placements: [...inbox(5), ...spam(5)] });
  assert.equal(d.accion, "bajar");
  assert.ok(d.cupo > 0, "sigue mandando");
  assert.ok(d.cupo < 20);
  assert.match(d.motivo, /se sigue mandando/);
});

test("placement malo de verdad: frena", () => {
  const d = decidirCupoDeHoy({ ...base, diaN: 10, placements: [...inbox(1), ...spam(9)] });
  assert.equal(d.accion, "frenar");
  assert.equal(d.cupo, 0);
});

test("el cupo del nodo recorta cualquier decisión, y se DECLARA el recorte", () => {
  const d = decidirCupoDeHoy({ ...base, cupoFisico: 5, diaN: 20, placements: inbox(10) });
  assert.equal(d.cupo, 5);
  assert.match(d.motivo, /recortado por el cupo del nodo/);
});

test("cupo del nodo desconocido: gobierna la rampa, y se DECLARA que no se sabe", () => {
  // Acá no corresponde fail-closed al mínimo: la barrera es FÍSICA y no depende de nosotros — si
  // nos pasamos, Postfix responde 450 y no sale un correo. Nuestro número no es el gate. Recortar
  // a 2 solo dejaría a un dominio sano del día 20 arrastrándose sin ninguna ganancia de seguridad.
  const d = decidirCupoDeHoy({ ...base, cupoFisico: null, diaN: 20, placements: inbox(10) });
  assert.equal(d.cupo, 40, "la rampa, que ya es un techo sano");
  assert.match(d.motivo, /desconocido/);
});

test("la decisión es reproducible: mismo estado, misma decisión", () => {
  const e = { ...base, diaN: 7, placements: [...inbox(6), ...spam(2)] };
  assert.deepEqual(decidirCupoDeHoy(e), decidirCupoDeHoy(e));
});


// ── El guarda de la continuación de hilos ────────────────────────────────────────────────────────
// Vivía inline en el daemon SIN un solo test, y ahí estaba el agujero más grave que encontró la
// auditoría: la continuación mandaba correo real esquivando la decisión del día.

import { puedeMandarTurno } from "./decision-diaria.ts";

const decision = (over: Partial<ReturnType<typeof decidirCupoDeHoy>> = {}) => ({
  cupo: 4, accion: "subir" as const, motivo: "test", placement: 0.9, ...over
});

test("un dominio FRENADO por placement no manda turno, aunque su nodo tenga cupo físico de sobra", () => {
  // El bug exacto: `frenados` solo tiene los que rebotaron con 450 contra el cap FÍSICO. Un dominio
  // con cap 20 en Postfix nunca aparece ahí, así que el guarda viejo lo dejaba pasar y seguía
  // emitiendo un turno por vuelta mientras el log decía "frenar · cupo 0/día".
  const r = puedeMandarTurno({
    dominio: "d.com", rebotadosHoy: new Set(), enviadosHoy: 0,
    decision: decision({ cupo: 0, accion: "frenar" })
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, /frenar/);
});

test("un dominio que ya cumplió su cupo NO recibe uno más por el camino de continuación", () => {
  // El caso frecuente: cupo 2, ya mandó 2, y la continuación metía el tercero. Todos los días.
  const r = puedeMandarTurno({
    dominio: "d.com", rebotadosHoy: new Set(), enviadosHoy: 2, decision: decision({ cupo: 2 })
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, /van 2/);
});

test("con cupo libre, sí manda", () => {
  const r = puedeMandarTurno({
    dominio: "d.com", rebotadosHoy: new Set(), enviadosHoy: 1, decision: decision({ cupo: 4 })
  });
  assert.equal(r.si, true);
  assert.match(r.motivo, /3 de cupo libre/);
});

test("el rebote físico sigue mandando: se chequea antes que nada", () => {
  const r = puedeMandarTurno({
    dominio: "d.com", rebotadosHoy: new Set(["d.com"]), enviadosHoy: 0, decision: decision({ cupo: 9 })
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, /rebotó hoy/);
});

// ── PROMOTIONS ───────────────────────────────────────────────────────────────────────────────────

test("PROMOTIONS cuenta como bandeja: un dominio sano en la pestaña no se frena", () => {
  // El diseño v1 (§9) dice textual que las pestañas cuentan como inbox, y placement.ts ya lo hacía
  // así. Contarlas como fallo daba tasa 0% y FRENABA un dominio cuya evidencia era buena.
  const p = Array.from({ length: 8 }, () => "PROMOTIONS" as const);
  const d = decidirCupoDeHoy({ ...base, diaN: 6, placements: p });
  assert.equal(d.placement, 1);
  assert.equal(d.accion, "subir");
});

test("OTHER NO cuenta como bandeja: archivado o etiquetado no es aterrizar", () => {
  const p = Array.from({ length: 8 }, () => "OTHER" as const);
  const d = decidirCupoDeHoy({ ...base, diaN: 6, placements: p });
  assert.equal(d.accion, "frenar");
});

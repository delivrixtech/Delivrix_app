// Tests de la decisión diaria. Lo que protegen es el criterio, no el cálculo: que no se reaccione
// a ruido, que "flojo" baje en vez de frenar, que "malo" sí frene, y que el cupo físico del nodo
// sea una pared y no una sugerencia.

import assert from "node:assert/strict";
import test from "node:test";

import { decidirCupoDeHoy, CUPO_ARRANQUE, MUESTRA_MINIMA, TECHO_DURO_POR_DOMINIO } from "./decision-diaria.ts";
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

/** Un dominio con historia: la regla de "no gastar la última medición" no le aplica. */
const CON_HISTORIA = MUESTRA_MINIMA;

test("un dominio FRENADO por placement no manda turno, aunque su nodo tenga cupo físico de sobra", () => {
  // El bug exacto: `frenados` solo tiene los que rebotaron con 450 contra el cap FÍSICO. Un dominio
  // con cap 20 en Postfix nunca aparece ahí, así que el guarda viejo lo dejaba pasar y seguía
  // emitiendo un turno por vuelta mientras el log decía "frenar · cupo 0/día".
  const r = puedeMandarTurno({
    dominio: "d.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 0, medicionesPropias: CON_HISTORIA,
    decision: decision({ cupo: 0, accion: "frenar" })
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, /frenar/);
});

test("un dominio que ya cumplió su cupo NO recibe uno más por el camino de continuación", () => {
  // El caso frecuente: cupo 2, ya mandó 2, y la continuación metía el tercero. Todos los días.
  const r = puedeMandarTurno({
    dominio: "d.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 2, medicionesPropias: CON_HISTORIA,
    decision: decision({ cupo: 2 })
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, /van 2/);
});

test("con cupo libre, sí manda", () => {
  const r = puedeMandarTurno({
    dominio: "d.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 1, medicionesPropias: CON_HISTORIA,
    decision: decision({ cupo: 4 })
  });
  assert.equal(r.si, true);
  assert.match(r.motivo, /3 de cupo libre/);
});

test("el rebote físico sigue mandando: se chequea antes que nada", () => {
  const r = puedeMandarTurno({
    dominio: "d.com", enElPool: true, rebotadosHoy: new Set(["d.com"]), enviadosHoy: 0, medicionesPropias: CON_HISTORIA,
    decision: decision({ cupo: 9 })
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, /rebotó hoy/);
});

// ── El turno de continuación no se come la MEDICIÓN del día ──────────────────────────────────────
//
// Un dominio nuevo tiene cupo 2/día y necesita MUESTRA_MINIMA mediciones propias para que la rampa
// lo deje subir. El envío principal mide dónde cayó; el "Re:" de continuación solo graba `sent`.
// Medido en producción el 2026-08-06: 18 envíos = 11 principales + 7 continuaciones, y tres de los
// cinco dominios nuevos (annualfilings-control.com, annualfilings-ops.com, statefilings-control.com)
// gastaron 1 de sus 2 envíos en un "Re:" y se quedaron con UNA medición en el día. A ese ritmo
// juntan las 4 en cuatro días; con el cupo bien repartido, en dos. No cuesta un correo más.

test("dominio nuevo (cupo 2, van 1, 1 medición): el turno NO se lleva el último envío del día", () => {
  const r = puedeMandarTurno({
    dominio: "annualfilings-ops.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 1,
    medicionesPropias: 1, decision: decision({ cupo: 2, accion: "sostener" })
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, /1 de 4 mediciones propias/);
  assert.match(r.motivo, /que MIDE dónde cayó/);
});

test("el MISMO dominio con las 4 mediciones ya juntadas SÍ continúa el hilo", () => {
  // La regla se apaga sola: no es un castigo permanente a la conversación multivuelta, que también
  // construye reputación. Aplicada a toda la flota le sacaría la mitad de los turnos a
  // corpfiling-infra.com, que hoy hace 4 continuaciones con 83% de bandeja.
  const r = puedeMandarTurno({
    dominio: "annualfilings-ops.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 1,
    medicionesPropias: MUESTRA_MINIMA, decision: decision({ cupo: 2, accion: "sostener" })
  });
  assert.equal(r.si, true);
});

test("REGRESIÓN: con cupo 2 y CERO enviados, el 'Re:' tampoco sale — se comía la primera medición", () => {
  // La primera versión de la regla era `medicionesPropias < MUESTRA_MINIMA && enviadosHoy + 1 >=
  // cupo`, o sea que solo atajaba el ÚLTIMO envío del día. Con cupo 2 y 0 enviados el "Re:" salía
  // igual — y sale seguido, porque `hilosParaContinuar` busca por SEMILLA y ventana de 7 días, no
  // por el box de la vuelta: el turno cae rutinariamente en un dominio que todavía no mandó hoy.
  // Resultado medido a 24 h sobre annualfilings-control.com: 1 continuación, 1 principal, 1
  // medición. La línea base que tiene que pasar a 0 | 2 | 2.
  const r = puedeMandarTurno({
    dominio: "annualfilings-control.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 0,
    medicionesPropias: 1, decision: decision({ cupo: 2, accion: "sostener" })
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, /1 de 4 mediciones propias/);
});

test("cupo 1 y sin mediciones: ese único envío es para el principal, que es el que mide", () => {
  const r = puedeMandarTurno({
    dominio: "nuevo.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 0,
    medicionesPropias: 0, decision: decision({ cupo: 1 })
  });
  assert.equal(r.si, false);
});

test("la EXCLUSIÓN POR SALUD también frena la continuación: un dominio fuera del pool no manda 'Re:'", () => {
  // `elegirPool` saca a los que cruzaron el umbral permanente, a los cerrados por el receptor y a
  // los de cola atascada. La continuación no lo miraba: busca hilos por semilla, así que un dominio
  // excluido —con cap > 0 y un hilo abierto de los últimos 7 días— seguía mandando un correo REAL
  // por vuelta, por su propio nodo. Es literalmente un dominio roto volviendo al pool por la puerta
  // de al lado. B2 pedía un techo "que ningún camino puede pasar"; éste lo pasaba.
  const r = puedeMandarTurno({
    dominio: "quemado.com", enElPool: false, rebotadosHoy: new Set(), enviadosHoy: 0,
    medicionesPropias: 10, decision: decision({ cupo: 20 })
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, /no está en el pool de hoy/);
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

// ── El invariante que junta las dos mitades ──────────────────────────────────────────────────────
// "Un dominio con cupo N manda como máximo N correos por día, contando el ciclo principal Y la
// continuación de hilos." Las dos mitades estaban bien por separado y el sistema igual mandaba de
// más, porque el contador que alimentaba a la segunda era la foto ANTERIOR al envío de la primera.

test("REGRESIÓN: el envío del ciclo principal cuenta para la continuación (cupo 2 ⇒ NO salen 3)", () => {
  const enviadosPorDominio = new Map<string, number>([["d.com", 1]]);
  const decision = decidirCupoDeHoy({
    diaN: 1, placements: ["INBOX", "INBOX", "INBOX", "INBOX"], cupoFisico: 20, isoWeekday: 2
  });
  assert.equal(decision.cupo, 2, "día 1 × paso 2 = 2, que es el caso real de hoy");

  // 1. El ciclo principal: van 1 de 2 ⇒ manda.
  const antes = enviadosPorDominio.get("d.com")!;
  assert.ok(antes < decision.cupo, "el gate del ciclo principal deja pasar");

  // 2. El envío SALIÓ. Sin esta línea (que es el fix), el paso 3 decide con `antes`.
  enviadosPorDominio.set("d.com", antes + 1);

  // 3. La continuación pregunta por el MISMO dominio, en la MISMA vuelta.
  const permiso = puedeMandarTurno({
    dominio: "d.com",
    enElPool: true, rebotadosHoy: new Set(),
    decision,
    enviadosHoy: enviadosPorDominio.get("d.com") ?? 0,
    medicionesPropias: 4
  });
  assert.equal(permiso.si, false, "con 2 de 2 no puede mandar el tercero");
  assert.match(permiso.motivo, /van 2/);
});

test("y si el envío principal FALLÓ, el cupo no se gasta", () => {
  // `brokeAt === "sent"` es el único caso en que mailer.send falló. Ahí no se incrementa, porque
  // cobrar cupo por un correo que no salió frenaría al dominio sin motivo.
  const enviadosPorDominio = new Map<string, number>([["d.com", 1]]);
  const decision = decidirCupoDeHoy({
    diaN: 1, placements: ["INBOX", "INBOX", "INBOX", "INBOX"], cupoFisico: 20, isoWeekday: 2
  });
  // no se incrementa. Las 4 mediciones son las mismas 4 placements con las que se armó la decisión:
  // este dominio ya tiene muestra, así que la regla del último envío no aplica.
  const permiso = puedeMandarTurno({
    dominio: "d.com", enElPool: true, rebotadosHoy: new Set(), decision,
    enviadosHoy: enviadosPorDominio.get("d.com") ?? 0, medicionesPropias: 4
  });
  assert.equal(permiso.si, true, "el cupo sigue disponible porque no salió nada");
});

// ── El techo duro por dominio: ningún camino lo pasa ─────────────────────────────────────────────
//
// Google clasifica como "bulk sender" al dominio que cruza 5.000/día a destinatarios personales, y
// esa clasificación es PERMANENTE. Los tres caminos que producen volumen son la rampa, la
// continuación de hilos y una orden que arme la decisión a mano; hay un test por cada uno.

test("techo duro · la RAMPA no lo pasa aunque la configuren en 9000/día", () => {
  const d = decidirCupoDeHoy({
    ...base, cupoFisico: null, diaN: 500, placements: inbox(10), limiteDiario: 9000, pasoPorDia: 100
  });
  assert.equal(d.cupo, TECHO_DURO_POR_DOMINIO);
  assert.match(d.motivo, /techo duro/);
});

test("techo duro · la CONTINUACIÓN cuenta contra el cupo clampeado, no contra el configurado", () => {
  const d = decidirCupoDeHoy({
    ...base, cupoFisico: null, diaN: 500, placements: inbox(10), limiteDiario: 9000, pasoPorDia: 100
  });
  const r = puedeMandarTurno({
    dominio: "d.com", enElPool: true, rebotadosHoy: new Set(), decision: d,
    enviadosHoy: TECHO_DURO_POR_DOMINIO, medicionesPropias: 10
  });
  assert.equal(r.si, false, "con el techo alcanzado, la continuación tampoco pasa");
});

test("techo duro · una ORDEN que arme la decisión a mano tampoco lo pasa", () => {
  // `puedeMandarTurno` recibe un objeto de quien sea. Clampear solo dentro de `decidirCupoDeHoy`
  // dejaba abierto justo el camino que no pasa por ella: un cupo 9999 escrito a mano habría
  // autorizado 9999 turnos. Un techo con una puerta al lado no es un techo.
  const r = puedeMandarTurno({
    dominio: "d.com", enElPool: true, rebotadosHoy: new Set(), decision: decision({ cupo: 9999 }),
    enviadosHoy: TECHO_DURO_POR_DOMINIO, medicionesPropias: 10
  });
  assert.equal(r.si, false);
  assert.match(r.motivo, new RegExp(`cupo ${TECHO_DURO_POR_DOMINIO}/día`));
});

test("techo duro · con los números de HOY no cambia un solo correo", () => {
  // La rampa por defecto topa en 40 y el cupo del nodo en 20: el clamp está muy por encima y no
  // toca ninguna decisión real. Existe para el día en que alguien escriba 9000 en gateway.env.
  const d = decidirCupoDeHoy({ ...base, diaN: 30, placements: inbox(10) });
  assert.equal(d.cupo, 20, "el cupo del nodo sigue mandando");
  assert.doesNotMatch(d.motivo, /techo duro/);
});

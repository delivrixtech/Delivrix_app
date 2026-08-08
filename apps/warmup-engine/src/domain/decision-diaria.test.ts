// Tests de la decisión diaria. Lo que protegen es el criterio, no el cálculo: que no se reaccione
// a ruido, que "flojo" baje en vez de frenar, que "malo" sí frene, y que el cupo físico del nodo
// sea una pared y no una sugerencia.

import assert from "node:assert/strict";
import test from "node:test";

import {
  cruzarEntregaConPlacement,
  decidirCupoDeHoy,
  evaluarGate,
  medirPlacement,
  medirPorProveedor,
  textoPlacement,
  textoPorProveedor,
  CUPO_ARRANQUE,
  MUESTRA_MINIMA,
  PISO_PARA_SUBIR,
  rampaDesdeEnv,
  TECHO_DURO_POR_DOMINIO,
  type FilaPlacement
} from "./decision-diaria.ts";
import { wilsonLowerBound } from "./placement.ts";
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

test("placement sano CON EVIDENCIA: la rampa avanza", () => {
  const d = decidirCupoDeHoy({ ...base, diaN: 5, placements: inbox(8) });
  assert.equal(d.accion, "subir");
  // La rampa del día 5 son 10/día, pero SIN el cupo autorizado de anteayer el clamp 3×/48h asume
  // el piso (CUPO_ARRANQUE) y topa en 6. Antes de ese cambio acá salían 10 — con el clamp
  // desconectado, que es como está la producción de hoy (0 de 54 filas `sent` con `cupoDelDia`).
  assert.equal(d.cupo, 6, "3× el piso del clamp, porque nadie sabe qué tenía autorizado anteayer");
  const conHistorial = decidirCupoDeHoy({ ...base, diaN: 5, placements: inbox(8), cupoAutorizadoHace2Dias: 10 });
  assert.equal(conHistorial.cupo, 10, "con el dato, la rampa entera del día 5 × paso 2");
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
  const d = decidirCupoDeHoy({ ...base, cupoFisico: null, diaN: 20, placements: inbox(10), cupoAutorizadoHace2Dias: 20 });
  assert.equal(d.cupo, 40, "la rampa, que ya es un techo sano");
  assert.match(d.motivo, /desconocido/);

  // Y sin saber qué tenía autorizado anteayer, el clamp fail-closed manda: 6, no 40. Las dos
  // incertidumbres se tratan distinto A PROPÓSITO — el cupo del nodo es una pared física que
  // responde 450 si nos pasamos, y el clamp es la única baranda contra la firma 3×/48h: perderla
  // no rebota nada, sólo deja salir el escalón.
  const sinSaberNada = decidirCupoDeHoy({ ...base, cupoFisico: null, diaN: 20, placements: inbox(10) });
  assert.equal(sinSaberNada.cupo, 6);
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
// El envío principal mide dónde cayó; el "Re:" de continuación solo graba `sent`, y cuando la
// respuesta SÍ se mide sale etiquetada `origen = 'continuación de hilo'`, que es justo lo que
// `filasDePlacement` (plan-diario.ts) EXCLUYE de la ventana. O sea: gasta cupo y no aporta una
// fila a la ventana que gobierna el volumen de ese dominio.
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
  assert.match(r.motivo, /en el piso de la rampa \(cupo 2\/día/);
  assert.match(r.motivo, /que MIDE dónde cayó/);
});

test("EL GATE DEL 'Re:' ES LA CONJUNCIÓN: en el piso Y SIN MUESTRA. Cortar solo por cupo apaga la flota entera", () => {
  // EL BUG QUE ESTE TEST EXISTE PARA IMPEDIR (encontrado por QA antes de desplegar, 2026-08-07).
  //
  // El corte se cambió de `medicionesPropias < MUESTRA_MINIMA` a `cupo <= CUPO_ARRANQUE` a secas, y
  // eso APAGA LA CONVERSACIÓN MULTIVUELTA EN TODA LA FLOTA por tiempo indefinido: los SEIS dominios
  // del pool están hoy en cupo 2 y ninguno sale de ahí solo —la rampa exige un piso de Wilson de
  // 0,60 y el mejor mide 0,51—, así que la condición de salida "cupo > 2" no la cumple nadie.
  // Corrido con el código real sobre las seis ventanas de producción: los SEIS daban `si:false`.
  //
  // El costo medido: las continuaciones son el 29% del correo que sale (2026-08-05: 11 principales
  // + 7 "Re:"; 08-06: 12 + 3), y el encargo era que la fábrica caliente MÁS. Encima el README del
  // motor dice que lo que calienta es el TRÁFICO REAL A DESTINATARIOS ENGAGED, y un "Re:" dentro de
  // un hilo vivo es lo más parecido a eso que la fábrica produce hoy. Apagarlo sin flag, sin alerta
  // y sin fecha de vuelta mata la función que la memoria del proyecto registra como recién arreglada.
  const conMuestra = puedeMandarTurno({
    dominio: "corpfiling-infra.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 0,
    medicionesPropias: 12, decision: decision({ cupo: 2, accion: "sostener" })
  });
  assert.equal(conMuestra.si, true, "corpfiling-infra.com: 12 mediciones y 83% de bandeja — éste ya se ganó conversar");

  // Y LO QUE SÍ SE PROTEGE, que es el caso realmente medido: el dominio nuevo que gasta en un "Re:"
  // la mitad de su día. `filasDePlacement` excluye la continuación de la ventana (`origen IS
  // DISTINCT FROM 'continuación de hilo'`), así que ese correo no le aporta una sola fila a la
  // ventana que gobierna su volumen — annualfilings-control.com terminó el día con 1 continuación,
  // 1 principal y UNA medición.
  const sinMuestra = puedeMandarTurno({
    dominio: "annualfilings-control.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 0,
    medicionesPropias: 2, decision: decision({ cupo: 2, accion: "sostener" })
  });
  assert.equal(sinMuestra.si, false);
  assert.match(sinMuestra.motivo, /le falta muestra/);
  assert.match(sinMuestra.motivo, /no entra a la ventana/, "el motivo nombra por qué el 'Re:' no sirve acá");

  // Las DOS salidas, y las dos son automáticas: juntar muestra, o que la rampa lo levante del piso.
  const yaGraduado = puedeMandarTurno({
    dominio: "annualfilings-control.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 0,
    medicionesPropias: 2, decision: decision({ cupo: 6, accion: "subir" })
  });
  assert.equal(yaGraduado.si, true);
});

test("justo en el borde: MUESTRA_MINIMA mediciones y cupo de arranque ⇒ ya puede continuar", () => {
  // El borde exacto de la conjunción. opscorpfiling.com está acá hoy (4 mediciones, cupo 2).
  const r = puedeMandarTurno({
    dominio: "opscorpfiling.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 1,
    medicionesPropias: MUESTRA_MINIMA, decision: decision({ cupo: CUPO_ARRANQUE + 1, accion: "sostener" })
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
  assert.match(r.motivo, /en el piso de la rampa/);
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
  //
  // El dominio de este test es uno YA GRADUADO (día 10, ventana limpia, cupo autorizado anteayer):
  // con uno en el piso el turno no sale igual, y el test no probaría nada sobre el contador.
  const enviadosPorDominio = new Map<string, number>([["d.com", 1]]);
  const decision = decidirCupoDeHoy({
    diaN: 10, placements: inbox(6), cupoFisico: 20, isoWeekday: 2, cupoAutorizadoHace2Dias: 6
  });
  assert.ok(decision.cupo > CUPO_ARRANQUE, "el dominio ya salió del piso");
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

// `cupoAutorizadoHace2Dias` va explícito en los tres: sin él, el clamp 3×/48h fail-closed topa en
// 6/día y el techo duro no llegaría a morder nunca — el test pasaría por la razón equivocada y
// dejaría de vigilar lo único que tiene que vigilar.
test("techo duro · la RAMPA no lo pasa aunque la configuren en 9000/día", () => {
  const d = decidirCupoDeHoy({
    ...base, cupoFisico: null, diaN: 500, placements: inbox(10), limiteDiario: 9000, pasoPorDia: 100,
    cupoAutorizadoHace2Dias: 9000
  });
  assert.equal(d.cupo, TECHO_DURO_POR_DOMINIO);
  assert.match(d.motivo, /techo duro/);
});

test("techo duro · la CONTINUACIÓN cuenta contra el cupo clampeado, no contra el configurado", () => {
  const d = decidirCupoDeHoy({
    ...base, cupoFisico: null, diaN: 500, placements: inbox(10), limiteDiario: 9000, pasoPorDia: 100,
    cupoAutorizadoHace2Dias: 9000
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
  const d = decidirCupoDeHoy({ ...base, diaN: 30, placements: inbox(10), cupoAutorizadoHace2Dias: 20 });
  assert.equal(d.cupo, 20, "el cupo del nodo sigue mandando");
  assert.doesNotMatch(d.motivo, /techo duro/);
});

// ── MISSING fuera del denominador, y el agujero que eso NO puede reabrir ─────────────────────────

const missing = (n: number): Placement[] => Array.from({ length: n }, () => "MISSING" as const);

test("MISSING sale del denominador: 3 INBOX + 1 MISSING es 100% sobre muestra 3, no 75% sobre 4", () => {
  // "No apareció en ninguna carpeta" no es "cayó en spam": es que no lo pudimos medir. El §9 del
  // propio diseño le da a `missing` un bucket propio, ni inbox ni spam. Y con la muestra de hoy —4—
  // una sola fila movía la tasa 25 puntos y con ella la decisión del día entero.
  const m = medirPlacement([...inbox(3), ...missing(1)]);
  assert.equal(m.muestra, 3);
  assert.equal(m.tasa, 1);
  assert.equal(m.tragados, 1);
});

test("todo MISSING no es 0% de bandeja: no hay muestra, y no se frena por eso", () => {
  const d = decidirCupoDeHoy({ ...base, diaN: 8, placements: missing(6) });
  assert.equal(d.placement, null, "null es 'no sé', y no se puede leer como cero");
  assert.equal(d.accion, "sostener");
  assert.match(d.motivo, /se tragaron/);
});

test("el correo tragado NO puede subir el volumen de nadie (el incidente del día 20)", () => {
  // El desastre textual del comentario de warmup-live-cycle.ts: "un dominio en día 20 manda 40,
  // Gmail se traga 36 y 4 llegan a INBOX". Con MISSING fuera del denominador eso da 4 de 4 = 100%,
  // y sería el único camino del sistema hacia MÁS volumen sobre la peor señal que existe. Con la
  // tasa CRUDA en la rama que frena, son 4 de 40 = 10% y para.
  const d = decidirCupoDeHoy({ ...base, diaN: 20, cupoFisico: 2000, placements: [...inbox(4), ...missing(36)] });
  assert.equal(d.accion, "frenar");
  assert.equal(d.cupo, 0);
  assert.match(d.motivo, /4 de 40 correos llegaron a bandeja \(36 se los tragaron/);
});

test("UN MISSING no puede sacar a un dominio del freno (ventana 6 de producción)", () => {
  // EL DEFECTO QUE ESTE TEST EXISTE PARA IMPEDIR, medido con un A/B de 8.820 combinaciones contra
  // la versión anterior: de las 2.626 donde la decisión nueva mandaba MÁS que la vieja, en las
  // 2.626 había un MISSING. Con MISSING fuera del denominador, [MISSING,SPAM,SPAM,SPAM,INBOX,INBOX]
  // pasaba de 33% (frenar) a 40% (bajar) y el dominio saltaba de cupo 0 a 20 correos/día — el único
  // camino nuevo hacia más volumen, y apuntando justo al receptor que nos manda a spam.
  const ventana: Placement[] = ["MISSING", "SPAM", "SPAM", "SPAM", "INBOX", "INBOX"];
  const d = decidirCupoDeHoy({ ...base, diaN: 20, cupoFisico: null, placements: ventana });
  assert.equal(d.accion, "frenar");
  assert.equal(d.cupo, 0);

  // Y el control: la misma ventana sin el tragado sigue dando lo mismo que daba antes.
  const sinTragado = decidirCupoDeHoy({ ...base, diaN: 20, cupoFisico: null, placements: ventana.slice(1) });
  assert.equal(sinTragado.accion, "bajar", "40% sobre 5 medidas: baja, no frena");
});

test("la señal de correo tragado TIENE que ser alcanzable con la ventana de producción", () => {
  // El hermano del test de Wilson, y por el mismo motivo. La regla vieja (`PISO_TRAGADOS`) exigía
  // 4 filas MEDIDAS *y* la mitad de tragados: con `WARMUP_LIVE_PLACEMENT_WINDOW=6` eso pide 3+4
  // sobre 6 filas, imposible. Su test la probaba con 40 placements, una ventana que
  // `placementsDeDominio` (LIMIT 6) no puede devolver: el fixture y el código compartían la
  // suposición. Con la tasa cruda, 2 tragados sobre 6 bastan para bajar el volumen.
  const perfectaSalvoTragados: Placement[] = [...missing(2), ...inbox(4)];
  const d = decidirCupoDeHoy({ ...base, diaN: 20, cupoFisico: 2000, placements: perfectaSalvoTragados });
  assert.equal(d.accion, "bajar", "4 de 6 = 67% crudo, debajo del piso sano");
  assert.match(d.motivo, /2 se los tragaron/);

  // Y con MÁS tragados no puede terminar mandando MÁS: la rama que baja nunca pasa a la que
  // sostiene por muestra corta.
  const masTragados = decidirCupoDeHoy({ ...base, diaN: 20, cupoFisico: 2000, placements: [...missing(4), ...inbox(2)] });
  assert.ok(masTragados.cupo <= d.cupo, `con 4 tragados no puede mandar más que con 2 (${masTragados.cupo} vs ${d.cupo})`);
});

// ── Wilson ASIMÉTRICO: subir exige prueba, bajar no ──────────────────────────────────────────────

test("4 de 4 NO dispara subir por la proporción cruda", () => {
  // El salto medido corriendo el código: el día que un dominio junta su CUARTA medición pasa de
  // `sostener 2` a la rampa entera — 2 → 8/10/12/14/16, de ×4 a ×8 en 24 horas. Con n=4, el 100%
  // crudo es compatible con una tasa real del 51%.
  const d = decidirCupoDeHoy({ ...base, diaN: 5, cupoHace2Dias: 2, placements: inbox(4) });
  assert.equal(d.accion, "sostener");
  assert.equal(d.cupo, 2, "se queda en lo que venía mandando, no salta a la rampa");
  assert.match(d.motivo, /el piso real puede ser/);
});

test("1 de 4 sigue bajando enseguida: la dirección segura no necesita prueba", () => {
  const d = decidirCupoDeHoy({ ...base, diaN: 10, placements: [...inbox(1), ...spam(3)] });
  assert.equal(d.accion, "frenar", "25% cruda está debajo del piso crítico y no espera evidencia");
});

test("sostener no castiga a un dominio sano: mantiene el volumen que ya tenía", () => {
  // Bajarlo al cupo de arranque sería castigarlo por no haber juntado muestra todavía, que es lo
  // contrario de lo que se busca.
  const d = decidirCupoDeHoy({
    ...base, diaN: 20, cupoFisico: 2000, cupoAutorizadoHace2Dias: 14, cupoHace2Dias: 14, placements: inbox(5)
  });
  assert.equal(d.accion, "sostener");
  assert.equal(d.cupo, 14);
});

test("SOSTENER DEJA DE DEMOTAR: el piso es el cupo AUTORIZADO, no los correos que salieron", () => {
  // EL BUG QUE ESTE TEST EXISTE PARA IMPEDIR, y es el mismo error que este archivo ya diagnosticó
  // y arregló para el clamp 3×/48h treinta líneas más arriba: quedó vivo dos líneas más abajo.
  //
  // `cupoHace2Dias` son los correos que SALIERON, y los que salen están topados por un límite
  // GLOBAL del daemon (`WARMUP_LIVE_MAX_PER_DAY=14` para TODA la flota, verificado en el
  // gateway.env de la Studio): dan 1-8 y casi siempre 2. Un dominio ya autorizado a 20/día que
  // saca 5 de 6 (83%) caía a cupo 2 porque anteayer MANDÓ 2 — 'sostener' nunca sostenía, hacía
  // sierra 20→2→6→6→18→20→2 mientras el panel decía "sostener".
  const autorizado20 = decidirCupoDeHoy({
    ...base, diaN: 20, cupoFisico: 2000, placements: inbox(5),
    cupoAutorizadoHace2Dias: 20, cupoHace2Dias: 2
  });
  assert.equal(autorizado20.accion, "sostener", "wilson(5,5)=0,57 no cruza el piso para subir");
  assert.equal(autorizado20.cupo, 20, "sostiene lo que tenía AUTORIZADO, no lo que el sobre global lo dejó mandar");

  // Sin el dato del autorizado se cae al enviado, que es la única memoria que queda: peor, pero
  // mejor que arrancar de cero. Es el estado de la producción de hoy.
  const soloEnviado = decidirCupoDeHoy({ ...base, diaN: 20, cupoFisico: 2000, placements: inbox(5), cupoHace2Dias: 2 });
  assert.equal(soloEnviado.cupo, 2);
});

// ── El clamp 3×/48h NO se alimenta de los envíos ─────────────────────────────────────────────────

test("el clamp no se alimenta de los ENVÍOS: frenaba a los sanos y soltaba a los que no mandaron", () => {
  // MEDIDO CONTRA LA BASE DE PRODUCCIÓN el 2026-08-07. `cupoHace2Dias` son envíos REALES, y los
  // envíos reales están topados por WARMUP_LIVE_MAX_PER_DAY (14 vueltas para TODA la flota), así
  // que por dominio dan 1-8. Con eso como base del clamp:
  //   · corpfiling-infra.com (el más sano, 83% de bandeja) mandó 1 el 05-ago ⇒ techo 3/día;
  //   · opscorpfiling.com mandó 0 ese día ⇒ ausente del Map ⇒ sin clamp, rampa entera.
  // Y se realimentaba: el plan quedaba fijo en 3-6/día para siempre mientras `accion` decía "subir".
  const sano = decidirCupoDeHoy({ ...base, diaN: 10, cupoFisico: 20, cupoHace2Dias: 1, placements: inbox(6) });
  const mudo = decidirCupoDeHoy({ ...base, diaN: 10, cupoFisico: 20, placements: inbox(6) });
  assert.equal(sano.accion, "subir");
  assert.equal(
    sano.cupo,
    mudo.cupo,
    "haber mandado 1 correo hace dos días no puede dejarte con MENOS cupo que no haber mandado ninguno"
  );
  // 6 = 3× el PISO del clamp (`CUPO_ARRANQUE`), que es lo que se asume cuando no se sabe qué tenía
  // autorizado anteayer. Lo que este test fija es que NO sea 3 (3× el correo que salió), que es lo
  // que daba con los envíos adentro del clamp.
  assert.equal(sano.cupo, 6, "el múltiplo sale del piso del clamp, jamás de lo que salió");
  assert.notEqual(sano.cupo, 3);
});

// ── LA MONOTONÍA: peor placement NUNCA manda más correo ──────────────────────────────────────────

test("INVARIANTE: a peor placement, cupo no creciente (la escalera entera, no un caso suelto)", () => {
  // EL BUG QUE ESTE TEST EXISTE PARA IMPEDIR, y ya se había shipeado. Con la ventana de producción
  // (WARMUP_LIVE_PLACEMENT_WINDOW=6, verificado por ssh en el gateway.env de la Studio):
  //
  //   5 INBOX / 1 SPAM (83%) → sostener  2/día        ← el que entrega BIEN
  //   4 INBOX / 2 SPAM (67%) → bajar    20/día        ← DIEZ VECES MÁS, el que entrega PEOR
  //
  // porque `bajar` valía `rampa/2` (crece con el día) y `sostener` está anclado a `cupoHace2Dias`,
  // que son ENVÍOS REALES aplastados por el tope GLOBAL del daemon (1-8, casi siempre 2). No es un
  // número de panel: `live-warmup-daemon` gatea el envío real con `enviadosHoyBox >= delDia.cupo`,
  // así que el presupuesto del día se corría hacia el dominio que peor entrega — el mecanismo exacto
  // que empuja al umbral permanente de Gmail.
  //
  // Un test de casos sueltos no iba a ver esto nunca: lo que falla es la RELACIÓN entre dos ramas.
  // Por eso se recorre la escalera entera, en toda la rampa, con SPAM y con MISSING (los dos bajan
  // la tasa cruda) y con varios valores de lo que mandó anteayer.
  // EL PISO NUEVO VA ADENTRO DEL BARRIDO. `sostenido` pasó a anclarse en `cupoAutorizadoHace2Dias`
  // (que puede ser MUCHO más grande que los envíos: 20 contra 2) y `bajar` está topado por él, así
  // que la relación entre las dos ramas se recalcula con el cambio. Se recorre con el campo
  // presente Y ausente, porque el estado de la producción de hoy es el ausente.
  const VENTANA_DE_PRODUCCION = 6;
  const tragado = (n: number): Placement[] => Array.from({ length: n }, () => "MISSING" as const);

  for (const diaN of [4, 8, 12, 20, 40]) {
    for (const cupoHace2Dias of [0, 1, 2, 8, 14]) {
      for (const autorizado of [undefined, 0, 2, 20, 200]) {
        for (const malos of [spam, tragado]) {
          let previo = Number.POSITIVE_INFINITY;
          for (let bien = VENTANA_DE_PRODUCCION; bien >= 0; bien--) {
            const placements = [...inbox(bien), ...malos(VENTANA_DE_PRODUCCION - bien)];
            const d = decidirCupoDeHoy({
              ...base, diaN, cupoFisico: 2000, cupoHace2Dias, placements,
              ...(autorizado === undefined ? {} : { cupoAutorizadoHace2Dias: autorizado })
            });
            assert.ok(
              d.cupo <= previo,
              `día ${diaN}, anteayer envió ${cupoHace2Dias} / autorizado ${autorizado}: ` +
                `${bien}/${VENTANA_DE_PRODUCCION} en bandeja dio ${d.accion} ${d.cupo}/día, MÁS que el ` +
                `${bien + 1}/${VENTANA_DE_PRODUCCION} anterior (${previo}/día)`
            );
            previo = d.cupo;
          }
        }
      }
    }
  }
});

test("HOY NO CAMBIA UN SOLO CUPO: los seis dominios del pool siguen en 2/día", () => {
  // LA LÍNEA BASE, y es la que hace que este lote se pueda shipear sin autorización de volumen.
  // Las seis ventanas REALES de producción, leídas de la Postgres viva el 2026-08-07, con el cap
  // físico de 20 que tienen instalado y SIN `cupoAutorizadoHace2Dias` (0 de 54 filas `sent` de toda
  // la historia lo llevan, así que ése es el estado de hoy, no una hipótesis).
  //
  // Si alguno de estos seis se mueve, alguien cambió una regla de VOLUMEN sin decirlo — que es
  // exactamente lo que este lote tiene prohibido hacer.
  const HOY: { dominio: string; diaN: number; placements: Placement[] }[] = [
    { dominio: "corpfiling-infra.com", diaN: 5, placements: [...inbox(5), ...spam(1)] },          // 83%
    { dominio: "annualcorp-infra.com", diaN: 4, placements: [...inbox(3), ...spam(2)] },          // 60%
    { dominio: "annualfilings-control.com", diaN: 3, placements: [...inbox(2), ...spam(2)] },     // 50%
    { dominio: "annualfilings-ops.com", diaN: 3, placements: [...inbox(2), ...spam(2)] },         // 50%
    { dominio: "opscorpfiling.com", diaN: 2, placements: [...inbox(3), ...spam(1)] },             // 75%
    { dominio: "statefilings-control.com", diaN: 2, placements: inbox(3) }                        // 3 mediciones
  ];
  for (const d of HOY) {
    const decision = decidirCupoDeHoy({
      isoWeekday: 5, cupoFisico: 20, diaN: d.diaN, placements: d.placements, cupoHace2Dias: 2
    });
    assert.equal(decision.cupo, CUPO_ARRANQUE, `${d.dominio} salió con ${decision.cupo}/día (${decision.accion})`);
  }
});

test("el techo irreversible gana sobre TODO, incluso sobre una rampa configurada absurda", () => {
  const d = decidirCupoDeHoy({
    ...base, diaN: 400, cupoFisico: null, cupoHace2Dias: 9000, cupoAutorizadoHace2Dias: 9000,
    limiteDiario: 50_000, pasoPorDia: 500, placements: inbox(20)
  });
  assert.equal(d.cupo, TECHO_DURO_POR_DOMINIO);
});

test("el gate de Wilson TIENE que ser alcanzable con la ventana de producción", () => {
  // EL BUG QUE ESTE TEST EXISTE PARA IMPEDIR, y estuvo a punto de shipearse: producción corre con
  // WARMUP_LIVE_PLACEMENT_WINDOW=6 (verificado en gateway.env de la Mac Studio), o sea que la
  // muestra tiene 6 filas como máximo. `wilsonLowerBound(6,6)` da 0,6096: contra PISO_SANO (0,70)
  // el gate es MATEMÁTICAMENTE inalcanzable, "subir" no vuelve a ocurrir nunca, y la fábrica deja
  // de crecer sin que nada falle ni nadie se entere. La peor clase de bug de este proyecto.
  const VENTANA_DE_PRODUCCION = 6;
  assert.ok(
    (wilsonLowerBound(VENTANA_DE_PRODUCCION, VENTANA_DE_PRODUCCION) ?? 0) >= PISO_PARA_SUBIR,
    "una ventana PERFECTA tiene que poder cruzar el piso, o la rampa está muerta"
  );
  const d = decidirCupoDeHoy({ ...base, diaN: 5, placements: inbox(VENTANA_DE_PRODUCCION) });
  assert.equal(d.accion, "subir");
});

// ══ EL CLAMP ANTI-FIRMA VUELVE A TENER ENTRADA (§10) ═════════════════════════════════════════════

test("clamp 3×/48h: el cupo AUTORIZADO de anteayer topa la rampa de hoy", () => {
  // EL AGUJERO QUE ESTO CIERRA: `dailyQuota` implementa el clamp desde el diseño v1 y NUNCA tuvo
  // entrada — el dato que pide (el cupo AUTORIZADO de hace dos días) no se persistía en ningún
  // lado, y el comentario del código lo declaraba. Sin él, el día que un dominio junta su cuarta
  // medición pasa de 2 a la rampa entera: 2 → 20 en 24 h, que es exactamente la firma que el clamp
  // existe para evitar.
  const conClamp = decidirCupoDeHoy({ ...base, diaN: 10, placements: inbox(6), cupoAutorizadoHace2Dias: 2 });
  const sinTope = decidirCupoDeHoy({ ...base, diaN: 10, placements: inbox(6), cupoAutorizadoHace2Dias: 20 });
  assert.equal(sinTope.cupo, 20, "la rampa del día 10 con paso 2 son 20/día, y 3×20 no la toca");
  assert.equal(conClamp.cupo, 6, "3× lo autorizado hace 2 días, ni uno más");
  assert.ok(conClamp.cupo < sinTope.cupo, "el clamp SOLO puede bajar");
});

test("EL CLAMP NO PUEDE DESAPARECER POR FALTA DE DATO", () => {
  // EL AGUJERO QUE ESTE TEST EXISTE PARA IMPEDIR, y es el estado exacto de la producción de hoy.
  // `dailyQuota` (ramp.ts:88-94) sólo clampea `if (twoDaysAgo > 0)`: SIN el dato, la válvula
  // anti-firma 3×/48h falla ABIERTA. Y el dato no está — medido contra la Postgres viva el
  // 2026-08-07: de las 54 filas `sent` de TODA la historia de warmup_activity, las que llevan
  // `detail.cupoDelDia` son CERO. El árbol desplegado es eb6b373 y el daemon que lo graba se
  // relanzó a las 17:59:27 hora local de ese mismo día: la baranda es código nuevo sin una sola
  // vuelta de evidencia, justo antes de que la rampa se destrabe.
  //
  // Antes de este cambio, este caso daba 20 (la rampa entera del día 10). Ahora da 6.
  const sinDato = decidirCupoDeHoy({ ...base, diaN: 20, placements: inbox(6) });
  assert.ok(sinDato.cupo <= 6, `sin dato el clamp asume el piso: ${sinDato.cupo}/día`);
  const conDato = decidirCupoDeHoy({ ...base, diaN: 20, placements: inbox(6), cupoAutorizadoHace2Dias: 2 });
  assert.equal(conDato.cupo, 6, "3× el autorizado de anteayer");

  // Y el hueco NO se cierra solo cuando el daemon empiece a grabar: con 6 dominios rotando, el que
  // no mandó hace dos días vuelve a quedar sin dato. Por eso el piso y no un "ya lo va a grabar".
  const ausente = decidirCupoDeHoy({ ...base, diaN: 20, placements: inbox(6), cupoAutorizadoHace2Dias: undefined });
  assert.equal(ausente.cupo, 6);
});

test("clamp: el 0 se trata como falta de dato, no como freno permanente", () => {
  // `dailyQuota` no puede multiplicar desde 0 (un dominio frenado anteayer no tendría por dónde
  // recuperarse), así que el 0 cae al mismo piso que la ausencia: 3×CUPO_ARRANQUE = 6/día. Lo que
  // este test impide es lo de siempre por los dos lados — que el 0 vuelva a significar "sin techo"
  // (fail-open) y que alguien lo "arregle" convirtiéndolo en cupo 0 permanente, que sería una
  // trampa de la que un dominio no sale nunca.
  const cero = decidirCupoDeHoy({ ...base, diaN: 10, placements: inbox(6), cupoAutorizadoHace2Dias: 0 });
  const ausente = decidirCupoDeHoy({ ...base, diaN: 10, placements: inbox(6) });
  assert.equal(cero.cupo, ausente.cupo);
  assert.equal(cero.cupo, 6);
  // Un valor negativo o NaN (el campo sale de un `detail->>'cupoDelDia'` parseado) tampoco abre la
  // puerta: con `||` a secas el negativo es truthy, `clampNonNegativeInt` lo baja a 0 y el clamp
  // desaparece — el mismo fail-open, entrando por el costado.
  const roto = decidirCupoDeHoy({ ...base, diaN: 10, placements: inbox(6), cupoAutorizadoHace2Dias: -5 });
  assert.equal(roto.cupo, 6);
  const nan = decidirCupoDeHoy({ ...base, diaN: 10, placements: inbox(6), cupoAutorizadoHace2Dias: Number.NaN });
  assert.equal(nan.cupo, 6);
});

test("el clamp NO se alimenta de los ENVÍOS: son dos datos distintos y se confundieron una vez", () => {
  // `cupoHace2Dias` son correos que SALIERON, aplastados por el tope GLOBAL del daemon (14 vueltas
  // para toda la flota): da 1-8 y casi siempre 2, sin relación con lo que el dominio tenía
  // permitido. Usarlo como base del clamp frenaba a los sanos (corpfiling-infra.com mandó 1 el
  // 05-ago ⇒ techo 3/día) y soltaba a los que no mandaron nada. Este test fija que los dos campos
  // gobiernan cosas DISTINTAS y que nadie los vuelva a unir.
  const soloEnvios = decidirCupoDeHoy({ ...base, diaN: 10, placements: inbox(6), cupoHace2Dias: 1 });
  const sinNada = decidirCupoDeHoy({ ...base, diaN: 10, placements: inbox(6) });
  assert.equal(soloEnvios.cupo, sinNada.cupo, "para el clamp, los envíos NO son dato: es como no traer nada");
  assert.notEqual(soloEnvios.cupo, 3, "3 = 3×1 correo enviado, que es el clamp mal alimentado");
});

test("días hábiles: la palanca existía en dailyQuota y estaba escrita a mano en `false`", () => {
  // §3 del doc lista "días hábiles" entre los levers y `dailyQuota` lo soporta desde el diseño v1,
  // pero los DOS llamadores lo tenían hardcodeado: no había forma de encenderlo sin tocar código.
  // Sólo puede BAJAR el volumen (sábado y domingo dan 0), que es la única dirección que este lote
  // tiene permitido mover.
  // `cupoAutorizadoHace2Dias` explícito para que el clamp fail-closed no tape lo que este test mide:
  // sin él los tres casos darían 6 y el sábado apagado no se distinguiría del martes.
  const yaCalentando = { ...base, diaN: 10, placements: inbox(6), cupoAutorizadoHace2Dias: 20 };
  const sabado = decidirCupoDeHoy({ ...yaCalentando, isoWeekday: 6, soloDiasHabiles: true });
  assert.equal(sabado.cupo, 0);
  const martes = decidirCupoDeHoy({ ...yaCalentando, isoWeekday: 2, soloDiasHabiles: true });
  assert.equal(martes.cupo, 20, "de lunes a viernes no cambia nada");
  const sinPalanca = decidirCupoDeHoy({ ...yaCalentando, isoWeekday: 6 });
  assert.equal(sinPalanca.cupo, 20, "y apagada, el sábado sigue mandando como hoy");
});

// ══ TODA CIFRA DE PLACEMENT LLEVA SU PROVEEDOR (B2) ══════════════════════════════════════════════

const REGISTRO: Record<string, string> = {
  "trazosvercel@gmail.com": "gmail",
  "flomia33193@gmail.com": "gmail",
  "alguien@outlook.com": "outlook"
};
const proveedorDe = (s: string): string | null => REGISTRO[s] ?? null;
const fila = (placement: Placement, semilla: string): FilaPlacement => ({ placement, semilla });

test("la cifra sale CON su receptor: nunca 'placement 70%' a secas", () => {
  // El "83% inbox" que el jefe leyó era 83%-EN-GMAIL presentado como placement a secas. Verificado
  // contra la Postgres de producción el 2026-08-07: las 24 filas `measured` de los últimos 10 días
  // salen de dos semillas y las dos son Gmail.
  const filas = [
    ...Array.from({ length: 7 }, () => fila("INBOX", "trazosvercel@gmail.com")),
    ...Array.from({ length: 3 }, () => fila("SPAM", "flomia33193@gmail.com"))
  ];
  const m = medirPorProveedor(filas, proveedorDe);
  assert.equal(m.proveedor, "gmail");
  assert.equal(m.muestra, 10);
  assert.equal(textoPlacement(m), "placement Gmail 70% sobre 10 mediciones");
  assert.doesNotMatch(textoPlacement(m), /^placement \d/, "una tasa sin receptor no puede salir del motor");
});

test("Outlook y Yahoo salen 'no sé', NUNCA 0% — 'no medido' y 'cero' no son lo mismo", () => {
  // Es la confusión más cara del sistema. Un Outlook en 0% se lee como "todo nuestro correo va a
  // spam en Outlook" y dispararía un freno sobre evidencia que no existe; un Outlook en `no sé`
  // dice la verdad, que es que no tenemos semilla ahí.
  const m = medirPorProveedor(inbox(4).map((p) => fila(p, "trazosvercel@gmail.com")), proveedorDe);
  const outlook = m.porProveedor.find((p) => p.proveedor === "outlook")!;
  const yahoo = m.porProveedor.find((p) => p.proveedor === "yahoo")!;
  assert.equal(outlook.tasa, null, "no medido es null");
  assert.equal(outlook.muestra, 0);
  assert.notEqual(outlook.tasa, 0, "cero sería una medición, y no la hay");
  assert.match(textoPorProveedor(outlook), /Outlook: no sé/);
  assert.match(textoPorProveedor(yahoo), /Yahoo: no sé/);
  assert.equal(textoPorProveedor(m.porProveedor.find((p) => p.proveedor === "gmail")!), "Gmail 100% sobre 4");
});

test("sin ninguna medición el proveedor es null, no un 'gmail' adivinado", () => {
  const m = medirPorProveedor([], proveedorDe);
  assert.equal(m.proveedor, null);
  assert.equal(m.tasa, null);
  assert.equal(textoPlacement(m), "placement no sé (todavía sin mediciones)");
});

test("una semilla fuera del registro cae en 'desconocido', no en gmail", () => {
  // Con el default silencioso, borrar una semilla del registro habría movido sus mediciones al
  // montón del proveedor equivocado sin que nada fallara.
  const m = medirPorProveedor([fila("INBOX", "fantasma@nadie.com")], proveedorDe);
  assert.equal(m.proveedor, "desconocido");
});

test("dos receptores distintos ⇒ 'varios', y la agregada sigue siendo la MISMA que decide", () => {
  const filas = [fila("INBOX", "trazosvercel@gmail.com"), fila("SPAM", "alguien@outlook.com")];
  const m = medirPorProveedor(filas, proveedorDe);
  assert.equal(m.proveedor, "varios");
  // La agregada no puede divergir de `medirPlacement`: el panel mostrando 75% sobre una decisión
  // tomada con 100% es peor que no mostrar nada.
  assert.equal(m.tasa, medirPlacement(filas.map((f) => f.placement)).tasa);
});

test("MISSING sale del denominador TAMBIÉN por proveedor", () => {
  // Si la cuenta por receptor usara otra regla que la agregada, el panel diría un número y la
  // decisión otro. Dos cuentas del mismo hecho es cómo se desincronizan.
  const filas = [fila("INBOX", "trazosvercel@gmail.com"), fila("MISSING", "trazosvercel@gmail.com")];
  const gmail = medirPorProveedor(filas, proveedorDe).porProveedor.find((p) => p.proveedor === "gmail")!;
  assert.equal(gmail.muestra, 1);
  assert.equal(gmail.tasa, 1);
});

// ══ EL GATE DE §3 COMO DATO EVALUADO (B1) ════════════════════════════════════════════════════════

test("el gate aplica el umbral DEL PROVEEDOR QUE MIDIÓ, no un promedio", () => {
  // §3 pide ≥95% en Gmail y ≥90% en Outlook. Un 92% pasa en Outlook y NO pasa en Gmail: sin el
  // proveedor al lado, el mismo número da dos veredictos opuestos y no hay forma de saber cuál.
  const enGmail = medirPorProveedor(
    [...inbox(11).map((p) => fila(p, "trazosvercel@gmail.com")), fila("SPAM", "trazosvercel@gmail.com")],
    proveedorDe
  );
  const g = evaluarGate({ placement: enGmail });
  assert.equal(g.umbral, 0.95);
  assert.equal(g.pasa, false);
  assert.match(g.condicionQueFalla!, /placement Gmail 92% sobre 12 mediciones/);
  assert.match(g.condicionQueFalla!, /§3 pide 95%/);

  // EL MISMO 92%, otro receptor, veredicto OPUESTO. Sin el proveedor al lado, el número no se puede
  // comparar contra ningún umbral: ésa es la razón por la que B2 tiene que existir antes que B1.
  const enOutlook = medirPorProveedor(
    [...inbox(11).map((p) => fila(p, "alguien@outlook.com")), fila("SPAM", "alguien@outlook.com")],
    proveedorDe
  );
  const o = evaluarGate({ placement: enOutlook });
  assert.equal(o.umbral, 0.9);
  assert.equal(o.pasa, true, "92% pasa el umbral de Outlook aunque no pase el de Gmail");
});

test("con DOS receptores, cada uno pasa el SUYO: una tasa promediada daba PASA falso", () => {
  // EL DEFECTO QUE ESTE TEST HABRÍA CAZADO: el umbral se elegía por proveedor (`Math.max` sobre los
  // que midieron) y se comparaba contra `placement.tasa`, que es la tasa AGREGADA de todos juntos.
  // Gmail 9/10 (90%, por debajo de su propio 95%) + Outlook 10/10 (100%) ⇒ pooled 95% ⇒ pasa=true,
  // cuando §3 evaluado sobre Gmail dice que no. Y un PASA falso alimenta la propuesta de SUBIR
  // volumen, que es lo irreversible.
  //
  // Hoy no dispara en producción porque las dos semillas que miden son Gmail: está armado esperando
  // a la primera semilla de Outlook.
  const filas = [
    ...inbox(9).map((p) => fila(p, "trazosvercel@gmail.com")),
    fila("SPAM", "trazosvercel@gmail.com"),
    ...inbox(10).map((p) => fila(p, "alguien@outlook.com"))
  ];
  const m = medirPorProveedor(filas, proveedorDe);
  assert.equal(m.tasa, 0.95, "la agregada da justo el umbral de Gmail: por eso el defecto pasaba");
  const g = evaluarGate({ placement: m, entregadosMta: 100, rechazadosMta: 0 });
  assert.equal(g.pasa, false, "Gmail al 90% no pasa aunque Outlook esté al 100%");
  assert.match(g.condicionQueFalla!, /placement Gmail 90% sobre 10 mediciones/, "y NOMBRA cuál falló");
  assert.equal(g.proveedor, "gmail", "el proveedor que se reporta es el dueño del umbral aplicado");
  assert.equal(g.umbral, 0.95);

  // Y al revés: el que falla es Outlook y el mensaje tampoco puede decir "varios receptores 50%",
  // que esconde de quién es el problema.
  const alReves = medirPorProveedor(
    [...inbox(10).map((p) => fila(p, "trazosvercel@gmail.com")), ...spam(10).map((p) => fila(p, "alguien@outlook.com"))],
    proveedorDe
  );
  const o = evaluarGate({ placement: alReves, entregadosMta: 100, rechazadosMta: 0 });
  assert.equal(o.pasa, false);
  assert.match(o.condicionQueFalla!, /placement Outlook 0% sobre 10 mediciones/);
  assert.doesNotMatch(o.condicionQueFalla!, /varios receptores/);

  // Los dos por encima del suyo SÍ pasan: la regla es "todos el suyo", no "el más exigente sobre
  // el promedio" ni "alguno alcanza".
  const losDos = medirPorProveedor(
    [...inbox(10).map((p) => fila(p, "trazosvercel@gmail.com")), ...inbox(10).map((p) => fila(p, "alguien@outlook.com"))],
    proveedorDe
  );
  assert.equal(evaluarGate({ placement: losDos, entregadosMta: 100, rechazadosMta: 0 }).pasa, true);
});

test("el llamador SIN porProveedor se evalúa igual que antes: su tasa es de un receptor o de ninguno", () => {
  // La firma permite pasar un placement pelado y hay que seguir sosteniéndolo: ahí agregada y por
  // proveedor son el mismo número, así que comparar contra el umbral del proveedor es correcto.
  const g = evaluarGate({ placement: { proveedor: "gmail", tasa: 0.9, muestra: 10 } });
  assert.equal(g.pasa, false);
  assert.match(g.condicionQueFalla!, /§3 pide 95% para Gmail/);
});

test("el gate PASA cuando la evidencia da: 24 de 24 en Gmail", () => {
  const m = medirPorProveedor(inbox(24).map((p) => fila(p, "trazosvercel@gmail.com")), proveedorDe);
  const g = evaluarGate({ placement: m });
  assert.equal(g.pasa, true);
  assert.equal(g.condicionQueFalla, null);
});

test("sin muestra el gate NO pasa, y lo dice: no sé ≠ está mal", () => {
  const m = medirPorProveedor([fila("INBOX", "trazosvercel@gmail.com")], proveedorDe);
  const g = evaluarGate({ placement: m });
  assert.equal(g.pasa, false);
  assert.match(g.condicionQueFalla!, /sin muestra suficiente: 1 de 4/);
});

test("cruzar el umbral permanente gana sobre cualquier placement", () => {
  // Es irreversible: calentarlo no lo recupera, sólo gasta cupo. Va primero a propósito.
  const m = medirPorProveedor(inbox(24).map((p) => fila(p, "trazosvercel@gmail.com")), proveedorDe);
  const g = evaluarGate({ placement: m, cruzoUmbralPermanente: true });
  assert.equal(g.pasa, false);
  assert.match(g.condicionQueFalla!, /umbral permanente/);
});

test("rebotes por encima del 2% frenan el gate ANTES de mirar el placement", () => {
  // §3: bounce <2%. Un dominio puede tener 100% de bandeja en la semilla y estar rebotando contra
  // el resto del receptor — la semilla es una dirección, no el universo.
  const m = medirPorProveedor(inbox(24).map((p) => fila(p, "trazosvercel@gmail.com")), proveedorDe);
  const g = evaluarGate({ placement: m, entregadosMta: 90, rechazadosMta: 10 });
  assert.equal(g.pasa, false);
  assert.match(g.condicionQueFalla!, /rebotes 10% sobre 100 intentos/);
});

test("lo que el motor NO mide se DECLARA, nunca se asume bueno", () => {
  // Ausencia de dato no es evidencia de que algo está bien. El gate dice, en su propia salida, qué
  // umbrales de §3 no pudo evaluar: complaint rate (no hay ingesta de FBL), "sostenido 2-3 días"
  // (la ventana es de N mediciones, no una serie diaria) y listas negras (el chequeo existe en
  // checks/ip-network-checks.ts y ningún camino del plan lo llama).
  const m = medirPorProveedor(inbox(24).map((p) => fila(p, "trazosvercel@gmail.com")), proveedorDe);
  const g = evaluarGate({ placement: m });
  assert.ok(g.sinInstrumento.some((s) => /complaint/.test(s)));
  assert.ok(g.sinInstrumento.some((s) => /sostenido/.test(s)));
  assert.ok(g.sinInstrumento.some((s) => /listas negras/.test(s)));
  assert.ok(g.sinInstrumento.some((s) => /rebotes/.test(s)), "sin dato del MTA, los rebotes son 'no sé'");
});

test("EL GATE NO TOCA EL CUPO — sólo informa, y la distancia entre las dos varas es ENORME", () => {
  // Cablearlo a una acción en el mismo commit cambiaría el comportamiento de la flota entera de
  // golpe, y frenar de más es tan caro como frenar de menos: es el episodio del `placement-pause`,
  // que paró al único dominio que calentaba bien. La decisión del día se toma SIN el gate.
  //
  // Y de paso fija la brecha que B1 vino a hacer visible: 4 de 6 en bandeja es 67%, una banda que
  // §3 llama directamente "pausar" (<80%) y que el motor vigente responde con "bajar y seguir
  // mandando". Las dos varas conviven a propósito; lo que no se puede es no saber que son dos.
  const filas: Placement[] = [...inbox(4), ...spam(2)];
  const delMotor = decidirCupoDeHoy({ ...base, diaN: 10, placements: filas });
  const m = medirPorProveedor(filas.map((p) => fila(p, "trazosvercel@gmail.com")), proveedorDe);
  assert.equal(evaluarGate({ placement: m }).pasa, false, "§3 lo rechaza: 67% está por debajo de su banda de pausa");
  assert.equal(delMotor.accion, "bajar");
  assert.ok(delMotor.cupo > 0, "y el motor vigente lo sigue mandando igual: son dos varas distintas");
});

// ══ EL CRUCE MTA × PLACEMENT ═════════════════════════════════════════════════════════════════════

test("el MTA entregó y la semilla dice SPAM ⇒ es REPUTACIÓN, no bloqueo", () => {
  // Los números REALES de producción el 2026-08-07 (corpfiling-infra.com), sobre los 5 días que
  // cubre sender-measurement.json: el MTA entregó 20 a gmail.com y la semilla midió 12 (10 INBOX +
  // 2 SPAM) ⇒ 2 casos de "entregado pero en SPAM" y 8 entregas que ninguna semilla vio.
  //
  // Con la ventana de PRODUCCIÓN (`WARMUP_LIVE_PLACEMENT_WINDOW=6`) el mismo dominio da 1 SPAM y 14
  // sin medir, que es lo que corre de verdad. Las dos cifras son la misma medición vista con dos
  // ventanas, y las dos están en el comentario de `cruzarEntregaConPlacement`.
  const filas = [
    ...Array.from({ length: 10 }, () => fila("INBOX", "trazosvercel@gmail.com")),
    ...Array.from({ length: 2 }, () => fila("SPAM", "flomia33193@gmail.com"))
  ];
  const [c] = cruzarEntregaConPlacement({
    filas,
    porReceptor: [{ receptor: "gmail.com", entregados: 20, rechazados: 0, diferidos: 0 }],
    atribuido: false
  });
  assert.equal(c!.receptor, "gmail.com");
  assert.equal(c!.entregadosMta, 20);
  assert.equal(c!.enSpam, 2);
  assert.equal(c!.sinMedir, 8);
  assert.match(c!.lectura, /es REPUTACIÓN, no bloqueo/);
  assert.match(c!.lectura, /8 entrega\(s\) que ninguna semilla vio/);
  // Los 58 nodos están en `atribucion.modo: "todo"`: el veredicto del MTA incluye el correo del
  // otro inquilino y eso no se puede callar. Es la misma honestidad de la regla c4.
  assert.match(c!.lectura, /TODO el correo del nodo/);
});

test("el MTA no entregó ⇒ es BLOQUEO y el placement no aplica", () => {
  const [c] = cruzarEntregaConPlacement({
    filas: [fila("SPAM", "trazosvercel@gmail.com")],
    porReceptor: [{ receptor: "gmail.com", entregados: 0, rechazados: 40, diferidos: 3 }],
    atribuido: true
  });
  assert.match(c!.lectura, /es BLOQUEO, el placement no aplica/);
});

test("sin dato del MTA el cruce dice 'no sé', no cero", () => {
  // Medido: de los 6 dominios que calientan, CINCO tienen `porReceptor: []`, porque el escritor
  // filtra los receptores con menos de 20 intentos y nuestro warmup manda ~2/día por dominio. El
  // cruce vale hoy para UNO solo, y eso hay que decirlo en vez de mostrar un 0.
  const [c] = cruzarEntregaConPlacement({ filas: [fila("INBOX", "trazosvercel@gmail.com")], porReceptor: [], atribuido: false });
  assert.equal(c!.entregadosMta, null);
  assert.equal(c!.sinMedir, null);
  assert.match(c!.lectura, /no reporta gmail\.com en la ventana/);
  assert.match(c!.lectura, /el cruce no se puede hacer/);
});

// ── 'BAJAR' TIENE QUE BAJAR, Y EL PISO QUE EL OPERADOR PUEDE APROBAR ─────────────────────────────

test("'BAJAR' BAJA DE VERDAD: con el mismo autorizado, bajar manda ESTRICTAMENTE menos que sostener", () => {
  // EL BUG (encontrado por QA antes de desplegar, 2026-08-07). Al anclar el piso de `sostener` al
  // cupo AUTORIZADO, la rama `bajar` quedó topada por `Math.min(rampa/2, sostenido)` — y `sostenido`
  // se REALIMENTA, porque el autorizado de hoy es lo que esta misma rama decidió anteayer. Resultado
  // corrido con el código real: al día 20 con autorizado 20, `sostener` (5/6 = 83%) y `bajar` (4/6 =
  // 67%) devolvían LOS DOS cupo 20. La señal de degradación no movía un solo correo.
  //
  // El test de monotonía que ya existía no lo caza porque compara con `>=`: sostener == bajar pasa.
  const conAutorizado = { ...base, diaN: 20, cupoAutorizadoHace2Dias: 20, limiteDiario: 40, pasoPorDia: 2 };
  const sostener = decidirCupoDeHoy({ ...conAutorizado, placements: [...inbox(5), ...spam(1)] });
  const bajar = decidirCupoDeHoy({ ...conAutorizado, placements: [...inbox(4), ...spam(2)] });
  assert.equal(sostener.accion, "sostener");
  assert.equal(bajar.accion, "bajar");
  assert.ok(bajar.cupo < sostener.cupo, `bajar ${bajar.cupo} tiene que ser MENOS que sostener ${sostener.cupo}`);
});

test("y la serie realimentada DESCIENDE en vez de estacionarse: 20 → 10 → 5 → 2", () => {
  // La otra mitad del mismo defecto, y la cara cara: un dominio que ramp-eó a 20 y después entrega
  // 67% para siempre se estacionaba en 11-13/día INDEFINIDAMENTE (d11=11 d12=12 d13=13 d14=11 …
  // d30=12), porque el punto fijo de `min(rampa/2, autorizado)` con autorizado = lo de anteayer no
  // desciende. Antes de anclar el piso al autorizado se estacionaba en 3. Cuatro veces más volumen
  // sostenido sobre un dominio que se está yendo a spam, sin decisión de nadie.
  const historia: number[] = [];
  for (let dia = 1; dia <= 20; dia++) {
    const d = decidirCupoDeHoy({
      ...base,
      diaN: dia,
      placements: dia <= 10 ? inbox(6) : [...inbox(4), ...spam(2)],
      ...(historia[dia - 3] !== undefined ? { cupoAutorizadoHace2Dias: historia[dia - 3]! } : {}),
      limiteDiario: 40,
      pasoPorDia: 2
    });
    historia[dia] = d.cupo;
  }
  const bajando = historia.slice(11, 21);
  assert.ok(historia[10]! >= 18, `el dominio tiene que haber ramp-eado antes de degradarse (llegó a ${historia[10]})`);
  assert.ok(
    Math.min(...bajando) <= CUPO_ARRANQUE,
    `la serie tiene que converger al piso y no estacionarse arriba: ${bajando.join(" ")}`
  );
  assert.ok(historia[20]! < historia[11]!, `y tiene que ir hacia abajo: d11=${historia[11]} d20=${historia[20]}`);
});

test("bajar NUNCA cae por debajo del piso de arranque, o rompe la monotonía por el otro borde", () => {
  // EL BORDE por el que dividir el piso rompía la monotonía en la dirección contraria: la rama de
  // `muestra < MUESTRA_MINIMA` devuelve `min(rampa, CUPO_ARRANQUE)` = 2 SIN mirar el placement, así
  // que con el suelo en 1 un dominio con peor señal (3 medidos, muestra insuficiente) mandaba 2 y el
  // mismo dominio con muestra suficiente al 50% mandaba 1. Peor placement, más volumen — la
  // dirección insegura, y hay dos tests del repo que la cazan. Por eso el suelo es CUPO_ARRANQUE.
  const sinMuestra = decidirCupoDeHoy({ ...base, diaN: 8, placements: [...inbox(3), "MISSING", "MISSING", "MISSING"] });
  const bajando = decidirCupoDeHoy({ ...base, diaN: 8, placements: [...inbox(3), ...spam(1), "MISSING", "MISSING"] });
  assert.equal(bajando.accion, "bajar");
  assert.ok(bajando.cupo >= CUPO_ARRANQUE, `bajar no puede caer bajo el piso de arranque: dio ${bajando.cupo}`);
  assert.ok(sinMuestra.cupo <= bajando.cupo, `${sinMuestra.cupo} vs ${bajando.cupo}`);
});

test("EL PISO QUE EL OPERADOR PUEDE APROBAR: WARMUP_RAMPA_PISO_SOSTENER, default 2 = no cambia nada", () => {
  // POR QUÉ EXISTE. El problema central del encargo —"36 correos en 5 días, 58 dominios comprados y
  // 6 calentando"— se entregaba como PROSA: la propuesta al operador era "subir el piso de sostener
  // de 2 a N" y el piso era `export const CUPO_ARRANQUE = 2`, una constante dura sin env var.
  // `PISO_PARA_SUBIR` y `MUESTRA_MINIMA` tampoco son configurables, y lo único que el operador
  // podía tocar —`WARMUP_LIVE_PLACEMENT_WINDOW`— no destraba: con n=20 el gate de Wilson pide 17/20
  // = 85% y nuestro mejor dominio mide 83%. O sea: no había NADA que aprobar.
  assert.equal(rampaDesdeEnv({}).pisoSostener, CUPO_ARRANQUE, "ausente = exactamente lo de hoy");
  assert.equal(rampaDesdeEnv({ WARMUP_RAMPA_PISO_SOSTENER: "basura" }).pisoSostener, CUPO_ARRANQUE, "fail-closed");
  assert.equal(rampaDesdeEnv({ WARMUP_RAMPA_PISO_SOSTENER: "8" }).pisoSostener, 8);

  // La ventana REAL del mejor dominio de la flota (corpfiling-infra.com, 5 de 6 = 83%): hoy sostiene
  // en 2 y no sale solo, porque `wilsonLowerBound(5,6)` = 0,51 < PISO_PARA_SUBIR.
  const hoy = decidirCupoDeHoy({ ...base, diaN: 20, placements: [...inbox(5), ...spam(1)] });
  assert.equal(hoy.accion, "sostener");
  assert.equal(hoy.cupo, CUPO_ARRANQUE, "el punto fijo del que nadie sale sin decisión del operador");

  // Con la palanca aprobada el mismo dominio se mueve — y el clamp anti-firma 3×/48h del §10 sigue
  // arriba de ella, que es exactamente lo que tiene que pasar: con `autorizado` en 2, el primer día
  // topa en 6 (3×2) aunque el operador haya escrito 8. La palanca sube, el clamp marca el ritmo.
  const primerDia = decidirCupoDeHoy({ ...base, diaN: 20, placements: [...inbox(5), ...spam(1)], pisoSostener: 8, cupoAutorizadoHace2Dias: 2 });
  assert.equal(primerDia.accion, "sostener");
  assert.equal(primerDia.cupo, 6, "3× lo autorizado anteayer: la palanca no puede saltarse el clamp");

  const yaSubio = decidirCupoDeHoy({ ...base, diaN: 20, placements: [...inbox(5), ...spam(1)], pisoSostener: 8, cupoAutorizadoHace2Dias: 6 });
  assert.equal(yaSubio.cupo, 8, "dos días después, el piso aprobado por el operador manda");
});

test("el piso del operador NO levanta al que entrega mal ni al que no tiene muestra", () => {
  // Las dos condiciones que impiden que la palanca sea un cheque en blanco. Sin ellas, subir el piso
  // subiría el volumen de un dominio que se está yendo a spam — que es el camino al umbral
  // permanente de Google, el único daño que no se deshace.
  const sinMuestra = decidirCupoDeHoy({ ...base, diaN: 20, placements: [...inbox(2), ...spam(1)], pisoSostener: 20 });
  assert.ok(sinMuestra.cupo <= CUPO_ARRANQUE, `con ${MUESTRA_MINIMA - 1} mediciones no sube: dio ${sinMuestra.cupo}`);

  // 4 de 6 = 67%, debajo de PISO_SANO ⇒ rama `bajar`, y ahí el piso del operador entra dividido por
  // dos como todo lo demás: nunca puede terminar mandando más que "sostener".
  const entregandoMal = decidirCupoDeHoy({ ...base, diaN: 20, placements: [...inbox(4), ...spam(2)], pisoSostener: 20 });
  const sostieneBien = decidirCupoDeHoy({ ...base, diaN: 20, placements: [...inbox(5), ...spam(1)], pisoSostener: 20 });
  assert.equal(entregandoMal.accion, "bajar");
  assert.ok(entregandoMal.cupo < sostieneBien.cupo, `${entregandoMal.cupo} vs ${sostieneBien.cupo}`);
});

test("NaN EN EL CUPO PREVIO NO BORRA EL TOPE DEL DÍA — y la rama abierta era la de PRODUCCIÓN", () => {
  // EL INCIDENTE QUE FIJA (encontrado por QA antes de desplegar, 2026-08-07). `??` NO atrapa NaN:
  // `NaN ?? 2` devuelve NaN. El piso de `sostener` lo usaba —`Math.max(piso, e.cupoAutorizadoHace2Dias
  // ?? e.cupoHace2Dias ?? CUPO_ARRANQUE)`— así que `decidirCupoDeHoy` salía con `cupo: NaN`, y con
  // eso el TOPE DIARIO DEL DOMINIO DESAPARECE: el gate del daemon es `enviadosHoyBox >= delDia.cupo`
  // y `n >= NaN` es false para todo n. Reproducido con el código real: `0 >= NaN`, `100 >= NaN` y
  // `10000 >= NaN` dan los tres false, y `puedeMandarTurno` con 10.000 enviados contestaba `si: true
  // · "tiene NaN de cupo libre hoy"`.
  //
  // LA VENTANA ES 5/6 Y NO 6/6, Y ESA ES LA MITAD IMPORTANTE DEL TEST. El test que decía cubrir el
  // NaN lo probaba con `inbox(6)` —ventana perfecta ⇒ rama `subir`, que pasa por `baseDelClamp`, la
  // ÚNICA mitad que ya estaba defendida—. La ventana real de los seis dominios del pool es 5 de 6, y
  // ésa cae en `sostener`, que era la rama con el agujero. El test y el código compartían la
  // suposición: es literal la lección `verificar-con-el-mismo-camino-de-produccion`, y la mutación no
  // salva de eso porque los dos se equivocan igual.
  //
  // HOY NO ES ALCANZABLE desde la base (el SQL filtra `detail->>'cupoDelDia' ~ '^[0-9]+$'` y
  // `cupoAutorizadoVigente` descarta con `Number.isFinite`). Se cierra igual porque la próxima
  // entrada del campo —un endpoint, una orden, otro lector— no tiene por qué saber que esta función
  // se apoyaba en el filtro de un SQL que vive en otro archivo.
  const ventanaDeProduccion = [...inbox(5), ...spam(1)];
  for (const roto of [{ cupoAutorizadoHace2Dias: Number.NaN }, { cupoHace2Dias: Number.NaN }]) {
    const d = decidirCupoDeHoy({ ...base, diaN: 20, placements: ventanaDeProduccion, ...roto });
    assert.ok(Number.isFinite(d.cupo), `${JSON.stringify(roto)} ⇒ cupo ${d.cupo}: un tope que no es número no es un tope`);
    assert.ok(d.cupo > 0 && d.cupo <= TECHO_DURO_POR_DOMINIO);
    // Y el gate del daemon vuelve a poder frenar: con NaN, `100 >= cupo` era false.
    assert.equal(100 >= d.cupo, true, "el tope tiene que poder frenar a alguien que ya mandó 100");
  }
  // Un negativo entra por el mismo costado y sale por la misma puerta.
  const negativo = decidirCupoDeHoy({ ...base, diaN: 20, placements: ventanaDeProduccion, cupoAutorizadoHace2Dias: -5 });
  assert.ok(Number.isFinite(negativo.cupo) && negativo.cupo > 0);
});

test("EL 'Re:' NO SE QUEDA CON LA ÚLTIMA RANURA DEL DÍA: la que queda es la que MIDE", () => {
  // EL AGUJERO QUE FIJA, medido en la Postgres de producción el 2026-08-07 (7 días): 51 envíos, 15
  // continuaciones, y CERO de esas 15 produjo una fila `measured`. `filasDePlacement` (plan-diario.ts)
  // excluye el origen 'continuación de hilo' con `IS DISTINCT FROM`, así que el "Re:" gasta cupo y no
  // aporta un dato a la ventana que gobierna el volumen de ese mismo dominio.
  //
  // corpfiling-infra.com —el mejor de la flota y el dominio del que trata el encargo— hizo 21 envíos
  // y sacó 12 mediciones en vez de ~18. El gate de Wilson le pide n≈14 para su 83%: el 29% de correo
  // tirado le DUPLICA el tiempo hasta poder graduarse.
  //
  // El guarda de arriba (piso de la rampa + sin muestra) no lo tapaba: 5 de los 6 dominios del pool
  // ya tienen 4 o más mediciones propias, así que pasaban enteros. Barrido exhaustivo con el código
  // real (11.880 combinaciones): la conjunción de arriba no cambia UN SOLO veredicto respecto de la
  // condición vieja — el freno que muerde es éste.
  const conMuestraYUnaRanura = puedeMandarTurno({
    dominio: "corpfiling-infra.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 1,
    medicionesPropias: 12, decision: decision({ cupo: 2, accion: "sostener" })
  });
  assert.equal(conMuestraYUnaRanura.si, false, "12 mediciones no le dan derecho a comerse la única ranura que mide");
  assert.match(conMuestraYUnaRanura.motivo, /UNA sola ranura libre hoy/);
  assert.match(conMuestraYUnaRanura.motivo, /su ventana de placement lo excluye/);

  // Y NO APAGA LA CONVERSACIÓN MULTIVUELTA, que es la objeción legítima contra cortar por `cupo <=
  // CUPO_ARRANQUE` a secas (con eso los SEIS del pool daban `si:false` y ninguno sale solo del piso).
  // Con cupo 2 el turno sigue saliendo: en la PRIMERA ranura, no en la última.
  const primeraRanura = puedeMandarTurno({
    dominio: "corpfiling-infra.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 0,
    medicionesPropias: 12, decision: decision({ cupo: 2, accion: "sostener" })
  });
  assert.equal(primeraRanura.si, true, "el hilo vivo es el tráfico más parecido al real que produce la fábrica");

  // Y con `WARMUP_RAMPA_PISO_SOSTENER` arriba de 2 se afloja solo: nadie tiene que acordarse de nada.
  const conPisoDelOperador = puedeMandarTurno({
    dominio: "corpfiling-infra.com", enElPool: true, rebotadosHoy: new Set(), enviadosHoy: 4,
    medicionesPropias: 12, decision: decision({ cupo: 6, accion: "sostener" })
  });
  assert.equal(conPisoDelOperador.si, true);
});

test("el envelope de volumen no se mueve por calendario: el techo es el mismo y la bajada planea", () => {
  // POR QUÉ ESTE TEST EXISTE. `sostenido` se ancló al cupo AUTORIZADO hace dos días
  // (`cupoAutorizadoHace2Dias`) en vez de a los correos ENVIADOS, y el dato lo graba el daemon en
  // `detail.cupoDelDia`: aparece SOLO a las ~48 h del despliegue. O sea que el cambio de volumen no
  // llega con un deploy que alguien revisa, llega con una FECHA. Un comentario que diga "hoy no
  // mueve nada" se vuelve falso sin que nadie toque una línea — que es la misma forma de la falla
  // que este lote arregló en el sensor de salud (absolverse porque la evidencia se cae de la
  // ventana). La única defensa que no vence es afirmar la serie completa.
  //
  // SE REALIMENTA LA DECISIÓN, y ahí está el punto: el autorizado de hace dos días es lo que ESTA
  // función decidió ese día. Un barrido que le pase `cupoAutorizadoHace2Dias: 40` a un estado que
  // nunca pudo llegar a 40 mide un fixture, no el sistema.
  const correr = (ventana: (dia: number) => Placement[], dias: number): number[] => {
    const hist: number[] = [];
    for (let dia = 1; dia <= dias; dia++) {
      const a2 = hist[dia - 3];
      hist.push(
        decidirCupoDeHoy({
          ...base,
          diaN: dia,
          placements: ventana(dia),
          ...(a2 !== undefined ? { cupoAutorizadoHace2Dias: a2 } : {})
        }).cupo
      );
    }
    return hist;
  };

  // 1. EL TECHO NO SE MUEVE. Con la ventana perfecta la serie es la rampa lineal y se planta en la
  //    pared del nodo (`cupoFisico: 20` de `base`). Si alguien sube el techo sin querer, acá se ve.
  const perfecta = correr(() => inbox(6), 14);
  assert.deepEqual(perfecta, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 20, 20, 20]);

  // 2. LA BAJADA PLANEA, NO CAE EN PICADA — y eso es MÁS volumen que antes, dicho con el número.
  //    Antes de anclar al autorizado la serie se desplomaba a 2 en un día; ahora hace 20→10→5→2.
  //    Son 4 días de descenso sobre un dominio al 50% de bandeja. Es la diferencia real del cambio.
  const degradada = correr((dia) => (dia <= 12 ? inbox(6) : [...inbox(3), ...spam(3)]), 24);
  assert.deepEqual(degradada.slice(12, 18), [10, 10, 5, 5, 2, 2], "20 → 10 → 5 → 2 y ahí se queda");
  assert.equal(degradada.reduce((a, b) => a + b, 0), 196, "el presupuesto de 24 días, con nombre y número");

  // 3. Y NINGÚN SALTO PUEDE SER GRANDE. Lo topa el clamp 3×/48h; acá se afirma el 2× medido, que es
  //    lo que impide que un dato que aparece solo a las 48 h se traduzca en un escalón de volumen.
  for (const serie of [perfecta, degradada]) {
    for (let i = 1; i < serie.length; i++) {
      if (serie[i - 1]! <= 0) continue;
      assert.ok(serie[i]! / serie[i - 1]! <= 2, `salto de ${serie[i - 1]} a ${serie[i]}: ningún día puede más que duplicar`);
    }
  }
});

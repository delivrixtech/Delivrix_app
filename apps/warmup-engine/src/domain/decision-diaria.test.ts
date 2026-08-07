// Tests de la decisión diaria. Lo que protegen es el criterio, no el cálculo: que no se reaccione
// a ruido, que "flojo" baje en vez de frenar, que "malo" sí frene, y que el cupo físico del nodo
// sea una pared y no una sugerencia.

import assert from "node:assert/strict";
import test from "node:test";

import {
  decidirCupoDeHoy,
  medirPlacement,
  CUPO_ARRANQUE,
  MUESTRA_MINIMA,
  PISO_PARA_SUBIR,
  TECHO_DURO_POR_DOMINIO
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
  const d = decidirCupoDeHoy({ ...base, diaN: 20, cupoFisico: 2000, cupoHace2Dias: 14, placements: inbox(5) });
  assert.equal(d.accion, "sostener");
  assert.equal(d.cupo, 14);
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
  assert.equal(sano.cupo, 20, "manda el cupo físico del nodo, no un múltiplo de lo que salió");
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
  const VENTANA_DE_PRODUCCION = 6;
  const tragado = (n: number): Placement[] => Array.from({ length: n }, () => "MISSING" as const);

  for (const diaN of [4, 8, 12, 20, 40]) {
    for (const cupoHace2Dias of [0, 1, 2, 8, 14]) {
      for (const malos of [spam, tragado]) {
        let previo = Number.POSITIVE_INFINITY;
        for (let bien = VENTANA_DE_PRODUCCION; bien >= 0; bien--) {
          const placements = [...inbox(bien), ...malos(VENTANA_DE_PRODUCCION - bien)];
          const d = decidirCupoDeHoy({ ...base, diaN, cupoFisico: 2000, cupoHace2Dias, placements });
          assert.ok(
            d.cupo <= previo,
            `día ${diaN}, anteayer ${cupoHace2Dias}: ${bien}/${VENTANA_DE_PRODUCCION} en bandeja dio ` +
              `${d.accion} ${d.cupo}/día, MÁS que el ${bien + 1}/${VENTANA_DE_PRODUCCION} anterior (${previo}/día)`
          );
          previo = d.cupo;
        }
      }
    }
  }
});

test("el techo irreversible gana sobre TODO, incluso sobre una rampa configurada absurda", () => {
  const d = decidirCupoDeHoy({
    ...base, diaN: 400, cupoFisico: null, cupoHace2Dias: 9000,
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

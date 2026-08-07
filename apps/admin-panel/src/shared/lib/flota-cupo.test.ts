import assert from "node:assert/strict";
import test from "node:test";

import {
  TECHO_ABSOLUTO,
  estadoDeCupo,
  medicionEsDeHoy,
  ordenarPorRiesgo,
  resumenCupo,
  subredDe,
  usoDelCupo,
  type NodoCupo
} from "./flota-cupo.ts";
import { agruparBloqueos } from "./bloqueos-receptor.ts";
import { textoProcedencia } from "./procedencia.ts";

const nodo = (over: Partial<NodoCupo>): NodoCupo => ({
  domain: "ejemplo.com",
  cap: 20,
  consumidoHoy: 8,
  cableado: true,
  motivo: null,
  ...over
});

// ── El incidente del 2026-08-06: 8 nodos frenados pintados de verde ──────────────────────────────
//
// cap 0 = el policy service difiere el 100% del correo autenticado. Con la guarda vieja
// (`consumidoHoy === null ⇒ -1` evaluada ANTES del cap) los 8 nodos frenados en producción caían
// en la rama de "no medible": fuera del KPI "en el tope", ordenados últimos y con la barra verde
// al 0%. El estado del nodo se decide antes que cualquier porcentaje.

test("cap 0 es el freno, no un 0% de uso — y se evalúa antes que el contador", () => {
  const frenadoSinContador = nodo({ cap: 0, consumidoHoy: null });
  assert.equal(estadoDeCupo(frenadoSinContador), "frenado");
  assert.equal(usoDelCupo(frenadoSinContador), null);

  const resumen = resumenCupo([frenadoSinContador, nodo({})]);
  assert.equal(resumen.frenados, 1);
  // Un nodo que difiere todo ESTÁ en el tope por definición, tenga contador o no.
  assert.equal(resumen.enElTope, 1);
});

// ── El incidente del cap ilegal: cuanto más ancha la puerta, más sano se veía ────────────────────
//
// 10 nodos tenían cap 15000 contra un techo de sistema de 4000. La barra medía consumido/cap, así
// que 11.065/15000 = 0,74 ⇒ VERDE, mientras la tarjeta de alertas de la misma pantalla los
// marcaba `cap_ilegal · critical`.

test("un cap por encima del techo del sistema es crítico y se mide contra el techo, no contra el cap", () => {
  const ilegal = nodo({ cap: 15000, consumidoHoy: 11065 });
  assert.equal(estadoDeCupo(ilegal), "ilegal");
  const uso = usoDelCupo(ilegal);
  assert.ok(uso !== null && uso > 1, `esperaba uso > 1 contra el techo ${TECHO_ABSOLUTO}, dio ${uso}`);
  assert.equal(resumenCupo([ilegal]).ilegales, 1);
  assert.equal(resumenCupo([ilegal]).enElTope, 1);
});

// ── El `?? 0` que convertía "no medido" en cero ─────────────────────────────────────────────────
//
// 42 de 58 nodos venían con consumidoHoy null y sumaban 0 al titular "Aceptados hoy por la flota".
// El número mostrado era un piso calculado sobre 16 nodos, presentado como total de la flota.

test("los nodos sin contador no suman cero: quedan fuera del total y se declaran", () => {
  const nodos = [
    nodo({ domain: "a.com", consumidoHoy: 100 }),
    nodo({ domain: "b.com", consumidoHoy: 50 }),
    nodo({ domain: "c.com", consumidoHoy: null }),
    nodo({ domain: "d.com", consumidoHoy: null })
  ];
  const r = resumenCupo(nodos);
  assert.equal(r.consumido, 150);
  assert.equal(r.medidos, 2);
  assert.equal(r.totalNodos, 4);
  assert.equal(r.sinContador, 2);
});

// ── "Nodos sin límite: 0" junto a "8 fuera de alcance (nadie los capa)" ─────────────────────────

test("sin límite cuenta los no cableados MÁS los que nadie alcanzó", () => {
  const r = resumenCupo([nodo({ cableado: false, cap: null, consumidoHoy: null, motivo: "policy service ausente" })], {
    omitidos: 8,
    ilegibles: 2
  });
  assert.equal(r.sinLimite, 11);
});

test("el orden pone lo roto arriba y lo no medible abajo", () => {
  const ilegal = nodo({ domain: "ilegal.com", cap: 15000, consumidoHoy: 11065 });
  const frenado = nodo({ domain: "frenado.com", cap: 0, consumidoHoy: null });
  const sinLimite = nodo({ domain: "sinlimite.com", cableado: false, cap: null, consumidoHoy: null });
  const enUso = nodo({ domain: "enuso.com", cap: 20, consumidoHoy: 8 });
  const sinContador = nodo({ domain: "sincontador.com", cap: 20, consumidoHoy: null });

  assert.deepEqual(
    ordenarPorRiesgo([sinContador, enUso, sinLimite, frenado, ilegal]).map((n) => n.domain),
    ["ilegal.com", "frenado.com", "sinlimite.com", "enuso.com", "sincontador.com"]
  );
});

// ── La medición que vence cuando la Mac se duerme ───────────────────────────────────────────────

test("una lectura de otro día no es 'hoy'", () => {
  const ahora = new Date("2026-08-06T21:00:00.000Z");
  assert.equal(medicionEsDeHoy("2026-08-06T14:56:00.000Z", ahora), true);
  assert.equal(medicionEsDeHoy("2026-08-05T23:59:00.000Z", ahora), false);
  assert.equal(medicionEsDeHoy(null, ahora), false);
  assert.equal(medicionEsDeHoy("", ahora), false);
});

test("la subred /24 es la unidad de agrupación (11 de 13 nodos del mismo /24 caídos)", () => {
  assert.equal(subredDe("80.190.75.12"), "80.190.75.0/24");
  assert.equal(subredDe("80.190.75.240"), "80.190.75.0/24");
  assert.equal(subredDe(""), null);
  assert.equal(subredDe(null), null);
  assert.equal(subredDe("no-es-una-ip"), null);
});

// ── El bloqueo de Microsoft que desaparecía en silencio ─────────────────────────────────────────

test("ninguna bandeja cerrada desaparece: lo que no cae en una familia va a 'otros receptores'", () => {
  const alertas = [
    { domain: "uno.com", detail: "cerrada en yahoo.com, aol.com" },
    { domain: "dos.com", detail: "cerrada en gmail.com" },
    { domain: "infranationalreport.com", detail: "cerrada en hotmail.com, outlook.com, live.com, msn.com" },
    { domain: "raro.com", detail: "cerrada en correo.de.un.isp.desconocido" }
  ];
  const grupos = agruparBloqueos(alertas);

  const todos = new Set(grupos.flatMap((g) => g.afectados));
  for (const a of alertas) {
    assert.ok(todos.has(a.domain), `${a.domain} desapareció del agrupamiento`);
  }
  // Microsoft ya es una familia propia (era el punto ciego que se perdía en silencio).
  assert.ok(grupos.some((g) => g.afectados.includes("infranationalreport.com") && g.nombre.startsWith("Microsoft")));
  // Y lo desconocido queda VISIBLE, no borrado.
  const otros = grupos.find((g) => g.nombre === "Otros receptores");
  assert.deepEqual(otros?.afectados, ["raro.com"]);
});

// ── La procedencia: el caso que decide si la pantalla puede mentir ──────────────────────────────
//
// Por los mismos nodos pasa el correo de otro producto y el clasificador de salud del gateway leía
// TODO el mail.log sin filtrar quién inyectó (269.680 de 279.232 líneas de annualfiling-infra.com
// eran del otro inquilino y NINGUNA nuestra, y esa bandeja se pintaba "umbral cruzado"). El caso
// que importa acá es el TERCERO: si el gateway todavía no declara procedencia, la pantalla NO
// puede asumir que el dato es nuestro — así deja de depender del orden de despliegue.

test("sin campo de atribución, la pantalla dice que no se declaró — nunca asume que es nuestro", () => {
  const esperado = "procedencia no declarada por el gateway";
  assert.equal(textoProcedencia(undefined), esperado);
  assert.equal(textoProcedencia(null), esperado);
  // Un `modo` que no reconocemos es tan desconocido como la ausencia del campo.
  assert.equal(textoProcedencia({ modo: "otro" as never, queueIds: 9, descartados: 0 }), esperado);
});

test("modo 'todo' declara que el número incluye correo ajeno", () => {
  assert.match(textoProcedencia({ modo: "todo", queueIds: 0, descartados: 0 }), /otro inquilino/);
});

test("modo 'nuestro' declara la muestra propia y NO reparte lo que quedó sin atribuir", () => {
  // 9.552 líneas quedaron sin atribuir porque su línea de origen cayó fuera de la rotación de
  // logs. Repartirlas o asumirlas nuestras sería inventar: se declaran aparte.
  const texto = textoProcedencia({ modo: "nuestro", queueIds: 27, descartados: 9552 });
  assert.match(texto, /27 env[íi]os NUESTROS/);
  // El separador de miles depende del ICU del runtime (node sin full-icu no lo pone): lo que se
  // fija es el número y la palabra, no el formato.
  assert.match(texto, /9\.?552 sin atribuir/);
});

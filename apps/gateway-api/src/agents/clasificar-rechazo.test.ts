// Tests de la clasificación de rechazos. Nacen de un error REAL del agente el 2026-08-04: leyó
// "450 daily send cap reached on this node" y escribió "está bloqueado por los límites diarios de
// Gmail", y de ahí "hay que esperar a que se reseteen". Las dos cosas falsas.

import assert from "node:assert/strict";
import test from "node:test";

import { clasificarRechazo, resumirRechazos } from "./clasificar-rechazo.ts";

const EL_QUE_ENGAÑO =
  "Can't send mail - all recipients were rejected: 450 4.7.1 <trazosvercel@gmail.com>: Recipient address rejected: daily send cap reached on this node";

test("el 450 de NUESTRO Postfix no se confunde con un rechazo de Gmail", () => {
  // El texto menciona una dirección de gmail.com, que es justo lo que despistó al modelo.
  const c = clasificarRechazo(EL_QUE_ENGAÑO);
  assert.equal(c?.origen, "freno_propio");
  assert.match(c!.explicacion, /NUESTRO límite de Postfix/);
  assert.match(c!.explicacion, /lo soltamos nosotros/);
});

test("5.7.1 es reputación del receptor, no nuestro freno", () => {
  const c = clasificarRechazo("550-5.7.1 Our system has detected unsolicited mail");
  assert.equal(c?.origen, "receptor");
});

test("5.1.1 es dirección inexistente, y se distingue de reputación", () => {
  // La diferencia decide la acción: una se arregla con la lista, la otra no.
  assert.equal(clasificarRechazo("550 5.1.1 User unknown")?.origen, "receptor");
  assert.match(clasificarRechazo("550 5.1.1 User unknown")!.explicacion, /no existe/);
});

test("un fallo de red es infra, no reputación", () => {
  assert.equal(clasificarRechazo("connect ECONNREFUSED 10.0.0.1:587")?.origen, "infra");
});

test("lo que no se reconoce sale como DESCONOCIDO, no se le inventa un culpable", () => {
  // Es el punto entero del módulo: preferimos "no sé de quién es este freno" antes que una
  // atribución equivocada, que es la que arrastra a una conclusión equivocada.
  const c = clasificarRechazo("algo raro pasó acá");
  assert.equal(c?.origen, "desconocido");
  assert.match(c!.explicacion, /no se pudo clasificar/);
});

test("sin texto no hay clasificación (null), no un 'desconocido' fantasma", () => {
  assert.equal(clasificarRechazo(null), null);
  assert.equal(clasificarRechazo("   "), null);
});

test("el resumen agrupa por origen y cuenta, con un ejemplo de cada uno", () => {
  const r = resumirRechazos([EL_QUE_ENGAÑO, EL_QUE_ENGAÑO, "550-5.7.1 unsolicited mail", null]);
  assert.equal(r.length, 2);
  assert.equal(r[0]!.origen, "freno_propio");
  assert.equal(r[0]!.cuantos, 2, "el más frecuente primero");
  assert.equal(r[1]!.origen, "receptor");
});

// Tests del agente monitor. El foco no es "¿el modelo dice cosas lindas?" sino "¿lo que dice se
// sostiene contra los hechos?". Nacieron de una lectura real que atribuyó a Gmail un freno nuestro.

import assert from "node:assert/strict";
import test from "node:test";

import type { HechosWarmup } from "./warmup-monitor.ts";


// ── Verificación de la lectura ───────────────────────────────────────────────────────────────────
// Le pedimos en el prompt que use solo los datos dados, y aun así afirmó que el freno era de Gmail.
// Una regla en el prompt es una intención; esto es una verificación.

import { SISTEMA, verificarLectura } from "./warmup-monitor.ts";

const HECHOS_BASE: HechosWarmup = {
  generadoEn: "2026-08-04T15:00:00.000Z",
  semillas: { destinos: 5, midiendo: 1, puntoCiego: ["outlook"] },
  vueltas: [{ dominio: "corpfiling-infra.com", semilla: "s@gmail.com", cuando: "2026-08-04T10:00:00Z", placement: "INBOX", completa: true, error: null }],
  cap: { consumidoHoy: 2, tope: 20, enElTope: [], sinLimite: 0 },
  flota: { sanas: 13, bloqueadas: 22, atascadas: 22, cruzados: [], cerca: [] },
  plan: [{ dominio: "corpfiling-infra.com", diaN: 1, placementTasa: 0.75, placementMuestra: 4, cupo: 2, accion: "subir", motivo: "test", enviadosHoy: 2 }],
  rechazos: [{ origen: "freno_propio", cuantos: 6, explicacion: "es NUESTRO límite de Postfix", ejemplo: "450 ..." }]
};

test("parte la lectura en sus cuatro campos", () => {
  const v = verificarLectura(
    "AHORA: el warmup cumplió su cupo.\nPORQUE: 2 de 2 enviados hoy.\nRIESGO: ninguno\nFALTA: nada",
    HECHOS_BASE
  );
  assert.equal(v.ahora, "el warmup cumplió su cupo.");
  assert.equal(v.riesgo, "ninguno");
  assert.deepEqual(v.reparos, []);
});

test("CAZA el error real: atribuirle a Gmail un freno que es nuestro", () => {
  // Textualmente lo que escribió el agente el 2026-08-04.
  const v = verificarLectura(
    "AHORA: está bloqueado por los límites diarios de Gmail en el nodo.\nPORQUE: 6 rechazos.\nRIESGO: ninguno\nFALTA: nada",
    HECHOS_BASE
  );
  assert.ok(v.reparos.some((r) => /freno que en los datos figura como nuestro/.test(r)));
});

test("CAZA un dominio inventado", () => {
  const v = verificarLectura(
    "AHORA: falla en ejemplo-inventado.com.\nPORQUE: nada.\nRIESGO: ninguno\nFALTA: nada",
    HECHOS_BASE
  );
  assert.ok(v.reparos.some((r) => r.includes("ejemplo-inventado.com")));
});

test("nombrar al proveedor como concepto NO es un reparo", () => {
  // "el placement en Gmail" es legítimo; lo que no se puede es inventar un dominio NUESTRO.
  const v = verificarLectura(
    "AHORA: el placement en Gmail viene bien.\nPORQUE: 75% sobre 4.\nRIESGO: ninguno\nFALTA: nada",
    HECHOS_BASE
  );
  assert.deepEqual(v.reparos, []);
});

test("CAZA un placement citado cuando no hay ninguna medición", () => {
  const sinMuestra: HechosWarmup = { ...HECHOS_BASE, plan: [{ ...HECHOS_BASE.plan![0]!, placementTasa: null, placementMuestra: 0 }] };
  const v = verificarLectura(
    "AHORA: vamos con 80% de inbox.\nPORQUE: mediciones.\nRIESGO: ninguno\nFALTA: nada",
    sinMuestra
  );
  assert.ok(v.reparos.some((r) => /sin.*medición|no hay ninguna medición/i.test(r)));
});

test("una respuesta en prosa suelta se marca como fuera de formato", () => {
  const v = verificarLectura("Bueno, mirando los datos me parece que todo viene bien.", HECHOS_BASE);
  assert.ok(v.reparos.some((r) => /formato/.test(r)));
});

test("REGRESIÓN: UN solo rechazo de receptor NO desarma el chequeo de atribución", () => {
  // La condición era `.every(origen === "freno_propio")`, así que bastaba un rechazo de receptor en
  // la ventana para que la frase textual del 2026-08-04 volviera a pasar limpia. Y como el runner
  // ejecuta acciones solo cuando NO hay reparos, además habilitaba a actuar sobre ese razonamiento.
  const mezclado: HechosWarmup = {
    ...HECHOS_BASE,
    rechazos: [
      { origen: "freno_propio", cuantos: 6, explicacion: "es NUESTRO límite de Postfix", ejemplo: "450 ..." },
      { origen: "receptor", cuantos: 1, explicacion: "el receptor rechaza por política", ejemplo: "550 5.7.1" }
    ]
  };
  const v = verificarLectura(
    "AHORA: está bloqueado por los límites diarios de Gmail en el nodo.\nPORQUE: 6 rechazos.\nRIESGO: ninguno\nFALTA: nada",
    mezclado
  );
  assert.ok(v.reparos.some((r) => /freno que en los datos figura como nuestro/.test(r)));
});

test("sin ningún freno propio en la ventana, nombrar los límites del proveedor NO es un reparo", () => {
  // El otro lado del borde: si de verdad todos los rechazos son del receptor, hablar de sus límites
  // es correcto y marcarlo sería un reparo FALSO — que bloquea todas las acciones, incluida la buena.
  const soloReceptor: HechosWarmup = {
    ...HECHOS_BASE,
    rechazos: [{ origen: "receptor", cuantos: 6, explicacion: "política del receptor", ejemplo: "550 5.7.1" }]
  };
  const v = verificarLectura(
    "AHORA: nos frenan los límites diarios de Gmail.\nPORQUE: 6 rechazos del receptor.\nRIESGO: ninguno\nFALTA: nada",
    soloReceptor
  );
  assert.deepEqual(v.reparos, []);
});

test("la VOZ se separa de los hechos: da personalidad sin debilitar el gate", () => {
  const hechos: HechosWarmup = {
    generadoEn: "2026-08-05T00:00:00.000Z",
    semillas: { destinos: 2, midiendo: 1, puntoCiego: [] },
    vueltas: [],
    cap: null,
    flota: null
  };

  const conVoz = verificarLectura(
    [
      "AHORA: el emisor está pausado.",
      "PORQUE: el placement quedó por debajo del piso.",
      "RIESGO: ninguno",
      "FALTA: nada",
      "VOZ: Juanes, esto se destraba solo cuando entren más mediciones, no toco nada."
    ].join("\n"),
    hechos
  );
  assert.equal(conVoz.reparos.length, 0, "una lectura sana con voz sigue sin reparos");
  assert.match(conVoz.voz ?? "", /Juanes/);
  assert.equal(conVoz.estilo.length, 0);

  // Lo que NO puede pasar: que un problema de ESTILO bloquee al agente. Los reparos frenan
  // acciones (scripts/ops/warmup-monitor.ts); el estilo no puede tener ese poder.
  const vozConDato = verificarLectura(
    [
      "AHORA: el emisor está pausado.",
      "PORQUE: el placement quedó por debajo del piso.",
      "RIESGO: ninguno",
      "FALTA: nada",
      "VOZ: Juanes, tenemos 33% y eso no me gusta nada."
    ].join("\n"),
    hechos
  );
  assert.equal(vozConDato.reparos.length, 0, "el número en la voz NO es un reparo");
  assert.equal(vozConDato.estilo.length, 1, "pero sí queda observado");
  assert.match(vozConDato.estilo[0] ?? "", /números/);

  // Y al revés: sin voz, todo sigue funcionando igual que antes.
  const sinVoz = verificarLectura(
    ["AHORA: todo bien.", "PORQUE: no hay señales malas.", "RIESGO: ninguno", "FALTA: nada"].join("\n"),
    hechos
  );
  assert.equal(sinVoz.voz, null);
  assert.equal(sinVoz.reparos.length, 0);
});

test("no marca como inventado un porcentaje que le dimos nosotros en el estado del emisor", () => {
  // Reparo FALSO visto en producción el 2026-08-06: el hecho `emisor` trae su propio porcentaje
  // ("inbox 33% < piso 50%") y el verificador solo comparaba contra las tasas del plan. Marcaba
  // como inventado un dato propio — y con reparos el agente NO ejecuta nada, así que un reparo
  // falso le corta las manos y encima entrena al operador a ignorar los reparos.
  const hechos: HechosWarmup = {
    generadoEn: "2026-08-06T00:00:00.000Z",
    emisor: { estado: "placement-pause", motivo: "inbox 33% < piso 50%", vueltasHoy: 0, topeDiario: 14 },
    semillas: { destinos: 6, midiendo: 2, puntoCiego: [] },
    vueltas: [],
    cap: null,
    flota: null,
    plan: [{ dominio: "a.com", diaN: 1, placementTasa: 0.83, placementMuestra: 6, cupo: 2, accion: "sostener", motivo: "m", enviadosHoy: 0 }]
  };

  const citaElEmisor = verificarLectura(
    [
      "AHORA: el emisor está pausado con el inbox en 33%.",
      "PORQUE: el piso es 50% y no lo alcanza.",
      "RIESGO: ninguno",
      "FALTA: nada"
    ].join("\n"),
    hechos
  );
  assert.deepEqual(citaElEmisor.reparos, [], "33% y 50% vienen del propio hecho emisor");

  // Y sigue atajando lo que SÍ es inventado. (La forma "placement del N%" es una de las que el
  // chequeo reconoce; no cubre todas las redacciones posibles, y eso es previo a este arreglo.)
  const inventado = verificarLectura(
    ["AHORA: llegamos a un placement del 91%.", "PORQUE: mejoró.", "RIESGO: ninguno", "FALTA: nada"].join("\n"),
    hechos
  );
  assert.equal(inventado.reparos.length, 1);
  assert.match(inventado.reparos[0] ?? "", /91%/);
});

test("el prompt le prohíbe pedirle a Juanes lo que puede hacer solo", () => {
  // El reclamo textual, después de una noche entera de mensajes: "me está pidiendo resolver ciertas
  // cosas, que él mismo puede resolver... más que decirme errores sobre errores, que vaya
  // aprendiendo a cómo resolverlos".
  const p = SISTEMA.replace(/\s+/g, " ");
  assert.match(p, /NO LE PIDAS A JUANES LO QUE PODÉS HACER VOS/);
  assert.match(p, /MOLESTALO SOLO SI SE CUMPLEN LAS DOS/, "el criterio de escalada es explícito");
  assert.match(p, /es grave AHORA, y vos no tenés herramienta para resolverlo/);
  // Y le da los ejemplos concretos que separan un caso del otro: sin ellos la regla es abstracta
  // y el modelo la cumple a medias.
  assert.match(p, /leelo.*diagnosticalo.*medilo/s);
  assert.match(p, /no es un mensaje: es un pendiente/);
});

test("la VOZ por defecto cuenta lo que hizo, no pide permiso", () => {
  const p = SISTEMA.replace(/\s+/g, " ");
  assert.match(p, /Por defecto la VOZ cuenta LO QUE HICISTE/);
  assert.match(p, /si está ahí, es tuyo y no se pide permiso/);
});

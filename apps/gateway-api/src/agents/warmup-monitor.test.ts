// Tests del agente monitor. El foco no es "¿el modelo dice cosas lindas?" sino "¿lo que dice se
// sostiene contra los hechos?". Nacieron de una lectura real que atribuyó a Gmail un freno nuestro.

import assert from "node:assert/strict";
import test from "node:test";

import type { HechosWarmup } from "./warmup-monitor.ts";


// ── Verificación de la lectura ───────────────────────────────────────────────────────────────────
// Le pedimos en el prompt que use solo los datos dados, y aun así afirmó que el freno era de Gmail.
// Una regla en el prompt es una intención; esto es una verificación.

import { ejecutarAcciones, extraerAcciones } from "./acciones-agente.ts";
import { limpiarMaquinaria, responder, VOZ } from "./sentinel-chat.ts";
import { agruparReparos, construirPrompt, lineasDeFrenados, SISTEMA, verificarLectura, type FrenadoDetalle } from "./warmup-monitor.ts";

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
  assert.match(p, /NO LE PIDAS A JUANES LO QUE PUEDES HACER TÚ/);
  assert.match(p, /MOLÉSTALO SOLO SI SE CUMPLEN LAS DOS/, "el criterio de escalada es explícito");
  assert.match(p, /es grave AHORA, y tú no tienes herramienta para resolverlo/);
  // Y le da los ejemplos concretos que separan un caso del otro: sin ellos la regla es abstracta
  // y el modelo la cumple a medias.
  assert.match(p, /léelo.*diagnostícalo.*mídelo/s);
  assert.match(p, /no es un mensaje: es un pendiente/);
});

test("la VOZ por defecto cuenta lo que hizo, no pide permiso", () => {
  const p = SISTEMA.replace(/\s+/g, " ");
  assert.match(p, /Por defecto la VOZ cuenta LO QUE HICISTE/);
  assert.match(p, /si está ahí, es tuyo y no se pide permiso/);
});

// ── Los frenados entran como DATO, no como criterio en prosa ──────────────────────────────────────
// El agente tiene `soltar_dominio` habilitada en producción desde hace días y en 31 entradas de
// bitácora la usó UNA vez: contra bizreport-control.com, el único que había cruzado el umbral
// permanente. No es que se equivocara de dominio — es que no tenía con qué elegir. Las condiciones
// vivían en el prompt escritas en prosa ("y soltar_dominio si alguno califica"), que es exactamente
// la forma en que este proyecto ya se quemó dos veces: un criterio en párrafo el modelo lo devuelve
// como hallazgo propio, y si es falso lo devuelve con seguridad.

/** Lo que ninguna línea generada puede decir nunca. Si aconseja, vuelve como hallazgo del modelo. */
const IMPERATIVOS = /\b(deberías|hay que|conviene|tenés que|recomiendo|revisá|mirá|usá|soltá)\b/i;

const CAP_FRENADOS = (frenadosDetalle: FrenadoDetalle[]): HechosWarmup["cap"] => ({
  nodosMedidos: 14,
  nodosSinMedir: 44,
  enElTope: [],
  frenados: frenadosDetalle.map((f) => f.dominio),
  frenadosDetalle,
  sinLimite: 0,
  medidoEn: "2026-08-06T12:00:00.000Z"
});

test("cada frenado lleva sus tres condiciones ya evaluadas, y ni un imperativo", () => {
  const l = lineasDeFrenados(
    CAP_FRENADOS([
      // El quemado: cruzó el umbral permanente, y eso no lo levanta ninguna autoridad.
      { dominio: "bizreport-control.com", cruzado: true, bloqueanPor: [], muestra: 6, tasaInbox: 0.83 },
      // Un virgen de los 7: tráfico cero, nadie lo rechaza, y califica.
      { dominio: "filing-ops.com", cruzado: false, bloqueanPor: [], muestra: 0, tasaInbox: null }
    ])
  );
  const texto = l.join("\n");
  assert.match(texto, /bizreport-control\.com: no vuelve: ya cruzó el umbral permanente/);
  assert.match(texto, /filing-ops\.com: califica para soltar_dominio/);
  for (const x of l) assert.doesNotMatch(x, IMPERATIVOS, `una línea de datos no da órdenes: "${x}"`);
  // Y cada línea de dato cita datos guardados: los tres campos aparecen, no solo el veredicto.
  for (const x of l.filter((y) => y.startsWith("- "))) {
    assert.match(x, /umbral permanente/);
    assert.match(x, /receptores|lo rechazan/);
    assert.match(x, /placement propio/);
  }
});

test("el que cruzó el umbral JAMÁS aparece como candidato", () => {
  // La condición 0 de soltar_dominio no la levanta ni una orden del jefe por chat. Si la línea que
  // el modelo lee dijera "califica" sobre este dominio, le estaríamos pidiendo que intente algo que
  // el gate va a rechazar siempre — y un rechazo que se repite entrena a dejar de intentar.
  const l = lineasDeFrenados(
    CAP_FRENADOS([{ dominio: "bizreport-control.com", cruzado: true, bloqueanPor: null, muestra: null, tasaInbox: null }])
  ).join("\n");
  assert.ok(!/califica/.test(l), "no puede decir que califica");
  assert.match(l, /cruzó el umbral permanente/);
});

test('"no evaluado" no es "califica", y "sin diagnosticar" no es "nadie lo rechaza"', () => {
  // La confusión más cara del sistema, con nombre y apellido: el 2026-07-25, 38 nodos estaban
  // cerrados en Gmail con CERO detecciones de blacklist, y ese cero se leyó como "está limpio".
  // Ausencia de dato no es evidencia de que algo está bien.
  const sinEvaluar = lineasDeFrenados(
    CAP_FRENADOS([{ dominio: "corpfiling-relay.com", cruzado: null, bloqueanPor: null, muestra: null, tasaInbox: null }])
  ).join("\n");
  assert.match(sinEvaluar, /todavía no se evaluó si puede volver/);
  assert.match(sinEvaluar, /umbral permanente: sin dato/);
  assert.match(sinEvaluar, /receptores: sin diagnosticar/);
  assert.match(sinEvaluar, /placement propio: sin medir/);
  assert.ok(!/califica/.test(sinEvaluar));

  // Y "se miró y no hay nada" se dice distinto de "no se miró".
  const medido = lineasDeFrenados(
    CAP_FRENADOS([{ dominio: "corpfiling-relay.com", cruzado: false, bloqueanPor: [], muestra: 0, tasaInbox: null }])
  ).join("\n");
  assert.match(medido, /receptores: ninguno lo rechaza/);
  assert.match(medido, /placement propio: 0 mediciones/);
});

test("sin frenadosDetalle degrada a 'sin evaluar', nunca a 'califica'", () => {
  // Mientras el orquestador no escriba el campo nuevo, los frenados se siguen listando —perderlos
  // dejaría a soltar_dominio otra vez sin sujeto— pero con TODO en sin evaluar. Prometer una
  // evaluación que nadie hizo es la mano prometida y no cableada que este proyecto ya pagó dos veces.
  const l = lineasDeFrenados({ nodosMedidos: 1, nodosSinMedir: 0, enElTope: [], frenados: ["filing-ops.com"], sinLimite: 0 }).join("\n");
  assert.match(l, /filing-ops\.com: todavía no se evaluó si puede volver/);
  assert.ok(!/califica/.test(l));
  // Y sin frenados no se emite una sola línea: el prompt queda exactamente como estaba.
  assert.deepEqual(lineasDeFrenados(null), []);
  assert.deepEqual(lineasDeFrenados(undefined), []);
  // El ENCABEZADO tampoco puede afirmar más de lo que hay debajo: si ninguna fila llegó a un
  // veredicto, no dice "ya evaluadas". Decirlo era una falsedad dentro del prompt, y de las caras:
  // el agente lee que el trabajo está hecho y no vuelve a mirar.
  assert.ok(!/ya evaluadas/.test(l), "no puede prometer una evaluación que no ocurrió");
  assert.match(l, /TODAVÍA NO se evaluaron/);
});

test("el umbral permanente se llena de flota.cruzados: el dato estaba a dos campos y no se miraba", () => {
  // El caso más caro del día: nadie escribe `frenadosDetalle`, así que las 8 líneas de frenados
  // salían enteras en "umbral permanente: sin dato" mientras `hechos.flota.cruzados` traía la lista
  // exacta en el MISMO objeto. Es gratis —ni un SSH ni una consulta— y es justo la condición que
  // rechaza a un dominio quemado.
  const cap = { nodosMedidos: 2, nodosSinMedir: 0, enElTope: [], frenados: ["bizreport-control.com", "filing-ops.com"], sinLimite: 0 };
  const flota = { sanas: 6, bloqueadas: 36, atascadas: 9, cruzados: ["bizreport-control.com"], cerca: [] };
  const l = lineasDeFrenados(cap, flota).join("\n");
  assert.match(l, /bizreport-control\.com: no vuelve: ya cruzó el umbral permanente/);
  assert.match(l, /filing-ops\.com: todavía no se evaluó .* · no cruzó el umbral permanente/);
  assert.ok(!/filing-ops\.com: califica/.test(l), "que no haya cruzado NO alcanza para calificar: faltan receptor y placement");

  // SIN flota, `cruzado` queda en "no sé". Nunca en "no cruzó": es la confusión que abrió el gate.
  const sinFlota = lineasDeFrenados(cap, null).join("\n");
  assert.match(sinFlota, /bizreport-control\.com: todavía no se evaluó/);
  assert.match(sinFlota, /umbral permanente: sin dato/);
});

test("EL ESTADO DE HOY: 1 de 8 evaluados NO se anuncia como 'ya evaluadas'", () => {
  // El caso EXACTO de producción (warmup-monitor.json de las 23:45Z), y el que el guard anterior
  // dejaba pasar: `algunoEvaluado` se prendía con UNA fila. bizreport-control.com está en
  // `flota.cruzados`, saca veredicto por el atajo `cruzado === true` —sin tocar un solo nodo— y
  // volteaba el encabezado a "las condiciones ya evaluadas contra los nodos" mientras los 7
  // vírgenes decían "todavía no se evaluó · receptores: sin diagnosticar · placement propio: sin
  // medir". Es la misma falsedad dentro del prompt que el arreglo decía haber matado: el agente lee
  // que el trabajo está hecho y no vuelve a mirar a los únicos 7 que podían salir.
  const cap = {
    nodosMedidos: 8,
    nodosSinMedir: 0,
    enElTope: [],
    frenados: [
      "bizreport-control.com",
      "bizregistry-ops.com",
      "controlnationalcorp.com",
      "corpfiling-relay.com",
      "corpfilingrelay.com",
      "corpregistry-ops.com",
      "filing-ops.com",
      "nationalbizrenewal-ops.com"
    ],
    sinLimite: 0
  };
  const flota = { sanas: 6, bloqueadas: 36, atascadas: 9, cruzados: ["bizreport-control.com"], cerca: [] };
  const l = lineasDeFrenados(cap, flota);
  const encabezado = l[0]!;
  const sinEvaluar = l.slice(1).filter((x) => x.includes("todavía no se evaluó")).length;

  assert.equal(sinEvaluar, 7, "los 7 vírgenes siguen sin veredicto — ese es el estado real");
  assert.ok(!/ya evaluadas/.test(encabezado), `el encabezado afirma más de lo que hay debajo: "${encabezado}"`);
  assert.match(encabezado, /1 de 8/, "el número tiene que estar: un '1 de 8' no se lee como 'está hecho'");
  assert.match(encabezado, /a los otros 7 todavía no los miró nadie/);

  // Y los dos extremos siguen diciendo lo suyo, sin número.
  const todas = lineasDeFrenados(
    CAP_FRENADOS([
      { dominio: "a.com", cruzado: false, bloqueanPor: [], muestra: 0, tasaInbox: null },
      { dominio: "b.com", cruzado: true, bloqueanPor: [], muestra: 0, tasaInbox: null }
    ])
  )[0]!;
  assert.match(todas, /ya evaluadas contra los nodos/);
  assert.ok(!/de 2/.test(todas));
});

test("ninguna rama de porQueNoVuelve mete un imperativo en el prompt", () => {
  // El test antiimperativo pasaba por la razón equivocada: solo probaba `cruzado:true` y una fila
  // que califica, y nunca la rama de RECEPTOR — que es el caso más común de la flota real (22 nodos
  // cerrados hoy) y decía textual "hay que destrabar al receptor primero". `lineasDeFrenados` cita a
  // `porQueNoVuelve` palabra por palabra, así que ese imperativo llegaba al prompt entero. Acá van
  // las CINCO ramas: si mañana alguien agrega una sexta con un consejo adentro, se pone rojo.
  const filas: FrenadoDetalle[] = [
    { dominio: "cruzado.com", cruzado: true, bloqueanPor: [], muestra: 6, tasaInbox: 0.83 },
    { dominio: "receptor.com", cruzado: false, bloqueanPor: ["gmail", "yahoo"], muestra: 5, tasaInbox: 0.8 },
    { dominio: "historia.com", cruzado: false, bloqueanPor: [], muestra: 5, tasaInbox: 0.2 },
    { dominio: "califica.com", cruzado: false, bloqueanPor: [], muestra: 0, tasaInbox: null },
    { dominio: "sinevaluar.com", cruzado: null, bloqueanPor: null, muestra: null, tasaInbox: null },
    // La rama nueva: los tres datos menos el umbral, que es el `.catch(() => null)` de la flota.
    { dominio: "sinflota.com", cruzado: null, bloqueanPor: [], muestra: 5, tasaInbox: 0.9 }
  ];
  const l = lineasDeFrenados(CAP_FRENADOS(filas));
  for (const x of l) assert.doesNotMatch(x, IMPERATIVOS, `una línea de datos no da órdenes: "${x}"`);
  const texto = l.join("\n");
  assert.match(texto, /receptor\.com: no vuelve: lo tiene cerrado gmail, yahoo/);
  assert.match(texto, /califica\.com: califica para soltar_dominio/);
  // Y el que no tiene la medición de flota NO califica: "no sé" no es "no cruzó".
  assert.match(texto, /sinflota\.com: no vuelve: no se pudo leer la medición de la flota/);
});

/**
 * La capacidad de `ContextoAcciones` que cada acción anunciada necesita para poder ejecutarse.
 * `null` = no necesita ninguna (el `case` se resuelve solo).
 */
const CAPACIDAD_DE: Record<string, string | null> = {
  frenar_dominio: "frenarDominio",
  soltar_dominio: "soltarDominio",
  pausar_warmup: "pausarWarmup",
  anotar_pendiente: "pendientes",
  resolver_pendiente: "pendientes",
  leer_cupo_nodo: "leerCupoNodo",
  diagnosticar_dominio: "diagnosticarDominio",
  medir_dominio: "medirDominio",
  revisar_reputacion: "revisarReputacion",
  // TODAVÍA NO SE ANUNCIA EN NINGÚN PROMPT, y la fila entra igual: el contrato de arriba solo mira
  // las acciones que el prompt nombra, así que esto es el guardia puesto ANTES de que haga falta.
  // El día que la línea `- proponer_subida |` entre a SISTEMA sin que el orquestador pase
  // `datosParaProponer`, este test se pone rojo — que es exactamente la falla que el repo ya pagó
  // cinco veces (la mano prometida y no cableada), atajada del lado barato.
  proponer_subida: "datosParaProponer"
};

test("EL CONTRATO: ninguna mano se anuncia en un prompt si el orquestador no la cablea", async () => {
  // LA MANO PROMETIDA Y NO CABLEADA — el modo de falla que este proyecto ya pagó DOS veces, y que
  // el test anterior no atajaba porque solo miraba que el `case` existiera en acciones-agente.ts.
  // Esa es la mitad barata: un `case` sin la capacidad en el contexto devuelve "rechazada: X no
  // está habilitado en este entorno", y el modelo, cuando le anuncian una mano que no tiene, la
  // vuelve a pedir — medido en el log de producción: 26 rechazos de "frenar no está habilitado" en
  // 5 horas sobre 31 pedidos del mismo dominio.
  //
  // La otra mitad, la que importa, es que quien CONSTRUYE el ContextoAcciones la pase. Hoy el único
  // `ejecutarAcciones` real vive en scripts/ops/warmup-monitor.ts (guardia y chat), así que el
  // contrato se verifica contra ese archivo. Se lee como texto a propósito: importarlo arrancaría
  // el orquestador entero.
  const { readFile } = await import("node:fs/promises");
  const crudo = await readFile(new URL("../../../../scripts/ops/warmup-monitor.ts", import.meta.url), "utf8");
  // SIN COMENTARIOS, y no es un detalle: el test anterior buscaba `\bfrenarDominio\s*:` sobre el
  // archivo entero, así que un comentario que EXPLICARA el incidente —o una línea comentada—
  // satisfacía el contrato. Documentar un agujero no es taparlo.
  const orquestador = sinComentarios(crudo);
  const condicionales = spreadsCondicionales(orquestador);

  for (const prompt of [
    { nombre: "SISTEMA (guardia)", texto: SISTEMA },
    { nombre: "VOZ (chat)", texto: VOZ }
  ]) {
    for (const accion of Object.keys(CAPACIDAD_DE)) {
      if (!prompt.texto.includes(`- ${accion} |`)) continue;
      // 1. El parser la reconoce. Sin esto la línea del prompt no llega ni al switch.
      assert.ok(
        extraerAcciones(`ACCION: ${accion} | dominio=a.com | motivo=x`).some((a) => a.accion === accion),
        `${prompt.nombre} anuncia ${accion} y extraerAcciones no la reconoce`
      );
      // 2. Y el orquestador PASA la capacidad. Ésta es la que faltaba.
      const cap = CAPACIDAD_DE[accion];
      if (cap === null) continue;
      const donde = [...orquestador.matchAll(new RegExp(`\\b${cap}\\s*:`, "g"))].map((m) => m.index!);
      assert.ok(
        donde.length > 0,
        `${prompt.nombre} anuncia ${accion} pero scripts/ops/warmup-monitor.ts no pasa "${cap}" al ContextoAcciones: ` +
          `el modelo la va a pedir y le va a volver "no está habilitado en este entorno". O se cablea, o se saca la línea del prompt.`
      );
      // 3. LA MITAD QUE FALTABA: presencia del identificador NO es cableado. `frenarDominio:` está
      //    en el archivo, pero adentro de `...(puedeFrenar ? { … } : {})`, y `puedeFrenar` es
      //    `WARMUP_AGENT_PUEDE_FRENAR === "true"`, APAGADO por defecto. O sea que el incidente que
      //    este contrato dice atajar —26 rechazos de "frenar no está habilitado" en 5 horas sobre
      //    31 pedidos del mismo dominio— pasaba verde. Una mano detrás de un flag no se puede
      //    prometer plana: o el prompt avisa que puede no estar, o el modelo la pide igual.
      const bajoFlag = donde.every((i) => condicionales.some(([a, b]) => i > a && i < b));
      if (!bajoFlag) continue;
      const linea = lineaDeLaAccion(prompt.texto, accion);
      assert.match(
        linea,
        /puede (no )?estar (habilitad|disponible)|si está habilitad/i,
        `${prompt.nombre} anuncia ${accion} como si siempre estuviera, pero el orquestador solo la cablea detrás de un flag ` +
          `(está adentro de un "...(x ? {…} : {})"). Prometer una mano que puede no estar es peor que no darla: el modelo la ` +
          `pide, le vuelve "no está habilitado en este entorno" y la vuelve a pedir. O se cablea sin flag, o la línea lo dice.`
      );
    }
  }
});

/** Saca comentarios de línea y de bloque. Sin esto, documentar un agujero lo daba por tapado. */
function sinComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Los rangos `...( … )` del archivo, que es como se escribe una capacidad detrás de un flag:
 *
 *     ...(puedeFrenar ? { frenarDominio: async (…) => { … } } : {})
 *
 * Se emparejan paréntesis a mano (los comentarios ya se fueron). Si alguno no cierra, se descarta:
 * un rango mal armado tiene que dar "no está bajo flag" y dejar pasar, nunca inventar un flag.
 */
function spreadsCondicionales(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of src.matchAll(/\.\.\.\(/g)) {
    let prof = 1;
    let i = m.index! + 4;
    for (; i < src.length && prof > 0; i++) {
      if (src[i] === "(") prof++;
      else if (src[i] === ")") prof--;
    }
    if (prof === 0) out.push([m.index!, i]);
  }
  return out;
}

/** La línea del prompt que anuncia la acción, más sus renglones de continuación (los indentados). */
function lineaDeLaAccion(prompt: string, accion: string): string {
  const lineas = prompt.split("\n");
  const i = lineas.findIndex((l) => l.includes(`- ${accion} |`));
  if (i < 0) return "";
  const cont: string[] = [lineas[i]!];
  for (let j = i + 1; j < lineas.length && /^\s/.test(lineas[j]!) && !lineas[j]!.trimStart().startsWith("- "); j++) {
    cont.push(lineas[j]!);
  }
  return cont.join(" ");
}

test("revisar_reputacion ya está cableada, así que SÍ se anuncia — y sigue rechazando limpio sin ella", async () => {
  // ESTE TEST CAMBIÓ DE SENTIDO, y esa es la señal de que el proceso funcionó. Nació afirmando que
  // la mano NO se anunciaba, porque el equipo que escribió el módulo la dejó sin productor en
  // runtime y el auditor —con razón— prefirió sacar la línea del prompt antes que dejar una
  // promesa suelta. Su propio comentario decía: "el día que el orquestador pase la capacidad,
  // vuelven las líneas y este test cambia de sentido". Ese día es hoy: el orquestador la cablea en
  // los dos carriles, sin flag, así que la línea volvió.
  //
  // Lo que se fija ahora es el estado bueno, no el transitorio: anunciada Y cableada. El contrato
  // general (el test de arriba) es el que impide que se vuelvan a separar.
  assert.ok(SISTEMA.includes("- revisar_reputacion |"), "la guardia tiene los ojos y tiene que saberlo");
  assert.match(SISTEMA, /una lista negra LIMPIA no significa que estés/, "con la lección del 2026-07-25 pegada");

  // Y el rechazo limpio sigue vivo para el entorno que NO la cablee (los tests, el dry-run): una
  // mano ausente se declara, nunca se simula.
  const r = await ejecutarAcciones([{ accion: "revisar_reputacion", dominio: "a.com", motivo: "x" }], {
    dominiosConocidos: ["a.com"],
    diagnosticarDominio: async () => ({ estado: "ok", bloqueanPor: [], degradadoEn: [], entregados: 1, rechazados: 0, detalle: "" }),
    pendientes: { listar: async () => [], guardar: async () => {} }
  } as never);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no está habilitado en este entorno/);
});

test("el prompt ya no lleva el criterio en prosa", () => {
  const p = construirPrompt({
    ...HECHOS_BASE,
    cap: CAP_FRENADOS([{ dominio: "filing-ops.com", cruzado: false, bloqueanPor: [], muestra: 0, tasaInbox: null }])
  });
  assert.ok(!p.includes("si alguno califica"), "esa frase es el criterio en prosa que hay que matar");
  assert.match(p, /filing-ops\.com: califica para soltar_dominio/);
});

test("EL CONTRATO: ningún marcador que VOZ le pide al modelo se publica crudo", async () => {
  // LA MISMA LECCIÓN QUE LAS MANOS, pero sobre los MARCADORES. El test de arriba solo mira acciones
  // (`- <accion> |`), así que no vio lo que pasó con el marcador nuevo: VOZ le pide al modelo
  // `PROMETI: <qué> | espero=<campo>` y le dice que esa línea es la única forma de que el aviso
  // exista, mientras el único consumidor real de VOZ limpiaba el texto con dos `.replace` escritos a
  // mano —`^ACCION:` y `^RECORDAR:`— y nada más. Resultado: el andamiaje pelado saliendo a Slack.
  //
  // Se acepta cualquiera de los dos caminos, porque los dos cierran el agujero: que el módulo
  // CONSUMA el marcador y lo saque del texto (lo que hace hoy `responder` con PROMETI), o que el
  // orquestador lo limpie antes de publicar (lo que hace con ACCION y RECORDAR, que él sí lee).
  //
  // SOLO VOZ, no SISTEMA: los marcadores de SISTEMA (AHORA/PORQUE/RIESGO/FALTA) son la ESTRUCTURA de
  // la lectura, la parsea `verificarLectura` y lo que se publica de ahí son campos ya extraídos,
  // nunca el texto crudo del modelo.
  const { readFile } = await import("node:fs/promises");
  const orquestador = sinComentarios(await readFile(new URL("../../../../scripts/ops/warmup-monitor.ts", import.meta.url), "utf8"));

  const marcadores = VOZ.match(/^[A-ZÁÉÍÓÚ]{4,}(?=:\s*<)/gm) ?? [];
  assert.ok(marcadores.length >= 3, `no se pudieron leer los marcadores de VOZ (leí ${marcadores.length})`);

  for (const marcador of marcadores) {
    const linea = `${marcador}: lo que sea | campo=valor`;
    assert.equal(limpiarMaquinaria(`Dale Juanes.\n${linea}`), "Dale Juanes.", `limpiarMaquinaria no conoce ${marcador}`);

    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: `Dale Juanes.\n${linea}` } }], usage: {} })
    })) as never;
    const r = await responder({ contexto: { hilo: [], snapshot: null, loQueHiciste: [] }, baseUrl: "http://x/v1", modelo: "m", fetchImpl });
    if (!new RegExp(`^${marcador}:`, "im").test(r.texto ?? "")) continue; // el módulo ya lo consumió

    // Se acepta `limpiarParaSlack` además de `limpiarMaquinaria`: la primera LLAMA a la segunda y
    // encima saca el markdown que el modelo mete solo (asteriscos, viñetas, títulos). O sea que es
    // un saneador estrictamente más fuerte, y exigir el nombre exacto de la función interna habría
    // hecho fallar el gate por usar la versión mejor. El invariante que se protege no es qué
    // función se llama: es que NINGÚN marcador del prompt llegue crudo a Slack.
    assert.ok(
      /\blimpiar(Maquinaria|ParaSlack)\s*\(/.test(orquestador) || new RegExp(`\\^${marcador}:`).test(orquestador),
      `VOZ le pide al modelo la línea "${marcador}:", esa línea sobrevive en RespuestaChat.texto y ` +
        `scripts/ops/warmup-monitor.ts publica ese texto sin sacarla: el jefe va a ver el andamiaje. ` +
        `O el orquestador llama a limpiarMaquinaria, o el marcador se consume en el módulo, o se saca del prompt.`
    );
  }
});

test("el prompt de la guardia ya no le ENSEÑA a arrancar cada frase con el nombre del jefe", () => {
  // El ejemplo de la VOZ decía textual: "sin rodeos: 'Juanes, esto no lo puedo destrabar yo, mirá
  // X'". O sea que el prompt le mostraba el tic, y el modelo aprendió: 71 de las 192 líneas VOZ del
  // log de producción arrancan con "Juanes,". Mientras tanto slack.ts declara el invariante
  // contrario y nadie lo aplicaba en ningún lado.
  //
  // Los dos hablan por el mismo canal privado: repetirle el nombre en cada frase no es cercanía, es
  // plantilla. Se assertea sobre la constante SISTEMA y no sobre el archivo, así que un comentario
  // que CITE el ejemplo viejo —como el que explica este cambio— no da falso verde.
  assert.ok(!SISTEMA.includes("Juanes,"), "el prompt no puede traer el vocativo ni siquiera como ejemplo");
  assert.match(SISTEMA.replace(/\s+/g, " "), /sin rodeos y sin arrancar con su nombre/);
  // Y la regla que se está cuidando sigue viva: el ejemplo tiene que seguir mostrando CUÁNDO pedir.
  assert.match(SISTEMA.replace(/\s+/g, " "), /esto no lo puedo destrabar yo, mira X/);
});

test("EL REPARO FALSO: nombrar un dominio que NOSOTROS le dimos en su bitácora no es inventarlo", () => {
  // Medido en el log de producción: 3 de 51 vueltas. `construirPrompt` le entrega "LO QUE YA
  // PEDISTE" con el nombre del dominio adentro, el agente lo nombra en su lectura, y `conocidos`
  // —armado solo desde `hechos`— lo marcaba como invención. Como el runner ejecuta acciones solo
  // cuando `reparos.length === 0`, perdía las manos la vuelta entera por citar lo que le dimos.
  //
  // Es la TERCERA instancia de la clase que este mismo archivo declara peor que el error que
  // previene: un reparo falso bloquea también las acciones correctas.
  const loQueHiciste = [
    "- pediste diagnosticar_dominio bizregistry-ops.com (lo pediste 34 veces) y NO se ejecutó: sin datos. Pedirlo otra vez no lo va a cambiar."
  ];
  const texto = "AHORA: sigo sin poder diagnosticar bizregistry-ops.com\nPORQUE: lo pedí 34 veces y siempre vuelve vacío\nRIESGO: ninguno\nFALTA: nada";

  const sinBitacora = verificarLectura(texto, HECHOS_BASE);
  assert.ok(sinBitacora.reparos.some((r) => /bizregistry-ops\.com/.test(r)), "así estaba antes: reparo sobre un dato nuestro");

  const conBitacora = verificarLectura(texto, HECHOS_BASE, loQueHiciste);
  assert.deepEqual(conBitacora.reparos, [], "el dominio salió de nuestro propio prompt");

  // Y lo que SÍ es una invención sigue siendo una invención: la puerta se abre para lo que le
  // dimos, no para cualquier cosa.
  const inventado = verificarLectura(
    "AHORA: bizregistry-ops.com y jamas-existio.com están cerrados\nPORQUE: los diagnostiqué\nRIESGO: ninguno\nFALTA: nada",
    HECHOS_BASE,
    loQueHiciste
  );
  assert.ok(inventado.reparos.some((r) => /jamas-existio\.com/.test(r)));
});

test("los FRENADOS son datos que le dimos: nombrarlos no es inventarlos", () => {
  // El mismo agujero por otra puerta: las ocho líneas de FRENADOS entran al prompt con su nombre y
  // `conocidos` no las miraba. Los 7 nodos vírgenes son justo los que hay que evaluar para soltar.
  const hechos = { ...HECHOS_BASE, cap: CAP_FRENADOS([{ dominio: "filing-ops.com", cruzado: false, bloqueanPor: [], muestra: 0, tasaInbox: null }]) };
  const v = verificarLectura("AHORA: filing-ops.com sigue frenado\nPORQUE: tiene cupo 0\nRIESGO: ninguno\nFALTA: nada", hechos);
  assert.deepEqual(v.reparos, []);
});

test("el placement del plan NUNCA sale sin su proveedor, y el gate solo si alguien lo evaluó", () => {
  // Con una sola semilla que mide (Gmail), un "83%" a secas es 83%-en-Gmail disfrazado de placement
  // general — y los umbrales de la receta son distintos por proveedor. Mientras el motor no emita el
  // campo se dice "sin proveedor": la verdad, no un default.
  const conProveedor = construirPrompt({
    ...HECHOS_BASE,
    plan: [{ dominio: "a.com", diaN: 3, placementTasa: 0.83, placementMuestra: 6, placementProveedor: "Gmail", gate: { pasa: true, falla: null }, cupo: 2, accion: "sostener", motivo: "m", enviadosHoy: 2 }]
  });
  assert.match(conProveedor, /placement Gmail 83% sobre 6 mediciones/);
  assert.match(conProveedor, /gate: PASA/);

  const sinProveedor = construirPrompt({
    ...HECHOS_BASE,
    plan: [{ dominio: "a.com", diaN: 3, placementTasa: 0.83, placementMuestra: 6, cupo: 2, accion: "sostener", motivo: "m", enviadosHoy: 2 }]
  });
  assert.match(sinProveedor, /placement sin proveedor 83% sobre 6 mediciones/);
  assert.doesNotMatch(sinProveedor, /gate:/, "sin evaluación no se nombra el gate: silencio, nunca 'pasa'");

  // Y "no medido" sigue sin ser "0%".
  const sinMedir = construirPrompt({
    ...HECHOS_BASE,
    plan: [{ dominio: "a.com", diaN: null, placementTasa: null, placementMuestra: 0, cupo: 2, accion: "arrancar", motivo: "m", enviadosHoy: 0 }]
  });
  assert.match(sinMedir, /placement SIN MEDIR \(0 mediciones\)/);
});

test("los 5 reparos de la MISMA lección ocupan UNA línea con contador, no cinco", () => {
  // Medido en el archivo real: las 5 ranuras de "ERRORES QUE YA COMETISTE" estaban ocupadas por la
  // misma lección con cinco dominios distintos, o sea que la memoria de errores tenía capacidad
  // para UNA sola lección y cualquier otra clase quedaba empujada afuera por el slice.
  const cinco = [
    'nombra "bizregistry-ops.com", que no está en los datos',
    'nombra "corpfiling-relay.com", que no está en los datos',
    'nombra "controlnationalcorp.com", que no está en los datos',
    'nombra "annualfiling-infra.com", que no está en los datos',
    'nombra "corpannualinfra.com", que no está en los datos'
  ];
  const g = agruparReparos(cinco);
  assert.equal(g.length, 1);
  assert.match(g[0] as string, /te pasó 5 veces, con distintos nombres/);
  assert.match(g[0] as string, /bizregistry-ops\.com/, "conserva el texto completo del primero");

  // Y una lección DISTINTA no se funde con ellas: el agrupamiento es por clase, no por parecido.
  const conOtra = agruparReparos([...cinco, "dice que cruzaron 5 dominios y los datos dicen 9"]);
  assert.equal(conOtra.length, 2);

  // En el prompt, las cinco dejan lugar para las otras cuatro clases que antes no entraban.
  const p = construirPrompt(HECHOS_BASE, [...cinco, "dice que cruzaron 5 dominios y los datos dicen 9"]);
  assert.match(p, /te pasó 5 veces/);
  assert.match(p, /dice que cruzaron 5 dominios/);
});

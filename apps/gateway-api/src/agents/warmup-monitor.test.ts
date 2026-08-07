// Tests del agente monitor. El foco no es "¿el modelo dice cosas lindas?" sino "¿lo que dice se
// sostiene contra los hechos?". Nacieron de una lectura real que atribuyó a Gmail un freno nuestro.

import assert from "node:assert/strict";
import test from "node:test";

import type { HechosWarmup } from "./warmup-monitor.ts";


// ── Verificación de la lectura ───────────────────────────────────────────────────────────────────
// Le pedimos en el prompt que use solo los datos dados, y aun así afirmó que el freno era de Gmail.
// Una regla en el prompt es una intención; esto es una verificación.

import { ejecutarAcciones, extraerAcciones } from "./acciones-agente.ts";
import { VOZ } from "./sentinel-chat.ts";
import { construirPrompt, lineasDeFrenados, SISTEMA, verificarLectura, type FrenadoDetalle } from "./warmup-monitor.ts";

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
  revisar_reputacion: "revisarReputacion"
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

test("revisar_reputacion NO se anuncia mientras no esté cableada, y el case sigue listo", async () => {
  // El caso concreto que disparó el contrato de arriba. `revisarReputacion` no tiene un solo
  // productor en runtime, así que las tres líneas salieron de los DOS prompts. El `case` se queda:
  // el día que el orquestador pase la capacidad, vuelven las líneas y este test cambia de sentido.
  assert.ok(!SISTEMA.includes("- revisar_reputacion |"), "la guardia no puede prometer lo que no tiene");
  assert.ok(!VOZ.includes("- revisar_reputacion |"), "y el chat menos: ahí el jefe se la pide de frente");
  const r = await ejecutarAcciones([{ accion: "revisar_reputacion", dominio: "a.com", motivo: "x" }], {
    dominiosConocidos: ["a.com"],
    diagnosticarDominio: async () => ({ estado: "ok", bloqueanPor: [], degradadoEn: [], entregados: 1, rechazados: 0, detalle: "" }),
    pendientes: { listar: async () => [], guardar: async () => {} }
  } as never);
  assert.equal(r[0]!.ejecutada, false);
  assert.match(r[0]!.detalle, /no está habilitado en este entorno/, "el case existe y rechaza limpio");
});

test("el prompt ya no lleva el criterio en prosa", () => {
  const p = construirPrompt({
    ...HECHOS_BASE,
    cap: CAP_FRENADOS([{ dominio: "filing-ops.com", cruzado: false, bloqueanPor: [], muestra: 0, tasaInbox: null }])
  });
  assert.ok(!p.includes("si alguno califica"), "esa frase es el criterio en prosa que hay que matar");
  assert.match(p, /filing-ops\.com: califica para soltar_dominio/);
});

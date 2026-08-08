import assert from "node:assert/strict";
import test from "node:test";

import { esLineaDe, historiaDe, type FilaHistoria } from "./historia.ts";

// TODO ENTRA POR `historiaDe`, que es la única puerta que el módulo exporta.
//
// Estos tests llamaban a `buscar`, `lineasDeHistoria` y `rangoDe` sueltas, y esa era justamente la
// forma de usar el módulo que el bug del handoff necesitaba: combinarlas a mano con el argumento
// equivocado (`rangoDe` sobre las filas YA filtradas). Con las tres exportadas, un llamador podía
// reintroducir el bug entero con todos estos tests en verde — probaban el interior de `historiaDe`,
// no al que la arma desde afuera. Ahora son privadas y estos tests entran por donde entra el
// orquestador, así que lo que verifican es lo que va a correr.

const fila = (cuando: string, dominio: string | null, que = "algo pasó", origen: FilaHistoria["origen"] = "hechos"): FilaHistoria => ({
  cuando,
  que,
  dominio,
  origen
});

test("RANGO VACÍO: no hay registro NO es cero — y la salida no puede tener un número", () => {
  // LA LECCIÓN MÁS CARA DEL PROYECTO, aplicada al carril nuevo. `delivrix.warmup_activity` tiene un
  // agujero REAL de 13 días (ni una fila entre el 2026-07-21 y el 2026-08-02), así que preguntar por
  // un rango sin datos es el caso NORMAL, no el borde. Si eso sale como "0% de inbox" o "0
  // mediciones", el que lea —modelo o jefe— va a frenar una flota que estaba bien.
  const corpus = [fila("2026-08-06T10:00:00.000Z", "corp-delivery.com"), fila("2026-08-07T11:00:00.000Z", "corp-delivery.com")];
  const salida = historiaDe(corpus, { desde: "2026-07-21", hasta: "2026-08-02" }).join("\n");
  assert.doesNotMatch(salida, /\(lectura\)|\(medición\)/, "el agujero real de 13 días: ni una fila en la ventana");
  assert.match(salida, /no hay registro/, "se dice con palabras");
  assert.doesNotMatch(salida, /0%/, "un porcentaje sobre cero filas es una afirmación inventada");
  assert.doesNotMatch(salida, / 0 /, "ningún conteo: la ausencia de dato no es un cero");
  assert.match(salida, /tampoco que no pasó nada/, "la ausencia tampoco prueba lo contrario");
});

test("HORIZONTE DECLARADO: pedir 30 días sobre un corpus de 2 dice desde cuándo hay registro", () => {
  // El corpus de destilación arrancó el 2026-08-06 y se llena SOLO mientras el maestro corra. Si el
  // maestro se cae, la fuente se seca en silencio y las filas viejas siguen ahí. Sin esta línea,
  // "no encontré nada del 10 de julio" se lee como "no pasó nada el 10 de julio". Es exactamente la
  // frase que el agente tuvo que improvisar a mano en el canal el 2026-08-07.
  const corpus = [fila("2026-08-06T10:00:00.000Z", "x.com"), fila("2026-08-07T10:00:00.000Z", "x.com")];
  const lineas = historiaDe(corpus, { desde: "2026-07-08", hasta: "2026-08-07" });
  const salida = lineas.join("\n");

  assert.match(salida, /2026-08-06/, "dice desde cuándo hay registro, aunque le hayan pedido 30 días");
  assert.match(salida, /fuera de esa ventana no guardo nada/);
  // Y la declaración va PRIMERO: si va al final, cualquier recorte por longitud se la come y queda
  // justo la parte que afirma, sin la que aclara.
  assert.match(lineas[0]!, /tengo registro desde/);
});

test("sin corpus no se inventa un horizonte", () => {
  const salida = historiaDe([], { desde: "2026-08-01", hasta: "2026-08-07" }).join("\n");
  assert.match(salida, /no tengo NADA guardado todavía/);
  assert.doesNotMatch(salida, / 0 /);
  assert.doesNotMatch(salida, /tengo registro desde/, "sin una sola fila no se puede declarar un horizonte");
});

test("el dominio se compara ENTERO, nunca por pedazo", () => {
  // Un identificador no es texto libre. Por substring, "corp-delivery.com" traería
  // "corp-delivery.com.br" y el jefe recibiría la historia de otro nodo con nombre parecido.
  const corpus = [
    fila("2026-08-06T10:00:00.000Z", "corp-delivery.com", "cayó en spam"),
    fila("2026-08-06T11:00:00.000Z", "corp-delivery.com.br", "otro nodo"),
    fila("2026-08-06T12:00:00.000Z", null, "global")
  ];
  const salida = historiaDe(corpus, { dominio: "CORP-DELIVERY.COM", desde: "2026-08-01", hasta: "2026-08-07" }).join("\n");
  assert.match(salida, /cayó en spam/);
  assert.doesNotMatch(salida, /otro nodo/, "corp-delivery.com.br es otro nodo: sería la historia de otro");
  assert.doesNotMatch(salida, /global/, "una fila sin dominio no es de este dominio");
});

test("de lo más nuevo a lo más viejo, y acotado", () => {
  const corpus = ["2026-08-01", "2026-08-05", "2026-08-03"].map((d) => fila(`${d}T10:00:00.000Z`, "x.com", d));
  const lineas = historiaDe(corpus, { desde: "2026-08-01", hasta: "2026-08-07" }, 2).filter((l) => /\(lectura\)/.test(l));
  assert.deepEqual(lineas.map((l) => l.slice(-10)), ["2026-08-05", "2026-08-03"], "primero lo reciente, y respeta el tope");
});

test("`hasta` sin hora incluye el día ENTERO", () => {
  // Borde de un carácter con consecuencia grande: "2026-08-07T09:00Z" > "2026-08-07", así que sin
  // cerrar a fin de día pedir "hasta el 7" descartaba todo el 7 y devolvía "no hay registro" sobre
  // un día que sí tenía filas. Una ausencia fabricada es peor que no responder.
  const corpus = [fila("2026-08-07T09:00:00.000Z", "x.com", "de mañana"), fila("2026-08-07T23:30:00.000Z", "x.com", "de noche")];
  const salida = historiaDe(corpus, { desde: "2026-08-07", hasta: "2026-08-07" }).join("\n");
  assert.match(salida, /de mañana/);
  assert.match(salida, /de noche/, "sin cerrar a fin de día, todo el 7 desaparecía y salía 'no hay registro'");
  assert.doesNotMatch(salida, /no hay registro/);
});

test("la línea distingue lo que MIDIÓ de lo que solo vio", () => {
  // Una lectura del agente es una impresión suya; una medición es evidencia contra una bandeja.
  // Mezclarlas ya costó caro en este proyecto (fixtures servidos por el panel como medición real).
  const salida = historiaDe(
    [fila("2026-08-06T10:00:00.000Z", "x.com", "INBOX en la semilla", "placement")],
    { dominio: "x.com", desde: "2026-08-01", hasta: "2026-08-07" }
  ).join("\n");
  assert.match(salida, /2026-08-06 10:00 \(medición\) x\.com: INBOX en la semilla/);
});

// ── LO QUE NO ESTABA CUBIERTO Y SOBREVIVÍA A LA MUTACIÓN ──────────────────────────────────────────

test("el horizonte: mínimo y máximo REALES sobre un corpus desordenado, no el primero ni el último", () => {
  // Los 7 tests originales pasaban con `rangoDe` devolviendo la PRIMERA fila para los dos extremos,
  // y también con la última: sus corpus venían ordenados y el primer elemento coincidía con el
  // mínimo por casualidad. O sea que el horizonte —el invariante (b) entero, la línea que impide
  // que "no encontré nada del 20 de julio" se lea como "no pasó nada el 20 de julio"— podía mentir
  // sin que nada fallara. Desordenado a propósito.
  const corpus = [
    fila("2026-08-04T10:00:00.000Z", "x.com"),
    fila("2026-07-30T09:00:00.000Z", "x.com"),
    fila("2026-08-07T23:00:00.000Z", "x.com"),
    fila("2026-08-01T12:00:00.000Z", "x.com")
  ];
  // Se lee por el horizonte que declara la salida, que es para lo único que existe el mínimo/máximo.
  const salida = historiaDe(corpus, { dominio: "x.com", desde: "2026-08-04", hasta: "2026-08-04" }).join("\n");
  assert.match(salida, /tengo registro desde el 2026-07-30 y hasta el 2026-08-07/);
});

test("lo anterior a `desde` queda AFUERA — si no, 'no hay registro' es inalcanzable", () => {
  // Borrar el filtro de `desde` dejaba los 7 tests en verde. Con él roto, cualquier ventana vacía
  // traería las filas viejas y la frase "no hay registro entre X e Y" no se emitiría nunca: el
  // agente contestaría con datos de otro mes como si fueran de la ventana que le pidieron.
  const corpus = [fila("2026-07-01T10:00:00.000Z", "x.com", "viejo"), fila("2026-08-06T10:00:00.000Z", "x.com", "nuevo")];
  const ventana = historiaDe(corpus, { dominio: "x.com", desde: "2026-08-01", hasta: "2026-08-07" }).join("\n");
  assert.match(ventana, /nuevo/);
  assert.doesNotMatch(ventana, /viejo/, "lo anterior a `desde` queda afuera");
  const salida = historiaDe(corpus, { dominio: "x.com", desde: "2026-07-10", hasta: "2026-07-20" }).join("\n");
  assert.match(salida, /no hay registro entre el 2026-07-10 y el 2026-07-20/);
});

test("el sello va en los DOS sentidos: una LECTURA nunca se publica como medición", () => {
  // Solo estaba cubierto el sentido "placement ⇒ medición", así que colapsar todo a "medición"
  // sobrevivía. Y eso es publicar una impresión del agente como evidencia contra una bandeja —
  // mezclar las dos cosas es lo que ya costó caro acá (fixtures servidos por el panel como
  // medición real).
  const salida = historiaDe(
    [fila("2026-08-06T10:00:00.000Z", "x.com", "lo vi en el retrato del día", "hechos")],
    { dominio: "x.com", desde: "2026-08-01", hasta: "2026-08-07" }
  ).join("\n");
  assert.match(salida, /\(lectura\) x\.com: lo vi en el retrato del día/);
  assert.doesNotMatch(salida, /medición/, "una lectura del agente no es evidencia");
});

// ── historiaDe: LA PUERTA ÚNICA ──────────────────────────────────────────────────────────────────

test("EL HORIZONTE SE MIDE SOBRE TODO EL CORPUS, no sobre lo que quedó en la ventana", () => {
  // EL BUG DEL HANDOFF, y las dos afirmaciones que producía eran falsas de forma opuesta:
  //
  //   · ventana vacía sobre corpus lleno → "no tengo NADA guardado todavía" (el agente declarándole
  //     al jefe que no tiene una memoria que sí tiene);
  //   · ventana de un día sobre 35 filas del 01 al 07 → "tengo registro desde el 03 y hasta el 03"
  //     (negándose a mirar días que sí guardó).
  //
  // Por eso el horizonte no es un parámetro que el llamador calcule: `historiaDe` recibe el corpus
  // entero y hace el recorte adentro.
  const corpus = [
    fila("2026-08-01T10:00:00.000Z", "a.com", "el primero"),
    fila("2026-08-03T10:00:00.000Z", "a.com", "el del medio"),
    fila("2026-08-07T10:00:00.000Z", "a.com", "el último")
  ];

  const vacia = historiaDe(corpus, { dominio: "a.com", desde: "2026-07-21", hasta: "2026-07-25" }).join("\n");
  assert.match(vacia, /no hay registro entre el 2026-07-21 y el 2026-07-25/);
  assert.match(vacia, /tengo registro desde el 2026-08-01 y hasta el 2026-08-07/, "el corpus existe y se declara");
  assert.doesNotMatch(vacia, /no tengo NADA guardado/, "tiene memoria: decir que no la tiene es la falsedad exacta del handoff");

  const unDia = historiaDe(corpus, { dominio: "a.com", desde: "2026-08-03", hasta: "2026-08-03" }).join("\n");
  assert.match(unDia, /tengo registro desde el 2026-08-01 y hasta el 2026-08-07/, "el horizonte no se encoge con la ventana");
  assert.match(unDia, /el del medio/);
  assert.doesNotMatch(unDia, /el último/, "pero solo devuelve lo de la ventana pedida");
});

test("EL RECORTE SE DICE: 35 en la ventana y 12 en pantalla no se sirven como 'esto es todo'", () => {
  const corpus = Array.from({ length: 35 }, (_, i) =>
    fila(`2026-08-0${1 + Math.floor(i / 6)}T${String(8 + (i % 6)).padStart(2, "0")}:00:00.000Z`, "a.com", `evento ${i}`)
  );
  const salida = historiaDe(corpus, { dominio: "a.com", desde: "2026-08-01", hasta: "2026-08-07" }, 12);
  assert.equal(salida.length, 13, "el horizonte más los 12");
  assert.match(salida[0]!, /Hay 35 registros en esa ventana y te muestro los 12 más recientes/);
});

test("sin recorte no se agrega la frase: nada de números cuando no hubo nada que recortar", () => {
  const corpus = [fila("2026-08-06T10:00:00.000Z", "a.com", "único")];
  const salida = historiaDe(corpus, { dominio: "a.com", desde: "2026-08-01", hasta: "2026-08-07" }, 12).join("\n");
  assert.doesNotMatch(salida, /Hay \d+ registros/);
  // Y la ventana vacía sigue sin un solo número más allá de las fechas. Invariante (a).
  const vacia = historiaDe([], { dominio: "a.com", desde: "2026-08-01", hasta: "2026-08-07" }).join("\n");
  assert.match(vacia, /no tengo NADA guardado todavía/);
  assert.doesNotMatch(vacia, / 0 /);
});

test("esLineaDe: el estado de la flota entera NO se atribuye a un dominio porque lo nombre", () => {
  // Líneas REALES del retrato del día. `includes(dominio)` devolvía las tres: la de flota matchea
  // solo porque el dominio figura en la enumeración de cruzados, y la de pendientes es prosa que
  // escribió el propio agente. Publicarlas fechadas a nombre del dominio es fabricar el hecho
  // ambiguo que este proyecto ya pagó.
  const flota = "Flota (medida hace 4.7h): 6 entregan, 35 cerradas por el receptor. CRUZARON el umbral permanente: corp-delivery.com, otro.com.";
  const pendientes = "Pendientes que YA anotaste: p-5-identificar-los-4-dominios-en-rats-dyna-, sobre corp-delivery.com.";
  const propia = "- corp-delivery.com: la IP figura en 1 lista negra: RATS Dyna.";

  assert.equal(esLineaDe(flota, "corp-delivery.com"), false);
  assert.equal(esLineaDe(pendientes, "corp-delivery.com"), false);
  assert.equal(esLineaDe(propia, "corp-delivery.com"), true);
  assert.equal(esLineaDe("- CORP-DELIVERY.COM: en mayúsculas", "corp-delivery.com"), true);
  assert.equal(esLineaDe("- corp-delivery.com (217.216.53.43): en RATS Dyna", "corp-delivery.com"), true, "la línea de reputación lleva la IP entre paréntesis");
  // Y NO se lleva las líneas de un dominio con nombre parecido. Es la misma regla que `buscar`
  // aplica del otro lado: un identificador se compara entero, nunca por pedazo.
  assert.equal(esLineaDe("- corp-delivery.com.br: otro nodo", "corp-delivery.com"), false);
  assert.equal(esLineaDe("- corp-delivery.com.br: otro nodo", "corp-delivery.com.br"), true);
});

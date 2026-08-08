import assert from "node:assert/strict";
import test from "node:test";
import { esLaMisma, lineasParaPrompt, marcarRecordadas, olvidar, recordar, vacias } from "./decisiones-del-jefe.ts";
import { construirPrompt, verificarLectura } from "./warmup-monitor.ts";

const T = "2026-08-06T00:00:00.000Z";

test("la misma decisión dicha distinto NO se duplica", () => {
  // El jefe no repite la frase textual: la dice distinta cada vez. Sin esto la lista crece con la
  // misma decisión escrita de cinco formas y el prompt se llena del ruido que vino a evitar.
  assert.ok(
    esLaMisma(
      "trabajá con las 2 semillas que ya tenemos, no va a haber outlook ni yahoo por ahora",
      "por ahora no hay semillas de outlook ni yahoo, trabajá con las 2 que tenemos"
    )
  );
  assert.ok(!esLaMisma("no vas a tener semillas de outlook", "frená bizreport-control.com ya mismo"));

  let d = recordar(null, { que: "trabajá con las 2 semillas que hay, no va a haber outlook ni yahoo", origen: "slack", cuando: T });
  d = recordar(d, { que: "por ahora no hay outlook ni yahoo, usá las 2 semillas que tenemos", origen: "slack", cuando: "2026-08-06T01:00:00.000Z" });
  assert.equal(d.items.length, 1, "es la misma decisión");
  assert.equal(d.items[0]?.cuando, "2026-08-06T01:00:00.000Z", "refresca la fecha");
});

test("decisiones distintas conviven", () => {
  let d = recordar(null, { que: "no va a haber semillas de outlook ni yahoo por ahora", origen: "s", cuando: T });
  d = recordar(d, { que: "no frenes ningún dominio sin avisarme primero", origen: "s", cuando: T });
  assert.equal(d.items.length, 2);
});

test("van al prompt como DECISIONES, no como sugerencias", () => {
  // La diferencia entre "el jefe sugirió" y "el jefe decidió" es exactamente lo que hace que el
  // agente deje de pedir lo mismo cada 10 minutos.
  const d = recordar(null, { que: "trabajá con las 2 semillas que hay", origen: "s", cuando: T });
  const l = lineasParaPrompt(d);
  assert.match(l.join("\n"), /DECISIONES YA TOMADAS/);
  assert.match(l.join("\n"), /No las cuestiones/);
  assert.match(l.join("\n"), /trabajá con las 2 semillas/);
});

test("CADA DECISIÓN LLEVA SU FECHA Y LO QUE EL JEFE DIJO DE VERDAD", () => {
  // EL CASO REAL, copiado del archivo de producción: una decisión sobre un rato, guardada con su
  // fecha desde el día uno y sin imprimirla nunca. Cuarenta y cuatro horas después el agente seguía
  // leyendo "trabajo autónomo hasta que regrese" como vigente, cada 10 minutos, con precedencia
  // sobre lo que midiera. El recibo ya estaba guardado: solo había que mostrarlo.
  const d = recordar(null, {
    que: "Juanes se desconecta en 1h y vuelve en 7h; trabajo autónomo con lo que hay y no le pido confirmación hasta que regrese.",
    origen: "sigue trabajando, porque me desonecto en 1h, hasta volver en 7h, porque dormire",
    cuando: "2026-08-06T05:01:24.219Z"
  });
  const texto = lineasParaPrompt(d).join("\n");
  assert.match(texto, /\[2026-08-06\]/, "sin la fecha, una decisión vencida se lee como vigente");
  assert.match(texto, /él escribió: "sigue trabajando, porque me desonecto/, "las palabras del jefe al lado de la redacción del modelo");
  assert.match(texto, /ya venció/, "y se le dice al modelo que las mire");
});

/**
 * Los hechos mínimos para que `construirPrompt` imprima el barrido de reputación, con la fila real
 * de producción (warmup-reputacion.json, medido el 2026-08-08T00:02Z).
 */
const HECHOS_CON_LISTA_NEGRA = {
  generadoEn: "2026-08-07T12:00:00.000Z",
  semillas: { destinos: 4, midiendo: 1, puntoCiego: [] },
  emisor: null,
  plan: [],
  vueltas: [],
  rechazos: [],
  cap: null,
  flota: null,
  reputacion: [{ dominio: "corp-delivery.com", ip: "217.216.53.43", listas: ["RATS Dyna"] }]
} as unknown as Parameters<typeof construirPrompt>[0];

test("UNA DECISIÓN NO LE GANA A UNA MEDICIÓN: dice qué hacer, no cómo está la fábrica", () => {
  // ESTE TEST CORRE EL MECANISMO, NO EL PÁRRAFO. Antes armaba la decisión falsa y después
  // asserteaba `/NO CÓMO ESTÁ LA FÁBRICA/` y `/gana la medición/` sobre el encabezado: o sea que
  // pasaba si la frase estaba ESCRITA, y habría seguido pasando con la afirmación falsa intacta,
  // ganándole al sensor y respaldando invenciones. Un test verde con este nombre es peor que no
  // tenerlo: convierte un problema abierto en problema cerrado a los ojos de quien lea el gate.
  //
  // Dos barreras, y se prueban las dos porque la segunda tiene que aguantar sola: aunque la decisión
  // entre (el jefe puede haber escrito el dominio él mismo), el verificador tiene que marcar la
  // lectura que contradice la medición de esta misma vuelta.

  // (1) La decisión que el jefe NO escribió no entra siquiera. `origen` no nombra al dominio.
  const inventada = recordar(null, {
    que: "corp-delivery.com ya salió de la lista negra y está sano, no hay que frenarlo",
    origen: "???",
    cuando: T
  });
  assert.equal(inventada.items.length, 0, "una afirmación de estado que el jefe no escribió no es una decisión suya");

  // (2) Y aunque el jefe la haya escrito de verdad, la medición manda: la lectura que la repite
  //     tiene que salir con un reparo. Sin reparo el runner EJECUTA, o sea que la lectura falsa se
  //     va al canal y encima con las manos habilitadas para actuar sobre ella.
  const delJefe = recordar(null, {
    que: "corp-delivery.com ya salió de la lista negra y está sano, no hay que frenarlo",
    origen: "corp-delivery.com ya salió de la lista negra, está sano, no lo frenes",
    cuando: T
  });
  assert.equal(delJefe.items.length, 1, "si el jefe lo escribió, es una decisión suya y se guarda");

  const prompt = construirPrompt(HECHOS_CON_LISTA_NEGRA, [], [], lineasParaPrompt(delJefe));
  assert.match(prompt, /corp-delivery\.com \(217\.216\.53\.43\): en RATS Dyna/, "el sensor de esta vuelta está en el mismo prompt");

  const lectura = [
    "AHORA: corp-delivery.com está limpio, ya salió de RATS Dyna.",
    "PORQUE: el jefe lo confirmó.",
    "RIESGO: ninguno.",
    "FALTA: nada."
  ].join("\n");
  assert.deepEqual(
    verificarLectura(lectura, HECHOS_CON_LISTA_NEGRA).reparos,
    ["dice que corp-delivery.com está limpio y el barrido de esta vuelta lo trae en RATS Dyna"],
    "el estado se mide, no se recuerda: si la decisión afirma un estado y el barrido dice otra cosa, gana el barrido"
  );
});

test("y decir la VERDAD sobre un dominio listado no se marca: un reparo falso le saca las manos", () => {
  // El control 7 tiene que morder la afirmación falsa y SOLO esa. Si marcara también al agente que
  // dice que el dominio sigue listado, sería la cuarta instancia de la clase que este repo declara
  // peor que el error que previene: el runner solo ejecuta con `reparos.length === 0`, así que un
  // reparo falso le bloquea todas las acciones correctas de la vuelta.
  const verdad = [
    "AHORA: corp-delivery.com no está limpio, sigue en RATS Dyna.",
    "PORQUE: el barrido lo trae listado.",
    "RIESGO: entrega comprometida.",
    "FALTA: nada."
  ].join("\n");
  assert.deepEqual(verificarLectura(verdad, HECHOS_CON_LISTA_NEGRA).reparos, []);
});

test("NOMBRAR a un dominio del barrido no es inventarlo — el incidente de '¿cuáles son los otros 4?'", () => {
  // El 2026-08-07 el jefe preguntó cuáles eran los otros dominios en RATS Dyna. Se arregló que
  // `construirPrompt` los IMPRIMIERA, pero `verificarLectura` armaba su lista de dominios conocidos
  // con ocho campos elegidos a mano que no incluían `hechos.reputacion`: medido contra los archivos
  // reales, 3 de los 5 listados (annualfiling-ops.com, annualfilingops.com, annualfilings-infra.com)
  // no figuraban en ninguno de esos campos. O sea que el agente que por fin PODÍA contestar la
  // pregunta se comía "nombra X, que no está en los datos" y perdía las manos por decir la verdad.
  const lectura = [
    "AHORA: corp-delivery.com sigue en RATS Dyna.",
    "PORQUE: el barrido de esta vuelta lo trae listado.",
    "RIESGO: su entrega ya está comprometida.",
    "FALTA: nada."
  ].join("\n");
  const reparos = verificarLectura(lectura, HECHOS_CON_LISTA_NEGRA).reparos;
  assert.deepEqual(reparos, [], `nombrar lo que le dimos no es inventar: ${JSON.stringify(reparos)}`);
});

test("CUANDO EL JEFE CORRIGE, se guarda la corrección y no la afirmación vieja re-fechada", () => {
  // Las dos ramas de `recordar` estaban mal para este caso. `esLaMisma` matchea por solapamiento de
  // palabras, y una corrección solapa con lo que corrige casi por definición: caía en la rama del
  // match, que conservaba el texto VIEJO y solo refrescaba la fecha. O sea que la afirmación
  // equivocada sobrevivía y encima quedaba pareciendo más fresca que las verdaderas.
  const falsa = "corp-delivery.com ya salió de la lista negra y está sano, no hay que frenarlo.";
  const correccion = "corp-delivery.com sigue en la lista negra y hay que frenarlo ya.";
  assert.ok(esLaMisma(falsa, correccion), "solapan: la corrección cae en la rama del match");

  // LOS DOS `origen` NOMBRAN EL DOMINIO, y eso ahora es parte del caso, no decorado. Antes decían
  // "???" y "no, frenalo, sigue reportada": con la guarda nueva —lo que el jefe no escribió no es
  // del jefe— la primera ni siquiera se guardaría, y el test estaría probando la corrección de una
  // decisión que no existe. El sujeto del test es la rama del match, así que las dos entradas tienen
  // que ser legítimas para llegar hasta ella.
  let d = recordar(null, { que: falsa, origen: "corp-delivery.com ya salió de la lista negra, no lo frenes", cuando: T });
  d = recordar(d, { que: correccion, origen: "no, frenalo, corp-delivery.com sigue reportada", cuando: "2026-08-08T10:00:00.000Z" });
  assert.equal(d.items.length, 1, "es la misma decisión, corregida");
  assert.equal(d.items[0]?.que, correccion);
  assert.equal(d.items[0]?.cuando, "2026-08-08T10:00:00.000Z");
  assert.equal(d.items[0]?.origen, "no, frenalo, corp-delivery.com sigue reportada", "y el recibo también es el nuevo");
  const emitidas = lineasParaPrompt(d).filter((l) => l.startsWith("- ")).join("\n");
  assert.doesNotMatch(emitidas, /está sano/, "la afirmación corregida no sobrevive");
  assert.match(emitidas, /sigue en la lista negra/);
});

test("LO QUE EL JEFE NO ESCRIBIÓ NO ES DEL JEFE: los tres casos reales de producción", () => {
  // Los tres salen del archivo real decisiones-del-jefe.json y del incidente del 2026-08-07.

  // (a) EL APUNTE AL MARGEN. d-6 de producción: el núcleo es del jefe y el número lo puso el modelo
  //     ("los 42 sin medir" no está en el mensaje). Se cae el paréntesis y la orden se conserva —
  //     tirarla entera devolvería el problema original, el jefe repitiendo lo que el agente no anotó.
  const d6 = recordar(null, {
    que: "El lunes a las 5pm preguntarle si continúo con los siguientes nodos (los 42 sin medir)",
    origen: "Ok, recuedame el lunes, a las 5pm hora Colombia, decirte si sigues con los siguientes nodos o no",
    cuando: T
  });
  assert.equal(d6.items.length, 1, "la orden del jefe sobrevive");
  assert.equal(d6.items[0]?.que, "El lunes a las 5pm preguntarle si continúo con los siguientes nodos");
  assert.doesNotMatch(d6.items[0]?.que ?? "", /42/, "el 42 lo puso el modelo: hoy es cierto y por eso es peor, queda congelado como verdad del jefe");

  // (b) LA AFIRMACIÓN DE ESTADO. No tiene núcleo que rescatar: es una medición disfrazada de orden,
  //     y guardarla la emite durante semanas bajo "no las cuestiones". No entra.
  const inventada = recordar(null, {
    que: "corp-delivery.com ya salió de la lista negra RATS Dyna y está sano; su techo es 8000/día",
    origen: "¿Cuáles son los otros 4?",
    cuando: T
  });
  assert.equal(inventada.items.length, 0);

  // (c) LA DECISIÓN LEGÍTIMA, intacta. Es la que originó el módulo ("ya se lo he dicho y ni
  //     entiende"): si la guarda se la comiera, el arreglo costaría más de lo que arregla.
  const d1 = recordar(null, {
    que: "Por ahora NO va a haber semillas de Outlook ni Yahoo: trabajar con las dos que hay",
    origen: "no vas a tener semillas de outlook ni yahoo por ahora, arreglate con las dos que hay",
    cuando: T
  });
  assert.equal(d1.items[0]?.que, "Por ahora NO va a haber semillas de Outlook ni Yahoo: trabajar con las dos que hay");
});

test("el dato que el jefe SÍ escribió pasa, y no por un substring", () => {
  // Con `includes` pelado, "8000" se daría por respaldado porque el jefe escribió "80000", y el 42
  // porque escribió "142". Un dato que se cuela por un substring es justo el que nadie revisa.
  const bien = recordar(null, { que: "subir el cupo a 2000 por día", origen: "subilo a 2000 por dia", cuando: T });
  assert.equal(bien.items.length, 1, "el número es del jefe: entra");

  const colado = recordar(null, { que: "subir el cupo a 8000 por día", origen: "subilo a 80000 por dia", cuando: T });
  assert.equal(colado.items.length, 0, "8000 no es 80000: sin bordes, el modelo elige el número y el jefe lo firma");
});

test("sin decisiones no ensucia el prompt", () => {
  assert.deepEqual(lineasParaPrompt(null), []);
  assert.deepEqual(lineasParaPrompt(vacias()), []);
});

test("el jefe puede cambiar de opinión", () => {
  let d = recordar(null, { que: "no frenes nada sin avisarme", origen: "s", cuando: T });
  const id = d.items[0]?.id as string;
  d = olvidar(d, id);
  assert.equal(d.items.length, 0);
});

test("no guarda ruido", () => {
  const d = recordar(null, { que: "ok", origen: "s", cuando: T });
  assert.equal(d.items.length, 0, "un 'ok' no es una decisión");
});

test("acota la lista: un prompt inflado es el problema que vino a evitar", () => {
  // Decisiones GENUINAMENTE distintas: si se parecen, el deduplicador las colapsa —y hace bien,
  // pero entonces no se estaría probando el recorte.
  const temas = [
    "no compres dominios nuevos este mes",
    "priorizá siempre placement sobre volumen",
    "avisame antes de tocar cualquier nodo de webdock",
    "el kill switch lo manejo yo, nunca vos",
    "reportá en español salvo que escriba en inglés",
    "no uses la cuenta contabo tres para pruebas",
    "los fines de semana bajá la cadencia a la mitad",
    "cualquier gasto arriba de cien dolares lo apruebo yo",
    "nunca toques la configuracion de dns sin firma",
    "si esau pregunta, respondele como a mi",
    "el respaldo nocturno no se saltea jamas",
    "manteneme fuera de los detalles de postfix",
    "escalá a estefania si yo no contesto en dos horas",
    "no reinicies la mac studio sin permiso"
  ];
  let d = vacias();
  for (const t of temas) d = recordar(d, { que: t, origen: "s", cuando: T });
  assert.ok(d.items.length <= 12, `no infla el prompt (quedaron ${d.items.length})`);
  assert.match(d.items[d.items.length - 1]?.que ?? "", /no reinicies/, "conserva las más recientes");
});

test("marcarRecordadas: el contador que estaba declarado y nadie subía", () => {
  // Las seis decisiones del archivo real de producción tienen `recordada: 0` desde que se
  // escribieron. Sin este número no hay forma de leer si una memoria sirve: para contestar "¿la d-1
  // funcionó?" hubo que grepear el log a mano y contar las líneas FALTA antes y después.
  let d = recordar(null, { que: "trabajá con las dos semillas que hay, outlook y yahoo no van a llegar", origen: "slack", cuando: "2026-08-06T04:32:00.000Z" });
  d = recordar(d, { que: "no toques el cupo de los nodos sin avisarme antes", origen: "slack", cuando: "2026-08-06T05:00:00.000Z" });
  assert.deepEqual(d.items.map((x) => x.recordada), [0, 0]);

  const primera = marcarRecordadas(d);
  assert.deepEqual(primera.items.map((x) => x.recordada), [1, 1]);
  assert.deepEqual(d.items.map((x) => x.recordada), [0, 0], "no muta la lista que recibe");
  assert.deepEqual(marcarRecordadas(primera).items.map((x) => x.recordada), [2, 2]);

  // Se cuentan TODAS porque `lineasParaPrompt` emite todas: si alguna vez filtra, este map filtra
  // igual o el contador miente hacia arriba.
  assert.equal(lineasParaPrompt(d).filter((l) => l.startsWith("- ")).length, d.items.length);

  // Y un archivo viejo sin el campo no rompe el contador ni lo arranca en NaN.
  const viejo = { version: 1 as const, items: [{ id: "d-1", que: "x", cuando: "", origen: "", recordada: undefined as unknown as number }] };
  assert.equal(marcarRecordadas(viejo).items[0]?.recordada, 1);
  assert.deepEqual(marcarRecordadas(null).items, []);
});

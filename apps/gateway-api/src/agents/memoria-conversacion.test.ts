import assert from "node:assert/strict";
import test from "node:test";
import { esLaMisma } from "./decisiones-del-jefe.ts";
import { CANAL_REAL } from "./memoria-conversacion.fixture.ts";
import {
  anotar,
  anotarReaccion,
  clasificarReaccion,
  esPing,
  esTema,
  lineasParaPrompt,
  memoriaVacia,
  resumen,
  type Intercambio,
  type MemoriaConversacion
} from "./memoria-conversacion.ts";

// TODOS los números de este archivo salen de correr el código contra el canal real del 2026-08-06
// (105 mensajes: 32 del jefe, 73 del bot). Ninguno está estimado. Es la lección de
// `verificar-por-el-camino-de-produccion`: un fixture escrito desde mi suposición del wire de
// Bedrock escondió que `stop_reason` nunca se leía, y el test no salvó de nada porque compartía el
// error con el código.

const JEFE = CANAL_REAL.filter((m) => !m.bot);
const BOT = CANAL_REAL.filter((m) => m.bot);
const T = "2026-08-06T12:00:00.000Z";
const iso = (ts: string): string => new Date(Number(ts) * 1000).toISOString();

/** El mismo agrupamiento codicioso que hace `anotar` por dentro, sin el tope de 12 temas: acá
 *  interesa cuántos grupos HAY en los datos, no cuántos entran al archivo. */
function agrupar(textos: string[]): string[][] {
  const grupos: string[][] = [];
  for (const t of textos) {
    if (!esTema(t)) continue;
    const g = grupos.find((x) => esLaMisma(x[0] as string, t));
    if (g) g.push(t);
    else grupos.push([t]);
  }
  return grupos.sort((a, b) => b.length - a.length);
}

test("REPLAY: el patrón que el jefe intuye existe en los datos y sale sin modelo", () => {
  // Si esto cambia, el patrón se está calculando distinto de como se midió — y la primera línea del
  // prompt pasaría a citar un grupo que nadie verificó.
  const grupos = agrupar(JEFE.map((m) => m.texto));
  // Era 18 hasta que `esTema` dejó de abrir tema con los cierres de cortesía. El que se fue es uno
  // solo y está nombrado abajo: "Ok, estare atento.". Bajar el número sin decir cuál se fue sería
  // acomodar el test al código.
  assert.equal(grupos.length, 17, "17 grupos sobre los 32 mensajes del jefe");
  assert.ok(!grupos.flat().includes("Ok, estare atento."), "el único que salió al arreglar los cierres");
  assert.deepEqual(grupos[0], [
    "Como vamos ?",
    "Hola, buenos dias. Como vamos ??? cuantas bandejas ya se estan calentando ?",
    "Respondeme, como vamos ?",
    "Hey, como vamos ?"
  ]);
});

test("los pings son reclamo de latencia, NO abren tema", () => {
  // Un reclamo mal contado como pregunta le enseñaría al agente que a Juanes le interesa el tema
  // "???". El último de la lista es el que se escapa si las menciones no se sacan ANTES de
  // normalizar: el id del bot queda como palabra de 11 caracteres, deja de ser ping, y abre un tema
  // propio llamado "respondeme".
  const esperados = ["Hey si buenasssss!!!", "???", "Hola?", "Hey,", "respondeme", "<@U0BNCHPTPH8> Respondeme,"];
  assert.deepEqual(JEFE.filter((m) => esPing(m.texto)).map((m) => m.texto), esperados);
  for (const t of esperados) assert.ok(!esTema(t), `"${t}" no es un tema`);
});

test('"Ok, es bien." no entra a ningún grupo', () => {
  // Sin la guarda de ≥2 palabras >3 chars, el agrupamiento codicioso lo mete con el mensaje de las
  // semillas: comparten "bien" y el divisor de `esLaMisma` es min(1, N) = 1 ⇒ 1.0. El conforme más
  // claro del día se contaba como tema.
  assert.ok(!esTema("Ok, es bien."));
  const grupos = agrupar(JEFE.map((m) => m.texto));
  assert.ok(!grupos.some((g) => g.some((t) => t.includes("Ok, es bien"))));
});

test("el orden de clasificarReaccion: conforme ANTES que ping", () => {
  // Probado al revés, "Ok!" cae en ping y el único conforme del día se lee como reclamo.
  assert.equal(clasificarReaccion("Como vamos ?", "Ok!"), "conforme");
  assert.equal(clasificarReaccion("Como vamos ?", "Hola?"), "insiste");
  assert.equal(clasificarReaccion("Como vamos ?", "Respondeme, como vamos ?"), "insiste");
  assert.equal(clasificarReaccion("frené el dominio", "Como que no lo puedes hacer?"), "corrige");
  // `null` es respuesta legítima, igual que `sin_evidencia` en bitacora-acciones.ts: silencio no es
  // aprobación, y subestimar no inventa.
  assert.equal(clasificarReaccion("Como vamos ?", "Y que sugieres?"), null);
});

/** Corre las 73 respuestas del bot por `anotar` y devuelve, de las que quedaron marcadas, su ts y
 *  su hilo. Se cuenta en el momento de anotar porque el FIFO de 40 recorta las viejas: las 73
 *  respuestas son 17 h de canal. */
function repetidasDelCanal(): Array<{ ts: string; hilo: string }> {
  const out: Array<{ ts: string; hilo: string }> = [];
  let mem = memoriaVacia();
  for (const m of BOT) {
    mem = anotar(mem, {
      ts: m.ts, hilo: m.hilo, quien: "bot", pregunta: "", respuesta: m.texto,
      cuando: iso(m.ts), tardoSeg: 1, fallo: null, inventadas: 0
    });
    const ultimo = mem.intercambios[mem.intercambios.length - 1] as Intercambio;
    if (ultimo.ts === m.ts && ultimo.repetida) out.push({ ts: m.ts, hilo: m.hilo });
  }
  return out;
}

test("detecta las respuestas casi idénticas del hilo del incidente", () => {
  // El jefe lo describió textual: "se volvió repetitivo e imbécil". Fueron 4 respuestas casi
  // iguales entre las 03:28 y las 03:31 del 2026-08-06, tres de ellas en el hilo ...393.
  // El total pasó de 4 a 12 al sacar el filtro de hilo y bajar el umbral a UMBRAL_REPETIDA: las 8
  // nuevas se listan en el test de abajo y todas son repeticiones de verdad.
  const repetidas = repetidasDelCanal();
  assert.equal(repetidas.length, 12, "12 repetidas sobre las 73 respuestas del bot");
  assert.equal(repetidas.filter((r) => r.hilo === "1785983393.674239").length, 3, "3 son del hilo del incidente");
});

test("EL INCIDENTE DE LAS 09:28: ocho respuestas iguales en OCHO hilos distintos", () => {
  // El caso que el detector NO veía, y es el que el jefe sufrió. Entre las 09:28:52 y las 09:34:35
  // del 2026-08-06 el agente fue contestando hilos viejos de a uno con la MISMA foto ("seis
  // calentando, ocho frenados, nueve cruzaron, el freno de bizreport-control.com no pegó"),
  // redactada distinto cada vez. Ocho respuestas, ocho hilos, 5,7 minutos.
  //
  // Las dos cegueras eran acumulativas y ninguna sola alcanzaba: (1) el guard `p.hilo === e.hilo`
  // las daba todas de hilos distintos, y (2) aun sacándolo, su solapamiento real medido va de 0,19
  // a 0,53, o sea que el 0,6 de `esLaMisma` daba CERO igual. Verificado: 0 de 8 con el código de
  // ayer, en los dos escenarios.
  const rafaga = BOT.filter((m) => Number(m.ts) >= 1786042132 && Number(m.ts) <= 1786042476);
  assert.equal(rafaga.length, 8, "la ráfaga son 8 mensajes");
  assert.equal(new Set(rafaga.map((m) => m.hilo)).size, 8, "en 8 hilos distintos");
  assert.ok(Number(rafaga[7]!.ts) - Number(rafaga[0]!.ts) < 600, "y dentro de la ventana de 10 min");

  const marcados = new Set(repetidasDelCanal().map((r) => r.ts));
  const cazados = rafaga.filter((m) => marcados.has(m.ts)).length;
  assert.ok(cazados >= 4, `al menos 4 de las 8 tienen que quedar marcadas, quedaron ${cazados}`);

  // El otro lado del borde: la PRIMERA de la ráfaga no puede estar marcada. Decir "esto ya lo
  // dijiste" sobre lo primero que se dijo es un falso positivo, y un detector que se dispara solo
  // entrena a ignorarlo — la misma lección que los reparos falsos del verificador.
  assert.ok(!marcados.has(rafaga[0]!.ts), "la primera de la ráfaga no es repetición de nada");
});

test("un aviso enlatado repetido textual se caza, aunque sea corto", () => {
  // El aviso "te leí pero no pude contestarte" es corto y sale siempre igual. Con pocas palabras
  // largas el solapamiento no sirve (min(|A|,|B|) es tan chico que un 0,4 lo alcanza cualquier par),
  // así que ahí se exige texto normalizado idéntico. Es la repetición que la memoria vino a matar:
  // sin esto el agente puede mandarlo indefinidamente sin que nada lo cuente.
  const aviso = "Juanes, te leí pero no pude contestarte.";
  let m = memoriaVacia();
  m = anotar(m, { ts: "1", hilo: "h1", quien: "U1", pregunta: "Como vamos ?", respuesta: aviso, cuando: T, tardoSeg: 5, fallo: null, inventadas: 0 });
  m = anotar(m, { ts: "2", hilo: "h2", quien: "U1", pregunta: "Hola?", respuesta: aviso, cuando: "2026-08-06T12:02:00.000Z", tardoSeg: 5, fallo: null, inventadas: 0 });
  assert.equal(m.intercambios[0]?.repetida, false, "el primero no repite nada");
  assert.equal(m.intercambios[1]?.repetida, true, "el segundo sí, aunque sea otro hilo");

  // Y dos avisos cortos DISTINTOS no se confunden entre sí: sin el guard de texto exacto,
  // "no pude contestarte" y "no pude leer el estado" comparten vocabulario suficiente para que el
  // divisor chico los junte.
  let n = memoriaVacia();
  n = anotar(n, { ts: "1", hilo: "h1", quien: "U1", pregunta: "?", respuesta: "Juanes, no pude leer el estado.", cuando: T, tardoSeg: 5, fallo: null, inventadas: 0 });
  n = anotar(n, { ts: "2", hilo: "h2", quien: "U1", pregunta: "?", respuesta: aviso, cuando: "2026-08-06T12:02:00.000Z", tardoSeg: 5, fallo: null, inventadas: 0 });
  assert.equal(n.intercambios[1]?.repetida, false, "otro aviso no es el mismo aviso");
});

test("un cierre de cortesía NO abre tema", () => {
  // Los cuatro son textuales del canal. `esTema` solo exigía 2 palabras largas, así que "Ok, si
  // cambia algo o si tienes dudas, avisame." abría tema — y el MISMO texto `clasificarReaccion` lo
  // devuelve como "conforme": el módulo se contradecía. En el archivo real de producción 2 de los 4
  // temas guardados son cierres, y con MIN_VECES=3 eran los primeros en llegar al prompt.
  const cierres = [
    "Ok, si cambia algo o si tienes dudas, avisame.",
    "Listo, gracias por avisarme entonces",
    "dale perfecto quedo atento a eso",
    "Ok, bien!"
  ];
  for (const c of cierres) {
    assert.ok(!esTema(c), `"${c}" es un cierre, no un tema`);
    assert.equal(clasificarReaccion("", c), "conforme", `y clasificarReaccion ya lo sabía: "${c}"`);
  }
  // Una pregunta de verdad sigue abriendo tema: el arreglo no puede comerse el caso útil.
  assert.ok(esTema("Como vamos con el placement de las bandejas"));

  // Y ACÁ ESTUVO EL PRECIO DEL PRIMER ARREGLO, que era peor que el problema: delegar en
  // `clasificarReaccion` metía su regex `^(ok|dale|listo|gracias|…)\b`, un ancla al ARRANQUE que no
  // mira lo que sigue. Y el prompt de VOZ le enseña al agente que Juanes habla exactamente así
  // ("podés usar listo, dale, de una, hágale"). Resultado medido: 6 de estos 7 pedidos daban
  // `false`, o sea que la memoria de temas —lo que el informe de 14 días usa para decidir si este
  // paquete se queda— quedaba ciega a casi todo lo que el jefe pide. Se cambió "el agente aprende
  // el tema avisame" por "el agente no aprende nada".
  const pedidos = [
    "Dale, subí el cupo de corpfiling-infra.com a 40 y avisame cómo viene el placement",
    "Listo, ahora revisá los 7 dominios vírgenes y decime cuál conviene soltar primero",
    "Ok pero por qué bizreport-control.com sigue frenado si las listas negras están limpias",
    "Gracias, igual quiero que revises el placement de annualfilings-ops.com esta semana",
    "Bien, pero la cola de statefilings-control.com sigue atascada, mirala",
    "Perfecto, ahora mostrame el diagnóstico de los nodos que rechaza Yahoo",
    // Sin prefijo cortés, el vocabulario de cierre NO descuenta: "cambia" acá sí abre tema.
    "Cambia el cupo de corpfiling-infra.com a 40"
  ];
  for (const p of pedidos) assert.ok(esTema(p), `"${p}" es un PEDIDO del jefe, no un cierre`);

  // Y en anotar: tres cierres seguidos no dejan ni un tema.
  let m = memoriaVacia();
  cierres.slice(0, 3).forEach((c, i) => {
    m = anotar(m, { ts: `c${i}`, hilo: `h${i}`, quien: "U1", pregunta: c, respuesta: `dale ${i}`, cuando: new Date(Date.parse(T) + i * 3_600_000).toISOString(), tardoSeg: 5, fallo: null, inventadas: 0 });
  });
  assert.equal(m.temas.length, 0, "un cierre de cortesía no es una costumbre que valga la pena contarle");
});

test("la reacción se le atribuye a quien la escribió, no al último que preguntó", () => {
  // El campo `quien` existe en Intercambio justamente para esto y no se estaba usando. Hoy el canal
  // tiene una persona y eso es una coincidencia, no un control: el día que entre Esaú, un "no,
  // pero..." suyo queda anotado como que Juanes corrigió la respuesta que le dieron a Juanes.
  // Barato ahora, imposible de reconstruir después.
  let m = memoriaVacia();
  m = anotar(m, { ts: "1", hilo: "h", quien: "JUANES", pregunta: "Como vamos con las bandejas", respuesta: "seis calentando", cuando: T, tardoSeg: 5, fallo: null, inventadas: 0 });
  m = anotarReaccion(m, { texto: "No, pero eso no es lo que te pregunté", cuando: "2026-08-06T12:05:00.000Z", quien: "ESAU" });
  assert.equal(m.intercambios[0]?.reaccion, null, "Esaú no corrige la respuesta que era para Juanes");

  m = anotarReaccion(m, { texto: "No, pero eso no es lo que te pregunté", cuando: "2026-08-06T12:06:00.000Z", quien: "JUANES" });
  assert.equal(m.intercambios[0]?.reaccion, "corrige");

  // Sin `quien` se comporta EXACTAMENTE como hoy: es lo que permite que el orquestador lo cablee
  // después sin que este cambio le rompa nada mientras tanto.
  let n = memoriaVacia();
  n = anotar(n, { ts: "1", hilo: "h", quien: "JUANES", pregunta: "Como vamos con las bandejas", respuesta: "seis calentando", cuando: T, tardoSeg: 5, fallo: null, inventadas: 0 });
  n = anotarReaccion(n, { texto: "Ok!", cuando: "2026-08-06T12:05:00.000Z" });
  assert.equal(n.intercambios[0]?.reaccion, "conforme");
});

test("un turno fallido no se marca como repetido ni abre tema", () => {
  // Sin el guard de respuesta vacía, `esLaMisma("", "")` da true y CADA turno fallido quedaría
  // marcado como repetición — justo los que no dijeron nada. Hoy fallan el 66% de los turnos.
  let m = memoriaVacia();
  const base = { hilo: "h1", quien: "U1", pregunta: "Hola, buenos dias. Como vamos con las bandejas", respuesta: "", tardoSeg: 90, inventadas: 0 };
  m = anotar(m, { ...base, ts: "1", cuando: T, fallo: "el modelo tardó demasiado" });
  m = anotar(m, { ...base, ts: "2", cuando: "2026-08-06T12:01:00.000Z", fallo: "texto vacío" });
  assert.equal(m.intercambios.filter((i) => i.repetida).length, 0);
  assert.equal(m.temas.length, 0, "un turno que ni salió no es evidencia de que el tema le importe");
});

test("la reacción se busca sin filtrar por hilo", () => {
  // Corrección MEDIDA: buscando dentro del mismo hilo da insiste = 0, porque el jefe reclama con un
  // mensaje SUELTO del canal mientras el bot le contesta adentro del hilo ("Hola?" a las 03:29
  // mientras respondía el ...393 entre 03:28 y 03:31).
  let m = memoriaVacia();
  m = anotar(m, { ts: "1", hilo: "1785983393.674239", quien: "U1", pregunta: "Como vamos ?", respuesta: "El emisor está pausado", cuando: T, tardoSeg: 10, fallo: null, inventadas: 0 });
  m = anotarReaccion(m, { texto: "Hola?", cuando: "2026-08-06T12:05:00.000Z" });
  assert.equal(m.intercambios[0]?.reaccion, "insiste");
});

test("una reacción que llega tarde no cuenta", () => {
  // Silencio ≠ aprobación, y un "ok" de dos horas después tampoco habla de esa respuesta.
  let m = memoriaVacia();
  m = anotar(m, { ts: "1", hilo: "h", quien: "U1", pregunta: "Como vamos ?", respuesta: "pausado", cuando: T, tardoSeg: 10, fallo: null, inventadas: 0 });
  m = anotarReaccion(m, { texto: "Ok!", cuando: "2026-08-06T14:00:00.000Z" });
  assert.equal(m.intercambios[0]?.reaccion, null);
});

test("dedupe por ts: si el tick se repite, el registro ya está", () => {
  // El tick del chat corre cada 6 s = 14.400 pasadas por día, y `updateInventoryJson` reescribe el
  // archivo ENTERO bajo lock. Sin id natural habría dos memorias contradiciéndose.
  const e = { ts: "1785983393.674239", hilo: "h", quien: "U1", pregunta: "Como vamos ?", respuesta: "pausado", cuando: T, tardoSeg: 10, fallo: null, inventadas: 0 };
  let m = anotar(memoriaVacia(), e);
  m = anotar(m, e);
  assert.equal(m.intercambios.length, 1);
});

test("VENTANA: un tema viejo no entra al prompt", () => {
  // Es el test que decisiones-del-jefe.json NO tiene, y por eso su item d-3 ("Juanes se desconecta
  // en 1h") lleva horas entrando en cada prompt diciéndole al agente que su jefe duerme.
  // Un día entre vista y vista: dos respuestas iguales al minuto en el mismo hilo son una
  // repetición, no un tema — y así las cuenta `anotar`.
  const hace = (dias: number) => new Date(Date.parse(T) - dias * 86_400_000).toISOString();
  let m = memoriaVacia();
  for (let i = 0; i < 4; i++) {
    m = anotar(m, { ts: `v${i}`, hilo: "viejo", quien: "U1", pregunta: "Como vamos con el placement de las bandejas", respuesta: `pausado, van ${i}`, cuando: hace(20 - i), tardoSeg: 10, fallo: null, inventadas: 0 });
  }
  assert.equal(m.temas.length, 1, "el tema existe");
  assert.equal(m.temas[0]?.vistas.length, 4, "con sus 4 vistas");
  assert.deepEqual(lineasParaPrompt(m, "viejo", T), [], "pero no entra al prompt");
  assert.equal(resumen(m, T).temas[0]?.veces, 0, "y resumen lo da con veces 0");
});

test("sin memoria el prompt queda exactamente como está hoy", () => {
  // Mismo contrato que sus dos hermanas: con el sistema recién arrancado no se agrega una sola
  // línea. Un prompt inflado es el problema que este módulo vino a evitar, no a causar.
  assert.deepEqual(lineasParaPrompt(null, "x", T), []);
  assert.deepEqual(lineasParaPrompt(memoriaVacia(), "x", T), []);
  assert.equal(resumen(null, T).intercambios, 0);
  assert.equal(resumen(null, T).tasaInsiste, 0);
});

test("TECHO: nunca más de 6 líneas y ninguna da una orden", () => {
  // Contra las dos inflaciones que este proyecto ya se comió, el límite va en un assert y no en una
  // intención. "Preguntó 4 veces" es un hecho; "deberías responder más rápido" es consejo, y el
  // consejo es lo que el modelo devuelve como si fuera un hallazgo propio.
  let m = memoriaVacia();
  const t0 = Date.parse(T);
  // 8 temas distintos con 4 apariciones cada uno: más candidatos de los que pueden salir. Una
  // aparición por hora y con respuesta propia, o el detector de repetidas se las come —
  // correctamente: dos veces la misma frase en el mismo hilo no es un tema, es el bug del hilo ...393.
  for (let tema = 0; tema < 8; tema++) {
    for (let v = 0; v < 4; v++) {
      m = anotar(m, {
        ts: `t${tema}-${v}`, hilo: "hilo-actual", quien: "U1",
        pregunta: `Como vamos con el asunto numero ${"x".repeat(tema + 4)} y su medicion`,
        respuesta: `El emisor está pausado, vuelta ${tema}-${v}`,
        cuando: new Date(t0 - (40 - tema * 4 - v) * 3_600_000).toISOString(),
        tardoSeg: 30, fallo: null, inventadas: 0
      });
    }
  }
  // Y una respuesta reciente en el hilo actual, para que salgan las dos secciones.
  m = anotar(m, { ts: "reciente", hilo: "hilo-actual", quien: "U1", pregunta: "Y ahora que hacemos con los nodos", respuesta: "Frené bizreport-control.com y estoy midiendo el resto", cuando: new Date(t0 - 3 * 60_000).toISOString(), tardoSeg: 12, fallo: null, inventadas: 0 });

  const l = lineasParaPrompt(m, "hilo-actual", T);
  assert.ok(l.length > 0, "con datos sí emite");
  assert.ok(l.length <= 6, `nunca más de 6 líneas (fueron ${l.length})`);
  assert.match(l[0] as string, /LO ÚLTIMO QUE DIJISTE \(hace 3 min, en este hilo\)/);
  assert.match(l.join("\n"), /LO QUE TE PREGUNTA SEGUIDO/);
  for (const x of l) {
    assert.doesNotMatch(x, /\b(deberías|tenés que|hay que|conviene|revisá|respondé|hacé|mejorá|contestá)\b/, `orden en: ${x}`);
  }
  // Toda línea de dato cita un registro guardado, entre comillas y recortada: un mensaje de Slack
  // que vuelve al prompt en cada turno es un canal de persistencia para texto ajeno.
  for (const x of l.filter((y) => y.startsWith("- "))) assert.match(x, /^- "/);
});

test("el tema recién nacido no llega al prompt", () => {
  // Piso de evidencia ≥3: la lección del `placement-pause`, donde 4 muestras sueltas frenaron al
  // único dominio que andaba bien. Dos repeticiones no son una costumbre.
  let m = memoriaVacia();
  for (let i = 0; i < 2; i++) {
    m = anotar(m, { ts: `n${i}`, hilo: "h", quien: "U1", pregunta: "Cuantas bandejas se estan calentando ahora", respuesta: "veintitrés", cuando: new Date(Date.parse(T) - (60 - i) * 60_000).toISOString(), tardoSeg: 10, fallo: null, inventadas: 0 });
  }
  assert.deepEqual(lineasParaPrompt(m, "h", T), []);
});

test("TAMAÑO: el archivo tiene techo estructural, no una promesa", () => {
  // El modo de falla está en la misma carpeta: warmup-destilacion.json lleva 175.897 bytes por 19
  // ejemplos en 15,5 h, sin tope, camino a ~98 MB al año — en un archivo que `updateInventoryJson`
  // lee, parsea, re-serializa y reescribe ENTERO bajo lock.
  const textos = CANAL_REAL.map((m) => m.texto);
  const preguntas = JEFE.map((m) => m.texto);
  let m = memoriaVacia();
  const t0 = Date.parse("2026-08-06T00:00:00.000Z");
  for (let i = 0; i < 500; i++) {
    m = anotar(m, {
      ts: `sint-${i}`, hilo: `hilo-${i % 7}`, quien: "U0BAQSXJJLW",
      pregunta: preguntas[i % preguntas.length] as string,
      respuesta: textos[i % textos.length] as string,
      cuando: new Date(t0 + i * 60_000).toISOString(),
      tardoSeg: 30 + (i % 300), fallo: null, inventadas: i % 3
    });
  }
  assert.equal(m.intercambios.length, 40);
  assert.equal(m.temas.length, 12);
  const bytes = JSON.stringify(m, null, 2).length;
  assert.ok(bytes < 30_000, `${bytes} bytes con 500 intercambios`);
});

test("aguanta un archivo corrupto sin romper el chat", () => {
  // El archivo lo escribe un daemon que corre 24/7 y se reinicia con launchd. Si un JSON a medio
  // escribir tirara una excepción acá, el agente dejaría de contestarle al jefe por una memoria —
  // que es de solo lectura respecto de lo que hace y jamás debería poder frenarlo.
  const roto = { version: 1, intercambios: "no soy un array", temas: null } as unknown as MemoriaConversacion;
  assert.deepEqual(lineasParaPrompt(roto, "h", T), []);
  assert.equal(resumen(roto, T).intercambios, 0);
  const m = anotar(roto, { ts: "1", hilo: "h", quien: "U1", pregunta: "Como vamos con las bandejas", respuesta: "ok", cuando: T, tardoSeg: 1, fallo: null, inventadas: 0 });
  assert.equal(m.intercambios.length, 1);

  // Y una fecha ilegible no borra el registro: lo deja pasar y que lo recorte el FIFO.
  const conFechaMala = anotar(m, { ts: "2", hilo: "h", quien: "U1", pregunta: "Y las semillas", respuesta: "dos", cuando: "ayer a la tarde", tardoSeg: 1, fallo: null, inventadas: 0 });
  assert.equal(conFechaMala.intercambios.length, 2);
  assert.equal(resumen(conFechaMala, "tampoco es fecha").intercambios, 2);
});

test("resumen: los seis números del informe salen de los registros, no del log", () => {
  // Hoy los 65 fallos y la latencia hay que grepearlos del log. Desde acá son campos del propio
  // registro: un grep frágil convertido en contador.
  let m = memoriaVacia();
  const filas: Array<[string, string | null, number, number]> = [
    ["1", null, 60, 0], ["2", null, 120, 2], ["3", "el modelo tardó demasiado", 240, 0], ["4", null, 6000, 1]
  ];
  for (const [ts, fallo, seg, inv] of filas) {
    m = anotar(m, { ts, hilo: `h${ts}`, quien: "U1", pregunta: `pregunta numero ${ts} sobre bandejas`, respuesta: fallo ? "" : `respuesta ${ts}`, cuando: new Date(Date.parse(T) + Number(ts) * 1000).toISOString(), tardoSeg: seg, fallo, inventadas: inv });
  }
  const r = resumen(m, T);
  assert.equal(r.intercambios, 4);
  assert.equal(r.fallos, 1);
  assert.equal(r.inventadas, 3);
  // La latencia se calcula SOLO sobre los que no fallaron: un turno que ni salió no midió nada.
  assert.equal(r.latencia.max, 100, "100 min, y el fallido de 4 min no entra");
  assert.equal(r.latencia.mediana, 2);
});

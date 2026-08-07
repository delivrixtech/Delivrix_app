import assert from "node:assert/strict";
import test from "node:test";

import { informe, parsear, reclasificar, rutaPermitida, ARBOL_DE_PRODUCCION } from "./sentinel-audit.ts";

// LAS LÍNEAS SON REALES. Copiadas textualmente del log de producción de la Mac Studio
// (runtime/logs/warmup-monitor.log, sha256 49f09a10da061998…, ventana 2026-08-05T20:42Z ..
// 2026-08-07T11:53Z). Un fixture escrito desde mi suposición del formato ya ocultó un bug entero en
// este proyecto —el `stop_reason` de Bedrock que nunca se leía—, así que acá el fixture se copia,
// no se inventa.
const LOG_REAL = [
  "[slack] motivo=novedad placement opscorpfiling.com SPAM→INBOX · el placement de opscorpfiling.com: SPAM → INBOX.",
  "[slack] silencio: nada cambió y no hay nada que pedir",
  "[slack] motivo=novedad placement statefilings-control.com INBOX→SPAM · el placement de statefilings-control.com: INBOX → SPAM.",
  "[slack] motivo=ejecutó una acción · Ya activé los chequeos pasivos sobre los dominios frenados y las subredes contaminadas, así que ajusto la rampa en cuanto lleguen los resultados sin esperar tu luz. Hice esto: revisar_reputacion corpannualinfra.com.",
  "[slack] motivo=ejecutó una acción · Voy a medir y diagnosticar los cercanos y los frenados para ver qué puedo soltar. Hice esto: revisar_reputacion controlnationalcorp.com.",
  "[slack] motivo=novedad plan.accion annualcorp-infra.com sostener→bajar · el plan de annualcorp-infra.com: sostener → bajar.",
  '[slack] motivo=acción trabada · Quise diagnosticar_dominio_bizregistry-ops.com y no pude: rechazada: "diagnosticar_dominio_bizregistry-ops.com" no es una acción permitida. ¿Lo resolvés vos?',
  "[slack] motivo=sin lectura · No pude leer el estado: el modelo devolvió texto vacío (probablemente el razonamiento consumió todo el presupuesto). Si sigue así en la próxima vuelta, algo está roto.",
  "[slack] motivo=novedad plan.accion opscorpfiling.com sostener→subir · el plan de opscorpfiling.com: sostener → subir. Además: 1 cambio menor.",
  "[slack] motivo=novedad plan.diaN statefilings-control.com 1→2 · el día de rampa de statefilings-control.com: 1 → 2.",
  "[slack] motivo=novedad placement statefilings-control.com SPAM→INBOX · statefilings-control.com entró en bandeja — venía cayendo en spam.",
  "[slack] motivo=ejecutó una acción · Voy a revisar los congelados para ver cuáles pueden volver. Hice esto: revisar_reputacion corpfiling-relay.com.",
  // ── EL TERCER FORMATO, el que el parser tiraba en silencio ─────────────────────────────────────
  // Son 39 de los 50 proactivos del log real: renglones SIN `motivo=`, o sea el texto tal cual salió
  // a Slack. El regex exigía la etiqueta y los descartaba en un `continue`, así que el informe
  // declaraba 11 mensajes sobre una ventana de 39 h midiendo sólo las últimas 7. Copiados textuales.
  "[slack] Juanes, hice esto: frenar_dominio bizreport-control.com. Juanes, esto no lo puedo destrabar yo, mirá si querés que levante la pausa manualmente o esperamos a que mejore la señal.",
  "[slack] Juanes, hice esto: anotar_pendiente p-2-bizreport-control-com. Juanes, mirá por qué el freno no se pegó y ajustá el nodo para que aplique el cupo correcto.",
  "[slack] Me trabé: dije algo que no cuadra con los datos (nombra \"bizregistry-ops.com\", que no está en los datos), así que no toqué nada. Mejor miralo vos.",
  "[slack] Sigo acá. Ya los estoy evaluando y midiendo para decidir si soltamos alguno."
].join("\n");

test("EL REPLAY: los mensajes que fueron a MIRAR quedan en 0", () => {
  // Es la aceptación central del lote y la queja textual del jefe: "esta bien que me notifique cada
  // huella que va haciendo, pero tambien lo siento innecesario porque es lo que el agente en
  // delivrix app esta haciendo en su columna propia". Los tres "Hice esto: revisar_reputacion X" son
  // el agente avisando que fue a mirar, y `revisar_reputacion` es la mano que se agregó última y
  // reabrió la fuga que ya habíamos tapado para las otras pasivas.
  const { mensajes } = parsear(LOG_REAL);
  assert.equal(mensajes.length, 15, "los 11 etiquetados MÁS los 4 del formato crudo");

  const mirar = mensajes.filter((m) => /Hice esto: (medir|diagnosticar|leer_cupo|revisar_reputacion)/.test(m.texto));
  assert.equal(mirar.length, 3, "el log real tiene tres");
  assert.equal(mirar.filter((m) => m.saldria).length, 0, "y con el criterio nuevo no sale ninguno");
  for (const m of mirar) {
    assert.equal(m.clase, "huella");
    assert.equal(m.tapado, "clase-huella");
  }
});

test("los 6 mensajes de huella pura del panel tampoco salen", () => {
  // placement, plan.accion y plan.diaN son exactamente las filas de `warmup_activity` que el panel
  // sirve por /v1/warmup/activity — 62 en 24 h, verificadas contra la base. Slack repetía eso.
  const { mensajes } = parsear(LOG_REAL);
  const novedades = mensajes.filter((m) => m.motivo.startsWith("novedad "));
  assert.equal(novedades.length, 6);
  assert.equal(novedades.filter((m) => m.saldria).length, 0);
  assert.deepEqual(
    [...new Set(novedades.map((m) => m.regla))].sort(),
    ["huella:placement", "huella:plan.accion", "huella:plan.diaN"]
  );
});

test("un error de sintaxis del propio modelo no cuenta como pedido de decisión", () => {
  // Salió a Slack tal cual: "Quise diagnosticar_dominio_bizregistry-ops.com y no pude: no es una
  // acción permitida. ¿Lo resolvés vos?". El modelo pegó el dominio al nombre de la acción. No hay
  // nada que el jefe pueda resolver ahí, y preguntarlo gasta la única señal que sirve.
  const r = reclasificar("acción trabada", 'Quise diagnosticar_dominio_bizregistry-ops.com y no pude: rechazada: "…" no es una acción permitida. ¿Lo resolvés vos?');
  assert.equal(r.saldria, false);
  assert.equal(r.tapado, "error-propio");
  assert.equal(r.decision, null);
});

test("lo que TOCA la infraestructura sigue saliendo, y con su llave", () => {
  // La contracara: bajar el ruido solo sirve si lo que de verdad importa llega. Una mano que se
  // mueve en silencio es exactamente lo que no queremos de un agente autónomo.
  const r = reclasificar("ejecutó una acción", "Hice esto: frenar_dominio bizreport-control.com.");
  assert.equal(r.saldria, true);
  assert.equal(r.regla, "dec5-toque-de-infra");
  assert.equal(r.decision, "revertir-la-mano", "la llave: el jefe puede revertirlo");
});

test("una sola vuelta ciega NO interrumpe, y se dice por qué no salió", () => {
  // c1 exige DOS vueltas seguidas: la primera es un tropiezo (el modelo tarda, Postgres se recarga
  // doce segundos). Lo que no puede pasar es que el mensaje desaparezca sin motivo: "no salió" y
  // "se perdió" tienen que poder distinguirse.
  const r = reclasificar("sin lectura", "No pude leer el estado: el modelo devolvió texto vacío.");
  assert.equal(r.regla, "c1-sin-lectura-2");
  assert.equal(r.saldria, false);
  assert.equal(r.tapado, "una-sola-vuelta");
});

test("lee el formato NUEVO sin reclasificarlo", () => {
  // Lo que ya viene etiquetado se cuenta tal cual salió. Reclasificar un mensaje etiquetado sería
  // medir mi parser en vez de medir el canal.
  const { mensajes } = parsear(
    "[slack] clase=dano regla=d1-cruce-umbral decision=kill-switch motivo=dano d1-cruce-umbral · x.com cruzó el umbral de volumen de Gmail."
  );
  assert.equal(mensajes.length, 1);
  assert.equal(mensajes[0]?.etiquetado, true);
  assert.equal(mensajes[0]?.clase, "dano");
  assert.equal(mensajes[0]?.decision, "kill-switch");
  assert.equal(mensajes[0]?.saldria, true);
});

test("cuenta los TAPADOS del formato nuevo con su motivo", () => {
  const { silencios } = parsear("[slack] silencio: tapado=clase-huella:huella:placement,tapado=modelo-caido:huella:plan.diaN");
  assert.deepEqual(silencios.map((s) => s.motivo), ["clase-huella", "modelo-caido"]);
});

test("RECHAZA una ruta bajo el árbol de producción", () => {
  // PRODUCCIÓN ES SOLO LECTURA, y el chequeo vive en el código y no en la disciplina de quien corre
  // el comando. Apuntar al árbol vivo es la forma más fácil de que el próximo agregado que "solo
  // escribe un cachito" toque producción.
  assert.equal(rutaPermitida(`${ARBOL_DE_PRODUCCION}/runtime/logs/warmup-monitor.log`), false);
  assert.equal(rutaPermitida(ARBOL_DE_PRODUCCION), false);
  assert.equal(rutaPermitida("/tmp/warmup-monitor.log"), true);
  // Y no se escapa con un `..`: se resuelve la ruta antes de comparar.
  assert.equal(rutaPermitida("/tmp/../Users/Shared/delivrix/runtime/logs/x.log"), false);
});

test("sin la tabla de relevancia dice 'sin dato', jamás 0", () => {
  // No medido y cero no son lo mismo. Es la confusión más cara del sistema: el 2026-07-25 había 38
  // nodos cerrados en Gmail con CERO detecciones de blacklist, y alguien leyó ese cero como "está
  // limpio". Un informe que dice "0 respuestas del jefe" sin haber podido mirar dice lo mismo.
  const sinTabla = informe(LOG_REAL, "sha-de-prueba", null).join("\n");
  assert.match(sinTabla, /RESPUESTAS DEL JEFE EN EL HILO\n\s+sin dato/);
  assert.ok(!/RESPUESTAS DEL JEFE EN EL HILO\n\s+0 /.test(sinTabla));
  assert.match(sinTabla, /vacía: ningún par llegó al piso de 3/);
});

test("el peso NUNCA se imprime sin su muestra al lado", () => {
  // Un peso sobre 3 muestras no es un peso, y el informe tiene que poder decir "todavía no sé". Si
  // el operador ve "peso 0,8" solo, va a confiar en un número que se calculó con tres observaciones.
  const conTabla = informe(LOG_REAL, "sha", {
    "huella:placement": { salieron: 12, respondio: 4, quejo: 0, peso: 1, muestra: 12, ultimaVez: null },
    "huella:plan.diaN": { salieron: 2, respondio: 0, quejo: 0, peso: 0, muestra: 2, ultimaVez: null }
  }).join("\n");
  assert.match(conTabla, /huella:placement\s+peso 1 sobre 12 observaciones/);
  assert.match(conTabla, /huella:plan\.diaN\s+peso 0 sobre 2 observaciones .*todavía no sé/);
  assert.match(conTabla, /4 respuestas sobre 14 salidas/);
});

test("el informe NO llama a ningún modelo ni toca la red", () => {
  // Es la mitad de lo que lo hace usable: tiene que correr sobre una copia del log, sin credenciales
  // y sin depender de que la Mac mini esté viva. Si algún día alguien le mete una llamada, este test
  // lo agarra: `fetch` roto y el informe sale igual.
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("el informe no puede salir a la red");
  }) as never;
  try {
    assert.ok(informe(LOG_REAL, "sha", null).length > 5);
  } finally {
    globalThis.fetch = original;
  }
});

test("NINGÚN renglón [slack] se descarta en silencio", () => {
  // EL DEFECTO QUE ESTE TEST IMPIDE, y es el más caro de todos porque rompe el instrumento que hace
  // falsificable a todo lo demás: el parser exigía `motivo=` y las líneas del formato crudo caían en
  // un `if (!partes) continue` sin dejar rastro. Sobre el log de producción (sha256 49f09a10…) eso
  // era el 78% del archivo — 50 proactivos reales contra 11 declarados, y los 11 salían todos de las
  // últimas 7 horas de una ventana de 39. Un canal donde no se puede saber cuánto se calló no se
  // puede calibrar; un AUDITOR que se calla lo que no entiende, tampoco.
  const conBasura = `${LOG_REAL}\n[slack] una forma que nadie previó y que el parser no entiende`;
  const { mensajes, silencios, vueltas, noClasificadas } = parsear(conBasura);
  const renglones = conBasura.split("\n").filter((l) => l.startsWith("[slack]")).length;
  assert.equal(vueltas, renglones);
  assert.equal(
    mensajes.length + silencios.length,
    renglones,
    "cada renglón termina o en un mensaje o en un silencio: ninguno se evapora"
  );
  assert.equal(noClasificadas, 1, "y la que no se entiende se CUENTA, con su nombre en el informe");
  assert.match(informe(conBasura, "sha", null).join("\n"), /no clasificadas\s+1/);
});

test("el formato crudo se clasifica por el texto: mirar es huella, tocar la infra sale", () => {
  // Las tres familias que el 78% descartado contenía, y que son justamente las que deciden el
  // baseline: `frenar_dominio` TOCA (dec5 sale), `anotar_pendiente` sólo anota (huella, calla), y
  // "Me trabé…" es una vuelta ciega (c1, que exige DOS seguidas y acá no las tiene).
  const toco = reclasificar("", "Juanes, hice esto: frenar_dominio bizreport-control.com. Juanes, esto no lo puedo destrabar yo.");
  assert.equal(toco.regla, "dec5-toque-de-infra");
  assert.equal(toco.saldria, true);

  const miro = reclasificar("", "Juanes, hice esto: anotar_pendiente p-2-bizreport-control-com.");
  assert.equal(miro.clase, "huella");
  assert.equal(miro.saldria, false);

  const ciega = reclasificar("", "Me trabé: dije algo que no cuadra con los datos, así que no toqué nada. Mejor miralo vos.");
  assert.equal(ciega.regla, "c1-sin-lectura-2");
  assert.equal(ciega.tapado, "una-sola-vuelta");
});

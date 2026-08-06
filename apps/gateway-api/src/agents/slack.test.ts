import assert from "node:assert/strict";
import test from "node:test";
import { decidirSiHablar, mandarASlack, recordarAviso, type EstadoParaSlack, type MemoriaSlack } from "./slack.ts";

const T = (h: number): string => `2026-08-06T${String(h).padStart(2, "0")}:00:00.000Z`;

const base = (over: Partial<EstadoParaSlack> = {}): EstadoParaSlack => ({
  emisor: "placement-pause",
  acciones: [],
  reparos: [],
  sinLectura: null,
  voz: "Juanes, todo tranquilo.",
  ahora: "el emisor está pausado",
  riesgo: "ninguno",
  ...over
});

test("si nada cambió y no hay nada que hacer, SE CALLA", () => {
  // Es la respuesta correcta casi siempre. Corre cada 10 min: hablar en cada vuelta son 144
  // mensajes por día y en dos días el operador lo silencia.
  const mem: MemoriaSlack = { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null };
  assert.equal(decidirSiHablar(base(), mem, T(10)), null);
});

test("habla cuando CAMBIA el estado del emisor, en las dos direcciones", () => {
  const mem: MemoriaSlack = { ultimoEmisor: "send", ultimoAviso: T(9), ultimaFirma: null };
  const frenó = decidirSiHablar(base({ emisor: "placement-pause" }), mem, T(10));
  assert.ok(frenó);
  assert.match(frenó.texto, /se frenó/);

  const arrancó = decidirSiHablar(
    base({ emisor: "send" }),
    { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null },
    T(10)
  );
  assert.ok(arrancó);
  assert.match(arrancó.texto, /arrancó/);
});

test("si ACTUÓ sobre la infraestructura, lo dice siempre", () => {
  // Una mano que se mueve en silencio es exactamente lo que no queremos de un agente autónomo.
  const a = decidirSiHablar(
    base({ acciones: [{ accion: "frenar_dominio", objetivo: "x.com", ejecutada: true, detalle: "frenado" }] }),
    { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null },
    T(10)
  );
  assert.ok(a);
  assert.match(a.texto, /frenar_dominio x\.com/);
  assert.equal(a.pideRespuesta, false);
});

test("si quiso actuar y NO pudo, pide decisión — pero UNA sola vez", () => {
  // El caso real: pidió lo mismo 10 veces en 2 horas. Serían 10 mensajes idénticos en Slack.
  const estado = base({
    acciones: [{ accion: "frenar_dominio", objetivo: "y.com", ejecutada: false, detalle: "no habilitado" }]
  });
  const mem: MemoriaSlack = { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null };

  const primero = decidirSiHablar(estado, mem, T(10));
  assert.ok(primero);
  assert.equal(primero.pideRespuesta, true);
  assert.match(primero.texto, /¿Lo resolvés vos\?/);

  // Con la memoria actualizada, el MISMO pedido ya no vuelve a molestar.
  const mem2 = recordarAviso(estado, true, T(10), mem);
  assert.equal(decidirSiHablar(estado, mem2, T(11)), null, "no repite el mismo pedido");
});

test("si no pudo mirar, lo dice: un vigilante ciego tiene que avisar", () => {
  const a = decidirSiHablar(base({ sinLectura: "fetch failed" }), null, T(10));
  assert.ok(a);
  assert.match(a.texto, /No pude leer/);
});

test("si dijo algo que no se sostiene, avisa que quedó SIN MANOS", () => {
  // Con reparos el agente no ejecuta nada. El operador tiene que saber que quedó mudo de manos,
  // no solo de boca.
  const a = decidirSiHablar(base({ reparos: ["nombra z.com, que no está en los datos"] }), null, T(10));
  assert.ok(a);
  assert.equal(a.pideRespuesta, true);
  assert.match(a.texto, /no toqué nada/);
});

test("la memoria recuerda el emisor AUNQUE se haya callado", () => {
  // Si no, el primer cambio tras un silencio se reportaría contra un estado viejísimo.
  const mem = recordarAviso(base({ emisor: "send" }), false, T(10), { ultimoEmisor: "placement-pause", ultimoAviso: T(9), ultimaFirma: null });
  assert.equal(mem.ultimoEmisor, "send");
  assert.equal(mem.ultimoAviso, T(9), "pero no marca que habló");
});

test("la señal de vida solo sale con riesgo abierto, nunca como ruido periódico", () => {
  const mem: MemoriaSlack = { ultimoEmisor: "placement-pause", ultimoAviso: T(0), ultimaFirma: null };
  assert.equal(decidirSiHablar(base({ riesgo: "ninguno" }), mem, T(10)), null, "sin riesgo, silencio");
  const conRiesgo = decidirSiHablar(base({ riesgo: "la rampa se estanca" }), mem, T(10));
  assert.ok(conRiesgo);
  assert.match(conRiesgo.texto, /Sigo acá/);
});

test("sin credenciales no revienta: informa y sigue", async () => {
  // Que Slack esté caído o sin configurar no puede tumbar al agente que vigila la fábrica.
  const r = await mandarASlack({ texto: "x", motivo: "m", pideRespuesta: false }, {});
  assert.equal(r.ok, false);
  assert.match(r.motivo ?? "", /SLACK_BOT_TOKEN/);

  const rota = await mandarASlack(
    { texto: "x", motivo: "m", pideRespuesta: false },
    { token: "t", canal: "c", fetchImpl: (async () => { throw new Error("red caída"); }) as never }
  );
  assert.equal(rota.ok, false);
  assert.match(rota.motivo ?? "", /red caída/);

  const okey = await mandarASlack(
    { texto: "x", motivo: "m", pideRespuesta: false },
    { token: "t", canal: "c", fetchImpl: (async () => ({ json: async () => ({ ok: true }) })) as never }
  );
  assert.equal(okey.ok, true);
});

test("un problema que dura toda la noche NO son 48 mensajes idénticos", () => {
  // Corriendo cada 10 min, las razones que avisan sobre una CONDICIÓN QUE PERSISTE (el modelo
  // caído, una lectura con reparos) no miraban la memoria: un problema que dura la noche llenaba
  // Slack antes del desayuno. El daño real no es la molestia — es que entrena al operador a
  // ignorar el canal por el que tiene que llegar lo urgente.
  const ciego = base({ sinLectura: "fetch failed" });
  const primero = decidirSiHablar(ciego, null, T(1));
  assert.ok(primero, "la primera vez sí avisa");

  const mem = recordarAviso(ciego, true, T(1), null, primero);
  assert.equal(decidirSiHablar(ciego, mem, T(2)), null, "una hora después, callado");
  assert.equal(decidirSiHablar(ciego, mem, T(6)), null, "cinco horas después, todavía callado");

  // Pero callarse para siempre tampoco sirve: si a las 4am quedó ciego, a las 8 hay que saberlo.
  const alRato = decidirSiHablar(ciego, mem, T(8));
  assert.ok(alRato, "a las 7 horas lo repite: sigue roto y hay que enterarse");
});

test("dos condiciones distintas no se tapan entre sí", () => {
  // Guardando solo la firma del ESTADO, un aviso por reparos silenciaba al de sin-lectura y al
  // revés, porque el estado subyacente puede ser el mismo. Cada razón lleva su etiqueta.
  const conReparos = base({ reparos: ["dice que x.com cruzó y no figura"] });
  const a1 = decidirSiHablar(conReparos, null, T(1));
  assert.ok(a1);
  const mem = recordarAviso(conReparos, true, T(1), null, a1);

  const ciego = base({ sinLectura: "modelo caído" });
  assert.ok(decidirSiHablar(ciego, mem, T(2)), "otra condición SÍ se avisa aunque sea a los minutos");
});

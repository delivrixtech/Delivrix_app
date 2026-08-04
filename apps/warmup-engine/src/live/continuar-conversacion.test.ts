// Tests de la continuación del hilo. Lo que protegen: que no contestemos cuando no toca (el error
// caro es MANDAR de más), que la espera sea humana y reproducible, y que un fallo del modelo nunca
// termine en un correo inventado.

import assert from "node:assert/strict";
import test from "node:test";

import {
  esperaAntesDeResponder,
  MAX_TURNOS,
  pedirSiguienteTurno,
  tocaResponder,
  type TurnoHilo
} from "./continuar-conversacion.ts";

const AHORA = new Date("2026-08-03T20:00:00.000Z");
const haceMin = (m: number) => new Date(AHORA.getTime() - m * 60_000).toISOString();

const hilo = (...quienes: Array<TurnoHilo["quien"]>): TurnoHilo[] =>
  quienes.map((quien, i) => ({ quien, texto: `mensaje ${i}` }));

test("NO se contesta si el último mensaje es nuestro: estaríamos hablando solos", () => {
  const r = tocaResponder({ hiloId: "h1", turnos: hilo("ellos", "nosotros"), ultimoMensajeEn: haceMin(300), ahora: AHORA });
  assert.equal(r.si, false);
  assert.match(r.motivo, /esperando respuesta/);
});

test("se espera un tiempo humano antes de contestar", () => {
  // Contestar a los 2 minutos, siempre, es tan reconocible como un texto repetido.
  const r = tocaResponder({ hiloId: "h1", turnos: hilo("nosotros", "ellos"), ultimoMensajeEn: haceMin(2), ahora: AHORA });
  assert.equal(r.si, false);
  assert.match(r.motivo, /tiempo humano/);
  assert.ok((r.esperaRestanteMs ?? 0) > 0);
});

test("pasada la espera, toca responder", () => {
  const r = tocaResponder({ hiloId: "h1", turnos: hilo("nosotros", "ellos"), ultimoMensajeEn: haceMin(200), ahora: AHORA });
  assert.equal(r.si, true);
  assert.match(r.motivo, /toca responder/);
});

test("la espera es REPRODUCIBLE y está entre 12 y 90 minutos", () => {
  // Sin azar, una corrida se puede reconstruir; y el rango evita los dos extremos sospechosos.
  for (const id of ["a", "b", "c-largo", "warmup-cycle-123"]) {
    for (let t = 0; t < 5; t += 1) {
      const ms = esperaAntesDeResponder(id, t);
      assert.equal(ms, esperaAntesDeResponder(id, t), "misma entrada, misma espera");
      assert.ok(ms >= 12 * 60_000 && ms <= 91 * 60_000, `fuera de rango: ${ms / 60000} min`);
    }
  }
  assert.notEqual(esperaAntesDeResponder("a", 0), esperaAntesDeResponder("a", 1), "varía entre turnos");
});

test("el hilo se deja morir al llegar al tope: una charla infinita tampoco es humana", () => {
  const largo = hilo(...Array.from({ length: MAX_TURNOS }, (_, i) => (i % 2 ? "ellos" : "nosotros") as const));
  const r = tocaResponder({ hiloId: "h1", turnos: largo, ultimoMensajeEn: haceMin(300), ahora: AHORA });
  assert.equal(r.si, false);
  assert.match(r.motivo, /tope/);
});

test("hilo vacío o fecha ilegible: no se contesta, y se dice por qué", () => {
  assert.equal(tocaResponder({ hiloId: "h", turnos: [], ultimoMensajeEn: haceMin(1), ahora: AHORA }).si, false);
  const r = tocaResponder({ hiloId: "h", turnos: hilo("ellos"), ultimoMensajeEn: "no-es-fecha", ahora: AHORA });
  assert.equal(r.si, false);
  assert.match(r.motivo, /fecha/);
});

test("si el modelo dice FIN, no se manda nada", async () => {
  const r = await pedirSiguienteTurno({
    turnos: hilo("nosotros", "ellos"), asunto: "x", baseUrl: "http://local/v1", modelo: "m",
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "FIN" } }] }))) as typeof fetch
  });
  assert.equal(r.texto, null);
  assert.match(r.motivo, /cerró la conversación/);
});

test("un fallo del modelo NUNCA termina en un correo inventado", async () => {
  // El error caro acá es mandar de más: un correo enviado por error no se puede deshacer.
  const httpMal = await pedirSiguienteTurno({
    turnos: hilo("ellos"), asunto: "x", baseUrl: "http://local/v1", modelo: "m",
    fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch
  });
  assert.equal(httpMal.texto, null);

  const vacio = await pedirSiguienteTurno({
    turnos: hilo("ellos"), asunto: "x", baseUrl: "http://local/v1", modelo: "m",
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "  " } }] }))) as typeof fetch
  });
  assert.equal(vacio.texto, null);
  assert.match(vacio.motivo, /vacío/);

  const roto = await pedirSiguienteTurno({
    turnos: hilo("ellos"), asunto: "x", baseUrl: "http://local/v1", modelo: "m",
    fetchImpl: (async () => { throw new Error("sin red"); }) as typeof fetch
  });
  assert.equal(roto.texto, null);
  assert.match(roto.motivo, /sin red/);
});

test("un turno largo se recorta: un correo cotidiano no tiene 3 mil caracteres", async () => {
  const r = await pedirSiguienteTurno({
    turnos: hilo("ellos"), asunto: "x", baseUrl: "http://local/v1", modelo: "m",
    fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "a".repeat(3000) } }] }))) as typeof fetch
  });
  assert.ok((r.texto ?? "").length <= 601);
});

import assert from "node:assert/strict";
import test from "node:test";
import { avanzar, dondeResponder, esParaContestar, estadoVacio, leerNuevos } from "./slack-lectura.ts";

test("NO se contesta a sí mismo — el bucle infinito más fácil de escribir", () => {
  // Los mensajes propios traen bot_id pero NO siempre subtype "bot_message": filtrar por subtype
  // solo (que es lo obvio) deja pasar los propios y el agente se responde para siempre.
  assert.equal(esParaContestar({ ts: "1", text: "hola", bot_id: "B123" }, null), false, "cualquier bot");
  assert.equal(esParaContestar({ ts: "1", text: "hola", user: "U_YO" }, "U_YO"), false, "él mismo por user id");
  assert.equal(esParaContestar({ ts: "1", text: "x", subtype: "channel_join" }, null), false, "no es conversación");
  assert.equal(esParaContestar({ ts: "1", text: "   " }, null), false, "vacío");
  assert.equal(esParaContestar({ ts: "1", text: "hola" }, "U_YO"), true, "un humano sí");
});

test("responde EN EL HILO: el ?? es donde se pierde la conversación", () => {
  // Si el mensaje del jefe ya es una respuesta dentro de un hilo, trae thread_ts distinto de ts.
  // Contestar sobre `ts` a secas abre un hilo nuevo colgando de una respuesta: la conversación
  // queda partida y el agente "se pierde".
  assert.equal(dondeResponder({ ts: "200", thread_ts: "100", texto: "x", usuario: "U" }), "100");
  assert.equal(dondeResponder({ ts: "100", thread_ts: "100", texto: "x", usuario: "U" }), "100");
});

test("el cursor es el dedupe: al reiniciar no re-contesta lo viejo", () => {
  const e = avanzar(estadoVacio(), [{ ts: "300", thread_ts: "300", texto: "a", usuario: "U" }], "2026-08-06T00:00:00Z");
  assert.equal(e.cursorTs, "300");
  const e2 = avanzar(e, [{ ts: "500", thread_ts: "300", texto: "b", usuario: "U" }], "2026-08-06T00:10:00Z");
  assert.equal(e2.cursorTs, "500", "avanza al más nuevo");
  assert.equal(e2.hilosActivos.length, 1, "el hilo sigue siendo uno");
  assert.equal(e2.hilosActivos[0]?.ultimoTs, "500");
});

test("solo vigila los 5 hilos más recientes", () => {
  // Mirar respuestas cuesta una llamada por hilo. Una charla de hace días no necesita vigilancia.
  let e = estadoVacio();
  for (let i = 1; i <= 9; i++) {
    e = avanzar(e, [{ ts: `${i}00`, thread_ts: `${i}00`, texto: "x", usuario: "U" }], "2026-08-06T00:00:00Z");
  }
  assert.equal(e.hilosActivos.length, 5);
  assert.equal(e.hilosActivos[0]?.thread_ts, "900", "los más nuevos primero");
});

test("leerNuevos descarta lo ya procesado y junta las respuestas del hilo", async () => {
  const llamadas: string[] = [];
  const fake = (async (url: string) => {
    llamadas.push(String(url));
    const u = String(url);
    if (u.includes("conversations.history")) {
      return {
        json: async () => ({
          ok: true,
          messages: [
            { ts: "100", text: "viejo, ya contestado", user: "U_JEFE" },
            { ts: "300", text: "nuevo", user: "U_JEFE" },
            { ts: "310", text: "mío", bot_id: "B1" }
          ]
        })
      };
    }
    return { json: async () => ({ ok: true, messages: [{ ts: "305", thread_ts: "200", text: "en el hilo", user: "U_JEFE" }] }) };
  }) as never;

  const { mensajes, error } = await leerNuevos(
    { token: "t", canal: "C1", botUserId: "U_YO", fetchImpl: fake },
    { cursorTs: "200", hilosActivos: [{ thread_ts: "200", ultimoTs: "200" }], ultimaLecturaOk: null }
  );
  assert.equal(error, null);
  assert.deepEqual(mensajes.map((m) => m.ts), ["300", "305"], "ni el viejo ni el propio");
  assert.equal(mensajes.find((m) => m.ts === "305")?.thread_ts, "200", "la respuesta conserva su hilo");
  assert.ok(llamadas.some((u) => u.includes("conversations.replies")), "pidió las respuestas del hilo vivo");
});

test("un hilo roto no tumba la lectura entera", async () => {
  const fake = (async (url: string) => {
    if (String(url).includes("conversations.history")) {
      return { json: async () => ({ ok: true, messages: [{ ts: "400", text: "hola", user: "U" }] }) };
    }
    return { json: async () => ({ ok: false, error: "thread_not_found" }) };
  }) as never;
  const { mensajes, error } = await leerNuevos(
    { token: "t", canal: "C1", fetchImpl: fake },
    { cursorTs: "300", hilosActivos: [{ thread_ts: "999", ultimoTs: "999" }], ultimaLecturaOk: null }
  );
  assert.equal(error, null);
  assert.deepEqual(mensajes.map((m) => m.ts), ["400"]);
});

test("si Slack falla, lo dice y no inventa mensajes", async () => {
  const fake = (async () => ({ json: async () => ({ ok: false, error: "not_in_channel" }) })) as never;
  const { mensajes, error } = await leerNuevos({ token: "t", canal: "C1", fetchImpl: fake }, estadoVacio());
  assert.deepEqual(mensajes, []);
  assert.equal(error, "not_in_channel");
});

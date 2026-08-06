import assert from "node:assert/strict";
import test from "node:test";
import { avanzar, dondeResponder, esParaContestar, estadoVacio, leerNuevos, acusarRecibo } from "./slack-lectura.ts";

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

test("un mensaje del jefe con 'responder también al canal' SE LEE", () => {
  // Rechazar todo `subtype` dejaba sordo al agente ante la forma más natural de escribirle desde
  // el móvil. Se comió dos mensajes reales de Juanes la noche del 2026-08-05 ("Ok, muestrame." y
  // "Pero ya tenemos 2 semillas configuradas...") y él nunca vio un error: para él, Sentinel lo
  // ignoró. Mismo bug que motivó este archivo, sobreviviendo en otra forma.
  assert.equal(
    esParaContestar({ ts: "1785989349.433769", text: "Ok, muestrame.", user: "U0BAQSXJJLW", subtype: "thread_broadcast" }, "U0BNCHPTPH8"),
    true
  );
  // Una captura CON texto también es conversación: el operador manda capturas todo el tiempo.
  assert.equal(esParaContestar({ ts: "1", text: "mirá esto", user: "U0BAQSXJJLW", subtype: "file_share" }, "U0BNCHPTPH8"), true);
  // Lo que NO es conversación sigue afuera.
  assert.equal(esParaContestar({ ts: "1", text: "se unió al canal", user: "U0BAQSXJJLW", subtype: "channel_join" }, "U0BNCHPTPH8"), false);
  // Y un broadcast del PROPIO bot sigue sin contar: el filtro de subtype no puede abrirle la puerta.
  assert.equal(esParaContestar({ ts: "1", text: "hola", bot_id: "B123", subtype: "thread_broadcast" }, "U0BNCHPTPH8"), false);
  assert.equal(esParaContestar({ ts: "1", text: "hola", user: "U0BNCHPTPH8", subtype: "thread_broadcast" }, "U0BNCHPTPH8"), false);
});

test("el acuse de recibo no puede tumbar ni demorar la respuesta", async () => {
  // El modelo tarda ~34s. El 👀 existe para que el jefe sepa que su mensaje llegó mientras tanto:
  // "no pasó nada" es indistinguible de "el agente está caído". Pero un acuse es cortesía y la
  // respuesta es el trabajo — si Slack rechaza la reacción, no puede impedir que conteste.
  const ok = (async () => ({ json: async () => ({ ok: true }) })) as never;
  assert.equal(await acusarRecibo({ token: "t", canal: "c", fetchImpl: ok }, "1785992301.007749"), true);

  const rechaza = (async () => ({ json: async () => ({ ok: false, error: "already_reacted" }) })) as never;
  assert.equal(await acusarRecibo({ token: "t", canal: "c", fetchImpl: rechaza }, "1"), false, "informa, no lanza");

  const rota = (async () => { throw new Error("red caída"); }) as never;
  assert.equal(await acusarRecibo({ token: "t", canal: "c", fetchImpl: rota }, "1"), false, "una red caída no explota");
});

test("el acuse va al MENSAJE, no al hilo", async () => {
  // reactions.add necesita el ts del mensaje concreto. Mandarle el thread_ts pondría el 👀 en el
  // primer mensaje del hilo —uno viejo— y el jefe no vería nada sobre lo que acaba de escribir.
  let cuerpo: Record<string, unknown> = {};
  const espia = (async (_u: string, init: { body: string }) => {
    cuerpo = JSON.parse(init.body) as Record<string, unknown>;
    return { json: async () => ({ ok: true }) };
  }) as never;
  await acusarRecibo({ token: "t", canal: "C123", fetchImpl: espia }, "1785992301.007749");
  assert.equal(cuerpo.timestamp, "1785992301.007749");
  assert.equal(cuerpo.channel, "C123");
  assert.equal(cuerpo.name, "eyes");
});

test("el cursor avanza aunque NO haya nada que contestar — o el agente queda sordo", () => {
  // EL BUG del 2026-08-06, tal cual pasó. `conversations.history` con `oldest` pagina hacia
  // ADELANTE y devuelve los N más VIEJOS que quedan. El agente había mandado ~25 avisos durante la
  // noche; esos 20 llenaron la ventana, se filtraron todos por ser suyos, la lista salió vacía —
  // y como el cursor solo avanzaba con mensajes contestables, se quedó clavado. Cada 6 segundos
  // releía la MISMA pared. Los seis mensajes del jefe estaban del otro lado y nunca los vio.
  // Los ts van con la forma REAL de Slack (epoch.microsegundos, ancho fijo). Importa: todo el
  // módulo los ordena como STRINGS, y eso solo es correcto porque son de ancho fijo. Con valores
  // de juguete como "50" y "100" el test miente —"50" > "100" es verdadero comparando strings— y
  // habría fijado la regla al revés.
  const estado: EstadoLectura = { cursorTs: "1785993125.485049", hilosActivos: [], ultimaLecturaOk: null };

  const clavado = avanzar(estado, [], "2026-08-06T18:00:00.000Z");
  assert.equal(clavado.cursorTs, "1785993125.485049", "sin ultimoVisto no puede saltar: no inventa");

  const salta = avanzar(estado, [], "2026-08-06T18:00:00.000Z", "1786020618.219029");
  assert.equal(salta.cursorTs, "1786020618.219029", "leyó hasta ahí aunque nada fuera contestable");

  // Y nunca retrocede: un ultimoVisto viejo no puede hacer que se reprocese lo ya contestado.
  assert.equal(avanzar(estado, [], "t", "1785000000.000000").cursorTs, "1785993125.485049");
});

test("con mensajes contestables, el cursor cubre TODO lo leído, no solo lo contestado", () => {
  // Si en la misma tanda vienen un mensaje del jefe (ts 200) y después tres del bot (hasta 400),
  // dejar el cursor en 200 hace que la vuelta siguiente relea los tres del bot. Con pocos no
  // importa; con veinte, es la pared otra vez.
  const estado: EstadoLectura = { cursorTs: "1785993125.485049", hilosActivos: [], ultimaLecturaOk: null };
  const delJefe = [{ ts: "1786034865.923579", thread_ts: "1786034865.923579", texto: "hola", usuario: "U0BAQSXJJLW" }];
  assert.equal(avanzar(estado, delJefe, "t", "1786041326.793579").cursorTs, "1786041326.793579");
  // Sin ultimoVisto sigue funcionando como antes: el contrato viejo no se rompe.
  assert.equal(avanzar(estado, delJefe, "t").cursorTs, "1786034865.923579");
});

test("leerNuevos informa hasta dónde LEYÓ, no solo qué contestó", async () => {
  const soloDelBot = {
    ok: true,
    messages: [
      { ts: "1786015275.299129", text: "Juanes, revisá los cupos", bot_id: "B123" },
      { ts: "1786020618.219029", text: "Juanes, el freno no pegó", bot_id: "B123" }
    ]
  };
  const fake = (async () => ({ json: async () => soloDelBot })) as never;
  const r = await leerNuevos(
    { token: "t", canal: "c", botUserId: "U0BNCHPTPH8", fetchImpl: fake },
    { cursorTs: "1785993125.485049", hilosActivos: [], ultimaLecturaOk: null }
  );
  assert.equal(r.mensajes.length, 0, "ninguno es contestable");
  assert.equal(r.ultimoVisto, "1786020618.219029", "pero leyó hasta ahí, y el cursor tiene que poder saltar");
});

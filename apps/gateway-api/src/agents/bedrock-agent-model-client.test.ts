// Tests del cliente real de modelo. Cero red, cero credenciales: se inyecta un cliente falso que
// devuelve chunks del stream, que es exactamente la costura que ya usa el test del bridge.
//
// Lo que estos tests protegen no es "que compile": es que un diagnostico no se cierre con datos
// que no existen. Cada uno corresponde a un modo de falla concreto que el mock nunca ejercito.

import assert from "node:assert/strict";
import test from "node:test";

import {
  BedrockAgentModelClient,
  isRetryableModelError,
  mapStopReason,
  toBedrockMessages
} from "./bedrock-agent-model-client.ts";
import type { AgentModelTurn } from "./bedrock-agent-session.ts";
import type { BedrockRuntimeClientLike } from "../bedrock-messages-invoke.ts";

// --- dobles ----------------------------------------------------------------

function chunk(event: unknown): { chunk: { bytes: Uint8Array } } {
  return { chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) } };
}

/** Stream minimo bien formado: usage de entrada, bloques, usage de salida y stop_reason. */
function streamOf(options: {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input?: unknown; partialJson?: string }>;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}): Array<{ chunk: { bytes: Uint8Array } }> {
  const events: unknown[] = [
    { type: "message_start", message: { usage: { input_tokens: options.inputTokens ?? 1_200 } } }
  ];
  let index = 0;
  if (options.text !== undefined) {
    events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: options.text } });
    index += 1;
  }
  for (const use of options.toolUses ?? []) {
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: use.id, name: use.name, input: {} }
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: use.partialJson ?? JSON.stringify(use.input ?? {})
      }
    });
    index += 1;
  }
  // FORMA REAL DEL WIRE, y esto ya se equivoco una vez.
  // En message_delta el `usage` va en la RAIZ y `stop_reason` va DENTRO de `delta`. El fixture
  // anterior ponia stop_reason en la raiz, o sea que confirmaba el parser en vez de la realidad:
  // los 20 tests pasaban en verde mientras contra Bedrock stopReason salia siempre undefined.
  // Si se toca esta forma, se rompe el unico anclaje que este modulo tiene con la API de verdad.
  events.push({
    type: "message_delta",
    delta: { stop_reason: options.stopReason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: options.outputTokens ?? 340 }
  });
  return events.map(chunk);
}

interface FakeClientCall {
  body: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

function fakeClient(
  responder: (call: number) => Array<{ chunk: { bytes: Uint8Array } }> | Error
): { client: BedrockRuntimeClientLike; calls: FakeClientCall[] } {
  const calls: FakeClientCall[] = [];
  const client: BedrockRuntimeClientLike = {
    async send(command, options) {
      const raw = (command as unknown as { input: { body: string } }).input.body;
      calls.push({ body: JSON.parse(raw) as Record<string, unknown>, ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}) });
      const outcome = responder(calls.length);
      if (outcome instanceof Error) throw outcome;
      return { body: outcome };
    }
  };
  return { client, calls };
}

function clientUnderTest(
  responder: (call: number) => Array<{ chunk: { bytes: Uint8Array } }> | Error,
  overrides: Partial<ConstructorParameters<typeof BedrockAgentModelClient>[0]> = {}
): {
  client: BedrockAgentModelClient;
  calls: FakeClientCall[];
  degradations: Array<{ kind: string; detail: string }>;
  slept: number[];
} {
  const { client: fake, calls } = fakeClient(responder);
  const degradations: Array<{ kind: string; detail: string }> = [];
  const slept: number[] = [];
  const client = new BedrockAgentModelClient({
    client: fake,
    modelId: "us.anthropic.claude-sonnet-4-6-v1:0",
    onDegradation: (notice) => degradations.push({ kind: notice.kind, detail: notice.detail }),
    sleep: async (ms) => { slept.push(ms); },
    random: () => 0.5,
    ...overrides
  });
  return { client, calls, degradations, slept };
}

const TOOLS = [
  { name: "read_smtp_reachability", description: "sondea el nodo", input_schema: { type: "object", properties: {}, required: [] } }
];

// --- traduccion de turnos --------------------------------------------------

test("toBedrockMessages: el turno de tool_results NO lleva bloque de texto vacio", () => {
  // La sesion empuja SIEMPRE content:"" despues de despachar tools (bedrock-agent-session.ts:344).
  // Un mapeo literal meteria {type:"text",text:""} en toda sesion que use tools.
  const turns: AgentModelTurn[] = [
    { role: "user", content: "diagnostica filing-ops.com" },
    { role: "assistant", content: "", toolUses: [{ toolUseId: "toolu_1", toolName: "read_smtp_reachability", toolInput: { domain: "filing-ops.com" } }] },
    { role: "user", content: "", toolResults: [{ toolUseId: "toolu_1", content: '{"ok":true}' }] }
  ];

  const messages = toBedrockMessages(turns);

  assert.deepEqual(messages[0], { role: "user", content: [{ type: "text", text: "diagnostica filing-ops.com" }] });
  // El assistant que fue directo a la tool: SOLO el tool_use, sin texto vacio adelante.
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "read_smtp_reachability", input: { domain: "filing-ops.com" } }]
  });
  assert.deepEqual(messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' }]
  });

  for (const message of messages) {
    for (const block of message.content) {
      assert.notEqual(block.type === "text" && block.text === "", true, "ningun bloque de texto vacio");
    }
  }
});

test("toBedrockMessages: el texto del assistant sobrevive junto a sus tool_use, en orden", () => {
  const messages = toBedrockMessages([
    {
      role: "assistant",
      content: "Reviso el nodo primero.",
      toolUses: [
        { toolUseId: "toolu_a", toolName: "read_smtp_reachability", toolInput: { domain: "a.com" } },
        { toolUseId: "toolu_b", toolName: "read_dkim_status", toolInput: { domain: "a.com" } }
      ]
    }
  ]);

  assert.deepEqual(messages[0]?.content, [
    { type: "text", text: "Reviso el nodo primero." },
    { type: "tool_use", id: "toolu_a", name: "read_smtp_reachability", input: { domain: "a.com" } },
    { type: "tool_use", id: "toolu_b", name: "read_dkim_status", input: { domain: "a.com" } }
  ]);
});

test("toBedrockMessages: no muta el historial vivo de la sesion", () => {
  // La sesion pasa `messages: this.turns` sin copia y sigue haciendo push despues.
  const turns: AgentModelTurn[] = [{ role: "user", content: "hola" }];
  const snapshot = JSON.stringify(turns);
  toBedrockMessages(turns);
  assert.equal(JSON.stringify(turns), snapshot);
});

test("toBedrockMessages: un turno sin nada adentro falla legible en vez de dar 400", () => {
  assert.throws(
    () => toBedrockMessages([{ role: "user", content: "" }]),
    (error: unknown) => (error as { code?: string }).code === "agent_turn_without_content"
  );
});

// --- mapeo de stop_reason --------------------------------------------------

test("mapStopReason: tool_use solo si de verdad hay tool_use", () => {
  assert.deepEqual(mapStopReason("tool_use", 2), { stopReason: "tool_use", unknown: false });
  // Declaro tool_use pero no mando bloques: no hay nada que ejecutar.
  assert.deepEqual(mapStopReason("tool_use", 0), { stopReason: "end_turn", unknown: false });
  // Y al reves: hay bloques, gana el hecho sobre la etiqueta.
  assert.deepEqual(mapStopReason("end_turn", 1), { stopReason: "tool_use", unknown: false });
});

test("mapStopReason: lo desconocido cierra el turno pero se reporta", () => {
  assert.deepEqual(mapStopReason("max_tokens", 0), { stopReason: "max_tokens", unknown: false });
  assert.deepEqual(mapStopReason("stop_sequence", 0), { stopReason: "end_turn", unknown: false });
  assert.deepEqual(mapStopReason(undefined, 0), { stopReason: "end_turn", unknown: false });
  assert.deepEqual(mapStopReason("pause_turn", 0), { stopReason: "end_turn", unknown: true });
});

// --- payload ---------------------------------------------------------------

test("invoke: arma el payload del camino probado y omite tools cuando no hay", async () => {
  const { client, calls } = clientUnderTest(() => streamOf({ text: "listo" }));

  await client.invoke({ system: "sos el warmup senior", messages: [{ role: "user", content: "dale" }], tools: [] });

  const body = calls[0]!.body;
  assert.equal(body.anthropic_version, "bedrock-2023-05-31");
  assert.equal(body.system, "sos el warmup senior");
  assert.equal(body.max_tokens, 8_192);
  // tools:[] no es lo mismo que omitir la clave.
  assert.equal("tools" in body, false);
  assert.equal("tool_choice" in body, false);
});

test("invoke: no manda temperature a los modelos que la rechazan", async () => {
  const conTemp = clientUnderTest(() => streamOf({ text: "ok" }), { modelId: "us.anthropic.claude-sonnet-4-6-v1:0" });
  await conTemp.client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: TOOLS });
  assert.equal(conTemp.calls[0]!.body.temperature, 0);

  const sinTemp = clientUnderTest(() => streamOf({ text: "ok" }), { modelId: "us.anthropic.claude-opus-5-v1:0" });
  await sinTemp.client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: TOOLS });
  assert.equal("temperature" in sinTemp.calls[0]!.body, false);
});

// --- respuesta -------------------------------------------------------------

test("invoke: devuelve tool_uses, texto y tokens reales", async () => {
  const { client } = clientUnderTest(() =>
    streamOf({
      text: "Sondeo el nodo.",
      toolUses: [{ id: "toolu_9", name: "read_smtp_reachability", input: { domain: "x.com" } }],
      stopReason: "tool_use",
      inputTokens: 4_321,
      outputTokens: 87
    })
  );

  const result = await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: TOOLS });

  assert.equal(result.stopReason, "tool_use");
  assert.equal(result.text, "Sondeo el nodo.");
  assert.deepEqual(result.toolUses, [
    { toolUseId: "toolu_9", toolName: "read_smtp_reachability", toolInput: { domain: "x.com" } }
  ]);
  assert.equal(result.inputTokens, 4_321);
  assert.equal(result.outputTokens, 87);
});

test("invoke: sin usage falla, porque el cap de tokens es el unico freno de gasto", async () => {
  // Un 0 inventado desactivaria en silencio el cap de 50.000 por sesion.
  const { client } = clientUnderTest(() => [
    chunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "hola" } }),
    chunk({ type: "message_delta", stop_reason: "end_turn" })
  ]);

  await assert.rejects(
    client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] }),
    (error: unknown) => (error as { code?: string }).code === "agent_usage_missing"
  );
});

test("invoke: un tool_use con el JSON cortado falla en vez de sondear con parametros vacios", async () => {
  // Este es el modo de falla caro: read_smtp_reachability sin dominio devuelve un veredicto
  // confiado sobre el nodo equivocado.
  const { client, degradations } = clientUnderTest(() =>
    streamOf({
      toolUses: [{ id: "toolu_x", name: "read_smtp_reachability", partialJson: '{"domain":"filing-op' }],
      stopReason: "tool_use"
    })
  );

  await assert.rejects(
    client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: TOOLS }),
    (error: unknown) => (error as { code?: string }).code === "agent_tool_input_malformed"
  );
  assert.equal(degradations.some((d) => d.kind === "malformed_tool_input"), true);
});

test("invoke: una respuesta truncada se avisa, aunque la sesion la cierre como completada", async () => {
  const { client, degradations } = clientUnderTest(() =>
    streamOf({ text: "el veredicto a medio escr", stopReason: "max_tokens" })
  );

  const result = await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });

  assert.equal(result.stopReason, "max_tokens");
  assert.equal(degradations.some((d) => d.kind === "response_truncated"), true);
});

test("invoke: stop_reason se lee de delta, que es donde la API lo manda", async () => {
  // Test de regresion del bug que los otros 20 no vieron porque el fixture repetia mi error.
  // Se arma el evento a mano, sin pasar por streamOf, para que quede escrito literal.
  const { client } = clientUnderTest(() => [
    chunk({ type: "message_start", message: { usage: { input_tokens: 1_200 } } }),
    chunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "el veredicto a medio" } }),
    chunk({ type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 8_192 } })
  ]);

  const result = await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });

  assert.equal(result.stopReason, "max_tokens", "stop_reason vive en delta, no en la raiz");
});

test("invoke: un stop_reason nuevo cierra el turno y se reporta, no se inventa", async () => {
  const { client, degradations } = clientUnderTest(() => streamOf({ text: "x", stopReason: "refusal" }));

  const result = await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });

  assert.equal(result.stopReason, "end_turn");
  assert.equal(degradations.some((d) => d.kind === "unknown_stop_reason"), true);
});

// --- throttling ------------------------------------------------------------

test("isRetryableModelError: throttling y 5xx si, 400 no", () => {
  const throttle = Object.assign(new Error("slow down"), { name: "ThrottlingException" });
  assert.equal(isRetryableModelError(throttle), true);

  const server = Object.assign(new Error("boom"), { $metadata: { httpStatusCode: 503 } });
  assert.equal(isRetryableModelError(server), true);

  // Reintentar un 400 es quemar plata: va a fallar igual las 4 veces.
  const badRequest = Object.assign(new Error("invalid"), {
    name: "ValidationException",
    $metadata: { httpStatusCode: 400 }
  });
  assert.equal(isRetryableModelError(badRequest), false);
});

test("invoke: reintenta el throttle con backoff creciente y termina bien", async () => {
  const throttle = (): Error => Object.assign(new Error("rate"), { name: "ThrottlingException" });
  const { client, calls, slept, degradations } = clientUnderTest((call) =>
    call <= 2 ? throttle() : streamOf({ text: "al tercer intento" })
  );

  const result = await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });

  assert.equal(result.text, "al tercer intento");
  assert.equal(calls.length, 3);
  // Con random fijo en 0.5 el jitter es exacto: base * 2^(n-1) * 1.0
  assert.deepEqual(slept, [1_000, 2_000]);
  assert.equal(degradations.filter((d) => d.kind === "throttled_retry").length, 2);
});

test("invoke: agotados los intentos, el error sube — no se devuelve un resultado vacio", async () => {
  const { client, calls } = clientUnderTest(() => Object.assign(new Error("rate"), { name: "ThrottlingException" }));

  await assert.rejects(
    client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] }),
    /rate/
  );
  assert.equal(calls.length, 4);
});

test("invoke: un 400 no se reintenta", async () => {
  const { client, calls } = clientUnderTest(() =>
    Object.assign(new Error("invalid"), { name: "ValidationException", $metadata: { httpStatusCode: 400 } })
  );

  await assert.rejects(client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] }));
  assert.equal(calls.length, 1);
});

// --- corte -----------------------------------------------------------------

test("invoke: abortado lanza, no devuelve exito", async () => {
  // Devolver stopReason "aborted" haria que la sesion lo cierre como completado: exito reportado
  // sobre un diagnostico que nunca ocurrio.
  const controller = new AbortController();
  const { client } = clientUnderTest(() => {
    controller.abort();
    return Object.assign(new Error("aborted"), { name: "AbortError" });
  });

  await assert.rejects(
    client.invoke({
      system: "s",
      messages: [{ role: "user", content: "u" }],
      tools: [],
      abortSignal: controller.signal
    }),
    (error: unknown) => (error as { code?: string }).code === "agent_invoke_aborted"
  );
});

test("invoke: el presupuesto por llamada corta aunque nadie pase abortSignal", async () => {
  // Hoy la sesion NO pasa abortSignal: sin techo propio, una llamada colgada cuelga la sesion,
  // el worker del abanico y la respuesta HTTP entera.
  const { client } = clientUnderTest(
    () => Object.assign(new Error("cuelga"), { name: "ThrottlingException" }),
    { callBudgetMs: 5, maxAttempts: 50, sleep: async () => { await new Promise((r) => setTimeout(r, 10)); } }
  );

  await assert.rejects(
    client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] }),
    (error: unknown) => (error as { code?: string }).code === "agent_call_budget_exhausted"
  );
});

test("invoke: un input gigante falla antes de mandarse", async () => {
  const { client, calls } = clientUnderTest(() => streamOf({ text: "ok" }), { maxInputChars: 200 });

  await assert.rejects(
    client.invoke({
      system: "s",
      messages: [{ role: "user", content: "x".repeat(5_000) }],
      tools: []
    }),
    (error: unknown) => (error as { code?: string }).code === "agent_input_too_large"
  );
  assert.equal(calls.length, 0, "no se gasto una llamada");
});

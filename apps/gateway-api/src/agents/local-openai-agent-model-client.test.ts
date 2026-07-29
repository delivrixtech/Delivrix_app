// Tests del cliente del modelo local. Servidor HTTP falso, cero red real, cero Mac prendida.
//
// El fixture de la respuesta usa la forma REAL de la API de OpenAI (choices[0].message.tool_calls
// con `arguments` como STRING, usage.prompt_tokens/completion_tokens). Esto no es un detalle:
// hace horas un fixture escrito desde mi suposicion escondio que stop_reason nunca se leia, y los
// 20 tests pasaban en verde. Si se toca esta forma, se rompe el unico anclaje con la realidad.

import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalOpenAiAgentModelClient,
  createLocalOpenAiAgentModelClient,
  mapFinishReason,
  toOpenAiMessages,
  toOpenAiTools
} from "./local-openai-agent-model-client.ts";
import type { AgentModelTurn } from "./bedrock-agent-session.ts";

const TOOLS = [
  {
    name: "read_smtp_reachability",
    description: "sondea el nodo",
    input_schema: { type: "object" as const, properties: { serverSlug: {}, serverIp: {} }, required: ["serverSlug", "serverIp"] }
  }
];

interface FakeCall { url: string; body: any }

function clientUnderTest(
  responder: (call: number) => { status?: number; payload?: unknown; text?: string } | Error,
  overrides: Partial<ConstructorParameters<typeof LocalOpenAiAgentModelClient>[0]> = {}
): { client: LocalOpenAiAgentModelClient; calls: FakeCall[]; degradations: string[] } {
  const calls: FakeCall[] = [];
  const degradations: string[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const outcome = responder(calls.length);
    if (outcome instanceof Error) throw outcome;
    const status = outcome.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return outcome.payload; },
      async text() { return outcome.text ?? ""; }
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const client = new LocalOpenAiAgentModelClient({
    baseUrl: "http://100.104.216.127:1234/v1",
    modelId: "qwen3-30b-a3b",
    fetchImpl,
    onDegradation: (n) => degradations.push(n.kind),
    ...overrides
  });
  return { client, calls, degradations };
}

/** Respuesta con la forma real de la API. */
function reply(options: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  finish?: string;
  prompt?: number;
  completion?: number;
  omitUsage?: boolean;
}): { payload: unknown } {
  return {
    payload: {
      choices: [
        {
          message: {
            role: "assistant",
            content: options.content ?? null,
            ...(options.toolCalls
              ? {
                  tool_calls: options.toolCalls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: c.args }
                  }))
                }
              : {})
          },
          finish_reason: options.finish ?? "stop"
        }
      ],
      ...(options.omitUsage
        ? {}
        : { usage: { prompt_tokens: options.prompt ?? 1_500, completion_tokens: options.completion ?? 90 } })
    }
  };
}

// --- traduccion de mensajes ------------------------------------------------

test("toOpenAiMessages: N tool_result se abren en N mensajes role:tool, no en uno solo", () => {
  // La diferencia estructural que mas rompe. En Anthropic los N resultados van en UN turno; en
  // OpenAI cada uno es su propio mensaje apareado por tool_call_id. Colapsarlos deja tool_calls
  // sin responder y el server rechaza el turno siguiente.
  const turns: AgentModelTurn[] = [
    { role: "user", content: "diagnostica a.com" },
    {
      role: "assistant",
      content: "",
      toolUses: [
        { toolUseId: "call_1", toolName: "read_smtp_reachability", toolInput: { serverSlug: "n1" } },
        { toolUseId: "call_2", toolName: "read_dkim_status", toolInput: { domain: "a.com" } }
      ]
    },
    {
      role: "user",
      content: "",
      toolResults: [
        { toolUseId: "call_1", content: '{"ok":true}' },
        { toolUseId: "call_2", content: '{"ok":false}' }
      ]
    }
  ];

  const messages = toOpenAiMessages(turns, "sos el warmup senior");

  assert.equal(messages[0]!.role, "system");
  assert.equal(messages[1]!.role, "user");
  // El assistant lleva content null (no "") y sus tool_calls con arguments STRING.
  assert.equal(messages[2]!.role, "assistant");
  assert.equal(messages[2]!.content, null);
  assert.equal(messages[2]!.tool_calls?.length, 2);
  assert.equal(typeof messages[2]!.tool_calls![0]!.function!.arguments, "string");
  assert.deepEqual(JSON.parse(messages[2]!.tool_calls![0]!.function!.arguments!), { serverSlug: "n1" });
  // Y los dos resultados salen como DOS mensajes separados.
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[3], { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' });
  assert.deepEqual(messages[4], { role: "tool", tool_call_id: "call_2", content: '{"ok":false}' });
});

test("toOpenAiMessages: el system va primero y una sola vez", () => {
  const messages = toOpenAiMessages([{ role: "user", content: "hola" }], "prompt del rol");
  assert.equal(messages.filter((m) => m.role === "system").length, 1);
  assert.equal(messages[0]!.content, "prompt del rol");
});

test("toOpenAiMessages: no muta el historial vivo de la sesion", () => {
  const turns: AgentModelTurn[] = [{ role: "user", content: "hola" }];
  const snapshot = JSON.stringify(turns);
  toOpenAiMessages(turns, "s");
  assert.equal(JSON.stringify(turns), snapshot);
});

test("toOpenAiTools: el schema viaja como parameters, sin transformar", () => {
  const tools = toOpenAiTools(TOOLS);
  assert.equal(tools[0]!.type, "function");
  assert.equal(tools[0]!.function.name, "read_smtp_reachability");
  assert.deepEqual(tools[0]!.function.parameters, TOOLS[0]!.input_schema);
});

// --- finish_reason ---------------------------------------------------------

test("mapFinishReason: gana el hecho sobre la etiqueta", () => {
  // Los modelos locales cierran con "stop" aunque hayan emitido tool_calls. Creerle a la
  // etiqueta dejaria las tools escritas y sin ejecutar.
  assert.deepEqual(mapFinishReason("stop", 2), { stopReason: "tool_use", unknown: false });
  assert.deepEqual(mapFinishReason("tool_calls", 1), { stopReason: "tool_use", unknown: false });
  // Y al reves: dice tool_calls pero no mando ninguna -> no hay nada que ejecutar.
  assert.deepEqual(mapFinishReason("tool_calls", 0), { stopReason: "end_turn", unknown: false });
  assert.deepEqual(mapFinishReason("length", 0), { stopReason: "max_tokens", unknown: false });
  assert.deepEqual(mapFinishReason("no_visto_antes", 0), { stopReason: "end_turn", unknown: true });
});

// --- payload ---------------------------------------------------------------

test("invoke: arma el request en la URL y forma correctas", async () => {
  const { client, calls } = clientUnderTest(() => reply({ content: "listo" }));

  await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: TOOLS });

  assert.equal(calls[0]!.url, "http://100.104.216.127:1234/v1/chat/completions");
  assert.equal(calls[0]!.body.model, "qwen3-30b-a3b");
  assert.equal(calls[0]!.body.stream, false);
  assert.equal(calls[0]!.body.temperature, 0, "un diagnostico tiene que ser reproducible");
  assert.equal(calls[0]!.body.tool_choice, "auto");
});

test("invoke: sin tools omite las claves, no manda tools vacio", async () => {
  const { client, calls } = clientUnderTest(() => reply({ content: "ok" }));
  await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });
  assert.equal("tools" in calls[0]!.body, false);
  assert.equal("tool_choice" in calls[0]!.body, false);
});

test("baseUrl: acepta con y sin /v1, y con barra colgando", async () => {
  for (const base of ["http://x:1234", "http://x:1234/", "http://x:1234/v1", "http://x:1234/v1/"]) {
    const { client, calls } = clientUnderTest(() => reply({ content: "ok" }), { baseUrl: base });
    await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    assert.equal(calls[0]!.url, "http://x:1234/v1/chat/completions", `fallo con ${base}`);
  }
});

// --- respuesta -------------------------------------------------------------

test("invoke: parsea tool_calls con arguments como string", async () => {
  const { client } = clientUnderTest(() =>
    reply({
      toolCalls: [{ id: "call_abc", name: "read_smtp_reachability", args: '{"serverSlug":"n1","serverIp":"1.2.3.4"}' }],
      finish: "tool_calls",
      prompt: 4_321,
      completion: 87
    })
  );

  const result = await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: TOOLS });

  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.toolUses, [
    { toolUseId: "call_abc", toolName: "read_smtp_reachability", toolInput: { serverSlug: "n1", serverIp: "1.2.3.4" } }
  ]);
  // usage viene con OTROS nombres que en Bedrock.
  assert.equal(result.inputTokens, 4_321);
  assert.equal(result.outputTokens, 87);
  // content null se normaliza a "": la sesion lee result.text sin guarda.
  assert.equal(result.text, "");
});

test("invoke: arguments vacio es una tool sin parametros, no un error", async () => {
  const { client } = clientUnderTest(() =>
    reply({ toolCalls: [{ id: "c1", name: "inspect_smtp_inventory", args: "" }], finish: "tool_calls" })
  );
  const result = await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: TOOLS });
  assert.deepEqual(result.toolUses[0]!.toolInput, {});
});

test("invoke: arguments con JSON roto falla en vez de sondear con parametros vacios", async () => {
  // El modo de falla mas probable de un modelo chico, y el mas caro: una sonda sin dominio
  // devuelve un veredicto confiado sobre el nodo equivocado.
  const { client, degradations } = clientUnderTest(() =>
    reply({ toolCalls: [{ id: "c1", name: "read_smtp_reachability", args: '{"serverSlug":"n1' }], finish: "tool_calls" })
  );

  await assert.rejects(
    client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: TOOLS }),
    (error: unknown) => (error as { code?: string }).code === "agent_tool_input_malformed"
  );
  assert.equal(degradations.includes("malformed_tool_input"), true);
});

test("invoke: sin usage falla — el cap por sesion es el unico freno", async () => {
  const { client } = clientUnderTest(() => reply({ content: "hola", omitUsage: true }));
  await assert.rejects(
    client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] }),
    (error: unknown) => (error as { code?: string }).code === "agent_usage_missing"
  );
});

test("invoke: una respuesta truncada se avisa", async () => {
  const { client, degradations } = clientUnderTest(() => reply({ content: "el veredicto a medio", finish: "length" }));
  const result = await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });
  assert.equal(result.stopReason, "max_tokens");
  assert.equal(degradations.includes("response_truncated"), true);
});

test("invoke: el costo de un modelo local es 0 y es un HECHO, no un desconocido", async () => {
  const { client } = clientUnderTest(() => reply({ content: "ok" }));
  assert.deepEqual(client.pricing, { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 });
  await client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });
});

// --- fallas del servidor ---------------------------------------------------

test("invoke: el modelo apagado da un error que lo dice", async () => {
  const { client } = clientUnderTest(() => Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" }));
  await assert.rejects(
    client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] }),
    (error: unknown) => (error as { code?: string }).code === "agent_local_unreachable"
  );
});

test("invoke: un HTTP no-ok sube con el detalle del server", async () => {
  const { client } = clientUnderTest(() => ({ status: 400, text: "model not loaded" }));
  await assert.rejects(
    client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] }),
    (error: unknown) =>
      (error as { code?: string }).code === "agent_local_http_error" &&
      /model not loaded/.test((error as Error).message)
  );
});

test("invoke: una respuesta sin choices no se toma por buena", async () => {
  const { client } = clientUnderTest(() => ({ payload: { id: "x" } }));
  await assert.rejects(
    client.invoke({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] }),
    (error: unknown) => (error as { code?: string }).code === "agent_local_response_malformed"
  );
});

test("invoke: abortado lanza, no devuelve exito", async () => {
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

// --- construccion desde el entorno -----------------------------------------

test("createLocalOpenAiAgentModelClient: falta de config falla explicito, no en la primera llamada", () => {
  assert.throws(
    () => createLocalOpenAiAgentModelClient({ env: {} }),
    (error: unknown) => (error as { code?: string }).code === "agent_local_base_url_missing"
  );
  assert.throws(
    () => createLocalOpenAiAgentModelClient({ env: { LOCAL_INFERENCE_BASE_URL: "http://x:1234/v1" } }),
    (error: unknown) => (error as { code?: string }).code === "agent_local_model_missing"
  );
  const ok = createLocalOpenAiAgentModelClient({
    env: { LOCAL_INFERENCE_BASE_URL: "http://100.104.216.127:1234/v1", LOCAL_INFERENCE_MODEL: "qwen3-30b-a3b" }
  });
  assert.equal(ok.modelId, "qwen3-30b-a3b");
});

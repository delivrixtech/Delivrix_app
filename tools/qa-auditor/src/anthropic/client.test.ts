import test from "node:test";
import assert from "node:assert/strict";
import { createAnthropicClient } from "./client.ts";

function res(status: number, body: unknown): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const toolBlockResponse = {
  content: [
    { type: "text", text: "preludio ignorado" },
    { type: "tool_use", name: "report_findings", input: { summary: "ok", findings: [] } }
  ],
  usage: { input_tokens: 120, output_tokens: 40 }
};

const baseInput = {
  system: "sys",
  userContent: "user",
  toolName: "report_findings",
  toolDescription: "desc",
  toolSchema: { type: "object" },
  maxTokens: 1024
};

test("invokeStructured extrae el input del bloque tool_use y fuerza el tool", async () => {
  let capturedBody: any = null;
  const fetchImpl = (async (_url: any, init: any) => {
    capturedBody = JSON.parse(init.body);
    return res(200, toolBlockResponse);
  }) as unknown as typeof fetch;
  const client = createAnthropicClient({ apiKey: "k", model: "m", fetchImpl });
  const result = await client.invokeStructured(baseInput);

  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.data, { summary: "ok", findings: [] });
    assert.equal(result.usage.inputTokens, 120);
  }
  assert.equal(capturedBody.tool_choice.type, "tool");
  assert.equal(capturedBody.tool_choice.name, "report_findings");
});

test("invokeStructured reintenta ante 429 y luego tiene exito", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    return n === 1 ? res(429, { error: "rate" }) : res(200, toolBlockResponse);
  }) as unknown as typeof fetch;
  const client = createAnthropicClient({ apiKey: "k", model: "m", fetchImpl, sleep: async () => {} });
  const result = await client.invokeStructured(baseInput);
  assert.ok(result.ok);
  assert.equal(n, 2);
});

test("invokeStructured falla limpio si no hay bloque tool_use", async () => {
  const fetchImpl = (async () =>
    res(200, { content: [{ type: "text", text: "sin tool" }], usage: {} })) as unknown as typeof fetch;
  const client = createAnthropicClient({ apiKey: "k", model: "m", fetchImpl });
  const result = await client.invokeStructured(baseInput);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /no_tool_use/);
  }
});

test("invokeStructured no reintenta ante 400 (no retryable)", async () => {
  let n = 0;
  const fetchImpl = (async () => {
    n += 1;
    return res(400, { error: "bad" });
  }) as unknown as typeof fetch;
  const client = createAnthropicClient({ apiKey: "k", model: "m", fetchImpl, sleep: async () => {} });
  const result = await client.invokeStructured(baseInput);
  assert.equal(result.ok, false);
  assert.equal(n, 1);
});

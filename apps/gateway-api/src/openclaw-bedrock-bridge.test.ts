import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createOpenClawBedrockBridgeFromEnv,
  OpenClawBedrockBridge
} from "./openclaw-bedrock-bridge.ts";
import type { ChatStreamEvent } from "./openclaw-chat.ts";

test("OpenClawBedrockBridge sendMessage queues and streamHistory emits typing, delta, and done", async () => {
  const calls: unknown[] = [];
  const bridge = new OpenClawBedrockBridge({
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
    modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    systemPromptPath: await promptFile("System prompt demo"),
    now: fixedNow(),
    fetchImpl: liveContextFetchStub(),
    client: {
      send: async (command) => {
        calls.push(command);
        return {
          body: [
            streamJson({ type: "message_start", message: { usage: { input_tokens: 12 } } }),
            streamJson({ type: "content_block_delta", delta: { type: "text_delta", text: "Respuesta OpenClaw " } }),
            streamJson({ type: "content_block_delta", delta: { type: "text_delta", text: "sobre DNS." } }),
            streamJson({ type: "message_delta", usage: { output_tokens: 8 } })
          ]
        };
      }
    }
  });

  const queued = await bridge.sendMessage({ msgId: "msg-1", message: "hola" });
  assert.deepEqual(queued, { msgId: "msg-1", queued: true });

  const events: ChatStreamEvent[] = [];
  await bridge.streamHistory("msg-1", {
    onTyping: (event) => events.push(event),
    onDelta: (event) => events.push(event),
    onDone: (event) => events.push(event)
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(events.map((event) => event.type), [
    "ASSISTANT_TYPING",
    "ASSISTANT_DELTA",
    "ASSISTANT_DONE"
  ]);
  assert.deepEqual(events[1], {
    type: "ASSISTANT_DELTA",
    msgId: "msg-1",
    delta: "Respuesta OpenClaw sobre DNS."
  });
  assert.equal(events[2].type, "ASSISTANT_DONE");
  assert.equal(events[2].content, "Respuesta OpenClaw sobre DNS.");
  assert.equal(events[2].audit?.modelId, "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  assert.equal(events[2].audit?.inputTokens, 12);
  assert.equal(events[2].audit?.outputTokens, 8);
  assert.equal(events[2].audit?.tokensUsed, 20);
});

test("OpenClawBedrockBridge keeps in-memory conversation history across turns", async () => {
  const payloads: Array<Record<string, unknown>> = [];
  const bridge = new OpenClawBedrockBridge({
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
    modelId: "model-test",
    systemPromptPath: await promptFile("System prompt demo"),
    now: fixedNow(),
    fetchImpl: liveContextFetchStub(),
    client: {
      send: async (command) => {
        payloads.push(JSON.parse(String(command.input.body)));
        return {
          body: [
            streamJson({ type: "content_block_delta", delta: { type: "text_delta", text: `respuesta-${payloads.length}` } })
          ]
        };
      }
    }
  });

  await bridge.sendMessage({ msgId: "msg-1", message: "primer turno" });
  await bridge.streamHistory("msg-1", {});
  await bridge.sendMessage({ msgId: "msg-2", message: "segundo turno" });
  await bridge.streamHistory("msg-2", {});

  const secondMessages = payloads[1].messages as Array<{ role: string; content: Array<{ text: string }> }>;
  assert.deepEqual(secondMessages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(secondMessages[0].content[0].text, "primer turno");
  assert.equal(secondMessages[1].content[0].text, "respuesta-1");
  assert.equal(secondMessages[2].content[0].text, "segundo turno");
});

test("OpenClawBedrockBridge falls back to OPENCLAW_SYSTEM_PROMPT path when bundle is missing", async () => {
  const fallbackPath = await promptFile("Fallback system prompt");
  let payload: Record<string, unknown> | null = null;
  const bridge = new OpenClawBedrockBridge({
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
    modelId: "model-test",
    systemPromptPath: join(tmpdir(), "missing-system-context.txt"),
    fallbackSystemPromptPath: fallbackPath,
    now: fixedNow(),
    fetchImpl: liveContextFetchStub(),
    client: {
      send: async (command) => {
        payload = JSON.parse(String(command.input.body));
        return { body: [streamJson({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } })] };
      }
    }
  });

  await bridge.sendMessage({ msgId: "msg-1", message: "hola" });
  await bridge.streamHistory("msg-1", {});

  assert.ok(payload);
  assert.match(String((payload as Record<string, unknown>).system), /^Fallback system prompt/);
  assert.match(String((payload as Record<string, unknown>).system), /<live_context generatedAt="2026-05-29T05:00:00.000Z">/);
});

test("OpenClawBedrockBridge injects read-only live context and tolerates endpoint failures", async () => {
  const requestedPaths: string[] = [];
  const seenTokens: string[] = [];
  let payload: Record<string, unknown> | null = null;
  const bridge = new OpenClawBedrockBridge({
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
    modelId: "model-test",
    systemPromptPath: await promptFile("System prompt demo"),
    now: fixedNow(),
    delivrixBaseUrl: "http://gateway.test/",
    readBoundaryToken: "read-token",
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      requestedPaths.push(`${url.pathname}${url.search}`);
      const headers = init?.headers as Record<string, string> | undefined;
      seenTokens.push(headers?.["x-delivrix-token"] ?? "");
      if (url.pathname === "/v1/canvas/live/state") {
        throw new Error("canvas timeout");
      }
      const bodyByPath: Record<string, unknown> = {
        "/v1/admin/overview": { service: "gateway-api", secret: "should-redact" },
        "/v1/kill-switch": { enabled: false, updatedBy: "operator_local" },
        "/v1/audit-events": [{ action: "oc.chat.test", token: "should-redact" }]
      };
      return {
        ok: true,
        status: 200,
        json: async () => bodyByPath[url.pathname] ?? {}
      } as Response;
    }) as typeof fetch,
    client: {
      send: async (command) => {
        payload = JSON.parse(String(command.input.body));
        return { body: [streamJson({ type: "content_block_delta", delta: { type: "text_delta", text: "ok" } })] };
      }
    }
  });

  await bridge.sendMessage({ msgId: "msg-1", message: "estado" });
  await bridge.streamHistory("msg-1", {});

  assert.deepEqual(requestedPaths.sort(), [
    "/v1/admin/overview",
    "/v1/audit-events?limit=10",
    "/v1/canvas/live/state",
    "/v1/kill-switch"
  ].sort());
  assert.deepEqual(new Set(seenTokens), new Set(["read-token"]));
  const capturedPayload = payload as Record<string, unknown> | null;
  assert.ok(capturedPayload);
  const system = String(capturedPayload.system);
  assert.match(system, /<live_context generatedAt="2026-05-29T05:00:00.000Z">/);
  assert.match(system, /## kill_switch \(GET \/v1\/kill-switch\)/);
  assert.match(system, /"enabled": false/);
  assert.match(system, /"_error": "canvas timeout"/);
  assert.match(system, /"secret": "\[redacted\]"/);
  assert.match(system, /"token": "\[redacted\]"/);
});

test("createOpenClawBedrockBridgeFromEnv requires bedrock mode and critical env vars", () => {
  assert.equal(createOpenClawBedrockBridgeFromEnv({ OPENCLAW_BRIDGE_KIND: "ssh" }), null);
  assert.equal(createOpenClawBedrockBridgeFromEnv({ OPENCLAW_BRIDGE_KIND: "bedrock" }), null);
  assert.ok(createOpenClawBedrockBridgeFromEnv({
    OPENCLAW_BRIDGE_KIND: "bedrock",
    AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key",
    AWS_BEDROCK_MODEL_ID: "model-test",
    AWS_BEDROCK_REGION: "us-east-1"
  }));
  assert.ok(createOpenClawBedrockBridgeFromEnv({
    OPENCLAW_BRIDGE_KIND: "bedrock",
    AWS_BEDROCK_ACCESS_KEY_ID: "access",
    AWS_BEDROCK_SECRET_ACCESS_KEY: "secret",
    AWS_BEDROCK_MODEL_ID: "model-test",
    AWS_BEDROCK_REGION: "us-east-1"
  }));
});

async function promptFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openclaw-bedrock-"));
  const file = join(dir, "prompt.md");
  await writeFile(file, content, "utf8");
  return file;
}

function streamJson(value: unknown): { chunk: { bytes: Uint8Array } } {
  return { chunk: { bytes: new TextEncoder().encode(JSON.stringify(value)) } };
}

function fixedNow(): () => Date {
  return () => new Date("2026-05-29T05:00:00.000Z");
}

function liveContextFetchStub(): typeof fetch {
  return (async (input) => {
    const path = new URL(String(input)).pathname;
    return {
      ok: true,
      status: 200,
      json: async () => ({ path })
    } as Response;
  }) as typeof fetch;
}

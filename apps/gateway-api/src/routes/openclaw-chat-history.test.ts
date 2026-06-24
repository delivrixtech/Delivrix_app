import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  handleOpenClawChatConversationsHttp,
  handleOpenClawChatHistoryHttp
} from "./openclaw-chat-history.ts";
import { OpenClawChatHistoryStore } from "../services/openclaw-chat-history-store.ts";

test("OpenClaw chat history routes require read token and return isolated history", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-chat-route-"));
  const store = new OpenClawChatHistoryStore({ stateDir });
  await store.appendTurn("conv-a", { role: "user", content: "hola a", msgId: "a-1", createdAt: "2026-06-19T12:00:00.000Z" });
  await store.appendTurn("conv-b", { role: "user", content: "hola b", msgId: "b-1", createdAt: "2026-06-19T12:05:00.000Z" });
  await store.appendTurn("conv-a", { role: "assistant", content: "respuesta a", msgId: "a-1", createdAt: "2026-06-19T12:10:00.000Z" });

  const denied = await invokeConversations(store, {});
  assert.equal(denied.statusCode, 401);

  const listed = await invokeConversations(store, { authorization: "Bearer read-token" });
  assert.equal(listed.statusCode, 200);
  const listBody = listed.body as { conversations: Array<{ id: string; preview: string }> };
  assert.deepEqual(listBody.conversations.map((entry) => entry.id), ["conv-a", "conv-b"]);
  assert.equal(listBody.conversations[0].preview, "respuesta a");

  const history = await invokeHistory(store, "/v1/openclaw/chat/history?conversationId=conv-b", { "x-delivrix-token": "read-token" });
  assert.equal(history.statusCode, 200);
  const historyBody = history.body as { id: string; turns: Array<{ content: string }> };
  assert.equal(historyBody.id, "conv-b");
  assert.deepEqual(historyBody.turns.map((turn) => turn.content), ["hola b"]);

  const invalid = await invokeHistory(store, "/v1/openclaw/chat/history?conversationId=../bad", { "x-delivrix-token": "read-token" });
  assert.equal(invalid.statusCode, 422);

  const queryToken = await invokeHistory(store, "/v1/openclaw/chat/history?conversationId=conv-a&token=read-token", {});
  assert.equal(queryToken.statusCode, 401);
});

test("OpenClaw chat history routes redact secrets from summaries and turns", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaw-chat-route-redact-"));
  const store = new OpenClawChatHistoryStore({ stateDir });
  const sensitive = [
    "Authorization: Bearer bearer.secret",
    "password=hunter2",
    "api_key=api-secret",
    "approval token is approval-secret",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDsecretbody",
    "-----END PRIVATE KEY-----"
  ].join("\n");
  await store.appendTurn("conv-secret", {
    role: "user",
    content: sensitive,
    msgId: "secret-1",
    createdAt: "2026-06-19T12:00:00.000Z"
  });
  await store.appendTurn("conv-secret", {
    role: "assistant",
    content: `recibido ${sensitive}`,
    msgId: "secret-1",
    createdAt: "2026-06-19T12:01:00.000Z"
  });

  const listed = await invokeConversations(store, { "x-delivrix-token": "read-token" });
  assert.equal(listed.statusCode, 200);
  const history = await invokeHistory(store, "/v1/openclaw/chat/history?conversationId=conv-secret", {
    authorization: "Bearer read-token"
  });
  assert.equal(history.statusCode, 200);

  for (const surface of [JSON.stringify(listed.body), JSON.stringify(history.body)]) {
    assert.doesNotMatch(surface, /bearer\.secret/);
    assert.doesNotMatch(surface, /hunter2/);
    assert.doesNotMatch(surface, /api-secret/);
    assert.doesNotMatch(surface, /approval-secret/);
    assert.doesNotMatch(surface, /iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB/);
    assert.doesNotMatch(surface, /BEGIN PRIVATE KEY|END PRIVATE KEY|secretbody/);
    assert.match(surface, /\[REDACTED/);
  }
});

async function invokeConversations(
  store: OpenClawChatHistoryStore,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: unknown }> {
  const response = responseRecorder();
  await handleOpenClawChatConversationsHttp({
    request: requestStub("/v1/openclaw/chat/conversations", headers),
    response: response as unknown as ServerResponse,
    store,
    readBoundaryToken: "read-token"
  });
  return response.result();
}

async function invokeHistory(
  store: OpenClawChatHistoryStore,
  url: string,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: unknown }> {
  const response = responseRecorder();
  await handleOpenClawChatHistoryHttp({
    request: requestStub(url, headers),
    response: response as unknown as ServerResponse,
    store,
    readBoundaryToken: "read-token"
  });
  return response.result();
}

function requestStub(url: string, headers: Record<string, string>): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

function responseRecorder(): {
  writeHead: (statusCode: number, headers?: Record<string, string>) => void;
  end: (chunk?: string) => void;
  result: () => { statusCode: number; body: unknown };
} {
  let statusCode = 0;
  let rawBody = "";
  return {
    writeHead(status) {
      statusCode = status;
    },
    end(chunk) {
      rawBody = chunk ?? "";
    },
    result() {
      return {
        statusCode,
        body: rawBody ? JSON.parse(rawBody) : null
      };
    }
  };
}

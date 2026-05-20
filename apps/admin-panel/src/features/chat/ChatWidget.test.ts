import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { ChatClientLike, ChatState } from "../../shared/api/chat-client.ts";

type ChatModule = {
  ChatWidget: ComponentType<{
    open: boolean;
    onClose: () => void;
    client?: ChatClientLike;
  }>;
};

type ChatClientModule = {
  reduceChatState: (state: ChatState, event: unknown, now?: Date) => ChatState;
};

type UiModule = {
  TooltipProvider: ComponentType<{ children: React.ReactNode }>;
};

let server: ViteDevServer | null = null;

async function loadChatModule() {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });

  return server.ssrLoadModule("/src/features/chat/ChatWidget.tsx") as Promise<ChatModule>;
}

async function loadChatClientModule() {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });

  return server.ssrLoadModule("/src/shared/api/chat-client.ts") as Promise<ChatClientModule>;
}

async function loadUiModule() {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });

  return server.ssrLoadModule("/src/shared/ui/index.ts") as Promise<UiModule>;
}

after(async () => {
  await server?.close();
});

test("ChatWidget renders nothing when closed and full drawer when open", async () => {
  const { ChatWidget } = await loadChatModule();
  const { TooltipProvider } = await loadUiModule();
  const client = fakeClient({
    messages: [],
    streaming: null,
    connection: "offline",
    lastError: null,
    queuedCount: 0
  });

  const closed = renderToStaticMarkup(wrapWithTooltipProvider(TooltipProvider, React.createElement(ChatWidget, {
    open: false,
    onClose: () => undefined,
    client
  })));
  assert.equal(closed, "");

  const open = renderToStaticMarkup(wrapWithTooltipProvider(TooltipProvider, React.createElement(ChatWidget, {
    open: true,
    onClose: () => undefined,
    client
  })));
  assert.match(open, /Chat con OpenClaw/);
  assert.match(open, /Agente offline/);
  assert.match(open, /Sin mensajes en esta sesión/);
  assert.match(open, /sessionKey: agent:main:operator/);
});

test("ChatWidget renders messages and streaming state", async () => {
  const { ChatWidget } = await loadChatModule();
  const { TooltipProvider } = await loadUiModule();
  const client = fakeClient({
    connection: "connected",
    lastError: null,
    queuedCount: 1,
    streaming: {
      msgId: "assistant-2",
      deltaSoFar: "Analizando gates"
    },
    messages: [
      {
        msgId: "user-1",
        role: "user",
        content: "¿qué gates tiene el MVP?",
        timestamp: "2026-05-20T15:30:00.000Z",
        status: "pending"
      },
      {
        msgId: "assistant-1",
        role: "assistant",
        content: "Los gates no negociables vienen del norte operativo.",
        timestamp: "2026-05-20T15:31:00.000Z",
        status: "sent"
      }
    ]
  });

  const markup = renderToStaticMarkup(wrapWithTooltipProvider(TooltipProvider, React.createElement(ChatWidget, {
    open: true,
    onClose: () => undefined,
    client
  })));

  assert.match(markup, /Conectado · 1 en cola/);
  assert.match(markup, /¿qué gates tiene el MVP\?/);
  assert.match(markup, /Pendiente/);
  assert.match(markup, /Los gates no negociables/);
  assert.match(markup, /Analizando gates/);
  assert.match(markup, /escribiendo/);
});

test("chat reducer accumulates deltas and finalizes assistant response", async () => {
  const { reduceChatState } = await loadChatClientModule();
  const base: ChatState = {
    messages: [],
    streaming: null,
    connection: "reconnecting",
    lastError: "offline",
    queuedCount: 0
  };

  const withDelta = reduceChatState(base, {
    type: "ASSISTANT_DELTA",
    msgId: "m1",
    delta: "Hola"
  });
  const withSecondDelta = reduceChatState(withDelta, {
    type: "ASSISTANT_DELTA",
    msgId: "m1",
    delta: " operador"
  });
  const done = reduceChatState(withSecondDelta, {
    type: "ASSISTANT_DONE",
    msgId: "m1",
    content: "Hola operador"
  }, new Date("2026-05-20T16:00:00.000Z"));

  assert.deepEqual(withSecondDelta.streaming, {
    msgId: "m1",
    deltaSoFar: "Hola operador"
  });
  assert.equal(done.streaming, null);
  assert.equal(done.connection, "connected");
  assert.equal(done.messages.length, 1);
  assert.equal(done.messages[0].role, "assistant");
  assert.equal(done.messages[0].content, "Hola operador");
});

function fakeClient(state: ChatState): ChatClientLike {
  return {
    connect: () => undefined,
    disconnect: () => undefined,
    sendMessage: async () => undefined,
    getSnapshot: () => state,
    subscribe: () => () => undefined
  };
}

function wrapWithTooltipProvider(TooltipProvider: UiModule["TooltipProvider"], child: React.ReactElement) {
  return React.createElement(TooltipProvider, null, child);
}

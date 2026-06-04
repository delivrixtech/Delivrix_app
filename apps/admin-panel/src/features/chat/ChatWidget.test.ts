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
  ChatClient: new (options?: Record<string, unknown>) => ChatClientLike;
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
    queuedCount: 0,
    interrupting: false
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
    interrupting: false,
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
    queuedCount: 0,
    interrupting: false
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

test("chat reducer renders typing and blocked events instead of blank bubbles", async () => {
  const { reduceChatState } = await loadChatClientModule();
  const base: ChatState = {
    messages: [],
    streaming: null,
    connection: "reconnecting",
    lastError: null,
    queuedCount: 0,
    interrupting: false
  };

  const typing = reduceChatState(base, {
    type: "ASSISTANT_TYPING",
    msgId: "m2"
  });
  const blocked = reduceChatState(typing, {
    type: "ASSISTANT_BLOCKED",
    msgId: "m2",
    reason: "ssh_history_timeout"
  }, new Date("2026-05-20T16:05:00.000Z"));

  assert.deepEqual(typing.streaming, {
    msgId: "m2",
    deltaSoFar: ""
  });
  assert.equal(blocked.streaming, null);
  assert.equal(blocked.messages.length, 1);
  assert.equal(blocked.messages[0].role, "assistant");
  assert.equal(blocked.messages[0].status, "failed");
  assert.match(blocked.messages[0].content, /ssh_history_timeout/);
});

test("chat reducer clears streaming when operator interrupts OpenClaw", async () => {
  const { reduceChatState } = await loadChatClientModule();
  const base: ChatState = {
    messages: [],
    streaming: {
      msgId: "m-stop",
      deltaSoFar: "Configurando"
    },
    connection: "connected",
    lastError: null,
    queuedCount: 0,
    interrupting: true
  };

  const interrupted = reduceChatState(base, {
    type: "ASSISTANT_INTERRUPTED",
    msgId: "m-stop",
    reason: "operator_interrupt",
    ts: "2026-05-20T16:06:00.000Z"
  }, new Date("2026-05-20T16:06:00.000Z"));

  assert.equal(interrupted.streaming, null);
  assert.equal(interrupted.interrupting, false);
  assert.equal(interrupted.messages.length, 1);
  assert.equal(interrupted.messages[0].content, "Interrumpido por el operador.");
});

test("chat client marks a rejected send as failed and clears the queue", async () => {
  const { ChatClient } = await loadChatClientModule();
  const client = new ChatClient({
    initialState: {
      connection: "connected",
      messages: [],
      streaming: null,
      lastError: null,
      queuedCount: 0,
      interrupting: false
    },
    fetchImpl: async () => new Response(JSON.stringify({
      message: "SSH command failed with exit 1."
    }), {
      status: 502,
      headers: { "content-type": "application/json" }
    }),
    webSocketCtor: undefined,
    idFactory: () => "failed-send-1",
    now: () => new Date("2026-05-20T16:10:00.000Z")
  });

  await client.sendMessage("continua");

  const state = client.getSnapshot();
  assert.equal(state.queuedCount, 0);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].status, "failed");
  assert.equal(state.lastError, "SSH command failed with exit 1.");
});

test("chat client applies assistant content returned by chat.send ack", async () => {
  const { ChatClient } = await loadChatClientModule();
  const client = new ChatClient({
    initialState: {
      connection: "connected",
      messages: [],
      streaming: null,
      lastError: null,
      queuedCount: 0,
      interrupting: false
    },
    fetchImpl: async () => new Response(JSON.stringify({
      msgId: "domain-send-1",
      queued: true,
      assistant: {
        content: "Encontré 16 dominios registrados en IONOS.",
        source: "delivrix.domain_inventory",
        skillsInvoked: ["delivrix.domain_inventory"],
        durationMs: 42
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }),
    webSocketCtor: undefined,
    idFactory: () => "domain-send-1",
    now: () => new Date("2026-05-20T16:15:00.000Z")
  });

  await client.sendMessage("enlistame los dominios de IONOS");

  const state = client.getSnapshot();
  assert.equal(state.queuedCount, 0);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0].role, "user");
  assert.equal(state.messages[0].status, "sent");
  assert.equal(state.messages[1].role, "assistant");
  assert.equal(state.messages[1].content, "Encontré 16 dominios registrados en IONOS.");
  assert.equal(state.lastError, null);
});

test("chat client sends operator params as metadata while keeping local message clean", async () => {
  const { ChatClient } = await loadChatClientModule();
  const calls: unknown[] = [];
  const client = new ChatClient({
    initialState: {
      connection: "connected",
      messages: [],
      streaming: null,
      lastError: null,
      queuedCount: 0,
      interrupting: false
    },
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({
        msgId: "params-send-1",
        queued: true
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    webSocketCtor: undefined,
    idFactory: () => "params-send-1",
    now: () => new Date("2026-06-04T13:10:00.000Z")
  });

  await client.sendMessage("vamos a continuar corriendo el proyecto", {
    operatorParams: {
      mode: "chat",
      skillHint: "auto",
      executionScope: "read_only",
      timeBudgetMinutes: 30,
      approvalContract: "1 firma operador"
    }
  });

  assert.deepEqual(calls, [{
    msgId: "params-send-1",
    message: "vamos a continuar corriendo el proyecto",
    operatorParams: {
      mode: "chat",
      skillHint: "auto",
      executionScope: "read_only",
      timeBudgetMinutes: 30,
      approvalContract: "1 firma operador"
    }
  }]);
  const state = client.getSnapshot();
  assert.equal(state.messages[0].content, "vamos a continuar corriendo el proyecto");
});

test("chat client posts interrupt for the active streaming message", async () => {
  const { ChatClient } = await loadChatClientModule();
  const calls: Array<{ url: string; body: unknown }> = [];
  const client = new ChatClient({
    initialState: {
      connection: "connected",
      messages: [],
      streaming: {
        msgId: "interrupt-1",
        deltaSoFar: "ejecutando"
      },
      lastError: null,
      queuedCount: 0,
      interrupting: false
    },
    interruptUrl: "/v1/openclaw/chat/interrupt",
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ msgId: "interrupt-1", interrupted: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    webSocketCtor: undefined,
    now: () => new Date("2026-05-20T16:20:00.000Z")
  });

  const interrupted = await client.interruptActive();

  const state = client.getSnapshot();
  assert.equal(interrupted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/v1/openclaw/chat/interrupt");
  assert.deepEqual(calls[0].body, { msgId: "interrupt-1" });
  assert.equal(state.streaming, null);
  assert.equal(state.interrupting, false);
  assert.equal(state.messages.at(-1)?.content, "Interrumpido por el operador.");
});

function fakeClient(state: ChatState): ChatClientLike {
  return {
    connect: () => undefined,
    disconnect: () => undefined,
    sendMessage: async () => undefined,
    interruptActive: async () => false,
    getSnapshot: () => state,
    subscribe: () => () => undefined
  };
}

function wrapWithTooltipProvider(TooltipProvider: UiModule["TooltipProvider"], child: React.ReactElement) {
  return React.createElement(TooltipProvider, null, child);
}

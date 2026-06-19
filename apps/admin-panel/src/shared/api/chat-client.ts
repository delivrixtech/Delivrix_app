import { useSyncExternalStore } from "react";

export type ChatConnection = "connected" | "reconnecting" | "offline";
export type ChatRole = "user" | "assistant";
export type ChatMessageStatus = "sent" | "pending" | "failed";

export interface ChatMessage {
  msgId: string;
  role: ChatRole;
  content: string;
  timestamp: string;
  status: ChatMessageStatus;
}

export interface ChatOperatorParams {
  mode?: string;
  skillHint?: string;
  executionScope?: string;
  timeBudgetMinutes?: number;
  approvalContract?: string;
}

export interface ChatSendOptions {
  operatorParams?: ChatOperatorParams;
}

export interface ChatStreamingState {
  msgId: string;
  deltaSoFar: string;
}

export interface ChatState {
  messages: ChatMessage[];
  streaming: ChatStreamingState | null;
  connection: ChatConnection;
  lastError: string | null;
  queuedCount: number;
  interrupting: boolean;
}

export type ChatStreamEvent =
  | { type: "HEARTBEAT"; at: string }
  | { type: "ASSISTANT_TYPING"; msgId: string; ts?: string }
  | { type: "ASSISTANT_DELTA"; msgId: string; delta: string }
  | {
      type: "ASSISTANT_DONE";
      msgId: string;
      content: string;
      audit?: { skillsInvoked: string[]; tokensUsed?: number; durationMs?: number };
      proposals?: unknown[];
    }
  | { type: "ASSISTANT_BLOCKED"; msgId: string; reason: string }
  | { type: "ASSISTANT_INTERRUPTED"; msgId: string; reason?: string; ts?: string }
  | { type: "ERROR"; msgId?: string; error: string }
  | { type: "AGENT_OFFLINE" };

export interface ChatClientLike {
  connect(): void;
  disconnect(): void;
  sendMessage(content: string, options?: ChatSendOptions): Promise<void>;
  interruptActive(): Promise<boolean>;
  getSnapshot(): ChatState;
  subscribe(listener: () => void): () => void;
}

interface QueuedMessage {
  msgId: string;
  content: string;
  operatorParams?: ChatOperatorParams;
}

interface ChatClientOptions {
  fetchImpl?: typeof fetch;
  webSocketCtor?: typeof WebSocket;
  streamUrl?: string;
  sendUrl?: string;
  interruptUrl?: string;
  now?: () => Date;
  idFactory?: () => string;
  reconnectDelay?: (attempt: number) => number;
  initialState?: Partial<ChatState>;
}

interface ChatSendAck {
  msgId?: string;
  queued?: boolean;
  assistant?: {
    content?: string;
    source?: string;
    skillsInvoked?: string[];
    durationMs?: number;
  };
}

const initialState: ChatState = {
  messages: [],
  streaming: null,
  connection: "offline",
  lastError: null,
  queuedCount: 0,
  interrupting: false
};

export class ChatClient implements ChatClientLike {
  private state: ChatState;
  private readonly listeners = new Set<() => void>();
  private readonly queue: QueuedMessage[] = [];
  private readonly inFlight = new Set<string>();
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private closedByClient = false;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketCtor: typeof WebSocket | undefined;
  private readonly sendUrl: string;
  private readonly interruptUrl: string;
  private readonly streamUrl: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly reconnectDelay: (attempt: number) => number;

  constructor(options: ChatClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.webSocketCtor = options.webSocketCtor ?? globalThis.WebSocket;
    this.sendUrl = options.sendUrl ?? "/v1/openclaw/chat/send";
    this.interruptUrl = options.interruptUrl ?? "/v1/openclaw/chat/interrupt";
    this.streamUrl = options.streamUrl ?? resolveChatStreamUrl();
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? createMessageId;
    this.reconnectDelay = options.reconnectDelay ?? chatReconnectDelayMs;
    this.state = {
      ...initialState,
      ...options.initialState,
      messages: options.initialState?.messages ?? []
    };
    this.syncQueuedCount();
  }

  connect(): void {
    if (this.socket || this.reconnectTimer !== null || !this.webSocketCtor) {
      return;
    }

    this.closedByClient = false;
    this.setState({ connection: "reconnecting" });
    const socket = new this.webSocketCtor(this.streamUrl);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setState({ connection: "connected", lastError: null });
      void this.flushQueue();
    });

    socket.addEventListener("message", (message) => {
      const event = parseStreamEvent(message.data);
      if (!event) return;
      this.applyStreamEvent(event);
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      if (!this.closedByClient) {
        this.scheduleReconnect();
      }
    });

    socket.addEventListener("error", () => {
      this.socket = null;
      this.setState({ connection: "reconnecting", lastError: "Conexión de chat interrumpida." });
      if (!this.closedByClient) {
        this.scheduleReconnect();
      }
    });
  }

  disconnect(): void {
    this.closedByClient = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setState({ connection: "offline" });
  }

  async sendMessage(content: string, options: ChatSendOptions = {}): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    const msgId = this.idFactory();
    this.queue.push({
      msgId,
      content: trimmed,
      ...(options.operatorParams ? { operatorParams: options.operatorParams } : {})
    });
    this.state = addOrUpdateMessage(this.state, {
      msgId,
      role: "user",
      content: trimmed,
      timestamp: this.now().toISOString(),
      status: this.state.connection === "connected" ? "sent" : "pending"
    });
    this.syncQueuedCount();
    this.emit();

    if (this.state.connection !== "connected") {
      this.connect();
    }

    if (this.state.connection === "connected") {
      await this.flushQueue();
    }
  }

  async interruptActive(): Promise<boolean> {
    const msgId = this.activeMsgId();
    if (!msgId || this.state.interrupting) {
      return false;
    }

    this.setState({ interrupting: true, lastError: null });
    try {
      const response = await this.fetchImpl(this.interruptUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json"
        },
        body: JSON.stringify({ msgId })
      });
      const payload = await response.json().catch(() => ({})) as Partial<{ message: string; error: string }>;
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : `chat.interrupt failed with ${response.status}`);
      }
      this.removeQueued(msgId);
      this.inFlight.delete(msgId);
      this.applyStreamEvent({
        type: "ASSISTANT_INTERRUPTED",
        msgId,
        reason: "operator_interrupt",
        ts: this.now().toISOString()
      });
      return true;
    } catch (error) {
      this.setState({
        lastError: error instanceof Error ? error.message : "No se pudo interrumpir OpenClaw."
      }, false);
      throw error;
    } finally {
      this.setState({ interrupting: false });
    }
  }

  getSnapshot(): ChatState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  applyStreamEvent(event: ChatStreamEvent): void {
    this.state = reduceChatState(this.state, event, this.now());
    this.emit();

    if (event.type === "HEARTBEAT") {
      void this.flushQueue();
    }
  }

  private async flushQueue(): Promise<void> {
    if (this.state.connection !== "connected") {
      return;
    }

    for (const item of [...this.queue]) {
      if (this.inFlight.has(item.msgId)) {
        continue;
      }

      this.inFlight.add(item.msgId);
      try {
        const response = await this.fetchImpl(this.sendUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json"
          },
          body: JSON.stringify({
            msgId: item.msgId,
            message: item.content,
            ...(item.operatorParams ? { operatorParams: item.operatorParams } : {})
          })
        });

        const payload = await response.json().catch(() => ({})) as ChatSendAck & Partial<{ message: string }>;

        if (!response.ok) {
          const message = typeof payload.message === "string"
            ? payload.message
            : `chat.send failed with ${response.status}`;
          throw new Error(message);
        }

        this.removeQueued(item.msgId);
        this.state = updateMessageStatus(this.state, item.msgId, "sent");
        if (payload.assistant?.content) {
          this.applyStreamEvent({
            type: "ASSISTANT_DONE",
            msgId: typeof payload.msgId === "string" ? payload.msgId : item.msgId,
            content: payload.assistant.content,
            audit: {
              skillsInvoked: payload.assistant.skillsInvoked ?? [],
              ...(typeof payload.assistant.durationMs === "number"
                ? { durationMs: payload.assistant.durationMs }
                : {})
            }
          });
        }
      } catch (error) {
        this.removeQueued(item.msgId);
        this.state = updateMessageStatus(this.state, item.msgId, "failed");
        this.setState({
          lastError: error instanceof Error ? error.message : "No se pudo enviar el mensaje."
        }, false);
        break;
      } finally {
        this.inFlight.delete(item.msgId);
        this.syncQueuedCount();
        this.emit();
      }
    }
  }

  private removeQueued(msgId: string): void {
    const index = this.queue.findIndex((item) => item.msgId === msgId);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private activeMsgId(): string | null {
    if (this.state.streaming?.msgId) {
      return this.state.streaming.msgId;
    }
    const inFlight = [...this.inFlight].at(-1);
    if (inFlight) {
      return inFlight;
    }
    return this.queue.at(0)?.msgId ?? null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }

    this.reconnectAttempt += 1;
    this.setState({ connection: "reconnecting" });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay(this.reconnectAttempt));
  }

  private setState(next: Partial<ChatState>, emit = true): void {
    this.state = { ...this.state, ...next };
    this.syncQueuedCount();
    if (emit) {
      this.emit();
    }
  }

  private syncQueuedCount(): void {
    this.state = {
      ...this.state,
      queuedCount: this.queue.length
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/* ============================================================
 * Persistencia local del historial (parche frontend).
 * Sobrevive recargas del panel. La persistencia server-side real
 * (disco + GET /chat/history + sessionKey por chat) la hace el gateway.
 * Guardado bajo typeof guards → no corre en tests/SSR.
 * ============================================================ */
const CHAT_HISTORY_KEY = "delivrix.chat.history.v1";
const CHAT_HISTORY_MAX = 100;

function loadPersistedChatMessages(): ChatMessage[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: ChatMessage[] = [];
    for (const item of parsed) {
      if (
        item && typeof item === "object"
        && typeof (item as ChatMessage).msgId === "string"
        && ((item as ChatMessage).role === "user" || (item as ChatMessage).role === "assistant")
        && typeof (item as ChatMessage).content === "string"
        && typeof (item as ChatMessage).timestamp === "string"
      ) {
        const m = item as ChatMessage;
        valid.push({ msgId: m.msgId, role: m.role, content: m.content, timestamp: m.timestamp, status: "sent" });
      }
    }
    return valid.slice(-CHAT_HISTORY_MAX);
  } catch {
    return [];
  }
}

function persistChatMessages(messages: ChatMessage[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(messages.slice(-CHAT_HISTORY_MAX)));
  } catch {
    /* quota o storage deshabilitado: ignorar */
  }
}

export const chatClient = new ChatClient({ initialState: { messages: loadPersistedChatMessages() } });

if (typeof window !== "undefined") {
  let lastMessagesRef: ChatMessage[] | null = null;
  chatClient.subscribe(() => {
    const messages = chatClient.getSnapshot().messages;
    if (messages === lastMessagesRef) return;
    lastMessagesRef = messages;
    persistChatMessages(messages);
  });
}

export function useChatStream(client: ChatClientLike = chatClient): ChatState {
  return useSyncExternalStore(
    client.subscribe.bind(client),
    client.getSnapshot.bind(client),
    client.getSnapshot.bind(client)
  );
}

export function reduceChatState(state: ChatState, event: ChatStreamEvent, now = new Date()): ChatState {
  if (event.type === "HEARTBEAT") {
    return { ...state, connection: "connected", lastError: null };
  }

  if (event.type === "AGENT_OFFLINE") {
    return { ...state, connection: "offline", lastError: "OpenClaw no está disponible." };
  }

  if (event.type === "ERROR") {
    return {
      ...state,
      streaming: event.msgId && state.streaming?.msgId === event.msgId ? null : state.streaming,
      lastError: event.error
    };
  }

  if (event.type === "ASSISTANT_TYPING") {
    return {
      ...state,
      connection: "connected",
      streaming: {
        msgId: event.msgId,
        deltaSoFar: state.streaming?.msgId === event.msgId ? state.streaming.deltaSoFar : ""
      },
      lastError: null
    };
  }

  if (event.type === "ASSISTANT_BLOCKED") {
    return addOrUpdateMessage({
      ...state,
      connection: "connected",
      streaming: state.streaming?.msgId === event.msgId ? null : state.streaming,
      lastError: `OpenClaw no pudo completar la respuesta: ${event.reason}`
    }, {
      msgId: event.msgId,
      role: "assistant",
      content: `No pude completar la respuesta (${event.reason}). Revisa el bridge SSH o vuelve a enviar el mensaje.`,
      timestamp: now.toISOString(),
      status: "failed"
    });
  }

  if (event.type === "ASSISTANT_INTERRUPTED") {
    return addOrUpdateMessage({
      ...state,
      connection: "connected",
      streaming: state.streaming?.msgId === event.msgId ? null : state.streaming,
      lastError: null,
      interrupting: false
    }, {
      msgId: event.msgId,
      role: "assistant",
      content: "Interrumpido por el operador.",
      timestamp: event.ts ?? now.toISOString(),
      status: "sent"
    });
  }

  if (event.type === "ASSISTANT_DELTA") {
    const current = state.streaming?.msgId === event.msgId ? state.streaming.deltaSoFar : "";
    return {
      ...state,
      connection: "connected",
      streaming: {
        msgId: event.msgId,
        deltaSoFar: current + event.delta
      },
      lastError: null
    };
  }

  return addOrUpdateMessage({
    ...state,
    connection: "connected",
    streaming: state.streaming?.msgId === event.msgId ? null : state.streaming,
    lastError: null
  }, {
    msgId: event.msgId,
    role: "assistant",
    content: event.content,
    timestamp: now.toISOString(),
    status: "sent"
  });
}

export function chatReconnectDelayMs(attempt: number): number {
  if (attempt <= 1) return 1_000;
  if (attempt === 2) return 2_000;
  if (attempt === 3) return 4_000;
  if (attempt === 4) return 8_000;
  return 30_000;
}

function addOrUpdateMessage(state: ChatState, message: ChatMessage): ChatState {
  const existing = state.messages.findIndex((item) => item.msgId === message.msgId && item.role === message.role);
  if (existing < 0) {
    return { ...state, messages: [...state.messages, message] };
  }

  const messages = [...state.messages];
  messages[existing] = message;
  return { ...state, messages };
}

function updateMessageStatus(state: ChatState, msgId: string, status: ChatMessageStatus): ChatState {
  return {
    ...state,
    messages: state.messages.map((message) => (
      message.msgId === msgId && message.role === "user"
        ? { ...message, status }
        : message
    ))
  };
}

function resolveChatStreamUrl(): string {
  if (typeof window === "undefined") {
    return "ws://127.0.0.1:5173/v1/openclaw/chat/stream";
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/v1/openclaw/chat/stream`;
}

function parseStreamEvent(raw: unknown): ChatStreamEvent | null {
  if (typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ChatStreamEvent>;
    return typeof parsed.type === "string" ? parsed as ChatStreamEvent : null;
  } catch {
    return null;
  }
}

function createMessageId(): string {
  if (globalThis.crypto && "randomUUID" in globalThis.crypto) {
    return globalThis.crypto.randomUUID();
  }
  return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

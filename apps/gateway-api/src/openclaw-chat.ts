import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { AuditEventInput } from "../../../packages/domain/src/index.ts";

export const OPENCLAW_CHAT_SESSION_KEY = "agent:main:operator";
const defaultAgentHttpUrl = "http://2.24.223.240:61175";
const defaultAgentWsUrl = "ws://2.24.223.240:61175/api/chat.stream";
const gatewayId = "delivrix-gateway-popayan";

export type ChatConnectionState = "connected" | "reconnecting" | "offline";

export type ChatStreamEvent =
  | { type: "HEARTBEAT"; at: string }
  | { type: "ASSISTANT_DELTA"; msgId: string; delta: string }
  | {
      type: "ASSISTANT_DONE";
      msgId: string;
      content: string;
      audit?: { skillsInvoked: string[]; tokensUsed?: number; durationMs?: number };
      proposals?: unknown[];
    }
  | { type: "ERROR"; msgId?: string; error: string }
  | { type: "AGENT_OFFLINE" };

export interface ChatSendRequest {
  message?: unknown;
  msgId?: unknown;
}

export interface ChatSendResponse {
  msgId: string;
  queued: true;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

export interface OpenClawChatPanelClient {
  sendJson(event: ChatStreamEvent): void;
  close(): void;
}

type FetchLike = typeof fetch;
type WebSocketConstructor = new (url: string) => WebSocket;

export interface OpenClawChatConfig {
  agentHttpUrl?: string;
  agentWsUrl?: string;
  gatewayToken?: string;
  readBoundaryToken?: string;
  delivrixBaseUrl?: string;
  sessionKey?: string;
  fetchImpl?: FetchLike;
  webSocketCtor?: WebSocketConstructor;
  now?: () => Date;
  reconnectDelay?: (attempt: number) => number;
}

export class OpenClawChatProxy {
  private readonly clients = new Set<OpenClawChatPanelClient>();
  private readonly agentHttpUrl: string;
  private readonly agentWsUrl: string;
  private readonly gatewayToken: string | undefined;
  private readonly readBoundaryToken: string;
  private readonly delivrixBaseUrl: string;
  private readonly sessionKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly webSocketCtor: WebSocketConstructor | undefined;
  private readonly now: () => Date;
  private readonly reconnectDelay: (attempt: number) => number;
  private agentSocket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private transportDegradedAudited = false;
  private state: ChatConnectionState = "offline";

  constructor(
    private readonly auditLog: AuditSink,
    config: OpenClawChatConfig = {}
  ) {
    this.agentHttpUrl = normalizeBaseUrl(config.agentHttpUrl ?? process.env.OPENCLAW_AGENT_HTTP_URL ?? defaultAgentHttpUrl);
    this.agentWsUrl = config.agentWsUrl ?? process.env.OPENCLAW_AGENT_WS_URL ?? defaultAgentWsUrl;
    this.gatewayToken = config.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN;
    this.readBoundaryToken = config.readBoundaryToken ?? process.env.DELIVRIX_OPENCLAW_TOKEN ?? "";
    this.delivrixBaseUrl = config.delivrixBaseUrl ?? process.env.DELIVRIX_BASE_URL ?? "http://gateway.delivrix.local:3000";
    this.sessionKey = config.sessionKey ?? OPENCLAW_CHAT_SESSION_KEY;
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    this.webSocketCtor = config.webSocketCtor ?? globalThis.WebSocket;
    this.now = config.now ?? (() => new Date());
    this.reconnectDelay = config.reconnectDelay ?? openClawChatReconnectDelayMs;
  }

  get connectionState(): ChatConnectionState {
    return this.state;
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  async sendOperatorMessage(input: ChatSendRequest): Promise<ChatSendResponse> {
    if (typeof input.message !== "string" || !input.message.trim()) {
      throw new ChatProxyError(400, "invalid_message", "message is required.");
    }

    const message = input.message.trim();
    const msgId = typeof input.msgId === "string" && isUuid(input.msgId) ? input.msgId : randomUUID();

    if (!this.gatewayToken) {
      await this.auditOperatorMessage(msgId, message, "reject", "gateway_internal_error");
      throw new ChatProxyError(503, "openclaw_gateway_token_missing", "OPENCLAW_GATEWAY_TOKEN is not configured.");
    }

    const upstreamPayload = {
      sessionKey: this.sessionKey,
      msgId,
      message: { role: "user", content: message },
      context: {
        delivrix_endpoint_token: this.readBoundaryToken,
        delivrix_base_url: this.delivrixBaseUrl
      }
    };

    let upstreamResponse: Response;
    try {
      upstreamResponse = await this.fetchImpl(`${this.agentHttpUrl}/api/chat.send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.gatewayToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(upstreamPayload)
      });
    } catch (error) {
      await this.auditOperatorMessage(msgId, message, "reject", "gateway_timeout");
      throw new ChatProxyError(
        502,
        "openclaw_chat_send_failed",
        error instanceof Error ? error.message : "OpenClaw chat.send failed."
      );
    }

    if (!upstreamResponse.ok) {
      await this.auditOperatorMessage(msgId, message, "reject", "gateway_internal_error", {
        upstreamStatus: upstreamResponse.status
      });
      throw new ChatProxyError(502, "openclaw_chat_send_rejected", `OpenClaw rejected chat.send with ${upstreamResponse.status}.`);
    }

    await this.auditOperatorMessage(msgId, message, "n/a", null);
    return { msgId, queued: true };
  }

  acceptPanelSocket(request: IncomingMessage, socket: Socket, head?: Buffer): void {
    if (!isWebSocketUpgrade(request)) {
      socket.destroy();
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const acceptKey = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      ""
    ].join("\r\n"));

    const client = new RawPanelWebSocketClient(socket, (closedClient) => {
      this.removePanelClient(closedClient);
    });
    this.addPanelClient(client);

    if (head && head.length > 0) {
      socket.unshift(head);
    }
  }

  addPanelClient(client: OpenClawChatPanelClient): void {
    this.clients.add(client);
    if (this.state !== "connected") {
      client.sendJson({ type: "AGENT_OFFLINE" });
    }
    this.ensureAgentConnection();
  }

  removePanelClient(client: OpenClawChatPanelClient): void {
    this.clients.delete(client);
  }

  broadcast(event: ChatStreamEvent): void {
    for (const client of this.clients) {
      try {
        client.sendJson(event);
      } catch {
        this.clients.delete(client);
        client.close();
      }
    }
  }

  async handleAgentMessage(raw: unknown): Promise<ChatStreamEvent | null> {
    const event = normalizeAgentChatEvent(raw);
    if (!event) {
      return null;
    }

    this.broadcast(event);

    if (event.type === "ASSISTANT_DONE") {
      await this.auditAgentResponse(event);
    }

    return event;
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.agentSocket?.close();
    this.agentSocket = null;
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
  }

  private ensureAgentConnection(): void {
    if (this.agentSocket || this.reconnectTimer) {
      return;
    }

    if (!this.gatewayToken || !this.webSocketCtor) {
      this.markAgentOffline();
      return;
    }

    const socket = new this.webSocketCtor(withTokenQuery(this.agentWsUrl, this.gatewayToken));
    this.agentSocket = socket;
    this.state = "reconnecting";

    socket.addEventListener("open", () => {
      this.state = "connected";
      this.reconnectAttempt = 0;
      this.transportDegradedAudited = false;
      this.startHeartbeat();
    });

    socket.addEventListener("message", (message) => {
      const raw = typeof message.data === "string" ? message.data : String(message.data);
      const parsed = parseJson(raw);
      void this.handleAgentMessage(parsed);
      if (isRecord(parsed) && parsed.type === "HELLO") {
        this.sendAgentJson({
          type: "HELLO_ACK",
          gatewayId,
          sessionTokenForReads: this.readBoundaryToken,
          readBoundaryBase: this.delivrixBaseUrl
        });
      }
    });

    socket.addEventListener("close", () => {
      this.agentSocket = null;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      this.agentSocket = null;
      this.stopHeartbeat();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.markAgentOffline();
    if (!this.gatewayToken || this.reconnectTimer) {
      return;
    }

    this.reconnectAttempt += 1;
    if (this.reconnectAttempt >= 5 && !this.transportDegradedAudited) {
      this.transportDegradedAudited = true;
      void this.auditLog.append({
        actorType: "system",
        actorId: "gateway-api",
        action: "oc.transport.degraded",
        targetType: "openclaw_chat_stream",
        targetId: this.sessionKey,
        riskLevel: "medium",
        decision: "n/a",
        metadata: {
          consecutiveFailures: this.reconnectAttempt,
          transport: "gateway_to_openclaw_ws"
        }
      });
    }
    const delayMs = this.reconnectDelay(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureAgentConnection();
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private markAgentOffline(): void {
    if (this.state !== "offline") {
      this.state = "offline";
      this.broadcast({ type: "AGENT_OFFLINE" });
      return;
    }
    this.broadcast({ type: "AGENT_OFFLINE" });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendAgentJson({ type: "HEARTBEAT", ts: this.now().toISOString() });
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendAgentJson(payload: Record<string, unknown>): void {
    if (this.agentSocket?.readyState === WebSocket.OPEN) {
      this.agentSocket.send(JSON.stringify(payload));
    }
  }

  private async auditOperatorMessage(
    msgId: string,
    message: string,
    decision: "n/a" | "reject",
    rejectReason: "gateway_internal_error" | "gateway_timeout" | null,
    extraMetadata: Record<string, unknown> = {}
  ): Promise<void> {
    await this.auditLog.append({
      actorType: "operator",
      actorId: "admin-panel",
      action: "oc.chat.operator_message",
      targetType: "openclaw_chat_session",
      targetId: this.sessionKey,
      riskLevel: rejectReason ? "medium" : "low",
      decision,
      rejectReason,
      metadata: {
        msgId,
        sessionKey: this.sessionKey,
        length: message.length,
        ...extraMetadata
      }
    });
  }

  private async auditAgentResponse(event: Extract<ChatStreamEvent, { type: "ASSISTANT_DONE" }>): Promise<void> {
    await this.auditLog.append({
      actorType: "openclaw",
      actorId: "openclaw-hostinger-prod",
      action: "oc.chat.agent_response",
      targetType: "openclaw_chat_session",
      targetId: this.sessionKey,
      riskLevel: event.proposals && event.proposals.length > 0 ? "medium" : "low",
      decision: "n/a",
      metadata: {
        msgId: event.msgId,
        sessionKey: this.sessionKey,
        contentLength: event.content.length,
        skillsInvoked: event.audit?.skillsInvoked ?? [],
        tokensUsed: event.audit?.tokensUsed ?? null,
        durationMs: event.audit?.durationMs ?? null,
        proposalsCount: event.proposals?.length ?? 0
      }
    });
  }
}

export class ChatProxyError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ChatProxyError";
  }
}

export function normalizeAgentChatEvent(raw: unknown): ChatStreamEvent | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (raw.type === "HEARTBEAT_OK" || raw.type === "HEARTBEAT") {
    return { type: "HEARTBEAT", at: stringValue(raw.ts) ?? stringValue(raw.at) ?? new Date().toISOString() };
  }

  if (raw.type === "ASSISTANT_DELTA") {
    const msgId = stringValue(raw.msgId);
    const delta = stringValue(raw.delta);
    if (!msgId || delta === null) return null;
    return { type: "ASSISTANT_DELTA", msgId, delta };
  }

  if (raw.type === "ASSISTANT_DONE") {
    const msgId = stringValue(raw.msgId);
    if (!msgId) return null;

    const assistant = isRecord(raw.assistant) ? raw.assistant : {};
    const audit = isRecord(assistant.audit) ? assistant.audit : isRecord(raw.audit) ? raw.audit : {};
    const skillsInvoked = stringArray(assistant.skillsInvoked ?? raw.skillsInvoked);
    const tokensUsed = numberValue(audit.tokensUsed) ?? numberValue(audit.tokens_used);
    const durationMs = numberValue(audit.durationMs) ?? numberValue(audit.duration_ms);
    const content = stringValue(assistant.content) ?? stringValue(raw.content) ?? "";
    const proposals = Array.isArray(assistant.proposals) ? assistant.proposals : Array.isArray(raw.proposals) ? raw.proposals : undefined;

    return {
      type: "ASSISTANT_DONE",
      msgId,
      content,
      audit: { skillsInvoked, ...(tokensUsed === undefined ? {} : { tokensUsed }), ...(durationMs === undefined ? {} : { durationMs }) },
      ...(proposals ? { proposals } : {})
    };
  }

  if (raw.type === "ERROR") {
    return {
      type: "ERROR",
      ...(typeof raw.msgId === "string" ? { msgId: raw.msgId } : {}),
      error: stringValue(raw.error) ?? stringValue(raw.message) ?? stringValue(raw.code) ?? "OpenClaw stream error"
    };
  }

  return null;
}

export function openClawChatReconnectDelayMs(attempt: number): number {
  if (attempt <= 1) return 1_000;
  if (attempt === 2) return 2_000;
  if (attempt === 3) return 4_000;
  if (attempt === 4) return 8_000;
  return 30_000;
}

export async function handleChatSendHttp(
  proxy: OpenClawChatProxy,
  body: ChatSendRequest,
  response: ServerResponse
): Promise<void> {
  try {
    const result = await proxy.sendOperatorMessage(body);
    jsonResponse(response, 200, result);
  } catch (error) {
    if (error instanceof ChatProxyError) {
      jsonResponse(response, error.statusCode, {
        error: error.code,
        message: error.message
      });
      return;
    }
    jsonResponse(response, 500, {
      error: "openclaw_chat_send_internal_error",
      message: error instanceof Error ? error.message : "Unknown chat proxy error."
    });
  }
}

class RawPanelWebSocketClient implements OpenClawChatPanelClient {
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly onClose: (client: OpenClawChatPanelClient) => void
  ) {
    socket.on("data", (chunk: Buffer) => {
      if (hasCloseFrame(chunk)) {
        this.close();
      }
    });
    socket.on("close", () => {
      this.closed = true;
      this.onClose(this);
    });
    socket.on("error", () => {
      this.closed = true;
      this.onClose(this);
    });
  }

  sendJson(event: ChatStreamEvent): void {
    if (this.closed) {
      return;
    }
    this.socket.write(encodeWebSocketTextFrame(JSON.stringify(event)));
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.end(encodeWebSocketCloseFrame());
  }
}

function encodeWebSocketTextFrame(text: string): Buffer {
  return encodeWebSocketFrame(0x1, Buffer.from(text, "utf8"));
}

function encodeWebSocketCloseFrame(): Buffer {
  return encodeWebSocketFrame(0x8, Buffer.alloc(0));
}

function encodeWebSocketFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }

  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function hasCloseFrame(chunk: Buffer): boolean {
  return (chunk[0] & 0x0f) === 0x8;
}

function isWebSocketUpgrade(request: IncomingMessage): boolean {
  return request.headers.upgrade?.toLowerCase() === "websocket";
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function withTokenQuery(rawUrl: string, token: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function jsonResponse(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

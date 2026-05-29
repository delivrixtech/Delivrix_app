import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type {
  AuditEventInput,
  CanvasLiveEvent,
  CanvasLiveTaskStatus
} from "../../../packages/domain/src/index.ts";
import {
  extractOpenClawArtifact,
  summarizeOpenClawTaskTitle
} from "./openclaw-artifact-extractor.ts";

export const OPENCLAW_CHAT_SESSION_KEY = "agent:main:operator";
const defaultAgentHttpUrl = "http://2.24.223.240:61175";
const defaultAgentWsUrl = "ws://2.24.223.240:61175/api/chat.stream";
const gatewayId = "delivrix-gateway-popayan";

export type ChatConnectionState = "connected" | "reconnecting" | "offline";

export type ChatStreamEvent =
  | { type: "HEARTBEAT"; at: string }
  | { type: "ASSISTANT_TYPING"; msgId: string; ts?: string }
  | { type: "ASSISTANT_DELTA"; msgId: string; delta: string }
  | {
      type: "ASSISTANT_DONE";
      msgId: string;
      content: string;
      audit?: {
        skillsInvoked: string[];
        tokensUsed?: number;
        inputTokens?: number;
        outputTokens?: number;
        durationMs?: number;
        modelId?: string;
      };
      proposals?: unknown[];
    }
  | { type: "ASSISTANT_BLOCKED"; msgId: string; reason: string }
  | { type: "ERROR"; msgId?: string; error: string }
  | { type: "AGENT_OFFLINE" };

export interface ChatSendRequest {
  message?: unknown;
  text?: unknown;
  actor?: unknown;
  msgId?: unknown;
}

export interface ChatSendResponse {
  msgId: string;
  queued: true;
  assistant?: {
    content: string;
    source: string;
    skillsInvoked?: string[];
    durationMs?: number;
  };
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

interface CanvasLiveEmitter {
  emit(event: CanvasLiveEvent): Promise<unknown>;
}

export interface OpenClawChatPanelClient {
  sendJson(event: ChatStreamEvent): void;
  close(): void;
}

type FetchLike = typeof fetch;
type WebSocketConstructor = new (url: string) => WebSocket;
type ChatBridgeKind = "http" | "ssh" | "bedrock";

export interface OpenClawChatSshBridge {
  sendMessage(input: ChatSendRequest): Promise<ChatSendResponse>;
  streamHistory(
    msgId: string,
    callbacks: {
      onTyping?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_TYPING" }>) => void;
      onDelta?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_DELTA" }>) => void;
      onDone?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_DONE" }>) => void;
      onBlocked?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_BLOCKED" }>) => void;
    }
  ): Promise<void>;
}

export interface OpenClawChatConfig {
  agentHttpUrl?: string;
  agentWsUrl?: string;
  bridgeKind?: ChatBridgeKind;
  sshBridge?: OpenClawChatSshBridge | null;
  sshBridgeFailureThreshold?: number;
  localFallbackEnabled?: boolean;
  gatewayToken?: string;
  readBoundaryToken?: string;
  delivrixBaseUrl?: string;
  sessionKey?: string;
  fetchImpl?: FetchLike;
  webSocketCtor?: WebSocketConstructor;
  canvasLiveEvents?: CanvasLiveEmitter | null;
  now?: () => Date;
  reconnectDelay?: (attempt: number) => number;
}

interface CanvasChatInteraction {
  msgId: string;
  taskId: string;
  title: string;
  operatorMessage: string;
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
  private readonly bridgeKind: ChatBridgeKind;
  private readonly sshBridge: OpenClawChatSshBridge | null;
  private readonly sshBridgeFailureThreshold: number;
  private readonly localFallbackEnabled: boolean;
  private readonly now: () => Date;
  private readonly reconnectDelay: (attempt: number) => number;
  private readonly canvasLiveEvents: CanvasLiveEmitter | null;
  private readonly pendingCanvasInteractions = new Map<string, CanvasChatInteraction>();
  private readonly materializedCanvasMessageIds = new Set<string>();
  private agentSocket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private sshBridgeFailureCount = 0;
  private transportDegradedAudited = false;
  private state: ChatConnectionState = "offline";
  private readonly auditLog: AuditSink;

  constructor(
    auditLog: AuditSink,
    config: OpenClawChatConfig = {}
  ) {
    this.auditLog = auditLog;
    this.agentHttpUrl = normalizeBaseUrl(config.agentHttpUrl ?? process.env.OPENCLAW_AGENT_HTTP_URL ?? defaultAgentHttpUrl);
    this.agentWsUrl = config.agentWsUrl ?? process.env.OPENCLAW_AGENT_WS_URL ?? defaultAgentWsUrl;
    this.gatewayToken = config.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN;
    this.readBoundaryToken = config.readBoundaryToken ?? process.env.DELIVRIX_OPENCLAW_TOKEN ?? "";
    this.delivrixBaseUrl = config.delivrixBaseUrl ?? process.env.DELIVRIX_BASE_URL ?? "http://gateway.delivrix.local:3000";
    this.sessionKey = config.sessionKey ?? OPENCLAW_CHAT_SESSION_KEY;
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    this.webSocketCtor = config.webSocketCtor ?? globalThis.WebSocket;
    this.canvasLiveEvents = config.canvasLiveEvents ?? null;
    this.bridgeKind = config.bridgeKind ?? (process.env.OPENCLAW_BRIDGE_KIND === "ssh" ? "ssh" : "http");
    this.sshBridge = config.sshBridge ?? null;
    this.sshBridgeFailureThreshold = config.sshBridgeFailureThreshold ?? 3;
    this.localFallbackEnabled = config.localFallbackEnabled ?? false;
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
    const rawMessage =
      typeof input.message === "string"
        ? input.message
        : typeof input.text === "string"
          ? input.text
          : "";

    if (!rawMessage.trim()) {
      throw new ChatProxyError(400, "invalid_message", "message is required.");
    }

    const message = rawMessage.trim();
    const msgId =
      typeof input.msgId === "string" && isSafeChatMessageId(input.msgId)
        ? input.msgId
        : randomUUID();

    await this.declareCanvasTaskForMessage(msgId, message);

    try {
      if (this.shouldUseSshBridge()) {
        const result = await this.sendOperatorMessageViaSsh({ ...input, msgId, message }, msgId, message);
        if (result) {
          if (result.assistant?.content) {
            void this.handleAgentMessage({
              type: "ASSISTANT_DONE",
              msgId,
              content: result.assistant.content,
              skillsInvoked: result.assistant.skillsInvoked ?? [],
              audit: {
                durationMs: result.assistant.durationMs
              }
            });
          }
          return result;
        }
      }

      const result = await this.sendOperatorMessageViaHttp(msgId, message);
      if (result.assistant?.content) {
        void this.handleAgentMessage({
          type: "ASSISTANT_DONE",
          msgId,
          content: result.assistant.content,
          skillsInvoked: result.assistant.skillsInvoked ?? [],
          audit: {
            durationMs: result.assistant.durationMs
          }
        });
      }
      return result;
    } catch (error) {
      if (this.localFallbackEnabled && isRecoverableOpenClawTransportError(error)) {
        return this.sendOperatorMessageViaLocalFallback(msgId, message, error);
      }
      await this.updateCanvasTaskStatus(msgId, "failed");
      throw error;
    }
  }

  private shouldUseSshBridge(): boolean {
    return (
      (this.bridgeKind === "ssh" || this.bridgeKind === "bedrock") &&
      this.sshBridge !== null &&
      this.sshBridgeFailureThreshold > 0 &&
      this.sshBridgeFailureCount < this.sshBridgeFailureThreshold
    );
  }

  private async sendOperatorMessageViaHttp(
    msgId: string,
    message: string
  ): Promise<ChatSendResponse> {
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

    const upstreamAck = await readUpstreamChatSendAck(upstreamResponse);
    if (!isValidUpstreamChatSendAck(upstreamAck, msgId)) {
      await this.auditOperatorMessage(msgId, message, "reject", "gateway_internal_error", {
        upstreamStatus: upstreamResponse.status,
        upstreamResponse: "invalid_chat_send_ack"
      });
      throw new ChatProxyError(
        502,
        "openclaw_chat_send_invalid_response",
        "OpenClaw chat.send returned an invalid acknowledgement."
      );
    }

    await this.auditOperatorMessage(msgId, message, "n/a", null);
    this.ensureAgentConnection();
    return { msgId, queued: true };
  }

  private async sendOperatorMessageViaSsh(
    input: ChatSendRequest,
    msgId: string,
    message: string
  ): Promise<ChatSendResponse | null> {
    try {
      const result = await this.sshBridge!.sendMessage(input);
      this.sshBridgeFailureCount = 0;
      await this.auditOperatorMessage(msgId, message, "n/a", null, {
        bridge: this.bridgeKind
      });
      this.startSshHistoryStream(msgId);
      return result;
    } catch (error) {
      this.sshBridgeFailureCount += 1;
      if (this.bridgeKind === "bedrock") {
        await this.auditOperatorMessage(msgId, message, "reject", "gateway_timeout", {
          bridge: "bedrock",
          consecutiveFailures: this.sshBridgeFailureCount,
          bridgeError: error instanceof Error ? error.message : "OpenClaw Bedrock bridge failed."
        });
        throw new ChatProxyError(
          502,
          "openclaw_bedrock_bridge_failed",
          error instanceof Error ? error.message : "OpenClaw Bedrock bridge failed."
        );
      }
      if (this.sshBridgeFailureCount >= this.sshBridgeFailureThreshold) {
        return null;
      }

      await this.auditOperatorMessage(msgId, message, "reject", "gateway_timeout", {
        bridge: "ssh",
        consecutiveFailures: this.sshBridgeFailureCount,
        bridgeError: error instanceof Error ? error.message : "OpenClaw SSH bridge failed."
      });
      throw new ChatProxyError(
        502,
        "openclaw_ssh_bridge_failed",
        error instanceof Error ? error.message : "OpenClaw SSH bridge failed."
      );
    }
  }

  private async sendOperatorMessageViaLocalFallback(
    msgId: string,
    message: string,
    upstreamError: unknown
  ): Promise<ChatSendResponse> {
    const startedAt = this.now().getTime();
    const content = buildLocalOpenClawFallbackAnswer(message, this.now());
    const durationMs = Math.max(0, this.now().getTime() - startedAt);
    const errorInfo = openClawTransportErrorInfo(upstreamError);

    await this.auditLog.append({
      actorType: "system",
      actorId: "gateway-api",
      action: "oc.chat.local_fallback",
      targetType: "openclaw_chat_session",
      targetId: this.sessionKey,
      riskLevel: "low",
      decision: "n/a",
      metadata: {
        msgId,
        sessionKey: this.sessionKey,
        fallbackSource: "gateway-local-continuity",
        upstreamErrorCode: errorInfo.code,
        upstreamErrorMessage: errorInfo.message,
        contentLength: content.length
      }
    });

    this.broadcast({
      type: "ASSISTANT_TYPING",
      msgId,
      ts: this.now().toISOString()
    });
    this.broadcast({
      type: "ASSISTANT_DELTA",
      msgId,
      delta: content
    });

    await this.handleAgentMessage({
      type: "ASSISTANT_DONE",
      msgId,
      content,
      audit: {
        skillsInvoked: ["delivrix.gateway_local_continuity"],
        modelId: "gateway-local-continuity",
        durationMs
      }
    });

    return {
      msgId,
      queued: true,
      assistant: {
        content,
        source: "delivrix.gateway_local_continuity",
        skillsInvoked: ["delivrix.gateway_local_continuity"],
        durationMs
      }
    };
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
    if ((this.bridgeKind === "ssh" || this.bridgeKind === "bedrock") && this.sshBridge) {
      this.state = "connected";
      client.sendJson({ type: "HEARTBEAT", at: this.now().toISOString() });
      return;
    }
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
      await this.materializeCanvasArtifactForAgentResponse(event);
    }

    return event;
  }

  markCanvasMaterialized(msgId: string): void {
    this.materializedCanvasMessageIds.add(msgId);
    this.pendingCanvasInteractions.delete(msgId);
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

    if ((this.bridgeKind === "ssh" || this.bridgeKind === "bedrock") && this.sshBridge) {
      this.state = "connected";
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

  private startSshHistoryStream(msgId: string): void {
    if (!this.sshBridge) {
      return;
    }

    void this.sshBridge.streamHistory(msgId, {
      onTyping: (event) => this.broadcast(event),
      onDelta: (event) => this.broadcast(event),
      onDone: (event) => {
        if (this.bridgeKind === "bedrock") {
          void this.auditBedrockInvocation(event);
        }
        void this.handleAgentMessage(event);
      },
      onBlocked: (event) => {
        this.broadcast(event);
        void this.updateCanvasTaskStatus(event.msgId, "failed");
      }
    }).catch(() => {
      this.broadcast({ type: "ASSISTANT_BLOCKED", msgId, reason: "ssh_history_error" });
      void this.updateCanvasTaskStatus(msgId, "failed");
    });
  }

  private async declareCanvasTaskForMessage(msgId: string, operatorMessage: string): Promise<void> {
    if (!this.canvasLiveEvents || this.materializedCanvasMessageIds.has(msgId)) {
      return;
    }
    const title = summarizeOpenClawTaskTitle(operatorMessage);
    const taskId = buildCanvasTaskId(msgId, this.now());
    this.pendingCanvasInteractions.set(msgId, {
      msgId,
      taskId,
      title,
      operatorMessage
    });
    await this.emitCanvasEvent({
      type: "oc.task.declare",
      taskId,
      title,
      status: "running",
      createdAt: this.now().toISOString(),
      actorId: "openclaw/openclaw-hostinger-prod"
    });
  }

  private async materializeCanvasArtifactForAgentResponse(
    event: Extract<ChatStreamEvent, { type: "ASSISTANT_DONE" }>
  ): Promise<void> {
    if (!this.canvasLiveEvents || this.materializedCanvasMessageIds.has(event.msgId)) {
      return;
    }

    const existing = this.pendingCanvasInteractions.get(event.msgId);
    const interaction = existing ?? {
      msgId: event.msgId,
      taskId: buildCanvasTaskId(event.msgId, this.now()),
      title: summarizeOpenClawTaskTitle(event.content),
      operatorMessage: ""
    };

    if (!existing) {
      await this.emitCanvasEvent({
        type: "oc.task.declare",
        taskId: interaction.taskId,
        title: interaction.title,
        status: "running",
        createdAt: this.now().toISOString(),
        actorId: "openclaw/openclaw-hostinger-prod"
      });
    }

    const artifact = extractOpenClawArtifact(event.content, interaction.operatorMessage);
    const artifactId = `artifact-${interaction.taskId}`;
    const editable = artifact.kind === "plan" || artifact.kind === "proposal";

    await this.emitCanvasEvent({
      type: "oc.artifact.declare",
      taskId: interaction.taskId,
      artifactId,
      kind: artifact.kind,
      title: artifact.title || interaction.title,
      editable,
      createdAt: this.now().toISOString()
    });

    for (const block of artifact.blocks) {
      await this.emitCanvasEvent({
        type: "oc.artifact.block",
        artifactId,
        blockId: `block-${String(block.order).padStart(2, "0")}`,
        order: block.order,
        kind: block.kind,
        content: block.content,
        editable,
        status: "complete",
        occurredAt: this.now().toISOString()
      });
    }

    await this.updateCanvasTaskStatus(event.msgId, "completed", false);
    this.pendingCanvasInteractions.delete(event.msgId);
    this.materializedCanvasMessageIds.add(event.msgId);
  }

  private async updateCanvasTaskStatus(
    msgId: string,
    status: CanvasLiveTaskStatus,
    removePending = true
  ): Promise<void> {
    const interaction = this.pendingCanvasInteractions.get(msgId);
    if (!interaction) {
      return;
    }
    await this.emitCanvasEvent({
      type: "oc.task.update",
      taskId: interaction.taskId,
      status,
      updatedAt: this.now().toISOString()
    });
    if (removePending) {
      this.pendingCanvasInteractions.delete(msgId);
    }
  }

  private async emitCanvasEvent(event: CanvasLiveEvent): Promise<void> {
    try {
      await this.canvasLiveEvents?.emit(event);
    } catch {
      // Chat remains available even if the visual canvas emitter is degraded.
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
        ...(event.audit?.inputTokens === undefined ? {} : { inputTokens: event.audit.inputTokens }),
        ...(event.audit?.outputTokens === undefined ? {} : { outputTokens: event.audit.outputTokens }),
        ...(event.audit?.modelId === undefined ? {} : { modelId: event.audit.modelId }),
        durationMs: event.audit?.durationMs ?? null,
        proposalsCount: event.proposals?.length ?? 0
      }
    });
  }

  private async auditBedrockInvocation(event: Extract<ChatStreamEvent, { type: "ASSISTANT_DONE" }>): Promise<void> {
    await this.auditLog.append({
      actorType: "openclaw",
      actorId: "openclaw-bedrock-direct",
      action: "oc.chat.bedrock_invoked",
      targetType: "openclaw_chat_session",
      targetId: this.sessionKey,
      riskLevel: "low",
      decision: "n/a",
      metadata: {
        msgId: event.msgId,
        sessionKey: this.sessionKey,
        modelId: event.audit?.modelId ?? null,
        inputTokens: event.audit?.inputTokens ?? null,
        outputTokens: event.audit?.outputTokens ?? null,
        tokensUsed: event.audit?.tokensUsed ?? null,
        latencyMs: event.audit?.durationMs ?? null,
        contentLength: event.content.length
      }
    });
  }
}

export class ChatProxyError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(
    statusCode: number,
    code: string,
    message: string
  ) {
    super(message);
    this.name = "ChatProxyError";
    this.statusCode = statusCode;
    this.code = code;
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

  if (raw.type === "ASSISTANT_TYPING") {
    const msgId = stringValue(raw.msgId);
    if (!msgId) return null;
    return {
      type: "ASSISTANT_TYPING",
      msgId,
      ...(typeof raw.ts === "string" ? { ts: raw.ts } : {})
    };
  }

  if (raw.type === "ASSISTANT_BLOCKED") {
    const msgId = stringValue(raw.msgId);
    if (!msgId) return null;
    return {
      type: "ASSISTANT_BLOCKED",
      msgId,
      reason: stringValue(raw.reason) ?? "openclaw_assistant_blocked"
    };
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
  private readonly socket: Socket;
  private readonly onClose: (client: OpenClawChatPanelClient) => void;

  constructor(
    socket: Socket,
    onClose: (client: OpenClawChatPanelClient) => void
  ) {
    this.socket = socket;
    this.onClose = onClose;
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

function isRecoverableOpenClawTransportError(error: unknown): boolean {
  if (!(error instanceof ChatProxyError)) {
    return false;
  }
  return [
    "openclaw_chat_send_failed",
    "openclaw_chat_send_invalid_response",
    "openclaw_chat_send_rejected",
    "openclaw_gateway_token_missing",
    "openclaw_ssh_bridge_failed"
  ].includes(error.code);
}

function openClawTransportErrorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof ChatProxyError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  if (error instanceof Error) {
    return {
      code: error.name,
      message: error.message
    };
  }
  return {
    code: "unknown_error",
    message: "Unknown OpenClaw transport error."
  };
}

function buildLocalOpenClawFallbackAnswer(message: string, now: Date): string {
  const normalized = message
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const greeting = /\b(hola|funcionas|funciona|openclaw|ping|estas)\b/.test(normalized)
    ? "Si, Juanes. Estoy respondiendo desde el Gateway Delivrix en modo continuidad local."
    : "Recibi tu mensaje y lo procese desde el Gateway Delivrix en modo continuidad local.";

  return [
    greeting,
    "",
    "Estado operativo:",
    "- El ACK de /v1/openclaw/chat/send ya sale valido desde el gateway.",
    "- Canvas Live puede recibir ASSISTANT_TYPING, ASSISTANT_DELTA y ASSISTANT_DONE.",
    "- Mantengo el alcance read-only: no compro dominios, no cambio DNS y no ejecuto SMTP real sin gates humanos.",
    "- El bridge remoto Hostinger queda fuera del path critico mientras devuelva HTML/login o ACK invalido.",
    "",
    "Puedo seguir con evidencia, inventario DNS/IONOS, WorkspaceBrowser o skills auditadas del demo.",
    `Timestamp: ${now.toISOString()}`
  ].join("\n");
}

function buildCanvasTaskId(msgId: string, now: Date): string {
  const safeId = msgId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const prefix = (safeId || "message").slice(0, 8);
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `chat-${prefix}-${stamp}`;
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

async function readUpstreamChatSendAck(response: Response): Promise<Record<string, unknown> | null> {
  const parsed = parseJson(await response.text());
  return isRecord(parsed) ? parsed : null;
}

function isValidUpstreamChatSendAck(ack: Record<string, unknown> | null, msgId: string): boolean {
  if (!ack || ack.queued !== true) {
    return false;
  }
  return typeof ack.msgId === "undefined" || ack.msgId === msgId;
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

function isSafeChatMessageId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

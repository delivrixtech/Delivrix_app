import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { resolve } from "node:path";

export type GatewayLogLevel = "info" | "warn" | "error";

export type GatewayLogStreamEvent =
  | {
      type: "GATEWAY_LOG_HELLO";
      at: string;
      logPath: string;
      level: GatewayLogLevel;
      backlogLines: number;
      tokenRequired: boolean;
    }
  | {
      type: "GATEWAY_LOG_STATUS";
      at: string;
      status: "watching" | "waiting_for_log_file" | "truncated";
      message: string;
    }
  | {
      type: "GATEWAY_LOG";
      ts: string;
      level: GatewayLogLevel;
      message: string;
    }
  | {
      type: "ERROR";
      error: string;
      message: string;
    };

export interface GatewayLogStreamOptions {
  logPath?: string;
  authToken?: string;
  requireToken?: boolean;
  now?: () => Date;
  pollIntervalMs?: number;
  backlogLines?: number;
  maxQueuedFrames?: number;
  maxReadBytes?: number;
}

interface GatewayLogClient {
  readonly minLevel: GatewayLogLevel;
  sendJson(event: GatewayLogStreamEvent): void;
  close(): void;
}

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const levelRank: Record<GatewayLogLevel, number> = {
  info: 0,
  warn: 1,
  error: 2
};

export class GatewayLogStreamService {
  private readonly logPath: string;
  private readonly authToken: string;
  private readonly requireToken: boolean;
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly backlogLines: number;
  private readonly maxQueuedFrames: number;
  private readonly maxReadBytes: number;
  private readonly clients = new Set<GatewayLogClient>();
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private offset: number | null = null;
  private partialLine = "";

  constructor(options: GatewayLogStreamOptions = {}) {
    this.logPath = resolve(options.logPath ?? process.env.GATEWAY_LOG_PATH ?? "runtime/logs/gateway.log");
    this.authToken = options.authToken ?? process.env.GATEWAY_LOG_STREAM_TOKEN ?? process.env.DELIVRIX_OPENCLAW_TOKEN ?? "";
    this.requireToken = options.requireToken ?? (this.authToken.length > 0 || process.env.GATEWAY_LOG_STREAM_REQUIRE_TOKEN === "true");
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.backlogLines = options.backlogLines ?? 200;
    this.maxQueuedFrames = options.maxQueuedFrames ?? 5_000;
    this.maxReadBytes = options.maxReadBytes ?? 512 * 1024;
  }

  acceptPanelSocket(request: IncomingMessage, socket: Socket, head?: Buffer): void {
    if (!isWebSocketUpgrade(request)) {
      socket.destroy();
      return;
    }

    if (!this.isAuthorized(request)) {
      rejectWebSocket(socket, 401, "Unauthorized");
      return;
    }

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }

    const acceptKey = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "",
      ""
    ].join("\r\n"));

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const minLevel = normalizeGatewayLogLevel(url.searchParams.get("level"));
    const client = new RawGatewayLogWebSocketClient(socket, minLevel, this.maxQueuedFrames, (closedClient) => {
      this.clients.delete(closedClient);
      this.stopWatchingWhenIdle();
    });

    this.clients.add(client);
    client.sendJson({
      type: "GATEWAY_LOG_HELLO",
      at: this.now().toISOString(),
      logPath: this.logPath,
      level: minLevel,
      backlogLines: this.backlogLines,
      tokenRequired: this.requireToken
    });
    void this.sendBacklog(client);
    this.ensureWatching();

    if (head && head.length > 0) {
      socket.unshift(head);
    }
  }

  close(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.requireToken) {
      return true;
    }

    if (!this.authToken) {
      return false;
    }

    const supplied = bearerToken(request.headers.authorization) ?? tokenQueryParam(request.url) ?? headerValue(request.headers["x-delivrix-openclaw-token"]);
    return supplied === this.authToken;
  }

  private ensureWatching(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    void this.pollOnce();
  }

  private stopWatchingWhenIdle(): void {
    if (this.clients.size > 0 || !this.pollTimer) {
      return;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.offset = null;
    this.partialLine = "";
  }

  private async sendBacklog(client: GatewayLogClient): Promise<void> {
    try {
      const lines = await readTailLines(this.logPath, this.backlogLines, this.maxReadBytes);
      if (lines.length === 0) {
        client.sendJson({
          type: "GATEWAY_LOG_STATUS",
          at: this.now().toISOString(),
          status: existsSync(this.logPath) ? "watching" : "waiting_for_log_file",
          message: existsSync(this.logPath) ? "Gateway log file is empty." : "Waiting for gateway log file."
        });
        return;
      }

      for (const line of lines) {
        this.sendLineToClient(client, line);
      }
    } catch (error) {
      client.sendJson({
        type: "ERROR",
        error: "gateway_log_backlog_failed",
        message: error instanceof Error ? error.message : "Could not read gateway log backlog."
      });
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.pollInFlight || this.clients.size === 0) {
      return;
    }

    this.pollInFlight = true;
    try {
      if (!existsSync(this.logPath)) {
        this.offset = null;
        this.partialLine = "";
        this.broadcast({
          type: "GATEWAY_LOG_STATUS",
          at: this.now().toISOString(),
          status: "waiting_for_log_file",
          message: "Waiting for gateway log file."
        });
        return;
      }

      const fileStat = await stat(this.logPath);
      if (this.offset === null) {
        this.offset = fileStat.size;
        this.broadcast({
          type: "GATEWAY_LOG_STATUS",
          at: this.now().toISOString(),
          status: "watching",
          message: "Gateway log stream attached."
        });
        return;
      }

      if (fileStat.size < this.offset) {
        this.offset = 0;
        this.partialLine = "";
        this.broadcast({
          type: "GATEWAY_LOG_STATUS",
          at: this.now().toISOString(),
          status: "truncated",
          message: "Gateway log rotated or truncated; stream resynced."
        });
      }

      if (fileStat.size === this.offset) {
        return;
      }

      const pendingBytes = fileStat.size - this.offset;
      const readBytes = Math.min(pendingBytes, this.maxReadBytes);
      const start = pendingBytes > this.maxReadBytes ? fileStat.size - this.maxReadBytes : this.offset;
      if (pendingBytes > this.maxReadBytes) {
        this.broadcast({
          type: "GATEWAY_LOG_STATUS",
          at: this.now().toISOString(),
          status: "truncated",
          message: "Gateway log burst exceeded stream buffer; older lines were dropped."
        });
      }

      const chunk = await readFileRange(this.logPath, start, readBytes);
      this.offset = fileStat.size;
      this.broadcastChunk(chunk);
    } catch (error) {
      this.broadcast({
        type: "ERROR",
        error: "gateway_log_poll_failed",
        message: error instanceof Error ? error.message : "Could not poll gateway log."
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  private broadcastChunk(chunk: Buffer): void {
    const text = this.partialLine + chunk.toString("utf8");
    const complete = text.endsWith("\n") || text.endsWith("\r");
    const lines = text.split(/\r?\n/);
    this.partialLine = complete ? "" : lines.pop() ?? "";
    const boundedLines = lines.length > 5_000 ? lines.slice(-5_000) : lines;
    for (const line of boundedLines) {
      this.broadcastLine(line);
    }
  }

  private broadcastLine(line: string): void {
    const event = gatewayLogEventFromLine(line, this.now());
    if (!event) {
      return;
    }
    this.broadcast(event);
  }

  private sendLineToClient(client: GatewayLogClient, line: string): void {
    const event = gatewayLogEventFromLine(line, this.now());
    if (!event || !shouldEmitGatewayLogLevel(event.level, client.minLevel)) {
      return;
    }
    client.sendJson(event);
  }

  private broadcast(event: GatewayLogStreamEvent): void {
    for (const client of this.clients) {
      try {
        if (event.type !== "GATEWAY_LOG" || shouldEmitGatewayLogLevel(event.level, client.minLevel)) {
          client.sendJson(event);
        }
      } catch {
        this.clients.delete(client);
        client.close();
      }
    }
  }
}

export function gatewayLogEventFromLine(line: string, now: Date): Extract<GatewayLogStreamEvent, { type: "GATEWAY_LOG" }> | null {
  const trimmed = line.trimEnd();
  if (!trimmed) {
    return null;
  }
  return {
    type: "GATEWAY_LOG",
    ts: extractTimestamp(trimmed) ?? now.toISOString(),
    level: inferGatewayLogLevel(trimmed),
    message: redactGatewayLogSecrets(trimmed).slice(0, 8_000)
  };
}

export function inferGatewayLogLevel(line: string): GatewayLogLevel {
  if (/\b(error|exception|failed|failure|fatal|uncaught)\b/i.test(line)) {
    return "error";
  }
  if (/\b(warn|warning|degraded|retry|timeout)\b/i.test(line)) {
    return "warn";
  }
  return "info";
}

export function shouldEmitGatewayLogLevel(eventLevel: GatewayLogLevel, minLevel: GatewayLogLevel): boolean {
  return levelRank[eventLevel] >= levelRank[minLevel];
}

export function redactGatewayLogSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\bauthorization\b\s*[:=]\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/\bauthorization\b\s*[:=]\s*(?!Bearer\s+\[REDACTED\])("[^"]+"|'[^']+'|[^\s,;]+)/gi, "Authorization=[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1=[REDACTED]");
}

function normalizeGatewayLogLevel(value: string | null): GatewayLogLevel {
  if (value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function extractTimestamp(line: string): string | null {
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/.exec(line);
  if (iso) {
    return iso[0];
  }
  return null;
}

async function readTailLines(filePath: string, lineCount: number, maxBytes: number): Promise<string[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const fileStat = await stat(filePath);
  if (fileStat.size === 0) {
    return [];
  }
  const bytesToRead = Math.min(fileStat.size, maxBytes);
  const buffer = await readFileRange(filePath, fileStat.size - bytesToRead, bytesToRead);
  return buffer.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-lineCount);
}

async function readFileRange(filePath: string, start: number, length: number): Promise<Buffer> {
  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

class RawGatewayLogWebSocketClient implements GatewayLogClient {
  readonly minLevel: GatewayLogLevel;
  private closed = false;
  private blocked = false;
  private readonly socket: Socket;
  private readonly maxQueuedFrames: number;
  private readonly queue: Buffer[] = [];
  private readonly onClose: (client: GatewayLogClient) => void;

  constructor(
    socket: Socket,
    minLevel: GatewayLogLevel,
    maxQueuedFrames: number,
    onClose: (client: GatewayLogClient) => void
  ) {
    this.socket = socket;
    this.minLevel = minLevel;
    this.maxQueuedFrames = maxQueuedFrames;
    this.onClose = onClose;
    socket.on("data", (chunk: Buffer) => {
      if (hasCloseFrame(chunk)) {
        this.close();
      }
    });
    socket.on("drain", () => {
      this.flush();
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

  sendJson(event: GatewayLogStreamEvent): void {
    if (this.closed) {
      return;
    }
    const frame = encodeWebSocketTextFrame(JSON.stringify(event));
    if (this.blocked) {
      this.enqueue(frame);
      return;
    }
    this.blocked = !this.socket.write(frame);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.end(encodeWebSocketCloseFrame());
  }

  private enqueue(frame: Buffer): void {
    this.queue.push(frame);
    while (this.queue.length > this.maxQueuedFrames) {
      this.queue.shift();
    }
  }

  private flush(): void {
    if (this.closed) {
      return;
    }
    this.blocked = false;
    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      if (!frame) {
        return;
      }
      this.blocked = !this.socket.write(frame);
      if (this.blocked) {
        return;
      }
    }
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

function rejectWebSocket(socket: Socket, statusCode: number, reason: string): void {
  const body = JSON.stringify({ error: reason.toLowerCase().replace(/\s+/g, "_") });
  socket.end([
    `HTTP/1.1 ${statusCode} ${reason}`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body
  ].join("\r\n"));
}

function bearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function tokenQueryParam(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const parsed = new URL(url, "http://127.0.0.1");
  return parsed.searchParams.get("token");
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

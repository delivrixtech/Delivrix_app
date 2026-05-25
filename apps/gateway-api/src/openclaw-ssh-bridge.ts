import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ChatSendRequest, ChatSendResponse, ChatStreamEvent } from "./openclaw-chat.ts";

const defaultSshPort = 22;
const defaultSshUser = "root";
const defaultContainerId = "openclaw-dtsf-openclaw-1";
const defaultTimeoutMs = 30_000;
const defaultHistoryTimeoutMs = 180_000;
const defaultPollIntervalMs = 500;
const defaultSessionKey = "agent:main:operator";

export interface OpenClawSshBridgeConfig {
  sshHost: string;
  sshUser?: string;
  sshPort?: number;
  /** Path a la llave privada SSH. Alias compatible con la spec OPS: sshKey. */
  sshKey?: string;
  sshKeyPath?: string;
  containerId?: string;
  timeoutMs?: number;
  historyTimeoutMs?: number;
  pollIntervalMs?: number;
  sessionKey?: string;
  commandRunner?: OpenClawSshCommandRunner;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface OpenClawSshCommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface OpenClawSshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type OpenClawSshCommandRunner = (
  file: string,
  args: string[],
  options: OpenClawSshCommandOptions
) => Promise<OpenClawSshCommandResult>;

export interface OpenClawSshHistoryCallbacks {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onTyping?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_TYPING" }>) => void;
  onDelta?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_DELTA" }>) => void;
  onDone?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_DONE" }>) => void;
  onBlocked?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_BLOCKED" }>) => void;
}

export class OpenClawSshBridge {
  private readonly sshHost: string;
  private readonly sshUser: string;
  private readonly sshPort: number;
  private readonly sshKeyPath: string | undefined;
  private readonly containerId: string;
  private readonly timeoutMs: number;
  private readonly historyTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sessionKey: string;
  private readonly commandRunner: OpenClawSshCommandRunner;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly pendingMessages = new Map<string, { message: string; sentAtMs: number }>();

  constructor(config: OpenClawSshBridgeConfig) {
    if (!config.sshHost.trim()) {
      throw new OpenClawSshBridgeError("ssh_host_missing", "OPENCLAW_SSH_HOST is required.");
    }

    const containerId = config.containerId ?? defaultContainerId;
    if (!/^[A-Za-z0-9_.-]+$/.test(containerId)) {
      throw new OpenClawSshBridgeError(
        "invalid_container_id",
        "OPENCLAW_CONTAINER_ID contains unsupported characters."
      );
    }

    this.sshHost = config.sshHost.trim();
    this.sshUser = config.sshUser?.trim() || defaultSshUser;
    this.sshPort = config.sshPort ?? defaultSshPort;
    this.sshKeyPath = expandHome(config.sshKeyPath ?? config.sshKey);
    this.containerId = containerId;
    this.timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
    this.historyTimeoutMs = config.historyTimeoutMs ?? defaultHistoryTimeoutMs;
    this.pollIntervalMs = config.pollIntervalMs ?? defaultPollIntervalMs;
    this.sessionKey = config.sessionKey ?? defaultSessionKey;
    this.commandRunner = config.commandRunner ?? runSshCommand;
    this.now = config.now ?? (() => new Date());
    this.sleep = config.sleep ?? sleep;
  }

  async sendMessage(input: ChatSendRequest): Promise<ChatSendResponse> {
    const msgId = typeof input.msgId === "string" && input.msgId.length > 0
      ? input.msgId
      : "";
    const message =
      typeof input.message === "string"
        ? input.message.trim()
        : typeof input.text === "string"
          ? input.text.trim()
          : "";

    if (!msgId || !message) {
      throw new OpenClawSshBridgeError(
        "invalid_chat_payload",
        "msgId and message are required for SSH chat bridge."
      );
    }

    const sentAtMs = this.now().getTime();
    const output = await this.callOpenClaw("chat.send", {
      sessionKey: this.sessionKey,
      message,
      idempotencyKey: msgId
    });
    const parsed = parseJsonFromStdout(output.stdout);

    if (!isRecord(parsed) || parsed.status !== "started") {
      throw new OpenClawSshBridgeError(
        "invalid_chat_send_ack",
        "OpenClaw SSH chat.send did not return status=started."
      );
    }

    this.pendingMessages.set(msgId, { message, sentAtMs });
    return { msgId, queued: true };
  }

  async streamHistory(msgId: string, callbacks: OpenClawSshHistoryCallbacks): Promise<void> {
    const timeoutMs = callbacks.timeoutMs ?? this.historyTimeoutMs;
    const pollIntervalMs = callbacks.pollIntervalMs ?? this.pollIntervalMs;
    const startedAt = this.now().getTime();
    let emittedTyping = false;
    let emittedContent = "";
    let lastError: Error | null = null;

    while (this.now().getTime() - startedAt <= timeoutMs) {
      if (callbacks.signal?.aborted) {
        return;
      }

      if (!emittedTyping) {
        emittedTyping = true;
        callbacks.onTyping?.({
          type: "ASSISTANT_TYPING",
          msgId,
          ts: this.now().toISOString()
        });
      }

      try {
        const output = await this.callOpenClaw("chat.history", {
          sessionKey: this.sessionKey,
          limit: 20
        }, callbacks.signal);
        const parsed = parseJsonFromStdout(output.stdout);
        const completion = extractAssistantCompletion(
          parsed,
          msgId,
          this.pendingMessages.get(msgId)?.sentAtMs
        );

        if (completion) {
          const delta = completion.content.startsWith(emittedContent)
            ? completion.content.slice(emittedContent.length)
            : completion.content;
          emittedContent = completion.content;
          if (delta.length > 0) {
            callbacks.onDelta?.({ type: "ASSISTANT_DELTA", msgId, delta });
          }
          callbacks.onDone?.({
            type: "ASSISTANT_DONE",
            msgId,
            content: completion.content,
            ...(completion.audit ? { audit: completion.audit } : {}),
            ...(completion.proposals ? { proposals: completion.proposals } : {})
          });
          this.pendingMessages.delete(msgId);
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      await this.sleep(pollIntervalMs, callbacks.signal);
    }

    callbacks.onBlocked?.({
      type: "ASSISTANT_BLOCKED",
      msgId,
      reason: lastError ? "ssh_history_error" : "ssh_history_timeout"
    });
    this.pendingMessages.delete(msgId);
  }

  private callOpenClaw(
    command: "chat.send" | "chat.history",
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<OpenClawSshCommandResult> {
    return this.commandRunner("ssh", this.buildSshArgs(command, params), {
      timeoutMs: this.timeoutMs,
      signal
    });
  }

  private buildSshArgs(command: string, params: Record<string, unknown>): string[] {
    const args: string[] = [];
    if (this.sshKeyPath) {
      args.push("-i", this.sshKeyPath);
    }
    args.push(
      "-p",
      String(this.sshPort),
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      `${this.sshUser}@${this.sshHost}`,
      shellQuoteArgs([
        "docker",
        "exec",
        this.containerId,
        "openclaw",
        "gateway",
        "call",
        command,
        "--json",
        "--timeout",
        String(Math.ceil(this.timeoutMs / 1000)),
        "--params",
        JSON.stringify(params)
      ])
    );
    return args;
  }
}

export function createOpenClawSshBridgeFromEnv(
  env: Record<string, string | undefined> =
    typeof process !== "undefined" ? process.env : {}
): OpenClawSshBridge | null {
  if (env.OPENCLAW_BRIDGE_KIND !== "ssh") {
    return null;
  }

  const sshHost = normalizeEnvValue(env.OPENCLAW_SSH_HOST);
  if (!sshHost) {
    return null;
  }

  return new OpenClawSshBridge({
    sshHost,
    sshUser: normalizeEnvValue(env.OPENCLAW_SSH_USER) ?? defaultSshUser,
    sshPort: parsePort(env.OPENCLAW_SSH_PORT) ?? defaultSshPort,
    sshKeyPath: normalizeEnvValue(env.OPENCLAW_SSH_KEY_PATH),
    containerId: normalizeEnvValue(env.OPENCLAW_CONTAINER_ID) ?? defaultContainerId,
    timeoutMs: parsePositiveInt(env.OPENCLAW_SSH_TIMEOUT_MS) ?? defaultTimeoutMs,
    historyTimeoutMs: parsePositiveInt(env.OPENCLAW_SSH_HISTORY_TIMEOUT_MS) ?? defaultHistoryTimeoutMs,
    pollIntervalMs: parsePositiveInt(env.OPENCLAW_SSH_POLL_INTERVAL_MS) ?? defaultPollIntervalMs
  });
}

export class OpenClawSshBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OpenClawSshBridgeError";
    this.code = code;
  }
}

async function runSshCommand(
  file: string,
  args: string[],
  options: OpenClawSshCommandOptions
): Promise<OpenClawSshCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };

    const finish = (
      fn: typeof resolvePromise | typeof reject,
      value: OpenClawSshCommandResult | Error
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value as never);
    };

    const abort = () => {
      child.kill("SIGTERM");
      finish(reject, new OpenClawSshBridgeError("ssh_command_aborted", "SSH command aborted."));
    };

    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(
        reject,
        new OpenClawSshBridgeError("ssh_command_timeout", "SSH command timed out.")
      );
    }, options.timeoutMs);
    timeout.unref();

    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        finish(resolvePromise, { stdout, stderr, exitCode });
        return;
      }
      finish(
        reject,
        new OpenClawSshBridgeError(
          "ssh_command_failed",
          `SSH command failed with exit ${exitCode ?? "unknown"}.`
        )
      );
    });
  });
}

function extractAssistantCompletion(
  raw: unknown,
  msgId: string,
  sentAtMs?: number
): {
  content: string;
  audit?: Extract<ChatStreamEvent, { type: "ASSISTANT_DONE" }>["audit"];
  proposals?: unknown[];
} | null {
  const messages = extractMessages(raw);
  const assistantMessages = messages.filter((message) => {
    const role = stringValue(message.role) ?? stringValue(message.type);
    const content = contentFromMessage(message);
    if (!content || (role !== "assistant" && role !== "ASSISTANT_DONE")) {
      return false;
    }
    if (isAssistantToolUseMessage(message)) {
      return false;
    }
    const timestamp = numberValue(message.timestamp);
    return sentAtMs === undefined || timestamp === undefined || timestamp >= sentAtMs;
  });

  const preferred = [...assistantMessages]
    .reverse()
    .find((message) =>
      [message.msgId, message.requestMsgId, message.parentMsgId, message.id].some(
        (value) => value === msgId
      )
    ) ?? assistantMessages.at(-1);

  if (!preferred) {
    return null;
  }

  const content = contentFromMessage(preferred);
  if (!content) {
    return null;
  }

  const audit = extractAudit(preferred);
  const proposals = Array.isArray(preferred.proposals) ? preferred.proposals : undefined;
  return {
    content,
    ...(audit ? { audit } : {}),
    ...(proposals ? { proposals } : {})
  };
}

function extractMessages(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw.filter(isRecord);
  }
  if (!isRecord(raw)) {
    return [];
  }
  if (Array.isArray(raw.messages)) {
    return raw.messages.filter(isRecord);
  }
  if (Array.isArray(raw.items)) {
    return raw.items.filter(isRecord);
  }
  if (isRecord(raw.history) && Array.isArray(raw.history.messages)) {
    return raw.history.messages.filter(isRecord);
  }
  return [];
}

function contentFromMessage(message: Record<string, unknown>): string | null {
  const direct = stringValue(message.content) ?? stringValue(message.text);
  if (direct !== null) {
    return direct;
  }
  if (Array.isArray(message.content)) {
    const text = message.content
      .filter(isRecord)
      .map((block) => stringValue(block.text))
      .filter((blockText): blockText is string => blockText !== null)
      .join("");
    return text.length > 0 ? text : null;
  }
  if (isRecord(message.message)) {
    return stringValue(message.message.content) ?? stringValue(message.message.text);
  }
  return null;
}

function isAssistantToolUseMessage(message: Record<string, unknown>): boolean {
  const stopReason = stringValue(message.stopReason) ?? stringValue(message.stop_reason);
  if (stopReason === "toolUse" || stopReason === "tool_use") {
    return true;
  }

  if (!Array.isArray(message.content)) {
    return false;
  }

  return message.content
    .filter(isRecord)
    .some((block) => {
      const type = stringValue(block.type);
      return type === "toolCall" || type === "tool_use";
    });
}

function extractAudit(
  message: Record<string, unknown>
): Extract<ChatStreamEvent, { type: "ASSISTANT_DONE" }>["audit"] | undefined {
  const rawAudit = isRecord(message.audit) ? message.audit : {};
  const skillsInvoked = stringArray(message.skillsInvoked);
  const tokensUsed = numberValue(rawAudit.tokensUsed) ?? numberValue(rawAudit.tokens_used);
  const durationMs = numberValue(rawAudit.durationMs) ?? numberValue(rawAudit.duration_ms);
  if (skillsInvoked.length === 0 && tokensUsed === undefined && durationMs === undefined) {
    return undefined;
  }
  return {
    skillsInvoked,
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    ...(durationMs === undefined ? {} : { durationMs })
  };
}

function parseJsonFromStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const direct = parseJson(trimmed);
  if (direct !== null) {
    return direct;
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).reverse();
  for (const line of lines) {
    if (!line.startsWith("{") && !line.startsWith("[")) {
      continue;
    }
    const parsed = parseJson(line);
    if (parsed !== null) {
      return parsed;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return parseJson(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function expandHome(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(value: string | undefined): number | undefined {
  const parsed = parsePositiveInt(value);
  return parsed && parsed <= 65_535 ? parsed : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellQuoteArgs(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(resolvePromise, ms);
    timer.unref();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
  });
}

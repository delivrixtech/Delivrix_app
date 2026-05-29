import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  type BedrockRuntimeClientConfig,
  type InvokeModelWithResponseStreamCommandInput
} from "@aws-sdk/client-bedrock-runtime";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ChatSendRequest,
  ChatSendResponse,
  ChatStreamEvent,
  OpenClawChatSshBridge
} from "./openclaw-chat.ts";

const defaultModelRegion = "us-east-1";
const defaultMaxTokens = 4096;
const defaultTemperature = 0.3;
const defaultSessionKey = "agent:main:operator";
const defaultMaxConversationTurns = 12;

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

interface BedrockStreamChunk {
  chunk?: {
    bytes?: Uint8Array;
  };
}

interface BedrockRuntimeClientLike {
  send(command: InvokeModelWithResponseStreamCommand): Promise<{
    body?: AsyncIterable<BedrockStreamChunk> | Iterable<BedrockStreamChunk>;
  }>;
}

interface BedrockInvocationResult {
  text: string;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

export interface OpenClawBedrockBridgeConfig {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  bearerToken?: string;
  region?: string;
  modelId: string;
  systemPromptPath?: string;
  fallbackSystemPromptPath?: string;
  maxTokens?: number;
  temperature?: number;
  sessionKey?: string;
  maxConversationTurns?: number;
  client?: BedrockRuntimeClientLike;
  now?: () => Date;
}

export class OpenClawBedrockBridge implements OpenClawChatSshBridge {
  private readonly client: BedrockRuntimeClientLike;
  private readonly modelId: string;
  private readonly systemPromptPath: string;
  private readonly fallbackSystemPromptPath: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly sessionKey: string;
  private readonly maxConversationTurns: number;
  private readonly now: () => Date;
  private cachedSystemPrompt: string | null = null;
  private readonly conversations = new Map<string, ConversationTurn[]>();
  private readonly pendingResponses = new Map<string, Promise<BedrockInvocationResult>>();

  constructor(config: OpenClawBedrockBridgeConfig) {
    if (!config.modelId.trim()) {
      throw new OpenClawBedrockBridgeError("bedrock_model_missing", "AWS_BEDROCK_MODEL_ID is required.");
    }

    const clientConfig: BedrockRuntimeClientConfig = {
      region: config.region ?? defaultModelRegion
    };
    if (config.bearerToken) {
      clientConfig.token = { token: config.bearerToken };
      clientConfig.authSchemePreference = ["httpBearerAuth"];
    } else if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {})
      };
    }
    this.client = config.client ?? new BedrockRuntimeClient(clientConfig);
    this.modelId = config.modelId.trim();
    this.systemPromptPath = config.systemPromptPath ?? join(process.cwd(), ".audit", "system-context.txt");
    this.fallbackSystemPromptPath = config.fallbackSystemPromptPath ?? join(process.cwd(), "DOCUMENTACION", "OPENCLAW_SYSTEM_PROMPT.md");
    this.maxTokens = config.maxTokens ?? defaultMaxTokens;
    this.temperature = config.temperature ?? defaultTemperature;
    this.sessionKey = config.sessionKey ?? defaultSessionKey;
    this.maxConversationTurns = config.maxConversationTurns ?? defaultMaxConversationTurns;
    this.now = config.now ?? (() => new Date());
  }

  isConfigured(): boolean {
    return Boolean(this.modelId);
  }

  async sendMessage(input: ChatSendRequest): Promise<ChatSendResponse> {
    const msgId = typeof input.msgId === "string" && input.msgId.length > 0 ? input.msgId : "";
    const message = typeof input.message === "string"
      ? input.message.trim()
      : typeof input.text === "string"
        ? input.text.trim()
        : "";

    if (!msgId || !message) {
      throw new OpenClawBedrockBridgeError("invalid_chat_payload", "msgId and message are required for Bedrock chat bridge.");
    }

    const turns = [...(this.conversations.get(this.sessionKey) ?? []), { role: "user" as const, content: message }];
    this.conversations.set(this.sessionKey, this.trimConversation(turns));
    this.pendingResponses.set(msgId, this.invokeBedrock(turns));
    return { msgId, queued: true };
  }

  async streamHistory(
    msgId: string,
    callbacks: {
      onTyping?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_TYPING" }>) => void;
      onDelta?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_DELTA" }>) => void;
      onDone?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_DONE" }>) => void;
      onBlocked?: (event: Extract<ChatStreamEvent, { type: "ASSISTANT_BLOCKED" }>) => void;
    }
  ): Promise<void> {
    const pending = this.pendingResponses.get(msgId);
    if (!pending) {
      callbacks.onBlocked?.({ type: "ASSISTANT_BLOCKED", msgId, reason: "bedrock_response_missing" });
      return;
    }

    callbacks.onTyping?.({
      type: "ASSISTANT_TYPING",
      msgId,
      ts: this.now().toISOString()
    });

    try {
      const result = await pending;
      if (result.text.length > 0) {
        callbacks.onDelta?.({ type: "ASSISTANT_DELTA", msgId, delta: result.text });
      }
      callbacks.onDone?.({
        type: "ASSISTANT_DONE",
        msgId,
        content: result.text,
        audit: {
          skillsInvoked: ["openclaw-bedrock-direct"],
          modelId: result.modelId,
          ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
          ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
          ...(result.inputTokens === undefined || result.outputTokens === undefined ? {} : { tokensUsed: result.inputTokens + result.outputTokens }),
          durationMs: result.durationMs
        }
      });
      const turns = this.conversations.get(this.sessionKey) ?? [];
      this.conversations.set(this.sessionKey, this.trimConversation([...turns, { role: "assistant", content: result.text }]));
    } catch {
      callbacks.onBlocked?.({ type: "ASSISTANT_BLOCKED", msgId, reason: "bedrock_invoke_error" });
    } finally {
      this.pendingResponses.delete(msgId);
    }
  }

  private async invokeBedrock(turns: ConversationTurn[]): Promise<BedrockInvocationResult> {
    const startedAt = this.now().getTime();
    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system: await this.loadSystemPrompt(),
      messages: turns.map((turn) => ({
        role: turn.role,
        content: [{ type: "text", text: turn.content }]
      }))
    };
    const command = new InvokeModelWithResponseStreamCommand({
      modelId: this.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload)
    } satisfies InvokeModelWithResponseStreamCommandInput);
    const result = await this.client.send(command);

    let text = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const event of toAsyncIterable(result.body ?? [])) {
      if (!event.chunk?.bytes) continue;
      const parsed = parseJson(new TextDecoder().decode(event.chunk.bytes));
      if (!isRecord(parsed)) continue;

      if (parsed.type === "message_start" && isRecord(parsed.message) && isRecord(parsed.message.usage)) {
        inputTokens = numberValue(parsed.message.usage.input_tokens) ?? inputTokens;
      }
      if (parsed.type === "message_delta" && isRecord(parsed.usage)) {
        outputTokens = numberValue(parsed.usage.output_tokens) ?? outputTokens;
      }
      if (parsed.type === "content_block_start" && isRecord(parsed.content_block) && parsed.content_block.type === "text") {
        text += stringValue(parsed.content_block.text) ?? "";
      }
      if (parsed.type === "content_block_delta" && isRecord(parsed.delta) && parsed.delta.type === "text_delta") {
        text += stringValue(parsed.delta.text) ?? "";
      }
    }

    return {
      text,
      modelId: this.modelId,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      durationMs: Math.max(0, this.now().getTime() - startedAt)
    };
  }

  private async loadSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt) return this.cachedSystemPrompt;
    try {
      this.cachedSystemPrompt = await readFile(this.systemPromptPath, "utf8");
      return this.cachedSystemPrompt;
    } catch {
      this.cachedSystemPrompt = await readFile(this.fallbackSystemPromptPath, "utf8");
      return this.cachedSystemPrompt;
    }
  }

  private trimConversation(turns: ConversationTurn[]): ConversationTurn[] {
    if (turns.length <= this.maxConversationTurns) return turns;
    return turns.slice(turns.length - this.maxConversationTurns);
  }
}

export function createOpenClawBedrockBridgeFromEnv(
  env: Record<string, string | undefined> =
    typeof process !== "undefined" ? process.env : {}
): OpenClawBedrockBridge | null {
  if (env.OPENCLAW_BRIDGE_KIND !== "bedrock") {
    return null;
  }

  const accessKeyId = normalizeEnvValue(env.AWS_BEDROCK_ACCESS_KEY_ID);
  const secretAccessKey = normalizeEnvValue(env.AWS_BEDROCK_SECRET_ACCESS_KEY);
  const bearerToken = normalizeEnvValue(env.AWS_BEARER_TOKEN_BEDROCK);
  const modelId = normalizeEnvValue(env.AWS_BEDROCK_MODEL_ID);
  if (!modelId || (!bearerToken && (!accessKeyId || !secretAccessKey))) {
    return null;
  }

  return new OpenClawBedrockBridge({
    accessKeyId,
    secretAccessKey,
    sessionToken: normalizeEnvValue(env.AWS_BEDROCK_SESSION_TOKEN),
    bearerToken,
    region: normalizeEnvValue(env.AWS_BEDROCK_REGION) ?? defaultModelRegion,
    modelId,
    systemPromptPath: normalizeEnvValue(env.OPENCLAW_SYSTEM_CONTEXT_PATH),
    maxTokens: parsePositiveInt(env.AWS_BEDROCK_MAX_TOKENS) ?? defaultMaxTokens,
    temperature: parseTemperature(env.AWS_BEDROCK_TEMPERATURE) ?? defaultTemperature
  });
}

export class OpenClawBedrockBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OpenClawBedrockBridgeError";
    this.code = code;
  }
}

async function* toAsyncIterable<T>(value: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> {
  for await (const item of value) {
    yield item;
  }
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseTemperature(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

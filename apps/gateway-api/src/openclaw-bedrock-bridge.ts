import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
  type BedrockRuntimeClientConfig,
  type InvokeModelWithResponseStreamCommandInput
} from "@aws-sdk/client-bedrock-runtime";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEventInput } from "../../../packages/domain/src/index.ts";
import type {
  ChatSendRequest,
  ChatSendResponse,
  ChatStreamEvent,
  OpenClawChatSshBridge
} from "./openclaw-chat.ts";
import {
  buildToolsForOpenClaw,
  type BedrockToolSpec
} from "./openclaw-tools-builder.ts";
import {
  createHttpToolUseProcessor,
  type ToolUseResult
} from "./tool-use-processor.ts";
import {
  noopGatewayRuntimeLogger,
  runtimeErrorMetadata,
  summarizeOperationalParams,
  type GatewayRuntimeLogger
} from "./gateway-runtime-log.ts";

const defaultModelRegion = "us-east-1";
const defaultMaxTokens = 4096;
const defaultTemperature = 0.3;
const defaultSessionKey = "agent:main:operator";
const defaultMaxConversationTurns = 12;
const defaultDelivrixBaseUrl = "http://127.0.0.1:3000";
const defaultMaxToolIterations = 10;

type FetchLike = typeof fetch;

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

type BedrockMessageRole = "user" | "assistant";

type BedrockContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface BedrockMessage {
  role: BedrockMessageRole;
  content: BedrockContentBlock[];
}

interface BedrockParsedResponse {
  content: BedrockContentBlock[];
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
}

interface BedrockStreamChunk {
  chunk?: {
    bytes?: Uint8Array;
  };
}

interface BedrockRuntimeClientLike {
  send(command: InvokeModelWithResponseStreamCommand, options?: { abortSignal?: AbortSignal }): Promise<{
    body?: AsyncIterable<BedrockStreamChunk> | Iterable<BedrockStreamChunk>;
  }>;
}

interface AuditSink {
  append(event: AuditEventInput): Promise<unknown>;
}

interface BedrockInvocationResult {
  text: string;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  toolsInvoked?: string[];
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
  delivrixBaseUrl?: string;
  readBoundaryToken?: string;
  fetchImpl?: FetchLike;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  maxToolIterations?: number;
  logger?: GatewayRuntimeLogger;
  auditLog?: AuditSink;
  processToolUse?: (input: {
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
    chatSession: { id: string; msgId?: string };
  }) => Promise<ToolUseResult>;
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
  private readonly delivrixBaseUrl: string;
  private readonly readBoundaryToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly env: Record<string, string | undefined>;
  private readonly maxToolIterations: number;
  private readonly logger: GatewayRuntimeLogger;
  private readonly auditLog: AuditSink | null;
  private readonly processToolUse: (input: {
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
    chatSession: { id: string; msgId?: string };
  }) => Promise<ToolUseResult>;
  private cachedSystemPrompt: string | null = null;
  private readonly conversations = new Map<string, ConversationTurn[]>();
  private readonly pendingResponses = new Map<string, Promise<BedrockInvocationResult>>();
  private readonly pendingControllers = new Map<string, AbortController>();
  private readonly interruptedMsgIds = new Set<string>();

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
    this.delivrixBaseUrl = normalizeBaseUrl(config.delivrixBaseUrl ?? defaultDelivrixBaseUrl);
    this.readBoundaryToken = config.readBoundaryToken ?? "";
    this.fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
    this.now = config.now ?? (() => new Date());
    this.env = config.env ?? (typeof process !== "undefined" ? process.env : {});
    this.maxToolIterations = config.maxToolIterations ?? defaultMaxToolIterations;
    this.logger = config.logger ?? noopGatewayRuntimeLogger;
    this.auditLog = config.auditLog ?? null;
    this.processToolUse = config.processToolUse ?? createHttpToolUseProcessor({
      delivrixBaseUrl: this.delivrixBaseUrl,
      fetchImpl: this.fetchImpl,
      readBoundaryToken: this.readBoundaryToken,
      env: this.env,
      now: this.now,
      logger: this.logger
    });
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
    const controller = new AbortController();
    this.pendingControllers.set(msgId, controller);
    this.interruptedMsgIds.delete(msgId);
    void this.logger.info("openclaw.bedrock.message_queued", "Operator message queued for AWS Bedrock.", {
      msgId,
      sessionKey: this.sessionKey,
      modelId: this.modelId,
      messageChars: message.length
    });
    this.pendingResponses.set(msgId, this.invokeBedrock(turns, msgId, controller.signal));
    return { msgId, queued: true };
  }

  async interrupt(msgId: string): Promise<boolean> {
    const controller = this.pendingControllers.get(msgId);
    const hadPending = this.pendingResponses.has(msgId) || Boolean(controller);
    this.interruptedMsgIds.add(msgId);
    controller?.abort();
    this.pendingControllers.delete(msgId);
    this.pendingResponses.delete(msgId);
    return hadPending;
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
      void this.logger.warn("openclaw.bedrock.response_missing", "Panel requested a Bedrock response that is no longer pending.", { msgId });
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
          skillsInvoked: ["openclaw-bedrock-direct", ...(result.toolsInvoked ?? [])],
          modelId: result.modelId,
          ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
          ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
          ...(result.inputTokens === undefined || result.outputTokens === undefined ? {} : { tokensUsed: result.inputTokens + result.outputTokens }),
          durationMs: result.durationMs
        }
      });
      const turns = this.conversations.get(this.sessionKey) ?? [];
      this.conversations.set(this.sessionKey, this.trimConversation([...turns, { role: "assistant", content: result.text }]));
    } catch (error) {
      if (this.interruptedMsgIds.has(msgId) || isAbortError(error)) {
        void this.logger.warn("openclaw.bedrock.interrupted", "Bedrock invocation interrupted by operator.", {
          msgId,
          ...runtimeErrorMetadata(error)
        });
        return;
      }
      void this.logger.error("openclaw.bedrock.invoke_failed", "Bedrock invocation failed before assistant response.", {
        msgId,
        ...runtimeErrorMetadata(error)
      });
      callbacks.onBlocked?.({ type: "ASSISTANT_BLOCKED", msgId, reason: "bedrock_invoke_error" });
    } finally {
      this.pendingResponses.delete(msgId);
      this.pendingControllers.delete(msgId);
      this.interruptedMsgIds.delete(msgId);
    }
  }

  private async invokeBedrock(turns: ConversationTurn[], msgId: string, signal?: AbortSignal): Promise<BedrockInvocationResult> {
    const startedAt = this.now().getTime();
    const systemBase = await this.loadSystemPrompt();
    const liveContext = await this.fetchLiveContext();
    const system = `${systemBase}\n\n${liveContext}`;
    const tools = buildToolsForOpenClaw(this.env);
    const messages: BedrockMessage[] = turns.map((turn) => ({
      role: turn.role,
      content: [{ type: "text", text: turn.content }]
    }));
    await this.logger.info("openclaw.bedrock.invoke_started", "Calling AWS Bedrock with live context and tool catalog.", {
      msgId,
      modelId: this.modelId,
      turns: turns.length,
      tools: tools.length,
      maxToolIterations: this.maxToolIterations
    });
    let inputTokens = 0;
    let outputTokens = 0;
    let sawInputTokens = false;
    let sawOutputTokens = false;
    const toolsInvoked: string[] = [];
    const turnIntentId = intentIdForMsgId(msgId);

    for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
      throwIfAborted(signal);
      const response = await this.invokeBedrockOnce({
        messages,
        system,
        tools,
        signal
      });
      if (response.inputTokens !== undefined) {
        inputTokens += response.inputTokens;
        sawInputTokens = true;
      }
      if (response.outputTokens !== undefined) {
        outputTokens += response.outputTokens;
        sawOutputTokens = true;
      }

      const toolUses = response.content.filter(isToolUseBlock);
      if (toolUses.length === 0) {
        const durationMs = Math.max(0, this.now().getTime() - startedAt);
        await this.logger.info("openclaw.bedrock.invoke_completed", "Bedrock returned final assistant response.", {
          msgId,
          modelId: this.modelId,
          durationMs,
          inputTokens: sawInputTokens ? inputTokens : undefined,
          outputTokens: sawOutputTokens ? outputTokens : undefined,
          toolsInvoked
        });
        return {
          text: response.text,
          modelId: this.modelId,
          ...(sawInputTokens ? { inputTokens } : {}),
          ...(sawOutputTokens ? { outputTokens } : {}),
          durationMs,
          ...(toolsInvoked.length > 0 ? { toolsInvoked } : {})
        };
      }

      messages.push({
        role: "assistant",
        content: response.content
      });

      const toolResults: BedrockContentBlock[] = [];
      for (const toolUse of toolUses) {
        throwIfAborted(signal);
        toolsInvoked.push(toolUse.name);
        const toolInputHash = hashToolInput(toolUse.input);
        await this.logger.info("openclaw.bedrock.tool_use_requested", "Bedrock requested a Delivrix tool.", {
          msgId,
          iteration,
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          params: summarizeOperationalParams(toolUse.input)
        });
        const result = await this.processToolUse({
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          toolInput: toolUse.input,
          chatSession: { id: this.sessionKey, msgId }
        }).catch((error): ToolUseResult => ({
          ok: false,
          error: "tool_use_processor_failed",
          details: error instanceof Error ? error.message : "Unknown tool-use processor error"
        }));
        await (result.ok
          ? this.logger.info("openclaw.bedrock.tool_use_completed", "Delivrix tool completed for Bedrock.", {
            msgId,
            iteration,
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            proposalId: result.proposalId,
            durationMs: result.durationMs,
            statusCode: result.statusCode
          })
          : this.logger.warn("openclaw.bedrock.tool_use_failed", "Delivrix tool returned a non-ok result to Bedrock.", {
            msgId,
            iteration,
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            proposalId: result.proposalId,
            error: result.error,
            statusCode: result.statusCode,
            details: result.details
          }));
        await this.auditSkillInvokedFromToolUse({
          intentId: turnIntentId,
          msgId,
          iteration,
          toolUse,
          inputHash: toolInputHash,
          result
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: stringifyToolResult(enrichToolResultForModel(result, {
            intentId: turnIntentId,
            msgId,
            iteration,
            toolUse,
            inputHash: toolInputHash
          }))
        });
      }

      messages.push({
        role: "user",
        content: toolResults
      });
    }

    throw new OpenClawBedrockBridgeError(
      "bedrock_tool_loop_exceeded",
      `OpenClaw Bedrock exceeded ${this.maxToolIterations} tool-use iterations.`
    );
  }

  private async auditSkillInvokedFromToolUse(input: {
    intentId: string;
    msgId: string;
    iteration: number;
    toolUse: Extract<BedrockContentBlock, { type: "tool_use" }>;
    inputHash: string;
    result: ToolUseResult;
  }): Promise<void> {
    if (!this.auditLog || input.toolUse.name === "compact_intent") {
      return;
    }

    try {
      await this.auditLog.append({
        actorType: "openclaw",
        actorId: "openclaw-bedrock-direct",
        action: "oc.skill.invoked",
        targetType: "openclaw_intent",
        targetId: input.intentId,
        riskLevel: "low",
        decision: "allow",
        metadata: {
          intentId: input.intentId,
          msgId: input.msgId,
          iteration: input.iteration,
          toolUseId: input.toolUse.id,
          skillSlug: input.toolUse.name,
          inputHash: input.inputHash,
          ok: input.result.ok,
          ...(input.result.proposalId ? { proposalId: input.result.proposalId } : {}),
          ...(input.result.statusCode === undefined ? {} : { statusCode: input.result.statusCode })
        }
      });
    } catch (error) {
      await this.logger.warn("openclaw.bedrock.skill_invocation_audit_failed", "Could not append skill invocation audit event for tool-use.", {
        msgId: input.msgId,
        toolUseId: input.toolUse.id,
        toolName: input.toolUse.name,
        ...runtimeErrorMetadata(error)
      });
    }
  }

  private async invokeBedrockOnce(input: {
    messages: BedrockMessage[];
    system: string;
    tools: BedrockToolSpec[];
    signal?: AbortSignal;
  }): Promise<BedrockParsedResponse> {
    const payload: Record<string, unknown> = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system: input.system,
      messages: input.messages
    };
    if (input.tools.length > 0) {
      payload.tools = input.tools;
      payload.tool_choice = { type: "auto" };
    }
    const command = new InvokeModelWithResponseStreamCommand({
      modelId: this.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload)
    } satisfies InvokeModelWithResponseStreamCommandInput);
    const result = await this.client.send(command, { abortSignal: input.signal });

    const content = new Map<number, MutableBedrockContentBlock>();
    let currentIndex = 0;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;

    for await (const event of toAsyncIterable(result.body ?? [])) {
      throwIfAborted(input.signal);
      if (!event.chunk?.bytes) continue;
      const parsed = parseJson(new TextDecoder().decode(event.chunk.bytes));
      if (!isRecord(parsed)) continue;

      if (parsed.type === "message_start" && isRecord(parsed.message) && isRecord(parsed.message.usage)) {
        inputTokens = numberValue(parsed.message.usage.input_tokens) ?? inputTokens;
      }
      if (parsed.type === "message_delta" && isRecord(parsed.usage)) {
        outputTokens = numberValue(parsed.usage.output_tokens) ?? outputTokens;
      }
      if (parsed.type === "message_delta") {
        stopReason = stringValue(parsed.stop_reason) ?? stringValue(parsed.stopReason) ?? stopReason;
      }
      if (parsed.type === "content_block_start" && isRecord(parsed.content_block)) {
        const index = numberValue(parsed.index) ?? currentIndex;
        currentIndex = index;
        const block = parsed.content_block;
        if (block.type === "text") {
          content.set(index, {
            type: "text",
            text: stringValue(block.text) ?? ""
          });
        }
        if (block.type === "tool_use") {
          content.set(index, {
            type: "tool_use",
            id: stringValue(block.id) ?? `toolu_${index}`,
            name: stringValue(block.name) ?? "",
            input: isRecord(block.input) ? block.input : {},
            partialJson: ""
          });
        }
      }
      if (parsed.type === "content_block_delta" && isRecord(parsed.delta)) {
        const index = numberValue(parsed.index) ?? currentIndex;
        currentIndex = index;
        if (parsed.delta.type === "text_delta") {
          const block = content.get(index);
          if (block?.type === "text") {
            block.text += stringValue(parsed.delta.text) ?? "";
          } else {
            content.set(index, {
              type: "text",
              text: stringValue(parsed.delta.text) ?? ""
            });
          }
        }
        if (parsed.delta.type === "input_json_delta") {
          const partial = stringValue(parsed.delta.partial_json) ?? "";
          const block = content.get(index);
          if (block?.type === "tool_use") {
            block.partialJson += partial;
          } else {
            content.set(index, {
              type: "tool_use",
              id: `toolu_${index}`,
              name: "",
              input: {},
              partialJson: partial
            });
          }
        }
      }
    }

    const blocks = [...content.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => finalizeContentBlock(block));

    return {
      content: blocks,
      text: blocks.filter(isTextBlock).map((block) => block.text).join(""),
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(stopReason ? { stopReason } : {})
    };
  }

  private async fetchLiveContext(): Promise<string> {
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (this.readBoundaryToken) {
      headers["x-delivrix-token"] = this.readBoundaryToken;
    }

    const safeGet = async (path: string): Promise<unknown> => {
      try {
        const response = await this.fetchImpl(`${this.delivrixBaseUrl}${path}`, { headers });
        if (!response.ok) {
          void this.logger.warn("openclaw.bedrock.live_context_fetch_failed", "Live context endpoint returned non-OK.", {
            path,
            statusCode: response.status
          });
          return { _error: `HTTP ${response.status}` };
        }
        return redactSensitiveLiveContext(await response.json());
      } catch (error) {
        void this.logger.warn("openclaw.bedrock.live_context_fetch_failed", "Live context endpoint could not be read.", {
          path,
          ...runtimeErrorMetadata(error)
        });
        return { _error: error instanceof Error ? error.message : "unknown" };
      }
    };

    const [overview, killSwitch, canvas, audit] = await Promise.all([
      safeGet("/v1/admin/overview"),
      safeGet("/v1/kill-switch"),
      safeGet("/v1/canvas/live/state"),
      safeGet("/v1/audit-events?limit=10")
    ]);
    const generatedAt = this.now().toISOString();

    return [
      `<live_context generatedAt="${generatedAt}">`,
      "Estos son datos REALES del Gateway Delivrix justo antes de tu turno actual.",
      "Cita explicitamente este contexto cuando el operador te pregunte por estado del sistema.",
      "Si un campo falta o tiene _error, dilo honesto. NO inventes valores.",
      "",
      "## overview (GET /v1/admin/overview)",
      "```json",
      stringifyLiveContext(overview, 4000),
      "```",
      "",
      "## kill_switch (GET /v1/kill-switch)",
      "```json",
      stringifyLiveContext(killSwitch, 1500),
      "```",
      "",
      "## canvas (GET /v1/canvas/live/state)",
      "```json",
      stringifyLiveContext(canvas, 4000),
      "```",
      "",
      "## audit_recent (GET /v1/audit-events?limit=10)",
      "```json",
      stringifyLiveContext(audit, 4000),
      "```",
      "</live_context>"
    ].join("\n");
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
    typeof process !== "undefined" ? process.env : {},
  options: { logger?: GatewayRuntimeLogger; auditLog?: AuditSink } = {}
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
    delivrixBaseUrl: normalizeEnvValue(env.DELIVRIX_BASE_URL) ?? defaultDelivrixBaseUrl,
    readBoundaryToken: normalizeEnvValue(env.DELIVRIX_OPENCLAW_TOKEN) ?? "",
    maxTokens: parsePositiveInt(env.AWS_BEDROCK_MAX_TOKENS) ?? defaultMaxTokens,
    temperature: parseTemperature(env.AWS_BEDROCK_TEMPERATURE) ?? defaultTemperature,
    maxToolIterations: parsePositiveInt(env.OPENCLAW_TOOL_MAX_ITERATIONS) ?? defaultMaxToolIterations,
    env,
    logger: options.logger,
    auditLog: options.auditLog
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

type MutableBedrockContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; partialJson: string };

function finalizeContentBlock(block: MutableBedrockContentBlock): BedrockContentBlock {
  if (block.type === "text") {
    return block;
  }

  const parsedInput = block.partialJson.trim().length > 0
    ? parseJson(block.partialJson)
    : block.input;
  return {
    type: "tool_use",
    id: block.id,
    name: block.name,
    input: parsedInput ?? block.input
  };
}

function isTextBlock(block: BedrockContentBlock): block is Extract<BedrockContentBlock, { type: "text" }> {
  return block.type === "text";
}

function isToolUseBlock(block: BedrockContentBlock): block is Extract<BedrockContentBlock, { type: "tool_use" }> {
  return block.type === "tool_use";
}

function enrichToolResultForModel(
  result: ToolUseResult,
  input: {
    intentId: string;
    msgId: string;
    iteration: number;
    toolUse: Extract<BedrockContentBlock, { type: "tool_use" }>;
    inputHash: string;
  }
): Record<string, unknown> {
  return {
    ...result,
    _openclaw: {
      intentId: input.intentId,
      msgId: input.msgId,
      iteration: input.iteration,
      toolUseId: input.toolUse.id,
      tool: input.toolUse.name,
      inputHash: input.inputHash,
      compactIntentStep: {
        step: input.iteration + 1,
        tool: input.toolUse.name,
        inputHash: input.inputHash,
        outcome: result.ok ? "success" : "failed",
        toolUseId: input.toolUse.id,
        ...(result.proposalId ? { proposalId: result.proposalId } : {}),
        ...(result.ok ? {} : { errorClass: result.error })
      },
      compactIntentInstruction:
        "Para cerrar memoria, llama compact_intent con este intentId y steps derivados de compactIntentStep. No inventes intentId."
    }
  };
}

function stringifyToolResult(result: unknown): string {
  const raw = JSON.stringify(result);
  if (raw.length <= 4096) {
    return raw;
  }
  const metadata = isRecord(result) && isRecord(result._openclaw) ? result._openclaw : undefined;
  return JSON.stringify({
    ok: isRecord(result) ? result.ok : undefined,
    ...(metadata ? { _openclaw: metadata } : {}),
    truncated: true,
    preview: raw.slice(0, 4096)
  });
}

function intentIdForMsgId(msgId: string): string {
  return `chat:${hashToolInput(msgId).slice(0, 24)}`;
}

function hashToolInput(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new OpenClawBedrockBridgeError("bedrock_invoke_aborted", "Bedrock invocation aborted by operator.");
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof OpenClawBedrockBridgeError) {
    return error.code === "bedrock_invoke_aborted";
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || /aborted|abort/i.test(error.message);
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function stringifyLiveContext(value: unknown, maxLength: number): string {
  return JSON.stringify(value, null, 2).slice(0, maxLength);
}

function redactSensitiveLiveContext(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveLiveContext(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isSensitiveLiveContextKey(key) ? "[redacted]" : redactSensitiveLiveContext(child);
  }
  return redacted;
}

function isSensitiveLiveContextKey(key: string): boolean {
  return /token|secret|password|private[_-]?key|access[_-]?key|api[_-]?key|authorization/i.test(key);
}

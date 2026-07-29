/**
 * Abstracción de sesión Bedrock multi-agente (Fase 2, día 1).
 *
 * Cada agente senior corre como una sesión lógica del gateway con su propio
 * historial, system prompt y tool set. La frontera con Bedrock es la interfaz
 * `AgentModelClient`:
 *  - `MockAgentModelClient` — modo dry-run por defecto. Sin red, sin credenciales.
 *  - El cliente real (`InvokeModelWithResponseStream`, mismo patrón que
 *    OpenClawBedrockBridge) se cablea el día 3 detrás de esta misma interfaz.
 *
 * Reglas de la spec implementadas aquí:
 *  - Token accounting + costo estimado por sesión (input $3/M, output $15/M).
 *  - Hard cap de tokens por sesión → auto-pausa + evento (kill switch suave).
 *  - Ciclo de vida observable: cada transición emite agent.* al bus.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AgentEvent,
  AgentRole,
  AgentSessionSnapshot,
  AgentSessionStatus
} from "../../../../packages/domain/src/index.ts";
import type { BedrockToolSpec } from "../openclaw-tools-builder.ts";
import type { AgentDefinition } from "./agent-registry.ts";
import type { AgentEventBus } from "./agent-event-bus.ts";

export const MOCK_AGENT_MODEL_ID = "mock/dry-run";

/**
 * Precio del modelo que corre esta sesion.
 *
 * Antes estaba clavado a tarifa de Sonnet ($3/$15 por millon) para TODAS las sesiones. Eso
 * subestimaba Opus y, sobre todo, iba a reportar dolares que nadie pago cuando el agente corra
 * en la Mac — justo el numero con el que se decide si el modelo local conviene. El precio lo
 * sabe quien sabe que modelo es: el cliente.
 */
export interface AgentModelPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface AgentModelToolUse {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
}

export interface AgentModelTurn {
  role: "user" | "assistant";
  content: string;
  toolUses?: AgentModelToolUse[];
  toolResults?: Array<{ toolUseId: string; content: string }>;
}

export interface AgentModelInvokeInput {
  system: string;
  messages: AgentModelTurn[];
  tools: BedrockToolSpec[];
  abortSignal?: AbortSignal;
}

export interface AgentModelInvokeResult {
  text: string;
  toolUses: AgentModelToolUse[];
  inputTokens: number;
  outputTokens: number;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "aborted";
}

/** Única frontera con Bedrock. Nada fuera de esta interfaz toca la red del modelo. */
export interface AgentModelClient {
  modelId: string;
  /** Ausente = precio desconocido. El costo estimado da 0 y NO significa gratis. */
  pricing?: AgentModelPricing;
  invoke(input: AgentModelInvokeInput): Promise<AgentModelInvokeResult>;
}

export type MockScriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; toolName: string; toolInput: unknown; note?: string };

export interface MockAgentModelClientOptions {
  /** Pasos guionados; agotados los pasos, responde texto de cierre. */
  script?: MockScriptStep[];
  /** Tokens simulados por invocación (para tests de caps/costos). */
  inputTokensPerCall?: number;
  outputTokensPerCall?: number;
}

/** Cliente dry-run: determinista, sin red, sin credenciales. */
export class MockAgentModelClient implements AgentModelClient {
  readonly modelId = MOCK_AGENT_MODEL_ID;
  /** Sin modelo no hay gasto: el 0 aca es un hecho, no un desconocido. */
  readonly pricing: AgentModelPricing = { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };
  private readonly script: MockScriptStep[];
  private readonly inputTokensPerCall: number;
  private readonly outputTokensPerCall: number;
  private cursor = 0;

  constructor(options: MockAgentModelClientOptions = {}) {
    this.script = options.script ?? [];
    this.inputTokensPerCall = options.inputTokensPerCall ?? 250;
    this.outputTokensPerCall = options.outputTokensPerCall ?? 120;
  }

  async invoke(input: AgentModelInvokeInput): Promise<AgentModelInvokeResult> {
    const step = this.script[this.cursor];
    this.cursor += 1;
    if (step && step.kind === "tool_use") {
      return {
        text: step.note ?? "",
        toolUses: [{
          toolUseId: `mock-tool-${this.cursor}`,
          toolName: step.toolName,
          toolInput: step.toolInput
        }],
        inputTokens: this.inputTokensPerCall,
        outputTokens: this.outputTokensPerCall,
        stopReason: "tool_use"
      };
    }
    const lastUser = [...input.messages].reverse().find((turn) => turn.role === "user");
    const text = step && step.kind === "text"
      ? step.text
      : `[dry-run] Recibido: ${truncate(lastUser?.content ?? "", 160)} — ${input.tools.length} tools declaradas.`;
    return {
      text,
      toolUses: [],
      inputTokens: this.inputTokensPerCall,
      outputTokens: this.outputTokensPerCall,
      stopReason: "end_turn"
    };
  }
}

export type MultiAgentRuntimeMode = "mock" | "bedrock";

export interface CreateAgentModelClientInput {
  mode?: MultiAgentRuntimeMode;
  env?: Record<string, string | undefined>;
  /** Factory del cliente real (día 3). Sin ella, el modo bedrock falla explícito. */
  bedrockClientFactory?: () => AgentModelClient;
  mock?: MockAgentModelClientOptions;
}

export function resolveMultiAgentRuntimeMode(env: Record<string, string | undefined>): MultiAgentRuntimeMode {
  const raw = (env.MULTI_AGENT_MODE ?? "mock").trim().toLowerCase();
  if (raw === "bedrock") return "bedrock";
  return "mock";
}

export function createAgentModelClient(input: CreateAgentModelClientInput = {}): AgentModelClient {
  const env = input.env ?? process.env;
  const mode = input.mode ?? resolveMultiAgentRuntimeMode(env);
  if (mode === "bedrock") {
    if (!input.bedrockClientFactory) {
      throw new AgentSessionError(
        "bedrock_agent_client_not_wired",
        "MULTI_AGENT_MODE=bedrock pero el cliente real aún no está cableado (día 3). Usa modo mock."
      );
    }
    return input.bedrockClientFactory();
  }
  return new MockAgentModelClient(input.mock);
}

export class AgentSessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentSessionError";
    this.code = code;
  }
}

export interface AgentToolExecutor {
  (input: {
    session: BedrockAgentSession;
    toolUseId: string;
    toolName: string;
    toolInput: unknown;
  }): Promise<{ success: boolean; content: string; error?: string }>;
}

export interface BedrockAgentSessionOptions {
  definition: AgentDefinition;
  taskId: string;
  parentTaskId?: string;
  delegatedBy: string;
  modelClient: AgentModelClient;
  eventBus: AgentEventBus;
  tools?: BedrockToolSpec[];
  /** Ejecuta tool_use dentro del scope del rol. Default: error explícito (stub día 1). */
  toolExecutor?: AgentToolExecutor;
  maxIterations?: number;
  /**
   * Corta la llamada al modelo en vuelo.
   *
   * Sin esto el kill switch solo se chequeaba ENTRE items del abanico: armarlo dejaba corriendo
   * hasta 4 llamadas pagas hasta que terminaran solas. Con el mock daba igual porque respondia
   * al instante; con un modelo real no.
   */
  abortSignal?: AbortSignal;
  now?: () => Date;
  sessionId?: string;
  systemPromptLoader?: (definition: AgentDefinition) => Promise<string>;
}

export interface AgentSessionResult {
  status: Extract<AgentSessionStatus, "completed" | "failed" | "paused">;
  resultSummary: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  /** false = no se conoce el precio del modelo; el costo de arriba es 0 y no significa gratis. */
  pricingKnown: boolean;
  /**
   * El modelo se quedo sin espacio a mitad del veredicto.
   *
   * La sesion trata todo lo que no es tool_use como terminado, asi que sin esta marca una
   * respuesta cortada se lee igual que una conclusion.
   */
  truncated?: true;
  /**
   * Cuantas tools ejecuto la sesion.
   *
   * Existe porque un modelo puede cerrar SIN pedir ninguna y aun asi escribir lineas de
   * "evidencia" citando sondas que nunca corrio. Medido el 2026-07-29: pasaba en el 46% de la
   * flota. El texto se ve razonable; el unico dato que lo delata es este contador.
   */
  toolCallCount: number;
}

const defaultMaxIterations = 8;

/**
 * Sesión de un agente senior: mantiene historial propio, invoca el modelo por
 * la interfaz `AgentModelClient`, despacha tool_use con la matriz de permisos
 * del rol y emite agent.* al bus en cada transición.
 */
export class BedrockAgentSession {
  readonly sessionId: string;
  readonly definition: AgentDefinition;
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly delegatedBy: string;

  private readonly modelClient: AgentModelClient;
  private readonly eventBus: AgentEventBus;
  private readonly tools: BedrockToolSpec[];
  private readonly toolExecutor: AgentToolExecutor;
  private readonly maxIterations: number;
  private readonly abortSignal: AbortSignal | undefined;
  private readonly now: () => Date;
  private readonly systemPromptLoader: (definition: AgentDefinition) => Promise<string>;

  private status: AgentSessionStatus = "idle";
  private readonly turns: AgentModelTurn[] = [];
  private inputTokens = 0;
  private outputTokens = 0;
  private startedAt = "";
  private updatedAt = "";
  private toolCallCount = 0;
  private lastEventType: AgentEvent["type"] | undefined;
  private failureReason: string | undefined;

  constructor(options: BedrockAgentSessionOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.definition = options.definition;
    this.taskId = options.taskId;
    this.parentTaskId = options.parentTaskId;
    this.delegatedBy = options.delegatedBy;
    this.modelClient = options.modelClient;
    this.eventBus = options.eventBus;
    this.tools = options.tools ?? [];
    this.toolExecutor = options.toolExecutor ?? (async ({ toolName }) => ({
      success: false,
      content: "",
      error: `tool_not_wired: ${toolName} declarada pero sin dispatcher (Fase 2 día 4).`
    }));
    this.maxIterations = options.maxIterations ?? defaultMaxIterations;
    this.abortSignal = options.abortSignal;
    this.now = options.now ?? (() => new Date());
    this.systemPromptLoader = options.systemPromptLoader ?? defaultSystemPromptLoader;
  }

  get role(): AgentRole {
    return this.definition.role;
  }

  get currentStatus(): AgentSessionStatus {
    return this.status;
  }

  get tokensUsed(): number {
    return this.inputTokens + this.outputTokens;
  }

  get estimatedCostUsd(): number {
    const pricing = this.modelClient.pricing;
    if (!pricing) return 0;
    return roundUsd(
      (this.inputTokens / 1_000_000) * pricing.inputUsdPerMillionTokens +
      (this.outputTokens / 1_000_000) * pricing.outputUsdPerMillionTokens
    );
  }

  /** false = el costo de arriba es 0 porque no se conoce el precio, no porque sea gratis. */
  get pricingKnown(): boolean {
    return this.modelClient.pricing !== undefined;
  }

  snapshot(): AgentSessionSnapshot {
    return {
      sessionId: this.sessionId,
      agentRole: this.role,
      taskId: this.taskId,
      ...(this.parentTaskId ? { parentTaskId: this.parentTaskId } : {}),
      status: this.status,
      modelId: this.modelClient.modelId,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedCostUsd: this.estimatedCostUsd,
      ...(this.lastEventType ? { lastEventType: this.lastEventType } : {}),
      ...(this.failureReason ? { failureReason: this.failureReason } : {})
    };
  }

  /**
   * Ejecuta la sesión completa para unas instrucciones: loop modelo → tools →
   * modelo hasta end_turn, cap de tokens o max iterations.
   */
  async run(instructions: string): Promise<AgentSessionResult> {
    if (this.status !== "idle") {
      throw new AgentSessionError(
        "agent_session_already_used",
        `La sesión ${this.sessionId} ya fue ejecutada (status=${this.status}). Crea una nueva sesión por delegación.`
      );
    }
    this.status = "starting";
    this.startedAt = this.timestamp();
    await this.emit({
      type: "agent.started",
      modelId: this.modelClient.modelId
    });

    const system = await this.systemPromptLoader(this.definition);
    this.turns.push({ role: "user", content: instructions });

    let lastText = "";
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      this.status = "thinking";
      await this.emit({
        type: "agent.thinking",
        progressNote: `iteración ${iteration + 1}/${this.maxIterations}`
      });

      const result = await this.modelClient.invoke({
        system,
        messages: this.turns,
        tools: this.tools,
        ...(this.abortSignal ? { abortSignal: this.abortSignal } : {})
      });
      this.inputTokens += result.inputTokens;
      this.outputTokens += result.outputTokens;
      lastText = result.text || lastText;
      this.turns.push({ role: "assistant", content: result.text, toolUses: result.toolUses });

      await this.emit({
        type: "agent.heartbeat",
        tokensUsedSoFar: this.tokensUsed,
        estimatedCostSoFar: this.estimatedCostUsd
      });

      if (this.tokensUsed > this.definition.maxSessionTokens) {
        return this.pauseForTokenCap();
      }

      if (result.stopReason !== "tool_use" || result.toolUses.length === 0) {
        // max_tokens no es una conclusion: el modelo se quedo sin espacio. Se cierra igual —no
        // hay nada mejor que hacer— pero marcado, para que el reporte no lo muestre como un
        // veredicto terminado.
        return this.complete(lastText, result.stopReason === "max_tokens");
      }

      const toolResults: Array<{ toolUseId: string; content: string }> = [];
      for (const toolUse of result.toolUses) {
        const toolOutcome = await this.dispatchToolUse(toolUse);
        toolResults.push({ toolUseId: toolUse.toolUseId, content: toolOutcome });
      }
      this.turns.push({ role: "user", content: "", toolResults });
    }

    return this.fail(
      `max_iterations: la sesión superó ${this.maxIterations} iteraciones sin end_turn.`,
      []
    );
  }

  private async dispatchToolUse(toolUse: AgentModelToolUse): Promise<string> {
    this.status = "tool_use";
    this.toolCallCount += 1;
    await this.emit({
      type: "agent.tool_use",
      toolName: toolUse.toolName,
      toolInput: toolUse.toolInput
    });

    const startedAt = Date.now();
    // Matriz de permisos: el gateway rechaza tools fuera del scope del rol.
    if (!this.definition.toolNames.includes(toolUse.toolName)) {
      const error = `tool_out_of_scope: ${toolUse.toolName} no está permitida para el rol ${this.role}.`;
      await this.emit({
        type: "agent.tool_result",
        toolName: toolUse.toolName,
        success: false,
        durationMs: Date.now() - startedAt,
        error
      });
      return JSON.stringify({ ok: false, error });
    }

    try {
      const outcome = await this.toolExecutor({
        session: this,
        toolUseId: toolUse.toolUseId,
        toolName: toolUse.toolName,
        toolInput: toolUse.toolInput
      });
      await this.emit({
        type: "agent.tool_result",
        toolName: toolUse.toolName,
        success: outcome.success,
        durationMs: Date.now() - startedAt,
        ...(outcome.error ? { error: outcome.error } : {})
      });
      return outcome.success
        ? outcome.content
        : JSON.stringify({ ok: false, error: outcome.error ?? "tool_failed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.emit({
        type: "agent.tool_result",
        toolName: toolUse.toolName,
        success: false,
        durationMs: Date.now() - startedAt,
        error: message
      });
      return JSON.stringify({ ok: false, error: message });
    }
  }

  private async complete(resultSummary: string, truncated = false): Promise<AgentSessionResult> {
    this.status = "completed";
    const summary = truncated
      ? `[VEREDICTO CORTADO EN max_tokens — puede estar incompleto]\n${resultSummary}`
      : resultSummary;
    await this.emit({
      type: "agent.completed",
      resultSummary: truncate(summary, 2_000),
      auditChainHashes: []
    });
    return { ...this.result("completed", summary), ...(truncated ? { truncated: true as const } : {}) };
  }

  private async fail(reason: string, evidenceRefs: string[]): Promise<AgentSessionResult> {
    this.status = "failed";
    this.failureReason = reason;
    await this.emit({
      type: "agent.failed",
      reason,
      evidenceRefs
    });
    return this.result("failed", reason);
  }

  private async pauseForTokenCap(): Promise<AgentSessionResult> {
    this.status = "paused";
    const reason =
      `token_hard_cap: la sesión usó ${this.tokensUsed} tokens ` +
      `(cap ${this.definition.maxSessionTokens}). Pausa automática + alerta al operador.`;
    this.failureReason = reason;
    await this.emit({
      type: "agent.failed",
      reason,
      evidenceRefs: []
    });
    return this.result("paused", reason);
  }

  private result(
    status: Extract<AgentSessionStatus, "completed" | "failed" | "paused">,
    resultSummary: string
  ): AgentSessionResult {
    return {
      status,
      resultSummary,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedCostUsd: this.estimatedCostUsd,
      pricingKnown: this.pricingKnown,
      toolCallCount: this.toolCallCount
    };
  }

  private async emit(partial: DistributiveOmit<AgentEvent, "agentRole" | "taskId" | "sessionId" | "occurredAt">): Promise<void> {
    this.updatedAt = this.timestamp();
    const event = {
      agentRole: this.role,
      taskId: this.taskId,
      sessionId: this.sessionId,
      occurredAt: this.updatedAt,
      ...partial
    } as AgentEvent;
    this.lastEventType = event.type;
    await this.eventBus.publish(event);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export interface SystemPromptFallbackNotice {
  role: AgentRole;
  path: string;
  reason: string;
}

let onFallback: ((notice: SystemPromptFallbackNotice) => void) | undefined;

/**
 * Registra a quien avisarle cuando un agente cae al prompt embebido.
 *
 * Existe porque la degradacion era invisible: el catch se comia el error y el agente corria con
 * dos frases genericas — sabiendo que tools tiene, sin saber que esta buscando. El operador
 * veia sesiones "completadas" con veredictos pobres y ninguna pista del motivo.
 */
export function setSystemPromptFallbackReporter(
  reporter: ((notice: SystemPromptFallbackNotice) => void) | undefined
): void {
  onFallback = reporter;
}

async function defaultSystemPromptLoader(definition: AgentDefinition): Promise<string> {
  try {
    const content = await readFile(definition.systemPromptPath, "utf8");
    if (content.trim()) return content;
  } catch (error) {
    // NO silencioso: correr con el fallback de dos frases es un agente generico que no sabe
    // que esta buscando. Es una degradacion, y el operador tiene que poder verla en el log.
    onFallback?.({
      role: definition.role,
      path: definition.systemPromptPath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  return definition.fallbackSystemPrompt;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

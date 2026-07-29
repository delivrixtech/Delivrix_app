// Segundo cerebro: AgentModelClient contra un servidor local compatible con OpenAI.
//
// Mismo contrato que el cliente de Bedrock, otra API. Existe porque los 59 agentes del warmup
// solo LEEN, y leer no justifica pagar tokens de frontera: OpenClaw —que crea SMTPs, donde un
// error cuesta un dominio y una IP— se queda en Claude.
//
// Todo el archivo es traduccion, y la traduccion es donde se pierden los diagnosticos. Las dos
// APIs no son variantes de la misma forma:
//
//   Anthropic                                  OpenAI
//   assistant con bloques [text, tool_use]  -> assistant con content + tool_calls[]
//   UN turno user con N tool_result         -> N mensajes role:"tool" SEPARADOS
//   input: objeto                           -> arguments: STRING con JSON adentro
//   stop_reason                             -> finish_reason (otros nombres)
//   usage.input_tokens / output_tokens      -> usage.prompt_tokens / completion_tokens
//
// La segunda linea es la que mas rompe: colapsar N tool_result en un solo mensaje deja tool_calls
// sin responder y el server rechaza el turno siguiente.

import {
  AgentSessionError,
  type AgentModelClient,
  type AgentModelInvokeInput,
  type AgentModelInvokeResult,
  type AgentModelPricing,
  type AgentModelToolUse,
  type AgentModelTurn
} from "./bedrock-agent-session.ts";
import type { BedrockToolSpec } from "../openclaw-tools-builder.ts";

/**
 * Un modelo local no factura.
 *
 * El 0 es un hecho declarado, no un desconocido: por eso `pricingKnown` queda en true y el
 * reporte puede decir "esta corrida costo 0" con la misma confianza con la que dice "costo 4,63".
 * Ese contraste es justamente el numero con el que se decide donde corren los agentes.
 */
const LOCAL_PRICING: AgentModelPricing = { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };

/** Un modelo local sin API key es lo normal; LM Studio ignora el header pero lo acepta. */
export const DEFAULT_LOCAL_API_KEY = "local";

/**
 * Mas generoso que los 240s de Bedrock a proposito.
 *
 * Un modelo local con 4 sesiones en paralelo compartiendo el mismo hardware degrada por cola, no
 * por error: cortar temprano convertiria "esta ocupado" en "fallo el diagnostico".
 */
export const DEFAULT_LOCAL_CALL_BUDGET_MS = 600_000;

export const DEFAULT_LOCAL_MAX_TOKENS = 8_192;

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export interface LocalOpenAiClientOptions {
  /** Base del endpoint, con o sin /v1 final. Ej: http://100.104.216.127:1234/v1 */
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  maxTokens?: number;
  callBudgetMs?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
  onDegradation?: (notice: { kind: string; detail: string; modelId: string }) => void;
}

/**
 * Traduce el historial plano a mensajes de la API de OpenAI.
 *
 * Un turno de la sesion puede producir VARIOS mensajes: el turno de tool_results se abre en un
 * mensaje `role:"tool"` por cada resultado, porque el protocolo aparea por `tool_call_id` y no
 * admite varios resultados en un mismo mensaje.
 */
export function toOpenAiMessages(turns: readonly AgentModelTurn[], system: string): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: "system", content: system }];

  for (const turn of turns) {
    if (turn.toolResults && turn.toolResults.length > 0) {
      for (const result of turn.toolResults) {
        messages.push({ role: "tool", tool_call_id: result.toolUseId, content: result.content });
      }
      // El texto que acompaña a los tool_result se descarta: en el protocolo de OpenAI ese turno
      // ES la respuesta de las tools. La sesion siempre lo manda vacio, asi que no se pierde nada.
      continue;
    }

    if (turn.role === "assistant") {
      const toolCalls = (turn.toolUses ?? []).map((use) => ({
        id: use.toolUseId,
        type: "function" as const,
        function: {
          name: use.toolName,
          // arguments es un STRING con JSON adentro, no un objeto. Mandar el objeto hace que el
          // server lo reciba como "[object Object]" o lo rechace.
          arguments: JSON.stringify(use.toolInput ?? {})
        }
      }));
      messages.push({
        role: "assistant",
        // null y no "": varios servers rechazan content vacio cuando hay tool_calls.
        content: turn.content === "" ? null : turn.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
      });
      continue;
    }

    messages.push({ role: "user", content: turn.content });
  }

  return messages;
}

/** Las specs ya son JSON Schema; solo cambia el envoltorio. */
export function toOpenAiTools(tools: readonly BedrockToolSpec[]): Array<{
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }
  }));
}

/**
 * finish_reason -> el union de la sesion.
 *
 * Igual que en Bedrock: manda el HECHO sobre la etiqueta. Un modelo local que emite tool_calls
 * pero cierra con finish_reason "stop" es comun, y creerle a la etiqueta dejaria las tools
 * escritas en el historial sin ejecutar jamas.
 */
export function mapFinishReason(
  raw: string | undefined,
  toolCallCount: number
): { stopReason: AgentModelInvokeResult["stopReason"]; unknown: boolean } {
  if (toolCallCount > 0) return { stopReason: "tool_use", unknown: false };
  switch (raw) {
    case "length":
      return { stopReason: "max_tokens", unknown: false };
    case "stop":
    case "tool_calls":
    case "function_call":
    case undefined:
    case null as unknown as string:
      return { stopReason: "end_turn", unknown: false };
    default:
      return { stopReason: "end_turn", unknown: true };
  }
}

export class LocalOpenAiAgentModelClient implements AgentModelClient {
  readonly modelId: string;
  readonly pricing = LOCAL_PRICING;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly callBudgetMs: number;
  private readonly temperature: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onDegradation: (notice: { kind: string; detail: string; modelId: string }) => void;

  constructor(options: LocalOpenAiClientOptions) {
    this.modelId = options.modelId;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey ?? DEFAULT_LOCAL_API_KEY;
    this.maxTokens = options.maxTokens ?? DEFAULT_LOCAL_MAX_TOKENS;
    this.callBudgetMs = options.callBudgetMs ?? DEFAULT_LOCAL_CALL_BUDGET_MS;
    // 0 y no 0.7: un diagnostico tiene que ser reproducible. A diferencia de Bedrock, los
    // servidores locales aceptan el parametro sin excepcion.
    this.temperature = options.temperature ?? 0;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onDegradation = options.onDegradation ?? (() => {});
  }

  async invoke(input: AgentModelInvokeInput): Promise<AgentModelInvokeResult> {
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), this.callBudgetMs);
    const signal = input.abortSignal
      ? AbortSignal.any([input.abortSignal, budget.signal])
      : budget.signal;

    const tools = toOpenAiTools(input.tools);
    const body = {
      model: this.modelId,
      messages: toOpenAiMessages(input.messages, input.system),
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: false,
      // Igual que en Bedrock: tools:[] no es lo mismo que omitir la clave.
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {})
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (input.abortSignal?.aborted) {
        throw new AgentSessionError("agent_invoke_aborted", "La llamada al modelo local fue abortada.");
      }
      if (budget.signal.aborted) {
        throw new AgentSessionError(
          "agent_call_budget_exhausted",
          `El modelo local no respondio en ${this.callBudgetMs}ms.`
        );
      }
      // Un modelo local apagado es el modo de falla mas comun y merece decirlo asi.
      throw new AgentSessionError(
        "agent_local_unreachable",
        `No se pudo hablar con el modelo local en ${this.baseUrl}: ${error instanceof Error ? error.message : "desconocido"}.`
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 400);
      throw new AgentSessionError(
        "agent_local_http_error",
        `El modelo local devolvio HTTP ${response.status}: ${detail}`
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: OpenAiMessage; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;

    const choice = payload?.choices?.[0];
    if (!choice?.message) {
      throw new AgentSessionError(
        "agent_local_response_malformed",
        "El modelo local no devolvio choices[0].message."
      );
    }

    const toolUses: AgentModelToolUse[] = [];
    const malformed: string[] = [];
    for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
      const name = call.function?.name ?? "";
      const rawArgs = call.function?.arguments ?? "";
      const parsed = parseArguments(rawArgs);
      if (parsed === undefined) {
        // Los modelos chicos cortan o malforman este JSON seguido, y es el modo de falla caro:
        // read_smtp_reachability sin dominio devuelve un veredicto confiado sobre otro nodo.
        malformed.push(name || `tool_call_${index}`);
        continue;
      }
      toolUses.push({
        toolUseId: call.id ?? `local-tool-${index}`,
        toolName: name,
        toolInput: parsed
      });
    }

    if (malformed.length > 0) {
      this.onDegradation({
        kind: "malformed_tool_input",
        detail: `Parametros ilegibles para: ${malformed.join(", ")}.`,
        modelId: this.modelId
      });
      throw new AgentSessionError(
        "agent_tool_input_malformed",
        `El modelo local emitio parametros que no son JSON valido para: ${malformed.join(", ")}. Sondear con eso daria un veredicto falso.`
      );
    }

    const { stopReason, unknown } = mapFinishReason(choice.finish_reason, toolUses.length);
    if (unknown) {
      this.onDegradation({
        kind: "unknown_stop_reason",
        detail: `finish_reason "${String(choice.finish_reason)}" no esta mapeado; se cerro como end_turn.`,
        modelId: this.modelId
      });
    }
    if (stopReason === "max_tokens") {
      this.onDegradation({
        kind: "response_truncated",
        detail: `La respuesta se corto en max_tokens (${this.maxTokens}); el veredicto puede estar incompleto.`,
        modelId: this.modelId
      });
    }

    // Sin usage no hay contabilidad y el cap por sesion queda desactivado en silencio. Un servidor
    // local que no lo reporta es un servidor mal configurado, no un caso a tolerar.
    const inputTokens = finite(payload?.usage?.prompt_tokens);
    const outputTokens = finite(payload?.usage?.completion_tokens);
    if (inputTokens === undefined || outputTokens === undefined) {
      throw new AgentSessionError(
        "agent_usage_missing",
        "El modelo local no devolvio usage. Sin tokens reales el cap por sesion queda desactivado."
      );
    }

    return {
      text: typeof choice.message.content === "string" ? choice.message.content : "",
      toolUses,
      inputTokens,
      outputTokens,
      stopReason
    };
  }
}

export interface CreateLocalClientInput {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  onDegradation?: (notice: { kind: string; detail: string; modelId: string }) => void;
}

export function createLocalOpenAiAgentModelClient(
  input: CreateLocalClientInput = {}
): LocalOpenAiAgentModelClient {
  const env = input.env ?? process.env;

  const baseUrl = trimmed(env.LOCAL_INFERENCE_BASE_URL);
  if (!baseUrl) {
    throw new AgentSessionError(
      "agent_local_base_url_missing",
      "Falta LOCAL_INFERENCE_BASE_URL (ej: http://100.104.216.127:1234/v1) para el modelo local."
    );
  }
  const modelId = trimmed(env.LOCAL_INFERENCE_MODEL);
  if (!modelId) {
    throw new AgentSessionError(
      "agent_local_model_missing",
      "Falta LOCAL_INFERENCE_MODEL (el id que el servidor local expone en /v1/models)."
    );
  }

  return new LocalOpenAiAgentModelClient({
    baseUrl,
    modelId,
    ...(trimmed(env.LOCAL_INFERENCE_API_KEY) ? { apiKey: trimmed(env.LOCAL_INFERENCE_API_KEY)! } : {}),
    ...(positiveInt(env.LOCAL_INFERENCE_MAX_TOKENS) === undefined
      ? {}
      : { maxTokens: positiveInt(env.LOCAL_INFERENCE_MAX_TOKENS)! }),
    ...(positiveInt(env.LOCAL_INFERENCE_CALL_BUDGET_MS) === undefined
      ? {}
      : { callBudgetMs: positiveInt(env.LOCAL_INFERENCE_CALL_BUDGET_MS)! }),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.onDegradation ? { onDegradation: input.onDegradation } : {})
  });
}

/** Acepta con o sin `/v1` final y sin barra colgando: los dos se escriben igual de seguido. */
function normalizeBaseUrl(raw: string): string {
  const trimmedUrl = raw.trim().replace(/\/+$/, "");
  return trimmedUrl.endsWith("/v1") ? trimmedUrl : `${trimmedUrl}/v1`;
}

/**
 * `arguments` es un string con JSON. Un objeto vacio es valido; un string vacio tambien
 * (tool sin parametros). Lo que NO es valido es JSON roto: eso devuelve undefined y falla arriba.
 */
function parseArguments(raw: string): unknown | undefined {
  const normalized = raw.trim();
  if (normalized === "") return {};
  try {
    const parsed = JSON.parse(normalized);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

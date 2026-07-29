// El cerebro real de un agente: AgentModelClient sobre Bedrock.
//
// Hasta ahora el abanico corria con MockAgentModelClient, que devuelve end_turn en la primera
// llamada: cero tools ejecutadas y la sesion cerrada como "completed". Este archivo es lo que
// convierte esa maqueta en un diagnostico.
//
// El cable (payload, stream, idle-timeout) NO esta aca: esta en bedrock-messages-invoke.ts,
// compartido con el chat. Aca vive lo que es propio del agente:
//   - la traduccion turno plano <-> bloques de contenido,
//   - el mapeo honesto de stop_reason,
//   - el retry ante throttling, que el chat no necesita y el abanico si,
//   - y las validaciones que impiden cerrar un diagnostico con datos que no existen.

import {
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig
} from "@aws-sdk/client-bedrock-runtime";
import {
  invokeBedrockMessages,
  isToolUseBlock,
  modelAcceptsSamplingParams,
  type BedrockMessage,
  type BedrockContentBlock,
  type BedrockRuntimeClientLike
} from "../bedrock-messages-invoke.ts";
import {
  AgentSessionError,
  type AgentModelClient,
  type AgentModelInvokeInput,
  type AgentModelInvokeResult,
  type AgentModelPricing,
  type AgentModelTurn
} from "./bedrock-agent-session.ts";

/**
 * Precio por millon de tokens, por familia de modelo.
 *
 * Se busca la familia DENTRO del id porque los ids de Bedrock llevan prefijos (`anthropic.`, y
 * perfiles cross-region como `us.`). Un modelo que no este en la tabla devuelve undefined, y
 * eso viaja hasta el reporte como "precio desconocido" en vez de como un numero inventado: el
 * costo de una corrida es justamente el dato con el que se decide donde corren los agentes.
 */
const MODEL_PRICING: ReadonlyArray<readonly [string, AgentModelPricing]> = [
  ["claude-opus-5", { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 }],
  ["claude-opus-4-8", { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 }],
  ["claude-opus-4-7", { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 }],
  ["claude-opus-4-6", { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: 25 }],
  ["claude-sonnet-5", { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 }],
  ["claude-sonnet-4-6", { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 }],
  ["claude-sonnet-4-5", { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 }],
  ["claude-haiku-4-5", { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 5 }]
];

export function pricingForModel(modelId: string): AgentModelPricing | undefined {
  const normalized = modelId.trim().toLowerCase();
  return MODEL_PRICING.find(([family]) => normalized.includes(family))?.[1];
}

/**
 * Mas alto que los 4096 del chat a proposito.
 *
 * La sesion trata TODO lo que no es tool_use como completado, asi que una respuesta truncada
 * cierra el diagnostico como si estuviera terminado. max_tokens es un techo, no un objetivo: no
 * se paga por lo que no se genera, y el freno de gasto real es el cap de 50.000 por sesion.
 * Subirlo cuesta cero y saca de la mesa el modo de falla caro.
 */
export const DEFAULT_AGENT_MAX_TOKENS = 8_192;

/** Heredado del chat. Mide el input de UNA llamada, que es lo que Bedrock rechaza. */
export const DEFAULT_AGENT_MAX_INPUT_CHARS = 720_000;

/**
 * 59 sesiones x hasta 8 iteraciones son ~472 llamadas por corrida con concurrencia 4. El rate
 * limit no es hipotetico: es el primer muro de la primera corrida real. El chat no lo necesita
 * (un operador, un turno); el abanico si.
 */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 4;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

/** Techo por llamada. Sin esto, un throttle sostenido deja la corrida colgada sin diagnostico. */
export const DEFAULT_CALL_BUDGET_MS = 240_000;

export interface AgentModelDegradation {
  kind:
    | "unknown_stop_reason"
    | "malformed_tool_input"
    | "throttled_retry"
    | "response_truncated";
  detail: string;
  modelId: string;
}

export interface BedrockAgentModelClientOptions {
  client: BedrockRuntimeClientLike;
  modelId: string;
  maxTokens?: number;
  idleTimeoutMs?: number;
  maxInputChars?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  callBudgetMs?: number;
  /** Se reporta lo que degrada la confianza del diagnostico, en vez de tragarselo. */
  onDegradation?: (notice: AgentModelDegradation) => void;
  /** Costuras de test: sin esto un test de backoff tarda segundos de verdad. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Traduce el historial plano de la sesion a bloques de contenido de la Messages API.
 *
 * La sesion produce exactamente tres formas de turno (bedrock-agent-session.ts:305, :323, :344):
 *   (a) user      content=<instrucciones>                -> [text]
 *   (b) assistant content=<texto|"">  toolUses=[...]     -> [text?] + N tool_use
 *   (c) user      content=""          toolResults=[...]  -> N tool_result, sin text
 *
 * La forma (c) es la trampa: la sesion SIEMPRE empuja content:"" despues de despachar tools, y
 * la (b) tambien trae "" cuando el modelo va directo a la tool. Un mapeo literal
 * content -> bloque de texto mete un {type:"text",text:""} en cada sesion que use tools, o sea
 * en todas las utiles. El camino que ya funciona en produccion nunca emite un bloque vacio.
 */
export function toBedrockMessages(turns: readonly AgentModelTurn[]): BedrockMessage[] {
  return turns.map((turn, index) => {
    const content: BedrockContentBlock[] = [];

    if (turn.content !== "") {
      content.push({ type: "text", text: turn.content });
    }
    // Reconstruidos, no re-emitidos: AgentModelTurn es un turno plano, no la forma de la API.
    // Sin esto los tool_result del turno siguiente quedan huerfanos y la request falla en la
    // SEGUNDA iteracion, no en la primera — que es peor, porque ya se pago la primera.
    for (const use of turn.toolUses ?? []) {
      content.push({ type: "tool_use", id: use.toolUseId, name: use.toolName, input: use.toolInput });
    }
    for (const result of turn.toolResults ?? []) {
      content.push({ type: "tool_result", tool_use_id: result.toolUseId, content: result.content });
    }

    if (content.length === 0) {
      // No alcanzable con las tres formas de arriba. Si pasa, es un bug del llamador y mandarlo
      // seria cambiar un error legible por un 400 de Bedrock.
      throw new AgentSessionError(
        "agent_turn_without_content",
        `El turno ${index} (${turn.role}) no tiene texto, ni tool_use, ni tool_result.`
      );
    }

    return { role: turn.role, content };
  });
}

/**
 * Mapea el stop_reason crudo al union de la sesion.
 *
 * `tool_use` solo si HAY tool_use: la sesion corta con
 * `stopReason !== "tool_use" || toolUses.length === 0`, asi que declarar tool_use sin bloques
 * seria pedirle que ejecute nada. Y al reves, un stop_reason desconocido que no mapee a
 * end_turn dejaria tool_use escritos en el historial que jamas se ejecutan.
 */
export function mapStopReason(
  raw: string | undefined,
  toolUseCount: number
): { stopReason: AgentModelInvokeResult["stopReason"]; unknown: boolean } {
  if (toolUseCount > 0) {
    return { stopReason: "tool_use", unknown: false };
  }
  switch (raw) {
    case "tool_use":
      // Declaro tools pero no mando ninguna: no hay nada que ejecutar, el turno termino.
      return { stopReason: "end_turn", unknown: false };
    case "max_tokens":
      return { stopReason: "max_tokens", unknown: false };
    case "end_turn":
    case "stop_sequence":
    case undefined:
      return { stopReason: "end_turn", unknown: false };
    default:
      // No se inventa: se cierra el turno y se reporta, para enterarnos de valores nuevos.
      return { stopReason: "end_turn", unknown: true };
  }
}

/** Throttling y caidas transitorias se reintentan. Un 400 no: reintentarlo es quemar plata. */
export function isRetryableModelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return [
    "ThrottlingException",
    "TooManyRequestsException",
    "ServiceUnavailableException",
    "ServiceQuotaExceededException",
    "ModelTimeoutException",
    "ModelNotReadyException",
    "InternalServerException"
  ].includes(error.name);
}

export class BedrockAgentModelClient implements AgentModelClient {
  readonly modelId: string;
  /** undefined si el modelo no esta en la tabla: mejor "no se" que un numero de otro modelo. */
  readonly pricing: AgentModelPricing | undefined;

  private readonly client: BedrockRuntimeClientLike;
  private readonly maxTokens: number;
  private readonly idleTimeoutMs: number | undefined;
  private readonly maxInputChars: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly callBudgetMs: number;
  private readonly onDegradation: (notice: AgentModelDegradation) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: BedrockAgentModelClientOptions) {
    // modelId es propiedad, no algo que se resuelve en la primera llamada: la sesion lo lee en
    // agent.started y en el snapshot del panel, ambos antes de que invoke() corra.
    this.modelId = options.modelId;
    this.pricing = pricingForModel(options.modelId);
    this.client = options.client;
    this.maxTokens = options.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.maxInputChars = options.maxInputChars ?? DEFAULT_AGENT_MAX_INPUT_CHARS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.callBudgetMs = options.callBudgetMs ?? DEFAULT_CALL_BUDGET_MS;
    this.onDegradation = options.onDegradation ?? (() => {});
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  async invoke(input: AgentModelInvokeInput): Promise<AgentModelInvokeResult> {
    const messages = toBedrockMessages(input.messages);

    // Se mide aca, por llamada, y no una sola vez antes del loop: nada trunca los tool_result en
    // el camino de agentes, y el resultado de inspect_smtp_inventory se re-manda entero en cada
    // iteracion. Un error legible vale mas que un 400 de Bedrock a mitad de una corrida.
    const inputChars = input.system.length + JSON.stringify(messages).length;
    if (inputChars > this.maxInputChars) {
      throw new AgentSessionError(
        "agent_input_too_large",
        `El input de esta llamada mide ${inputChars} chars y el techo es ${this.maxInputChars}.`
      );
    }

    // Presupuesto propio por llamada: hoy la sesion NO pasa abortSignal (bedrock-agent-session.ts:315),
    // asi que si el cliente no pone un techo, una llamada colgada cuelga la sesion, el worker del
    // abanico y la respuesta HTTP entera.
    const budgetController = new AbortController();
    const budgetTimer = setTimeout(() => budgetController.abort(), this.callBudgetMs);
    const signal = input.abortSignal
      ? AbortSignal.any([input.abortSignal, budgetController.signal])
      : budgetController.signal;

    try {
      return await this.invokeWithRetry(input, messages, signal, budgetController);
    } finally {
      clearTimeout(budgetTimer);
    }
  }

  private async invokeWithRetry(
    input: AgentModelInvokeInput,
    messages: BedrockMessage[],
    signal: AbortSignal,
    budgetController: AbortController
  ): Promise<AgentModelInvokeResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await invokeBedrockMessages({
          client: this.client,
          modelId: this.modelId,
          maxTokens: this.maxTokens,
          ...(modelAcceptsSamplingParams(this.modelId) ? { temperature: 0 } : {}),
          ...(this.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.idleTimeoutMs }),
          system: input.system,
          messages,
          tools: input.tools,
          signal
        });

        // Un tool_use con el JSON de parametros cortado se degrada a {} rio abajo. En el chat eso
        // es un error visible; aca una tool de sondeo sin dominio devuelve un veredicto confiado
        // sobre el nodo equivocado. Se falla, no se sondea a ciegas.
        if (response.malformedToolInput && response.malformedToolInput.length > 0) {
          const names = response.malformedToolInput.map((entry) => entry.name).join(", ");
          this.onDegradation({
            kind: "malformed_tool_input",
            detail: `Parametros incompletos para: ${names}.`,
            modelId: this.modelId
          });
          throw new AgentSessionError(
            "agent_tool_input_malformed",
            `El modelo corto el JSON de parametros de: ${names}. Sondear con parametros vacios daria un veredicto falso.`
          );
        }

        const toolUses = response.content.filter(isToolUseBlock).map((block) => ({
          toolUseId: block.id,
          toolName: block.name,
          toolInput: block.input
        }));

        const { stopReason, unknown } = mapStopReason(response.stopReason, toolUses.length);
        if (unknown) {
          this.onDegradation({
            kind: "unknown_stop_reason",
            detail: `stop_reason "${String(response.stopReason)}" no esta mapeado; se cerro como end_turn.`,
            modelId: this.modelId
          });
        }
        if (stopReason === "max_tokens") {
          // La sesion trata todo lo que no es tool_use como completado, asi que sin este aviso un
          // diagnostico truncado se reporta como terminado.
          this.onDegradation({
            kind: "response_truncated",
            detail: `La respuesta se corto en max_tokens (${this.maxTokens}); el veredicto puede estar incompleto.`,
            modelId: this.modelId
          });
        }

        // Sin usage no hay contabilidad, y sin contabilidad el cap de 50.000 tokens por sesion
        // queda desactivado en silencio: es el UNICO freno de gasto que existe. Un 0 inventado
        // seria peor que un error.
        const inputTokens = finiteTokens(response.inputTokens);
        const outputTokens = finiteTokens(response.outputTokens);
        if (inputTokens === undefined || outputTokens === undefined) {
          throw new AgentSessionError(
            "agent_usage_missing",
            "Bedrock no devolvio usage. Sin tokens reales el cap por sesion queda desactivado."
          );
        }

        return {
          text: response.text,
          toolUses,
          inputTokens,
          outputTokens,
          stopReason
        };
      } catch (error) {
        lastError = error;

        // Abortado por el operador o por el presupuesto: se corta. Devolver stopReason "aborted"
        // haria que la sesion lo CIERRE como completado (bedrock-agent-session.ts:335), o sea
        // exito reportado sobre un diagnostico que nunca ocurrio.
        if (input.abortSignal?.aborted) {
          throw new AgentSessionError("agent_invoke_aborted", "La llamada al modelo fue abortada.");
        }
        if (budgetController.signal.aborted) {
          throw new AgentSessionError(
            "agent_call_budget_exhausted",
            `La llamada al modelo supero ${this.callBudgetMs}ms.`
          );
        }
        if (error instanceof AgentSessionError) throw error;
        if (!isRetryableModelError(error) || attempt === this.maxAttempts) throw error;

        // Backoff exponencial con jitter: sin jitter los 4 workers del abanico reintentan
        // sincronizados y vuelven a chocar contra el mismo rate limit, todos juntos.
        const delayMs = Math.round(this.retryBaseDelayMs * 2 ** (attempt - 1) * (0.5 + this.random()));
        this.onDegradation({
          kind: "throttled_retry",
          detail: `Intento ${attempt}/${this.maxAttempts} fallo con ${(error as Error).name}; reintento en ${delayMs}ms.`,
          modelId: this.modelId
        });
        await this.sleep(delayMs);
      }
    }

    throw lastError;
  }
}

export interface CreateBedrockAgentModelClientInput {
  env?: Record<string, string | undefined>;
  /** Inyectable para test. Sin esto se construye un BedrockRuntimeClient real. */
  client?: BedrockRuntimeClientLike;
  onDegradation?: (notice: AgentModelDegradation) => void;
}

/**
 * Construye el cliente desde el entorno.
 *
 * Presupuestos separados del chat a proposito: MULTI_AGENT_* propio, con AWS_BEDROCK_* como
 * respaldo solo para lo que es de la cuenta (region, credenciales, modelo). Atar el max_tokens
 * del abanico al del chat significa que tocar uno mueve el otro sin querer.
 */
export function createBedrockAgentModelClient(
  input: CreateBedrockAgentModelClientInput = {}
): BedrockAgentModelClient {
  const env = input.env ?? process.env;

  const modelId = trimmed(env.MULTI_AGENT_MODEL_ID) ?? trimmed(env.AWS_BEDROCK_MODEL_ID);
  if (!modelId) {
    throw new AgentSessionError(
      "agent_model_id_missing",
      "Falta MULTI_AGENT_MODEL_ID (o AWS_BEDROCK_MODEL_ID) para el runtime de agentes."
    );
  }

  const client = input.client ?? buildRuntimeClient(env);

  return new BedrockAgentModelClient({
    client,
    modelId,
    maxTokens: positiveInt(env.MULTI_AGENT_MAX_TOKENS) ?? DEFAULT_AGENT_MAX_TOKENS,
    ...(positiveInt(env.MULTI_AGENT_IDLE_TIMEOUT_MS) === undefined
      ? {}
      : { idleTimeoutMs: positiveInt(env.MULTI_AGENT_IDLE_TIMEOUT_MS)! }),
    maxAttempts: positiveInt(env.MULTI_AGENT_MAX_ATTEMPTS) ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    callBudgetMs: positiveInt(env.MULTI_AGENT_CALL_BUDGET_MS) ?? DEFAULT_CALL_BUDGET_MS,
    ...(input.onDegradation ? { onDegradation: input.onDegradation } : {})
  });
}

function buildRuntimeClient(env: Record<string, string | undefined>): BedrockRuntimeClientLike {
  const region = trimmed(env.AWS_BEDROCK_REGION) ?? "us-east-1";
  const bearerToken = trimmed(env.AWS_BEARER_TOKEN_BEDROCK);
  const accessKeyId = trimmed(env.AWS_BEDROCK_ACCESS_KEY_ID);
  const secretAccessKey = trimmed(env.AWS_BEDROCK_SECRET_ACCESS_KEY);

  // En el bridge esto es un else-if: con bearer presente, las access keys NUNCA se evaluan y
  // authSchemePreference apaga SigV4. Se conserva la precedencia pero explicita, para que
  // configurar las dos no sea una sorpresa silenciosa.
  const config: BedrockRuntimeClientConfig = { region };
  if (bearerToken) {
    (config as BedrockRuntimeClientConfig & { token?: { token: string } }).token = { token: bearerToken };
    config.authSchemePreference = ["httpBearerAuth"];
  } else if (accessKeyId && secretAccessKey) {
    config.credentials = {
      accessKeyId,
      secretAccessKey,
      ...(trimmed(env.AWS_BEDROCK_SESSION_TOKEN) ? { sessionToken: trimmed(env.AWS_BEDROCK_SESSION_TOKEN)! } : {})
    };
  } else {
    throw new AgentSessionError(
      "agent_model_credentials_missing",
      "Faltan credenciales de Bedrock: AWS_BEARER_TOKEN_BEDROCK, o AWS_BEDROCK_ACCESS_KEY_ID + AWS_BEDROCK_SECRET_ACCESS_KEY."
    );
  }

  return new BedrockRuntimeClient(config);
}

function finiteTokens(value: number | undefined): number | undefined {
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

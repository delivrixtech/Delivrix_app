// Un turno contra la Messages API de Anthropic sobre Bedrock. UNA sola implementacion del cable.
//
// Esto vivia adentro de OpenClawBedrockBridge como metodo privado. Sale de ahi porque el runtime
// de agentes necesita el mismo turno y la alternativa era escribir un segundo invoke. Dos copias
// del mismo cable divergen y despues una de las dos miente: es exactamente lo que paso con el
// verificador de propiedad de nodos que corria fuera del camino de produccion y dio por ajenos a
// 14 nodos vivos. El invariante va donde va el efecto.
//
// Lo que este modulo SI hace: arma el payload, abre el stream, lo parsea, y corta por idle.
// Lo que NO hace, a proposito: loop de tools, historial, contexto vivo, canvas, auditoria. Todo
// eso es del llamador. Aca solo hay request y response de un turno.

import {
  InvokeModelWithResponseStreamCommand,
  type InvokeModelWithResponseStreamCommandInput
} from "@aws-sdk/client-bedrock-runtime";

/** Default heredado del bridge: sin esto un stream colgado deja el chat en spinner (incidente 2026-07-02). */
export const DEFAULT_BEDROCK_IDLE_TIMEOUT_MS = 90_000;

/**
 * Familias de modelo que TODAVIA aceptan `temperature` / `top_p` / `top_k`.
 *
 * De Claude Opus 4.7 y Sonnet 5 en adelante esos parametros fueron removidos de la API y
 * mandarlos devuelve `400 invalid_request_error`. La lista es de lo que ACEPTA, no de lo que
 * rechaza, a proposito: un modelo desconocido —o sea, uno mas nuevo— cae del lado de omitir.
 * Equivocarse omitiendo cambia levemente el sampling; equivocarse mandando rompe todas las
 * llamadas.
 */
const MODEL_FAMILIES_WITH_SAMPLING_PARAMS = [
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-opus-4-20",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-0",
  "claude-sonnet-4-20",
  "claude-haiku-4-5",
  "claude-3-"
] as const;

/**
 * Los ids de Bedrock llevan prefijos (`anthropic.`, y perfiles de inferencia cross-region como
 * `us.`), asi que se busca la familia dentro del id en vez de comparar por igualdad.
 */
export function modelAcceptsSamplingParams(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return MODEL_FAMILIES_WITH_SAMPLING_PARAMS.some((family) => normalized.includes(family));
}

export type BedrockMessageRole = "user" | "assistant";

export type BedrockContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface BedrockMessage {
  role: BedrockMessageRole;
  content: BedrockContentBlock[];
}

export interface BedrockToolSpecLike {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Lo que el modelo puede devolver: solo texto y tool_use.
 *
 * Es a proposito mas angosto que BedrockContentBlock. image y tool_result son bloques que se
 * MANDAN, nunca que se reciben, y tiparlos como posibles obligaria a todos los llamadores a
 * descartar ramas que no existen.
 */
export type BedrockResponseBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface BedrockParsedResponse {
  content: BedrockResponseBlock[];
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  /**
   * Un tool_use cuyo input_json_delta no cerro en JSON valido.
   *
   * El llamador decide: el chat puede seguir con input {} y que el operador vea el error; el
   * abanico NO puede, porque una tool de sondeo con parametros vacios devuelve un veredicto
   * confiado sobre el nodo equivocado.
   */
  malformedToolInput?: Array<{ id: string; name: string; partialJson: string }>;
}

interface BedrockStreamChunk {
  chunk?: {
    bytes?: Uint8Array;
  };
}

/** Costura de inyeccion: permite testear el mapeo y el parseo sin red ni credenciales. */
export interface BedrockRuntimeClientLike {
  send(command: InvokeModelWithResponseStreamCommand, options?: { abortSignal?: AbortSignal }): Promise<{
    body?: AsyncIterable<BedrockStreamChunk> | Iterable<BedrockStreamChunk>;
  }>;
}

export class BedrockInvokeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BedrockInvokeError";
    this.code = code;
  }
}

export interface InvokeBedrockMessagesInput {
  client: BedrockRuntimeClientLike;
  modelId: string;
  maxTokens: number;
  /** Se manda SOLO si el llamador ya verifico que el modelo lo acepta. undefined = no va en el payload. */
  temperature?: number;
  idleTimeoutMs?: number;
  system: string;
  messages: BedrockMessage[];
  tools: BedrockToolSpecLike[];
  signal?: AbortSignal;
}

/**
 * Invoca el modelo una vez y devuelve la respuesta completa.
 *
 * El idle-timeout se re-arma con cada chunk: mide silencio del stream, no duracion total. Se
 * encadena al signal del llamador, asi que un interrupt manual sigue funcionando.
 */
export async function invokeBedrockMessages(
  input: InvokeBedrockMessagesInput
): Promise<BedrockParsedResponse> {
  const idleTimeoutMs = input.idleTimeoutMs ?? DEFAULT_BEDROCK_IDLE_TIMEOUT_MS;

  const payload: Record<string, unknown> = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: input.maxTokens,
    system: input.system,
    messages: input.messages
  };
  // temperature es decision del llamador: de Opus 4.7 / Sonnet 5 en adelante el parametro fue
  // removido de la API y mandarlo devuelve 400. Aca solo se respeta lo que ya se decidio.
  if (input.temperature !== undefined) {
    payload.temperature = input.temperature;
  }
  // tools:[] no es lo mismo que omitir la clave. Los roles sin tools declaradas son un estado
  // normal, no un bug, y el camino probado omite las dos claves en ese caso.
  if (input.tools.length > 0) {
    payload.tools = input.tools;
    payload.tool_choice = { type: "auto" };
  }

  const command = new InvokeModelWithResponseStreamCommand({
    modelId: input.modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(payload)
  } satisfies InvokeModelWithResponseStreamCommandInput);

  const idleController = new AbortController();
  const combinedSignal = input.signal
    ? AbortSignal.any([input.signal, idleController.signal])
    : idleController.signal;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idleController.abort(), idleTimeoutMs);
  };

  const content = new Map<number, MutableBedrockContentBlock>();
  let currentIndex = 0;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: string | undefined;

  try {
    armIdle();
    const result = await input.client.send(command, { abortSignal: combinedSignal });

    for await (const event of toAsyncIterable(result.body ?? [])) {
      armIdle();
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
        // OJO con el nivel. En message_delta el `usage` viaja en la RAIZ pero `stop_reason` viaja
        // DENTRO de `delta`:
        //   {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":N}}
        // Leerlo de la raiz —como se hacia— daba undefined en toda corrida real. El bug quedo
        // latente durante meses porque el unico consumidor, el chat, nunca miraba stopReason;
        // el primero que lo mira es el cliente de agentes, y sin esto su cadena `truncated`
        // entera es codigo muerto: un veredicto cortado a la mitad se reporta como concluido.
        // Se conserva la lectura de la raiz como respaldo: no cuesta y tolera variantes.
        const delta = isRecord(parsed.delta) ? parsed.delta : undefined;
        stopReason =
          stringValue(delta?.stop_reason) ??
          stringValue(parsed.stop_reason) ??
          stringValue(parsed.stopReason) ??
          stopReason;
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

    const ordered = [...content.entries()].sort(([left], [right]) => left - right);
    const blocks = ordered.map(([, block]) => finalizeContentBlock(block));
    // El JSON roto se REPORTA, no se maquilla. finalizeContentBlock degrada a {} para no romper
    // el chat; quien no pueda tolerar esa degradacion lo ve aca y decide.
    const malformed = ordered
      .map(([, block]) => block)
      .filter((block): block is Extract<MutableBedrockContentBlock, { type: "tool_use" }> =>
        block.type === "tool_use" && block.partialJson.trim().length > 0 && parseJson(block.partialJson) === null)
      .map((block) => ({ id: block.id, name: block.name, partialJson: block.partialJson }));

    return {
      content: blocks,
      text: blocks.filter(isTextBlock).map((block) => block.text).join(""),
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(stopReason ? { stopReason } : {}),
      ...(malformed.length > 0 ? { malformedToolInput: malformed } : {})
    };
  } catch (error) {
    // Idle-timeout propio (no interrupt del llamador) => error con codigo propio.
    if (idleController.signal.aborted && !(input.signal?.aborted)) {
      throw new BedrockInvokeError(
        "bedrock_call_idle_timeout",
        `Bedrock stream idle > ${idleTimeoutMs}ms; llamada abortada.`
      );
    }
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

type MutableBedrockContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; partialJson: string };

function finalizeContentBlock(block: MutableBedrockContentBlock): BedrockResponseBlock {
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

export function isTextBlock(block: BedrockResponseBlock): block is Extract<BedrockResponseBlock, { type: "text" }> {
  return block.type === "text";
}

export function isToolUseBlock(block: BedrockResponseBlock): block is Extract<BedrockResponseBlock, { type: "tool_use" }> {
  return block.type === "tool_use";
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BedrockInvokeError("bedrock_invoke_aborted", "Bedrock invocation aborted by operator.");
  }
}

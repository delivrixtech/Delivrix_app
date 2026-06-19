// Cliente LLM via AWS Bedrock (Claude). Reemplaza la API directa de Anthropic:
// usa el rol IAM del Lambda (SigV4), sin API key. Misma interfaz que el cliente
// Anthropic (invokeStructured con tool_use forzado) para no tocar el orquestador.
// El SDK lo provee el runtime de Lambda; este modulo no lo importan los tests.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { InvokeStructuredInput, InvokeStructuredResult } from "../anthropic/client.ts";
import { log } from "../logging.ts";

const ANTHROPIC_BEDROCK_VERSION = "bedrock-2023-05-31";

export type BedrockClientOptions = {
  modelId: string;
  region?: string;
  client?: BedrockRuntimeClient;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBedrockClient(options: BedrockClientOptions) {
  const client = options.client ?? new BedrockRuntimeClient({ region: options.region });
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? defaultSleep;

  async function invokeStructured(input: InvokeStructuredInput): Promise<InvokeStructuredResult> {
    // Cuerpo Messages API en formato Bedrock (sin "model"; va anthropic_version).
    const body = {
      anthropic_version: ANTHROPIC_BEDROCK_VERSION,
      max_tokens: input.maxTokens,
      system: input.system,
      tools: [
        { name: input.toolName, description: input.toolDescription, input_schema: input.toolSchema }
      ],
      tool_choice: { type: "tool", name: input.toolName },
      messages: [{ role: "user", content: input.userContent }]
    };

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await client.send(
          new InvokeModelCommand({
            modelId: options.modelId,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(body)
          })
        );
        const json: any = JSON.parse(new TextDecoder().decode(response.body));
        const block = Array.isArray(json.content)
          ? json.content.find((part: any) => part?.type === "tool_use" && part?.name === input.toolName)
          : undefined;
        if (!block) {
          return { ok: false, error: "bedrock_no_tool_use_block" };
        }
        return {
          ok: true,
          data: block.input,
          usage: {
            inputTokens: Number(json.usage?.input_tokens ?? 0),
            outputTokens: Number(json.usage?.output_tokens ?? 0)
          }
        };
      } catch (cause: any) {
        const name = cause?.name ?? "";
        const status = cause?.$metadata?.httpStatusCode ?? 0;
        const retryable = name === "ThrottlingException" || name === "ModelTimeoutException" || status >= 500;
        if (!retryable || attempt === maxRetries) {
          return { ok: false, error: `bedrock_error: ${name || String(cause)}` };
        }
        log.warn("bedrock_retry", { name, status, attempt });
        await sleep(750 * 2 ** attempt);
      }
    }
    return { ok: false, error: "bedrock_retries_exhausted" };
  }

  return { invokeStructured };
}

export type BedrockClient = ReturnType<typeof createBedrockClient>;

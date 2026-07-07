// Cliente de la Messages API de Anthropic con fetch nativo (cero dependencias).
// Forzamos tool_use (tool_choice) para obtener JSON estructurado y validable en
// vez de parsear texto/markdown. fetchImpl/sleep inyectables para tests.

import { log } from "../logging.ts";

const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type InvokeStructuredInput = {
  system: string;
  userContent: string;
  toolName: string;
  toolDescription: string;
  toolSchema: Record<string, unknown>;
  maxTokens: number;
};

export type InvokeStructuredResult =
  | { ok: true; data: unknown; usage: AnthropicUsage }
  | { ok: false; error: string };

export type AnthropicClientOptions = {
  apiKey: string;
  model: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAnthropicClient(options: AnthropicClientOptions) {
  const apiBase = (options.apiBase ?? "https://api.anthropic.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? defaultSleep;

  async function invokeStructured(input: InvokeStructuredInput): Promise<InvokeStructuredResult> {
    const payload = {
      model: options.model,
      max_tokens: input.maxTokens,
      system: input.system,
      tools: [
        {
          name: input.toolName,
          description: input.toolDescription,
          input_schema: input.toolSchema
        }
      ],
      tool_choice: { type: "tool", name: input.toolName },
      messages: [{ role: "user", content: input.userContent }]
    };

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(`${apiBase}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": options.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json"
          },
          body: JSON.stringify(payload)
        });
      } catch (cause) {
        if (attempt === maxRetries) {
          return { ok: false, error: `anthropic_network_error: ${String(cause)}` };
        }
        await sleep(750 * 2 ** attempt);
        continue;
      }

      if (response.ok) {
        const json: any = await response.json();
        const block = Array.isArray(json.content)
          ? json.content.find((part: any) => part?.type === "tool_use" && part?.name === input.toolName)
          : undefined;
        if (!block) {
          return { ok: false, error: "anthropic_no_tool_use_block" };
        }
        return {
          ok: true,
          data: block.input,
          usage: {
            inputTokens: Number(json.usage?.input_tokens ?? 0),
            outputTokens: Number(json.usage?.output_tokens ?? 0)
          }
        };
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) {
        const detail = await response.text().catch(() => "");
        return { ok: false, error: `anthropic_http_${response.status}: ${detail.slice(0, 300)}` };
      }
      const backoffMs = 750 * 2 ** attempt;
      log.warn("anthropic_retry", { status: response.status, attempt, backoffMs });
      await sleep(backoffMs);
    }
    return { ok: false, error: "anthropic_retries_exhausted" };
  }

  return { invokeStructured };
}

export type AnthropicClient = ReturnType<typeof createAnthropicClient>;

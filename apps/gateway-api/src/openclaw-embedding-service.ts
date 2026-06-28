// Embedding service for OpenClaw semantic memory.
//
// Turns text into a 1024-dim vector via AWS Bedrock, mirroring the exact
// credential/region resolution used by `openclaw-bedrock-bridge.ts`
// (bearer token OR accessKey/secret/session, region from env). Supports the
// Titan and Cohere embedding families; both can emit 1024-dim vectors that fit
// the `openclaw_memory_vectors.embedding vector(1024)` column.
//
// If embeddings are not configured the service reports `enabled: false` and
// callers fall back to full-text-only memory — so nothing breaks when Bedrock
// embeddings are absent.

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type BedrockRuntimeClientConfig
} from "@aws-sdk/client-bedrock-runtime";

export const EMBEDDING_DIMENSIONS = 1024;

const DEFAULT_EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";
const DEFAULT_EMBEDDING_REGION = "us-east-1";
const MAX_EMBED_INPUT_CHARS = 8000;

export class EmbeddingServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EmbeddingServiceError";
    this.code = code;
  }
}

export interface EmbeddingInvokeResponse {
  body?: Uint8Array | string | { transformToString?: () => Promise<string> };
}

export interface EmbeddingClientLike {
  send(command: InvokeModelCommand): Promise<EmbeddingInvokeResponse>;
}

export interface EmbeddingServiceConfig {
  modelId?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  bearerToken?: string;
  /** Inject a fake client in tests. */
  client?: EmbeddingClientLike;
}

export interface EmbeddingService {
  readonly enabled: boolean;
  readonly modelId: string;
  embed(text: string): Promise<number[]>;
}

export function createEmbeddingService(config: EmbeddingServiceConfig = {}): EmbeddingService {
  const modelId = (config.modelId ?? DEFAULT_EMBEDDING_MODEL_ID).trim();
  const hasCredentials = Boolean(
    config.client ||
      config.bearerToken ||
      (config.accessKeyId && config.secretAccessKey)
  );
  const enabled = modelId.length > 0 && hasCredentials;

  let client: EmbeddingClientLike | undefined = config.client;
  const ensureClient = (): EmbeddingClientLike => {
    if (client) return client;
    const clientConfig: BedrockRuntimeClientConfig = {
      region: config.region ?? DEFAULT_EMBEDDING_REGION
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
    client = new BedrockRuntimeClient(clientConfig);
    return client;
  };

  return {
    enabled,
    modelId,
    async embed(text: string): Promise<number[]> {
      if (!enabled) {
        throw new EmbeddingServiceError(
          "embedding_disabled",
          "Embedding service is not configured (missing Bedrock credentials or model id)."
        );
      }
      const input = normalizeInput(text);
      const command = new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(buildRequestBody(modelId, input))
      });
      const response = await ensureClient().send(command);
      const parsed = parseResponseBody(await readBody(response.body));
      const vector = extractEmbedding(modelId, parsed);
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingServiceError(
          "embedding_dimension_mismatch",
          `Embedding model returned ${vector.length} dims; expected ${EMBEDDING_DIMENSIONS}.`
        );
      }
      return vector;
    }
  };
}

export function embeddingServiceFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): EmbeddingService {
  return createEmbeddingService({
    ...(normalizeEnvValue(env.AWS_BEDROCK_EMBEDDING_MODEL_ID) !== undefined
      ? { modelId: normalizeEnvValue(env.AWS_BEDROCK_EMBEDDING_MODEL_ID) }
      : {}),
    ...(normalizeEnvValue(env.AWS_BEDROCK_REGION) !== undefined
      ? { region: normalizeEnvValue(env.AWS_BEDROCK_REGION) }
      : {}),
    ...(normalizeEnvValue(env.AWS_BEDROCK_ACCESS_KEY_ID) !== undefined
      ? { accessKeyId: normalizeEnvValue(env.AWS_BEDROCK_ACCESS_KEY_ID) }
      : {}),
    ...(normalizeEnvValue(env.AWS_BEDROCK_SECRET_ACCESS_KEY) !== undefined
      ? { secretAccessKey: normalizeEnvValue(env.AWS_BEDROCK_SECRET_ACCESS_KEY) }
      : {}),
    ...(normalizeEnvValue(env.AWS_BEDROCK_SESSION_TOKEN) !== undefined
      ? { sessionToken: normalizeEnvValue(env.AWS_BEDROCK_SESSION_TOKEN) }
      : {}),
    ...(normalizeEnvValue(env.AWS_BEARER_TOKEN_BEDROCK) !== undefined
      ? { bearerToken: normalizeEnvValue(env.AWS_BEARER_TOKEN_BEDROCK) }
      : {})
  });
}

// --- internals -------------------------------------------------------------

function normalizeInput(text: string): string {
  if (typeof text !== "string") {
    throw new EmbeddingServiceError("invalid_text", "embed(text) requires a string.");
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new EmbeddingServiceError("invalid_text", "embed(text) requires non-empty text.");
  }
  return trimmed.slice(0, MAX_EMBED_INPUT_CHARS);
}

function isCohere(modelId: string): boolean {
  return modelId.toLowerCase().includes("cohere");
}

function buildRequestBody(modelId: string, input: string): Record<string, unknown> {
  if (isCohere(modelId)) {
    return {
      texts: [input],
      input_type: "search_document",
      embedding_types: ["float"]
    };
  }
  // Titan Text Embeddings v2 (and v1-compatible) shape.
  return {
    inputText: input,
    dimensions: EMBEDDING_DIMENSIONS,
    normalize: true
  };
}

function extractEmbedding(modelId: string, parsed: Record<string, unknown>): number[] {
  if (isCohere(modelId)) {
    const embeddings = parsed.embeddings as unknown;
    const float =
      embeddings && typeof embeddings === "object" && !Array.isArray(embeddings)
        ? (embeddings as { float?: unknown }).float
        : embeddings;
    const first = Array.isArray(float) ? (float as unknown[])[0] : undefined;
    return asNumberArray(first, "cohere embeddings.float[0]");
  }
  return asNumberArray(parsed.embedding, "titan embedding");
}

function asNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new EmbeddingServiceError("embedding_parse_failed", `Could not read ${label} from model response.`);
  }
  for (const component of value) {
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new EmbeddingServiceError("embedding_parse_failed", `${label} contained a non-finite value.`);
    }
  }
  return value as number[];
}

function parseResponseBody(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("not an object");
  } catch {
    throw new EmbeddingServiceError("embedding_parse_failed", "Model response body was not a JSON object.");
  }
}

async function readBody(
  body: Uint8Array | string | { transformToString?: () => Promise<string> } | undefined
): Promise<string> {
  if (body === undefined || body === null) {
    throw new EmbeddingServiceError("embedding_parse_failed", "Model response had no body.");
  }
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (typeof body.transformToString === "function") return body.transformToString();
  throw new EmbeddingServiceError("embedding_parse_failed", "Unsupported model response body type.");
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

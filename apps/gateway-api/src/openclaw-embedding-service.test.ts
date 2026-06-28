import assert from "node:assert/strict";
import test from "node:test";
import { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  createEmbeddingService,
  embeddingServiceFromEnv,
  EmbeddingServiceError,
  EMBEDDING_DIMENSIONS,
  type EmbeddingClientLike,
  type EmbeddingInvokeResponse
} from "./openclaw-embedding-service.ts";

const vec = (n: number = EMBEDDING_DIMENSIONS): number[] => Array.from({ length: n }, (_, i) => (i % 11) / 11);

class FakeEmbeddingClient implements EmbeddingClientLike {
  readonly sent: InvokeModelCommand[] = [];
  private readonly responder: (command: InvokeModelCommand) => EmbeddingInvokeResponse;

  constructor(responder: (command: InvokeModelCommand) => EmbeddingInvokeResponse) {
    this.responder = responder;
  }

  async send(command: InvokeModelCommand): Promise<EmbeddingInvokeResponse> {
    this.sent.push(command);
    return this.responder(command);
  }
}

function requestBodyOf(command: InvokeModelCommand): Record<string, unknown> {
  return JSON.parse(String((command.input as { body?: unknown }).body ?? "{}"));
}

test("Titan: embed builds the Titan request and parses { embedding }", async () => {
  const client = new FakeEmbeddingClient(() => ({ body: JSON.stringify({ embedding: vec() }) }));
  const service = createEmbeddingService({ modelId: "amazon.titan-embed-text-v2:0", client });

  assert.equal(service.enabled, true);
  const out = await service.embed("bizreport cayó en spam con 10/10");

  assert.equal(out.length, EMBEDDING_DIMENSIONS);
  const body = requestBodyOf(client.sent[0]);
  assert.equal(body.inputText, "bizreport cayó en spam con 10/10");
  assert.equal(body.dimensions, EMBEDDING_DIMENSIONS);
  assert.equal(body.normalize, true);
});

test("Cohere: embed builds the Cohere request and parses embeddings.float[0]", async () => {
  const client = new FakeEmbeddingClient(() => ({ body: JSON.stringify({ embeddings: { float: [vec()] } }) }));
  const service = createEmbeddingService({ modelId: "cohere.embed-multilingual-v3", client });

  const out = await service.embed("plan de warmup");

  assert.equal(out.length, EMBEDDING_DIMENSIONS);
  const body = requestBodyOf(client.sent[0]);
  assert.deepEqual(body.texts, ["plan de warmup"]);
  assert.equal(body.input_type, "search_document");
  assert.deepEqual(body.embedding_types, ["float"]);
});

test("embed rejects a dimension mismatch from the model", async () => {
  const client = new FakeEmbeddingClient(() => ({ body: JSON.stringify({ embedding: vec(512) }) }));
  const service = createEmbeddingService({ modelId: "amazon.titan-embed-text-v2:0", client });

  await assert.rejects(
    () => service.embed("x"),
    (error: unknown) =>
      error instanceof EmbeddingServiceError && error.code === "embedding_dimension_mismatch"
  );
});

test("embed is disabled when no credentials are configured", async () => {
  const service = createEmbeddingService({ modelId: "amazon.titan-embed-text-v2:0" });

  assert.equal(service.enabled, false);
  await assert.rejects(
    () => service.embed("x"),
    (error: unknown) => error instanceof EmbeddingServiceError && error.code === "embedding_disabled"
  );
});

test("embed rejects empty text", async () => {
  const client = new FakeEmbeddingClient(() => ({ body: JSON.stringify({ embedding: vec() }) }));
  const service = createEmbeddingService({ modelId: "amazon.titan-embed-text-v2:0", client });

  await assert.rejects(
    () => service.embed("   "),
    (error: unknown) => error instanceof EmbeddingServiceError && error.code === "invalid_text"
  );
});

test("embed decodes a Uint8Array response body", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ embedding: vec() }));
  const client = new FakeEmbeddingClient(() => ({ body: bytes }));
  const service = createEmbeddingService({ modelId: "amazon.titan-embed-text-v2:0", client });

  const out = await service.embed("x");
  assert.equal(out.length, EMBEDDING_DIMENSIONS);
});

test("embeddingServiceFromEnv enables with Bedrock creds and disables without", () => {
  const withCreds = embeddingServiceFromEnv({
    AWS_BEDROCK_EMBEDDING_MODEL_ID: "amazon.titan-embed-text-v2:0",
    AWS_BEDROCK_ACCESS_KEY_ID: "AKIAEXAMPLE",
    AWS_BEDROCK_SECRET_ACCESS_KEY: "secret-example"
  });
  assert.equal(withCreds.enabled, true);

  const without = embeddingServiceFromEnv({});
  assert.equal(without.enabled, false);
});

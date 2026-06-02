import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  readRequestBody,
  RequestBodyTooLargeError
} from "./request-body.ts";

test("readRequestBody returns trimmed body inside the byte cap", async () => {
  const body = await readRequestBody(request("  {\"ok\":true}  "), { maxBytes: 32 });

  assert.equal(body, "{\"ok\":true}");
});

test("readRequestBody can preserve raw whitespace for HMAC verification", async () => {
  const body = await readRequestBody(request("  {\"ok\":true}  "), {
    maxBytes: 32,
    trim: false
  });

  assert.equal(body, "  {\"ok\":true}  ");
});

test("readRequestBody fails closed with 413 metadata when body exceeds cap", async () => {
  await assert.rejects(
    () => readRequestBody(request("0123456789"), { maxBytes: 4 }),
    (error) =>
      error instanceof RequestBodyTooLargeError &&
      error.statusCode === 413 &&
      error.code === "request_body_too_large" &&
      error.maxBytes === 4 &&
      error.receivedBytes === 10
  );
});

test("readRequestBody rejects oversized content-length before reading chunks", async () => {
  await assert.rejects(
    () => readRequestBody(request("{}", { "content-length": "100" }), { maxBytes: 8 }),
    (error) =>
      error instanceof RequestBodyTooLargeError &&
      error.maxBytes === 8 &&
      error.receivedBytes === 100
  );
});

function request(body: string, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([body]), {
    method: "POST",
    url: "/",
    headers
  }) as IncomingMessage;
}

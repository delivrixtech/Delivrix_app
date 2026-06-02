import type { IncomingMessage } from "node:http";

export const defaultMaxRequestBodyBytes = 1_048_576;

export class RequestBodyTooLargeError extends Error {
  readonly statusCode = 413;
  readonly code = "request_body_too_large";
  readonly maxBytes: number;
  readonly receivedBytes: number;

  constructor(
    maxBytes: number,
    receivedBytes: number
  ) {
    super(`Request body exceeds the ${maxBytes} byte limit.`);
    this.name = "RequestBodyTooLargeError";
    this.maxBytes = maxBytes;
    this.receivedBytes = receivedBytes;
  }
}

export async function readRequestBody(
  request: IncomingMessage,
  options: { maxBytes?: number; trim?: boolean } = {}
): Promise<string> {
  const maxBytes = positiveIntegerOrDefault(options.maxBytes, defaultMaxRequestBodyBytes);
  const declaredBytes = contentLength(request);
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes, declaredBytes);
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxBytes) {
      throw new RequestBodyTooLargeError(maxBytes, receivedBytes);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return options.trim === false ? raw : raw.trim();
}

export function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function contentLength(request: IncomingMessage): number | null {
  const header = request.headers["content-length"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

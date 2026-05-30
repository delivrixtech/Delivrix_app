import { Readable } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

export interface CapturedInternalHttpResponse {
  statusCode: number;
  headers: Record<string, number | string | string[]>;
  body: unknown;
  rawBody: string;
  ended: boolean;
}

export function createInternalHttpAdapter(input: {
  body?: unknown;
  method?: string;
  url?: string;
  headers?: IncomingHttpHeaders;
}): {
  request: IncomingMessage;
  response: ServerResponse;
  getResponse: () => CapturedInternalHttpResponse;
} {
  const rawBody = input.body === undefined ? "" : JSON.stringify(input.body);
  const request = Readable.from(rawBody ? [Buffer.from(rawBody, "utf8")] : []) as IncomingMessage;
  request.method = input.method ?? "POST";
  request.url = input.url ?? "/";
  request.headers = {
    "content-type": "application/json",
    ...(input.headers ?? {})
  };

  let statusCode = 200;
  const headers: Record<string, number | string | string[]> = {};
  const chunks: Buffer[] = [];
  let ended = false;

  const response = {
    writeHead(code: number, nextHeaders?: Record<string, number | string | string[]>) {
      statusCode = code;
      Object.assign(headers, nextHeaders ?? {});
      return response;
    },
    setHeader(name: string, value: number | string | string[]) {
      headers[name.toLowerCase()] = value;
      return response;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    write(chunk: unknown) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
      }
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
      }
      ended = true;
      return response;
    }
  } as ServerResponse;

  const getResponse = (): CapturedInternalHttpResponse => {
    const raw = Buffer.concat(chunks).toString("utf8");
    return {
      statusCode,
      headers,
      rawBody: raw,
      body: parseJsonOrText(raw),
      ended
    };
  };

  return { request, response, getResponse };
}

function parseJsonOrText(raw: string): unknown {
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

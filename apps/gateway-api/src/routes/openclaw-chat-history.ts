import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeConversationId,
  OPENCLAW_CHAT_SESSION_KEY
} from "../openclaw-chat.ts";
import { OpenClawChatHistoryStore } from "../services/openclaw-chat-history-store.ts";

export interface OpenClawChatHistoryRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  store: OpenClawChatHistoryStore;
  readBoundaryToken: string;
}

export async function handleOpenClawChatConversationsHttp(deps: OpenClawChatHistoryRouteDependencies): Promise<void> {
  if (!authorizeSensitiveRead(deps.request, deps.readBoundaryToken)) {
    json(deps.response, 401, {
      error: "openclaw_chat_history_unauthorized",
      message: "Missing or invalid read-boundary token."
    });
    return;
  }

  json(deps.response, 200, {
    conversations: await deps.store.listConversations()
  });
}

export async function handleOpenClawChatHistoryHttp(deps: OpenClawChatHistoryRouteDependencies): Promise<void> {
  if (!authorizeSensitiveRead(deps.request, deps.readBoundaryToken)) {
    json(deps.response, 401, {
      error: "openclaw_chat_history_unauthorized",
      message: "Missing or invalid read-boundary token."
    });
    return;
  }

  const url = new URL(deps.request.url ?? "/", "http://127.0.0.1");
  const rawConversationId = url.searchParams.get("conversationId");
  const conversationId = rawConversationId === null
    ? OPENCLAW_CHAT_SESSION_KEY
    : normalizeConversationId(rawConversationId);
  if (!conversationId) {
    json(deps.response, 422, {
      error: "invalid_conversation_id",
      message: "conversationId must match /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/."
    });
    return;
  }

  json(deps.response, 200, await deps.store.history(conversationId));
}

function authorizeSensitiveRead(request: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken) {
    return false;
  }
  const token = readTokenFromRequest(request);
  if (!token) {
    return false;
  }
  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(token);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function readTokenFromRequest(request: IncomingMessage): string | null {
  const headerToken = stringHeader(request.headers["x-delivrix-token"]);
  if (headerToken) {
    return headerToken;
  }
  const authorization = stringHeader(request.headers.authorization);
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) {
    return bearer;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  return url.searchParams.get("token");
}

function stringHeader(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed || null;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

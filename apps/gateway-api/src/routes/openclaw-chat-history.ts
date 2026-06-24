import type { IncomingMessage, ServerResponse } from "node:http";
import { redactRuntimeLogSecrets } from "../gateway-runtime-log.ts";
import {
  normalizeConversationId,
  OPENCLAW_CHAT_SESSION_KEY
} from "../openclaw-chat.ts";
import { OpenClawChatHistoryStore } from "../services/openclaw-chat-history-store.ts";
import { authorizeSensitiveRead } from "./sensitive-read-auth.ts";

export interface OpenClawChatHistoryRouteDependencies {
  request: IncomingMessage;
  response: ServerResponse;
  store: OpenClawChatHistoryStore;
  readBoundaryToken: string;
}

export async function handleOpenClawChatConversationsHttp(deps: OpenClawChatHistoryRouteDependencies): Promise<void> {
  const auth = authorizeSensitiveRead(deps.request, { readBoundaryToken: deps.readBoundaryToken }, "openclaw_chat_conversations");
  if (!auth.ok) {
    json(deps.response, auth.statusCode, {
      error: "openclaw_chat_history_unauthorized",
      message: "Missing or invalid read-boundary token.",
      reason: auth.error
    });
    return;
  }

  json(deps.response, 200, {
    conversations: redactConversationSummaries(await deps.store.listConversations())
  });
}

export async function handleOpenClawChatHistoryHttp(deps: OpenClawChatHistoryRouteDependencies): Promise<void> {
  const auth = authorizeSensitiveRead(deps.request, { readBoundaryToken: deps.readBoundaryToken }, "openclaw_chat_history");
  if (!auth.ok) {
    json(deps.response, auth.statusCode, {
      error: "openclaw_chat_history_unauthorized",
      message: "Missing or invalid read-boundary token.",
      reason: auth.error
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

  json(deps.response, 200, redactConversationHistory(await deps.store.history(conversationId)));
}

function redactConversationSummaries(
  summaries: Awaited<ReturnType<OpenClawChatHistoryStore["listConversations"]>>
): Awaited<ReturnType<OpenClawChatHistoryStore["listConversations"]>> {
  return summaries.map((summary) => ({
    ...summary,
    title: redactChatHistoryText(summary.title),
    preview: redactChatHistoryText(summary.preview)
  }));
}

function redactConversationHistory(
  snapshot: Awaited<ReturnType<OpenClawChatHistoryStore["history"]>>
): Awaited<ReturnType<OpenClawChatHistoryStore["history"]>> {
  return {
    ...snapshot,
    turns: snapshot.turns.map((turn) => ({
      ...turn,
      content: redactChatHistoryText(turn.content),
      attachments: turn.attachments?.map((attachment) => ({
        ...attachment,
        name: redactChatHistoryText(attachment.name)
      }))
    }))
  };
}

function redactChatHistoryText(value: string): string {
  return redactRuntimeLogSecrets(value)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:image/[REDACTED_BASE64]")
    .replace(
      /\b(smtp_sasl_password_maps)\s+([^\s:]+):([^\s,;]+)/gi,
      (match, key: string, username: string, password: string) => {
        if (username.includes("/") || password.includes("/")) {
          return match;
        }
        return `${key} ${username}:[REDACTED]`;
      }
    )
    .replace(
      /\b(smtp[_ -]?password|smtp[_ -]?credential|smtp|sasl|dovecot|password|passwd|secret|token|api[_ -]?key|authorization|approval[_ -]?token)\b(\s*(?::|=|\bis\b|\bes\b)\s*)("[^"]+"|'[^']+'|[^\s,;]+)/gi,
      (match, key: string, separator: string, rawValue: string) => {
        return isAlwaysSensitiveChatKey(key) || looksLikeChatSecret(rawValue)
          ? `${key}${separator}[REDACTED]`
          : match;
      }
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[REDACTED_UUID_TOKEN]")
    .replace(/\b(?:[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})\b/gi, "[REDACTED_HEX_TOKEN]")
    .replace(/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, "[REDACTED_LONG_TOKEN]");
}

function isAlwaysSensitiveChatKey(key: string): boolean {
  return !/^(smtp|sasl|dovecot)$/i.test(key);
}

function looksLikeChatSecret(rawValue: string): boolean {
  const value = rawValue.replace(/^["']|["']$/g, "");
  if (/^(?:hash|regexp|texthash):/i.test(value) || value.includes("/") || value.includes(".")) {
    return false;
  }
  if (/^[a-f0-9]{32}$|^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(value)) {
    return true;
  }
  return value.length >= 20
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /[0-9]/.test(value);
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

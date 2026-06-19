import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatAttachment } from "../openclaw-chat.ts";
import {
  normalizeConversationId,
  OPENCLAW_CHAT_SESSION_KEY
} from "../openclaw-chat.ts";

const defaultStateDir = join(process.cwd(), "state", "openclaw-chat");
const defaultMaxTurnsPerConversation = 40;
const maxStoredContentChars = 100_000;

export interface OpenClawChatHistoryTurn {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  msgId?: string;
  attachments?: OpenClawChatStoredAttachment[];
}

export interface OpenClawChatConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
}

export interface OpenClawChatHistorySnapshot {
  id: string;
  turns: OpenClawChatHistoryTurn[];
}

export interface OpenClawChatStoredAttachment {
  kind: "image" | "text";
  name: string;
  mimeType: ChatAttachment["mimeType"];
  bytes: number;
  sha256: string;
  truncated?: boolean;
}

export interface OpenClawChatHistoryStoreOptions {
  stateDir?: string;
  maxTurnsPerConversation?: number;
  now?: () => Date;
}

export class OpenClawChatHistoryStore {
  private readonly stateDir: string;
  private readonly maxTurnsPerConversation: number;
  private readonly now: () => Date;
  private readonly conversations = new Map<string, OpenClawChatHistoryTurn[]>();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: OpenClawChatHistoryStoreOptions = {}) {
    this.stateDir = options.stateDir ?? process.env.OPENCLAW_CHAT_STATE_DIR ?? defaultStateDir;
    this.maxTurnsPerConversation = options.maxTurnsPerConversation ?? positiveIntegerOrDefault(
      process.env.OPENCLAW_MAX_CONVERSATION_TURNS,
      defaultMaxTurnsPerConversation
    );
    this.now = options.now ?? (() => new Date());
  }

  async appendTurn(
    conversationId: string,
    turn: Omit<OpenClawChatHistoryTurn, "createdAt" | "attachments"> & {
      createdAt?: string;
      attachments?: Array<ChatAttachment | OpenClawChatStoredAttachment>;
    }
  ): Promise<void> {
    await this.ensureLoaded();
    const normalizedConversationId = normalizeConversationId(conversationId) ?? OPENCLAW_CHAT_SESSION_KEY;
    const record = normalizeHistoryTurn({
      ...turn,
      createdAt: turn.createdAt ?? this.now().toISOString()
    });
    const turns = this.trimTurns([...(this.conversations.get(normalizedConversationId) ?? []), record]);
    this.conversations.set(normalizedConversationId, turns);

    const path = this.filePathForConversation(normalizedConversationId);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.stateDir, { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    });
    await this.writeQueue;
  }

  async loadConversations(): Promise<Map<string, OpenClawChatHistoryTurn[]>> {
    await this.ensureLoaded();
    return new Map([...this.conversations.entries()].map(([id, turns]) => [id, [...turns]]));
  }

  async listConversations(): Promise<OpenClawChatConversationSummary[]> {
    await this.ensureLoaded();
    return [...this.conversations.entries()]
      .map(([id, turns]) => conversationSummary(id, turns))
      .filter((summary): summary is OpenClawChatConversationSummary => summary !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async history(conversationId: string): Promise<OpenClawChatHistorySnapshot> {
    await this.ensureLoaded();
    const normalizedConversationId = normalizeConversationId(conversationId) ?? OPENCLAW_CHAT_SESSION_KEY;
    return {
      id: normalizedConversationId,
      turns: [...(this.conversations.get(normalizedConversationId) ?? [])]
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    this.conversations.clear();
    let files: string[];
    try {
      files = await readdir(this.stateDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw error;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const conversationId = normalizeConversationId(file.slice(0, -".jsonl".length));
      if (!conversationId) {
        continue;
      }
      const turns: OpenClawChatHistoryTurn[] = [];
      const content = await readFile(join(this.stateDir, file), "utf8").catch((error) => {
        if (isNodeError(error) && error.code === "ENOENT") {
          return "";
        }
        throw error;
      });
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          turns.push(normalizeHistoryTurn(JSON.parse(trimmed)));
        } catch {
          // Append-only history must survive partial writes or manual edits.
        }
      }
      if (turns.length > 0) {
        this.conversations.set(conversationId, this.trimTurns(turns));
      }
    }
    this.loaded = true;
  }

  private trimTurns(turns: OpenClawChatHistoryTurn[]): OpenClawChatHistoryTurn[] {
    if (turns.length <= this.maxTurnsPerConversation) {
      return turns;
    }
    return turns.slice(turns.length - this.maxTurnsPerConversation);
  }

  private filePathForConversation(conversationId: string): string {
    return join(this.stateDir, `${conversationId}.jsonl`);
  }
}

function conversationSummary(id: string, turns: OpenClawChatHistoryTurn[]): OpenClawChatConversationSummary | null {
  if (turns.length === 0) {
    return null;
  }
  const firstUserTurn = turns.find((turn) => turn.role === "user");
  const lastTurn = turns.at(-1)!;
  return {
    id,
    title: summarizeChatTitle(firstUserTurn?.content ?? lastTurn.content),
    updatedAt: lastTurn.createdAt,
    preview: summarizePreview(lastTurn.content)
  };
}

function normalizeHistoryTurn(raw: unknown): OpenClawChatHistoryTurn {
  if (!isRecord(raw)) {
    throw new Error("invalid history turn");
  }
  const role = raw.role === "assistant" ? "assistant" : raw.role === "user" ? "user" : null;
  if (!role) {
    throw new Error("invalid history role");
  }
  const content = typeof raw.content === "string" ? raw.content.slice(0, maxStoredContentChars) : "";
  const createdAt = normalizeDate(raw.createdAt);
  const attachments = normalizeStoredAttachments(raw.attachments);
  return {
    role,
    content,
    createdAt,
    ...(typeof raw.msgId === "string" && raw.msgId.trim() ? { msgId: raw.msgId.trim().slice(0, 128) } : {}),
    ...(attachments.length > 0 ? { attachments } : {})
  };
}

function normalizeStoredAttachments(value: unknown): OpenClawChatStoredAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((raw): OpenClawChatStoredAttachment[] => {
    if (raw.kind === "image" && isImageMime(raw.mimeType) && typeof raw.sha256 === "string") {
      return [{
        kind: "image",
        name: safeStoredName(raw.name),
        mimeType: raw.mimeType,
        bytes: positiveIntegerOrDefault(raw.bytes, 0),
        sha256: raw.sha256.slice(0, 128),
        ...(raw.truncated === true ? { truncated: true } : {})
      }];
    }
    if (raw.kind === "text" && (raw.mimeType === "text/plain" || raw.mimeType === "text/markdown") && typeof raw.sha256 === "string") {
      return [{
        kind: "text",
        name: safeStoredName(raw.name),
        mimeType: raw.mimeType,
        bytes: positiveIntegerOrDefault(raw.bytes, 0),
        sha256: raw.sha256.slice(0, 128),
        ...(raw.truncated === true ? { truncated: true } : {})
      }];
    }
    return [];
  });
}

function isImageMime(value: unknown): value is Extract<ChatAttachment["mimeType"], `image/${string}`> {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

function safeStoredName(value: unknown): string {
  const raw = typeof value === "string" ? value : "attachment";
  const sanitized = raw.trim().replace(/[^a-zA-Z0-9_.:-]/g, "-").replace(/-+/g, "-").slice(0, 96);
  return sanitized || "attachment";
}

function summarizeChatTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Conversacion OpenClaw";
  }
  return normalized.length <= 90 ? normalized : `${normalized.slice(0, 87)}...`;
}

function summarizePreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function normalizeDate(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

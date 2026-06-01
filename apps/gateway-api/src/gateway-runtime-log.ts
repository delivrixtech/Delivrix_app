import { mkdir, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type GatewayRuntimeLogLevel = "info" | "warn" | "error";
export type GatewayRuntimeLogMetadata = Record<string, unknown>;

export interface GatewayRuntimeLogger {
  readonly logPath: string;
  info(event: string, message: string, metadata?: GatewayRuntimeLogMetadata): Promise<void>;
  warn(event: string, message: string, metadata?: GatewayRuntimeLogMetadata): Promise<void>;
  error(event: string, message: string, metadata?: GatewayRuntimeLogMetadata): Promise<void>;
}

export interface GatewayRuntimeLoggerOptions {
  logPath?: string;
  now?: () => Date;
}

export const noopGatewayRuntimeLogger: GatewayRuntimeLogger = {
  logPath: "",
  info: async () => undefined,
  warn: async () => undefined,
  error: async () => undefined
};

const maxMetadataChars = 4_000;
const maxMessageChars = 1_000;

export function createGatewayRuntimeLogger(options: GatewayRuntimeLoggerOptions = {}): GatewayRuntimeLogger {
  const logPath = resolve(options.logPath ?? process.env.GATEWAY_LOG_PATH ?? "runtime/logs/gateway.log");
  const now = options.now ?? (() => new Date());
  let ensureDirPromise: Promise<void> | null = null;

  async function write(level: GatewayRuntimeLogLevel, event: string, message: string, metadata?: GatewayRuntimeLogMetadata): Promise<void> {
    try {
      ensureDirPromise ??= mkdir(dirname(logPath), { recursive: true }).then(() => undefined);
      await ensureDirPromise;
      await appendFile(logPath, formatGatewayRuntimeLogLine({
        ts: now().toISOString(),
        level,
        event,
        message,
        metadata
      }), "utf8");
    } catch (error) {
      console.warn("[gateway-runtime-log] write failed", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    logPath,
    info: (event, message, metadata) => write("info", event, message, metadata),
    warn: (event, message, metadata) => write("warn", event, message, metadata),
    error: (event, message, metadata) => write("error", event, message, metadata)
  };
}

export function formatGatewayRuntimeLogLine(input: {
  ts: string;
  level: GatewayRuntimeLogLevel;
  event: string;
  message: string;
  metadata?: GatewayRuntimeLogMetadata;
}): string {
  const message = redactRuntimeLogSecrets(input.message).replace(/\s+/g, " ").trim().slice(0, maxMessageChars);
  const event = normalizeEventName(input.event);
  const metadata = input.metadata && Object.keys(input.metadata).length > 0
    ? ` ${redactRuntimeLogSecrets(stableStringify(normalizeMetadata(input.metadata))).slice(0, maxMetadataChars)}`
    : "";
  return `${input.ts} [${input.level}] event=${event} ${message}${metadata}\n`;
}

export function runtimeErrorMetadata(error: unknown): GatewayRuntimeLogMetadata {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 8).join(" | ")
    };
  }
  return { message: String(error) };
}

export function summarizeOperationalParams(value: unknown): GatewayRuntimeLogMetadata {
  if (!isRecord(value)) {
    return {};
  }
  const allowed = [
    "actorId",
    "brand",
    "domain",
    "hostname",
    "serverSlug",
    "serverIp",
    "smtpHost",
    "budgetUsdMax",
    "profile",
    "locationId",
    "imageSlug",
    "selector",
    "dmarcPolicy",
    "maxWaitMs",
    "pollIntervalMs"
  ];
  const summary: GatewayRuntimeLogMetadata = {};
  for (const key of allowed) {
    const item = value[key];
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      summary[key] = item;
    }
  }
  return summary;
}

export function redactRuntimeLogSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\bauthorization\b\s*[:=]\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1=[REDACTED]");
}

function normalizeMetadata(metadata: GatewayRuntimeLogMetadata): GatewayRuntimeLogMetadata {
  const normalized: GatewayRuntimeLogMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isSensitiveKey(key)) {
      normalized[key] = "[REDACTED]";
      continue;
    }
    const normalizedValue = normalizeMetadataValue(value);
    if (normalizedValue !== undefined) {
      normalized[key] = normalizedValue;
    }
  }
  return normalized;
}

function normalizeMetadataValue(value: unknown): unknown {
  if (value instanceof Error) {
    return runtimeErrorMetadata(value);
  }
  if (typeof value === "string") {
    return value.length > 800 ? `${value.slice(0, 800)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(normalizeMetadataValue);
  }
  if (isRecord(value)) {
    return normalizeMetadata(value);
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function normalizeEventName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  return normalized.length > 0 ? normalized.slice(0, 120) : "gateway.event";
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|private[_-]?key|access[_-]?key|api[_-]?key|authorization/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

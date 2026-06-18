import { createHash } from "node:crypto";

export type MxtoolboxHealthStatus = "clean" | "warning" | "listed" | "error";

export type MxtoolboxCommand =
  | "blacklist"
  | "smtp"
  | "mx"
  | "spf"
  | "dkim"
  | "dmarc"
  | "ptr"
  | "a"
  | "txt"
  | "dns"
  | "bimi"
  | "mta-sts";

export interface MxtoolboxCheck {
  id: number;
  name: string;
  info: string;
  url: string;
}

export interface MxtoolboxLookupRaw {
  UID?: string;
  Command?: string;
  CommandArgument?: string;
  TimeRecorded?: string;
  ReportingNameServer?: string;
  TimeToComplete?: string;
  Failed?: MxtoolboxCheck[];
  Warnings?: MxtoolboxCheck[];
  Passed?: MxtoolboxCheck[];
  Timeouts?: MxtoolboxCheck[];
}

export interface MxtoolboxHealthSummary {
  target: string;
  command: string;
  checkedAt: string;
  status: MxtoolboxHealthStatus;
  failedChecks: string[];
  warningChecks: string[];
  passedCount: number;
  timeoutCount: number;
  rawRef: string;
}

export interface MxtoolboxLookupSource {
  kind: "live" | "mock";
  apiBase: string;
  fetchedAt: string;
  responseOk: boolean;
  errorMessage?: string;
}

export interface MxtoolboxLookupResult {
  summary: MxtoolboxHealthSummary;
  source: MxtoolboxLookupSource;
  cacheHit: boolean;
}

export interface MxtoolboxUsage {
  used?: number;
  limit?: number;
  remaining?: number;
  rawRef: string;
  checkedAt: string;
}

export interface MxtoolboxAdapterConfig {
  apiKey?: string;
  apiBase?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  retryBaseDelayMs?: number;
  retryJitterMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface CacheEntry {
  expiresAt: number;
  result: MxtoolboxLookupResult;
}

const DEFAULT_API_BASE = "https://api.mxtoolbox.com/api/v1";
const DEFAULT_CACHE_TTL_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;
const DEFAULT_RETRY_JITTER_MS = 100;

const allowedCommands: readonly MxtoolboxCommand[] = [
  "blacklist",
  "smtp",
  "mx",
  "spf",
  "dkim",
  "dmarc",
  "ptr",
  "a",
  "txt",
  "dns",
  "bimi",
  "mta-sts"
] as const;

export class MxtoolboxAdapter {
  private readonly apiKey: string | undefined;
  private readonly apiBase: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryJitterMs: number;
  private readonly injectedFetch: typeof fetch | undefined;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: MxtoolboxAdapterConfig = {}) {
    this.apiKey = normalizeEnvValue(config.apiKey);
    this.apiBase = stripTrailingSlash(normalizeEnvValue(config.apiBase) ?? DEFAULT_API_BASE);
    this.cacheTtlMs = positiveNumber(config.cacheTtlMs) ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = positiveNumber(config.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
    this.retryBaseDelayMs = positiveNumber(config.retryBaseDelayMs) ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryJitterMs = Math.max(0, Math.trunc(config.retryJitterMs ?? DEFAULT_RETRY_JITTER_MS));
    this.injectedFetch = config.fetchImpl;
    this.now = config.now ?? (() => new Date());
    this.sleep = config.sleep ?? sleep;
  }

  isLive(): boolean {
    return Boolean(this.apiKey);
  }

  async lookup(input: {
    target: string;
    command?: string;
    selector?: string;
  }): Promise<MxtoolboxLookupResult> {
    const target = normalizeTarget(input.target);
    const command = normalizeCommand(input.command ?? "blacklist", input.selector);
    const cacheKey = `${command}:${target}`;
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now.getTime()) {
      return {
        ...cached.result,
        cacheHit: true
      };
    }

    const fetchedAt = now.toISOString();
    const result = await this.lookupLive({ target, command, fetchedAt });
    this.cache.set(cacheKey, {
      expiresAt: now.getTime() + this.cacheTtlMs,
      result
    });
    return result;
  }

  async usage(): Promise<MxtoolboxUsage | null> {
    if (!this.apiKey) return null;
    const checkedAt = this.now().toISOString();
    try {
      const response = await this.fetchWithTimeout(`${this.apiBase}/Usage`, {
        method: "GET",
        headers: this.authHeaders()
      });
      const raw = await response.json().catch(() => null);
      if (!response.ok || !isRecord(raw)) return null;
      return {
        ...parseUsage(raw),
        rawRef: rawRef(raw),
        checkedAt
      };
    } catch {
      return null;
    }
  }

  private async lookupLive(input: {
    target: string;
    command: string;
    fetchedAt: string;
  }): Promise<MxtoolboxLookupResult> {
    if (!this.apiKey) {
      return errorResult({
        target: input.target,
        command: input.command,
        fetchedAt: input.fetchedAt,
        apiBase: this.apiBase,
        errorMessage: "mxtoolbox_api_key_missing"
      });
    }

    const url = new URL(`${this.apiBase}/Lookup/${encodeURIComponent(input.command)}/`);
    url.searchParams.set("argument", input.target);

    try {
      const response = await this.fetchWithRetry(url);
      const raw = await response.json().catch(() => null);
      if (!response.ok) {
        return errorResult({
          target: input.target,
          command: input.command,
          fetchedAt: input.fetchedAt,
          apiBase: this.apiBase,
          errorMessage: `mxtoolbox_http_${response.status}`,
          raw
        });
      }
      const normalized = normalizeLookupRaw(raw);
      return {
        summary: summarizeLookup(input.target, input.command, normalized, input.fetchedAt, rawRef(raw)),
        source: {
          kind: "live",
          apiBase: this.apiBase,
          fetchedAt: input.fetchedAt,
          responseOk: true
        },
        cacheHit: false
      };
    } catch (error) {
      return errorResult({
        target: input.target,
        command: input.command,
        fetchedAt: input.fetchedAt,
        apiBase: this.apiBase,
        errorMessage: error instanceof Error ? error.message : "mxtoolbox_fetch_failed"
      });
    }
  }

  private async fetchWithRetry(url: URL): Promise<Response> {
    let retry429 = 0;
    let retry5xx = 0;

    for (;;) {
      const response = await this.fetchWithTimeout(url, {
        method: "GET",
        headers: this.authHeaders()
      });
      if (response.status === 429 && retry429 < 1) {
        retry429 += 1;
        await this.sleep(this.retryDelayMs(retry429));
        continue;
      }
      if (response.status >= 500 && response.status <= 599 && retry5xx < 2) {
        retry5xx += 1;
        await this.sleep(this.retryDelayMs(retry5xx));
        continue;
      }
      return response;
    }
  }

  private async fetchWithTimeout(input: string | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await (this.injectedFetch ?? globalThis.fetch)(input, {
        ...init,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private authHeaders(): HeadersInit {
    return {
      accept: "application/json",
      Authorization: this.apiKey ?? ""
    };
  }

  private retryDelayMs(attempt: number): number {
    const jitter = this.retryJitterMs > 0 ? Math.floor(Math.random() * this.retryJitterMs) : 0;
    return this.retryBaseDelayMs * attempt + jitter;
  }
}

export function createMxtoolboxAdapterFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): MxtoolboxAdapter | null {
  const apiKey = normalizeEnvValue(env.MXTOOLBOX_API_KEY);
  if (!apiKey) return null;
  return new MxtoolboxAdapter({
    apiKey,
    apiBase: normalizeEnvValue(env.MXTOOLBOX_API_BASE),
    cacheTtlMs: positiveNumber(Number(env.MXTOOLBOX_CACHE_TTL_MS)),
    timeoutMs: positiveNumber(Number(env.MXTOOLBOX_TIMEOUT_MS))
  });
}

export function normalizeMxtoolboxCommand(value: string | undefined, selector?: string): string {
  return normalizeCommand(value ?? "blacklist", selector);
}

export function isMxtoolboxCommand(value: string): value is MxtoolboxCommand {
  return (allowedCommands as readonly string[]).includes(value);
}

function normalizeCommand(value: string, selector?: string): string {
  const normalized = value.trim().toLowerCase();
  if (!isMxtoolboxCommand(normalized)) {
    throw new Error("invalid_mxtoolbox_command");
  }
  if (normalized === "dkim" && selector?.trim()) {
    return `dkim:${selector.trim().toLowerCase()}`;
  }
  return normalized;
}

function normalizeTarget(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (normalized.length < 1 || normalized.length > 253) {
    throw new Error("invalid_mxtoolbox_target");
  }
  if (isIpv4(normalized) || isDomain(normalized)) {
    return normalized;
  }
  throw new Error("invalid_mxtoolbox_target");
}

function normalizeLookupRaw(raw: unknown): Required<Pick<MxtoolboxLookupRaw, "Failed" | "Warnings" | "Passed" | "Timeouts">> & MxtoolboxLookupRaw {
  const record = isRecord(raw) ? raw : {};
  return {
    UID: stringValue(record.UID),
    Command: stringValue(record.Command),
    CommandArgument: stringValue(record.CommandArgument),
    TimeRecorded: stringValue(record.TimeRecorded),
    ReportingNameServer: stringValue(record.ReportingNameServer),
    TimeToComplete: stringValue(record.TimeToComplete),
    Failed: checks(record.Failed),
    Warnings: checks(record.Warnings),
    Passed: checks(record.Passed),
    Timeouts: checks(record.Timeouts)
  };
}

function summarizeLookup(
  target: string,
  command: string,
  raw: Required<Pick<MxtoolboxLookupRaw, "Failed" | "Warnings" | "Passed" | "Timeouts">> & MxtoolboxLookupRaw,
  fallbackCheckedAt: string,
  rawHash: string
): MxtoolboxHealthSummary {
  return {
    target,
    command,
    checkedAt: parseDateOrIso(raw.TimeRecorded) ?? fallbackCheckedAt,
    status: statusFromChecks(raw),
    failedChecks: raw.Failed.map((check) => check.name),
    warningChecks: raw.Warnings.map((check) => check.name),
    passedCount: raw.Passed.length,
    timeoutCount: raw.Timeouts.length,
    rawRef: rawHash
  };
}

function statusFromChecks(raw: {
  Failed: MxtoolboxCheck[];
  Warnings: MxtoolboxCheck[];
  Timeouts: MxtoolboxCheck[];
}): MxtoolboxHealthStatus {
  if (raw.Failed.length > 0) return "listed";
  if (raw.Warnings.length > 0) return "warning";
  if (raw.Timeouts.length > 0) return "error";
  return "clean";
}

function checks(value: unknown): MxtoolboxCheck[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      id: numberValue(record.ID) ?? numberValue(record.id) ?? 0,
      name: stringValue(record.Name) ?? stringValue(record.name) ?? "unknown_check",
      info: stringValue(record.Info) ?? stringValue(record.info) ?? "",
      url: stringValue(record.Url) ?? stringValue(record.url) ?? ""
    };
  });
}

function errorResult(input: {
  target: string;
  command: string;
  fetchedAt: string;
  apiBase: string;
  errorMessage: string;
  raw?: unknown;
}): MxtoolboxLookupResult {
  return {
    summary: {
      target: input.target,
      command: input.command,
      checkedAt: input.fetchedAt,
      status: "error",
      failedChecks: [],
      warningChecks: [],
      passedCount: 0,
      timeoutCount: 0,
      rawRef: rawRef(input.raw ?? { error: input.errorMessage })
    },
    source: {
      kind: input.errorMessage === "mxtoolbox_api_key_missing" ? "mock" : "live",
      apiBase: input.apiBase,
      fetchedAt: input.fetchedAt,
      responseOk: false,
      errorMessage: input.errorMessage
    },
    cacheHit: false
  };
}

function parseUsage(raw: Record<string, unknown>): Omit<MxtoolboxUsage, "rawRef" | "checkedAt"> {
  const used =
    numberValue(raw.Used) ??
    numberValue(raw.Usage) ??
    numberValue(raw.Current) ??
    numberValue(raw.Consumed);
  const limit =
    numberValue(raw.Limit) ??
    numberValue(raw.Maximum) ??
    numberValue(raw.Max) ??
    numberValue(raw.Total);
  const remaining =
    numberValue(raw.Remaining) ??
    (typeof used === "number" && typeof limit === "number" ? Math.max(0, limit - used) : undefined);
  return {
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining })
  };
}

function rawRef(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function parseDateOrIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isDomain(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

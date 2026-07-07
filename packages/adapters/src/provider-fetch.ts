export interface ProviderFetchFactoryOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
  maxRetries?: number;
  breakerFailureThreshold?: number;
  breakerOpenMs?: number;
  env?: Record<string, string | undefined>;
}

export interface ProviderFetchRequestOptions {
  /** Retries are ONLY applied when the caller declares the call idempotent. */
  idempotent?: boolean;
  /** Circuit breaker key, e.g. "contabo:contabo-1". No key = no breaker. */
  breakerKey?: string;
  timeoutMs?: number;
}

export type BreakerState = "closed" | "open" | "half-open";

export interface ProviderFetch {
  fetch(url: string, init: RequestInit, options?: ProviderFetchRequestOptions): Promise<Response>;
  breakerState(key: string): BreakerState;
}

export class ProviderFetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Provider request timed out after ${timeoutMs}ms: ${redactUrl(url)}`);
    this.name = "ProviderFetchTimeoutError";
  }
}

export class ProviderCircuitOpenError extends Error {
  constructor(key: string) {
    super(`Provider circuit breaker open for ${key}; skipping call`);
    this.name = "ProviderCircuitOpenError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BREAKER_FAILURE_THRESHOLD = 5;
const DEFAULT_BREAKER_OPEN_MS = 60_000;
const RETRY_BASE_DELAY_MS = 250;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

interface BreakerEntry {
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenInFlight: boolean;
}

export function createProviderFetch(options: ProviderFetchFactoryOptions = {}): ProviderFetch {
  const env = options.env ?? (typeof process !== "undefined" ? process.env : {});
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const defaultTimeoutMs =
    positiveNumber(options.timeoutMs) ??
    positiveNumber(Number(env.PROVIDER_FETCH_TIMEOUT_MS)) ??
    DEFAULT_TIMEOUT_MS;
  const maxRetries =
    nonNegativeInteger(options.maxRetries) ??
    nonNegativeInteger(Number(env.PROVIDER_FETCH_MAX_RETRIES)) ??
    DEFAULT_MAX_RETRIES;
  const breakerFailureThreshold =
    positiveNumber(options.breakerFailureThreshold) ?? DEFAULT_BREAKER_FAILURE_THRESHOLD;
  const breakerOpenMs = positiveNumber(options.breakerOpenMs) ?? DEFAULT_BREAKER_OPEN_MS;

  const breakers = new Map<string, BreakerEntry>();

  function breakerEntry(key: string): BreakerEntry {
    let entry = breakers.get(key);
    if (!entry) {
      entry = { consecutiveFailures: 0, openedAt: null, halfOpenInFlight: false };
      breakers.set(key, entry);
    }
    return entry;
  }

  function breakerState(key: string): BreakerState {
    const entry = breakers.get(key);
    if (!entry || entry.openedAt === null) return "closed";
    if (now().getTime() - entry.openedAt >= breakerOpenMs) return "half-open";
    return "open";
  }

  function recordSuccess(key: string | undefined): void {
    if (!key) return;
    const entry = breakerEntry(key);
    entry.consecutiveFailures = 0;
    entry.openedAt = null;
    entry.halfOpenInFlight = false;
  }

  function recordFailure(key: string | undefined): void {
    if (!key) return;
    const entry = breakerEntry(key);
    entry.consecutiveFailures += 1;
    entry.halfOpenInFlight = false;
    if (entry.consecutiveFailures >= breakerFailureThreshold || entry.openedAt !== null) {
      entry.openedAt = now().getTime();
    }
  }

  function assertBreakerAllows(key: string | undefined): void {
    if (!key) return;
    const state = breakerState(key);
    if (state === "closed") return;
    const entry = breakerEntry(key);
    if (state === "half-open" && !entry.halfOpenInFlight) {
      entry.halfOpenInFlight = true;
      return;
    }
    throw new ProviderCircuitOpenError(key);
  }

  async function fetchOnce(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderFetchTimeoutError(url, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function providerFetch(
    url: string,
    init: RequestInit,
    requestOptions: ProviderFetchRequestOptions = {}
  ): Promise<Response> {
    const timeoutMs = positiveNumber(requestOptions.timeoutMs) ?? defaultTimeoutMs;
    const attempts = requestOptions.idempotent ? maxRetries + 1 : 1;
    const breakerKey = requestOptions.breakerKey;

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      assertBreakerAllows(breakerKey);
      try {
        const response = await fetchOnce(url, init, timeoutMs);
        if (requestOptions.idempotent && RETRYABLE_STATUS.has(response.status) && attempt < attempts - 1) {
          recordFailure(breakerKey);
          await sleep(backoffDelayMs(attempt, random));
          continue;
        }
        if (response.ok || response.status < 500) {
          recordSuccess(breakerKey);
        } else {
          recordFailure(breakerKey);
        }
        return response;
      } catch (error) {
        if (error instanceof ProviderCircuitOpenError) {
          throw error;
        }
        recordFailure(breakerKey);
        lastError = error;
        if (attempt < attempts - 1) {
          await sleep(backoffDelayMs(attempt, random));
          continue;
        }
        throw error;
      }
    }
    throw lastError ?? new Error(`Provider request failed: ${redactUrl(url)}`);
  }

  return {
    fetch: providerFetch,
    breakerState
  };
}

function backoffDelayMs(attempt: number, random: () => number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
  return Math.round(base + random() * base);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface SensitiveReadAuthDeps {
  readBoundaryToken?: string;
  now?: () => Date;
  rateLimitPerMinute?: number;
}

export type SensitiveReadAuthResult =
  | { ok: true }
  | { ok: false; statusCode: 401 | 429 | 503; error: string };

const buckets = new Map<string, { windowMs: number; count: number }>();

export function authorizeSensitiveRead(
  request: IncomingMessage,
  deps: SensitiveReadAuthDeps,
  scope: string
): SensitiveReadAuthResult {
  const expected = deps.readBoundaryToken?.trim();
  if (!expected) {
    return { ok: false, statusCode: 503, error: "read_boundary_token_unconfigured" };
  }

  const supplied = bearerToken(request) || headerToken(request);
  if (!supplied || !safeEqual(supplied, expected)) {
    return { ok: false, statusCode: 401, error: "read_boundary_token_invalid" };
  }

  const limit = deps.rateLimitPerMinute ?? 60;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const windowMs = Math.floor(nowMs / 60_000) * 60_000;
  const key = `${scope}:${clientAddress(request)}:${hashableTokenPrefix(expected)}`;
  const bucket = buckets.get(key);
  if (!bucket || bucket.windowMs !== windowMs) {
    buckets.set(key, { windowMs, count: 1 });
    return { ok: true };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, statusCode: 429, error: "read_boundary_rate_limited" };
  }
  return { ok: true };
}

export function resetSensitiveReadAuthBucketsForTests(): void {
  buckets.clear();
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
}

function headerToken(request: IncomingMessage): string {
  const value = request.headers["x-delivrix-token"];
  return typeof value === "string" ? value.trim() : "";
}

function clientAddress(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return request.socket?.remoteAddress ?? "local";
}

function hashableTokenPrefix(token: string): string {
  return token.slice(0, 8);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

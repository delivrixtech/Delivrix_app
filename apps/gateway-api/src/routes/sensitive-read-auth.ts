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

/** Variables de las que puede salir el token del borde de lectura, en orden de preferencia. */
export const READ_BOUNDARY_TOKEN_VARS = [
  "DELIVRIX_READ_BOUNDARY_TOKEN",
  "DELIVRIX_OPENCLAW_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN"
] as const;

export type ReadBoundaryTokenSource = (typeof READ_BOUNDARY_TOKEN_VARS)[number];

export interface ReadBoundaryTokenResolution {
  token?: string;
  source?: ReadBoundaryTokenSource;
  /**
   * true cuando el token que autoriza LEER credenciales es tambien el que autoriza MUTAR.
   * Pasa de dos formas: por cascada (la variable dedicada esta vacia) o porque la dedicada
   * esta seteada con el mismo VALOR que una de las de mutacion.
   */
  sharesMutationToken: boolean;
  /** Texto listo para loguear cuando hay algo que avisar. */
  warning?: string;
}

/**
 * Resuelve el token del borde de lectura y avisa cuando termina siendo el de mutaciones.
 *
 * La cascada se mantiene a proposito: sacarla dejaria sin panel a cualquier despliegue que hoy
 * solo tenga `OPENCLAW_GATEWAY_TOKEN`. Lo que no puede seguir pasando es que ocurra en silencio:
 * el borde de lectura entrega credenciales SMTP de la flota entera, y el dia que alguien vacie
 * `DELIVRIX_READ_BOUNDARY_TOKEN` en una rotacion, ese permiso se lo lleva el token de mutaciones
 * sin que nada lo diga.
 */
export function resolveReadBoundaryToken(
  env: Record<string, string | undefined>
): ReadBoundaryTokenResolution {
  const valueOf = (name: ReadBoundaryTokenSource): string | undefined => {
    const trimmed = env[name]?.trim();
    return trimmed ? trimmed : undefined;
  };

  const source = READ_BOUNDARY_TOKEN_VARS.find((name) => valueOf(name) !== undefined);
  if (!source) {
    return {
      sharesMutationToken: false,
      warning:
        "El borde de lectura no tiene token configurado: las rutas de lectura sensible van a " +
        `responder 503. Configura una de ${READ_BOUNDARY_TOKEN_VARS.join(", ")}.`
    };
  }

  const token = valueOf(source) as string;
  const compartidoCon = READ_BOUNDARY_TOKEN_VARS.filter(
    (name) => name !== "DELIVRIX_READ_BOUNDARY_TOKEN" && valueOf(name) === token
  );

  if (compartidoCon.length === 0) {
    return { token, source, sharesMutationToken: false };
  }

  const porCascada = source !== "DELIVRIX_READ_BOUNDARY_TOKEN";
  return {
    token,
    source,
    sharesMutationToken: true,
    warning:
      `El token del borde de lectura es el MISMO que ${compartidoCon.join(" y ")}` +
      (porCascada
        ? " porque DELIVRIX_READ_BOUNDARY_TOKEN esta vacia y se cayo en cascada."
        : " (DELIVRIX_READ_BOUNDARY_TOKEN esta seteada con ese mismo valor).") +
      " Cualquiera que pueda mutar puede tambien descargar las credenciales SMTP de toda la " +
      "flota. Configura DELIVRIX_READ_BOUNDARY_TOKEN con un valor propio."
  };
}

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

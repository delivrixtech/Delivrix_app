// Proveedor de ACCESS TOKEN OAuth2 (Google) para autenticar la LECTURA del seed inbox por XOAUTH2.
//
// Qué hace: lee el OAuth config PERMANENTE del seed inbox (client_id/client_secret/refresh_token/
// token_uri), canjea el refresh_token por un access_token contra el token endpoint, lo cachea con su
// expiración y lo refresca proactivamente (~60s antes de vencer). Devuelve SOLO el access_token opaco;
// el reader/IMAP client lo enchufa en `auth:{ user, accessToken }` (XOAUTH2). Este proveedor NO abre
// sockets IMAP ni envía correo: sólo mintea tokens.
//
// SEGURIDAD (no negociable):
//   - Los valores del config (client_secret / refresh_token) y el access_token NUNCA se loguean, ni se
//     meten en mensajes de error. Los errores llevan un CÓDIGO snake_case + a lo sumo status/paths, jamás
//     el cuerpo de la respuesta del token endpoint (podría eco-devolver material sensible).
//   - Fail-closed: config ausente/inválido, respuesta HTTP no-OK, o respuesta sin access_token ⇒ THROW
//     un Error tipado por código; no se inventa un token ni se cachea basura.
//   - `readConfig` y `fetch` son INYECTABLES ⇒ los tests usan fakes con valores dummy; el archivo real
//     (config/warmup-oauth.local.json) NUNCA se toca en tests.
//
// Node 22 strip-types: sin clases/enums/parameter-properties; factory que devuelve object literal.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

// ─────────────────────────────────────────────────────────────────────────────
// Contrato público.
// ─────────────────────────────────────────────────────────────────────────────

/** Provee un access token válido para XOAUTH2. Cachea+refresca por dentro; NUNCA loguea el token. */
export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

/** Forma del OAuth config permanente del seed inbox. Todos los campos son strings no vacías. */
export interface GoogleOAuthConfig {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  token_uri: string;
}

/** Respuesta HTTP mínima que consumimos del token endpoint (subconjunto de Response). */
export interface TokenHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** fetch INYECTABLE (default = global fetch). Sólo POST x-www-form-urlencoded al token endpoint. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<TokenHttpResponse>;

/** Opciones del proveedor. `readConfig`/`fetch`/`now` inyectables ⇒ tests sin red ni archivo real. */
export interface GoogleOAuthTokenProviderOptions {
  /** Ruta al OAuth config; default = config/warmup-oauth.local.json (relativa al repo root). */
  configPath?: string;
  /** Override para leer el config (default = loadGoogleOAuthConfig sobre `configPath`). */
  readConfig?: () => Promise<GoogleOAuthConfig>;
  /** Override del fetch (default = global fetch). */
  fetch?: FetchLike;
  /** Reloj inyectable (default = Date.now). */
  now?: () => number;
  /** Margen para refrescar antes de vencer (default 60s). */
  refreshSkewMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ruta por defecto del config (relativa al repo root, robusta ante el cwd).
// live/ → src/ → warmup-engine/ → apps/ → <repo root>/config/warmup-oauth.local.json
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OAUTH_CONFIG_PATH = resolve(MODULE_DIR, "../../../../config/warmup-oauth.local.json");

const DEFAULT_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_SEC = 3600;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────────

/** Mensaje de error corto SIN secretos (sólo el .message del error, nunca cuerpos de respuesta). */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Exige que `obj[key]` sea string no vacía; el error nombra la CLAVE, jamás el valor. */
function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`warmup_oauth_config_invalid: campo "${key}" ausente o vacío en el OAuth config`);
  }
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Carga + validación del config (fail-closed, sin filtrar valores).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lee y valida el OAuth config. Fail-closed:
 *   - No se puede leer el archivo ⇒ warmup_oauth_config_missing (incluye sólo el path, no secretos).
 *   - No es JSON / no es objeto / falta un campo ⇒ warmup_oauth_config_invalid (SIN el contenido crudo:
 *     el error de JSON.parse podría llevar un snippet del archivo, así que NO lo propagamos).
 * `readFileFn` inyectable ⇒ tests no tocan el archivo real.
 */
export async function loadGoogleOAuthConfig(
  path: string = DEFAULT_OAUTH_CONFIG_PATH,
  readFileFn: (p: string) => Promise<string> = (p) => readFile(p, "utf8")
): Promise<GoogleOAuthConfig> {
  let raw: string;
  try {
    raw = await readFileFn(path);
  } catch (err) {
    throw new Error(`warmup_oauth_config_missing: no se pudo leer el OAuth config en ${path} (${errText(err)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberado: NO incluir el error de JSON.parse (puede llevar un snippet del contenido/secreto).
    throw new Error("warmup_oauth_config_invalid: el OAuth config no es JSON válido");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("warmup_oauth_config_invalid: el OAuth config no es un objeto JSON");
  }
  const obj = parsed as Record<string, unknown>;
  return {
    client_id: requireString(obj, "client_id"),
    client_secret: requireString(obj, "client_secret"),
    refresh_token: requireString(obj, "refresh_token"),
    token_uri: requireString(obj, "token_uri")
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proveedor: mint + cache + refresh proactivo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crea un AccessTokenProvider que canjea el refresh_token por access_token y lo cachea con expiración.
 *   - Primer getAccessToken() ⇒ mintea (POST token_uri, grant_type=refresh_token).
 *   - Llamadas dentro de la ventana de validez ⇒ devuelven el token cacheado (0 red).
 *   - Cerca del vencimiento (o pasado) ⇒ re-mintea. Un mint en vuelo se comparte (dedupe de concurrencia).
 * Nunca loguea secretos; cualquier fallo es fail-closed (throw tipado).
 */
export function createGoogleOAuthTokenProvider(
  opts: GoogleOAuthTokenProviderOptions = {}
): AccessTokenProvider {
  const now = opts.now ?? (() => Date.now());
  const skew = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const readConfig =
    opts.readConfig ?? (() => loadGoogleOAuthConfig(opts.configPath ?? DEFAULT_OAUTH_CONFIG_PATH));

  let cached: { token: string; expiresAtMs: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    const cfg = await readConfig();
    const body = new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: cfg.refresh_token,
      grant_type: "refresh_token"
    }).toString();

    let res: TokenHttpResponse;
    try {
      res = await doFetch(cfg.token_uri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
    } catch (err) {
      throw new Error(`warmup_oauth_token_request_failed: ${errText(err)}`);
    }

    if (!res.ok) {
      // Sólo el status: el cuerpo de la respuesta puede llevar detalles sensibles ⇒ no se propaga.
      throw new Error(`warmup_oauth_token_http_${res.status}: el token endpoint rechazó el refresh`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error("warmup_oauth_token_invalid_response: la respuesta del token endpoint no es JSON");
    }
    const obj = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
    const token = obj.access_token;
    if (typeof token !== "string" || token.trim() === "") {
      throw new Error("warmup_oauth_token_missing_access_token: la respuesta no trae access_token");
    }
    const rawTtl = obj.expires_in;
    const ttlSec = typeof rawTtl === "number" && rawTtl > 0 ? rawTtl : DEFAULT_TOKEN_TTL_SEC;
    cached = { token, expiresAtMs: now() + ttlSec * 1000 - skew };
    return token;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (cached && now() < cached.expiresAtMs) {
        return cached.token;
      }
      if (inflight) return inflight;
      inflight = mint().finally(() => {
        inflight = null;
      });
      return inflight;
    }
  };
}

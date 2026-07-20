// Configuración/guardas del runtime del warmup-engine.
//
// FEATURE FLAG DE SEGURIDAD: el engine NO debe arrancar ni enviar correo por sí solo en un deploy.
// Todo entrypoint/daemon/scheduler futuro DEBE chequear `warmupEngineEnabled(env)` y abstenerse si
// es false. Default = OFF: en ausencia de la var, el engine está inerte (no manda nada sin querer).
// El cableado de resolvers/transporte REALES (DNS/RBL/SMTP/IMAP en vivo) solo se conecta bajo este
// flag; los tests y la lógica pura no lo necesitan (usan mocks inyectados).

export interface WarmupEnv {
  WARMUP_ENGINE_ENABLE?: string;
  /** Selector de transporte del Send Worker: "postfix" (real) | "mock" (default, no envía). */
  WARMUP_TRANSPORT?: string;
  /** Host del Postfix de submission para el transporte real (roadmap 5.1). */
  WARMUP_SMTP_HOST?: string;
  /** Puerto de submission (default 587 si se omite). */
  WARMUP_SMTP_PORT?: string;
  /** Piso de placement (Wilson-LB) que expone el filtro /warm (roadmap 5.1). Default 0.80. */
  WARMUP_PLACEMENT_MIN?: string;
  /**
   * Activa la LECTURA real del seed inbox por OAuth (XOAUTH2) en el dry-run. Default OFF.
   * OJO: SOLO afecta la LECTURA (IMAP). El ENVÍO sigue MockTransport SIEMPRE en dry-run — este flag
   * NO habilita enviar correo real.
   */
  WARMUP_GMAIL_OAUTH_ENABLE?: string;
  /** Ruta al OAuth config del seed inbox (default config/warmup-oauth.local.json). */
  WARMUP_GMAIL_OAUTH_CONFIG?: string;
  /** Usuario (dirección) del seed inbox Gmail (default infradelivrixdemo@gmail.com). */
  WARMUP_GMAIL_SEED_USER?: string;
  /** Host IMAP del seed inbox (default imap.gmail.com). */
  WARMUP_GMAIL_IMAP_HOST?: string;
}

/** true solo si WARMUP_ENGINE_ENABLE está explícitamente en "true"/"1". Default OFF (fail-safe). */
export function warmupEngineEnabled(env: WarmupEnv = process.env): boolean {
  const raw = env.WARMUP_ENGINE_ENABLE?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

/** Lanza si el engine no está habilitado — guard para todo camino que toque red/transporte en vivo. */
export function assertWarmupEngineEnabled(env: WarmupEnv = process.env): void {
  if (!warmupEngineEnabled(env)) {
    throw new Error(
      "warmup_engine_disabled: set WARMUP_ENGINE_ENABLE=true to run live paths (send/IMAP/RBL). " +
      "Default is OFF so the engine never sends on deploy."
    );
  }
}

/** Los dos transportes soportados en v1. Postfix es Track A real; mock nunca toca red. */
export type WarmupTransportKind = "postfix" | "mock";

/** Default fail-safe: en ausencia (o valor inválido) de la var, el engine NO envía correo real. */
const DEFAULT_WARMUP_TRANSPORT: WarmupTransportKind = "mock";

/** Puerto de submission SMTP por defecto (STARTTLS) si WARMUP_SMTP_PORT no se especifica. */
const DEFAULT_WARMUP_SMTP_PORT = 587;

/** Piso de placement por defecto (Wilson-LB ≥ 0.80). Espeja domain/types.ts (promoteInboxLowerBound). */
export const DEFAULT_WARMUP_PLACEMENT_MIN = 0.8;

/**
 * Resuelve qué transporte usa el Send Worker según WARMUP_TRANSPORT.
 * "postfix" | "mock" (case-insensitive). Default = "mock" (fail-safe: nunca envía sin querer).
 * Valor inválido ⇒ warning + fallback a "mock" (default-deny al envío real; no rompe el arranque).
 */
export function warmupTransportKind(env: WarmupEnv = process.env): WarmupTransportKind {
  const raw = env.WARMUP_TRANSPORT?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return DEFAULT_WARMUP_TRANSPORT;
  }
  if (raw === "postfix" || raw === "mock") {
    return raw;
  }
  console.warn(
    `warmup_transport_invalid: WARMUP_TRANSPORT="${env.WARMUP_TRANSPORT}" no es "postfix"|"mock"; ` +
    `usando "${DEFAULT_WARMUP_TRANSPORT}" (fail-safe, no envía correo real).`
  );
  return DEFAULT_WARMUP_TRANSPORT;
}

/** Host/puerto del Postfix de submission para el transporte real. */
export interface WarmupSmtpConfig {
  host: string;
  port: number;
}

/**
 * Lee el destino SMTP del transporte real desde el env 5.1 (WARMUP_SMTP_HOST/PORT).
 * Fail-closed: sin host NO se puede armar el transporte postfix ⇒ lanza con mensaje claro.
 * Puerto inválido ⇒ fallback al submission default (587) con warning, no rompe.
 */
export function readWarmupSmtpConfig(env: WarmupEnv = process.env): WarmupSmtpConfig {
  const host = env.WARMUP_SMTP_HOST?.trim();
  if (!host) {
    throw new Error(
      "warmup_smtp_host_missing: set WARMUP_SMTP_HOST to use WARMUP_TRANSPORT=postfix " +
      "(host del Postfix de submission)."
    );
  }
  const rawPort = env.WARMUP_SMTP_PORT?.trim();
  let port = DEFAULT_WARMUP_SMTP_PORT;
  if (rawPort) {
    const n = Number(rawPort);
    if (Number.isInteger(n) && n > 0 && n <= 65535) {
      port = n;
    } else {
      console.warn(
        `warmup_smtp_port_invalid: WARMUP_SMTP_PORT="${env.WARMUP_SMTP_PORT}" no es un puerto válido; ` +
        `usando ${DEFAULT_WARMUP_SMTP_PORT}.`
      );
    }
  }
  return { host, port };
}

/**
 * Piso de placement (Wilson-LB) que el filtro /warm expone (roadmap 5.1). El gate REAL de la FSM
 * vive en domain/types.ts (promoteInboxLowerBound); esto es la lectura configurable del umbral.
 * Valor fuera de (0,1] o no numérico ⇒ warning + default 0.80.
 */
export function warmupPlacementMin(env: WarmupEnv = process.env): number {
  const raw = env.WARMUP_PLACEMENT_MIN?.trim();
  if (!raw) {
    return DEFAULT_WARMUP_PLACEMENT_MIN;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && n <= 1) {
    return n;
  }
  console.warn(
    `warmup_placement_min_invalid: WARMUP_PLACEMENT_MIN="${env.WARMUP_PLACEMENT_MIN}" fuera de (0,1]; ` +
    `usando ${DEFAULT_WARMUP_PLACEMENT_MIN}.`
  );
  return DEFAULT_WARMUP_PLACEMENT_MIN;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura OAuth del seed inbox (XOAUTH2) — SOLO afecta la LECTURA en dry-run.
// ─────────────────────────────────────────────────────────────────────────────

/** Default del seed inbox de placement (nuestro setup de warmup). NO es secreto: es una dirección. */
export const DEFAULT_WARMUP_GMAIL_SEED_USER = "infradelivrixdemo@gmail.com";
/** Host IMAP del seed inbox por defecto. */
export const DEFAULT_WARMUP_GMAIL_IMAP_HOST = "imap.gmail.com";

/**
 * true solo si WARMUP_GMAIL_OAUTH_ENABLE está explícitamente en "true"/"1". Default OFF (fail-safe).
 * OJO: habilita SOLO la LECTURA real del seed inbox por OAuth; el ENVÍO en dry-run sigue mock.
 */
export function warmupGmailOAuthEnabled(env: WarmupEnv = process.env): boolean {
  const raw = env.WARMUP_GMAIL_OAUTH_ENABLE?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

/** Config del seed inbox (host/user/ruta del OAuth config), con defaults del setup de warmup. */
export interface WarmupGmailSeedConfig {
  host: string;
  user: string;
  /** Ruta del OAuth config; ausente ⇒ el proveedor usa su default relativo al repo root. */
  configPath?: string;
}

/** Lee host/user/configPath del seed inbox desde el env, con defaults. `configPath` opcional. */
export function readWarmupGmailSeedConfig(env: WarmupEnv = process.env): WarmupGmailSeedConfig {
  const host = env.WARMUP_GMAIL_IMAP_HOST?.trim() || DEFAULT_WARMUP_GMAIL_IMAP_HOST;
  const user = env.WARMUP_GMAIL_SEED_USER?.trim() || DEFAULT_WARMUP_GMAIL_SEED_USER;
  const configPath = env.WARMUP_GMAIL_OAUTH_CONFIG?.trim();
  return { host, user, ...(configPath ? { configPath } : {}) };
}

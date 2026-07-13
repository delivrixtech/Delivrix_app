// Contrato de los checks de auth (§8 del Diseño-v1) — Fase 1, Track A (self-hosted).
// Cada checker es PURO respecto a sus dependencias: recibe resolvers/clients inyectables, así los
// tests corren sin red. El resultado agregado alimenta el AuthReadinessContract que consume el
// auth-gate fail-closed de la Fase 0 (runtime/auth-gate.ts).

/** Veredicto de un check individual. `unknown` = no se pudo determinar ⇒ fail-closed aguas arriba. */
export type CheckVerdict = "pass" | "fail" | "unknown";

export interface CheckResult {
  id: AuthCheckId;
  verdict: CheckVerdict;
  /** Detalle legible para diagnóstico/audit (nunca secretos). */
  detail?: string;
}

/**
 * IDs canónicos de los checks (§8). NO cambiar los strings: son la clave del `checks` map del
 * AuthReadinessContract y del audit. `sendingLimits` del contrato se deriva aparte.
 */
export type AuthCheckId =
  // --- Común a ambos tracks ---
  | "SPF_PASS"
  | "DKIM_ALIGN"           // d= alineado con el From
  | "DMARC_PRESENT"        // ≥ p=none, alineado
  | "MX_VALID"
  | "IMAP_AUTH"
  | "SMTP_AUTH"
  | "TRACKING_DOMAIN_CLEAN"// no en DBL/SURBL/URIBL
  | "ONECLICK_UNSUB_CAP"   // capacidad RFC 8058
  // --- Solo self-hosted (v1, Track A) ---
  | "PTR_FCRDNS"           // rDNS forward-confirmed = HELO
  | "IP_NOT_BLOCKLISTED"   // Spamhaus ZEN / Barracuda / SpamCop
  | "DEDICATED_IP_SCHEDULE"// rampa de IP registrada y activa
  | "TLS_DELIVERY"
  | "HELO_FQDN";

/** Checks comunes a ambos tracks (§8). */
export const COMMON_CHECKS: readonly AuthCheckId[] = [
  "SPF_PASS", "DKIM_ALIGN", "DMARC_PRESENT", "MX_VALID",
  "IMAP_AUTH", "SMTP_AUTH", "TRACKING_DOMAIN_CLEAN", "ONECLICK_UNSUB_CAP"
];

/** Checks adicionales solo self-hosted (v1). */
export const SELF_HOSTED_CHECKS: readonly AuthCheckId[] = [
  "PTR_FCRDNS", "IP_NOT_BLOCKLISTED", "DEDICATED_IP_SCHEDULE", "TLS_DELIVERY", "HELO_FQDN"
];

/** Set completo de precondiciones bloqueantes de un nodo Postfix (v1). */
export const V1_REQUIRED_CHECKS: readonly AuthCheckId[] = [...COMMON_CHECKS, ...SELF_HOSTED_CHECKS];

/** Contexto que un checker necesita para evaluar un nodo (sin secretos: refs/handles, no valores). */
export interface AuthCheckContext {
  domain: string;
  /** FQDN de envío (smtp.<domain>). */
  smtpHost: string;
  sendingIp: string;
  heloFqdn: string;
  /** Selector DKIM publicado. */
  dkimSelector: string;
  /** Dominio de tracking propio (para TRACKING_DOMAIN_CLEAN). */
  trackingDomain?: string;
}

/** Un checker evalúa uno o más checks. Puro respecto a sus deps inyectadas. */
export interface AuthChecker {
  readonly ids: readonly AuthCheckId[];
  run(ctx: AuthCheckContext): Promise<CheckResult[]>;
}

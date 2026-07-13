// Checks de "liveness" / capacidad — Fase 1b, común a ambos tracks (§8 del Diseño-v1).
// Cubre los 4 checks comunes que faltaban: SMTP_AUTH, IMAP_AUTH, TRACKING_DOMAIN_CLEAN y
// ONECLICK_UNSUB_CAP.
//
// Reglas de diseño (idénticas al resto de la Fase 1, ver dns-auth-checks.ts / ip-network-checks.ts):
//   - PUROS respecto a la red: TODA I/O (submission SMTP, IMAP, DNSBL de dominio, capacidad de
//     unsub) entra por dependencias INYECTADAS, así los tests corren sin red. El ensamblador
//     (index.ts) conecta los probes/resolvers reales; acá NUNCA se importa node:net/tls/imapflow.
//   - FAIL-CLOSED no-negociable (§8/§14): cualquier throw, timeout o indeterminación ⇒ `unknown`.
//     NUNCA `pass` por defecto. `unknown` aguas arriba lo trata el auth-gate como bloqueante.
//   - CREDENCIALES POR REFERENCIA: SMTP_AUTH/IMAP_AUTH reciben un `secretRef` opaco (p.ej.
//     "vault://warmup/acme/smtp"), NUNCA el valor crudo. El secretRef jamás se loguea ni aparece en
//     `detail`; los probes reales resuelven la referencia contra el secret store fuera de este módulo.
//   - Sin secretos en `detail`: hosts/puertos/usuarios/dominios son diagnóstico legítimo; passwords,
//     tokens y el propio secretRef, jamás.
//   - Node 22 strip-types: sin parameter properties; factories que devuelven object literals.

import type {
  AuthCheckContext,
  AuthCheckId,
  AuthChecker,
  CheckResult
} from "../domain/auth-checks.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencias inyectables (las costuras de red). El ensamblador provee las reales.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opciones de un probe de autenticación (SMTP submission / IMAP). Las credenciales van por
 * REFERENCIA: `secretRef` es un handle opaco (p.ej. "vault://...") que el probe real resuelve
 * contra el secret store. NUNCA se pasa el password/token crudo por aquí ni por el ctx.
 */
export interface AuthProbeOptions {
  host: string;
  port: number;
  user: string;
  /** Referencia opaca a la credencial (vault://...). NUNCA el valor crudo, NUNCA se loguea. */
  secretRef: string;
}

/** Resultado de un probe de auth. `ok` = credenciales aceptadas. `detail` sin secretos. */
export interface AuthProbeResult {
  ok: boolean;
  /** Diagnóstico legible (p.ej. "AUTH LOGIN aceptado" / "535 auth rechazada"). Sin secretos. */
  detail?: string;
}

/**
 * Probe de submission SMTP (587 STARTTLS + AUTH LOGIN/PLAIN). Lo implementa el ensamblador.
 * Convención dura: `ok:true` ⇒ auth aceptada (pass); `ok:false` ⇒ auth rechazada (fail);
 * LANZAR ⇒ error de conexión/red/TLS ⇒ el checker lo cuenta como `unknown` (fail-closed).
 */
export interface SmtpAuthProbe {
  probe(opts: AuthProbeOptions): Promise<AuthProbeResult>;
}

/**
 * Probe de auth IMAP (login sobre IMAPS/STARTTLS). Análogo a SmtpAuthProbe: `ok` ⇒ pass/fail,
 * throw ⇒ unknown (fail-closed).
 */
export interface ImapAuthProbe {
  probe(opts: AuthProbeOptions): Promise<AuthProbeResult>;
}

/** Resultado de una consulta a una zona DNSBL de DOMINIO (DBL/SURBL/URIBL). */
export interface DomainBlocklistLookup {
  listed: boolean;
  /** TXT de la zona (motivo del listado). Diagnóstico, no secreto. */
  txt?: string;
}

/**
 * Resolver de blocklists de DOMINIO (a diferencia del RBL de IP en ip-network-checks.ts).
 * El ensamblador implementa la query real como `<domain>.<zone>` y mapea NXDOMAIN⇒no-listado,
 * respuesta positiva⇒listado. Lanza en fallo de red/resolución (⇒ error de esa zona).
 */
export interface DomainBlocklistResolver {
  isListed(domain: string, zone: string): Promise<DomainBlocklistLookup>;
}

/** Capacidad RFC 8058 declarada por el nodo/config: puede inyectar el par de headers one-click. */
export interface UnsubCapability {
  enabled: boolean;
  /** Endpoint HTTPS que recibe el POST `List-Unsubscribe=One-Click`. Diagnóstico, no secreto. */
  endpoint?: string;
}

/**
 * Proveedor de la capacidad de unsub one-click. Lo inyecta el ensamblador (config del nodo o una
 * consulta). Sync o async; puede lanzar (⇒ unknown, fail-closed).
 */
export type UnsubCapabilityProvider = (
  ctx: AuthCheckContext
) => Promise<UnsubCapability> | UnsubCapability;

// ─────────────────────────────────────────────────────────────────────────────
// Constantes (§8)
// ─────────────────────────────────────────────────────────────────────────────

/** Zonas DNSBL de DOMINIO consultadas por TRACKING_DOMAIN_CLEAN (§8: DBL / SURBL / URIBL). */
export const DEFAULT_DOMAIN_BLOCKLIST_ZONES: readonly string[] = [
  "dbl.spamhaus.org",
  "multi.surbl.org",
  "multi.uribl.com"
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers PUROS (sin red) — testeables aislados
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza un hostname/dominio para comparar: minúsculas + sin punto final. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function isByte(s: string): boolean {
  if (!/^\d{1,3}$/.test(s)) return false;
  const n = Number(s);
  return n >= 0 && n <= 255;
}

/** true si la cadena es una IP literal (IPv4 dotted o IPv6 con ':'), no un FQDN. */
export function isIpLiteral(host: string): boolean {
  const h = host.trim();
  if (h.includes(":")) return true; // IPv6
  const octets = h.split(".");
  return octets.length === 4 && octets.every(isByte);
}

/**
 * true si `host` es un FQDN válido: no IP literal, ≥2 labels, cada label RFC-1123
 * (alfanumérico + guion interno, ≤63 chars). NO consulta DNS.
 */
export function isValidFqdn(host: string): boolean {
  const h = normalizeHost(host);
  if (!h || isIpLiteral(h)) return false;
  const labels = h.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * Validador PURO del endpoint one-click (RFC 8058): debe ser una URL HTTPS con host FQDN válido
 * (no IP literal, no http://, no localhost sin dominio). Devuelve el motivo del rechazo o `null`
 * si es válido. NO toca la red.
 */
export function validateOneClickEndpoint(endpoint: string | undefined): string | null {
  if (!endpoint || !endpoint.trim()) return "endpoint ausente";
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return "endpoint no es una URL válida";
  }
  if (url.protocol !== "https:") return `endpoint no es https (${url.protocol}//)`;
  const host = url.hostname;
  if (isIpLiteral(host)) return "endpoint usa IP literal, requiere FQDN";
  if (!isValidFqdn(host)) return "endpoint host no es un FQDN válido";
  return null;
}

/** Mensaje de error corto y sin secretos para el `detail` de un `unknown`. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Envoltura FAIL-CLOSED: ejecuta el cuerpo del check y convierte CUALQUIER excepción en `unknown`.
 * Garantía dura de §8: un throw jamás se filtra como `pass`.
 */
async function guarded(
  id: AuthCheckId,
  body: () => Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await body();
  } catch (err) {
    return { id, verdict: "unknown", detail: `error: ${errMsg(err)}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Checks (§8, comunes a ambos tracks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SMTP_AUTH — probe de submission (587 STARTTLS + AUTH LOGIN/PLAIN). El probe real resuelve la
 * credencial por `secretRef`; aquí solo se orquesta con el veredicto:
 *   - probe ok ⇒ pass
 *   - auth rechazada (ok:false) ⇒ fail
 *   - error de conexión/red (throw) ⇒ unknown (fail-closed)
 * El `secretRef` NUNCA aparece en `detail`.
 */
export function createSmtpAuthChecker(probe: SmtpAuthProbe): AuthChecker {
  return createAuthProbeChecker("SMTP_AUTH", probe, "smtp");
}

/**
 * IMAP_AUTH — probe de login IMAP. Semántica idéntica a SMTP_AUTH (pass/fail/unknown), credencial
 * por `secretRef`, jamás en logs.
 */
export function createImapAuthChecker(probe: ImapAuthProbe): AuthChecker {
  return createAuthProbeChecker("IMAP_AUTH", probe, "imap");
}

/**
 * Fábrica común a SMTP_AUTH/IMAP_AUTH: ambos son un probe de auth con la misma semántica.
 * La credencial va por referencia (`secretRef`) y se resuelve el user/host/port del ctx.
 */
function createAuthProbeChecker(
  id: AuthCheckId,
  probe: SmtpAuthProbe | ImapAuthProbe,
  kind: "smtp" | "imap"
): AuthChecker {
  return {
    ids: [id],
    async run(ctx: AuthCheckContext): Promise<CheckResult[]> {
      return [await runProbe(ctx)];
    }
  };

  async function runProbe(ctx: AuthCheckContext): Promise<CheckResult> {
    return guarded(id, async () => {
      const opts = resolveProbeOptions(ctx, kind);
      if (!opts.host) {
        return { id, verdict: "unknown", detail: `${kind}: sin host en el contexto` };
      }
      if (!opts.secretRef) {
        // Sin credencial referenciada no se puede probar auth ⇒ fail-closed (no se asume pass).
        return { id, verdict: "unknown", detail: `${kind}: sin secretRef (credencial por referencia)` };
      }
      const res = await probe.probe(opts);
      // Blindaje extra: nunca dejamos que un detail del probe filtre el secretRef.
      const safeDetail = scrubSecretRef(res.detail, opts.secretRef);
      if (res.ok) {
        return {
          id,
          verdict: "pass",
          detail: safeDetail ?? `${kind}: auth aceptada en ${opts.host}:${opts.port}`
        };
      }
      return {
        id,
        verdict: "fail",
        detail: safeDetail ?? `${kind}: auth rechazada en ${opts.host}:${opts.port}`
      };
    });
  }
}

/**
 * Deriva host/port/user/secretRef del ctx para el probe. El ctx NO transporta el valor de la
 * credencial: `secretRef` es una referencia opaca. Convención v1: la referencia vive bajo el
 * dominio del nodo (el ensamblador puede sobreescribir esto conectando su propio provider).
 */
function resolveProbeOptions(ctx: AuthCheckContext, kind: "smtp" | "imap"): AuthProbeOptions {
  const host = normalizeHost(ctx.smtpHost || "");
  const port = kind === "smtp" ? 587 : 993;
  // Usuario de submission/IMAP convencional del nodo. NO es un secreto.
  const user = `warmup@${normalizeHost(ctx.domain || "")}`;
  // Referencia opaca a la credencial; el probe real la canjea contra el secret store.
  const secretRef = `vault://warmup/${normalizeHost(ctx.domain || "")}/${kind}`;
  return { host, port, user, secretRef };
}

/** Elimina cualquier aparición del secretRef en un detail del probe (defensa en profundidad). */
function scrubSecretRef(detail: string | undefined, secretRef: string): string | undefined {
  if (!detail) return detail;
  if (!secretRef) return detail;
  return detail.split(secretRef).join("[secretRef]");
}

/**
 * TRACKING_DOMAIN_CLEAN — el trackingDomain no está en blocklists de DOMINIO (DBL/SURBL/URIBL).
 *   - Sin trackingDomain en el ctx ⇒ pass (no aplica).
 *   - Listado en CUALQUIER zona ⇒ fail (zona en detail).
 *   - Limpio con ≥1 lookup exitoso ⇒ pass.
 *   - Error de resolución en TODAS las zonas ⇒ unknown (fail-closed).
 */
export function createTrackingDomainChecker(
  resolver: DomainBlocklistResolver,
  zones: readonly string[] = DEFAULT_DOMAIN_BLOCKLIST_ZONES
): AuthChecker {
  const id: AuthCheckId = "TRACKING_DOMAIN_CLEAN";
  return {
    ids: [id],
    async run(ctx: AuthCheckContext): Promise<CheckResult[]> {
      return [await runTracking(ctx)];
    }
  };

  async function runTracking(ctx: AuthCheckContext): Promise<CheckResult> {
    return guarded(id, async () => {
      const tracking = ctx.trackingDomain ? normalizeHost(ctx.trackingDomain) : "";
      if (!tracking) {
        return { id, verdict: "pass", detail: "tracking: sin dominio de tracking (no aplica)" };
      }
      const listedZones: string[] = [];
      let okLookups = 0;
      const errorZones: string[] = [];
      for (const zone of zones) {
        try {
          const res = await resolver.isListed(tracking, zone);
          okLookups++;
          if (res.listed) {
            listedZones.push(res.txt ? `${zone} (${res.txt})` : zone);
          }
        } catch (err) {
          errorZones.push(`${zone}: ${errMsg(err)}`);
        }
      }
      if (listedZones.length > 0) {
        return {
          id,
          verdict: "fail",
          detail: `${tracking} listado en: ${listedZones.join("; ")}`
        };
      }
      if (okLookups === 0) {
        return {
          id,
          verdict: "unknown",
          detail: `tracking sin respuesta en todas las zonas: ${errorZones.join("; ")}`
        };
      }
      return {
        id,
        verdict: "pass",
        detail: `${tracking} no listado (${okLookups}/${zones.length} zonas respondieron)`
      };
    });
  }
}

/**
 * ONECLICK_UNSUB_CAP — capacidad RFC 8058: el nodo puede inyectar `List-Unsubscribe` +
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` con un endpoint HTTPS válido.
 *   - enabled + endpoint https/FQDN válido ⇒ pass.
 *   - sin capacidad (enabled:false) o endpoint inválido/no-https ⇒ fail.
 *   - el provider lanza ⇒ unknown (fail-closed).
 */
export function createOneClickUnsubChecker(provider: UnsubCapabilityProvider): AuthChecker {
  const id: AuthCheckId = "ONECLICK_UNSUB_CAP";
  return {
    ids: [id],
    async run(ctx: AuthCheckContext): Promise<CheckResult[]> {
      return [await runUnsub(ctx)];
    }
  };

  async function runUnsub(ctx: AuthCheckContext): Promise<CheckResult> {
    return guarded(id, async () => {
      const cap = await provider(ctx);
      if (!cap.enabled) {
        return { id, verdict: "fail", detail: "unsub: nodo sin capacidad one-click (RFC 8058)" };
      }
      const reason = validateOneClickEndpoint(cap.endpoint);
      if (reason) {
        return { id, verdict: "fail", detail: `unsub: ${reason}` };
      }
      return {
        id,
        verdict: "pass",
        detail: `unsub: one-click habilitado (${normalizeHost(new URL(cap.endpoint!).hostname)})`
      };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory de ensamblaje: los 4 checkers de liveness/capacidad con sus deps inyectadas.
// ─────────────────────────────────────────────────────────────────────────────

/** Dependencias inyectadas para el paquete completo de checks de liveness/capacidad (§8). */
export interface LivenessCheckDeps {
  smtpProbe: SmtpAuthProbe;
  imapProbe: ImapAuthProbe;
  domainBlocklist: DomainBlocklistResolver;
  unsubProvider: UnsubCapabilityProvider;
  /** Zonas DNSBL de dominio (default: DBL / SURBL / URIBL). */
  domainBlocklistZones?: readonly string[];
}

/**
 * Devuelve los 4 checkers comunes de liveness/capacidad (§8) listos para el auth-gate:
 * SMTP_AUTH, IMAP_AUTH, TRACKING_DOMAIN_CLEAN, ONECLICK_UNSUB_CAP. El ensamblador conecta aquí los
 * probes/resolvers reales (detrás del feature flag). Todos fail-closed: cualquier throw ⇒ unknown.
 */
export function createLivenessCheckers(deps: LivenessCheckDeps): AuthChecker[] {
  return [
    createSmtpAuthChecker(deps.smtpProbe),
    createImapAuthChecker(deps.imapProbe),
    createTrackingDomainChecker(deps.domainBlocklist, deps.domainBlocklistZones),
    createOneClickUnsubChecker(deps.unsubProvider)
  ];
}

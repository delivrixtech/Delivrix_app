// Checks de IP / red / PTR / TLS — Fase 1, Track A (self-hosted, §8 del Diseño-v1).
// Cubre los 5 checks "solo self-hosted": PTR_FCRDNS, IP_NOT_BLOCKLISTED, TLS_DELIVERY, HELO_FQDN y
// DEDICATED_IP_SCHEDULE.
//
// Reglas de diseño (idénticas al resto de la Fase 1):
//   - PUROS respecto a la red: TODA I/O (DNS, RBL, TLS) entra por dependencias INYECTADAS, así los
//     tests corren sin red. El ensamblador (index.ts) conecta los resolvers reales detrás de un
//     feature flag; acá NUNCA se importa `node:dns`.
//   - FAIL-CLOSED no-negociable (§8/§14): cualquier error, timeout o indeterminación ⇒ `unknown`.
//     NUNCA `pass` por defecto. `unknown` aguas arriba lo trata el auth-gate como bloqueante.
//   - Sin secretos en `detail`: IPs/hosts/zonas son diagnóstico legítimo; credenciales jamás.
//   - Node 22 strip-types: sin parameter properties; se usan factories que devuelven object literals.

import type {
  AuthCheckContext,
  AuthCheckId,
  AuthChecker,
  CheckResult
} from "../domain/auth-checks.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencias inyectables (las costuras de red). El ensamblador provee las reales.
// ─────────────────────────────────────────────────────────────────────────────

/** Resolver DNS mínimo para PTR/FCrDNS y HELO. `reverse` = PTR de una IP; `resolve4` = A de un host. */
export interface ReverseDnsResolver {
  /** PTR de una IP (equivalente a dns.reverse). Devuelve [] si no hay PTR. Lanza en fallo de red. */
  reverse(ip: string): Promise<string[]>;
  /** Registros A (IPv4) de un host (equivalente a dns.resolve4). Devuelve [] si no hay. Lanza en fallo. */
  resolve4(host: string): Promise<string[]>;
}

/** Resultado de una consulta a una zona RBL. `listed` sale de que la query resuelva a un 127.0.0.x. */
export interface BlocklistLookup {
  listed: boolean;
  /** TXT de la zona (motivo del listado). Diagnóstico, no secreto. */
  txt?: string;
}

/**
 * Resolver de blocklists (DNSBL). El ensamblador implementa la query real como
 * `<ip-invertida>.<zone>` (ver `rblQuery`) y mapea NXDOMAIN⇒no-listado, 127.0.0.x⇒listado.
 * Lanza en fallo de red/resolución (⇒ el checker lo cuenta como error de esa zona).
 */
export interface BlocklistResolver {
  isListed(ip: string, zone: string): Promise<BlocklistLookup>;
}

/** Resultado de sondear STARTTLS/TLS contra un MTA. */
export interface TlsProbeResult {
  ok: boolean;
  /** Protocolo negociado (p.ej. "TLSv1.3"). Diagnóstico. */
  proto?: string;
  /** Detalle legible (p.ej. "STARTTLS ofrecido" / "cert expirado"). Sin secretos. */
  detail?: string;
}

/** Sonda TLS: intenta STARTTLS (25/587) o TLS directo. Lanza en error de conexión/red. */
export interface TlsProbe {
  probe(host: string, port: number): Promise<TlsProbeResult>;
}

/** Estado de la rampa de IP dedicada registrada (DEDICATED_IP_SCHEDULE). */
export interface DedicatedIpScheduleStatus {
  active: boolean;
  /** Diagnóstico: p.ej. "rampa día 3/56". Sin secretos. */
  detail?: string;
}

/**
 * Proveedor del estado de la rampa de IP dedicada. Lo inyecta el ensamblador (puede ser un simple
 * booleano/objeto o una consulta a Postgres). Sync o async; puede lanzar (⇒ unknown, fail-closed).
 */
export type DedicatedIpScheduleProvider = (
  ctx: AuthCheckContext
) => Promise<DedicatedIpScheduleStatus | boolean> | DedicatedIpScheduleStatus | boolean;

// ─────────────────────────────────────────────────────────────────────────────
// Constantes (§8)
// ─────────────────────────────────────────────────────────────────────────────

/** Zonas RBL consultadas por IP_NOT_BLOCKLISTED (§8: Spamhaus ZEN / Barracuda / SpamCop). */
export const DEFAULT_BLOCKLIST_ZONES: readonly string[] = [
  "zen.spamhaus.org",
  "b.barracudacentral.org",
  "bl.spamcop.net"
];

/** Puertos SMTP donde se sondea STARTTLS/TLS (submission 587 y SMTP 25). */
export const DEFAULT_TLS_PORTS: readonly number[] = [587, 25];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers PUROS (sin red) — testeables aislados
// ─────────────────────────────────────────────────────────────────────────────

/** Normaliza un hostname para comparar: minúsculas + sin punto final (FQDN absoluto). */
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
 * (alfanumérico + guion interno, ≤63 chars). NO consulta DNS (eso lo hace el check).
 */
export function isValidFqdn(host: string): boolean {
  const h = normalizeHost(host);
  if (!h || isIpLiteral(h)) return false;
  const labels = h.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/** Expande una IPv6 a sus 32 nibbles hex (para la reversión de DNS). Lanza si es inválida. */
function expandIpv6ToNibbles(ip: string): string {
  const parts = ip.split("::");
  if (parts.length > 2) throw new Error(`IPv6 inválida (múltiples '::'): ${ip}`);

  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - (head.length + tail.length);
  if (parts.length === 1) {
    if (head.length !== 8) throw new Error(`IPv6 inválida: ${ip}`);
  } else if (missing < 0) {
    throw new Error(`IPv6 inválida (demasiados grupos): ${ip}`);
  }

  const hextets =
    parts.length === 1
      ? head
      : [...head, ...Array.from({ length: missing }, () => "0"), ...tail];

  const nibbles = hextets
    .map((h) => {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) throw new Error(`IPv6 inválida (grupo '${h}'): ${ip}`);
      return h.toLowerCase().padStart(4, "0");
    })
    .join("");
  if (nibbles.length !== 32) throw new Error(`IPv6 inválida: ${ip}`);
  return nibbles;
}

/**
 * Invierte una IP a su forma DNS (rDNS / DNSBL). Helper PURO:
 *   - IPv4 `1.2.3.4`  ⇒ `4.3.2.1`
 *   - IPv6            ⇒ 32 nibbles invertidos separados por '.'
 * Lanza si la IP es inválida (⇒ el caller lo convierte en `unknown`).
 */
export function reverseIpForDns(ip: string): string {
  const t = ip.trim();
  if (t.includes(":")) {
    return expandIpv6ToNibbles(t).split("").reverse().join(".");
  }
  const octets = t.split(".");
  if (octets.length !== 4 || !octets.every(isByte)) {
    throw new Error(`IPv4 inválida: ${t}`);
  }
  return octets.slice().reverse().join(".");
}

/**
 * Construye el nombre de query DNSBL: `<ip-invertida>.<zone>`. Es lo que el ensamblador usa dentro
 * del `BlocklistResolver` real. PURO y testeado. Ej: rblQuery("1.2.3.4","zen.spamhaus.org")
 *   ⇒ "4.3.2.1.zen.spamhaus.org".
 */
export function rblQuery(ip: string, zone: string): string {
  return `${reverseIpForDns(ip)}.${normalizeHost(zone)}`;
}

/** Mensaje de error corto y sin secretos para el `detail` de un `unknown`. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Envoltura FAIL-CLOSED: ejecuta el cuerpo del check y convierte CUALQUIER excepción en `unknown`.
 * Es la garantía dura de §8: un throw jamás se filtra como `pass`.
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
// Checks (§8, solo self-hosted)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PTR_FCRDNS — rDNS forward-confirmed y alineado con el HELO.
 * Cierra el círculo si existe un PTR `p` tal que:
 *   1. `p` está en reverse(sendingIp),
 *   2. resolve4(p) incluye sendingIp (forward-confirmed), y
 *   3. `p` == heloFqdn (o == smtpHost) normalizado.
 * Círculo cerrado ⇒ pass. Falta cualquier pata ⇒ fail. Fallo del resolver ⇒ unknown (fail-closed).
 */
export function createPtrFcrdnsChecker(dns: ReverseDnsResolver): AuthChecker {
  const id: AuthCheckId = "PTR_FCRDNS";
  return {
    ids: [id],
    async run(ctx: AuthCheckContext): Promise<CheckResult[]> {
      return [await runPtr(ctx)];
    }
  };

  async function runPtr(ctx: AuthCheckContext): Promise<CheckResult> {
    return guarded(id, async () => {
      const ptrs = await dns.reverse(ctx.sendingIp);
      if (ptrs.length === 0) {
        return { id, verdict: "fail", detail: `sin PTR para ${ctx.sendingIp}` };
      }
      const expected = new Set([normalizeHost(ctx.heloFqdn), normalizeHost(ctx.smtpHost)]);
      const forwardConfirmed: string[] = [];
      for (const ptr of ptrs) {
        const a = await dns.resolve4(ptr);
        if (a.map((x) => x.trim()).includes(ctx.sendingIp.trim())) {
          forwardConfirmed.push(normalizeHost(ptr));
        }
      }
      if (forwardConfirmed.length === 0) {
        return {
          id,
          verdict: "fail",
          detail: `FCrDNS no cierra: ningún PTR (${ptrs.join(",")}) resuelve de vuelta a ${ctx.sendingIp}`
        };
      }
      const aligned = forwardConfirmed.find((p) => expected.has(p));
      if (!aligned) {
        return {
          id,
          verdict: "fail",
          detail: `PTR forward-confirmed (${forwardConfirmed.join(",")}) no coincide con HELO/smtp (${[...expected].join(",")})`
        };
      }
      return { id, verdict: "pass", detail: `FCrDNS ok: ${aligned} ↔ ${ctx.sendingIp}` };
    });
  }
}

/**
 * IP_NOT_BLOCKLISTED — consulta Spamhaus ZEN / Barracuda / SpamCop.
 *   - Listado en CUALQUIER zona ⇒ fail (zona en detail).
 *   - Ninguno listado (≥1 lookup exitoso) ⇒ pass.
 *   - Error de resolución en TODAS las zonas ⇒ unknown (fail-closed).
 */
export function createBlocklistChecker(
  rbl: BlocklistResolver,
  zones: readonly string[] = DEFAULT_BLOCKLIST_ZONES
): AuthChecker {
  const id: AuthCheckId = "IP_NOT_BLOCKLISTED";
  return {
    ids: [id],
    async run(ctx: AuthCheckContext): Promise<CheckResult[]> {
      return [await runBlocklist(ctx)];
    }
  };

  async function runBlocklist(ctx: AuthCheckContext): Promise<CheckResult> {
    return guarded(id, async () => {
      const listedZones: string[] = [];
      let okLookups = 0;
      const errorZones: string[] = [];
      for (const zone of zones) {
        try {
          const res = await rbl.isListed(ctx.sendingIp, zone);
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
          detail: `${ctx.sendingIp} listada en: ${listedZones.join("; ")}`
        };
      }
      if (okLookups === 0) {
        return {
          id,
          verdict: "unknown",
          detail: `RBL sin respuesta en todas las zonas: ${errorZones.join("; ")}`
        };
      }
      return {
        id,
        verdict: "pass",
        detail: `${ctx.sendingIp} no listada (${okLookups}/${zones.length} zonas respondieron)`
      };
    });
  }
}

/**
 * TLS_DELIVERY — sonda STARTTLS/TLS contra smtpHost en los puertos dados (587/25).
 *   - Algún puerto negocia TLS ok ⇒ pass.
 *   - Ningún ok pero al menos un sondeo respondió (ok:false) ⇒ fail.
 *   - Error en TODOS los puertos ⇒ unknown (fail-closed).
 */
export function createTlsDeliveryChecker(
  tls: TlsProbe,
  ports: readonly number[] = DEFAULT_TLS_PORTS
): AuthChecker {
  const id: AuthCheckId = "TLS_DELIVERY";
  return {
    ids: [id],
    async run(ctx: AuthCheckContext): Promise<CheckResult[]> {
      return [await runTls(ctx)];
    }
  };

  async function runTls(ctx: AuthCheckContext): Promise<CheckResult> {
    return guarded(id, async () => {
      let anyProbe = false;
      const failures: string[] = [];
      const errors: string[] = [];
      for (const port of ports) {
        try {
          const res = await tls.probe(ctx.smtpHost, port);
          anyProbe = true;
          if (res.ok) {
            const proto = res.proto ? ` ${res.proto}` : "";
            return {
              id,
              verdict: "pass",
              detail: `TLS ok en ${ctx.smtpHost}:${port}${proto}${res.detail ? ` — ${res.detail}` : ""}`
            };
          }
          failures.push(`${port}: ${res.detail ?? "sin TLS"}`);
        } catch (err) {
          errors.push(`${port}: ${errMsg(err)}`);
        }
      }
      if (!anyProbe) {
        return {
          id,
          verdict: "unknown",
          detail: `TLS sin respuesta en ${ctx.smtpHost}: ${errors.join("; ")}`
        };
      }
      return {
        id,
        verdict: "fail",
        detail: `sin TLS en ${ctx.smtpHost}: ${failures.join("; ")}`
      };
    });
  }
}

/**
 * HELO_FQDN — el heloFqdn es un FQDN válido (no IP literal, ≥2 labels) y resuelve (A ≥1).
 *   - Sintaxis inválida (IP literal / <2 labels) ⇒ fail (sin tocar DNS).
 *   - FQDN válido pero sin A ⇒ fail.
 *   - FQDN válido con A ⇒ pass.
 *   - Fallo del resolver ⇒ unknown (fail-closed).
 */
export function createHeloFqdnChecker(dns: ReverseDnsResolver): AuthChecker {
  const id: AuthCheckId = "HELO_FQDN";
  return {
    ids: [id],
    async run(ctx: AuthCheckContext): Promise<CheckResult[]> {
      return [await runHelo(ctx)];
    }
  };

  async function runHelo(ctx: AuthCheckContext): Promise<CheckResult> {
    return guarded(id, async () => {
      const helo = ctx.heloFqdn;
      if (isIpLiteral(helo)) {
        return { id, verdict: "fail", detail: `HELO es IP literal, no FQDN: ${helo}` };
      }
      if (!isValidFqdn(helo)) {
        return { id, verdict: "fail", detail: `HELO no es FQDN válido (≥2 labels): ${helo}` };
      }
      const a = await dns.resolve4(helo);
      if (a.length === 0) {
        return { id, verdict: "fail", detail: `HELO ${helo} no resuelve (sin A)` };
      }
      return { id, verdict: "pass", detail: `HELO FQDN válido y resuelve: ${normalizeHost(helo)}` };
    });
  }
}

/**
 * DEDICATED_IP_SCHEDULE — hay una rampa de IP dedicada registrada y activa.
 * El estado lo inyecta el ensamblador (booleano u objeto). Activa ⇒ pass, inactiva ⇒ fail,
 * error del proveedor ⇒ unknown (fail-closed).
 */
export function createDedicatedIpScheduleChecker(
  provider: DedicatedIpScheduleProvider
): AuthChecker {
  const id: AuthCheckId = "DEDICATED_IP_SCHEDULE";
  return {
    ids: [id],
    async run(ctx: AuthCheckContext): Promise<CheckResult[]> {
      return [await runSchedule(ctx)];
    }
  };

  async function runSchedule(ctx: AuthCheckContext): Promise<CheckResult> {
    return guarded(id, async () => {
      const status = await provider(ctx);
      const active = typeof status === "boolean" ? status : status.active;
      const detail = typeof status === "boolean" ? undefined : status.detail;
      if (active) {
        return { id, verdict: "pass", detail: detail ?? `rampa de IP activa para ${ctx.sendingIp}` };
      }
      return { id, verdict: "fail", detail: detail ?? `sin rampa de IP registrada para ${ctx.sendingIp}` };
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory de ensamblaje: todos los checkers de IP/red con sus deps inyectadas.
// ─────────────────────────────────────────────────────────────────────────────

/** Dependencias inyectadas para el paquete completo de checks de IP/red (self-hosted). */
export interface IpNetworkCheckDeps {
  dns: ReverseDnsResolver;
  rbl: BlocklistResolver;
  tls: TlsProbe;
  scheduleProvider: DedicatedIpScheduleProvider;
  /** Zonas RBL (default: Spamhaus ZEN / Barracuda / SpamCop). */
  blocklistZones?: readonly string[];
  /** Puertos TLS a sondear (default: 587, 25). */
  tlsPorts?: readonly number[];
}

/**
 * Devuelve los 5 checkers self-hosted (§8) listos para el auth-gate, en el orden de
 * SELF_HOSTED_CHECKS. El ensamblador conecta aquí los resolvers reales (detrás del feature flag).
 */
export function createIpNetworkCheckers(deps: IpNetworkCheckDeps): AuthChecker[] {
  return [
    createPtrFcrdnsChecker(deps.dns),
    createBlocklistChecker(deps.rbl, deps.blocklistZones),
    createDedicatedIpScheduleChecker(deps.scheduleProvider),
    createTlsDeliveryChecker(deps.tls, deps.tlsPorts),
    createHeloFqdnChecker(deps.dns)
  ];
}

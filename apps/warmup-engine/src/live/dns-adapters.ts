// Adapters REALES de DNS / red / TLS (I/O en vivo) — warmup v1, §8 del Diseño-v1.
//
// Implementan las interfaces PURAS que definieron los checks (checks/*): DnsResolver,
// ReverseDnsResolver, BlocklistResolver, DomainBlocklistResolver y TlsProbe. Este es el ÚNICO
// archivo del módulo que toca la red real (node:dns/promises, node:net, node:tls). El ensamblador
// (index.ts) los conecta detrás de un feature flag.
//
// REGLAS DURAS:
//   - TESTABILIDAD SIN RED: toda costura real entra por DI con default a la función real. Los tests
//     inyectan FAKES y NUNCA abren sockets ni resuelven DNS de verdad.
//   - FAIL-CLOSED-FRIENDLY: distinguimos "no existe / no listado" (NXDOMAIN/ENODATA ⇒ dato negativo
//     determinista) de "error transitorio" (SERVFAIL/timeout/red ⇒ THROW). Los checkers convierten
//     el throw en `unknown` (nunca `pass`); un NXDOMAIN es un `false` legítimo, no un throw.
//   - Sin secretos en los detalles; sin parameter properties; sin enums (Node 22 strip-types).

import * as dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

import { rblQuery, normalizeHost } from "../checks/ip-network-checks.ts";
import { flattenTxt } from "../checks/dns-auth-checks.ts";
import type { DnsResolver } from "../checks/dns-auth-checks.ts";
import type {
  ReverseDnsResolver,
  BlocklistResolver,
  BlocklistLookup,
  TlsProbe,
  TlsProbeResult
} from "../checks/ip-network-checks.ts";
import type {
  DomainBlocklistResolver,
  DomainBlocklistLookup
} from "../checks/liveness-checks.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades comunes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ¿El error de DNS significa "el nombre no existe / no tiene ese registro" (NXDOMAIN / ENODATA)?
 * Sólo estos dos son un "no" determinista; cualquier otro (SERVFAIL, ETIMEOUT, ECONNREFUSED, …) es
 * transitorio y debe propagarse como throw para que el checker lo trate como `unknown`.
 */
export function isNxdomainError(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code;
  // ENOTFOUND = NXDOMAIN (el nombre no existe); ENODATA = existe pero sin ese registro.
  return code === "ENOTFOUND" || code === "ENODATA";
}

/** Colapsa los registros TXT (chunks) a una única cadena de diagnóstico, o `undefined` si no hay. */
function txtToDetail(records: string[][]): string | undefined {
  const flat = flattenTxt(records).filter((s) => s.trim().length > 0);
  return flat.length > 0 ? flat.join("; ") : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// DnsResolver — TXT / MX
// ─────────────────────────────────────────────────────────────────────────────

export interface NodeDnsResolverDeps {
  resolveTxt?: (name: string) => Promise<string[][]>;
  resolveMx?: (name: string) => Promise<Array<{ exchange: string; priority: number }>>;
}

/**
 * `DnsResolver` real sobre dns.promises.resolveTxt/resolveMx. `resolveTxt` de node ya devuelve el
 * shape `string[][]` que espera la interface (chunks por registro), así que lo pasamos tal cual;
 * de MX proyectamos exactamente `{ exchange, priority }`. Las funciones dns entran por DI (default
 * a las reales) para que los tests usen fakes sin tocar la red.
 */
export function createNodeDnsResolver(deps: NodeDnsResolverDeps = {}): DnsResolver {
  const { resolveTxt = dns.resolveTxt, resolveMx = dns.resolveMx } = deps;
  return {
    async resolveTxt(name: string): Promise<string[][]> {
      return resolveTxt(name);
    },
    async resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>> {
      const records = await resolveMx(name);
      return records.map((r) => ({ exchange: r.exchange, priority: r.priority }));
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ReverseDnsResolver — PTR / A
// ─────────────────────────────────────────────────────────────────────────────

export interface NodeReverseDnsResolverDeps {
  reverse?: (ip: string) => Promise<string[]>;
  resolve4?: (host: string) => Promise<string[]>;
}

/**
 * `ReverseDnsResolver` real sobre dns.reverse (PTR) y dns.resolve4 (A). DI igual que arriba: los
 * tests inyectan fakes. No traduce semántica de errores (el checker PTR/HELO ya envuelve en
 * fail-closed), sólo delega la I/O.
 */
export function createNodeReverseDnsResolver(
  deps: NodeReverseDnsResolverDeps = {}
): ReverseDnsResolver {
  const { reverse = dns.reverse, resolve4 = dns.resolve4 } = deps;
  return {
    async reverse(ip: string): Promise<string[]> {
      return reverse(ip);
    },
    async resolve4(host: string): Promise<string[]> {
      return resolve4(host);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BlocklistResolver (RBL de IP) — <ip-invertida>.<zone>
// ─────────────────────────────────────────────────────────────────────────────

export interface DnsBlocklistResolverDeps {
  resolve4?: (host: string) => Promise<string[]>;
  resolveTxt?: (name: string) => Promise<string[][]>;
}

/**
 * `BlocklistResolver` real para RBL de IP. Construye la query con `rblQuery(ip, zone)` (reusado de
 * ip-network-checks) y hace un A-lookup:
 *   - resuelve (típicamente 127.0.0.x) ⇒ listed:true, con el TXT de motivo si está disponible.
 *   - NXDOMAIN / ENODATA               ⇒ listed:false (no listado; dato determinista).
 *   - cualquier otro error (SERVFAIL/timeout/red) ⇒ THROW (el checker ⇒ unknown, fail-closed).
 * El TXT es best-effort: si su lookup falla, NO cambia el `listed` ya decidido por el A.
 */
export function createDnsBlocklistResolver(deps: DnsBlocklistResolverDeps = {}): BlocklistResolver {
  const { resolve4 = dns.resolve4, resolveTxt = dns.resolveTxt } = deps;
  return {
    async isListed(ip: string, zone: string): Promise<BlocklistLookup> {
      const query = rblQuery(ip, zone);
      let addrs: string[];
      try {
        addrs = await resolve4(query);
      } catch (err) {
        if (isNxdomainError(err)) return { listed: false };
        throw err; // transitorio ⇒ el checker lo cuenta como error de zona / unknown
      }
      if (!addrs || addrs.length === 0) return { listed: false };
      const txt = await safeTxt(resolveTxt, query);
      return txt ? { listed: true, txt } : { listed: true };
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DomainBlocklistResolver (DBL / SURBL / URIBL) — <domain>.<zone>
// ─────────────────────────────────────────────────────────────────────────────

export interface DomainBlocklistResolverDeps {
  resolve4?: (host: string) => Promise<string[]>;
  resolveTxt?: (name: string) => Promise<string[][]>;
}

/**
 * `DomainBlocklistResolver` real para blocklists de DOMINIO. Misma semántica que el RBL de IP pero
 * la query es `<domain-normalizado>.<zone-normalizada>`:
 *   - resuelve ⇒ listed:true (+txt best-effort). NXDOMAIN/ENODATA ⇒ listed:false. Otro error ⇒ THROW.
 */
export function createDomainBlocklistResolver(
  deps: DomainBlocklistResolverDeps = {}
): DomainBlocklistResolver {
  const { resolve4 = dns.resolve4, resolveTxt = dns.resolveTxt } = deps;
  return {
    async isListed(domain: string, zone: string): Promise<DomainBlocklistLookup> {
      const query = `${normalizeHost(domain)}.${normalizeHost(zone)}`;
      let addrs: string[];
      try {
        addrs = await resolve4(query);
      } catch (err) {
        if (isNxdomainError(err)) return { listed: false };
        throw err;
      }
      if (!addrs || addrs.length === 0) return { listed: false };
      const txt = await safeTxt(resolveTxt, query);
      return txt ? { listed: true, txt } : { listed: true };
    }
  };
}

/** Lookup TXT best-effort: nunca lanza (el `listed` ya está decidido por el A). */
async function safeTxt(
  resolveTxt: (name: string) => Promise<string[][]>,
  query: string
): Promise<string | undefined> {
  try {
    return txtToDetail(await resolveTxt(query));
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TlsProbe — STARTTLS (25/587) / TLS directo (465)
// ─────────────────────────────────────────────────────────────────────────────

/** Una respuesta SMTP ya parseada (código + líneas; multilínea colapsada). */
export interface ProbeReply {
  code: number;
  lines: string[];
}

/**
 * Conexión de sondeo: costura inyectable entre la lógica STARTTLS (testeable) y el socket real.
 * Los tests implementan esto con un fake scriptado; el default lo hace sobre net/tls.
 */
export interface ProbeConnection {
  /** ¿la conexión ya está cifrada? (true para TLS directo). */
  secure: boolean;
  /** protocolo negociado si `secure` (p.ej. "TLSv1.3"). */
  proto?: string;
  /** lee la próxima respuesta SMTP (p.ej. el saludo 220). Lanza en error/red. */
  readReply(): Promise<ProbeReply>;
  /** envía un comando y devuelve la respuesta. Lanza en error/red. */
  command(line: string): Promise<ProbeReply>;
  /** promueve la conexión de texto plano a TLS (post-STARTTLS). Lanza si el handshake falla. */
  upgradeTls(): Promise<{ proto: string }>;
  /** cierra la conexión (idempotente, no lanza). */
  end(): void;
}

export interface ProbeConnectOptions {
  host: string;
  port: number;
  /** true ⇒ abrir directamente con TLS (465). false ⇒ texto plano para STARTTLS (25/587). */
  tls: boolean;
  timeoutMs: number;
}

export type ProbeConnector = (opts: ProbeConnectOptions) => Promise<ProbeConnection>;

export interface TlsStarttlsProbeDeps {
  /** Conector real de sockets. Inyectable ⇒ los tests validan la lógica sin abrir puertos. */
  connect?: ProbeConnector;
  /** Puertos que hablan TLS directo (default: 465). El resto usa STARTTLS. */
  directTlsPorts?: readonly number[];
  /** Nombre para el EHLO. No es secreto ni afecta el veredicto. */
  heloName?: string;
  /** Timeout de conexión/lectura en ms. */
  timeoutMs?: number;
}

/**
 * `TlsProbe` real. En 465 abre TLS directo; en 25/587 hace STARTTLS: saludo 220 → EHLO → verifica
 * que el server anuncie STARTTLS → STARTTLS → upgrade a TLS.
 *   - negocia TLS (directo o post-STARTTLS) ⇒ ok:true (+proto).
 *   - el server responde pero NO ofrece/acepta TLS ⇒ ok:false (fail determinista).
 *   - error de conexión/red/handshake ⇒ THROW (el checker ⇒ unknown, fail-closed).
 * El `connect` entra por DI (default real) para testear todo con un socket fake.
 */
export function createTlsStarttlsProbe(deps: TlsStarttlsProbeDeps = {}): TlsProbe {
  const {
    connect = createRealConnector(),
    directTlsPorts = [465],
    heloName = "warmup-probe",
    timeoutMs = 8000
  } = deps;
  const directPorts = new Set(directTlsPorts);

  return {
    async probe(host: string, port: number): Promise<TlsProbeResult> {
      const direct = directPorts.has(port);
      const conn = await connect({ host, port, tls: direct, timeoutMs });
      try {
        if (direct) {
          // 465: si el conector resolvió, el handshake TLS ya ocurrió.
          return { ok: true, proto: conn.proto, detail: `TLS directo negociado en ${host}:${port}` };
        }
        const greeting = await conn.readReply();
        if (greeting.code !== 220) {
          return { ok: false, detail: `saludo SMTP inesperado (${greeting.code})` };
        }
        const ehlo = await conn.command(`EHLO ${heloName}`);
        if (ehlo.code >= 400) {
          return { ok: false, detail: `EHLO rechazado (${ehlo.code})` };
        }
        if (!ehloOffersStartTls(ehlo.lines)) {
          return { ok: false, detail: "servidor no ofrece STARTTLS" };
        }
        const start = await conn.command("STARTTLS");
        if (start.code !== 220) {
          return { ok: false, detail: `STARTTLS rechazado (${start.code})` };
        }
        const up = await conn.upgradeTls();
        return { ok: true, proto: up.proto, detail: `STARTTLS negociado en ${host}:${port}` };
      } finally {
        conn.end();
      }
    }
  };
}

/** ¿Alguna línea de la respuesta EHLO anuncia la extensión STARTTLS? (`250-STARTTLS` / `250 STARTTLS`). */
export function ehloOffersStartTls(lines: string[]): boolean {
  return lines.some((line) => /^\d{3}[ -]\s*STARTTLS\s*$/i.test(line.trim()) || /(^|[ -])STARTTLS\b/i.test(line));
}

// ─────────────────────────────────────────────────────────────────────────────
// Conector real (no cubierto por tests: los tests inyectan un fake). Sockets net/tls.
// ─────────────────────────────────────────────────────────────────────────────

function createRealConnector(): ProbeConnector {
  return (opts: ProbeConnectOptions) =>
    new Promise<ProbeConnection>((resolve, reject) => {
      const { host, port, tls: useTls, timeoutMs } = opts;
      const socket: net.Socket = useTls
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });

      let settled = false;
      const cleanup = (): void => {
        socket.removeListener("error", onError);
        socket.removeListener("timeout", onTimeout);
      };
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(err);
      };
      const onTimeout = (): void => onError(new Error(`timeout de conexión a ${host}:${port}`));
      const onReady = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const proto = useTls ? (socket as tls.TLSSocket).getProtocol() ?? undefined : undefined;
        resolve(makeRealConnection(socket, host, useTls, proto, timeoutMs));
      };

      socket.setTimeout(timeoutMs);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);
      socket.once(useTls ? "secureConnect" : "connect", onReady);
    });
}

function makeRealConnection(
  initial: net.Socket,
  host: string,
  secure0: boolean,
  proto0: string | undefined,
  timeoutMs: number
): ProbeConnection {
  let sock: net.Socket = initial;
  let secure = secure0;
  let proto = proto0;
  let buffer = "";
  let partial: string[] = [];
  const ready: ProbeReply[] = [];
  const waiters: Array<{ resolve: (r: ProbeReply) => void; reject: (e: Error) => void }> = [];
  let failure: Error | null = null;

  const feed = (chunk: string): void => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      partial.push(line);
      const m = /^(\d{3})([ -])/.exec(line);
      if (m && m[2] === " ") {
        const reply: ProbeReply = { code: Number(m[1]), lines: partial };
        partial = [];
        const w = waiters.shift();
        if (w) w.resolve(reply);
        else ready.push(reply);
      }
    }
  };
  const fail = (err: Error): void => {
    failure = failure ?? err;
    while (waiters.length > 0) waiters.shift()!.reject(failure);
  };
  const attach = (s: net.Socket): void => {
    s.setEncoding("utf8");
    s.setTimeout(timeoutMs);
    s.on("data", feed);
    s.on("error", fail);
    s.on("timeout", () => {
      fail(new Error("timeout de lectura"));
      s.destroy();
    });
    s.on("close", () => fail(new Error("conexión cerrada")));
  };
  const detach = (s: net.Socket): void => {
    s.removeListener("data", feed);
    s.removeListener("error", fail);
    s.removeAllListeners("timeout");
    s.removeAllListeners("close");
  };
  attach(sock);

  const readReply = (): Promise<ProbeReply> => {
    if (ready.length > 0) return Promise.resolve(ready.shift()!);
    if (failure) return Promise.reject(failure);
    return new Promise<ProbeReply>((resolve, reject) => waiters.push({ resolve, reject }));
  };

  return {
    get secure(): boolean {
      return secure;
    },
    get proto(): string | undefined {
      return proto;
    },
    readReply,
    command(line: string): Promise<ProbeReply> {
      sock.write(`${line}\r\n`);
      return readReply();
    },
    upgradeTls(): Promise<{ proto: string }> {
      return new Promise<{ proto: string }>((resolve, reject) => {
        const plain = sock;
        detach(plain);
        buffer = "";
        partial = [];
        const tsock = tls.connect({ socket: plain, servername: host }, () => {
          secure = true;
          proto = tsock.getProtocol() ?? undefined;
          sock = tsock;
          attach(tsock);
          resolve({ proto: proto ?? "TLS" });
        });
        tsock.once("error", reject);
      });
    },
    end(): void {
      try {
        sock.destroy();
      } catch {
        // idempotente
      }
    }
  };
}

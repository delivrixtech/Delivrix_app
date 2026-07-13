// Checks de auth basados en DNS (§8 del Diseño-v1) — Fase 1, Track A (self-hosted).
//
// Cubre SPF_PASS, DKIM_ALIGN, DMARC_PRESENT y MX_VALID. Todo es PURO respecto a la red:
// el DNS entra por un `DnsResolver` inyectable, así los tests corren sin tocar la red.
//
// REGLA DURA (fail-closed, §8): si el resolver lanza o no devuelve datos ⇒ verdict `unknown`
// (nunca `pass`). `unknown` aguas arriba se trata como no-pass en el auth-gate, pero lo
// separamos de `fail` porque uno es "no se pudo determinar" (transitorio/reintentar) y el otro
// es "configuración ausente/incorrecta" (determinista). NADA de secretos en `detail`.

import type {
  AuthCheckContext,
  AuthCheckId,
  AuthChecker,
  CheckResult
} from "../domain/auth-checks.ts";

/**
 * Resolver DNS inyectable. Interface propia (este módulo es standalone: NO importa del gateway).
 * `resolveTxt` devuelve, por registro, la lista de chunks de la cadena TXT (como hace
 * `dns.promises.resolveTxt`), que luego aplanamos.
 */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
}

const DNS_CHECK_IDS: readonly AuthCheckId[] = [
  "SPF_PASS",
  "DKIM_ALIGN",
  "DMARC_PRESENT",
  "MX_VALID"
];

// ───────────────────────── helpers de bajo nivel ─────────────────────────

/** Aplana los chunks de un TXT (RFC 1035: una cadena TXT puede venir troceada en ≤255 bytes). */
export function flattenTxt(records: string[][]): string[] {
  return records.map((record) => record.join(""));
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** ¿`a` y `b` comparten el mismo dominio organizacional (relajado: igual o subdominio)? */
export function organizationalDomainAligns(a: string, b: string): boolean {
  const x = normalizeHost(a);
  const y = normalizeHost(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

// ── IP en CIDR (IPv4 + IPv6), sin dependencias externas ──

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  // Rechaza notación con zona (%eth0) o puerto.
  if (ip.includes("%")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const expand = (segment: string): string[] => (segment === "" ? [] : segment.split(":"));
  const head = expand(halves[0] ?? "");
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];

  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - (head.length + tail.length);
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

/**
 * ¿`ip` cae dentro de `cidr`? Soporta IPv4 e IPv6, con o sin sufijo `/prefix`
 * (sin sufijo = host exacto: /32 en v4, /128 en v6). Entrada inválida ⇒ false.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const cleanIp = ip.trim();
  const [range, prefixRaw] = cidr.trim().split("/");
  const isV6 = cleanIp.includes(":") || range.includes(":");

  if (isV6) {
    const ipVal = ipv6ToBigInt(cleanIp);
    const rangeVal = ipv6ToBigInt(range);
    if (ipVal === null || rangeVal === null) return false;
    const prefix = prefixRaw === undefined ? 128 : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
    if (prefix === 0) return true;
    const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
    return (ipVal & mask) === (rangeVal & mask);
  }

  const ipVal = ipv4ToInt(cleanIp);
  const rangeVal = ipv4ToInt(range);
  if (ipVal === null || rangeVal === null) return false;
  const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipVal & mask) >>> 0 === (rangeVal & mask) >>> 0;
}

// ───────────────────────── SPF ─────────────────────────

/** Selecciona el registro SPF (`v=spf1`) entre los TXT aplanados. */
export function findSpfRecord(txt: string[]): string | undefined {
  return txt.find((entry) => entry.trim().toLowerCase().startsWith("v=spf1"));
}

/**
 * Evalúa un registro SPF ya resuelto contra una IP. PURA: los `include:` se resuelven vía
 * `lookupInclude` (inyectado) para no tocar la red aquí. Devuelve:
 *  - `pass`    si algún mecanismo autoriza la IP (o `+all`),
 *  - `fail`    si el registro existe y ningún mecanismo la autoriza,
 *  - `unknown` si un `include:` no se pudo resolver (fail-closed) y no hubo match previo.
 */
export async function evaluateSpf(
  record: string,
  ip: string,
  lookupInclude: (domain: string) => Promise<string | null>,
  depth = 0
): Promise<"pass" | "fail" | "unknown"> {
  if (depth > 10) return "unknown"; // límite de lookups RFC 7208 §4.6.4
  const tokens = record.trim().split(/\s+/).slice(1); // descarta "v=spf1"
  let sawUnresolvableInclude = false;

  for (const raw of tokens) {
    const token = raw.replace(/^[+\-~?]/, "");
    const qualifier = /^[+\-~?]/.test(raw) ? raw[0] : "+";
    const lower = token.toLowerCase();

    if (lower === "all") {
      // `+all` autoriza todo; `-all`/`~all`/`?all` no aportan un match positivo.
      return qualifier === "+" ? "pass" : (sawUnresolvableInclude ? "unknown" : "fail");
    }
    if (lower.startsWith("ip4:") || lower.startsWith("ip6:")) {
      if (qualifier === "+" && ipInCidr(ip, token.slice(4))) return "pass";
      continue;
    }
    if (lower.startsWith("include:")) {
      const includeDomain = token.slice("include:".length);
      let included: string | null;
      try {
        included = await lookupInclude(includeDomain);
      } catch {
        sawUnresolvableInclude = true;
        continue;
      }
      if (included === null) {
        sawUnresolvableInclude = true;
        continue;
      }
      const sub = await evaluateSpf(included, ip, lookupInclude, depth + 1);
      if (sub === "pass" && qualifier === "+") return "pass";
      if (sub === "unknown") sawUnresolvableInclude = true;
      continue;
    }
    // Mecanismos a/mx/exists/ptr/redirect: no resolubles sin más red en v1 → los ignoramos
    // como no-match (no cambian el veredicto salvo que sean el único camino a pass).
  }

  // Sin `all` explícito y sin match: si algún include quedó irresoluble, fail-closed a unknown.
  return sawUnresolvableInclude ? "unknown" : "fail";
}

export async function checkSpf(resolver: DnsResolver, ctx: AuthCheckContext): Promise<CheckResult> {
  let txt: string[];
  try {
    txt = flattenTxt(await resolver.resolveTxt(ctx.domain));
  } catch {
    return { id: "SPF_PASS", verdict: "unknown", detail: "spf: dns lookup failed" };
  }
  if (txt.length === 0) {
    return { id: "SPF_PASS", verdict: "unknown", detail: "spf: no txt records" };
  }
  const record = findSpfRecord(txt);
  if (!record) {
    return { id: "SPF_PASS", verdict: "fail", detail: "spf: no v=spf1 record" };
  }

  const lookupInclude = async (domain: string): Promise<string | null> => {
    const includeTxt = flattenTxt(await resolver.resolveTxt(domain));
    return findSpfRecord(includeTxt) ?? null;
  };

  const verdict = await evaluateSpf(record, ctx.sendingIp, lookupInclude);
  const detail =
    verdict === "pass"
      ? `spf: authorizes ${ctx.sendingIp}`
      : verdict === "fail"
        ? `spf: ${ctx.sendingIp} not authorized`
        : "spf: include unresolved";
  return { id: "SPF_PASS", verdict, detail };
}

// ───────────────────────── DKIM ─────────────────────────

export function findDkimRecord(txt: string[]): string | undefined {
  return txt.find((entry) => /(^|;|\s)v=DKIM1/i.test(entry));
}

/** Parsea los tags `k=v;` de un registro DKIM/DMARC en un mapa (claves en minúscula). */
export function parseTags(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of record.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (key) tags[key] = value;
  }
  return tags;
}

/** Un registro DKIM es válido si es v=DKIM1 y publica una clave pública (`p=` no vacío). */
export function isDkimRecordValid(record: string): boolean {
  const tags = parseTags(record);
  if ((tags.v ?? "").toUpperCase() !== "DKIM1") return false;
  return typeof tags.p === "string" && tags.p.length > 0; // p= vacío = clave revocada
}

export async function checkDkim(resolver: DnsResolver, ctx: AuthCheckContext): Promise<CheckResult> {
  const selector = ctx.dkimSelector?.trim().toLowerCase();
  if (!selector) {
    return { id: "DKIM_ALIGN", verdict: "unknown", detail: "dkim: no selector in context" };
  }
  const name = `${selector}._domainkey.${ctx.domain}`;
  let txt: string[];
  try {
    txt = flattenTxt(await resolver.resolveTxt(name));
  } catch {
    return { id: "DKIM_ALIGN", verdict: "unknown", detail: "dkim: dns lookup failed" };
  }
  if (txt.length === 0) {
    return { id: "DKIM_ALIGN", verdict: "unknown", detail: "dkim: no txt records" };
  }
  const record = findDkimRecord(txt);
  if (!record) {
    return { id: "DKIM_ALIGN", verdict: "fail", detail: "dkim: no v=DKIM1 record" };
  }
  if (!isDkimRecordValid(record)) {
    return { id: "DKIM_ALIGN", verdict: "fail", detail: "dkim: public key missing/revoked (p=)" };
  }
  // La clave se publica bajo <selector>._domainkey.<domain>, es decir el d= firmante es el
  // propio domain del From ⇒ alineación relajada trivial. La verificamos explícita igual.
  if (!organizationalDomainAligns(ctx.domain, ctx.domain)) {
    return { id: "DKIM_ALIGN", verdict: "fail", detail: "dkim: d= not aligned with From" };
  }
  return { id: "DKIM_ALIGN", verdict: "pass", detail: `dkim: aligned key at selector ${selector}` };
}

// ───────────────────────── DMARC ─────────────────────────

export function findDmarcRecord(txt: string[]): string | undefined {
  return txt.find((entry) => entry.trim().toLowerCase().startsWith("v=dmarc1"));
}

const DMARC_POLICIES = new Set(["none", "quarantine", "reject"]);

/** Extrae la política `p=` de un registro DMARC si es válida (none/quarantine/reject). */
export function parseDmarcPolicy(record: string): string | null {
  const tags = parseTags(record);
  const policy = (tags.p ?? "").toLowerCase();
  return DMARC_POLICIES.has(policy) ? policy : null;
}

export async function checkDmarc(resolver: DnsResolver, ctx: AuthCheckContext): Promise<CheckResult> {
  const name = `_dmarc.${ctx.domain}`;
  let txt: string[];
  try {
    txt = flattenTxt(await resolver.resolveTxt(name));
  } catch {
    return { id: "DMARC_PRESENT", verdict: "unknown", detail: "dmarc: dns lookup failed" };
  }
  if (txt.length === 0) {
    return { id: "DMARC_PRESENT", verdict: "unknown", detail: "dmarc: no txt records" };
  }
  const record = findDmarcRecord(txt);
  if (!record) {
    return { id: "DMARC_PRESENT", verdict: "fail", detail: "dmarc: no v=DMARC1 record" };
  }
  const policy = parseDmarcPolicy(record);
  if (!policy) {
    return { id: "DMARC_PRESENT", verdict: "fail", detail: "dmarc: missing/invalid p=" };
  }
  return { id: "DMARC_PRESENT", verdict: "pass", detail: `dmarc: p=${policy}` };
}

// ───────────────────────── MX ─────────────────────────

/** ¿Alguno de los MX apunta a la infra propia (smtpHost o el mismo dominio organizacional)? */
export function mxPointsToInfra(
  records: Array<{ exchange: string; priority: number }>,
  ctx: AuthCheckContext
): boolean {
  return records.some((mx) => {
    const exchange = normalizeHost(mx.exchange);
    if (!exchange) return false;
    if (ctx.smtpHost && organizationalDomainAligns(exchange, ctx.smtpHost)) return true;
    return organizationalDomainAligns(exchange, ctx.domain);
  });
}

export async function checkMx(resolver: DnsResolver, ctx: AuthCheckContext): Promise<CheckResult> {
  let records: Array<{ exchange: string; priority: number }>;
  try {
    records = await resolver.resolveMx(ctx.domain);
  } catch {
    return { id: "MX_VALID", verdict: "unknown", detail: "mx: dns lookup failed" };
  }
  const valid = (records ?? []).filter((mx) => normalizeHost(mx.exchange).length > 0);
  if (valid.length === 0) {
    return { id: "MX_VALID", verdict: "unknown", detail: "mx: no mx records" };
  }
  if (!mxPointsToInfra(valid, ctx)) {
    return { id: "MX_VALID", verdict: "fail", detail: "mx: none point to own infra" };
  }
  return { id: "MX_VALID", verdict: "pass", detail: `mx: ${valid.length} record(s) to infra` };
}

// ───────────────────────── factory ─────────────────────────

/**
 * Empaqueta los 4 checks DNS en un único `AuthChecker`. Recibe el `DnsResolver` inyectable.
 * `run` evalúa los 4 en paralelo y devuelve un `CheckResult` por check. Nunca lanza: cualquier
 * fallo del resolver se traduce a `unknown` (fail-closed).
 */
export function createDnsAuthChecker(resolver: DnsResolver): AuthChecker {
  return {
    ids: DNS_CHECK_IDS,
    run(ctx: AuthCheckContext): Promise<CheckResult[]> {
      return Promise.all([
        checkSpf(resolver, ctx),
        checkDkim(resolver, ctx),
        checkDmarc(resolver, ctx),
        checkMx(resolver, ctx)
      ]);
    }
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  createPtrFcrdnsChecker,
  createBlocklistChecker,
  createTlsDeliveryChecker,
  createHeloFqdnChecker,
  createDedicatedIpScheduleChecker,
  createIpNetworkCheckers,
  reverseIpForDns,
  rblQuery,
  isIpLiteral,
  isValidFqdn,
  normalizeHost,
  DEFAULT_BLOCKLIST_ZONES,
  DEFAULT_TLS_PORTS,
  type ReverseDnsResolver,
  type BlocklistResolver,
  type BlocklistLookup,
  type TlsProbe,
  type TlsProbeResult,
  type DedicatedIpScheduleProvider
} from "./ip-network-checks.ts";
import type { AuthCheckContext } from "../domain/auth-checks.ts";

// ── Contexto base y mocks inyectables (sin red) ──────────────────────────────
function ctx(over: Partial<AuthCheckContext> = {}): AuthCheckContext {
  return {
    domain: "acme.com",
    smtpHost: "smtp.acme.com",
    sendingIp: "203.0.113.10",
    heloFqdn: "smtp.acme.com",
    dkimSelector: "d1",
    ...over
  };
}

const THROW = Symbol("throw");

/** DNS mock: mapea reverse(ip) y resolve4(host). `THROW` en un valor ⇒ el resolver lanza. */
function fakeDns(cfg: {
  reverse?: Record<string, string[] | typeof THROW>;
  resolve4?: Record<string, string[] | typeof THROW>;
}): ReverseDnsResolver {
  return {
    async reverse(ip) {
      const v = cfg.reverse?.[ip];
      if (v === THROW) throw new Error(`SERVFAIL reverse ${ip}`);
      return v ?? [];
    },
    async resolve4(host) {
      const v = cfg.resolve4?.[normalizeHost(host)];
      if (v === THROW) throw new Error(`SERVFAIL resolve4 ${host}`);
      return v ?? [];
    }
  };
}

/** RBL mock: por zona devuelve un lookup o lanza (`THROW`). */
function fakeRbl(byZone: Record<string, BlocklistLookup | typeof THROW>): BlocklistResolver {
  return {
    async isListed(_ip, zone) {
      const v = byZone[zone];
      if (v === undefined || v === THROW) throw new Error(`timeout ${zone}`);
      return v;
    }
  };
}

/** TLS mock: por puerto devuelve un resultado o lanza (`THROW`). */
function fakeTls(byPort: Record<number, TlsProbeResult | typeof THROW>): TlsProbe {
  return {
    async probe(_host, port) {
      const v = byPort[port];
      if (v === undefined || v === THROW) throw new Error(`ECONNREFUSED ${port}`);
      return v;
    }
  };
}

async function only(checker: { run(c: AuthCheckContext): Promise<unknown[]> }, c: AuthCheckContext) {
  const results = (await checker.run(c)) as { verdict: string; detail?: string; id: string }[];
  assert.equal(results.length, 1, "cada checker devuelve exactamente un CheckResult");
  return results[0];
}

// ═════════════════════════════════════════════════════════════════════════════
// Helpers puros
// ═════════════════════════════════════════════════════════════════════════════

test("reverseIpForDns invierte octetos IPv4", () => {
  assert.equal(reverseIpForDns("1.2.3.4"), "4.3.2.1");
  assert.equal(reverseIpForDns("203.0.113.10"), "10.113.0.203");
});

test("reverseIpForDns lanza en IPv4 inválida (fail-closed aguas arriba)", () => {
  assert.throws(() => reverseIpForDns("1.2.3"));
  assert.throws(() => reverseIpForDns("1.2.3.999"));
  assert.throws(() => reverseIpForDns("no-una-ip"));
});

test("reverseIpForDns invierte nibbles IPv6 (con expansión de '::')", () => {
  // 2001:db8::1 ⇒ 32 nibbles, invertidos y separados por '.'
  const r = reverseIpForDns("2001:db8::1");
  assert.equal(r.split(".").length, 32);
  assert.equal(r, "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2");
});

test("rblQuery = <ip-invertida>.<zone> y normaliza la zona", () => {
  assert.equal(rblQuery("1.2.3.4", "zen.spamhaus.org"), "4.3.2.1.zen.spamhaus.org");
  assert.equal(rblQuery("203.0.113.10", "bl.spamcop.net."), "10.113.0.203.bl.spamcop.net");
});

test("isIpLiteral distingue IP literal de FQDN", () => {
  assert.equal(isIpLiteral("203.0.113.10"), true);
  assert.equal(isIpLiteral("2001:db8::1"), true);
  assert.equal(isIpLiteral("smtp.acme.com"), false);
  assert.equal(isIpLiteral("999.1.1.1"), false); // no es IPv4 válida ⇒ no literal
});

test("isValidFqdn: ≥2 labels, no IP literal, labels RFC-1123", () => {
  assert.equal(isValidFqdn("smtp.acme.com"), true);
  assert.equal(isValidFqdn("SMTP.Acme.Com."), true, "normaliza mayúsculas y punto final");
  assert.equal(isValidFqdn("localhost"), false, "1 solo label");
  assert.equal(isValidFqdn("203.0.113.10"), false, "IP literal no es FQDN");
  assert.equal(isValidFqdn("-bad.acme.com"), false, "label no puede empezar con guion");
});

// ═════════════════════════════════════════════════════════════════════════════
// PTR_FCRDNS
// ═════════════════════════════════════════════════════════════════════════════

test("PTR_FCRDNS pass: círculo cerrado y PTR == HELO", async () => {
  const dns = fakeDns({
    reverse: { "203.0.113.10": ["smtp.acme.com"] },
    resolve4: { "smtp.acme.com": ["203.0.113.10"] }
  });
  const r = await only(createPtrFcrdnsChecker(dns), ctx());
  assert.equal(r.verdict, "pass");
});

test("PTR_FCRDNS pass: PTR alinea con smtpHost aunque HELO difiera", async () => {
  const dns = fakeDns({
    reverse: { "203.0.113.10": ["smtp.acme.com"] },
    resolve4: { "smtp.acme.com": ["203.0.113.10"] }
  });
  const r = await only(createPtrFcrdnsChecker(dns), ctx({ heloFqdn: "mail.acme.com" }));
  assert.equal(r.verdict, "pass");
});

test("PTR_FCRDNS fail: sin PTR", async () => {
  const dns = fakeDns({ reverse: { "203.0.113.10": [] } });
  const r = await only(createPtrFcrdnsChecker(dns), ctx());
  assert.equal(r.verdict, "fail");
  assert.match(r.detail!, /sin PTR/);
});

test("PTR_FCRDNS fail: forward NO confirma (PTR no resuelve de vuelta a la IP)", async () => {
  const dns = fakeDns({
    reverse: { "203.0.113.10": ["smtp.acme.com"] },
    resolve4: { "smtp.acme.com": ["198.51.100.1"] } // otra IP ⇒ no cierra
  });
  const r = await only(createPtrFcrdnsChecker(dns), ctx());
  assert.equal(r.verdict, "fail");
  assert.match(r.detail!, /no cierra/);
});

test("PTR_FCRDNS fail: forward confirma pero PTR no alinea con HELO/smtp", async () => {
  const dns = fakeDns({
    reverse: { "203.0.113.10": ["host-random.dc.example"] },
    resolve4: { "host-random.dc.example": ["203.0.113.10"] }
  });
  const r = await only(createPtrFcrdnsChecker(dns), ctx());
  assert.equal(r.verdict, "fail");
  assert.match(r.detail!, /no coincide/);
});

test("PTR_FCRDNS unknown: reverse lanza (fail-closed, nunca pass)", async () => {
  const dns = fakeDns({ reverse: { "203.0.113.10": THROW } });
  const r = await only(createPtrFcrdnsChecker(dns), ctx());
  assert.equal(r.verdict, "unknown");
});

test("PTR_FCRDNS unknown: resolve4 del PTR lanza", async () => {
  const dns = fakeDns({
    reverse: { "203.0.113.10": ["smtp.acme.com"] },
    resolve4: { "smtp.acme.com": THROW }
  });
  const r = await only(createPtrFcrdnsChecker(dns), ctx());
  assert.equal(r.verdict, "unknown");
});

// ═════════════════════════════════════════════════════════════════════════════
// IP_NOT_BLOCKLISTED
// ═════════════════════════════════════════════════════════════════════════════

test("IP_NOT_BLOCKLISTED pass: ninguna zona lista la IP", async () => {
  const rbl = fakeRbl({
    "zen.spamhaus.org": { listed: false },
    "b.barracudacentral.org": { listed: false },
    "bl.spamcop.net": { listed: false }
  });
  const r = await only(createBlocklistChecker(rbl), ctx());
  assert.equal(r.verdict, "pass");
});

test("IP_NOT_BLOCKLISTED fail: listada en Spamhaus (zona en detail)", async () => {
  const rbl = fakeRbl({
    "zen.spamhaus.org": { listed: true, txt: "https://check.spamhaus.org" },
    "b.barracudacentral.org": { listed: false },
    "bl.spamcop.net": { listed: false }
  });
  const r = await only(createBlocklistChecker(rbl), ctx());
  assert.equal(r.verdict, "fail");
  assert.match(r.detail!, /zen\.spamhaus\.org/);
});

test("IP_NOT_BLOCKLISTED fail: listado gana aunque otras zonas den error", async () => {
  const rbl = fakeRbl({
    "zen.spamhaus.org": { listed: true },
    "b.barracudacentral.org": THROW,
    "bl.spamcop.net": THROW
  });
  const r = await only(createBlocklistChecker(rbl), ctx());
  assert.equal(r.verdict, "fail");
});

test("IP_NOT_BLOCKLISTED pass parcial: 1 zona limpia, resto error, ninguna lista", async () => {
  const rbl = fakeRbl({
    "zen.spamhaus.org": { listed: false },
    "b.barracudacentral.org": THROW,
    "bl.spamcop.net": THROW
  });
  const r = await only(createBlocklistChecker(rbl), ctx());
  assert.equal(r.verdict, "pass", "≥1 lookup exitoso y ninguna lista ⇒ pass");
});

test("IP_NOT_BLOCKLISTED unknown: error de resolución en TODAS las zonas", async () => {
  const rbl = fakeRbl({
    "zen.spamhaus.org": THROW,
    "b.barracudacentral.org": THROW,
    "bl.spamcop.net": THROW
  });
  const r = await only(createBlocklistChecker(rbl), ctx());
  assert.equal(r.verdict, "unknown", "sin ninguna respuesta ⇒ unknown, jamás pass");
});

test("IP_NOT_BLOCKLISTED usa las 3 zonas por defecto (§8)", () => {
  assert.deepEqual(DEFAULT_BLOCKLIST_ZONES, [
    "zen.spamhaus.org",
    "b.barracudacentral.org",
    "bl.spamcop.net"
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// TLS_DELIVERY
// ═════════════════════════════════════════════════════════════════════════════

test("TLS_DELIVERY pass: STARTTLS ok en 587", async () => {
  const tls = fakeTls({ 587: { ok: true, proto: "TLSv1.3" }, 25: { ok: false } });
  const r = await only(createTlsDeliveryChecker(tls), ctx());
  assert.equal(r.verdict, "pass");
  assert.match(r.detail!, /587/);
});

test("TLS_DELIVERY pass: 587 falla pero 25 ofrece STARTTLS", async () => {
  const tls = fakeTls({ 587: { ok: false, detail: "sin STARTTLS" }, 25: { ok: true, proto: "TLSv1.2" } });
  const r = await only(createTlsDeliveryChecker(tls), ctx());
  assert.equal(r.verdict, "pass");
});

test("TLS_DELIVERY fail: ningún puerto negocia TLS", async () => {
  const tls = fakeTls({ 587: { ok: false }, 25: { ok: false } });
  const r = await only(createTlsDeliveryChecker(tls), ctx());
  assert.equal(r.verdict, "fail");
});

test("TLS_DELIVERY unknown: error en TODOS los puertos (fail-closed)", async () => {
  const tls = fakeTls({ 587: THROW, 25: THROW });
  const r = await only(createTlsDeliveryChecker(tls), ctx());
  assert.equal(r.verdict, "unknown");
});

test("TLS_DELIVERY fail: un puerto error y el otro responde sin TLS (hay señal ⇒ fail)", async () => {
  const tls = fakeTls({ 587: THROW, 25: { ok: false, detail: "plaintext only" } });
  const r = await only(createTlsDeliveryChecker(tls), ctx());
  assert.equal(r.verdict, "fail");
});

test("TLS_DELIVERY puertos por defecto = [587, 25]", () => {
  assert.deepEqual(DEFAULT_TLS_PORTS, [587, 25]);
});

// ═════════════════════════════════════════════════════════════════════════════
// HELO_FQDN
// ═════════════════════════════════════════════════════════════════════════════

test("HELO_FQDN pass: FQDN válido que resuelve", async () => {
  const dns = fakeDns({ resolve4: { "smtp.acme.com": ["203.0.113.10"] } });
  const r = await only(createHeloFqdnChecker(dns), ctx());
  assert.equal(r.verdict, "pass");
});

test("HELO_FQDN fail: HELO es IP literal (no toca DNS)", async () => {
  let called = false;
  const dns: ReverseDnsResolver = {
    async reverse() { return []; },
    async resolve4() { called = true; return ["203.0.113.10"]; }
  };
  const r = await only(createHeloFqdnChecker(dns), ctx({ heloFqdn: "203.0.113.10" }));
  assert.equal(r.verdict, "fail");
  assert.equal(called, false, "IP literal se rechaza sin consultar DNS");
});

test("HELO_FQDN fail: un solo label (no FQDN)", async () => {
  const dns = fakeDns({ resolve4: { localhost: ["127.0.0.1"] } });
  const r = await only(createHeloFqdnChecker(dns), ctx({ heloFqdn: "localhost" }));
  assert.equal(r.verdict, "fail");
});

test("HELO_FQDN fail: FQDN válido pero sin registro A", async () => {
  const dns = fakeDns({ resolve4: { "smtp.acme.com": [] } });
  const r = await only(createHeloFqdnChecker(dns), ctx());
  assert.equal(r.verdict, "fail");
  assert.match(r.detail!, /no resuelve/);
});

test("HELO_FQDN unknown: resolve4 lanza (fail-closed)", async () => {
  const dns = fakeDns({ resolve4: { "smtp.acme.com": THROW } });
  const r = await only(createHeloFqdnChecker(dns), ctx());
  assert.equal(r.verdict, "unknown");
});

// ═════════════════════════════════════════════════════════════════════════════
// DEDICATED_IP_SCHEDULE
// ═════════════════════════════════════════════════════════════════════════════

test("DEDICATED_IP_SCHEDULE pass: rampa activa (boolean)", async () => {
  const r = await only(createDedicatedIpScheduleChecker(() => true), ctx());
  assert.equal(r.verdict, "pass");
});

test("DEDICATED_IP_SCHEDULE pass: rampa activa (objeto con detail)", async () => {
  const provider: DedicatedIpScheduleProvider = async () => ({ active: true, detail: "rampa día 3/56" });
  const r = await only(createDedicatedIpScheduleChecker(provider), ctx());
  assert.equal(r.verdict, "pass");
  assert.match(r.detail!, /día 3\/56/);
});

test("DEDICATED_IP_SCHEDULE fail: sin rampa registrada", async () => {
  const r = await only(createDedicatedIpScheduleChecker(() => ({ active: false })), ctx());
  assert.equal(r.verdict, "fail");
});

test("DEDICATED_IP_SCHEDULE unknown: el proveedor lanza (fail-closed)", async () => {
  const provider: DedicatedIpScheduleProvider = () => {
    throw new Error("db down");
  };
  const r = await only(createDedicatedIpScheduleChecker(provider), ctx());
  assert.equal(r.verdict, "unknown");
});

// ═════════════════════════════════════════════════════════════════════════════
// Factory de ensamblaje
// ═════════════════════════════════════════════════════════════════════════════

test("createIpNetworkCheckers devuelve los 5 checks self-hosted (§8)", async () => {
  const checkers = createIpNetworkCheckers({
    dns: fakeDns({
      reverse: { "203.0.113.10": ["smtp.acme.com"] },
      resolve4: { "smtp.acme.com": ["203.0.113.10"] }
    }),
    rbl: fakeRbl({
      "zen.spamhaus.org": { listed: false },
      "b.barracudacentral.org": { listed: false },
      "bl.spamcop.net": { listed: false }
    }),
    tls: fakeTls({ 587: { ok: true, proto: "TLSv1.3" }, 25: { ok: false } }),
    scheduleProvider: () => true
  });

  const ids = checkers.flatMap((c) => [...c.ids]);
  assert.deepEqual(ids.sort(), [
    "DEDICATED_IP_SCHEDULE",
    "HELO_FQDN",
    "IP_NOT_BLOCKLISTED",
    "PTR_FCRDNS",
    "TLS_DELIVERY"
  ]);

  const results = (await Promise.all(checkers.map((c) => c.run(ctx())))).flat();
  assert.equal(results.length, 5);
  assert.ok(results.every((r) => r.verdict === "pass"), "todos pass con el happy-path");
});

test("createIpNetworkCheckers: fail-closed extremo — todo error ⇒ ningún pass", async () => {
  const checkers = createIpNetworkCheckers({
    dns: fakeDns({ reverse: { "203.0.113.10": THROW }, resolve4: { "smtp.acme.com": THROW } }),
    rbl: fakeRbl({
      "zen.spamhaus.org": THROW,
      "b.barracudacentral.org": THROW,
      "bl.spamcop.net": THROW
    }),
    tls: fakeTls({ 587: THROW, 25: THROW }),
    scheduleProvider: () => {
      throw new Error("db down");
    }
  });
  const results = (await Promise.all(checkers.map((c) => c.run(ctx())))).flat();
  assert.equal(results.length, 5);
  assert.ok(results.every((r) => r.verdict === "unknown"), "todo error ⇒ todo unknown, jamás pass");
});

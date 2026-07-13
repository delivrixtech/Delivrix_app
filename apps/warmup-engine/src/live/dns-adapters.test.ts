import assert from "node:assert/strict";
import test from "node:test";

import {
  createNodeDnsResolver,
  createNodeReverseDnsResolver,
  createDnsBlocklistResolver,
  createDomainBlocklistResolver,
  createTlsStarttlsProbe,
  isNxdomainError,
  ehloOffersStartTls,
  type ProbeConnection,
  type ProbeConnector,
  type ProbeConnectOptions,
  type ProbeReply
} from "./dns-adapters.ts";

// ── Helpers de fakes (NINGÚN test toca la red) ───────────────────────────────

/** Error de DNS con `code` (como los que lanza node:dns). */
function dnsErr(code: string): Error {
  const e = new Error(code) as Error & { code: string };
  e.code = code;
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// isNxdomainError — distingue "no existe" de "transitorio"
// ─────────────────────────────────────────────────────────────────────────────

test("isNxdomainError: ENOTFOUND/ENODATA son negativos; el resto es transitorio", () => {
  assert.equal(isNxdomainError(dnsErr("ENOTFOUND")), true);
  assert.equal(isNxdomainError(dnsErr("ENODATA")), true);
  assert.equal(isNxdomainError(dnsErr("ESERVFAIL")), false);
  assert.equal(isNxdomainError(dnsErr("ETIMEOUT")), false);
  assert.equal(isNxdomainError(new Error("boom")), false);
  assert.equal(isNxdomainError(undefined), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// createNodeDnsResolver — mapeo del shape de node
// ─────────────────────────────────────────────────────────────────────────────

test("createNodeDnsResolver: pasa TXT como string[][] y proyecta MX a {exchange,priority}", async () => {
  const calls: string[] = [];
  const resolver = createNodeDnsResolver({
    async resolveTxt(name) {
      calls.push(`txt:${name}`);
      return [["v=spf1 ", "include:_spf.acme.com -all"], ["otro=1"]];
    },
    async resolveMx(name) {
      calls.push(`mx:${name}`);
      // node añade props extra en la realidad; probamos que sólo se proyecta lo pactado.
      return [
        { exchange: "mx1.acme.com", priority: 10 },
        { exchange: "mx2.acme.com", priority: 20 }
      ];
    }
  });

  const txt = await resolver.resolveTxt("acme.com");
  assert.deepEqual(txt, [["v=spf1 ", "include:_spf.acme.com -all"], ["otro=1"]]);

  const mx = await resolver.resolveMx("acme.com");
  assert.deepEqual(mx, [
    { exchange: "mx1.acme.com", priority: 10 },
    { exchange: "mx2.acme.com", priority: 20 }
  ]);
  assert.deepEqual(calls, ["txt:acme.com", "mx:acme.com"]);
});

test("createNodeDnsResolver: propaga el throw del resolver (⇒ el checker lo hace unknown)", async () => {
  const resolver = createNodeDnsResolver({
    async resolveTxt() {
      throw dnsErr("ESERVFAIL");
    },
    async resolveMx() {
      throw dnsErr("ESERVFAIL");
    }
  });
  await assert.rejects(() => resolver.resolveTxt("acme.com"), /ESERVFAIL/);
  await assert.rejects(() => resolver.resolveMx("acme.com"), /ESERVFAIL/);
});

// ─────────────────────────────────────────────────────────────────────────────
// createNodeReverseDnsResolver — PTR / A
// ─────────────────────────────────────────────────────────────────────────────

test("createNodeReverseDnsResolver: delega reverse() y resolve4() en las fns inyectadas", async () => {
  const seen: string[] = [];
  const resolver = createNodeReverseDnsResolver({
    async reverse(ip) {
      seen.push(`rev:${ip}`);
      return ["mail.acme.com"];
    },
    async resolve4(host) {
      seen.push(`a:${host}`);
      return ["203.0.113.10"];
    }
  });
  assert.deepEqual(await resolver.reverse("203.0.113.10"), ["mail.acme.com"]);
  assert.deepEqual(await resolver.resolve4("mail.acme.com"), ["203.0.113.10"]);
  assert.deepEqual(seen, ["rev:203.0.113.10", "a:mail.acme.com"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// createDnsBlocklistResolver — RBL de IP: listed / NXDOMAIN / error transitorio
// ─────────────────────────────────────────────────────────────────────────────

test("RBL IP: A resuelve ⇒ listed:true con la query rblQuery(ip,zone) y el TXT de motivo", async () => {
  const queried: string[] = [];
  const rbl = createDnsBlocklistResolver({
    async resolve4(q) {
      queried.push(q);
      return ["127.0.0.2"];
    },
    async resolveTxt(q) {
      assert.equal(q, "4.3.2.1.zen.spamhaus.org");
      return [["https://www.spamhaus.org/query/ip/1.2.3.4"]];
    }
  });

  const res = await rbl.isListed("1.2.3.4", "zen.spamhaus.org");
  assert.deepEqual(res, {
    listed: true,
    txt: "https://www.spamhaus.org/query/ip/1.2.3.4"
  });
  // Verifica el REUSO de rblQuery: <ip-invertida>.<zone>.
  assert.deepEqual(queried, ["4.3.2.1.zen.spamhaus.org"]);
});

test("RBL IP: listed:true aunque el TXT falle (best-effort, no cambia el veredicto)", async () => {
  const rbl = createDnsBlocklistResolver({
    async resolve4() {
      return ["127.0.0.4"];
    },
    async resolveTxt() {
      throw dnsErr("ESERVFAIL");
    }
  });
  assert.deepEqual(await rbl.isListed("1.2.3.4", "zen.spamhaus.org"), { listed: true });
});

test("RBL IP: NXDOMAIN/ENODATA ⇒ listed:false (no listado, determinista)", async () => {
  for (const code of ["ENOTFOUND", "ENODATA"]) {
    const rbl = createDnsBlocklistResolver({
      async resolve4() {
        throw dnsErr(code);
      }
    });
    assert.deepEqual(
      await rbl.isListed("1.2.3.4", "zen.spamhaus.org"),
      { listed: false },
      `code=${code}`
    );
  }
});

test("RBL IP: error transitorio (SERVFAIL) ⇒ THROW (fail-closed ⇒ unknown en el checker)", async () => {
  const rbl = createDnsBlocklistResolver({
    async resolve4() {
      throw dnsErr("ESERVFAIL");
    }
  });
  await assert.rejects(() => rbl.isListed("1.2.3.4", "zen.spamhaus.org"), /ESERVFAIL/);
});

// ─────────────────────────────────────────────────────────────────────────────
// createDomainBlocklistResolver — DBL/SURBL/URIBL: query <domain>.<zone>
// ─────────────────────────────────────────────────────────────────────────────

test("DBL dominio: A resuelve ⇒ listed:true con query <domain>.<zone> normalizada", async () => {
  const queried: string[] = [];
  const dbl = createDomainBlocklistResolver({
    async resolve4(q) {
      queried.push(q);
      return ["127.0.1.2"];
    },
    async resolveTxt() {
      return [["spam domain"]];
    }
  });
  const res = await dbl.isListed("Bad.Example.COM.", "dbl.spamhaus.org");
  assert.deepEqual(res, { listed: true, txt: "spam domain" });
  assert.deepEqual(queried, ["bad.example.com.dbl.spamhaus.org"]);
});

test("DBL dominio: NXDOMAIN ⇒ listed:false; error transitorio ⇒ THROW", async () => {
  const clean = createDomainBlocklistResolver({
    async resolve4() {
      throw dnsErr("ENOTFOUND");
    }
  });
  assert.deepEqual(await clean.isListed("track.acme.com", "dbl.spamhaus.org"), { listed: false });

  const flaky = createDomainBlocklistResolver({
    async resolve4() {
      throw dnsErr("ECONNREFUSED");
    }
  });
  await assert.rejects(() => flaky.isListed("track.acme.com", "dbl.spamhaus.org"), /ECONNREFUSED/);
});

// ─────────────────────────────────────────────────────────────────────────────
// ehloOffersStartTls — helper puro
// ─────────────────────────────────────────────────────────────────────────────

test("ehloOffersStartTls: detecta STARTTLS anunciado y su ausencia", () => {
  assert.equal(ehloOffersStartTls(["250-mail.acme.com", "250-STARTTLS", "250 SIZE 10240000"]), true);
  assert.equal(ehloOffersStartTls(["250-mail.acme.com", "250 STARTTLS"]), true);
  assert.equal(ehloOffersStartTls(["250-mail.acme.com", "250 SIZE 10240000"]), false);
});

// ── Fake ProbeConnection scriptada (sin sockets reales) ──────────────────────

interface ConnScript {
  secure?: boolean;
  proto?: string;
  replies?: ProbeReply[];
  upgrade?: { proto: string } | Error;
  onEnd?: () => void;
}

function fakeConnection(script: ConnScript): ProbeConnection {
  const replies = [...(script.replies ?? [])];
  const conn: ProbeConnection = {
    secure: script.secure ?? false,
    proto: script.proto,
    async readReply(): Promise<ProbeReply> {
      const r = replies.shift();
      if (!r) throw new Error("script agotado: readReply inesperado");
      return r;
    },
    async command(_line: string): Promise<ProbeReply> {
      return conn.readReply();
    },
    async upgradeTls(): Promise<{ proto: string }> {
      if (script.upgrade instanceof Error) throw script.upgrade;
      return script.upgrade ?? { proto: "TLSv1.3" };
    },
    end(): void {
      script.onEnd?.();
    }
  };
  return conn;
}

/** Conector fake: mapea puerto ⇒ fábrica de conexión (o throw de red). Captura las opts vistas. */
function fakeConnector(
  byPort: Record<number, () => Promise<ProbeConnection>>,
  seen?: ProbeConnectOptions[]
): ProbeConnector {
  return async (opts) => {
    seen?.push(opts);
    const make = byPort[opts.port];
    if (!make) throw new Error(`ECONNREFUSED ${opts.port}`);
    return make();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createTlsStarttlsProbe — negocia / no-negocia / error
// ─────────────────────────────────────────────────────────────────────────────

test("TLS probe 587: STARTTLS ofrecido y negociado ⇒ ok:true con proto", async () => {
  const seen: ProbeConnectOptions[] = [];
  let ended = false;
  const probe = createTlsStarttlsProbe({
    connect: fakeConnector(
      {
        587: async () =>
          fakeConnection({
            replies: [
              { code: 220, lines: ["220 mail.acme.com ESMTP"] },
              { code: 250, lines: ["250-mail.acme.com", "250-STARTTLS", "250 SIZE 1000"] },
              { code: 220, lines: ["220 Go ahead"] }
            ],
            upgrade: { proto: "TLSv1.3" },
            onEnd: () => {
              ended = true;
            }
          })
      },
      seen
    )
  });

  const res = await probe.probe("smtp.acme.com", 587);
  assert.equal(res.ok, true);
  assert.equal(res.proto, "TLSv1.3");
  assert.equal(seen[0].tls, false, "587 se abre en texto plano (STARTTLS), no TLS directo");
  assert.equal(ended, true, "conn.end() se llama siempre (finally)");
});

test("TLS probe 587: servidor sin STARTTLS ⇒ ok:false (fail determinista, no throw)", async () => {
  const probe = createTlsStarttlsProbe({
    connect: fakeConnector({
      587: async () =>
        fakeConnection({
          replies: [
            { code: 220, lines: ["220 mail.acme.com ESMTP"] },
            { code: 250, lines: ["250-mail.acme.com", "250 SIZE 1000"] }
          ]
        })
    })
  });
  const res = await probe.probe("smtp.acme.com", 587);
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /STARTTLS/);
});

test("TLS probe 587: saludo != 220 ⇒ ok:false", async () => {
  const probe = createTlsStarttlsProbe({
    connect: fakeConnector({
      587: async () => fakeConnection({ replies: [{ code: 554, lines: ["554 no service"] }] })
    })
  });
  const res = await probe.probe("smtp.acme.com", 587);
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /554/);
});

test("TLS probe 587: STARTTLS rechazado por el server ⇒ ok:false", async () => {
  const probe = createTlsStarttlsProbe({
    connect: fakeConnector({
      587: async () =>
        fakeConnection({
          replies: [
            { code: 220, lines: ["220 ESMTP"] },
            { code: 250, lines: ["250-x", "250 STARTTLS"] },
            { code: 454, lines: ["454 TLS not available"] }
          ]
        })
    })
  });
  const res = await probe.probe("smtp.acme.com", 587);
  assert.equal(res.ok, false);
  assert.match(res.detail ?? "", /454/);
});

test("TLS probe 465: TLS directo negociado por el conector ⇒ ok:true", async () => {
  const seen: ProbeConnectOptions[] = [];
  const probe = createTlsStarttlsProbe({
    connect: fakeConnector(
      {
        465: async () => fakeConnection({ secure: true, proto: "TLSv1.2" })
      },
      seen
    )
  });
  const res = await probe.probe("smtp.acme.com", 465);
  assert.equal(res.ok, true);
  assert.equal(res.proto, "TLSv1.2");
  assert.equal(seen[0].tls, true, "465 abre TLS directo");
});

test("TLS probe: error de red del conector ⇒ THROW (fail-closed ⇒ unknown en el checker)", async () => {
  const probe = createTlsStarttlsProbe({
    connect: fakeConnector({}) // ningún puerto ⇒ el conector lanza ECONNREFUSED
  });
  await assert.rejects(() => probe.probe("smtp.acme.com", 25), /ECONNREFUSED/);
});

test("TLS probe: error durante el upgrade TLS ⇒ THROW", async () => {
  const probe = createTlsStarttlsProbe({
    connect: fakeConnector({
      587: async () =>
        fakeConnection({
          replies: [
            { code: 220, lines: ["220 ESMTP"] },
            { code: 250, lines: ["250 STARTTLS"] },
            { code: 220, lines: ["220 go"] }
          ],
          upgrade: new Error("handshake alert: unknown ca")
        })
    })
  });
  await assert.rejects(() => probe.probe("smtp.acme.com", 587), /handshake alert/);
});

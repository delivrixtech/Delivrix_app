import assert from "node:assert/strict";
import test from "node:test";
import type { AuthCheckContext } from "../domain/auth-checks.ts";
import {
  checkDkim,
  checkDmarc,
  checkMx,
  checkSpf,
  createDnsAuthChecker,
  evaluateSpf,
  findSpfRecord,
  ipInCidr,
  isDkimRecordValid,
  mxPointsToInfra,
  organizationalDomainAligns,
  parseDmarcPolicy,
  parseTags,
  type DnsResolver
} from "./dns-auth-checks.ts";

// ───────────────────────── mock resolver ─────────────────────────

interface MockData {
  txt?: Record<string, string[][]>;
  mx?: Record<string, Array<{ exchange: string; priority: number }>>;
  throwTxt?: Set<string>;
  throwMx?: Set<string>;
}

function mockResolver(data: MockData): DnsResolver {
  return {
    async resolveTxt(name) {
      if (data.throwTxt?.has(name)) throw new Error(`ENOTFOUND ${name}`);
      const record = data.txt?.[name];
      if (record === undefined) throw new Error(`ENODATA ${name}`); // ausencia = throw (como dns)
      return record;
    },
    async resolveMx(name) {
      if (data.throwMx?.has(name)) throw new Error(`ENOTFOUND ${name}`);
      const record = data.mx?.[name];
      if (record === undefined) throw new Error(`ENODATA ${name}`);
      return record;
    }
  };
}

const CTX: AuthCheckContext = {
  domain: "delivrix.io",
  smtpHost: "smtp.delivrix.io",
  sendingIp: "203.0.113.10",
  heloFqdn: "smtp.delivrix.io",
  dkimSelector: "warmup",
  trackingDomain: "track.delivrix.io"
};

// as single-chunk TXT records (as dns.resolveTxt returns arrays of chunks)
const txt = (s: string): string[][] => [[s]];

// ───────────────────────── pure helpers: ipInCidr ─────────────────────────

test("ipInCidr: IPv4 host exacto sin prefijo", () => {
  assert.equal(ipInCidr("203.0.113.10", "203.0.113.10"), true);
  assert.equal(ipInCidr("203.0.113.11", "203.0.113.10"), false);
});

test("ipInCidr: IPv4 dentro y fuera de un /24", () => {
  assert.equal(ipInCidr("203.0.113.200", "203.0.113.0/24"), true);
  assert.equal(ipInCidr("203.0.114.1", "203.0.113.0/24"), false);
});

test("ipInCidr: IPv4 /0 autoriza todo", () => {
  assert.equal(ipInCidr("8.8.8.8", "0.0.0.0/0"), true);
});

test("ipInCidr: IPv6 dentro y fuera de un /32", () => {
  assert.equal(ipInCidr("2001:db8::1", "2001:db8::/32"), true);
  assert.equal(ipInCidr("2001:db9::1", "2001:db8::/32"), false);
});

test("ipInCidr: IPv6 host exacto con ::", () => {
  assert.equal(ipInCidr("2001:db8::1", "2001:db8::1"), true);
  assert.equal(ipInCidr("2001:db8::2", "2001:db8::1"), false);
});

test("ipInCidr: entrada inválida ⇒ false (no lanza)", () => {
  assert.equal(ipInCidr("999.1.1.1", "203.0.113.0/24"), false);
  assert.equal(ipInCidr("203.0.113.10", "bogus"), false);
  assert.equal(ipInCidr("203.0.113.10", "203.0.113.0/40"), false);
});

// ───────────────────────── pure helpers: alignment / tags ─────────────────────────

test("organizationalDomainAligns: igual, subdominio y no-match", () => {
  assert.equal(organizationalDomainAligns("delivrix.io", "delivrix.io"), true);
  assert.equal(organizationalDomainAligns("smtp.delivrix.io", "delivrix.io"), true);
  assert.equal(organizationalDomainAligns("delivrix.io", "smtp.delivrix.io"), true);
  assert.equal(organizationalDomainAligns("evil.com", "delivrix.io"), false);
});

test("parseTags: parsea k=v; y baja las claves", () => {
  assert.deepEqual(parseTags("v=DKIM1; k=rsa; p=ABC"), { v: "DKIM1", k: "rsa", p: "ABC" });
});

test("parseDmarcPolicy: acepta none/quarantine/reject, rechaza el resto", () => {
  assert.equal(parseDmarcPolicy("v=DMARC1; p=none"), "none");
  assert.equal(parseDmarcPolicy("v=DMARC1; p=quarantine"), "quarantine");
  assert.equal(parseDmarcPolicy("v=DMARC1; p=reject"), "reject");
  assert.equal(parseDmarcPolicy("v=DMARC1; sp=reject"), null); // falta p=
  assert.equal(parseDmarcPolicy("v=DMARC1; p=bogus"), null);
});

test("isDkimRecordValid: v=DKIM1 + p no vacío", () => {
  assert.equal(isDkimRecordValid("v=DKIM1; k=rsa; p=MIGf..."), true);
  assert.equal(isDkimRecordValid("v=DKIM1; k=rsa; p="), false); // clave revocada
  assert.equal(isDkimRecordValid("v=spf1 -all"), false);
});

test("findSpfRecord: selecciona el v=spf1 entre varios TXT", () => {
  assert.equal(findSpfRecord(["some-verification=abc", "v=spf1 -all"]), "v=spf1 -all");
  assert.equal(findSpfRecord(["no-spf-here"]), undefined);
});

// ───────────────────────── evaluateSpf (pura) ─────────────────────────

const noInclude = async (): Promise<string | null> => null;

test("evaluateSpf: ip4 autoriza ⇒ pass", async () => {
  assert.equal(await evaluateSpf("v=spf1 ip4:203.0.113.0/24 -all", "203.0.113.10", noInclude), "pass");
});

test("evaluateSpf: ip6 autoriza ⇒ pass", async () => {
  assert.equal(await evaluateSpf("v=spf1 ip6:2001:db8::/32 -all", "2001:db8::5", noInclude), "pass");
});

test("evaluateSpf: registro existe pero IP fuera ⇒ fail", async () => {
  assert.equal(await evaluateSpf("v=spf1 ip4:198.51.100.0/24 -all", "203.0.113.10", noInclude), "fail");
});

test("evaluateSpf: +all autoriza todo ⇒ pass", async () => {
  assert.equal(await evaluateSpf("v=spf1 +all", "203.0.113.10", noInclude), "pass");
});

test("evaluateSpf: include que autoriza ⇒ pass", async () => {
  const lookup = async (d: string) =>
    d === "_spf.provider.com" ? "v=spf1 ip4:203.0.113.0/24 -all" : null;
  assert.equal(
    await evaluateSpf("v=spf1 include:_spf.provider.com -all", "203.0.113.10", lookup),
    "pass"
  );
});

test("evaluateSpf: include irresoluble y sin otro match ⇒ unknown (fail-closed)", async () => {
  const lookup = async (): Promise<string | null> => {
    throw new Error("dns down");
  };
  assert.equal(
    await evaluateSpf("v=spf1 include:_spf.provider.com -all", "203.0.113.10", lookup),
    "unknown"
  );
});

test("evaluateSpf: include null y sin match ⇒ unknown", async () => {
  assert.equal(
    await evaluateSpf("v=spf1 include:_spf.provider.com -all", "203.0.113.10", noInclude),
    "unknown"
  );
});

test("evaluateSpf: match directo gana aunque haya include irresoluble después", async () => {
  const lookup = async (): Promise<string | null> => {
    throw new Error("dns down");
  };
  assert.equal(
    await evaluateSpf("v=spf1 ip4:203.0.113.10 include:x.com -all", "203.0.113.10", lookup),
    "pass"
  );
});

test("evaluateSpf: recursión infinita cortada por depth ⇒ unknown", async () => {
  const lookup = async () => "v=spf1 include:loop.com -all"; // se auto-incluye
  assert.equal(await evaluateSpf("v=spf1 include:loop.com -all", "203.0.113.10", lookup), "unknown");
});

// ───────────────────────── checkSpf ─────────────────────────

test("checkSpf: pass cuando el TXT autoriza la IP", async () => {
  const r = mockResolver({ txt: { "delivrix.io": txt("v=spf1 ip4:203.0.113.0/24 -all") } });
  const res = await checkSpf(r, CTX);
  assert.equal(res.id, "SPF_PASS");
  assert.equal(res.verdict, "pass");
});

test("checkSpf: fail cuando existe SPF pero no autoriza la IP", async () => {
  const r = mockResolver({ txt: { "delivrix.io": txt("v=spf1 ip4:198.51.100.0/24 -all") } });
  assert.equal((await checkSpf(r, CTX)).verdict, "fail");
});

test("checkSpf: fail cuando hay TXT pero ningún v=spf1", async () => {
  const r = mockResolver({ txt: { "delivrix.io": txt("google-site-verification=xyz") } });
  assert.equal((await checkSpf(r, CTX)).verdict, "fail");
});

test("checkSpf: unknown cuando el resolver lanza (fail-closed, NO pass)", async () => {
  const r = mockResolver({ throwTxt: new Set(["delivrix.io"]) });
  const res = await checkSpf(r, CTX);
  assert.equal(res.verdict, "unknown");
  assert.notEqual(res.verdict, "pass");
});

test("checkSpf: unknown cuando el TXT viene vacío", async () => {
  const r = mockResolver({ txt: { "delivrix.io": [] } });
  assert.equal((await checkSpf(r, CTX)).verdict, "unknown");
});

test("checkSpf: unknown cuando el include no resuelve", async () => {
  const r = mockResolver({
    txt: { "delivrix.io": txt("v=spf1 include:_spf.provider.com -all") },
    throwTxt: new Set(["_spf.provider.com"])
  });
  assert.equal((await checkSpf(r, CTX)).verdict, "unknown");
});

// ───────────────────────── checkDkim ─────────────────────────

const dkimName = "warmup._domainkey.delivrix.io";

test("checkDkim: pass con v=DKIM1 y p= no vacío", async () => {
  const r = mockResolver({ txt: { [dkimName]: txt("v=DKIM1; k=rsa; p=MIGfMA0...") } });
  const res = await checkDkim(r, CTX);
  assert.equal(res.id, "DKIM_ALIGN");
  assert.equal(res.verdict, "pass");
});

test("checkDkim: fail con p= vacío (clave revocada)", async () => {
  const r = mockResolver({ txt: { [dkimName]: txt("v=DKIM1; k=rsa; p=") } });
  assert.equal((await checkDkim(r, CTX)).verdict, "fail");
});

test("checkDkim: fail cuando hay TXT pero ningún v=DKIM1", async () => {
  const r = mockResolver({ txt: { [dkimName]: txt("not-a-dkim-record") } });
  assert.equal((await checkDkim(r, CTX)).verdict, "fail");
});

test("checkDkim: unknown cuando el resolver lanza", async () => {
  const r = mockResolver({ throwTxt: new Set([dkimName]) });
  assert.equal((await checkDkim(r, CTX)).verdict, "unknown");
});

test("checkDkim: unknown cuando el TXT viene vacío", async () => {
  const r = mockResolver({ txt: { [dkimName]: [] } });
  assert.equal((await checkDkim(r, CTX)).verdict, "unknown");
});

test("checkDkim: unknown cuando no hay selector en el contexto", async () => {
  const r = mockResolver({ txt: { [dkimName]: txt("v=DKIM1; p=abc") } });
  assert.equal((await checkDkim(r, { ...CTX, dkimSelector: "" })).verdict, "unknown");
});

// ───────────────────────── checkDmarc ─────────────────────────

const dmarcName = "_dmarc.delivrix.io";

test("checkDmarc: pass con p=none (>= none cuenta como present)", async () => {
  const r = mockResolver({ txt: { [dmarcName]: txt("v=DMARC1; p=none; rua=mailto:x@delivrix.io") } });
  const res = await checkDmarc(r, CTX);
  assert.equal(res.id, "DMARC_PRESENT");
  assert.equal(res.verdict, "pass");
});

test("checkDmarc: pass con p=reject", async () => {
  const r = mockResolver({ txt: { [dmarcName]: txt("v=DMARC1; p=reject") } });
  assert.equal((await checkDmarc(r, CTX)).verdict, "pass");
});

test("checkDmarc: fail con v=DMARC1 pero sin p= válido", async () => {
  const r = mockResolver({ txt: { [dmarcName]: txt("v=DMARC1; rua=mailto:x@delivrix.io") } });
  assert.equal((await checkDmarc(r, CTX)).verdict, "fail");
});

test("checkDmarc: fail cuando hay TXT pero ningún v=DMARC1", async () => {
  const r = mockResolver({ txt: { [dmarcName]: txt("some-other-txt") } });
  assert.equal((await checkDmarc(r, CTX)).verdict, "fail");
});

test("checkDmarc: unknown cuando el resolver lanza", async () => {
  const r = mockResolver({ throwTxt: new Set([dmarcName]) });
  assert.equal((await checkDmarc(r, CTX)).verdict, "unknown");
});

test("checkDmarc: unknown cuando el TXT viene vacío", async () => {
  const r = mockResolver({ txt: { [dmarcName]: [] } });
  assert.equal((await checkDmarc(r, CTX)).verdict, "unknown");
});

// ───────────────────────── mxPointsToInfra + checkMx ─────────────────────────

test("mxPointsToInfra: matchea el smtpHost", () => {
  assert.equal(
    mxPointsToInfra([{ exchange: "smtp.delivrix.io.", priority: 10 }], CTX),
    true
  );
});

test("mxPointsToInfra: matchea por dominio organizacional", () => {
  assert.equal(mxPointsToInfra([{ exchange: "mail.delivrix.io", priority: 10 }], CTX), true);
});

test("mxPointsToInfra: no matchea infra ajena", () => {
  assert.equal(mxPointsToInfra([{ exchange: "aspmx.l.google.com", priority: 1 }], CTX), false);
});

test("checkMx: pass con MX que apunta a la infra", async () => {
  const r = mockResolver({ mx: { "delivrix.io": [{ exchange: "smtp.delivrix.io", priority: 10 }] } });
  const res = await checkMx(r, CTX);
  assert.equal(res.id, "MX_VALID");
  assert.equal(res.verdict, "pass");
});

test("checkMx: fail cuando los MX no apuntan a la infra", async () => {
  const r = mockResolver({ mx: { "delivrix.io": [{ exchange: "aspmx.l.google.com", priority: 1 }] } });
  assert.equal((await checkMx(r, CTX)).verdict, "fail");
});

test("checkMx: unknown cuando el resolver lanza", async () => {
  const r = mockResolver({ throwMx: new Set(["delivrix.io"]) });
  assert.equal((await checkMx(r, CTX)).verdict, "unknown");
});

test("checkMx: unknown cuando no hay MX (lista vacía)", async () => {
  const r = mockResolver({ mx: { "delivrix.io": [] } });
  assert.equal((await checkMx(r, CTX)).verdict, "unknown");
});

test("checkMx: unknown cuando los MX vienen con exchange vacío", async () => {
  const r = mockResolver({ mx: { "delivrix.io": [{ exchange: "  ", priority: 10 }] } });
  assert.equal((await checkMx(r, CTX)).verdict, "unknown");
});

// ───────────────────────── factory: createDnsAuthChecker ─────────────────────────

test("createDnsAuthChecker: expone los 4 ids DNS", () => {
  const checker = createDnsAuthChecker(mockResolver({}));
  assert.deepEqual([...checker.ids], ["SPF_PASS", "DKIM_ALIGN", "DMARC_PRESENT", "MX_VALID"]);
});

test("createDnsAuthChecker: run devuelve un CheckResult por check, todo pass en happy path", async () => {
  const r = mockResolver({
    txt: {
      "delivrix.io": txt("v=spf1 ip4:203.0.113.0/24 -all"),
      [dkimName]: txt("v=DKIM1; k=rsa; p=MIGfMA0..."),
      [dmarcName]: txt("v=DMARC1; p=reject")
    },
    mx: { "delivrix.io": [{ exchange: "smtp.delivrix.io", priority: 10 }] }
  });
  const results = await createDnsAuthChecker(r).run(CTX);
  assert.equal(results.length, 4);
  assert.deepEqual(
    results.map((res) => [res.id, res.verdict]),
    [
      ["SPF_PASS", "pass"],
      ["DKIM_ALIGN", "pass"],
      ["DMARC_PRESENT", "pass"],
      ["MX_VALID", "pass"]
    ]
  );
});

test("createDnsAuthChecker: run nunca lanza; DNS caído ⇒ todo unknown (fail-closed)", async () => {
  const r = mockResolver({}); // todo lookup lanza ENODATA
  const results = await createDnsAuthChecker(r).run(CTX);
  assert.equal(results.length, 4);
  for (const res of results) {
    assert.equal(res.verdict, "unknown");
    assert.notEqual(res.verdict, "pass");
  }
});

test("createDnsAuthChecker: detail nunca expone secretos (sin p= completo)", async () => {
  const r = mockResolver({
    txt: { [dkimName]: txt("v=DKIM1; k=rsa; p=MIGfMA0SUPERSECRETKEYMATERIAL...") }
  });
  const res = await checkDkim(r, CTX);
  assert.equal(res.verdict, "pass");
  assert.ok(!res.detail?.includes("SUPERSECRET"));
});

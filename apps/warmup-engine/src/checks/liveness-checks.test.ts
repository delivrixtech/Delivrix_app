import assert from "node:assert/strict";
import test from "node:test";
import {
  createSmtpAuthChecker,
  createImapAuthChecker,
  createTrackingDomainChecker,
  createOneClickUnsubChecker,
  createLivenessCheckers,
  validateOneClickEndpoint,
  isIpLiteral,
  isValidFqdn,
  normalizeHost,
  DEFAULT_DOMAIN_BLOCKLIST_ZONES,
  type SmtpAuthProbe,
  type ImapAuthProbe,
  type AuthProbeOptions,
  type AuthProbeResult,
  type DomainBlocklistResolver,
  type DomainBlocklistLookup,
  type UnsubCapabilityProvider
} from "./liveness-checks.ts";
import type { AuthCheckContext } from "../domain/auth-checks.ts";

// ── Contexto base y mocks inyectables (sin red) ──────────────────────────────
function ctx(over: Partial<AuthCheckContext> = {}): AuthCheckContext {
  return {
    domain: "acme.com",
    smtpHost: "smtp.acme.com",
    sendingIp: "203.0.113.10",
    heloFqdn: "smtp.acme.com",
    dkimSelector: "d1",
    trackingDomain: "track.acme.com",
    ...over
  };
}

const THROW = Symbol("throw");

/**
 * Probe de auth mock: captura las opts recibidas (para aserciones sobre secretRef) y devuelve un
 * resultado fijo o lanza (`THROW`). `detailFrom` permite fabricar un detail que INTENTA filtrar el
 * secretRef, para verificar el scrubbing.
 */
function fakeAuthProbe(cfg: {
  result: AuthProbeResult | typeof THROW;
  detailFrom?: (opts: AuthProbeOptions) => string;
}): SmtpAuthProbe & ImapAuthProbe & { seen: AuthProbeOptions[] } {
  const seen: AuthProbeOptions[] = [];
  return {
    seen,
    async probe(opts: AuthProbeOptions): Promise<AuthProbeResult> {
      seen.push(opts);
      if (cfg.result === THROW) throw new Error("ECONNREFUSED smtp");
      if (cfg.detailFrom) return { ...cfg.result, detail: cfg.detailFrom(opts) };
      return cfg.result;
    }
  };
}

/** Resolver DNSBL de dominio mock: por zona devuelve un lookup o lanza (`THROW`). */
function fakeDomainBlocklist(
  byZone: Record<string, DomainBlocklistLookup | typeof THROW>
): DomainBlocklistResolver {
  return {
    async isListed(_domain, zone) {
      const v = byZone[zone];
      if (v === undefined || v === THROW) throw new Error(`timeout ${zone}`);
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

test("isIpLiteral / isValidFqdn distinguen IP literal de FQDN", () => {
  assert.equal(isIpLiteral("203.0.113.10"), true);
  assert.equal(isIpLiteral("smtp.acme.com"), false);
  assert.equal(isValidFqdn("track.acme.com"), true);
  assert.equal(isValidFqdn("localhost"), false);
  assert.equal(normalizeHost("Track.Acme.Com."), "track.acme.com");
});

test("validateOneClickEndpoint: https + FQDN ⇒ válido (null)", () => {
  assert.equal(validateOneClickEndpoint("https://unsub.acme.com/one-click"), null);
  assert.equal(validateOneClickEndpoint("https://unsub.acme.com:8443/u?t=abc"), null);
});

test("validateOneClickEndpoint rechaza no-https, IP literal, host inválido y ausente", () => {
  assert.match(validateOneClickEndpoint("http://unsub.acme.com/x")!, /https/);
  assert.match(validateOneClickEndpoint("https://203.0.113.10/x")!, /IP literal/);
  assert.match(validateOneClickEndpoint("https://localhost/x")!, /FQDN/);
  assert.match(validateOneClickEndpoint("not a url")!, /URL/);
  assert.match(validateOneClickEndpoint(undefined)!, /ausente/);
  assert.match(validateOneClickEndpoint("")!, /ausente/);
});

// ═════════════════════════════════════════════════════════════════════════════
// SMTP_AUTH
// ═════════════════════════════════════════════════════════════════════════════

test("SMTP_AUTH pass: probe acepta la auth", async () => {
  const probe = fakeAuthProbe({ result: { ok: true, detail: "AUTH LOGIN aceptado" } });
  const r = await only(createSmtpAuthChecker(probe), ctx());
  assert.equal(r.verdict, "pass");
  assert.equal(r.id, "SMTP_AUTH");
});

test("SMTP_AUTH fail: probe rechaza la auth (ok:false)", async () => {
  const probe = fakeAuthProbe({ result: { ok: false, detail: "535 auth rechazada" } });
  const r = await only(createSmtpAuthChecker(probe), ctx());
  assert.equal(r.verdict, "fail");
});

test("SMTP_AUTH unknown: error de conexión (throw) ⇒ fail-closed, nunca pass", async () => {
  const probe = fakeAuthProbe({ result: THROW });
  const r = await only(createSmtpAuthChecker(probe), ctx());
  assert.equal(r.verdict, "unknown");
});

test("SMTP_AUTH: la credencial va por REFERENCIA (secretRef vault://), no valor crudo", async () => {
  const probe = fakeAuthProbe({ result: { ok: true } });
  await only(createSmtpAuthChecker(probe), ctx());
  assert.equal(probe.seen.length, 1);
  const opts = probe.seen[0];
  assert.match(opts.secretRef, /^vault:\/\//, "secretRef es una referencia opaca");
  assert.equal(opts.port, 587, "submission");
  assert.match(opts.host, /smtp\.acme\.com/);
});

test("SMTP_AUTH: el secretRef NUNCA aparece en detail (aunque el probe intente filtrarlo)", async () => {
  // Probe malicioso: mete el secretRef crudo en su detail. El checker debe scrubearlo.
  const probe = fakeAuthProbe({
    result: { ok: false },
    detailFrom: (o) => `login falló con credencial ${o.secretRef}`
  });
  const r = await only(createSmtpAuthChecker(probe), ctx());
  const secretRef = probe.seen[0].secretRef;
  assert.ok(secretRef.length > 0);
  assert.equal(
    r.detail!.includes(secretRef),
    false,
    "el secretRef jamás debe filtrarse al detail/log"
  );
  assert.match(r.detail!, /\[secretRef\]/);
});

test("SMTP_AUTH unknown: sin smtpHost en el contexto (fail-closed)", async () => {
  const probe = fakeAuthProbe({ result: { ok: true } });
  const r = await only(createSmtpAuthChecker(probe), ctx({ smtpHost: "" }));
  assert.equal(r.verdict, "unknown");
  assert.equal(probe.seen.length, 0, "no se llama al probe sin host");
});

// ═════════════════════════════════════════════════════════════════════════════
// IMAP_AUTH
// ═════════════════════════════════════════════════════════════════════════════

test("IMAP_AUTH pass/fail/unknown y secretRef por referencia (puerto 993)", async () => {
  const okProbe = fakeAuthProbe({ result: { ok: true } });
  const passR = await only(createImapAuthChecker(okProbe), ctx());
  assert.equal(passR.verdict, "pass");
  assert.equal(passR.id, "IMAP_AUTH");
  assert.equal(okProbe.seen[0].port, 993, "IMAPS");
  assert.match(okProbe.seen[0].secretRef, /\/imap$/);

  const failR = await only(createImapAuthChecker(fakeAuthProbe({ result: { ok: false } })), ctx());
  assert.equal(failR.verdict, "fail");

  const unkR = await only(createImapAuthChecker(fakeAuthProbe({ result: THROW })), ctx());
  assert.equal(unkR.verdict, "unknown");
});

test("IMAP_AUTH: secretRef nunca en detail", async () => {
  const probe: ImapAuthProbe & { ref?: string } = {
    async probe(o) {
      (probe as { ref?: string }).ref = o.secretRef;
      return { ok: true, detail: `sesión ok con ${o.secretRef}` };
    }
  };
  const r = await only(createImapAuthChecker(probe), ctx());
  assert.equal(r.detail!.includes(probe.ref!), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// TRACKING_DOMAIN_CLEAN
// ═════════════════════════════════════════════════════════════════════════════

test("TRACKING_DOMAIN_CLEAN pass: sin trackingDomain ⇒ no aplica", async () => {
  const resolver = fakeDomainBlocklist({});
  const r = await only(createTrackingDomainChecker(resolver), ctx({ trackingDomain: undefined }));
  assert.equal(r.verdict, "pass");
  assert.match(r.detail!, /no aplica/);
});

test("TRACKING_DOMAIN_CLEAN pass: limpio en las 3 zonas", async () => {
  const resolver = fakeDomainBlocklist({
    "dbl.spamhaus.org": { listed: false },
    "multi.surbl.org": { listed: false },
    "multi.uribl.com": { listed: false }
  });
  const r = await only(createTrackingDomainChecker(resolver), ctx());
  assert.equal(r.verdict, "pass");
});

test("TRACKING_DOMAIN_CLEAN fail: listado en DBL (zona en detail)", async () => {
  const resolver = fakeDomainBlocklist({
    "dbl.spamhaus.org": { listed: true, txt: "https://check.spamhaus.org" },
    "multi.surbl.org": { listed: false },
    "multi.uribl.com": { listed: false }
  });
  const r = await only(createTrackingDomainChecker(resolver), ctx());
  assert.equal(r.verdict, "fail");
  assert.match(r.detail!, /dbl\.spamhaus\.org/);
});

test("TRACKING_DOMAIN_CLEAN pass parcial: 1 zona limpia, resto error, ninguna lista", async () => {
  const resolver = fakeDomainBlocklist({
    "dbl.spamhaus.org": { listed: false },
    "multi.surbl.org": THROW,
    "multi.uribl.com": THROW
  });
  const r = await only(createTrackingDomainChecker(resolver), ctx());
  assert.equal(r.verdict, "pass", "≥1 lookup exitoso y ninguna lista ⇒ pass");
});

test("TRACKING_DOMAIN_CLEAN unknown: error en TODAS las zonas (fail-closed)", async () => {
  const resolver = fakeDomainBlocklist({
    "dbl.spamhaus.org": THROW,
    "multi.surbl.org": THROW,
    "multi.uribl.com": THROW
  });
  const r = await only(createTrackingDomainChecker(resolver), ctx());
  assert.equal(r.verdict, "unknown", "sin ninguna respuesta ⇒ unknown, jamás pass");
});

test("TRACKING_DOMAIN_CLEAN usa las 3 zonas de dominio por defecto (§8)", () => {
  assert.deepEqual(DEFAULT_DOMAIN_BLOCKLIST_ZONES, [
    "dbl.spamhaus.org",
    "multi.surbl.org",
    "multi.uribl.com"
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// ONECLICK_UNSUB_CAP
// ═════════════════════════════════════════════════════════════════════════════

test("ONECLICK_UNSUB_CAP pass: enabled + endpoint https/FQDN", async () => {
  const provider: UnsubCapabilityProvider = () => ({
    enabled: true,
    endpoint: "https://unsub.acme.com/one-click"
  });
  const r = await only(createOneClickUnsubChecker(provider), ctx());
  assert.equal(r.verdict, "pass");
  assert.equal(r.id, "ONECLICK_UNSUB_CAP");
});

test("ONECLICK_UNSUB_CAP fail: sin capacidad (enabled:false)", async () => {
  const r = await only(createOneClickUnsubChecker(() => ({ enabled: false })), ctx());
  assert.equal(r.verdict, "fail");
  assert.match(r.detail!, /sin capacidad/);
});

test("ONECLICK_UNSUB_CAP fail: endpoint no-https ⇒ fail", async () => {
  const provider: UnsubCapabilityProvider = () => ({
    enabled: true,
    endpoint: "http://unsub.acme.com/one-click"
  });
  const r = await only(createOneClickUnsubChecker(provider), ctx());
  assert.equal(r.verdict, "fail");
  assert.match(r.detail!, /https/);
});

test("ONECLICK_UNSUB_CAP fail: endpoint ausente aunque enabled", async () => {
  const r = await only(createOneClickUnsubChecker(() => ({ enabled: true })), ctx());
  assert.equal(r.verdict, "fail");
});

test("ONECLICK_UNSUB_CAP unknown: el provider lanza (fail-closed)", async () => {
  const provider: UnsubCapabilityProvider = () => {
    throw new Error("config store down");
  };
  const r = await only(createOneClickUnsubChecker(provider), ctx());
  assert.equal(r.verdict, "unknown");
});

// ═════════════════════════════════════════════════════════════════════════════
// Factory de ensamblaje
// ═════════════════════════════════════════════════════════════════════════════

test("createLivenessCheckers devuelve los 4 checks comunes (§8)", async () => {
  const checkers = createLivenessCheckers({
    smtpProbe: fakeAuthProbe({ result: { ok: true } }),
    imapProbe: fakeAuthProbe({ result: { ok: true } }),
    domainBlocklist: fakeDomainBlocklist({
      "dbl.spamhaus.org": { listed: false },
      "multi.surbl.org": { listed: false },
      "multi.uribl.com": { listed: false }
    }),
    unsubProvider: () => ({ enabled: true, endpoint: "https://unsub.acme.com/one-click" })
  });

  const ids = checkers.flatMap((c) => [...c.ids]);
  assert.deepEqual(ids.sort(), [
    "IMAP_AUTH",
    "ONECLICK_UNSUB_CAP",
    "SMTP_AUTH",
    "TRACKING_DOMAIN_CLEAN"
  ]);

  const results = (await Promise.all(checkers.map((c) => c.run(ctx())))).flat();
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.verdict === "pass"), "todos pass con el happy-path");
});

test("createLivenessCheckers: fail-closed extremo — todo error ⇒ ningún pass", async () => {
  const checkers = createLivenessCheckers({
    smtpProbe: fakeAuthProbe({ result: THROW }),
    imapProbe: fakeAuthProbe({ result: THROW }),
    domainBlocklist: fakeDomainBlocklist({
      "dbl.spamhaus.org": THROW,
      "multi.surbl.org": THROW,
      "multi.uribl.com": THROW
    }),
    unsubProvider: () => {
      throw new Error("config store down");
    }
  });
  const results = (await Promise.all(checkers.map((c) => c.run(ctx())))).flat();
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.verdict === "unknown"), "todo error ⇒ todo unknown, jamás pass");
});

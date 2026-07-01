import assert from "node:assert/strict";
import test from "node:test";
import { verifySmokeAuthGate, type SmokeAuthDnsResolver } from "./smoke-auth-gate.ts";

test("verifySmokeAuthGate accepts a fully aligned SMTP auth surface", async () => {
  const resolver = resolverFromRecords({
    smtpA: ["203.0.113.10"],
    spf: "v=spf1 ip4:203.0.113.10 -all",
    dkim: "v=DKIM1; k=rsa; p=abc",
    dmarc: "v=DMARC1; p=quarantine",
    ptr: ["smtp.delivrixops.com."]
  });

  const result = await verifySmokeAuthGate({
    domain: "delivrixops.com",
    smtpHost: "smtp.delivrixops.com",
    serverIpv4: "203.0.113.10",
    selector: "s2026a",
    resolver
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("verifySmokeAuthGate fails closed on stale A/SPF and missing FCrDNS", async () => {
  const resolver = resolverFromRecords({
    smtpA: ["198.51.100.65"],
    spf: "v=spf1 ip4:198.51.100.65 -all",
    dkim: "v=DKIM1; k=rsa; p=abc",
    dmarc: "v=DMARC1; p=quarantine",
    ptr: ["smtp.delivrixops.com."]
  });

  const result = await verifySmokeAuthGate({
    domain: "delivrixops.com",
    smtpHost: "smtp.delivrixops.com",
    serverIpv4: "203.0.113.10",
    selector: "s2026a",
    resolver
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.sort(), ["fcrdns", "smtp_a", "spf"]);
  assert.deepEqual(result.checks.smtp_a.observed, ["198.51.100.65"]);
  assert.deepEqual(result.checks.spf.observed, ["v=spf1 ip4:198.51.100.65 -all"]);
});

test("verifySmokeAuthGate requires smtp A to be exactly the provisioned IP", async () => {
  const resolver = resolverFromRecords({
    smtpA: ["203.0.113.10", "198.51.100.65"],
    spf: "v=spf1 ip4:203.0.113.10 -all",
    dkim: "v=DKIM1; k=rsa; p=abc",
    dmarc: "v=DMARC1; p=quarantine",
    ptr: ["smtp.delivrixops.com."]
  });

  const result = await verifySmokeAuthGate({
    domain: "delivrixops.com",
    smtpHost: "smtp.delivrixops.com",
    serverIpv4: "203.0.113.10",
    selector: "s2026a",
    resolver
  });

  assert.equal(result.ok, false);
  assert.ok(result.missing.includes("smtp_a"));
  assert.deepEqual(result.checks.smtp_a.observed, ["203.0.113.10", "198.51.100.65"]);
});

test("verifySmokeAuthGate fails fast on invalid state preconditions", async () => {
  const resolver = resolverFromRecords({
    smtpA: ["203.0.113.10"],
    spf: "v=spf1 ip4:203.0.113.10 -all",
    dkim: "v=DKIM1; k=rsa; p=abc",
    dmarc: "v=DMARC1; p=quarantine",
    ptr: ["smtp.delivrixops.com."]
  });

  const invalidIp = await verifySmokeAuthGate({
    domain: "delivrixops.com",
    smtpHost: "smtp.delivrixops.com",
    serverIpv4: "203.0.113.999",
    selector: "s2026a",
    resolver
  });

  assert.equal(invalidIp.ok, false);
  assert.equal(invalidIp.error, "invalid_server_ipv4");
  assert.deepEqual(invalidIp.missing, ["invalid_precondition"]);
  assert.equal(invalidIp.checks.smtp_a.error, "invalid_server_ipv4");

  const mismatchedHost = await verifySmokeAuthGate({
    domain: "delivrixops.com",
    smtpHost: "smtp.otherdomain.com",
    serverIpv4: "203.0.113.10",
    selector: "s2026a",
    resolver
  });

  assert.equal(mismatchedHost.ok, false);
  assert.equal(mismatchedHost.error, "smtp_host_domain_mismatch");
  assert.deepEqual(mismatchedHost.missing, ["invalid_precondition"]);
});

test("verifySmokeAuthGate rejects revoked DKIM p= records", async () => {
  const resolver = resolverFromRecords({
    smtpA: ["203.0.113.10"],
    spf: "v=spf1 ip4:203.0.113.10 -all",
    dkim: "v=DKIM1; k=rsa; p=",
    dmarc: "v=DMARC1; p=quarantine",
    ptr: ["smtp.delivrixops.com."]
  });

  const result = await verifySmokeAuthGate({
    domain: "delivrixops.com",
    smtpHost: "smtp.delivrixops.com",
    serverIpv4: "203.0.113.10",
    selector: "s2026a",
    resolver
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["dkim"]);
});

function resolverFromRecords(input: {
  smtpA: string[];
  spf: string;
  dkim: string;
  dmarc: string;
  ptr: string[];
}): SmokeAuthDnsResolver {
  return {
    async resolve4(hostname: string) {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      if (normalized === "smtp.delivrixops.com") return input.smtpA;
      return [];
    },
    async resolveTxt(hostname: string) {
      const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
      if (normalized.startsWith("s2026a._domainkey.")) return [[input.dkim]];
      if (normalized.startsWith("_dmarc.")) return [[input.dmarc]];
      return [[input.spf]];
    },
    async reverse() {
      return input.ptr;
    }
  };
}

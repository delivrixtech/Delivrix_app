import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnoseDkim,
  parseDkimRecord,
  parseDkimTags
} from "./openclaw-dkim-diagnostic.ts";

const VALID = "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDexamplekey";
const REVOKED = "v=DKIM1; k=rsa; p=";

function resolver(map: Record<string, string>): (fqdn: string) => Promise<string[][]> {
  return async (fqdn: string) => {
    if (fqdn in map) return [[map[fqdn]]];
    throw new Error(`ENOTFOUND ${fqdn}`);
  };
}

test("parseDkimRecord: a real key is valid", () => {
  const p = parseDkimRecord([VALID]);
  assert.equal(p.present, true);
  assert.equal(p.valid, true);
  assert.equal(p.revoked, false);
  assert.equal(p.keyType, "rsa");
});

test("parseDkimRecord: an empty p= is REVOKED, not valid", () => {
  const p = parseDkimRecord([REVOKED]);
  assert.equal(p.present, true);
  assert.equal(p.valid, false);
  assert.equal(p.revoked, true);
});

test("parseDkimRecord: no v=DKIM1 means absent", () => {
  const p = parseDkimRecord(["v=spf1 -all"]);
  assert.equal(p.present, false);
  assert.equal(p.valid, false);
});

test("parseDkimTags splits tags", () => {
  const t = parseDkimTags(VALID);
  assert.equal(t.v, "DKIM1");
  assert.equal(t.k, "rsa");
  assert.ok(t.p.length > 0);
});

test("diagnoseDkim finds DKIM under s2026a even when 'default' is empty (the audited mismatch)", async () => {
  const r = resolver({ "s2026a._domainkey.bizreport.com": VALID });
  const d = await diagnoseDkim({
    resolveTxt: r,
    domain: "bizreport.com",
    now: () => new Date("2026-06-28T00:00:00Z")
  });
  assert.equal(d.status, "valid");
  assert.deepEqual(d.validSelectors, ["s2026a"]);
});

test("diagnoseDkim distinguishes revoked from absent", async () => {
  const r = resolver({ "s2026a._domainkey.x.com": REVOKED });
  const d = await diagnoseDkim({ resolveTxt: r, domain: "x.com", now: () => new Date("2026-06-28T00:00:00Z") });
  assert.equal(d.status, "revoked");
  assert.match(d.summary, /REVOCADO/);
});

test("diagnoseDkim returns unknown (never false-absent) when DNS resolves nothing", async () => {
  const r: (f: string) => Promise<string[][]> = async () => {
    throw new Error("ESERVFAIL");
  };
  const d = await diagnoseDkim({ resolveTxt: r, domain: "x.com" });
  assert.equal(d.status, "unknown");
  assert.match(d.summary, /NO asumir/);
});

test("diagnoseDkim returns absent when a selector resolves but has no DKIM", async () => {
  const r: (f: string) => Promise<string[][]> = async (fqdn) => {
    if (fqdn === "default._domainkey.x.com") return [["v=spf1 -all"]];
    throw new Error("ENOTFOUND");
  };
  const d = await diagnoseDkim({ resolveTxt: r, domain: "x.com", now: () => new Date("2026-06-28T00:00:00Z") });
  assert.equal(d.status, "absent");
});

test("diagnoseDkim prioritizes an explicit expectedSelector", async () => {
  const r = resolver({ "custom1._domainkey.x.com": VALID });
  const d = await diagnoseDkim({ resolveTxt: r, domain: "x.com", expectedSelector: "custom1" });
  assert.equal(d.status, "valid");
  assert.deepEqual(d.validSelectors, ["custom1"]);
});

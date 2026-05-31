import assert from "node:assert/strict";
import test from "node:test";
import {
  generateCandidates,
  validateDomainNaming,
  validateHostnameNaming
} from "./naming-validator.ts";

test("rejects delivrix-notify.com with contains_notify", () => {
  const result = validateDomainNaming("delivrix-notify.com");
  assert.equal(result.passes, false);
  assert.ok(result.blockedReasons.includes("contains_notify"));
  assert.ok(result.score < 50);
});

test("rejects delivrix-mail.click with prohibited word and problematic TLD", () => {
  const result = validateDomainNaming("delivrix-mail.click");
  assert.equal(result.passes, false);
  assert.ok(result.blockedReasons.includes("contains_mail"));
  assert.ok(result.blockedReasons.includes("tld_problematic"));
  assert.ok(result.score < 30);
});

test("allows delivrixops.com with strong score", () => {
  const result = validateDomainNaming("delivrixops.com");
  assert.equal(result.passes, true);
  assert.ok(result.score > 80);
});

test("allows nfcorpreport.com with strong score", () => {
  const result = validateDomainNaming("nfcorpreport.com");
  assert.equal(result.passes, true);
  assert.ok(result.score > 85);
});

test("rejects risky hostname prefix", () => {
  const result = validateHostnameNaming("mail.fileyourcorp.app");
  assert.equal(result.passes, false);
  assert.ok(result.blockedReasons.includes("hostname_prefix_mail"));
  assert.ok(result.score < 50);
});

test("penalizes long random number patterns", () => {
  const result = validateDomainNaming("corp4928.com");
  assert.equal(result.passes, false);
  assert.ok(result.blockedReasons.includes("contains_long_number"));
  assert.ok(result.score < 70);
});

test("combines multiple penalties into hard rejection", () => {
  const result = validateDomainNaming("app-h8x3-mail-2026.work");
  assert.equal(result.passes, false);
  assert.ok(result.blockedReasons.includes("contains_mail"));
  assert.ok(result.blockedReasons.includes("tld_problematic"));
  assert.ok(result.blockedReasons.includes("contains_year"));
  assert.ok(result.score <= 10);
});

test("does not flag normal brand length as too short", () => {
  const result = validateDomainNaming("delivrix.com");
  assert.equal(result.passes, true);
  assert.equal(result.blockedReasons.includes("sld_too_short"), false);
});

test("penalizes one-letter SLD", () => {
  const result = validateDomainNaming("a.com");
  assert.equal(result.passes, false);
  assert.ok(result.blockedReasons.includes("sld_too_short"));
  assert.ok(result.score < 100);
});

test("applies unknown TLD penalty without inventing a blocker", () => {
  const result = validateDomainNaming("delivrixops.foo");
  assert.equal(result.passes, true);
  assert.equal(result.blockedReasons.length, 0);
  assert.equal(result.score, 80);
});

test("candidate generator is deterministic and avoids prohibited smtp prefixes", () => {
  const first = generateCandidates({
    brand: "delivrix",
    intent: "smtp",
    tlds: ["com"],
    count: 5
  });
  const second = generateCandidates({
    brand: "delivrix",
    intent: "smtp",
    tlds: ["com"],
    count: 5
  });
  assert.deepEqual(first, second);
  assert.equal(first.some((domain) => /mail|notify|email/.test(domain)), false);
});

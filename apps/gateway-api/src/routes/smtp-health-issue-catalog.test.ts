import test from "node:test";
import assert from "node:assert/strict";
import {
  SMTP_HEALTH_ISSUE_CATALOG,
  buildSmtpHealthIssue,
  isKnownSmtpHealthIssueCode
} from "./smtp-health-issue-catalog.ts";

test("catalog covers the 5 real errors of 2026-07-13 plus hardening codes", () => {
  for (const code of [
    "stale_run_lock",
    "unknown_vps_provider",
    "plan_scope_mismatch_require_existing_domain",
    "domain_purchased_without_smtp",
    "domain_registration_pending"
  ] as const) {
    assert.ok(isKnownSmtpHealthIssueCode(code), `${code} should be catalogued`);
  }
});

test("buildSmtpHealthIssue fills placeholders and keeps severity + docRef", () => {
  const issue = buildSmtpHealthIssue("domain_purchased_without_smtp", {
    domain: "annualfilinginfra.com",
    runId: "smtp-annualfilinginfra-contabo2-20260713-v1",
    lastCompletedStep: 8,
    costUsd: 16
  });
  assert.equal(issue.code, "domain_purchased_without_smtp");
  assert.equal(issue.severity, "error");
  assert.match(issue.message, /annualfilinginfra\.com/);
  assert.match(issue.suggestedFix.text, /smtp-annualfilinginfra-contabo2-20260713-v1/);
  assert.match(issue.suggestedFix.text, /último paso completado: 8/);
  assert.equal(issue.suggestedFix.docRef, "I2");
});

test("unknown_vps_provider names the provider in the suggested fix", () => {
  const issue = buildSmtpHealthIssue("unknown_vps_provider", { provider: "contabo-2" });
  assert.match(issue.suggestedFix.text, /contabo-2/);
  assert.equal(issue.suggestedFix.kind, "complete_provider_credentials");
});

test("missing placeholder params leave a readable literal token, never 'undefined'", () => {
  const issue = buildSmtpHealthIssue("stale_run_lock", {});
  assert.match(issue.message, /\{runId\}/);
  assert.doesNotMatch(issue.suggestedFix.text, /undefined/);
});

test("every catalog entry has a suggestedFix with kind and text", () => {
  for (const [code, entry] of Object.entries(SMTP_HEALTH_ISSUE_CATALOG)) {
    assert.ok(entry.suggestedFix.kind.length > 0, `${code} needs a fix kind`);
    assert.ok(entry.suggestedFix.text.length > 0, `${code} needs a fix text`);
  }
});

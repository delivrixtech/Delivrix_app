import assert from "node:assert/strict";
import test from "node:test";
import { checkRunStateIntegrity } from "./run-state-integrity.ts";

test("flags a domain that sent without any run (the annualcorpfilings case)", () => {
  const report = checkRunStateIntegrity({
    runs: [{ runId: "r1", status: "completed", chosenDomain: "bizreport.com" }],
    sends: [
      { domain: "bizreport.com" },
      { domain: "annualcorpfilings.com" }, // sent, no run
      { domain: "annualcorpfilings.com" }
    ]
  });
  assert.deepEqual(report.domainsWithoutRun, ["annualcorpfilings.com"]);
  assert.equal(report.ok, false);
  assert.match(report.summary, /ENVÍAN SIN RUN/);
  assert.match(report.summary, /annualcorpfilings\.com/);
});

test("is ok when every sending domain has a run and none failed", () => {
  const report = checkRunStateIntegrity({
    runs: [
      { runId: "r1", status: "completed", chosenDomain: "a.com" },
      { runId: "r2", status: "running", chosenDomain: "b.com" }
    ],
    sends: [{ domain: "a.com" }, { domain: "B.COM" }] // case-insensitive
  });
  assert.deepEqual(report.domainsWithoutRun, []);
  assert.equal(report.ok, true);
});

test("a run of any status (even failed) still covers the domain for orphan purposes", () => {
  const report = checkRunStateIntegrity({
    runs: [{ runId: "r1", status: "failed", chosenDomain: "a.com" }],
    sends: [{ domain: "a.com" }]
  });
  assert.deepEqual(report.domainsWithoutRun, []); // has a run, not an orphan
  assert.equal(report.failedRuns.length, 1);
  assert.equal(report.ok, false); // but the failed run keeps it not-ok
});

test("collects failed and cancelled runs separately", () => {
  const report = checkRunStateIntegrity({
    runs: [
      { runId: "r1", status: "failed", chosenDomain: "a.com" },
      { runId: "r2", status: "cancelled_by_operator", chosenDomain: "b.com" },
      { runId: "r3", status: "completed", chosenDomain: "c.com" }
    ],
    sends: [{ domain: "a.com" }, { domain: "b.com" }, { domain: "c.com" }]
  });
  assert.equal(report.failedRuns.length, 1);
  assert.equal(report.failedRuns[0].runId, "r1");
  assert.equal(report.cancelledRuns.length, 1);
  assert.equal(report.ok, false);
});

test("cancelled-only is reported but does not by itself break integrity", () => {
  const report = checkRunStateIntegrity({
    runs: [{ runId: "r1", status: "cancelled_by_operator", chosenDomain: "a.com" }],
    sends: [{ domain: "a.com" }]
  });
  assert.equal(report.ok, true); // no orphan, no failed
  assert.match(report.summary, /cancelado/);
});

test("empty inputs are ok", () => {
  const report = checkRunStateIntegrity({ runs: [], sends: [] });
  assert.equal(report.ok, true);
  assert.equal(report.totals.runs, 0);
});

test("normalizes domains (trailing dot, case, spaces)", () => {
  const report = checkRunStateIntegrity({
    runs: [{ runId: "r1", status: "completed", chosenDomain: " A.com. " }],
    sends: [{ domain: "a.COM" }]
  });
  assert.deepEqual(report.domainsWithoutRun, []);
});

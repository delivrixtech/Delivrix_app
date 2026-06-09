import test from "node:test";
import assert from "node:assert/strict";
import {
  CreationAccountSelectionError,
  CreationRateGovernorError,
  countCreatedInWindow,
  countCreatedInRolling24h,
  ensureCreationBudget,
  ensureCreationBudgetReadError,
  evaluateAccountSelection,
  evaluateCreationBudget,
  evaluateCreationBudgetReadError,
  selectAccountForCreation,
  type CreationRateServer
} from "./creation-rate-governor.ts";

const now = new Date("2026-06-09T12:00:00.000Z");

test("countCreatedInRolling24h counts creationDate inside the rolling 24h window only", () => {
  const count = countCreatedInRolling24h([
    server("2026-06-09T11:59:59.000Z"),
    server("2026-06-08T12:00:00.000Z"),
    server("2026-06-08T11:59:59.999Z"),
    server("2026-06-09T12:00:00.001Z"),
    server(undefined),
    server("not-a-date")
  ], now);

  assert.equal(count, 2);
});

test("countCreatedInWindow can count by calendar day in America/Bogota", () => {
  const count = countCreatedInWindow([
    server("2026-06-09T05:30:00.000Z"),
    server("2026-06-09T04:59:59.999Z")
  ], new Date("2026-06-09T06:00:00.000Z"), "calendar_day_bogota");

  assert.equal(count, 1);
});

test("evaluateCreationBudget blocks when created_24h is greater than or equal to cap", () => {
  const decision = evaluateCreationBudget({
    servers: [
      server("2026-06-09T08:00:00.000Z"),
      server("2026-06-09T09:00:00.000Z"),
      server("2026-06-09T10:00:00.000Z"),
      server("2026-06-09T11:00:00.000Z")
    ],
    now,
    accountId: "ops",
    cap: 4
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "creation_rate_exceeded");
  assert.equal(decision.createdInWindow, 4);
  assert.equal(decision.remaining, 0);
  assert.equal(decision.failure?.code, "creation_rate_exceeded");
  assert.equal(decision.failure?.step, 4);
  assert.equal(decision.failure?.skill, "create_webdock_server");
  assert.equal(decision.failure?.message, "creation_rate_exceeded: created_24h=4 cap=4 account=ops");
  assert.equal(decision.audit?.eventName, "oc.orchestrator.creation_rate_exceeded");
  assert.equal(decision.audit?.severity, "error");
});

test("ensureCreationBudget throws a typed domain error when the cap is exhausted", () => {
  assert.throws(
    () => ensureCreationBudget({
      servers: [
        server("2026-06-09T08:00:00.000Z"),
        server("2026-06-09T09:00:00.000Z"),
        server("2026-06-09T10:00:00.000Z"),
        server("2026-06-09T11:00:00.000Z")
      ],
      now,
      cap: 4
    }),
    (error: unknown) => {
      assert.ok(error instanceof CreationRateGovernorError);
      assert.equal(error.code, "creation_rate_exceeded");
      assert.equal(error.step, 4);
      assert.equal(error.skill, "create_webdock_server");
      assert.equal(error.message, "creation_rate_exceeded: created_24h=4 cap=4 account=ops");
      return true;
    }
  );
});

test("evaluateCreationBudget allows when created_24h is below cap", () => {
  const decision = evaluateCreationBudget({
    servers: [
      server("2026-06-09T09:00:00.000Z"),
      server("2026-06-09T10:00:00.000Z"),
      server("2026-06-09T11:00:00.000Z")
    ],
    now,
    cap: 4
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "creation_rate_allowed");
  assert.equal(decision.createdInWindow, 3);
  assert.equal(decision.remaining, 1);
  assert.equal(decision.failure, undefined);
});

test("evaluateCreationBudget allows when the governor flag is off", () => {
  const decision = evaluateCreationBudget({
    servers: [
      server("2026-06-09T08:00:00.000Z"),
      server("2026-06-09T09:00:00.000Z"),
      server("2026-06-09T10:00:00.000Z"),
      server("2026-06-09T11:00:00.000Z")
    ],
    now,
    cap: 4,
    enabled: false
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "creation_rate_disabled");
  assert.equal(decision.createdInWindow, 4);
  assert.equal(decision.audit?.eventName, "oc.orchestrator.creation_rate_governor_disabled");
});

test("evaluateCreationBudgetReadError defaults to fail-open with a warning audit hint", () => {
  const decision = evaluateCreationBudgetReadError({
    now,
    accountId: "ops",
    error: new Error("webdock inventory timeout")
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "creation_rate_read_failed_fail_open");
  assert.equal(decision.readErrorMessage, "webdock inventory timeout");
  assert.equal(decision.audit?.eventName, "oc.orchestrator.creation_rate_read_failed");
  assert.equal(decision.audit?.severity, "warning");
});

test("evaluateCreationBudgetReadError can fail closed on inventory read errors", () => {
  const decision = evaluateCreationBudgetReadError({
    now,
    accountId: "ops",
    failMode: "fail_closed",
    error: "api unavailable"
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "creation_rate_read_failed_fail_closed");
  assert.equal(decision.failure?.code, "creation_rate_read_failed");
  assert.equal(decision.audit?.severity, "error");
});

test("ensureCreationBudgetReadError throws when read-error mode is fail-closed", () => {
  assert.throws(
    () => ensureCreationBudgetReadError({
      now,
      failMode: "fail_closed",
      error: "api unavailable"
    }),
    (error: unknown) => {
      assert.ok(error instanceof CreationRateGovernorError);
      assert.equal(error.code, "creation_rate_read_failed");
      assert.equal(error.step, 4);
      assert.equal(error.skill, "create_webdock_server");
      return true;
    }
  );
});

test("selectAccountForCreation returns the current ops account when it is the single eligible account", () => {
  const selected = selectAccountForCreation({
    accounts: [{ accountId: "ops", healthy: true }],
    governorState: [{ accountId: "ops", allowed: true, createdInWindow: 1, cap: 4 }]
  });

  assert.equal(selected, "ops");
});

test("selectAccountForCreation filters unhealthy or exhausted accounts and applies a stable tie-break", () => {
  const selected = selectAccountForCreation({
    accounts: [
      { accountId: "b-account", healthy: true },
      { accountId: "a-account", healthy: true },
      { accountId: "c-account", healthy: false },
      { accountId: "d-account", healthy: true }
    ],
    governorState: [
      { accountId: "b-account", allowed: true, createdInWindow: 2, cap: 4 },
      { accountId: "a-account", allowed: true, createdInWindow: 2, cap: 4 },
      { accountId: "c-account", allowed: true, createdInWindow: 0, cap: 4 },
      { accountId: "d-account", allowed: false, createdInWindow: 4, cap: 4 }
    ]
  });

  assert.equal(selected, "a-account");
});

test("evaluateAccountSelection reports all healthy accounts exhausted", () => {
  const decision = evaluateAccountSelection({
    accounts: [
      { accountId: "ops", healthy: true },
      { accountId: "secondary", healthy: true }
    ],
    governorState: [
      { accountId: "ops", allowed: false, createdInWindow: 4, cap: 4 },
      { accountId: "secondary", allowed: false, createdInWindow: 4, cap: 4 }
    ]
  });

  assert.equal(decision.selectedAccountId, null);
  assert.equal(decision.reason, "creation_rate_exceeded_all_accounts");
  assert.throws(
    () => selectAccountForCreation({
      accounts: [
        { accountId: "ops", healthy: true },
        { accountId: "secondary", healthy: true }
      ],
      governorState: [
        { accountId: "ops", allowed: false, createdInWindow: 4, cap: 4 },
        { accountId: "secondary", allowed: false, createdInWindow: 4, cap: 4 }
      ]
    }),
    CreationAccountSelectionError
  );
});

function server(creationDate: string | undefined): CreationRateServer {
  return { creationDate };
}

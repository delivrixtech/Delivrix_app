import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBusinessHoursQuorum,
  resolveGatewayNow
} from "./business-hours.ts";

test("business hours morning in Bogota requires one approval", () => {
  const quorum = resolveBusinessHoursQuorum(new Date("2026-05-20T15:00:00Z"), "incident-quarantine");

  assert.equal(quorum.requiredApprovals, 1);
  assert.equal(quorum.mode, "business_hours");
  assert.equal(quorum.operatorLocalHour, 10);
});

test("business hours afternoon in Bogota requires one approval", () => {
  const quorum = resolveBusinessHoursQuorum(new Date("2026-05-20T23:30:00Z"), "incident-quarantine");

  assert.equal(quorum.requiredApprovals, 1);
  assert.equal(quorum.mode, "business_hours");
  assert.equal(quorum.operatorLocalHour, 18);
});

test("off-hours night in Bogota requires two approvals", () => {
  const quorum = resolveBusinessHoursQuorum(new Date("2026-05-21T03:00:00Z"), "incident-quarantine");

  assert.equal(quorum.requiredApprovals, 2);
  assert.equal(quorum.mode, "off_hours");
  assert.equal(quorum.operatorLocalHour, 22);
});

test("off-hours dawn in Bogota requires two approvals", () => {
  const quorum = resolveBusinessHoursQuorum(new Date("2026-05-20T07:00:00Z"), "incident-quarantine");

  assert.equal(quorum.requiredApprovals, 2);
  assert.equal(quorum.mode, "off_hours");
  assert.equal(quorum.operatorLocalHour, 2);
});

test("business-hours quorum rejects other runbooks", () => {
  assert.throws(
    () => resolveBusinessHoursQuorum(new Date("2026-05-20T15:00:00Z"), "warming-step"),
    /incident-quarantine/
  );
});

test("DELIVRIX_NOW_OVERRIDE only applies in development", () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldOverride = process.env.DELIVRIX_NOW_OVERRIDE;

  process.env.NODE_ENV = "production";
  process.env.DELIVRIX_NOW_OVERRIDE = "2026-05-20T15:00:00Z";
  assert.equal(resolveGatewayNow(new Date("2026-05-20T00:00:00Z")).toISOString(), "2026-05-20T00:00:00.000Z");

  process.env.NODE_ENV = "development";
  assert.equal(resolveGatewayNow(new Date("2026-05-20T00:00:00Z")).toISOString(), "2026-05-20T15:00:00.000Z");

  if (oldNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = oldNodeEnv;
  }

  if (oldOverride === undefined) {
    delete process.env.DELIVRIX_NOW_OVERRIDE;
  } else {
    process.env.DELIVRIX_NOW_OVERRIDE = oldOverride;
  }
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  accountLifecycleKey,
  infrastructureAccountLifecycleIds,
  LocalFileInfrastructureAccountLifecycleStore
} from "./local-file-infrastructure-account-lifecycle-store.ts";

test("Infrastructure account lifecycle store canonicalizes Webdock cuenta madre roles", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-account-life-");
  t.after(cleanup);
  const store = new LocalFileInfrastructureAccountLifecycleStore(filePath);

  const transition = await store.observe({
    providerId: "webdock",
    accountId: "primary",
    accountLabel: "Webdock Primary",
    responseOk: true,
    healthStatus: "healthy",
    fetchedAt: "2026-06-24T10:00:00.000Z",
    observedAt: "2026-06-24T10:00:01.000Z",
    itemCount: 3,
    aliases: ["primary", "ops", "account", "default"]
  });

  assert.equal(accountLifecycleKey("webdock", "account"), "webdock:ops");
  assert.equal(transition.account.accountKey, "webdock:ops");
  assert.equal(transition.account.accountId, "ops");
  assert.equal(transition.account.lastKnownItemCount, 3);
  assert.equal(transition.action, "none");
});

test("Infrastructure account lifecycle store tracks failure and recovery without losing last count", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-account-life-");
  t.after(cleanup);
  const store = new LocalFileInfrastructureAccountLifecycleStore(filePath);

  await store.observe({
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    responseOk: true,
    healthStatus: "healthy",
    fetchedAt: "2026-06-24T10:00:00.000Z",
    observedAt: "2026-06-24T10:00:01.000Z",
    itemCount: 2
  });
  const failed = await store.observe({
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    responseOk: false,
    healthStatus: "unauthorized",
    fetchedAt: "2026-06-24T10:05:00.000Z",
    observedAt: "2026-06-24T10:05:01.000Z",
    itemCount: 0,
    httpStatus: 401,
    errorCode: "webdock_auth_401",
    errorReason: "Webdock API returned 401 Unauthorized"
  });
  const recovered = await store.observe({
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    responseOk: true,
    healthStatus: "healthy",
    fetchedAt: "2026-06-24T10:10:00.000Z",
    observedAt: "2026-06-24T10:10:01.000Z",
    itemCount: 1
  });

  assert.equal(failed.action, "unhealthy");
  assert.equal(failed.account.consecutiveFailures, 1);
  assert.equal(failed.account.lastKnownItemCount, 2);
  assert.equal(recovered.action, "recovered");
  assert.equal(recovered.account.consecutiveFailures, 0);
  assert.equal(recovered.account.lastKnownItemCount, 1);
});

test("Infrastructure account lifecycle store preserves first unhealthy timestamp across a failure streak", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-account-life-");
  t.after(cleanup);
  const store = new LocalFileInfrastructureAccountLifecycleStore(filePath);

  const failedOnce = await store.observe({
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    responseOk: false,
    healthStatus: "unauthorized",
    fetchedAt: "2026-06-24T10:05:00.000Z",
    observedAt: "2026-06-24T10:05:01.000Z",
    itemCount: 0,
    httpStatus: 401,
    errorCode: "webdock_auth_401"
  });
  const failedTwice = await store.observe({
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    responseOk: false,
    healthStatus: "unauthorized",
    fetchedAt: "2026-06-24T10:10:00.000Z",
    observedAt: "2026-06-24T10:10:01.000Z",
    itemCount: 0,
    httpStatus: 401,
    errorCode: "webdock_auth_401"
  });
  const recovered = await store.observe({
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    responseOk: true,
    healthStatus: "healthy",
    fetchedAt: "2026-06-24T10:15:00.000Z",
    observedAt: "2026-06-24T10:15:01.000Z",
    itemCount: 1
  });

  assert.equal(failedOnce.account.consecutiveFailures, 1);
  assert.equal(failedOnce.account.firstUnhealthyAt, "2026-06-24T10:05:01.000Z");
  assert.equal(failedTwice.account.consecutiveFailures, 2);
  assert.equal(failedTwice.account.firstUnhealthyAt, "2026-06-24T10:05:01.000Z");
  assert.equal(recovered.account.consecutiveFailures, 0);
  assert.equal(recovered.account.firstUnhealthyAt, undefined);
});

test("Infrastructure account lifecycle store soft-retires and does not unretire on observe", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-account-life-");
  t.after(cleanup);
  const store = new LocalFileInfrastructureAccountLifecycleStore(filePath);

  await assert.rejects(
    () => store.retire({
      providerId: "webdock",
      accountId: "tertiary",
      reason: "short",
      actorId: "operator",
      retiredAt: "2026-06-24T11:00:00.000Z"
    }),
    (error) => error instanceof Error && error.message === "retire_reason_too_short: minimum 10 characters required"
  );

  const retired = await store.retire({
    providerId: "webdock",
    accountId: "tertiary",
    accountLabel: "Cuenta perdida",
    reason: "Cuenta Webdock perdida permanentemente, retirar del selector.",
    actorId: "operator-juanes",
    retiredAt: "2026-06-24T11:00:00.000Z"
  });
  const observed = await store.observe({
    providerId: "webdock",
    accountId: "tertiary",
    accountLabel: "Cuenta perdida",
    responseOk: true,
    healthStatus: "healthy",
    fetchedAt: "2026-06-24T11:05:00.000Z",
    observedAt: "2026-06-24T11:05:01.000Z",
    itemCount: 9
  });

  assert.equal(retired.lifecycleStatus, "retired");
  assert.equal(observed.account.lifecycleStatus, "retired");
  assert.equal(observed.account.healthStatus, "retired");
  assert.equal(observed.account.retiredBy, "operator-juanes");
});

test("Infrastructure account lifecycle store remains retired across repeated observe calls", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-account-life-");
  t.after(cleanup);
  const store = new LocalFileInfrastructureAccountLifecycleStore(filePath);

  await store.retire({
    providerId: "webdock",
    accountId: "tertiary",
    accountLabel: "Cuenta perdida",
    reason: "Cuenta Webdock perdida permanentemente, retirar del selector.",
    actorId: "operator-juanes",
    retiredAt: "2026-06-24T11:00:00.000Z"
  });
  const failed = await store.observe({
    providerId: "webdock",
    accountId: "tertiary",
    accountLabel: "Cuenta perdida",
    responseOk: false,
    healthStatus: "unauthorized",
    fetchedAt: "2026-06-24T11:05:00.000Z",
    observedAt: "2026-06-24T11:05:01.000Z",
    itemCount: 0,
    httpStatus: 401,
    errorCode: "webdock_auth_401"
  });
  const recovered = await store.observe({
    providerId: "webdock",
    accountId: "tertiary",
    accountLabel: "Cuenta perdida",
    responseOk: true,
    healthStatus: "healthy",
    fetchedAt: "2026-06-24T11:10:00.000Z",
    observedAt: "2026-06-24T11:10:01.000Z",
    itemCount: 7
  });

  assert.equal(failed.account.lifecycleStatus, "retired");
  assert.equal(failed.account.healthStatus, "retired");
  assert.equal(failed.previousHealthStatus, "retired");
  assert.equal(failed.currentHealthStatus, "retired");
  assert.equal(failed.action, "none");
  assert.equal(failed.account.consecutiveFailures, 1);
  assert.equal(failed.account.lastKnownItemCount, 0);
  assert.equal(recovered.account.lifecycleStatus, "retired");
  assert.equal(recovered.account.healthStatus, "retired");
  assert.equal(recovered.previousHealthStatus, "retired");
  assert.equal(recovered.currentHealthStatus, "retired");
  assert.equal(recovered.action, "none");
  assert.equal(recovered.account.consecutiveFailures, 0);
  assert.equal(recovered.account.lastKnownItemCount, 7);
  assert.equal(recovered.account.updatedAt, "2026-06-24T11:10:01.000Z");
  assert.equal(recovered.account.retiredAt, "2026-06-24T11:00:00.000Z");
  assert.equal(recovered.account.retiredReason, "Cuenta Webdock perdida permanentemente, retirar del selector.");
});

test("Infrastructure account lifecycle store preserves Webdock cuenta madre aliases on retire", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-account-life-");
  t.after(cleanup);
  const store = new LocalFileInfrastructureAccountLifecycleStore(filePath);

  const retired = await store.retire({
    providerId: "webdock",
    accountId: "primary",
    accountLabel: "Cuenta madre",
    reason: "Cuenta madre Webdock retirada del selector por perdida operacional.",
    actorId: "operator-juanes",
    retiredAt: "2026-06-24T12:00:00.000Z"
  });

  assert.equal(retired.accountKey, "webdock:ops");
  assert.equal(retired.accountId, "ops");
  assert.deepEqual(retired.aliases, ["account", "default", "ops", "primary"]);
});

test("Infrastructure account lifecycle store accepts manual JSON rollback to active", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-account-life-");
  t.after(cleanup);
  const store = new LocalFileInfrastructureAccountLifecycleStore(filePath);

  await store.retire({
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    reason: "Cuenta Webdock retirada temporalmente por prueba de rollback manual.",
    actorId: "operator-juanes",
    retiredAt: "2026-06-24T12:00:00.000Z"
  });
  assert.equal((await store.get("webdock", "secondary"))?.lifecycleStatus, "retired");

  await writeFile(filePath, JSON.stringify({
    schemaVersion: "infrastructure-account-lifecycle/v1",
    updatedAt: "2026-06-24T12:05:00.000Z",
    accounts: [{
      accountKey: "webdock:secondary",
      providerId: "webdock",
      accountId: "secondary",
      accountLabel: "Cuenta 2",
      lifecycleStatus: "active",
      healthStatus: "healthy",
      lastKnownItemCount: 0,
      consecutiveFailures: 0,
      updatedAt: "2026-06-24T12:05:00.000Z",
      updatedBy: "operator-manual-rollback"
    }]
  }), "utf8");

  const rolledBack = await store.get("webdock", "secondary");
  assert.equal(rolledBack?.lifecycleStatus, "active");
  assert.equal(rolledBack?.healthStatus, "healthy");
  assert.equal(rolledBack?.retiredAt, undefined);

  const observed = await store.observe({
    providerId: "webdock",
    accountId: "secondary",
    accountLabel: "Cuenta 2",
    responseOk: true,
    healthStatus: "healthy",
    fetchedAt: "2026-06-24T12:06:00.000Z",
    observedAt: "2026-06-24T12:06:01.000Z",
    itemCount: 2
  });
  assert.equal(observed.account.lifecycleStatus, "active");
  assert.equal(observed.account.healthStatus, "healthy");
  assert.equal(observed.account.lastKnownItemCount, 2);
});

test("Infrastructure account lifecycle helpers expand legacy Webdock cuenta madre records", async (t) => {
  const { filePath, cleanup } = await tempFile("delivrix-account-life-");
  t.after(cleanup);
  await writeFile(filePath, JSON.stringify({
    schemaVersion: "infrastructure-account-lifecycle/v1",
    updatedAt: "2026-06-24T12:00:00.000Z",
    accounts: [{
      accountKey: "webdock:ops",
      providerId: "webdock",
      accountId: "ops",
      accountLabel: "Cuenta madre",
      lifecycleStatus: "retired",
      healthStatus: "retired",
      lastKnownItemCount: 3,
      consecutiveFailures: 0,
      retiredAt: "2026-06-24T12:00:00.000Z",
      retiredBy: "operator-juanes",
      retiredReason: "Registro legacy sin aliases debe bloquear todos los roles.",
      updatedAt: "2026-06-24T12:00:00.000Z",
      updatedBy: "operator-juanes"
    }]
  }), "utf8");

  const store = new LocalFileInfrastructureAccountLifecycleStore(filePath);
  const [record] = await store.list();

  assert.deepEqual(record.aliases, ["account", "default", "ops", "primary"]);
  assert.deepEqual(infrastructureAccountLifecycleIds(record), ["account", "default", "ops", "primary"]);
});

async function tempFile(prefix: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    filePath: join(dir, "store.json"),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

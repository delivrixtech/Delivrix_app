import assert from "node:assert/strict";
import test from "node:test";
import { buildInfrastructureInventoryResponse } from "./infrastructure-inventory.ts";

test("Infrastructure inventory response omits optional account health when absent", () => {
  const response = buildInfrastructureInventoryResponse({
    providers: [],
    now: new Date("2026-06-24T10:00:00.000Z")
  });

  assert.deepEqual(response, {
    generatedAt: "2026-06-24T10:00:00.000Z",
    itemTotal: 0,
    providers: []
  });
});

test("Infrastructure inventory response normalizes account health and orphan report", () => {
  const response = buildInfrastructureInventoryResponse({
    providers: [],
    accountHealth: {
      unhealthyCount: 1.9,
      retiredCount: 1.1,
      accounts: [{
        providerId: "webdock",
        providerKind: "compute",
        accountId: "secondary",
        accountLabel: "Cuenta 2",
        health: "unauthorized",
        lifecycleStatus: "unauthorized",
        responseOk: false,
        httpStatus: 401,
        errorCode: "webdock_auth_401",
        errorReason: "Webdock API returned 401 Unauthorized",
        liveItemCount: -4,
        lastKnownItemCount: 2.9,
        lastFetched: "2026-06-24T10:00:00.000Z"
      }]
    },
    orphanReport: {
      confirmedSenderNodeOrphans: [],
      uncertainBecauseAccountDown: [{
        providerId: "webdock",
        providerKind: "compute",
        accountId: "secondary",
        accountLabel: "Cuenta 2",
        health: "unauthorized",
        lifecycleStatus: "unauthorized",
        responseOk: false,
        liveItemCount: 0,
        lastFetched: null
      }],
      providerServersWithoutSenderNode: [{
        id: "server-1",
        kind: "webdock_server",
        displayName: "server-1",
        status: "running",
        detail: { ipv4: "203.0.113.10" }
      }]
    },
    now: new Date("2026-06-24T10:00:00.000Z")
  });

  assert.equal(response.accountHealth?.unhealthyCount, 1);
  assert.equal(response.accountHealth?.retiredCount, 1);
  assert.equal(response.accountHealth?.accounts[0].liveItemCount, 0);
  assert.equal(response.accountHealth?.accounts[0].lastKnownItemCount, 2);
  assert.equal(response.orphanReport?.providerServersWithoutSenderNode[0].detail?.ipv4, "203.0.113.10");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProviderTeardownPlan,
  liveResourcesFromLedger,
  type ProviderResourceRecord
} from "./provider-resource-ledger.ts";

function record(overrides: Partial<ProviderResourceRecord>): ProviderResourceRecord {
  return {
    id: overrides.id ?? "r1",
    provider: "webdock",
    accountId: "primary",
    resourceType: "vps_server",
    externalId: "srv-1",
    action: "created",
    occurredAt: "2026-07-06T10:00:00.000Z",
    ...overrides
  };
}

test("liveResourcesFromLedger: created sin deleted posterior queda vivo; deleted lo apaga", () => {
  const records = [
    record({ id: "a", externalId: "srv-1" }),
    record({ id: "b", externalId: "srv-2" }),
    record({ id: "c", externalId: "srv-1", action: "deleted", occurredAt: "2026-07-06T11:00:00.000Z" })
  ];

  const live = liveResourcesFromLedger(records);
  assert.equal(live.length, 1);
  assert.equal(live[0].externalId, "srv-2");
});

test("liveResourcesFromLedger: re-creacion despues de deleted vuelve a estar vivo", () => {
  const records = [
    record({ id: "a" }),
    record({ id: "b", action: "deleted", occurredAt: "2026-07-06T11:00:00.000Z" }),
    record({ id: "c", occurredAt: "2026-07-06T12:00:00.000Z" })
  ];

  assert.equal(liveResourcesFromLedger(records).length, 1);
});

test("buildProviderTeardownPlan: ordena DNS -> VPS -> dominio y marca el dominio como manual", () => {
  const records = [
    record({ id: "a", resourceType: "domain", externalId: "delivrixmail.com", provider: "namecheap", monthlyCostUsd: 0.76 }),
    record({ id: "b", resourceType: "vps_server", externalId: "srv-9", monthlyCostUsd: 12 }),
    record({ id: "c", resourceType: "dns_zone", externalId: "zone-1", provider: "aws-route53", monthlyCostUsd: 0.5 })
  ];

  const plan = buildProviderTeardownPlan(records);
  assert.equal(plan.liveResourceCount, 3);
  assert.deepEqual(
    plan.steps.map((step) => step.resourceType),
    ["dns_zone", "vps_server", "domain"]
  );
  const domainStep = plan.steps[2];
  assert.equal(domainStep.executable, false);
  assert.equal(domainStep.blockedReason, "registrar_release_has_no_api_path");
  assert.equal(plan.estimatedMonthlyCostUsd, 13.26);
});

test("buildProviderTeardownPlan: filtra por provider/accountId/flowId", () => {
  const records = [
    record({ id: "a", provider: "contabo", accountId: "contabo-2", flowId: "flow-1" }),
    record({ id: "b", provider: "contabo", accountId: "contabo-3", externalId: "srv-2" }),
    record({ id: "c", provider: "webdock", externalId: "srv-3", flowId: "flow-1" })
  ];

  assert.equal(buildProviderTeardownPlan(records, { provider: "contabo" }).liveResourceCount, 2);
  assert.equal(
    buildProviderTeardownPlan(records, { provider: "contabo", accountId: "contabo-2" }).liveResourceCount,
    1
  );
  assert.equal(buildProviderTeardownPlan(records, { flowId: "flow-1" }).liveResourceCount, 2);
});

test("buildProviderTeardownPlan: tipo desconocido queda como review_manual no ejecutable", () => {
  const plan = buildProviderTeardownPlan([record({ resourceType: "ssl_certificate" })]);
  assert.equal(plan.steps[0].suggestedAction, "review_manual");
  assert.equal(plan.steps[0].executable, false);
});

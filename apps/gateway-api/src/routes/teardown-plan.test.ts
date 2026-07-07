import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderResourceRecord } from "../../../../packages/domain/src/index.ts";
import { handleTeardownPlanHttp } from "./teardown-plan.ts";

function fakeHttp(url: string): {
  request: IncomingMessage;
  response: ServerResponse;
  result: () => { statusCode: number; body: unknown };
} {
  let statusCode = 0;
  let raw = "";
  const request = { url } as IncomingMessage;
  const response = {
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk: string) {
      raw = chunk;
    }
  } as unknown as ServerResponse;
  return {
    request,
    response,
    result: () => ({ statusCode, body: JSON.parse(raw) })
  };
}

const LEDGER: ProviderResourceRecord[] = [
  {
    id: "1",
    provider: "contabo",
    accountId: "contabo-2",
    resourceType: "vps_server",
    externalId: "301",
    action: "created",
    occurredAt: "2026-07-06T10:00:00.000Z",
    flowId: "flow-1",
    monthlyCostUsd: 8.5
  },
  {
    id: "2",
    provider: "namecheap",
    accountId: "namecheap-1",
    resourceType: "domain",
    externalId: "delivrixmail.com",
    action: "created",
    occurredAt: "2026-07-06T09:00:00.000Z"
  },
  {
    id: "3",
    provider: "contabo",
    accountId: "contabo-2",
    resourceType: "vps_server",
    externalId: "302",
    action: "created",
    occurredAt: "2026-07-06T10:30:00.000Z"
  },
  {
    id: "4",
    provider: "contabo",
    accountId: "contabo-2",
    resourceType: "vps_server",
    externalId: "302",
    action: "deleted",
    occurredAt: "2026-07-06T11:00:00.000Z"
  }
];

test("teardown-plan devuelve solo recursos vivos, ordenados y con costo estimado", async () => {
  const http = fakeHttp("/v1/infrastructure/teardown-plan");
  await handleTeardownPlanHttp({
    ...http,
    ledgerList: async () => LEDGER,
    now: () => new Date("2026-07-06T12:00:00.000Z")
  });

  const { statusCode, body } = http.result();
  const plan = body as {
    liveResourceCount: number;
    estimatedMonthlyCostUsd: number;
    steps: Array<{ resourceType: string; executable: boolean }>;
  };
  assert.equal(statusCode, 200);
  assert.equal(plan.liveResourceCount, 2);
  assert.equal(plan.estimatedMonthlyCostUsd, 8.5);
  assert.deepEqual(
    plan.steps.map((step) => step.resourceType),
    ["vps_server", "domain"]
  );
  assert.equal(plan.steps[1].executable, false);
});

test("teardown-plan filtra por query provider/accountId", async () => {
  const http = fakeHttp("/v1/infrastructure/teardown-plan?provider=contabo&accountId=contabo-2");
  await handleTeardownPlanHttp({ ...http, ledgerList: async () => LEDGER });

  const { body } = http.result();
  const plan = body as { liveResourceCount: number; scope: Record<string, string> };
  assert.equal(plan.liveResourceCount, 1);
  assert.deepEqual(plan.scope, { provider: "contabo", accountId: "contabo-2" });
});

test("teardown-plan degrada a 503 si el ledger no puede leerse", async () => {
  const http = fakeHttp("/v1/infrastructure/teardown-plan");
  await handleTeardownPlanHttp({
    ...http,
    ledgerList: async () => {
      throw new Error("disk");
    }
  });

  const { statusCode, body } = http.result();
  assert.equal(statusCode, 503);
  assert.equal((body as { error: string }).error, "provider_resource_ledger_unavailable");
});

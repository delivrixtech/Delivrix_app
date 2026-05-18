import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebdockInventoryContract,
  type WebdockInventoryServer
} from "./webdock-inventory.ts";

const fixedNow = new Date("2026-05-17T01:30:00.000Z");

function server(overrides: Partial<WebdockInventoryServer> = {}): WebdockInventoryServer {
  return {
    slug: "svc-test",
    name: "svc-test",
    ipv4: "10.0.0.1",
    status: "running",
    ...overrides
  };
}

test("buildWebdockInventoryContract: summary cuenta correcto y schemaVersion fijo", () => {
  const contract = buildWebdockInventoryContract({
    now: fixedNow,
    source: {
      kind: "live",
      apiBase: "https://api.webdock.io/v1",
      fetchedAt: fixedNow.toISOString(),
      responseOk: true
    },
    servers: [
      server({ slug: "a", status: "running" }),
      server({ slug: "b", status: "running" }),
      server({ slug: "c", status: "stopped" }),
      server({ slug: "d", status: "suspended" }),
      server({ slug: "e", status: "provisioning" })
    ]
  });

  assert.equal(contract.schemaVersion, "2026-05-17.v1");
  assert.equal(contract.mode, "read_only");
  assert.equal(contract.generatedAt, fixedNow.toISOString());
  assert.deepEqual(contract.summary, {
    total: 5,
    running: 2,
    stopped: 1,
    suspended: 1,
    other: 1
  });
  assert.equal(contract.source.kind, "live");
  assert.equal(contract.source.responseOk, true);
});

test("buildWebdockInventoryContract: fallback mock preserva errorMessage", () => {
  const contract = buildWebdockInventoryContract({
    now: fixedNow,
    source: {
      kind: "mock",
      apiBase: "https://api.webdock.io/v1",
      fetchedAt: fixedNow.toISOString(),
      responseOk: false,
      errorMessage: "API key missing"
    },
    servers: []
  });

  assert.equal(contract.summary.total, 0);
  assert.equal(contract.source.kind, "mock");
  assert.equal(contract.source.responseOk, false);
  assert.equal(contract.source.errorMessage, "API key missing");
});

test("buildWebdockInventoryContract: lista vacía produce summary cero", () => {
  const contract = buildWebdockInventoryContract({
    now: fixedNow,
    source: {
      kind: "live",
      apiBase: "https://api.webdock.io/v1",
      fetchedAt: fixedNow.toISOString(),
      responseOk: true
    },
    servers: []
  });

  assert.deepEqual(contract.summary, {
    total: 0,
    running: 0,
    stopped: 0,
    suspended: 0,
    other: 0
  });
  assert.equal(contract.servers.length, 0);
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalFileProviderResourceLedger } from "./local-file-provider-resource-ledger.ts";

test("provider resource ledger: append es append-only y list conserva orden", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delivrix-ledger-"));
  const ledger = new LocalFileProviderResourceLedger(join(dir, "ledger.json"));

  const created = await ledger.append({
    provider: "contabo",
    accountId: "contabo-2",
    resourceType: "vps_server",
    externalId: "301",
    action: "created",
    displayName: "smtp-node-3",
    flowId: "flow-42",
    monthlyCostUsd: 8.5
  });
  await ledger.append({
    provider: "contabo",
    accountId: "contabo-2",
    resourceType: "vps_server",
    externalId: "301",
    action: "deleted"
  });

  assert.ok(created.id);
  assert.ok(created.occurredAt);

  const records = await ledger.list();
  assert.equal(records.length, 2);
  assert.equal(records[0].action, "created");
  assert.equal(records[1].action, "deleted");
  assert.equal(records[0].flowId, "flow-42");

  await rm(dir, { recursive: true, force: true });
});

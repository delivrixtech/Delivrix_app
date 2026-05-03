import test from "node:test";
import assert from "node:assert/strict";
import { ProxmoxAdapter } from "./proxmox-adapter.ts";

test("plans Proxmox provisioning through the stable domain contract", () => {
  const adapter = new ProxmoxAdapter();
  const plan = adapter.planProvisioning({
    id: "proxmox_1",
    label: "Proxmox Sender 1"
  });

  assert.equal(plan.provider, "proxmox");
  assert.equal(plan.targetSenderNode.provider, "proxmox");
  assert.equal(plan.steps.length, 7);
  assert.equal(adapter.describeCapabilities().proxmoxApiEnabled, false);
});

test("converts mock config to a warming sender node", () => {
  const adapter = new ProxmoxAdapter();
  const input = adapter.toSenderNodeInput({
    id: "proxmox_1",
    label: "Proxmox Sender 1",
    dailyLimit: 25
  });

  assert.equal(input.status, "warming");
  assert.equal(input.dailyLimit, 25);
  assert.equal(input.warmupDay, 0);
});

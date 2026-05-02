import test from "node:test";
import assert from "node:assert/strict";
import { selectSenderNode, SenderNodeRegistry, type SenderNodeRegistryStore } from "./sender-node-registry.ts";
import type { SenderNode } from "./types.ts";

const activeNode: SenderNode = {
  id: "sender_active",
  label: "Active sender",
  provider: "webdock",
  status: "active",
  dailyLimit: 50,
  warmupDay: 7
};

test("selects active sender nodes before warming nodes", () => {
  const selected = selectSenderNode([
    {
      id: "sender_warming",
      label: "Warming sender",
      provider: "webdock",
      status: "warming",
      dailyLimit: 50,
      warmupDay: 1
    },
    activeNode
  ]);

  assert.equal(selected?.id, "sender_active");
});

test("does not select paused, quarantined or zero-limit sender nodes", () => {
  const selected = selectSenderNode([
    {
      id: "sender_paused",
      label: "Paused sender",
      provider: "webdock",
      status: "paused",
      dailyLimit: 50,
      warmupDay: 3
    },
    {
      id: "sender_zero",
      label: "Zero limit sender",
      provider: "webdock",
      status: "active",
      dailyLimit: 0,
      warmupDay: 3
    }
  ]);

  assert.equal(selected, null);
});

test("registers normalized sender nodes", async () => {
  const store = new MemorySenderNodeStore();
  const registry = new SenderNodeRegistry(store);

  const node = await registry.register({
    id: " sender_webdock_001 ",
    label: " Webdock Bridge 1 ",
    provider: "webdock",
    dailyLimit: 25
  });

  assert.equal(node.id, "sender_webdock_001");
  assert.equal(node.label, "Webdock Bridge 1");
  assert.equal(node.status, "warming");
  assert.equal(node.warmupDay, 0);
});

test("updates sender node status", async () => {
  const store = new MemorySenderNodeStore();
  const registry = new SenderNodeRegistry(store);

  await registry.register({
    id: "sender_webdock_001",
    label: "Webdock Bridge 1",
    provider: "webdock",
    status: "warming",
    dailyLimit: 25
  });

  const updated = await registry.updateStatus("sender_webdock_001", "degraded");

  assert.equal(updated.status, "degraded");
});

class MemorySenderNodeStore implements SenderNodeRegistryStore {
  private readonly nodes = new Map<string, SenderNode>();

  async list(): Promise<SenderNode[]> {
    return [...this.nodes.values()];
  }

  async upsert(node: SenderNode): Promise<SenderNode> {
    this.nodes.set(node.id, node);
    return node;
  }
}

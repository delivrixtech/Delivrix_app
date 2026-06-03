import test from "node:test";
import assert from "node:assert/strict";
import { selectSenderNode, SenderNodeRegistry, type SenderNodeRegistryStore } from "./sender-node-registry.ts";
import type {
  RateLimitCounter,
  RateLimitCounterStore,
  RateLimitRule
} from "./rate-limit.ts";
import type { SenderNode, SendRequest } from "./types.ts";

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

test("skips exhausted sender nodes when capacity snapshots are provided", () => {
  const selected = selectSenderNode([
    { ...activeNode, id: "sender_exhausted", dailyLimit: 50 },
    { ...activeNode, id: "sender_available", dailyLimit: 50 }
  ], [
    { senderNodeId: "sender_exhausted", consumed: 50 },
    { senderNodeId: "sender_available", consumed: 49 }
  ]);

  assert.equal(selected?.id, "sender_available");
});

test("orders active sender nodes by remaining capacity", () => {
  const selected = selectSenderNode([
    { ...activeNode, id: "sender_a", dailyLimit: 50 },
    { ...activeNode, id: "sender_b", dailyLimit: 50 }
  ], [
    { senderNodeId: "sender_a", consumed: 40 },
    { senderNodeId: "sender_b", consumed: 5 }
  ]);

  assert.equal(selected?.id, "sender_b");
});

test("registry findAvailableFor uses daily sender-node quota counters", async () => {
  const store = new MemorySenderNodeStore([
    { ...activeNode, id: "sender_exhausted", dailyLimit: 50 },
    { ...activeNode, id: "sender_available", dailyLimit: 50 }
  ]);
  const quotaStore = new MemoryRateLimitCounterStore([
    counter("sender_exhausted", 50),
    counter("sender_available", 49)
  ]);
  const registry = new SenderNodeRegistry(store, {
    quotaStore,
    now: () => new Date("2026-06-02T12:00:00.000Z")
  });

  const selected = await registry.findAvailableFor(sendRequest());

  assert.equal(selected?.id, "sender_available");
});

test("registry findAvailableFor fails closed when quota state cannot be read", async () => {
  const store = new MemorySenderNodeStore([activeNode]);
  const registry = new SenderNodeRegistry(store, {
    quotaStore: new FailingRateLimitCounterStore(),
    now: () => new Date("2026-06-02T12:00:00.000Z")
  });

  assert.equal(await registry.findAvailableFor(sendRequest()), null);
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

  constructor(nodes: SenderNode[] = []) {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  async list(): Promise<SenderNode[]> {
    return [...this.nodes.values()];
  }

  async upsert(node: SenderNode): Promise<SenderNode> {
    this.nodes.set(node.id, node);
    return node;
  }
}

class MemoryRateLimitCounterStore implements RateLimitCounterStore {
  private readonly counters: RateLimitCounter[];

  constructor(counters: RateLimitCounter[]) {
    this.counters = counters;
  }

  async get(rule: RateLimitRule, windowKey: string): Promise<RateLimitCounter> {
    return this.counters.find((candidate) => candidate.scope === rule.scope
      && candidate.id === rule.id
      && candidate.window === rule.window
      && candidate.windowKey === windowKey) ?? {
      scope: rule.scope,
      id: rule.id,
      window: rule.window,
      windowKey,
      count: 0
    };
  }

  async increment(rule: RateLimitRule, windowKey: string, amount: number): Promise<RateLimitCounter> {
    const current = await this.get(rule, windowKey);
    return { ...current, count: current.count + amount };
  }

  async tryConsume(rules: RateLimitRule[], windowKey: string, amount: number) {
    return {
      allowed: true,
      violations: [],
      counters: await Promise.all(rules.map((rule) => this.increment(rule, windowKey, amount)))
    };
  }

  async list(): Promise<RateLimitCounter[]> {
    return this.counters;
  }
}

class FailingRateLimitCounterStore implements RateLimitCounterStore {
  async get(): Promise<RateLimitCounter> {
    throw new Error("quota store unavailable");
  }

  async increment(): Promise<RateLimitCounter> {
    throw new Error("quota store unavailable");
  }

  async tryConsume() {
    throw new Error("quota store unavailable");
  }

  async list(): Promise<RateLimitCounter[]> {
    throw new Error("quota store unavailable");
  }
}

function counter(id: string, count: number): RateLimitCounter {
  return {
    scope: "sender_node",
    id,
    window: "daily",
    windowKey: "2026-06-02",
    count
  };
}

function sendRequest(): SendRequest {
  return {
    campaignId: "campaign-1",
    recipient: { email: "recipient@example.com" },
    sender: { address: "ops@sender.example", domain: "sender.example" },
    subject: "Operational report",
    bodyText: "Authorized operational update.",
    classification: "operational"
  };
}

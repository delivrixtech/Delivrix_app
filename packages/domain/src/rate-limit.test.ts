import test from "node:test";
import assert from "node:assert/strict";
import {
  RateLimitService,
  requestRateLimitRules,
  senderNodeRateLimitRule,
  type RateLimitCounter,
  type RateLimitCounterStore,
  type RateLimitRule
} from "./rate-limit.ts";
import type { SendRequest, SenderNode } from "./types.ts";

test("allows and consumes counters inside daily limits", async () => {
  const store = new MemoryRateLimitCounterStore();
  const service = new RateLimitService(store, () => new Date("2026-05-02T10:00:00.000Z"));
  const rule: RateLimitRule = {
    scope: "campaign",
    id: "campaign_001",
    limit: 2,
    window: "daily"
  };

  const first = await service.consume([rule]);
  const second = await service.consume([rule]);
  const third = await service.check([rule]);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.violations[0]?.current, 2);
});

test("does not consume counters when any rule is over limit", async () => {
  const store = new MemoryRateLimitCounterStore();
  const service = new RateLimitService(store, () => new Date("2026-05-02T10:00:00.000Z"));
  const campaignRule: RateLimitRule = {
    scope: "campaign",
    id: "campaign_001",
    limit: 1,
    window: "daily"
  };
  const domainRule: RateLimitRule = {
    scope: "recipient_domain",
    id: "example.com",
    limit: 10,
    window: "daily"
  };

  await service.consume([campaignRule, domainRule]);
  const blocked = await service.consume([campaignRule, domainRule]);
  const counters = await store.list();

  assert.equal(blocked.allowed, false);
  assert.equal(counters.find((counter) => counter.scope === "campaign")?.count, 1);
  assert.equal(counters.find((counter) => counter.scope === "recipient_domain")?.count, 1);
});

test("builds request rate-limit rules from campaign and domains", () => {
  const request: SendRequest = {
    campaignId: "campaign_001",
    recipient: {
      email: "Founder@Example.COM",
      consentProofId: "proof_001"
    },
    sender: {
      address: "hello@delivrix.com",
      domain: "Delivrix.COM"
    },
    subject: "Reminder",
    bodyText: "Body",
    classification: "commercial",
    unsubscribeUrl: "https://delivrix.com/unsubscribe",
    physicalAddress: "Delivrix LLC physical mailing address"
  };

  const rules = requestRateLimitRules(request, {
    campaignDailyLimit: 100,
    senderDomainDailyLimit: 200,
    recipientDomainDailyLimit: 300
  });

  assert.deepEqual(
    rules.map((rule) => `${rule.scope}:${rule.id}:${rule.limit}`),
    ["campaign:campaign_001:100", "sender_domain:delivrix.com:200", "recipient_domain:example.com:300"]
  );
});

test("builds sender-node rule from node dailyLimit", () => {
  const node: SenderNode = {
    id: "sender_001",
    label: "Sender 1",
    provider: "webdock",
    status: "warming",
    dailyLimit: 50,
    warmupDay: 1
  };

  assert.deepEqual(senderNodeRateLimitRule(node), {
    scope: "sender_node",
    id: "sender_001",
    limit: 50,
    window: "daily"
  });
});

class MemoryRateLimitCounterStore implements RateLimitCounterStore {
  private readonly counters = new Map<string, RateLimitCounter>();

  async get(rule: RateLimitRule, windowKey: string): Promise<RateLimitCounter> {
    return this.counters.get(key(rule, windowKey)) ?? {
      scope: rule.scope,
      id: rule.id,
      window: rule.window,
      windowKey,
      count: 0
    };
  }

  async increment(rule: RateLimitRule, windowKey: string, amount: number): Promise<RateLimitCounter> {
    const counter = await this.get(rule, windowKey);
    const updated = {
      ...counter,
      count: counter.count + amount
    };

    this.counters.set(key(rule, windowKey), updated);
    return updated;
  }

  async list(): Promise<RateLimitCounter[]> {
    return [...this.counters.values()];
  }
}

function key(rule: RateLimitRule, windowKey: string): string {
  return `${rule.scope}:${rule.id}:${rule.window}:${windowKey}`;
}

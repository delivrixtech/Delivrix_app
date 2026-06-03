import type { SendRequest, SenderNode } from "./types.ts";

export type RateLimitScope = "sender_node" | "campaign" | "sender_domain" | "recipient_domain";
export type RateLimitWindow = "daily";

export interface RateLimitRule {
  scope: RateLimitScope;
  id: string;
  limit: number;
  window: RateLimitWindow;
}

export interface RateLimitCounter {
  scope: RateLimitScope;
  id: string;
  window: RateLimitWindow;
  windowKey: string;
  count: number;
}

export interface RateLimitCounterStore {
  get(rule: RateLimitRule, windowKey: string): Promise<RateLimitCounter>;
  increment(rule: RateLimitRule, windowKey: string, amount: number): Promise<RateLimitCounter>;
  tryConsume(rules: RateLimitRule[], windowKey: string, amount: number): Promise<RateLimitDecision>;
  list(): Promise<RateLimitCounter[]>;
}

export interface RateLimitViolation {
  scope: RateLimitScope;
  id: string;
  limit: number;
  current: number;
  requested: number;
  window: RateLimitWindow;
  windowKey: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  violations: RateLimitViolation[];
  counters: RateLimitCounter[];
}

export interface RequestRateLimitProfile {
  campaignDailyLimit: number;
  senderDomainDailyLimit: number;
  recipientDomainDailyLimit: number;
}

export class RateLimitService {
  private readonly store: RateLimitCounterStore;
  private readonly now: () => Date;

  constructor(store: RateLimitCounterStore, now: () => Date = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  async check(rules: RateLimitRule[], amount = 1): Promise<RateLimitDecision> {
    const windowKey = dailyWindowKey(this.now());
    const counters = await Promise.all(rules.map((rule) => this.store.get(rule, windowKey)));
    const violations = counters
      .map((counter, index) => toViolation(counter, rules[index], amount))
      .filter((violation): violation is RateLimitViolation => violation !== null);

    return {
      allowed: violations.length === 0,
      violations,
      counters
    };
  }

  async consume(rules: RateLimitRule[], amount = 1): Promise<RateLimitDecision> {
    const windowKey = dailyWindowKey(this.now());
    return this.store.tryConsume(rules, windowKey, amount);
  }
}

export function requestRateLimitRules(request: SendRequest, profile: RequestRateLimitProfile): RateLimitRule[] {
  return [
    {
      scope: "campaign",
      id: request.campaignId,
      limit: profile.campaignDailyLimit,
      window: "daily"
    },
    {
      scope: "sender_domain",
      id: normalizeDomain(request.sender.domain),
      limit: profile.senderDomainDailyLimit,
      window: "daily"
    },
    {
      scope: "recipient_domain",
      id: emailDomain(request.recipient.email),
      limit: profile.recipientDomainDailyLimit,
      window: "daily"
    }
  ];
}

export function senderNodeRateLimitRule(senderNode: SenderNode): RateLimitRule {
  return {
    scope: "sender_node",
    id: senderNode.id,
    limit: senderNode.dailyLimit,
    window: "daily"
  };
}

export function dailyWindowKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function emailDomain(email: string): string {
  const parts = email.trim().toLowerCase().split("@");

  if (parts.length !== 2 || !parts[1]) {
    throw new Error("A valid recipient email domain is required.");
  }

  return parts[1];
}

function normalizeDomain(domain: string): string {
  const normalized = domain.trim().toLowerCase();

  if (!normalized) {
    throw new Error("A valid sender domain is required.");
  }

  return normalized;
}

function toViolation(
  counter: RateLimitCounter,
  rule: RateLimitRule | undefined,
  amount: number
): RateLimitViolation | null {
  if (!rule) {
    return null;
  }

  if (counter.count + amount <= rule.limit) {
    return null;
  }

  return {
    scope: rule.scope,
    id: rule.id,
    limit: rule.limit,
    current: counter.count,
    requested: amount,
    window: rule.window,
    windowKey: counter.windowKey
  };
}

import type {
  RateLimitCounter,
  RateLimitDecision,
  RateLimitViolation,
  RateLimitCounterStore,
  RateLimitRule
} from "../../domain/src/index.ts";
import { JsonFileStore } from "./json-file-store.ts";

export class LocalFileRateLimitStore implements RateLimitCounterStore {
  private readonly store: JsonFileStore<RateLimitCounter[]>;

  constructor(filePath = process.env.LOCAL_RATE_LIMIT_COUNTERS_FILE ?? "runtime/rate-limit-counters.json") {
    this.store = new JsonFileStore<RateLimitCounter[]>(filePath);
  }

  async get(rule: RateLimitRule, windowKey: string): Promise<RateLimitCounter> {
    const counters = await this.store.read([]);
    return counters.find((counter) => matches(counter, rule, windowKey)) ?? {
      scope: rule.scope,
      id: rule.id,
      window: rule.window,
      windowKey,
      count: 0
    };
  }

  async increment(rule: RateLimitRule, windowKey: string, amount: number): Promise<RateLimitCounter> {
    return this.store.transaction([], (counters) => {
      const updated = incrementCounter(counters, rule, windowKey, amount);
      return { value: counters, result: updated };
    });
  }

  async tryConsume(rules: RateLimitRule[], windowKey: string, amount: number): Promise<RateLimitDecision> {
    return this.store.transaction([], (counters) => {
      const currentCounters = rules.map((rule) => findCounter(counters, rule, windowKey));
      const violations = currentCounters
        .map((counter, index) => toViolation(counter, rules[index], amount))
        .filter((violation): violation is RateLimitViolation => violation !== null);

      if (violations.length > 0) {
        return {
          value: counters,
          result: {
            allowed: false,
            violations,
            counters: currentCounters
          }
        };
      }

      const updatedCounters = rules.map((rule) => incrementCounter(counters, rule, windowKey, amount));
      return {
        value: counters,
        result: {
          allowed: true,
          violations: [],
          counters: updatedCounters
        }
      };
    });
  }

  async list(): Promise<RateLimitCounter[]> {
    return this.store.read([]);
  }
}

function matches(counter: RateLimitCounter, rule: RateLimitRule, windowKey: string): boolean {
  return counter.scope === rule.scope
    && counter.id === rule.id
    && counter.window === rule.window
    && counter.windowKey === windowKey;
}

function findCounter(counters: RateLimitCounter[], rule: RateLimitRule, windowKey: string): RateLimitCounter {
  return counters.find((counter) => matches(counter, rule, windowKey)) ?? {
    scope: rule.scope,
    id: rule.id,
    window: rule.window,
    windowKey,
    count: 0
  };
}

function incrementCounter(
  counters: RateLimitCounter[],
  rule: RateLimitRule,
  windowKey: string,
  amount: number
): RateLimitCounter {
  const index = counters.findIndex((counter) => matches(counter, rule, windowKey));
  const current = index >= 0 ? counters[index] : findCounter(counters, rule, windowKey);
  const updated = {
    ...current,
    count: current.count + amount
  };

  if (index >= 0) {
    counters[index] = updated;
  } else {
    counters.push(updated);
  }
  return updated;
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

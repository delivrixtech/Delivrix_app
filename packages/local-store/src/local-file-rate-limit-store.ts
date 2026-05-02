import type {
  RateLimitCounter,
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
    const counters = await this.store.read([]);
    const index = counters.findIndex((counter) => matches(counter, rule, windowKey));
    const current = index >= 0 ? counters[index] : {
      scope: rule.scope,
      id: rule.id,
      window: rule.window,
      windowKey,
      count: 0
    };
    const updated = {
      ...current,
      count: current.count + amount
    };

    if (index >= 0) {
      counters[index] = updated;
    } else {
      counters.push(updated);
    }

    await this.store.write(counters);
    return updated;
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

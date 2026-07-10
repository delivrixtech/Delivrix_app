import assert from "node:assert/strict";
import test from "node:test";
import { getWarmupTrends } from "./trends-service.ts";
import type { PlacementTrendPoint, ProviderPlacement } from "../domain/trends.ts";
import type { PlacementStore, SignalStore } from "../store/ports.ts";

const now = new Date("2026-07-09T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

interface Recorded {
  seriesLimit?: number;
  providerSince?: Date;
  signalsSince?: Date;
}

function fakeStores(
  data: {
    rollups?: PlacementTrendPoint[];
    providers?: ProviderPlacement[];
    signals?: { bounces: number; complaints: number };
  } = {}
): { stores: { placement: PlacementStore; signals: SignalStore }; recorded: Recorded } {
  const recorded: Recorded = {};
  const placement = {
    async listRecentRollups(limit: number): Promise<PlacementTrendPoint[]> {
      recorded.seriesLimit = limit;
      return data.rollups ?? [];
    },
    async aggregateByProvider(since: Date): Promise<ProviderPlacement[]> {
      recorded.providerSince = since;
      return data.providers ?? [];
    }
  } as unknown as PlacementStore;
  const signals = {
    async countRecent(since: Date): Promise<{ bounces: number; complaints: number }> {
      recorded.signalsSince = since;
      return data.signals ?? { bounces: 0, complaints: 0 };
    }
  } as unknown as SignalStore;
  return { stores: { placement, signals }, recorded };
}

test("getWarmupTrends: serie invertida a orden cronológico; defaults de ventana", async () => {
  const rollups: PlacementTrendPoint[] = [
    { windowEnd: "2026-07-09T00:00:00.000Z", samples: 30 }, // más nuevo primero (como devuelve la store)
    { windowEnd: "2026-07-08T00:00:00.000Z", samples: 20 },
    { windowEnd: "2026-07-07T00:00:00.000Z", samples: 10 }
  ];
  const { stores, recorded } = fakeStores({
    rollups,
    providers: [{ provider: "gmail", inbox: 8, tabs: 2, spam: 1, missing: 1, total: 10, inboxRate: 0.8 }],
    signals: { bounces: 2, complaints: 1 }
  });

  const trends = await getWarmupTrends(stores, { now });

  assert.equal(trends.generatedAt, now.toISOString());
  // invertida: más viejo primero
  assert.deepEqual(
    trends.placementSeries.map((p) => p.windowEnd),
    ["2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z", "2026-07-09T00:00:00.000Z"]
  );
  assert.equal(trends.perProvider[0].provider, "gmail");
  assert.deepEqual(trends.signals, { bounces: 2, complaints: 1 });

  // defaults: seriesLimit 30, providerWindow 7d, signals 30d
  assert.equal(recorded.seriesLimit, 30);
  assert.equal(recorded.providerSince!.getTime(), now.getTime() - 7 * DAY_MS);
  assert.equal(recorded.signalsSince!.getTime(), now.getTime() - 30 * DAY_MS);
});

test("getWarmupTrends: honra overrides seriesLimit/providerWindowDays", async () => {
  const { stores, recorded } = fakeStores();
  await getWarmupTrends(stores, { now, seriesLimit: 5, providerWindowDays: 14 });
  assert.equal(recorded.seriesLimit, 5);
  assert.equal(recorded.providerSince!.getTime(), now.getTime() - 14 * DAY_MS);
});

test("getWarmupTrends: rampa de referencia lineal topada (dailyLimit 50, step 2), 1..rampDays", async () => {
  const { stores } = fakeStores();
  const trends = await getWarmupTrends(stores, { now, rampDays: 30 });
  assert.equal(trends.ramp.length, 30);
  assert.deepEqual(trends.ramp[0], { dayIndex: 1, quota: 2 }); // 1*2
  assert.deepEqual(trends.ramp[4], { dayIndex: 5, quota: 10 }); // 5*2
  assert.deepEqual(trends.ramp[24], { dayIndex: 25, quota: 50 }); // topado en dailyLimit
  assert.deepEqual(trends.ramp[29], { dayIndex: 30, quota: 50 });
});

test("getWarmupTrends: datos vacíos ⇒ arrays vacíos, nunca lanza", async () => {
  const { stores } = fakeStores();
  const trends = await getWarmupTrends(stores, { now });
  assert.deepEqual(trends.placementSeries, []);
  assert.deepEqual(trends.perProvider, []);
  assert.deepEqual(trends.signals, { bounces: 0, complaints: 0 });
  assert.ok(trends.ramp.length > 0); // la rampa es una referencia, no depende de la DB
});

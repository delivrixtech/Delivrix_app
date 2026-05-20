import assert from "node:assert/strict";
import test from "node:test";
import { buildRealTimeMeta } from "../../../packages/domain/src/index.ts";
import { SafetyRealtimeCache } from "./safety-realtime-cache.ts";

test("SafetyRealtimeCache returns cached payload for second GET inside 30s", async () => {
  let nowMs = Date.parse("2026-05-20T16:35:00.000Z");
  let liveCalls = 0;
  const cache = new SafetyRealtimeCache(30_000, () => nowMs);

  const first = await cache.resolve(
    "/v1/compliance/status",
    async (now) => {
      liveCalls += 1;
      return {
        value: liveCalls,
        meta: buildRealTimeMeta({ dataSource: "live", now })
      };
    },
    (now) => ({
      value: -1,
      meta: buildRealTimeMeta({ dataSource: "fallback", now })
    })
  );

  nowMs += 1_000;
  const second = await cache.resolve(
    "/v1/compliance/status",
    async (now) => {
      liveCalls += 1;
      return {
        value: liveCalls,
        meta: buildRealTimeMeta({ dataSource: "live", now })
      };
    },
    (now) => ({
      value: -1,
      meta: buildRealTimeMeta({ dataSource: "fallback", now })
    })
  );

  assert.equal(first.meta.dataSource, "live");
  assert.equal(second.meta.dataSource, "cached");
  assert.equal(second.meta.staleSinceMs, 1_000);
  assert.equal(second.value, 1);
  assert.equal(liveCalls, 1);
});

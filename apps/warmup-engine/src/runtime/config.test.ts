import assert from "node:assert/strict";
import test from "node:test";
import { warmupEngineEnabled, assertWarmupEngineEnabled } from "./config.ts";

test("default OFF: sin la var el engine está inerte", () => {
  assert.equal(warmupEngineEnabled({}), false);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "" }), false);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "false" }), false);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "0" }), false);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "no" }), false);
});

test("ON solo con true/1 explícito", () => {
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "true" }), true);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "TRUE" }), true);
  assert.equal(warmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "1" }), true);
});

test("assertWarmupEngineEnabled lanza si está OFF y no lanza si está ON", () => {
  assert.throws(() => assertWarmupEngineEnabled({}), /warmup_engine_disabled/);
  assert.doesNotThrow(() => assertWarmupEngineEnabled({ WARMUP_ENGINE_ENABLE: "true" }));
});

import assert from "node:assert/strict";
import test from "node:test";
import { dailyQuota } from "./ramp.ts";

const base = { dailyLimit: 10, increaseByDay: 1, dayIndex: 0, weekdaysOnly: false };

test("día 0 (recién onboardeado) no envía todavía", () => {
  assert.equal(dailyQuota({ ...base, dayIndex: 0 }, 1), 0);
});

test("rampa lenta: sube de a increaseByDay desde el día 1", () => {
  assert.equal(dailyQuota({ ...base, dayIndex: 1 }, 1), 1);
  assert.equal(dailyQuota({ ...base, dayIndex: 3 }, 1), 3);
  assert.equal(dailyQuota({ ...base, dayIndex: 5, increaseByDay: 2 }, 1), 10);
});

test("nunca supera el daily_limit (no arranca en el tope)", () => {
  assert.equal(dailyQuota({ ...base, dayIndex: 50 }, 1), 10);
  assert.equal(dailyQuota({ ...base, dayIndex: 1 }, 1), 1, "el día 1 arranca en 1, no en el tope");
});

test("weekdaysOnly manda 0 el fin de semana y el cupo normal entre semana", () => {
  const node = { ...base, dayIndex: 4, weekdaysOnly: true };
  assert.equal(dailyQuota(node, 5), 4, "viernes");
  assert.equal(dailyQuota(node, 6), 0, "sábado");
  assert.equal(dailyQuota(node, 7), 0, "domingo");
  assert.equal(dailyQuota(node, 1), 4, "lunes");
});

test("robustez: valores negativos/no finitos se normalizan a 0", () => {
  assert.equal(dailyQuota({ ...base, dayIndex: -3 }, 1), 0);
  assert.equal(dailyQuota({ ...base, increaseByDay: Number.NaN, dayIndex: 2 }, 1), 0);
  assert.equal(dailyQuota({ ...base, dailyLimit: -1, dayIndex: 2 }, 1), 0);
});

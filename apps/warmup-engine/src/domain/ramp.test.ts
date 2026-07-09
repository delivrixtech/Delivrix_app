import assert from "node:assert/strict";
import test from "node:test";
import { dailyQuota } from "./ramp.ts";

const base = { dailyLimit: 100, increaseByDay: 5, dayIndex: 0, weekdaysOnly: false };

test("día 0 (recién onboardeado) no envía todavía", () => {
  assert.equal(dailyQuota({ ...base, dayIndex: 0 }, 1), 0);
});

test("rampa LINEAL: sube de a increaseByDay desde el día 1", () => {
  assert.equal(dailyQuota({ ...base, dayIndex: 1 }, 1), 5);
  assert.equal(dailyQuota({ ...base, dayIndex: 3 }, 1), 15);
  assert.equal(dailyQuota({ ...base, dayIndex: 4 }, 1), 20);
});

test("nunca supera dailyLimit (no arranca en el tope)", () => {
  assert.equal(dailyQuota({ ...base, dayIndex: 50 }, 1), 100);
  assert.equal(dailyQuota({ ...base, dayIndex: 1 }, 1), 5, "el día 1 arranca en 5, no en el tope");
});

test("weekdaysOnly manda 0 el fin de semana y el cupo normal entre semana", () => {
  const node = { ...base, dayIndex: 4, weekdaysOnly: true };
  assert.equal(dailyQuota(node, 5), 20, "viernes");
  assert.equal(dailyQuota(node, 6), 0, "sábado");
  assert.equal(dailyQuota(node, 7), 0, "domingo");
  assert.equal(dailyQuota(node, 1), 20, "lunes");
});

test("robustez: valores negativos/no finitos se normalizan a 0", () => {
  assert.equal(dailyQuota({ ...base, dayIndex: -3 }, 1), 0);
  assert.equal(dailyQuota({ ...base, increaseByDay: Number.NaN, dayIndex: 2 }, 1), 0);
  assert.equal(dailyQuota({ ...base, dailyLimit: -1, dayIndex: 2 }, 1), 0);
});

test("clamp 3×/48h: nunca crece más de 3× el cupo de hace 2 días", () => {
  // Día 10 con step 5 = 50, pero hace 2 días el cupo fue 10 ⇒ tope 30.
  assert.equal(dailyQuota({ ...base, dayIndex: 10 }, 1, { quotaTwoDaysAgo: 10 }), 30);
  // Sin spike (crecimiento suave) el clamp no muerde: día 4 = 20, hace 2 días 10 ⇒ 3×10=30 ≥ 20.
  assert.equal(dailyQuota({ ...base, dayIndex: 4 }, 1, { quotaTwoDaysAgo: 10 }), 20);
  // quotaTwoDaysAgo=0 (arranque) NO fuerza 0: el clamp multiplicativo se salta.
  assert.equal(dailyQuota({ ...base, dayIndex: 2 }, 1, { quotaTwoDaysAgo: 0 }), 10);
  // multiplicador configurable.
  assert.equal(dailyQuota({ ...base, dayIndex: 10 }, 1, { quotaTwoDaysAgo: 10, maxRampMultiplier48h: 2 }), 20);
});

test("cap Gmail cuenta nueva: nunca ≥ el cap (§10: 50)", () => {
  // Día 20 × step 5 = 100 topado a dailyLimit 100, pero Gmail nueva cap 50.
  assert.equal(dailyQuota({ ...base, dayIndex: 20 }, 1, { gmailNewAccountCap: 50 }), 50);
  // Por debajo del cap no lo toca.
  assert.equal(dailyQuota({ ...base, dayIndex: 4 }, 1, { gmailNewAccountCap: 50 }), 20);
});

test("clamp por contrato de auth: sendingLimits.maxPerDay topa el cupo", () => {
  assert.equal(dailyQuota({ ...base, dayIndex: 10 }, 1, { contractMaxPerDay: 25 }), 25);
  // Contrato a 0 ⇒ no envía (fail-closed).
  assert.equal(dailyQuota({ ...base, dayIndex: 10 }, 1, { contractMaxPerDay: 0 }), 0);
  // Contrato negativo ⇒ 0 (límite inválido, fail-closed).
  assert.equal(dailyQuota({ ...base, dayIndex: 10 }, 1, { contractMaxPerDay: -5 }), 0);
});

test("todos los clamps a la vez: gana el más restrictivo", () => {
  // linear=50, gmail=50, contrato=40, 3×48h(15)=45 ⇒ min = 40.
  const q = dailyQuota({ ...base, dayIndex: 10 }, 1, {
    gmailNewAccountCap: 50,
    contractMaxPerDay: 40,
    quotaTwoDaysAgo: 15
  });
  assert.equal(q, 40);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createRecipientPool } from "./recipient-pool.ts";
import type { EngagedRecipient } from "./trends.ts";

const seeds = [
  { address: "seed-gmail@delivrix.test", provider: "gmail" as const },
  { address: "seed-outlook@delivrix.test", provider: "outlook" as const }
];

const curated: EngagedRecipient[] = [
  { address: "alice@real.test", source: "curated", weight: 1 },
  { address: "bob@real.test", source: "curated", weight: 1 },
  { address: "carol@real.test", source: "curated", weight: 1 }
];

test("seedQuota = floor(count * 0.1) (cap ≤10%, §9)", () => {
  const pool = createRecipientPool(seeds, curated);
  assert.equal(pool.seedQuota(100), 10);
  assert.equal(pool.seedQuota(25), 2);
  assert.equal(pool.seedQuota(9), 0);
  assert.equal(pool.seedQuota(0), 0);
});

test("seedQuota = 0 si no hay seeds (no hay cupo posible)", () => {
  const pool = createRecipientPool([], curated);
  assert.equal(pool.seedQuota(100), 0);
});

test("pick es DETERMINISTA: mismo (nodeId,index) ⇒ mismo destinatario", () => {
  const pool = createRecipientPool(seeds, curated, { dailyVolume: 100 });
  for (let i = 0; i < 100; i += 1) {
    const a = pool.pick("node-1", i);
    const b = pool.pick("node-1", i);
    assert.deepEqual(a, b, `index ${i} debe ser estable`);
  }
});

test("cap de seeds ≤10%: los primeros seedQuota(total) slots son seeds, el resto curated", () => {
  const pool = createRecipientPool(seeds, curated, { dailyVolume: 100 });
  let seedCount = 0;
  let curatedCount = 0;
  for (let i = 0; i < 100; i += 1) {
    const r = pool.pick("node-1", i);
    assert.ok(r, `pick(${i}) no debe ser undefined`);
    if (r!.source === "seed") seedCount += 1;
    else curatedCount += 1;
  }
  assert.equal(seedCount, 10, "exactamente floor(100*0.1) = 10 seeds");
  assert.equal(curatedCount, 90);
  assert.ok(seedCount / 100 <= 0.1, "el cap de seeds nunca supera el 10%");

  // Los slots de seed son los PRIMEROS y rotan en round-robin entre los 2 seeds.
  assert.equal(pool.pick("node-1", 0)!.source, "seed");
  assert.equal(pool.pick("node-1", 0)!.address, seeds[0].address);
  assert.equal(pool.pick("node-1", 1)!.address, seeds[1].address);
  assert.equal(pool.pick("node-1", 9)!.source, "seed");
  assert.equal(pool.pick("node-1", 10)!.source, "curated");
});

test("ponderación por weight: el curated más pesado domina el volumen", () => {
  const weighted: EngagedRecipient[] = [
    { address: "heavy@real.test", source: "curated", weight: 9 },
    { address: "light@real.test", source: "curated", weight: 1 }
  ];
  // Sin seeds para que todos los slots sean curated y contemos limpio.
  const pool = createRecipientPool([], weighted, { dailyVolume: 1000 });
  let heavy = 0;
  let light = 0;
  for (let i = 0; i < 1000; i += 1) {
    const r = pool.pick("node-1", i)!;
    if (r.address === "heavy@real.test") heavy += 1;
    else light += 1;
  }
  assert.ok(heavy > light * 3, `el peso 9 debe dominar (heavy=${heavy}, light=${light})`);
  assert.ok(light > 0, "el peso 1 igual recibe algo de tráfico");
});

test("sin engaged ⇒ todos los picks caen a seeds", () => {
  const pool = createRecipientPool(seeds, [], { dailyVolume: 100 });
  for (let i = 0; i < 50; i += 1) {
    const r = pool.pick("node-1", i)!;
    assert.equal(r.source, "seed", `index ${i} sin curated debe ser seed`);
  }
});

test("sin seeds ⇒ todos los picks caen a curated (incluso el slot de seed)", () => {
  const pool = createRecipientPool([], curated, { dailyVolume: 100 });
  for (let i = 0; i < 50; i += 1) {
    const r = pool.pick("node-1", i)!;
    assert.equal(r.source, "curated");
  }
});

test("vacío total (sin seeds ni curated) ⇒ pick devuelve undefined", () => {
  const pool = createRecipientPool([], [], { dailyVolume: 100 });
  assert.equal(pool.pick("node-1", 0), undefined);
  assert.equal(pool.pick("node-1", 7), undefined);
});

test("sin dailyVolume: los seeds se reparten ~1 de cada stride (mejor esfuerzo, ≤10%)", () => {
  const pool = createRecipientPool(seeds, curated);
  // stride = round(1/0.1) = 10 ⇒ seed en index 0,10,20…
  assert.equal(pool.pick("node-1", 0)!.source, "seed");
  assert.equal(pool.pick("node-1", 10)!.source, "seed");
  assert.equal(pool.pick("node-1", 5)!.source, "curated");
});

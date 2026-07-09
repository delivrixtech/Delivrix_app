import assert from "node:assert/strict";
import test from "node:test";
import { runWarmupTick, getWarmupStatusSnapshot, type WarmupTickDeps } from "./service.ts";
import { MockTransport } from "../runtime/transport.ts";
import type { WarmupNode } from "../domain/types.ts";
import type { WarmupStores, StoredSend } from "../store/ports.ts";

const now = new Date("2026-07-09T12:00:00.000Z");

function node(over: Partial<WarmupNode> = {}): WarmupNode {
  return {
    id: "n1", mailbox: "a@d.test", domain: "d.test", infraType: "postfix",
    state: "fresh", authReady: true, dailyLimit: 10, increaseByDay: 1, dayIndex: 3,
    weekdaysOnly: false, ...over
  };
}

/** Stores fake en memoria, suficientes para el tick/snapshot. */
function fakeStores(nodes: WarmupNode[]): WarmupStores {
  const queued: StoredSend[] = [];
  let seq = 0;
  return {
    nodes: {
      listActiveNodes: async () => nodes.filter((n) => n.state !== "blocked" && n.state !== "quarantined"),
      getNode: async (id) => nodes.find((n) => n.id === id) ?? null,
      updateState: async () => {},
      setDayIndex: async () => {},
      setAuthReady: async () => {}
    },
    sends: {
      enqueue: async (input) => {
        if (queued.some((s) => s.nodeId === input.nodeId && s.slotKey === input.slotKey)) return false;
        queued.push({ id: `s${seq++}`, nodeId: input.nodeId, slotKey: input.slotKey, toAddress: input.toAddress, status: "queued", attempts: 0 });
        return true;
      },
      listQueued: async (limit) => queued.filter((s) => s.status === "queued").slice(0, limit),
      markStatus: async (id, status) => { const s = queued.find((x) => x.id === id); if (s) s.status = status; }
    },
    signals: { record: async () => {} },
    seeds: { listEnabled: async () => [] },
    placement: {
      createTest: async () => {}, listPendingTests: async () => [], recordResult: async () => {},
      listResultsForRollup: async () => [], latestEwma: async () => undefined, upsertRollup: async () => {}
    }
  };
}

const ON = { WARMUP_ENGINE_ENABLE: "true" };

test("runWarmupTick lanza con el flag OFF (nada corre)", async () => {
  const stores = fakeStores([node()]);
  await assert.rejects(
    runWarmupTick(baseDeps(stores), {}),
    /warmup_engine_disabled/
  );
});

test("runWarmupTick con el flag ON: planifica, procesa y devuelve el resumen", async () => {
  const stores = fakeStores([node({ dayIndex: 3 })]);
  const result = await runWarmupTick(baseDeps(stores), ON);
  assert.equal(result.planned.nodes, 1);
  assert.equal(result.planned.enqueuedSends, 3, "dayIndex 3 ⇒ cupo 3");
  assert.equal(result.processed.processed, 3);
  assert.equal(result.processed.sent, 3);
});

test("runWarmupTick es idempotente por día: la 2ª corrida no encola de nuevo", async () => {
  const stores = fakeStores([node({ dayIndex: 3 })]);
  await runWarmupTick(baseDeps(stores), ON);
  const second = await runWarmupTick(baseDeps(stores), ON);
  assert.equal(second.planned.enqueuedSends, 0, "el slot del día ya existe");
});

test("getWarmupStatusSnapshot es read-only y resume el estado (para el panel)", async () => {
  const stores = fakeStores([node({ id: "n1", state: "fresh" }), node({ id: "n2", state: "warm", placementScore: 0.9 })]);
  const snap = await getWarmupStatusSnapshot(stores, { now, env: ON });
  assert.equal(snap.enabled, true);
  assert.equal(snap.totals.activeNodes, 2);
  assert.deepEqual(snap.byState, { fresh: 1, warm: 1 });
  assert.equal(snap.nodes.find((n) => n.id === "n2")?.placementScore, 0.9);
  assert.equal(snap.generatedAt, now.toISOString());
});

test("getWarmupStatusSnapshot reporta enabled=false cuando el flag está OFF (sin lanzar)", async () => {
  const snap = await getWarmupStatusSnapshot(fakeStores([node()]), { now, env: {} });
  assert.equal(snap.enabled, false, "leer estado no depende del flag; solo reporta que está OFF");
});

function baseDeps(stores: WarmupStores): WarmupTickDeps {
  return {
    stores,
    transport: new MockTransport(),
    imapClient: { search: async () => [] },
    now,
    pickRecipient: (_n, i) => `recipient${i}@engaged.test`,
    newTestId: (n, seedId) => `${n.id}:${seedId}:test`
  };
}

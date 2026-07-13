import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_WARMUP_POLICY } from "../domain/types.ts";
import type {
  LandedIn,
  SeedProvider,
  WarmupNode
} from "../domain/types.ts";
import type {
  NodeStore,
  PlacementStore,
  SeedStore,
  SendStore,
  SignalStore,
  StoredPlacementTest,
  StoredSeed,
  StoredSend,
  WarmupStores
} from "../store/ports.ts";
import { MockTransport } from "../runtime/transport.ts";
import type { ImapClient, ImapMessage, ImapSearchOptions } from "../reader/imap-placement-reader.ts";
import { TEST_ID_HEADER } from "../reader/imap-placement-reader.ts";
import {
  isoWeekdayOf,
  planNodeDay,
  processQueuedSends,
  reconcilePlacement,
  sendSlotKey
} from "./scheduler.ts";

// Miércoles UTC (isoWeekday 3): día laboral, evita el corte de weekdaysOnly.
const NOW = new Date("2026-07-08T12:00:00Z");

function node(overrides: Partial<WarmupNode> = {}): WarmupNode {
  return {
    id: "n1",
    mailbox: "warm@delivrix.io",
    domain: "delivrix.io",
    infraType: "postfix",
    state: "fresh",
    authReady: true,
    contractExpiresAt: new Date("2026-07-08T14:00:00Z"),
    dailyLimit: 100,
    increaseByDay: 10,
    dayIndex: 1,
    weekdaysOnly: false,
    ...overrides
  };
}

// ── Fakes en memoria de los puertos (store/ports.ts) ─────────────────────────────────────────────

function makeSendStore(): SendStore & { rows: StoredSend[] } {
  const rows: StoredSend[] = [];
  let seq = 0;
  return {
    rows,
    async enqueue(input) {
      if (rows.some((r) => r.nodeId === input.nodeId && r.slotKey === input.slotKey)) {
        return false; // exactly-once por (node_id, slot_key)
      }
      seq += 1;
      rows.push({
        id: `s${seq}`,
        nodeId: input.nodeId,
        slotKey: input.slotKey,
        toAddress: input.toAddress,
        status: "queued",
        attempts: 0
      });
      return true;
    },
    async listQueued(limit) {
      return rows.filter((r) => r.status === "queued").slice(0, limit);
    },
    async markStatus(id, status, opts) {
      const r = rows.find((x) => x.id === id);
      if (r == null) return;
      r.status = status;
      if (opts?.attempts != null) r.attempts = opts.attempts;
    }
  };
}

function makeNodeStore(nodes: WarmupNode[]): NodeStore & { updates: Array<{ id: string; state: string; score?: number }> } {
  const updates: Array<{ id: string; state: string; score?: number }> = [];
  return {
    updates,
    async listActiveNodes() {
      return nodes;
    },
    async getNode(id) {
      return nodes.find((n) => n.id === id) ?? null;
    },
    async updateState(id, state, placementScore) {
      updates.push({ id, state, score: placementScore });
      const n = nodes.find((x) => x.id === id);
      if (n != null) n.state = state;
    },
    async setDayIndex() {},
    async setAuthReady() {}
  };
}

function makeSignalStore(): SignalStore & { records: Array<{ nodeId: string; kind: string }> } {
  const records: Array<{ nodeId: string; kind: string }> = [];
  return {
    records,
    async record(input) {
      records.push({ nodeId: input.nodeId, kind: input.kind });
    }
  };
}

function makeSeedStore(seeds: StoredSeed[]): SeedStore {
  return {
    async listEnabled() {
      return seeds;
    }
  };
}

function makePlacementStore(pending: StoredPlacementTest[]): PlacementStore & {
  tests: StoredPlacementTest[];
  results: Array<{ testId: string; nodeId: string; provider: SeedProvider; landedIn: LandedIn; readAt: Date }>;
  rollups: Array<{ nodeId: string; samples: number; inboxWilsonLb?: number; inboxEwma?: number }>;
} {
  const tests = [...pending];
  const results: Array<{ testId: string; nodeId: string; provider: SeedProvider; landedIn: LandedIn; readAt: Date }> = [];
  const rollups: Array<{ nodeId: string; samples: number; inboxWilsonLb?: number; inboxEwma?: number }> = [];
  return {
    tests,
    results,
    rollups,
    async createTest(input) {
      tests.push({
        testId: input.testId,
        nodeId: input.nodeId,
        seedId: input.seedId,
        seedProvider: input.seedProvider,
        seedInbox: input.seedInbox,
        sentAt: input.sentAt
      });
    },
    async listPendingTests() {
      const resolved = new Set(results.map((r) => r.testId));
      return tests.filter((t) => !resolved.has(t.testId));
    },
    async recordResult(input) {
      results.push({
        testId: input.testId,
        nodeId: input.nodeId,
        provider: input.provider,
        landedIn: input.landedIn,
        readAt: input.readAt
      });
    },
    async listResultsForRollup(nodeId, since) {
      return results
        .filter((r) => r.nodeId === nodeId && r.readAt >= since)
        .map((r) => ({
          testId: r.testId,
          nodeId: r.nodeId,
          seedProvider: r.provider,
          landedIn: r.landedIn,
          readAt: r.readAt
        }));
    },
    async latestEwma() {
      return undefined;
    },
    async upsertRollup(input) {
      rollups.push({
        nodeId: input.nodeId,
        samples: input.samples,
        inboxWilsonLb: input.inboxWilsonLb,
        inboxEwma: input.inboxEwma
      });
    }
  };
}

function makeStores(opts: {
  nodes?: WarmupNode[];
  seeds?: StoredSeed[];
  pendingTests?: StoredPlacementTest[];
} = {}): WarmupStores & {
  sends: ReturnType<typeof makeSendStore>;
  nodes: ReturnType<typeof makeNodeStore>;
  signals: ReturnType<typeof makeSignalStore>;
  placement: ReturnType<typeof makePlacementStore>;
} {
  return {
    sends: makeSendStore(),
    nodes: makeNodeStore(opts.nodes ?? [node()]),
    signals: makeSignalStore(),
    seeds: makeSeedStore(opts.seeds ?? []),
    placement: makePlacementStore(opts.pendingTests ?? [])
  };
}

const pickRecipient = (_n: WarmupNode, i: number): string => `real-${i}@customer.com`;
const newTestId = (_n: WarmupNode, seedId: string): string => `tid-${seedId}`;

// ================== planNodeDay: auth gate ==================

test("planNodeDay: nodo que NO puede enviar (authReady=false) no encola nada ⇒ skippedReason auth_gate", async () => {
  const stores = makeStores({ nodes: [node({ authReady: false })] });
  const r = await planNodeDay({ node: node({ authReady: false }), now: NOW, stores, policy: DEFAULT_WARMUP_POLICY, pickRecipient, newTestId });
  assert.equal(r.enqueuedSends, 0);
  assert.equal(r.enqueuedTests, 0);
  assert.equal(r.skippedReason, "auth_gate");
  assert.equal(stores.sends.rows.length, 0, "el gate fail-closed NO debe encolar ni seeds");
});

test("planNodeDay: nodo blocked no encola (gate)", async () => {
  const stores = makeStores({ nodes: [node({ state: "blocked" })] });
  const r = await planNodeDay({ node: node({ state: "blocked" }), now: NOW, stores, policy: DEFAULT_WARMUP_POLICY, pickRecipient, newTestId });
  assert.equal(r.skippedReason, "auth_gate");
  assert.equal(stores.sends.rows.length, 0);
});

// ================== planNodeDay: cupo correcto ==================

test("planNodeDay: encola el cupo lineal del día (dayIndex×increaseByDay topado en dailyLimit)", async () => {
  const stores = makeStores();
  // dayIndex 1 × increaseByDay 10 = 10 (< dailyLimit 100) ⇒ cupo 10.
  const r = await planNodeDay({ node: node(), now: NOW, stores, policy: DEFAULT_WARMUP_POLICY, pickRecipient, newTestId });
  assert.equal(r.enqueuedSends, 10);
  assert.equal(stores.sends.rows.filter((s) => !s.slotKey.includes("seed")).length, 10);
  // slotKey determinista.
  assert.ok(stores.sends.rows.some((s) => s.slotKey === sendSlotKey("n1", NOW, 0)));
});

// ================== planNodeDay: idempotencia por slot ==================

test("planNodeDay: re-correr el MISMO día NO duplica (idempotencia por slotKey)", async () => {
  const stores = makeStores({ seeds: [{ id: "seed-gmail-1", address: "seed1@gmail.com", provider: "gmail" }] });
  const first = await planNodeDay({ node: node(), now: NOW, stores, policy: DEFAULT_WARMUP_POLICY, pickRecipient, newTestId });
  const second = await planNodeDay({ node: node(), now: NOW, stores, policy: DEFAULT_WARMUP_POLICY, pickRecipient, newTestId });
  assert.equal(first.enqueuedSends, 10);
  assert.equal(second.enqueuedSends, 0, "2ª corrida no inserta sends nuevos");
  assert.equal(second.enqueuedTests, 0, "2ª corrida no crea placement tests nuevos");
  // Total de filas de send = 10 tráfico + 1 seed (cap 10% de 10 = 1), sin duplicar.
  assert.equal(stores.sends.rows.length, 11);
  assert.equal(stores.placement.tests.length, 1, "un solo placement test pese a las 2 corridas");
});

// ================== planNodeDay: cap de seeds ≤10% ==================

test("planNodeDay: cap de seeds ≤10% del volumen del día (floor(cupo×0.10))", async () => {
  // cupo 10 ⇒ maxSeeds = floor(10 × 0.10) = 1, aunque haya 5 seeds habilitados.
  const seeds: StoredSeed[] = [
    { id: "sd1", address: "a@gmail.com", provider: "gmail" },
    { id: "sd2", address: "b@outlook.com", provider: "outlook" },
    { id: "sd3", address: "c@yahoo.com", provider: "yahoo" },
    { id: "sd4", address: "d@gmx.com", provider: "gmx" },
    { id: "sd5", address: "e@web.de", provider: "webde" }
  ];
  const stores = makeStores({ seeds });
  const r = await planNodeDay({ node: node(), now: NOW, stores, policy: DEFAULT_WARMUP_POLICY, pickRecipient, newTestId });
  assert.equal(r.enqueuedSends, 10);
  assert.equal(r.enqueuedTests, 1, "seeds capados a ≤10% (1 de 10)");
  assert.ok(r.enqueuedTests <= Math.floor(r.enqueuedSends * 0.1) + (r.enqueuedSends === 0 ? 0 : 0));
});

test("planNodeDay: cupo grande ⇒ hasta 10% de seeds", async () => {
  const seeds: StoredSeed[] = Array.from({ length: 30 }, (_v, i) => ({
    id: `sd${i}`,
    address: `s${i}@gmail.com`,
    provider: "gmail" as SeedProvider
  }));
  // cupo 100 ⇒ maxSeeds = floor(100 × 0.10) = 10.
  const stores = makeStores({ nodes: [node({ dayIndex: 10 })], seeds });
  const r = await planNodeDay({ node: node({ dayIndex: 10 }), now: NOW, stores, policy: DEFAULT_WARMUP_POLICY, pickRecipient, newTestId });
  assert.equal(r.enqueuedSends, 100);
  assert.equal(r.enqueuedTests, 10, "10% de 100 = 10 seeds");
});

// ================== processQueuedSends: envía y marca estados ==================

test("processQueuedSends: gate ok ⇒ envía y marca sent", async () => {
  const stores = makeStores();
  await stores.sends.enqueue({ nodeId: "n1", slotKey: "k0", toAddress: "d@x.com" });
  const transport = new MockTransport();
  const r = await processQueuedSends({ stores, transport, now: NOW, limit: 50 });
  assert.equal(r.processed, 1);
  assert.equal(r.sent, 1);
  assert.equal(transport.sent.length, 1);
  assert.equal(stores.sends.rows[0].status, "sent");
});

test("processQueuedSends: bounce PERMANENTE ⇒ marca bounced y registra signal", async () => {
  const stores = makeStores();
  await stores.sends.enqueue({ nodeId: "n1", slotKey: "k0", toAddress: "d@x.com" });
  const transport = MockTransport.permanentBounce("no_such_user");
  const r = await processQueuedSends({ stores, transport, now: NOW, limit: 50 });
  assert.equal(r.bounced, 1);
  assert.equal(stores.sends.rows[0].status, "bounced");
  assert.equal(stores.signals.records.length, 1);
  assert.equal(stores.signals.records[0].kind, "bounce");
});

test("processQueuedSends: fallo transitorio en el último intento ⇒ dead_lettered (DLQ)", async () => {
  const stores = makeStores();
  await stores.sends.enqueue({ nodeId: "n1", slotKey: "k0", toAddress: "d@x.com" });
  // Forzamos attempts previos = 2 ⇒ este es el intento 3 (DEFAULT_MAX_ATTEMPTS).
  stores.sends.rows[0].attempts = 2;
  const transport = MockTransport.transientFailure("temp");
  const r = await processQueuedSends({ stores, transport, now: NOW, limit: 50 });
  assert.equal(r.deadLettered, 1);
  assert.equal(stores.sends.rows[0].status, "dead_lettered");
  assert.equal(stores.signals.records.length, 0, "un dead-letter transitorio no es un bounce");
});

test("processQueuedSends: nodo desaparecido ⇒ dead_lettered (nunca reenvía a ciegas)", async () => {
  const stores = makeStores({ nodes: [] });
  await stores.sends.enqueue({ nodeId: "ghost", slotKey: "k0", toAddress: "d@x.com" });
  const transport = new MockTransport();
  const r = await processQueuedSends({ stores, transport, now: NOW, limit: 50 });
  assert.equal(transport.sent.length, 0);
  assert.equal(r.deadLettered, 1);
  assert.equal(stores.sends.rows[0].status, "dead_lettered");
});

// ================== reconcilePlacement: lee, rollup y transición FRESH→WARM ==================

/** Cliente IMAP fake: devuelve el seed en INBOX (primary) con el header que lo empareja. */
function inboxImap(): ImapClient {
  return {
    async search(opts: ImapSearchOptions): Promise<ImapMessage[]> {
      return [{ folder: "INBOX", headers: { [TEST_ID_HEADER]: opts.headerValue } }];
    }
  };
}

test("reconcilePlacement: lee seeds, hace rollup y dispara FRESH→WARM cuando el placement lo amerita", async () => {
  // 20 seeds Gmail pendientes, sentAt viejo (fuera del grace window no importa: aparecen en INBOX).
  const sentAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000); // t-3h
  const pendingTests: StoredPlacementTest[] = Array.from({ length: 20 }, (_v, i) => ({
    testId: `t${i}`,
    nodeId: "n1",
    seedId: `sd${i}`,
    seedProvider: "gmail" as SeedProvider,
    seedInbox: `s${i}@gmail.com`,
    sentAt
  }));
  const stores = makeStores({ nodes: [node({ state: "fresh" })], pendingTests });

  const r = await reconcilePlacement({
    stores,
    imapClient: inboxImap(),
    now: NOW,
    policy: DEFAULT_WARMUP_POLICY,
    // La FSM (§9) exige ≥5 días sostenidos sobre la barra: lo provee el histórico (inyectado).
    nodeSignals: () => ({ sustainedDaysOverBar: 5 })
  });

  assert.equal(r.read, 20, "leyó los 20 seeds");
  assert.equal(r.rolledUp, 1, "un nodo con resultados nuevos ⇒ un rollup");
  // 20/20 en Primary ⇒ Wilson-LB ≈ 0.839 ≥ 0.80.
  const rollup = stores.placement.rollups[0];
  assert.ok(rollup.inboxWilsonLb !== undefined && rollup.inboxWilsonLb >= 0.8, "Wilson-LB ≥ 0.80");
  assert.equal(r.transitions.length, 1, "una transición");
  assert.deepEqual(
    { from: r.transitions[0].from, to: r.transitions[0].to, reason: r.transitions[0].reason },
    { from: "fresh", to: "warm", reason: "graduated_to_warm" }
  );
  assert.equal(stores.nodes.updates.at(-1)?.state, "warm");
});

test("reconcilePlacement: seeds en spam ⇒ NO gradúa (sin transición)", async () => {
  const sentAt = new Date(NOW.getTime() - 3 * 60 * 60 * 1000);
  const pendingTests: StoredPlacementTest[] = Array.from({ length: 20 }, (_v, i) => ({
    testId: `t${i}`,
    nodeId: "n1",
    seedId: `sd${i}`,
    seedProvider: "gmail" as SeedProvider,
    seedInbox: `s${i}@gmail.com`,
    sentAt
  }));
  const stores = makeStores({ nodes: [node({ state: "fresh" })], pendingTests });
  const spamImap: ImapClient = {
    async search(opts) {
      return [{ folder: "[Gmail]/Spam", headers: { [TEST_ID_HEADER]: opts.headerValue }, gmailLabels: ["\\Spam"] }];
    }
  };
  const r = await reconcilePlacement({
    stores,
    imapClient: spamImap,
    now: NOW,
    policy: DEFAULT_WARMUP_POLICY,
    nodeSignals: () => ({ sustainedDaysOverBar: 5 })
  });
  assert.equal(r.read, 20);
  assert.equal(r.transitions.length, 0, "todo en spam: no gradúa");
});

test("reconcilePlacement: seed dentro del grace window sin aparecer ⇒ no cuenta como leído", async () => {
  const sentAt = new Date(NOW.getTime() - 5 * 60 * 1000); // t-5m (window abierto)
  const pendingTests: StoredPlacementTest[] = [
    { testId: "t0", nodeId: "n1", seedId: "sd0", seedProvider: "gmail", seedInbox: "s@gmail.com", sentAt }
  ];
  const stores = makeStores({ nodes: [node()], pendingTests });
  const emptyImap: ImapClient = { async search() { return []; } };
  const r = await reconcilePlacement({ stores, imapClient: emptyImap, now: NOW, policy: DEFAULT_WARMUP_POLICY });
  assert.equal(r.read, 0, "pendiente en grace window ⇒ no leído");
  assert.equal(r.rolledUp, 0);
  assert.equal(r.transitions.length, 0);
});

// ================== helper isoWeekdayOf ==================

test("isoWeekdayOf: domingo UTC ⇒ 7, lunes ⇒ 1", () => {
  assert.equal(isoWeekdayOf(new Date("2026-07-05T00:00:00Z")), 7); // domingo
  assert.equal(isoWeekdayOf(new Date("2026-07-06T00:00:00Z")), 1); // lunes
});

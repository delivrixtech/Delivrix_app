import assert from "node:assert/strict";
import test from "node:test";
import type { PgClient } from "./pg-stores.ts";
import { createPgWarmupStores } from "./pg-stores.ts";

// ── Fake PgClient: registra cada (text, params) y devuelve filas canned en orden ─────────────────
// NINGÚN test toca una DB real. El fake sólo observa el SQL emitido y regurgita respuestas.

interface Call {
  text: string;
  params: readonly unknown[];
}

interface Canned {
  rows: any[];
  rowCount: number | null;
}

function fakeClient(responses: Canned[] = []) {
  const calls: Call[] = [];
  let idx = 0;
  const client: PgClient = {
    async query<T = any>(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params });
      const r = responses[idx] ?? { rows: [], rowCount: 0 };
      idx += 1;
      return r as { rows: T[]; rowCount: number | null };
    }
  };
  return { client, calls };
}

/** Normaliza espacios para poder asertar substrings del SQL sin pelear con saltos de línea. */
function sql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ================== NodeStore ==================

test("listActiveNodes: SELECT sobre warmup_nodes filtrando por estados activos (param), mapea fila", async () => {
  const { client, calls } = fakeClient([
    {
      rows: [
        {
          id: "n1",
          mailbox: "warm@delivrix.io",
          domain: "delivrix.io",
          infra_type: "postfix",
          state: "warm",
          auth_ready: true,
          contract_expires_at: new Date("2026-07-09T13:00:00Z"),
          sending_ip: "203.0.113.5",
          helo_fqdn: "mail.delivrix.io",
          daily_limit: 20,
          increase_by_day: 1,
          day_index: 7,
          weekdays_only: false,
          health_score: "0.9",
          placement_score: "0.85"
        }
      ],
      rowCount: 1
    }
  ]);
  const stores = createPgWarmupStores(client);
  const nodes = await stores.nodes.listActiveNodes();

  const q = sql(calls[0].text);
  assert.match(q, /FROM warmup_nodes/);
  assert.match(q, /WHERE state = ANY\(\$1\)/);
  assert.deepEqual(calls[0].params, [["fresh", "warm", "paused"]]);

  assert.equal(nodes.length, 1);
  const n = nodes[0];
  assert.equal(n.infraType, "postfix");
  assert.equal(n.authReady, true);
  assert.equal(n.dayIndex, 7);
  assert.equal(n.dailyLimit, 20);
  assert.equal(n.increaseByDay, 1);
  assert.equal(n.weekdaysOnly, false);
  assert.equal(n.sendingIp, "203.0.113.5");
  assert.equal(n.heloFqdn, "mail.delivrix.io");
  assert.equal(n.healthScore, 0.9);
  assert.equal(n.placementScore, 0.85);
  assert.ok(n.contractExpiresAt instanceof Date);
});

test("getNode: filtra por id parametrizado; devuelve null si no hay filas; omite opcionales nulos", async () => {
  const { client, calls } = fakeClient([
    {
      rows: [
        {
          id: "n2",
          mailbox: "fresh@delivrix.io",
          domain: "delivrix.io",
          infra_type: "postfix",
          state: "fresh",
          auth_ready: false,
          contract_expires_at: null,
          sending_ip: null,
          helo_fqdn: null,
          daily_limit: 10,
          increase_by_day: 1,
          day_index: 0,
          weekdays_only: true,
          health_score: null,
          placement_score: null
        }
      ],
      rowCount: 1
    },
    { rows: [], rowCount: 0 }
  ]);
  const stores = createPgWarmupStores(client);

  const found = await stores.nodes.getNode("n2");
  assert.match(sql(calls[0].text), /FROM warmup_nodes WHERE id = \$1/);
  assert.deepEqual(calls[0].params, ["n2"]);
  assert.ok(found);
  assert.equal(found!.contractExpiresAt, undefined);
  assert.equal(found!.sendingIp, undefined);
  assert.equal(found!.healthScore, undefined);
  assert.equal(found!.placementScore, undefined);
  assert.equal(found!.weekdaysOnly, true);

  const missing = await stores.nodes.getNode("nope");
  assert.equal(missing, null);
  assert.deepEqual(calls[1].params, ["nope"]);
});

test("updateState: con placementScore actualiza ambas columnas; sin él sólo state", async () => {
  const { client, calls } = fakeClient([{ rows: [], rowCount: 1 }, { rows: [], rowCount: 1 }]);
  const stores = createPgWarmupStores(client);

  await stores.nodes.updateState("n1", "warm", 0.82);
  const q0 = sql(calls[0].text);
  assert.match(q0, /UPDATE warmup_nodes SET state = \$1, placement_score = \$2, updated_at = now\(\) WHERE id = \$3/);
  assert.deepEqual(calls[0].params, ["warm", 0.82, "n1"]);

  await stores.nodes.updateState("n1", "paused");
  const q1 = sql(calls[1].text);
  assert.match(q1, /UPDATE warmup_nodes SET state = \$1, updated_at = now\(\) WHERE id = \$2/);
  assert.doesNotMatch(q1, /placement_score/);
  assert.deepEqual(calls[1].params, ["paused", "n1"]);
});

test("setDayIndex y setAuthReady: parametrizados; contractExpiresAt opcional", async () => {
  const exp = new Date("2026-07-10T00:00:00Z");
  const { client, calls } = fakeClient([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 }
  ]);
  const stores = createPgWarmupStores(client);

  await stores.nodes.setDayIndex("n1", 3);
  assert.match(sql(calls[0].text), /UPDATE warmup_nodes SET day_index = \$1, updated_at = now\(\) WHERE id = \$2/);
  assert.deepEqual(calls[0].params, [3, "n1"]);

  await stores.nodes.setAuthReady("n1", true, exp);
  assert.match(sql(calls[1].text), /SET auth_ready = \$1, contract_expires_at = \$2, updated_at = now\(\) WHERE id = \$3/);
  assert.deepEqual(calls[1].params, [true, exp, "n1"]);

  await stores.nodes.setAuthReady("n1", false);
  const q2 = sql(calls[2].text);
  assert.match(q2, /SET auth_ready = \$1, updated_at = now\(\) WHERE id = \$2/);
  assert.doesNotMatch(q2, /contract_expires_at/);
  assert.deepEqual(calls[2].params, [false, "n1"]);
});

// ================== SendStore ==================

test("enqueue: INSERT ... ON CONFLICT DO NOTHING; true si rowCount>0", async () => {
  const { client, calls } = fakeClient([{ rows: [], rowCount: 1 }]);
  const stores = createPgWarmupStores(client);

  const inserted = await stores.sends.enqueue({
    nodeId: "n1",
    slotKey: "2026-07-09T12:00:00Z#n1#0",
    toAddress: "dest@example.com"
  });

  const q = sql(calls[0].text);
  assert.match(q, /INSERT INTO warmup_sends \(node_id, slot_key, to_address, status\)/);
  assert.match(q, /VALUES \(\$1, \$2, \$3, 'queued'\)/);
  assert.match(q, /ON CONFLICT \(node_id, slot_key\) DO NOTHING/);
  assert.deepEqual(calls[0].params, ["n1", "2026-07-09T12:00:00Z#n1#0", "dest@example.com"]);
  // anti-inyección: el valor de usuario NO aparece interpolado en el SQL.
  assert.doesNotMatch(q, /dest@example\.com/);
  assert.equal(inserted, true);
});

test("enqueue: idempotente — rowCount 0 ⇒ false (slot ya existente)", async () => {
  const { client } = fakeClient([{ rows: [], rowCount: 0 }]);
  const stores = createPgWarmupStores(client);
  const inserted = await stores.sends.enqueue({ nodeId: "n1", slotKey: "s", toAddress: "d@x.com" });
  assert.equal(inserted, false);
});

test("enqueue: rowCount null ⇒ false (no rompe)", async () => {
  const { client } = fakeClient([{ rows: [], rowCount: null }]);
  const stores = createPgWarmupStores(client);
  const inserted = await stores.sends.enqueue({ nodeId: "n1", slotKey: "s", toAddress: "d@x.com" });
  assert.equal(inserted, false);
});

test("listQueued: SELECT WHERE status='queued' ORDER BY created_at LIMIT $1; mapea filas", async () => {
  const { client, calls } = fakeClient([
    {
      rows: [
        { id: "s1", node_id: "n1", slot_key: "k1", to_address: "a@x.com", status: "queued", attempts: 0 }
      ],
      rowCount: 1
    }
  ]);
  const stores = createPgWarmupStores(client);
  const queued = await stores.sends.listQueued(50);

  const q = sql(calls[0].text);
  assert.match(q, /FROM warmup_sends WHERE status = 'queued' ORDER BY created_at LIMIT \$1/);
  assert.deepEqual(calls[0].params, [50]);
  assert.deepEqual(queued, [
    { id: "s1", nodeId: "n1", slotKey: "k1", toAddress: "a@x.com", status: "queued", attempts: 0 }
  ]);
});

test("markStatus: SET dinámico con placeholders correlativos y sólo campos provistos", async () => {
  const sentAt = new Date("2026-07-09T12:05:00Z");
  const { client, calls } = fakeClient([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 }
  ]);
  const stores = createPgWarmupStores(client);

  await stores.sends.markStatus("s1", "sent", { attempts: 1, sentAt });
  const q0 = sql(calls[0].text);
  assert.match(q0, /UPDATE warmup_sends SET status = \$1, attempts = \$2, sent_at = \$3 WHERE id = \$4/);
  assert.deepEqual(calls[0].params, ["sent", 1, sentAt, "s1"]);

  await stores.sends.markStatus("s2", "failed", { error: "smtp 451" });
  const q1 = sql(calls[1].text);
  assert.match(q1, /UPDATE warmup_sends SET status = \$1, last_error = \$2 WHERE id = \$3/);
  assert.deepEqual(calls[1].params, ["failed", "smtp 451", "s2"]);
});

test("markStatus: sin opts sólo actualiza status", async () => {
  const { client, calls } = fakeClient([{ rows: [], rowCount: 1 }]);
  const stores = createPgWarmupStores(client);
  await stores.sends.markStatus("s1", "dead_lettered");
  assert.match(sql(calls[0].text), /UPDATE warmup_sends SET status = \$1 WHERE id = \$2/);
  assert.deepEqual(calls[0].params, ["dead_lettered", "s1"]);
});

// ================== SignalStore ==================

test("record: INSERT warmup_signals con node_id/kind/detail parametrizados", async () => {
  const { client, calls } = fakeClient([{ rows: [], rowCount: 1 }]);
  const stores = createPgWarmupStores(client);
  await stores.signals.record({ nodeId: "n1", kind: "bounce", detail: { code: 550 } });
  const q = sql(calls[0].text);
  assert.match(q, /INSERT INTO warmup_signals \(node_id, kind, detail\) VALUES \(\$1, \$2, \$3\)/);
  assert.deepEqual(calls[0].params, ["n1", "bounce", { code: 550 }]);
});

test("record: detail ausente ⇒ null", async () => {
  const { client, calls } = fakeClient([{ rows: [], rowCount: 1 }]);
  const stores = createPgWarmupStores(client);
  await stores.signals.record({ nodeId: "n1", kind: "deferral" });
  assert.deepEqual(calls[0].params, ["n1", "deferral", null]);
});

// ================== SeedStore ==================

test("listEnabled: SELECT WHERE enabled=true; mapea a StoredSeed", async () => {
  const { client, calls } = fakeClient([
    { rows: [{ id: "sd1", address: "seed@gmail.com", provider: "gmail" }], rowCount: 1 }
  ]);
  const stores = createPgWarmupStores(client);
  const seeds = await stores.seeds.listEnabled();
  assert.match(sql(calls[0].text), /FROM warmup_seed_accounts WHERE enabled = true/);
  assert.deepEqual(seeds, [{ id: "sd1", address: "seed@gmail.com", provider: "gmail" }]);
});

// ================== PlacementStore ==================

test("createTest: INSERT sólo node_id/seed_id/test_id/sent_at (provider e inbox no se duplican)", async () => {
  const sentAt = new Date("2026-07-09T12:00:00Z");
  const { client, calls } = fakeClient([{ rows: [], rowCount: 1 }]);
  const stores = createPgWarmupStores(client);
  await stores.placement.createTest({
    nodeId: "n1",
    seedId: "sd1",
    testId: "T-123",
    seedProvider: "gmail",
    seedInbox: "seed@gmail.com",
    sentAt
  });
  const q = sql(calls[0].text);
  assert.match(q, /INSERT INTO warmup_placement_tests \(node_id, seed_id, test_id, sent_at\) VALUES \(\$1, \$2, \$3, \$4\)/);
  assert.deepEqual(calls[0].params, ["n1", "sd1", "T-123", sentAt]);
});

test("listPendingTests: JOIN seed + LEFT JOIN results con landed_in IS NULL; mapea con provider/inbox del seed", async () => {
  const sentAt = new Date("2026-07-09T12:00:00Z");
  const { client, calls } = fakeClient([
    {
      rows: [
        {
          test_id: "T-1",
          node_id: "n1",
          seed_id: "sd1",
          seed_provider: "outlook",
          seed_inbox: "seed@outlook.com",
          sent_at: sentAt
        }
      ],
      rowCount: 1
    }
  ]);
  const stores = createPgWarmupStores(client);
  const pending = await stores.placement.listPendingTests();
  const q = sql(calls[0].text);
  assert.match(q, /FROM warmup_placement_tests t/);
  assert.match(q, /JOIN warmup_seed_accounts s ON s\.id = t\.seed_id/);
  assert.match(q, /LEFT JOIN warmup_placement_results r ON r\.test_id = t\.test_id/);
  assert.match(q, /WHERE r\.id IS NULL OR r\.landed_in IS NULL/);
  assert.deepEqual(pending, [
    {
      testId: "T-1",
      nodeId: "n1",
      seedId: "sd1",
      seedProvider: "outlook",
      seedInbox: "seed@outlook.com",
      sentAt
    }
  ]);
});

test("recordResult: INSERT warmup_placement_results parametrizado", async () => {
  const readAt = new Date("2026-07-09T12:30:00Z");
  const { client, calls } = fakeClient([{ rows: [], rowCount: 1 }]);
  const stores = createPgWarmupStores(client);
  await stores.placement.recordResult({
    testId: "T-1",
    nodeId: "n1",
    provider: "gmail",
    landedIn: "spam",
    readAt
  });
  const q = sql(calls[0].text);
  assert.match(q, /INSERT INTO warmup_placement_results \(test_id, node_id, provider, landed_in, read_at\) VALUES \(\$1, \$2, \$3, \$4, \$5\)/);
  assert.deepEqual(calls[0].params, ["T-1", "n1", "gmail", "spam", readAt]);
});

test("listResultsForRollup: filtra node_id + read_at>=since; mapea landed_in null y readAt", async () => {
  const since = new Date("2026-07-08T00:00:00Z");
  const readAt = new Date("2026-07-09T09:00:00Z");
  const { client, calls } = fakeClient([
    {
      rows: [
        { test_id: "T-1", node_id: "n1", seed_provider: "gmail", landed_in: "primary", read_at: readAt },
        { test_id: "T-2", node_id: "n1", seed_provider: "yahoo", landed_in: null, read_at: readAt }
      ],
      rowCount: 2
    }
  ]);
  const stores = createPgWarmupStores(client);
  const rows = await stores.placement.listResultsForRollup("n1", since);
  const q = sql(calls[0].text);
  assert.match(q, /FROM warmup_placement_results WHERE node_id = \$1 AND read_at >= \$2 ORDER BY read_at/);
  assert.deepEqual(calls[0].params, ["n1", since]);
  assert.equal(rows[0].landedIn, "primary");
  assert.equal(rows[0].seedProvider, "gmail");
  assert.ok(rows[0].readAt instanceof Date);
  assert.equal(rows[1].landedIn, null);
});

test("latestEwma: SELECT inbox_ewma ORDER BY window_end DESC LIMIT 1; number o undefined", async () => {
  const { client, calls } = fakeClient([
    { rows: [{ inbox_ewma: "0.77" }], rowCount: 1 },
    { rows: [], rowCount: 0 }
  ]);
  const stores = createPgWarmupStores(client);

  const ewma = await stores.placement.latestEwma("n1");
  const q = sql(calls[0].text);
  assert.match(q, /SELECT inbox_ewma FROM warmup_placement_rollups WHERE node_id = \$1 ORDER BY window_end DESC LIMIT 1/);
  assert.deepEqual(calls[0].params, ["n1"]);
  assert.equal(ewma, 0.77);

  const none = await stores.placement.latestEwma("n2");
  assert.equal(none, undefined);
});

test("upsertRollup: INSERT ... ON CONFLICT (node_id, window_start, window_end) DO UPDATE; nulls por opcionales ausentes", async () => {
  const ws = new Date("2026-07-08T00:00:00Z");
  const we = new Date("2026-07-09T00:00:00Z");
  const { client, calls } = fakeClient([
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 1 }
  ]);
  const stores = createPgWarmupStores(client);

  await stores.placement.upsertRollup({
    nodeId: "n1",
    windowStart: ws,
    windowEnd: we,
    samples: 30,
    inboxCount: 25,
    spamCount: 3,
    missingCount: 2,
    inboxWilsonLb: 0.72,
    inboxEwma: 0.75
  });
  const q = sql(calls[0].text);
  assert.match(q, /INSERT INTO warmup_placement_rollups/);
  assert.match(q, /ON CONFLICT \(node_id, window_start, window_end\) DO UPDATE SET/);
  assert.match(q, /samples = EXCLUDED\.samples/);
  assert.deepEqual(calls[0].params, ["n1", ws, we, 30, 25, 3, 2, 0.72, 0.75]);

  await stores.placement.upsertRollup({
    nodeId: "n1",
    windowStart: ws,
    windowEnd: we,
    samples: 0,
    inboxCount: 0,
    spamCount: 0,
    missingCount: 0
  });
  assert.deepEqual(calls[1].params, ["n1", ws, we, 0, 0, 0, 0, null, null]);
});

test("countRecent: FILTER por kind sobre occurred_at>=since; mapea bounces/complaints", async () => {
  const since = new Date("2026-06-09T00:00:00Z");
  const { client, calls } = fakeClient([
    { rows: [{ bounces: "3", complaints: "1" }], rowCount: 1 }
  ]);
  const stores = createPgWarmupStores(client);
  const counts = await stores.signals.countRecent(since);
  const q = sql(calls[0].text);
  assert.match(q, /COUNT\(\*\) FILTER \(WHERE kind = 'bounce'\) AS bounces/);
  assert.match(q, /COUNT\(\*\) FILTER \(WHERE kind = 'complaint'\) AS complaints/);
  assert.match(q, /FROM warmup_signals WHERE occurred_at >= \$1/);
  assert.deepEqual(calls[0].params, [since]);
  assert.deepEqual(counts, { bounces: 3, complaints: 1 });
});

test("countRecent: sin filas ⇒ ceros (no rompe)", async () => {
  const { client } = fakeClient([{ rows: [], rowCount: 0 }]);
  const stores = createPgWarmupStores(client);
  assert.deepEqual(await stores.signals.countRecent(new Date()), { bounces: 0, complaints: 0 });
});

// ================== EngagedRecipientStore ==================

test("engaged.listEnabled: SELECT WHERE enabled=true; mapea a EngagedRecipient source='curated'", async () => {
  const { client, calls } = fakeClient([
    { rows: [{ address: "team@delivrix.io", weight: "3" }], rowCount: 1 }
  ]);
  const stores = createPgWarmupStores(client);
  const engaged = await stores.engaged.listEnabled();
  assert.match(sql(calls[0].text), /FROM warmup_engaged_recipients WHERE enabled = true ORDER BY created_at/);
  assert.deepEqual(engaged, [{ address: "team@delivrix.io", source: "curated", weight: 3 }]);
});

test("engaged.listEnabled: sin filas ⇒ array vacío", async () => {
  const { client } = fakeClient([{ rows: [], rowCount: 0 }]);
  const stores = createPgWarmupStores(client);
  assert.deepEqual(await stores.engaged.listEnabled(), []);
});

// ================== PlacementStore: tendencia ==================

test("listRecentRollups: ORDER BY window_end DESC LIMIT $1; spam_rate con NULLIF; mapea opcionales", async () => {
  const { client, calls } = fakeClient([
    {
      rows: [
        {
          window_end: new Date("2026-07-09T00:00:00Z"),
          inbox_wilson_lb: "0.72",
          inbox_ewma: "0.75",
          spam_rate: "0.1",
          samples: 30
        },
        // ventana sin muestras: opcionales nulos ⇒ se omiten
        { window_end: "2026-07-08", inbox_wilson_lb: null, inbox_ewma: null, spam_rate: null, samples: 0 }
      ],
      rowCount: 2
    }
  ]);
  const stores = createPgWarmupStores(client);
  const series = await stores.placement.listRecentRollups(30);
  const q = sql(calls[0].text);
  assert.match(q, /FROM warmup_placement_rollups ORDER BY window_end DESC LIMIT \$1/);
  assert.match(q, /spam_count::numeric \/ NULLIF\(samples, 0\) AS spam_rate/);
  assert.deepEqual(calls[0].params, [30]);

  assert.equal(series[0].windowEnd, "2026-07-09T00:00:00.000Z");
  assert.equal(series[0].inboxWilsonLb, 0.72);
  assert.equal(series[0].inboxEwma, 0.75);
  assert.equal(series[0].spamRate, 0.1);
  assert.equal(series[0].samples, 30);

  assert.equal(series[1].samples, 0);
  assert.equal("inboxWilsonLb" in series[1], false);
  assert.equal("inboxEwma" in series[1], false);
  assert.equal("spamRate" in series[1], false);
});

test("aggregateByProvider: FILTER por landed_in; WHERE read_at>=since AND landed_in NOT NULL; inboxRate", async () => {
  const since = new Date("2026-07-02T00:00:00Z");
  const { client, calls } = fakeClient([
    {
      rows: [
        { provider: "gmail", inbox: "8", tabs: "2", spam: "1", missing: "1", total: "10" },
        { provider: "outlook", inbox: "0", tabs: "0", spam: "0", missing: "0", total: "0" }
      ],
      rowCount: 2
    }
  ]);
  const stores = createPgWarmupStores(client);
  const providers = await stores.placement.aggregateByProvider(since);
  const q = sql(calls[0].text);
  assert.match(q, /FROM warmup_placement_results WHERE read_at >= \$1 AND landed_in IS NOT NULL/);
  assert.match(q, /COUNT\(\*\) FILTER \(WHERE landed_in IN \('primary', 'tabs'\)\) AS inbox/);
  assert.match(q, /GROUP BY provider ORDER BY provider/);
  assert.deepEqual(calls[0].params, [since]);

  assert.deepEqual(providers[0], {
    provider: "gmail",
    inbox: 8,
    tabs: 2,
    spam: 1,
    missing: 1,
    total: 10,
    inboxRate: 0.8
  });
  // total 0 ⇒ sin inboxRate (evita división por cero)
  assert.equal("inboxRate" in providers[1], false);
  assert.equal(providers[1].total, 0);
});

// ================== Factory ==================

test("createPgWarmupStores: expone las 6 stores (incluye engaged)", async () => {
  const { client } = fakeClient();
  const stores = createPgWarmupStores(client);
  assert.ok(
    stores.nodes && stores.sends && stores.signals && stores.seeds && stores.placement && stores.engaged
  );
});

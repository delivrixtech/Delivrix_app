import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

interface LogModule {
  eventTone: (event: Record<string, unknown>) => string;
  eventLabel: (event: Record<string, unknown>) => string;
}

interface ClientModule {
  normalizeMailboxEvents: (
    raw: unknown,
    fallbackMailboxId?: string
  ) => { mailboxId: string; events: Array<Record<string, unknown>>; note?: string };
  deriveDlqEntries: (
    events: Array<Record<string, unknown>>
  ) => Array<Record<string, unknown>>;
  postWarmupMailbox: (input: {
    email: string;
    domain?: string;
  }) => Promise<{ ok: boolean; id?: string; state?: string; status?: string }>;
}

let server: ViteDevServer | null = null;

async function boot(): Promise<ViteDevServer> {
  server ??= await createServer({
    configFile: false,
    root: process.cwd(),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true, ws: false },
    appType: "custom"
  });
  return server;
}

async function loadLog(): Promise<LogModule> {
  return (await boot()).ssrLoadModule("/src/v5/views/WarmupMailboxLog.tsx") as Promise<LogModule>;
}

async function loadClient(): Promise<ClientModule> {
  return (await boot()).ssrLoadModule(
    "/src/shared/api/warmup-mailboxes-client.ts"
  ) as Promise<ClientModule>;
}

after(async () => {
  await server?.close();
});

/* ---------------- eventTone ---------------- */

test("eventTone: envío sent = success, dead_lettered = critical, queued = info", async () => {
  const { eventTone } = await loadLog();
  assert.equal(eventTone({ type: "send", status: "sent" }), "success");
  assert.equal(eventTone({ type: "send", status: "dead_lettered" }), "critical");
  assert.equal(eventTone({ type: "send", status: "failed" }), "critical");
  assert.equal(eventTone({ type: "send", status: "queued" }), "info");
});

test("eventTone: placement inbox/tabs = success, spam = critical, missing = warning", async () => {
  const { eventTone } = await loadLog();
  assert.equal(eventTone({ type: "placement", landedIn: "inbox" }), "success");
  assert.equal(eventTone({ type: "placement", landedIn: "tabs" }), "success");
  assert.equal(eventTone({ type: "placement", landedIn: "spam" }), "critical");
  assert.equal(eventTone({ type: "placement", landedIn: "missing" }), "warning");
});

test("eventTone: state_change hacia warm = success, paused = warning, blocked = critical", async () => {
  const { eventTone } = await loadLog();
  assert.equal(eventTone({ type: "state_change", toState: "warm" }), "success");
  assert.equal(eventTone({ type: "state_change", toState: "paused" }), "warning");
  assert.equal(eventTone({ type: "state_change", toState: "blocked" }), "critical");
});

test("eventLabel: describe cada tipo con su detalle", async () => {
  const { eventLabel } = await loadLog();
  assert.equal(eventLabel({ type: "send", status: "sent" }), "envío · sent");
  assert.equal(eventLabel({ type: "placement", landedIn: "spam" }), "placement · spam");
  assert.equal(
    eventLabel({ type: "state_change", fromState: "fresh", toState: "warm" }),
    "estado · fresh→warm"
  );
});

/* ---------------- normalizeMailboxEvents ---------------- */

test("normalizeMailboxEvents: envelope { mailboxId, events, note }", async () => {
  const { normalizeMailboxEvents } = await loadClient();
  const out = normalizeMailboxEvents({
    mailboxId: "mb-1",
    note: "warmup_tables_unavailable",
    events: [{ id: "e1", type: "send", occurredAt: "2026-07-13T10:00:00Z", status: "sent" }]
  });
  assert.equal(out.mailboxId, "mb-1");
  assert.equal(out.note, "warmup_tables_unavailable");
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].status, "sent");
});

test("normalizeMailboxEvents: array pelado + snake_case + id sintético", async () => {
  const { normalizeMailboxEvents } = await loadClient();
  const out = normalizeMailboxEvents(
    [{ type: "state_change", at: "2026-07-13T09:00:00Z", from_state: "fresh", to_state: "warm" }],
    "mb-2"
  );
  assert.equal(out.mailboxId, "mb-2");
  assert.equal(out.events.length, 1);
  assert.equal(out.events[0].id, "evt-0"); // id sintético cuando el backend no lo trae
  assert.equal(out.events[0].occurredAt, "2026-07-13T09:00:00Z"); // lee `at`
  assert.equal(out.events[0].fromState, "fresh"); // lee snake_case
  assert.equal(out.events[0].toState, "warm");
});

test("normalizeMailboxEvents: entrada basura ⇒ vacío sin lanzar", async () => {
  const { normalizeMailboxEvents } = await loadClient();
  assert.deepEqual(normalizeMailboxEvents(null).events, []);
  assert.deepEqual(normalizeMailboxEvents(undefined).events, []);
  assert.deepEqual(normalizeMailboxEvents(42).events, []);
});

test("normalizeMailboxEvents: backend `kind` mapea a `type` (send/signal) + toAddress/lastError", async () => {
  const { normalizeMailboxEvents } = await loadClient();
  const out = normalizeMailboxEvents({
    events: [
      { kind: "send", id: "s1", at: "2026-07-13T10:00:00Z", status: "failed", to_address: "a@x.com", last_error: "550 blocked" },
      { kind: "signal", id: "g1", at: "2026-07-13T09:00:00Z", status: "bounce" }
    ]
  });
  assert.equal(out.events[0].type, "send"); // kind 'send' ⇒ type 'send'
  assert.equal(out.events[0].toAddress, "a@x.com");
  assert.equal(out.events[0].lastError, "550 blocked");
  assert.equal(out.events[1].type, "signal"); // kind 'signal' NO se colapsa a 'send'
  assert.equal(out.events[1].status, "bounce");
});

test("eventTone/eventLabel: señal bounce = critical y se etiqueta como señal", async () => {
  const { eventTone, eventLabel } = await loadLog();
  assert.equal(eventTone({ type: "signal", status: "bounce" }), "critical");
  assert.equal(eventTone({ type: "signal", status: "deferral" }), "warning");
  assert.equal(eventLabel({ type: "signal", status: "bounce" }), "señal · bounce");
});

/* ---------------- deriveDlqEntries ---------------- */

test("deriveDlqEntries: filtra solo envíos dead_lettered/failed", async () => {
  const { deriveDlqEntries } = await loadClient();
  const events = [
    { id: "a", type: "send", occurredAt: "t", status: "sent" },
    { id: "b", type: "send", occurredAt: "t", status: "dead_lettered" },
    { id: "c", type: "send", occurredAt: "t", status: "failed" },
    { id: "d", type: "placement", occurredAt: "t", status: "failed" }, // no es send ⇒ fuera
    { id: "e", type: "send", occurredAt: "t", status: "queued" }
  ];
  const dlq = deriveDlqEntries(events);
  assert.deepEqual(
    dlq.map((e) => e.id),
    ["b", "c"]
  );
});

/* ---------------- postWarmupMailbox (shape del carril B) ---------------- */

test("postWarmupMailbox: mapea el envelope real { created, mailbox } → id/state/status", async () => {
  const { postWarmupMailbox } = await loadClient();
  const originalFetch = globalThis.fetch;
  try {
    // 201 created: nuevo buzón.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 201,
      json: async () => ({ created: true, source: "manual", mailbox: { id: "m1", state: "blocked" } })
    })) as unknown as typeof fetch;
    const created = await postWarmupMailbox({ email: "warm@delivrix.io", domain: "delivrix.io" });
    assert.deepEqual(created, { ok: true, id: "m1", state: "blocked", status: "created" });

    // 200 created:false: reintento idempotente ⇒ 'exists' (no 'created'), estado preservado.
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ created: false, source: "manual", mailbox: { id: "m1", state: "warm" } })
    })) as unknown as typeof fetch;
    const existing = await postWarmupMailbox({ email: "warm@delivrix.io", domain: "delivrix.io" });
    assert.deepEqual(existing, { ok: true, id: "m1", state: "warm", status: "exists" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";

interface SelectorDomain {
  domain: string;
  status: string;
  registeredAt?: string | null;
  smtpCredential?: { host?: string | null; username?: string | null; createdAt?: string } | null;
}

interface SelectorRow {
  domain: string;
  status: string;
  email: string | null;
  smtpHost: string | null;
  warmupState: string | null;
  selectable: boolean;
}

interface SelectorModule {
  resolveMailerEmail: (d: SelectorDomain) => string | null;
  buildSelectorRow: (d: SelectorDomain, warmupByEmail: Map<string, string>) => SelectorRow;
  selectableEmails: (rows: SelectorRow[], opts?: { includeInWarmup?: boolean }) => string[];
  buildBatchInput: (
    selected: Iterable<string>,
    rows: SelectorRow[],
    actorId?: string
  ) => { mailboxes: Array<{ email: string; domain?: string }>; actorId?: string };
}

interface ClientModule {
  normalizeMailboxList: (raw: unknown) => {
    mailboxes: Array<{ id: string; email: string; domain?: string; state: string }>;
    note?: string;
  };
  normalizeBatchResult: (raw: unknown) => {
    summary: { requested: number; created: number; existed: number; failed: number };
    results: Array<{ email: string; status: string; id?: string; state?: string; error?: string }>;
  };
  postWarmupMailboxBatch: (input: {
    mailboxes: Array<{ email: string; domain?: string }>;
    actorId?: string;
  }) => Promise<{ summary: { requested: number; created: number; existed: number; failed: number }; results: unknown[] }>;
  listWarmupMailboxes: () => Promise<{ mailboxes: unknown[]; note?: string }>;
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

async function loadSelector(): Promise<SelectorModule> {
  return (await boot()).ssrLoadModule("/src/v5/views/WarmupOnboardSelector.tsx") as Promise<SelectorModule>;
}

async function loadClient(): Promise<ClientModule> {
  return (await boot()).ssrLoadModule(
    "/src/shared/api/warmup-mailboxes-client.ts"
  ) as Promise<ClientModule>;
}

after(async () => {
  await server?.close();
});

/* ---------------- resolveMailerEmail ---------------- */

test("resolveMailerEmail: username con @ ⇒ email en minúsculas; sin @ o sin credencial ⇒ null", async () => {
  const { resolveMailerEmail } = await loadSelector();
  assert.equal(
    resolveMailerEmail({ domain: "d.com", status: "owned", smtpCredential: { username: "Mailer@D.COM", host: "smtp.d.com" } }),
    "mailer@d.com"
  );
  assert.equal(
    resolveMailerEmail({ domain: "d.com", status: "owned", smtpCredential: { username: "mailer", host: "smtp.d.com" } }),
    null
  );
  assert.equal(resolveMailerEmail({ domain: "d.com", status: "owned", smtpCredential: null }), null);
  assert.equal(resolveMailerEmail({ domain: "d.com", status: "owned" }), null);
});

/* ---------------- buildSelectorRow ---------------- */

test("buildSelectorRow: cruza estado de warmup por email y marca selectable según mailer", async () => {
  const { buildSelectorRow } = await loadSelector();
  const warmup = new Map<string, string>([["mailer@a.com", "warm"]]);
  const withNode = buildSelectorRow(
    { domain: "a.com", status: "owned", smtpCredential: { username: "mailer@a.com", host: "smtp.a.com" } },
    warmup
  );
  assert.equal(withNode.email, "mailer@a.com");
  assert.equal(withNode.smtpHost, "smtp.a.com");
  assert.equal(withNode.warmupState, "warm");
  assert.equal(withNode.selectable, true);

  const noCred = buildSelectorRow({ domain: "b.com", status: "pending" }, warmup);
  assert.equal(noCred.email, null);
  assert.equal(noCred.warmupState, null);
  assert.equal(noCred.selectable, false);
});

/* ---------------- selectableEmails ---------------- */

test("selectableEmails: excluye los que ya están en warmup por defecto; includeInWarmup los suma", async () => {
  const { selectableEmails } = await loadSelector();
  const rows: SelectorRow[] = [
    { domain: "a.com", status: "owned", email: "m@a.com", smtpHost: "s", warmupState: null, selectable: true },
    { domain: "b.com", status: "owned", email: "m@b.com", smtpHost: "s", warmupState: "warm", selectable: true },
    { domain: "c.com", status: "pending", email: null, smtpHost: null, warmupState: null, selectable: false }
  ];
  assert.deepEqual(selectableEmails(rows), ["m@a.com"]);
  assert.deepEqual(selectableEmails(rows, { includeInWarmup: true }).sort(), ["m@a.com", "m@b.com"]);
});

/* ---------------- buildBatchInput ---------------- */

test("buildBatchInput: deriva domain del mailer, dedupe, ignora emails sin fila, adjunta actorId", async () => {
  const { buildBatchInput } = await loadSelector();
  const rows: SelectorRow[] = [
    { domain: "a.com", status: "owned", email: "m@a.com", smtpHost: "s", warmupState: null, selectable: true },
    { domain: "b.com", status: "owned", email: "m@b.com", smtpHost: "s", warmupState: null, selectable: true }
  ];
  const input = buildBatchInput(["m@a.com", "m@a.com", "ghost@x.com", "m@b.com"], rows, "operator/sender-pool");
  assert.equal(input.actorId, "operator/sender-pool");
  assert.deepEqual(input.mailboxes, [
    { email: "m@a.com", domain: "a.com" },
    { email: "m@b.com", domain: "b.com" }
  ]);

  const noActor = buildBatchInput(["m@a.com"], rows);
  assert.equal("actorId" in noActor, false);
});

/* ---------------- normalizeMailboxList ---------------- */

test("normalizeMailboxList: envelope { mailboxes, note }, array pelado, y filtra sin email", async () => {
  const { normalizeMailboxList } = await loadClient();
  const env = normalizeMailboxList({
    generatedAt: "t",
    note: "warmup_db_unavailable",
    mailboxes: [
      { id: "1", email: "A@X.com", domain: "x.com", state: "warm" },
      { id: "2", email: "", state: "fresh" } // sin email ⇒ descartado
    ]
  });
  assert.equal(env.note, "warmup_db_unavailable");
  assert.equal(env.mailboxes.length, 1);
  assert.equal(env.mailboxes[0].email, "a@x.com"); // lowercased
  assert.equal(env.mailboxes[0].state, "warm");

  const arr = normalizeMailboxList([{ id: "9", email: "z@z.com", state: "blocked" }]);
  assert.equal(arr.mailboxes.length, 1);
  assert.deepEqual(normalizeMailboxList(null).mailboxes, []);
});

/* ---------------- normalizeBatchResult ---------------- */

test("normalizeBatchResult: envelope completo { summary, results } pasa tal cual", async () => {
  const { normalizeBatchResult } = await loadClient();
  const out = normalizeBatchResult({
    summary: { requested: 3, created: 1, existed: 1, failed: 1 },
    results: [
      { email: "a@x.com", status: "created", id: "1", state: "blocked" },
      { email: "b@x.com", status: "exists", id: "2", state: "warm" },
      { email: "c@x.com", status: "failed", error: "warmup_db_write_failed" }
    ]
  });
  assert.deepEqual(out.summary, { requested: 3, created: 1, existed: 1, failed: 1 });
  assert.equal(out.results[0].id, "1");
  assert.equal(out.results[2].error, "warmup_db_write_failed");
});

test("normalizeBatchResult: sin summary ⇒ lo deriva contando por status (nunca miente)", async () => {
  const { normalizeBatchResult } = await loadClient();
  const out = normalizeBatchResult({
    results: [
      { email: "a@x.com", created: true, mailbox: { id: "1", state: "blocked" } }, // created:true ⇒ created
      { email: "b@x.com", created: false, mailbox: { id: "2", state: "warm" } }, // created:false ⇒ exists
      { email: "c@x.com", error: "boom" } // error ⇒ failed
    ]
  });
  assert.deepEqual(out.summary, { requested: 3, created: 1, existed: 1, failed: 1 });
  assert.equal(out.results[0].status, "created");
  assert.equal(out.results[0].id, "1"); // lee mailbox.id
  assert.equal(out.results[1].status, "exists");
  assert.equal(out.results[1].state, "warm");
  assert.equal(out.results[2].status, "failed");
  assert.equal(out.results[2].error, "boom");
});

test("normalizeBatchResult: forma REAL del backend (summary.existing + results con created:boolean)", async () => {
  const { normalizeBatchResult } = await loadClient();
  // Contrato real de handleWarmupMailboxOnboardBatch: summary usa `existing` (no `existed`) y los
  // results traen `created:boolean` + `state`, sin `status` textual ni `id`.
  // El summary del backend es autoritativo aunque `results` no lo refleje 1:1 (p.ej. si se truncara).
  // Aquí `existing:2` difiere del conteo derivado (1 exists en results) para probar que se LEE el campo.
  const out = normalizeBatchResult({
    summary: { requested: 3, created: 1, existing: 2, failed: 1 },
    results: [
      { email: "a@x.com", created: true, state: "blocked" },
      { email: "b@x.com", created: false, state: "warm" },
      { email: "c@x.com", created: false, error: "email_required" }
    ]
  });
  // Lee summary.existing como campo autoritativo (antes se descartaba y caía al derived=1).
  assert.equal(out.summary.existed, 2);
  assert.deepEqual(out.summary, { requested: 3, created: 1, existed: 2, failed: 1 });
  assert.equal(out.results[0].status, "created");
  assert.equal(out.results[1].status, "exists");
  assert.equal(out.results[2].status, "failed");
  assert.equal(out.results[2].error, "email_required");
});

test("normalizeBatchResult: entrada basura ⇒ summary en cero sin lanzar", async () => {
  const { normalizeBatchResult } = await loadClient();
  assert.deepEqual(normalizeBatchResult(null), {
    summary: { requested: 0, created: 0, existed: 0, failed: 0 },
    results: []
  });
});

/* ---------------- postWarmupMailboxBatch / listWarmupMailboxes ---------------- */

test("postWarmupMailboxBatch: POSTea a /v1/mailboxes:onboard-batch y normaliza la respuesta", async () => {
  const { postWarmupMailboxBatch } = await loadClient();
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  let calledMethod = "";
  try {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledMethod = init?.method ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          summary: { requested: 1, created: 1, existed: 0, failed: 0 },
          results: [{ email: "a@x.com", status: "created", id: "1", state: "blocked" }]
        })
      };
    }) as unknown as typeof fetch;
    const out = await postWarmupMailboxBatch({ mailboxes: [{ email: "a@x.com", domain: "x.com" }] });
    assert.equal(calledUrl, "/v1/mailboxes:onboard-batch");
    assert.equal(calledMethod, "POST");
    assert.equal(out.summary.created, 1);
    assert.equal(out.results.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listWarmupMailboxes: 404 ⇒ lista vacía con gracia (no lanza)", async () => {
  const { listWarmupMailboxes } = await loadClient();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const out = await listWarmupMailboxes();
    assert.deepEqual(out.mailboxes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

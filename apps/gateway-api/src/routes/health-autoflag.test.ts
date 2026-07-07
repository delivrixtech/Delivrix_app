import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  emptyHealthAutoFlagState,
  type HealthAutoFlagState,
  type SendResult,
  type SenderNode
} from "../../../../packages/domain/src/index.ts";
import {
  handleHealthAutoFlagRun,
  runHealthAutoFlag,
  type HealthAutoFlagAuditEvent,
  type HealthAutoFlagDeps
} from "./health-autoflag.ts";
import { resetSensitiveReadAuthBucketsForTests } from "./sensitive-read-auth.ts";

const NOW = new Date("2026-07-06T12:00:00.000Z");

function memoryStateStore(initial: HealthAutoFlagState = emptyHealthAutoFlagState()) {
  let state = initial;
  return {
    get: async () => state,
    set: async (next: HealthAutoFlagState) => {
      state = next;
    },
    current: () => state
  };
}

function node(id = "node-1"): SenderNode {
  return {
    id,
    label: "mail.acme.com",
    provider: "webdock",
    status: "active",
    ipAddress: "203.0.113.10",
    dailyLimit: 100,
    warmupDay: 12
  };
}

function bounceHeavyResults(senderNodeId: string): SendResult[] {
  const rows: SendResult[] = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push({
      id: `res-${i}`,
      sendJobId: `job-${i}`,
      senderNodeId,
      status: i < 8 ? "bounce" : "sent",
      metadata: {},
      occurredAt: NOW.toISOString()
    });
  }
  return rows;
}

function baseDeps(overrides: Partial<HealthAutoFlagDeps> = {}): HealthAutoFlagDeps & {
  audits: HealthAutoFlagAuditEvent[];
} {
  const audits: HealthAutoFlagAuditEvent[] = [];
  return {
    readBoundaryToken: "secret",
    getSenderNodes: async () => [node()],
    getSendResults: async () => bounceHeavyResults("node-1"),
    stateStore: memoryStateStore(),
    notion: { apiKey: undefined },
    emitAudit: async (event) => {
      audits.push(event);
    },
    now: () => NOW,
    audits,
    ...overrides
  };
}

test("dry-run: reporta candidates sin llamar a Notion ni registrar open flags", async () => {
  const store = memoryStateStore();
  let notionCalls = 0;
  const deps = baseDeps({
    stateStore: store,
    autoFlagEnabled: false,
    createEntry: async () => {
      notionCalls += 1;
      return { ok: true, pageId: "never" };
    }
  });

  const result = await runHealthAutoFlag(deps, { trigger: "test" });

  assert.equal(result.dryRun, true);
  assert.equal(result.wouldFlag.length, 1);
  assert.equal(result.wouldFlag[0].metric, "bounce_rate");
  assert.equal(result.created.length, 0);
  assert.equal(notionCalls, 0);
  assert.equal(store.current().openFlags.length, 0);
  assert.deepEqual(deps.audits.map((event) => event.action), ["health_autoflag.dry_run"]);
});

test("run real: crea entrada en Notion, registra open flag y dedupea el segundo run", async () => {
  const store = memoryStateStore();
  const entries: unknown[] = [];
  const deps = baseDeps({
    stateStore: store,
    autoFlagEnabled: true,
    createEntry: async (entry) => {
      entries.push(entry);
      return { ok: true, pageId: "page-123", url: "https://notion.so/page-123" };
    }
  });

  const first = await runHealthAutoFlag(deps, { trigger: "test" });
  assert.equal(first.dryRun, false);
  assert.deepEqual(first.created, [
    { dedupeKey: "node-1::bounce_rate", notionPageId: "page-123", url: "https://notion.so/page-123" }
  ]);
  assert.equal(store.current().openFlags.length, 1);
  assert.equal(store.current().openFlags[0].notionPageId, "page-123");
  assert.equal(entries.length, 1);
  const entry = entries[0] as Record<string, unknown>;
  assert.equal(entry.category, "Flagged Server");
  assert.equal(entry.severity, "High");
  assert.equal(entry.affectedServer, "mail.acme.com");
  assert.equal(entry.reportedDate, "2026-07-06");
  assert.match(String(entry.description), /bounce_rate/);
  assert.match(String(entry.description), /80\.0%/);

  const second = await runHealthAutoFlag(deps, { trigger: "test" });
  assert.equal(second.created.length, 0);
  assert.equal(second.wouldFlag.length, 0);
  assert.equal(entries.length, 1, "no debe crear duplicado mientras el flag siga abierto");
});

test("run real sin NOTION_API_KEY: skippea sin registrar open flag y audita el motivo", async () => {
  const store = memoryStateStore();
  const deps = baseDeps({ stateStore: store, autoFlagEnabled: true });

  const result = await runHealthAutoFlag(deps, { trigger: "test" });

  assert.deepEqual(result.skipped, [
    { dedupeKey: "node-1::bounce_rate", reason: "notion_api_key_missing" }
  ]);
  assert.equal(store.current().openFlags.length, 0);
  assert.deepEqual(deps.audits.map((event) => event.action), ["health_autoflag.notion_skipped"]);
});

test("metrica recuperada resuelve el open flag en el estado", async () => {
  const store = memoryStateStore({
    ...emptyHealthAutoFlagState(),
    openFlags: [{
      dedupeKey: "node-1::bounce_rate",
      senderNodeId: "node-1",
      server: "mail.acme.com",
      metric: "bounce_rate",
      value: "80.0%",
      threshold: ">5.0%",
      flaggedAt: "2026-07-01T00:00:00.000Z",
      notionPageId: "page-123"
    }]
  });
  const healthyResults: SendResult[] = Array.from({ length: 20 }, (_, i) => ({
    id: `ok-${i}`,
    sendJobId: `job-${i}`,
    senderNodeId: "node-1",
    status: "sent",
    metadata: {},
    occurredAt: NOW.toISOString()
  }));
  const deps = baseDeps({
    stateStore: store,
    getSendResults: async () => healthyResults,
    autoFlagEnabled: true,
    createEntry: async () => ({ ok: true, pageId: "unexpected" })
  });

  const result = await runHealthAutoFlag(deps, { trigger: "test" });

  assert.deepEqual(result.resolved, ["node-1::bounce_rate"]);
  assert.equal(store.current().openFlags.length, 0);
});

test("endpoint HTTP exige read boundary token", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const route = createRoute({ token: "wrong" });

  await handleHealthAutoFlagRun(route.request, route.response, baseDeps());

  assert.equal(route.response.statusCode, 401);
  assert.deepEqual(route.body(), { error: "read_boundary_token_invalid" });
});

test("endpoint HTTP corre dry-run con blacklist signals del body", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const route = createRoute({
    token: "secret",
    body: {
      dryRun: true,
      blacklistScanPerformed: true,
      blacklistSignals: [
        { senderNodeId: "node-1", source: "mxtoolbox:spamhaus", severity: "critical" }
      ]
    }
  });
  const deps = baseDeps({ getSendResults: async () => [] });

  await handleHealthAutoFlagRun(route.request, route.response, deps);

  assert.equal(route.response.statusCode, 200);
  const body = route.body();
  assert.equal(body.dryRun, true);
  assert.equal(body.wouldFlag.length, 1);
  assert.equal(body.wouldFlag[0].metric, "blacklist");
  assert.equal(body.wouldFlag[0].value, "mxtoolbox:spamhaus");
});

test("endpoint HTTP rechaza body invalido", async () => {
  resetSensitiveReadAuthBucketsForTests();
  const route = createRoute({ token: "secret", body: { dryRun: "yes" } });

  await handleHealthAutoFlagRun(route.request, route.response, baseDeps());

  assert.equal(route.response.statusCode, 400);
  assert.deepEqual(route.body(), { error: "dry_run_must_be_boolean" });
});

function createRoute(input: { token?: string; body?: unknown }) {
  const payload = input.body === undefined ? "" : JSON.stringify(input.body);
  const request = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  request.method = "POST";
  request.url = "/v1/health-autoflag/run";
  request.headers = input.token ? { "x-delivrix-token": input.token } : {};

  const chunks: string[] = [];
  const response = new EventEmitter() as ServerResponse & {
    statusCode: number;
    setHeader: (name: string, value: string) => void;
  };
  response.statusCode = 200;
  response.setHeader = (() => response) as unknown as ServerResponse["setHeader"];
  response.end = ((chunk?: unknown) => {
    if (chunk) chunks.push(String(chunk));
    response.emit("finish");
    return response;
  }) as ServerResponse["end"];

  return {
    request,
    response,
    body: () => JSON.parse(chunks.join("") || "{}")
  };
}
